import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import peerReplyExtension from "./index";
import * as messaging from "../src/utils/messaging";
import * as registry from "../src/utils/registry";
import { AgentKind, type AgentRecord, type TeamMessage } from "../src/utils/models";
import { sendToAgent } from "../src/utils/transport";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

const lead: AgentRecord = {
  id: "prlead01",
  kind: AgentKind.Lead,
  cwd: "/tmp/peer-reply-lead",
  pid: 1,
  startedAt: 1,
};
const peer: AgentRecord = {
  id: "prpeer01",
  kind: AgentKind.Lead,
  cwd: "/tmp/peer-reply-peer",
  pid: 2,
  startedAt: 2,
};
const records = [lead, peer];

function loadLead() {
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const tools = new Map<string, any>();
  const sendUserMessage = vi.fn().mockResolvedValue(undefined);
  peerReplyExtension({
    on: (name: string, handler: (...args: any[]) => Promise<void>) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage,
  } as any);
  return { handlers, tools, sendUserMessage };
}

const userReply = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function inbound(subject: string): TeamMessage {
  return {
    id: "peer-msg-001",
    from: peer.id,
    to: lead.id,
    fromLabel: messaging.agentLabel(peer),
    subject,
    text: "Peer request",
    timestamp: new Date().toISOString(),
  };
}

describe("lead peer auto-replies", () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "lead");
    vi.stubEnv("PI_AGENT_ID", lead.id);
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.stubEnv("PI_LEAD_ID", "");
    vi.spyOn(registry, "ensureRegistryDir").mockImplementation(() => {});
    vi.spyOn(registry, "writeAgentRecord").mockImplementation(() => {});
    vi.spyOn(registry, "readAgentRecord").mockImplementation((id) => records.find((record) => record.id === id));
    vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(peer);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function start(handlers: Map<string, (...args: any[]) => Promise<void>>): Promise<void> {
    await handlers.get("session_start")?.({}, {
      ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
      hasUI: true,
      model: { provider: "test", id: "model" },
    });
  }

  async function receive(subject: string): Promise<void> {
    await sendToAgent(inbound(subject));
  }

  it("replies to a peer lead with the final reply", async () => {
    const { handlers, sendUserMessage } = loadLead();
    await start(handlers);
    await receive("Request");
    expect(sendUserMessage).toHaveBeenCalledOnce();
    await handlers.get("agent_end")?.({ messages: [userReply("Handled the request.")] });
    await handlers.get("agent_settled")?.({ aborted: false });

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: lead.id }),
      peer.id,
      `Reply from Pi Agent in ${process.cwd()}`,
      "Handled the request.",
    );
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("does not auto-reply after a manual send to that peer", async () => {
    const { handlers, tools } = loadLead();
    await start(handlers);
    await receive("Request");
    await tools.get("send_message").execute("call", {
      recipient: peer.id,
      subject: "Manual response",
      content: "Answered directly.",
    });
    sendSpy.mockClear();
    await handlers.get("agent_settled")?.({ aborted: false });
    expect(sendSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("does not reply to a user-initiated run", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await handlers.get("agent_end")?.({ messages: [userReply("User task done.")] });
    await handlers.get("agent_settled")?.({ aborted: false });
    expect(sendSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("does not auto-reply to an incoming automatic reply", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await receive("Reply from another lead");
    await handlers.get("agent_end")?.({ messages: [userReply("Acknowledged.")] });
    await handlers.get("agent_settled")?.({ aborted: false });
    expect(sendSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });

  it("clears peer tracking after settle", async () => {
    const { handlers } = loadLead();
    await start(handlers);
    await receive("Request");
    await handlers.get("agent_end")?.({ messages: [userReply("First cycle.")] });
    await handlers.get("agent_settled")?.({ aborted: false });
    expect(sendSpy).toHaveBeenCalledOnce();

    sendSpy.mockClear();
    await handlers.get("agent_end")?.({ messages: [userReply("Second cycle.")] });
    await handlers.get("agent_settled")?.({ aborted: false });
    expect(sendSpy).not.toHaveBeenCalled();
    await handlers.get("session_shutdown")?.({}, {});
  });
});
