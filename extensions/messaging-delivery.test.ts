import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import deliveryExtension from "./index";
import * as paths from "../src/utils/paths";
import { sendToAgent } from "../src/utils/transport";
import { AgentKind, type AgentRecord, type TeamMessage } from "../src/utils/models";

const selfRecord: AgentRecord = {
  id: "dlvr1111",
  kind: AgentKind.Teammate,
  cwd: "/tmp/delivery-worker",
  pid: 1,
  leadId: "lead1111",
  name: "worker-1",
  startedAt: 1,
};
const peerRecord: AgentRecord = {
  id: "peer1234",
  kind: AgentKind.Teammate,
  cwd: "/tmp/delivery-peer",
  pid: 2,
  leadId: "lead1111",
  name: "peer",
  startedAt: 1,
};
const unrelatedWorker: AgentRecord = {
  ...peerRecord,
  id: "other222",
  leadId: "otherld1",
};
const registryRecords: AgentRecord[] = [selfRecord, peerRecord, unrelatedWorker];

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

vi.mock("../src/utils/registry", () => ({
  generateAgentId: vi.fn(() => "abc12345"),
  ensureRegistryDir: vi.fn(),
  writeAgentRecord: vi.fn(),
  readAgentRecord: vi.fn((id: string) => registryRecords.find((record) => record.id === id)),
  readAgentRecords: vi.fn(() => registryRecords),
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
  const ui = { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() };

  beforeEach(() => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", "dlvr1111");
    vi.stubEnv("PI_LEAD_ID", "lead1111");
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("queues a received message as a follow-up user message", async () => {
    const { handlers, sendUserMessage } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    try {
      await sendToAgent(message("dlvr1111", "please review"));
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

  it("rejects a message from a worker owned by another lead", async () => {
    const { handlers, sendUserMessage } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    try {
      await expect(sendToAgent({ ...message("dlvr1111", "not visible"), from: unrelatedWorker.id }))
        .rejects.toThrow(/unknown or not visible/);
      expect(sendUserMessage).not.toHaveBeenCalled();
    } finally {
      await handlers.get("session_shutdown")({}, {});
    }
  });

  it("holds a message that arrives mid-run until the run ends", async () => {
    const { handlers, sendUserMessage } = loadExtension();
    await handlers.get("session_start")({}, { ui, hasUI: false });
    try {
      await handlers.get("agent_start")({}, {});
      await sendToAgent(message("dlvr1111", "mid-run note"));
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
    await expect(sendToAgent(message("dlvr1111", "late"))).rejects.toThrow(/not reachable/);
  });

  it("registers send_message but not broadcast_message", () => {
    const { tools } = loadExtension();
    expect(tools.has("send_message")).toBe(true);
    expect(tools.has("broadcast_message")).toBe(false);
  });
});


