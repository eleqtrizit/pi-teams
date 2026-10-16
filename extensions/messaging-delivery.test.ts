import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deliveryExtension from "./index";
import * as paths from "../src/utils/paths";
import { sendToAgent } from "../src/utils/transport";
import type { TeamMessage } from "../src/utils/models";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

vi.mock("../src/utils/registry", () => ({
  generateAgentId: vi.fn(() => "abc12345"),
  ensureRegistryDir: vi.fn(),
  writeAgentRecord: vi.fn(),
  readAgentRecord: vi.fn(),
  readAgentRecords: vi.fn(() => []),
  removeAgentRecord: vi.fn(),
  isPidAlive: vi.fn(() => false),
}));

/** Handlers by event name. An event can have several handlers, which run in registration order. */
type HandlerMap = { get(name: string): (...args: any[]) => Promise<void> };

function loadExtension(): { handlers: HandlerMap; tools: Map<string, any>; sendUserMessage: any } {
  const registered = new Map<string, any[]>();
  const handlers: HandlerMap = {
    get: (name) => async (...args: any[]) => {
      for (const handler of registered.get(name) ?? []) await handler(...args);
    },
  };
  const tools = new Map<string, any>();
  const sendUserMessage = vi.fn().mockResolvedValue(undefined);
  deliveryExtension({
    on: (name: string, handler: any) => registered.set(name, [...(registered.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage,
  } as any);
  return { handlers, tools, sendUserMessage };
}

const message = (to: string, text: string): TeamMessage => ({
  id: "abcd1234",
  from: "peer1234",
  to,
  fromLabel: "peer",
  subject: "Subject",
  text,
  timestamp: "2026-05-28T10:00:00.000Z",
});

describe("immediate message delivery", () => {
  let team: string;
  let teamDir: string;
  const ui = { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() };

  beforeEach(() => {
    team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
    vi.stubEnv("PI_TEAM_NAME", team);
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", "work1111");
    vi.stubEnv("PI_LEAD_ID", "lead1111");
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
    vi.spyOn(paths, "teamDir").mockReturnValue(teamDir);
    vi.spyOn(paths, "pidPath").mockImplementation((_t, a) => path.join(teamDir, `${a}.pid`));
    vi.spyOn(paths, "activePath").mockImplementation((_t, a) => path.join(teamDir, `${a}.active`));
    vi.spyOn(paths, "firstActivationPath").mockImplementation((_t, a) => path.join(teamDir, `${a}.first`));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(teamDir, { recursive: true, force: true });
  });

  it("queues a received message as a follow-up user message", async () => {
    const { handlers, sendUserMessage } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    try {
      await sendToAgent(message("work1111", "please review"));
      await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
      const [text, options] = sendUserMessage.mock.calls[0];
      expect(text).toContain("**From:** peer (peer1234)");
      expect(text).toContain('Reply with send_message(recipient="peer1234").');
      expect(text).toContain("please review");
      expect(options).toEqual({ deliverAs: "followUp" });
    } finally {
      await handlers.get("session_shutdown")({}, {});
    }
  });

  it("holds a message that arrives mid-run until the run ends", async () => {
    const { handlers, sendUserMessage } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    try {
      await handlers.get("agent_start")({}, {});
      await sendToAgent(message("work1111", "mid-run note"));
      expect(sendUserMessage).not.toHaveBeenCalled();

      await handlers.get("agent_end")({ messages: [] }, { hasUI: true });
      await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
      expect(sendUserMessage.mock.calls[0][0]).toContain("mid-run note");
    } finally {
      await handlers.get("session_shutdown")({}, {});
    }
  });

  it("stops accepting messages after session shutdown", async () => {
    const { handlers } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    await handlers.get("session_shutdown")({}, {});
    await expect(sendToAgent(message("work1111", "late"))).rejects.toThrow(/not reachable/);
  });

  it("registers send_message but not broadcast_message", () => {
    const { tools } = loadExtension();
    expect(tools.has("send_message")).toBe(true);
    expect(tools.has("broadcast_message")).toBe(false);
  });
});

describe("lead window takeover", () => {
  let team: string;
  let teamDir: string;
  const ui = { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() };

  beforeEach(() => {
    team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "takeover-"));
    vi.stubEnv("PI_TEAM_NAME", team);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");
    vi.stubEnv("PI_AGENT_ID", "lead1111");
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
    vi.spyOn(paths, "teamDir").mockReturnValue(teamDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(teamDir, { recursive: true, force: true });
  });

  it("sends messages to the newest team-lead session", async () => {
    const original = loadExtension();
    await original.handlers.get("session_start")({}, { ui, hasUI: true });
    vi.stubEnv("PI_AGENT_ID", "lead2222");
    const window = loadExtension();
    await window.handlers.get("session_start")({}, { ui, hasUI: true });
    try {
      await sendToAgent(message("lead2222", "for the window"));
      await vi.waitFor(() => expect(window.sendUserMessage).toHaveBeenCalledTimes(1));
      expect(original.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await window.handlers.get("session_shutdown")({}, {});
      await original.handlers.get("session_shutdown")({}, {});
    }
  });

  it("keeps the newest session reachable when the older session shuts down first", async () => {
    const original = loadExtension();
    await original.handlers.get("session_start")({}, { ui, hasUI: true });
    vi.stubEnv("PI_AGENT_ID", "lead2222");
    const window = loadExtension();
    await window.handlers.get("session_start")({}, { ui, hasUI: true });
    try {
      await original.handlers.get("session_shutdown")({}, {});
      await sendToAgent(message("lead2222", "still there"));
      await vi.waitFor(() => expect(window.sendUserMessage).toHaveBeenCalledTimes(1));
    } finally {
      await window.handlers.get("session_shutdown")({}, {});
    }
  });
});
