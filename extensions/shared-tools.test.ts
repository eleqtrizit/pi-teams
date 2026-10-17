import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKind, type AgentRecord } from "../src/utils/models";
import * as messaging from "../src/utils/messaging";
import * as registry from "../src/utils/registry";
import { RecipientUnreachableError } from "../src/utils/transport";
import { ObligationTracker } from "../src/utils/obligations";
import { registerSharedTools } from "./shared-tools";

const NO_REPLY =
  "No reply is expected. If you wish to change this, send another message with " +
  "'Please reply with update' with expectReply set to true.";
const REPLY_EXPECTED =
  "A reply is expected and will arrive as a user message. End your turn; do not wait or poll.";

function makeAgent(
  id: string,
  kind: AgentKind,
  options: { name?: string; leadId?: string } = {},
): AgentRecord {
  return {
    id,
    kind,
    cwd: `/agents/${options.name ?? id}`,
    pid: 123,
    startedAt: 1,
    ...options,
  };
}

function loadTool(selfRecord: AgentRecord | null) {
  let tool: any;
  const pi = {
    registerTool: (registered: any) => {
      if (registered.name === "send_message") tool = registered;
    },
    registerCommand: vi.fn(),
  } as any;
  const deps = {
    agentName: selfRecord?.name ?? "lead",
    agentId: selfRecord?.id ?? "lead1111",
    isWorker: selfRecord?.kind !== AgentKind.Lead,
    getTeamName: () => undefined,
    messageListener: null,
    isMemberAlive: () => false,
    isAgentActive: () => false,
    onMessageSent: vi.fn(),
    onRecipientUnreachable: vi.fn(),
    obligations: new ObligationTracker(),
    terminal: null,
    selfRecord,
  };
  registerSharedTools(pi, deps);
  return { tool, deps };
}

describe("send_message registry addressing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends to a resolved agent ID and displays its label and ID", async () => {
    const lead = makeAgent("lead1111", AgentKind.Lead);
    const worker = makeAgent("work1111", AgentKind.Teammate, {
      name: "worker-1",
      leadId: lead.id,
    });
    const { tool } = loadTool(worker);
    const records = [lead, worker];
    const readSpy = vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(lead);

    const result = await tool.execute("call", {
      recipient: "lead",
      subject: "Status",
      content: "Done",
      expectReply: false,
      summary: "Finished",
    });

    expect(readSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      worker,
      "lead",
      "Status",
      "Done",
      false,
      "Finished",
      records,
    );
    expect(result.content[0].text).toBe(
      `Message sent to ${messaging.agentLabel(lead)} (${lead.id}). ${NO_REPLY}\n\nDone`,
    );
  });

  it("broadcasts to visible agents and reports recipients by label and ID", async () => {
    const lead = makeAgent("lead1111", AgentKind.Lead);
    const worker = makeAgent("work1111", AgentKind.Teammate, {
      name: "worker-1",
      leadId: lead.id,
    });
    const sibling = makeAgent("sibl1111", AgentKind.ReadonlyWorker, {
      name: "worker-2",
      leadId: lead.id,
    });
    const { tool } = loadTool(worker);
    const records = [lead, worker, sibling];
    vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [lead],
      failed: [{ record: sibling, reason: "socket closed" }],
    });

    const result = await tool.execute("call", {
      recipient: "all",
      subject: "Update",
      content: "Ready",
      expectReply: false,
    });

    expect(result.content[0].text).toBe(
      `Message sent to ${messaging.agentLabel(lead)} (${lead.id}). ${NO_REPLY}\n` +
        `Not reached: ${messaging.agentLabel(sibling)} (${sibling.id}): socket closed`,
    );
  });

  it("requires the session to have a registry record", async () => {
    const { tool } = loadTool(null);
    await expect(
      tool.execute("call", { recipient: "someone", subject: "s", content: "c", expectReply: false }),
    ).rejects.toThrow("This session is not registered in the agent registry.");
  });

  it("fails a broadcast that reaches no recipients", async () => {
    const lead = makeAgent("lead1111", AgentKind.Lead);
    const worker = makeAgent("work1111", AgentKind.Teammate, {
      name: "worker-1",
      leadId: lead.id,
    });
    const { tool } = loadTool(worker);
    const records = [lead, worker];
    vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [],
      failed: [{ record: lead, reason: "offline" }],
    });

    await expect(
      tool.execute("call", { recipient: "all", subject: "s", content: "c", expectReply: false }),
    ).rejects.toThrow(/Broadcast reached no one.*offline/);
  });
});

describe("send_message expectReply", () => {
  afterEach(() => vi.restoreAllMocks());

  const lead = makeAgent("lead1111", AgentKind.Lead);
  const worker = makeAgent("work1111", AgentKind.Teammate, { name: "worker-1", leadId: lead.id });
  const sibling = makeAgent("sibl1111", AgentKind.ReadonlyWorker, { name: "worker-2", leadId: lead.id });
  const label = (r: AgentRecord) => `${messaging.agentLabel(r)} (${r.id})`;

  it("marks expectReply as a required boolean after content", () => {
    const { tool } = loadTool(worker);
    const schema = tool.parameters;
    expect(schema.required).toContain("expectReply");
    expect(schema.properties.expectReply.type).toBe("boolean");
    expect(schema.properties.expectReply.description).toBe(
      "Set to true when you need an answer: assigning a task, asking a question, or requesting a status update. " +
        "The recipient is reminded until it messages you back. " +
        "Set to false for replies, reports, acknowledgments, and updates that need no answer.",
    );
    const keys = Object.keys(schema.properties);
    expect(keys.indexOf("expectReply")).toBe(keys.indexOf("content") + 1);
  });

  it("passes true to sendAgentMessage and reports that a reply is expected", async () => {
    const { tool, deps } = loadTool(worker);
    const records = [lead, worker];
    vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(lead);

    const result = await tool.execute("call", {
      recipient: lead.id,
      subject: "Q",
      content: "Body",
      expectReply: true,
    });

    expect(sendSpy).toHaveBeenCalledWith(worker, lead.id, "Q", "Body", true, undefined, records);
    expect(result.content[0].text).toBe(`Message sent to ${label(lead)}. ${REPLY_EXPECTED}\n\nBody`);
    expect(deps.onMessageSent).toHaveBeenCalledWith(lead.id);
    expect(deps.onRecipientUnreachable).not.toHaveBeenCalled();
  });

  it("passes the flag to broadcastAgentMessage and reports delivered ids", async () => {
    const { tool, deps } = loadTool(worker);
    const records = [lead, worker, sibling];
    vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    const broadcastSpy = vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [lead, sibling],
      failed: [],
    });

    const result = await tool.execute("call", {
      recipient: "all",
      subject: "Q",
      content: "Body",
      expectReply: true,
    });

    expect(broadcastSpy).toHaveBeenCalledWith(worker, "Q", "Body", true, undefined, records);
    expect(result.content[0].text).toBe(`Message sent to ${label(lead)}, ${label(sibling)}. ${REPLY_EXPECTED}`);
    expect(deps.onMessageSent).toHaveBeenCalledTimes(2);
    expect(deps.onMessageSent).toHaveBeenCalledWith(lead.id);
    expect(deps.onMessageSent).toHaveBeenCalledWith(sibling.id);
  });

  it("calls onRecipientUnreachable for failed broadcast recipients", async () => {
    const { tool, deps } = loadTool(worker);
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([lead, worker, sibling]);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [lead],
      failed: [{ record: sibling, reason: "not reachable" }],
    });

    await tool.execute("call", { recipient: "all", subject: "s", content: "c", expectReply: false });

    expect(deps.onMessageSent).toHaveBeenCalledOnce();
    expect(deps.onRecipientUnreachable).toHaveBeenCalledOnce();
    expect(deps.onRecipientUnreachable).toHaveBeenCalledWith(sibling.id);
  });

  it("reports unreachable recipients when a broadcast delivers to no one", async () => {
    const { tool, deps } = loadTool(worker);
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([lead, worker]);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [],
      failed: [{ record: lead, reason: "offline" }],
    });

    await expect(
      tool.execute("call", { recipient: "all", subject: "s", content: "c", expectReply: true }),
    ).rejects.toThrow(/Broadcast reached no one/);
    expect(deps.onMessageSent).not.toHaveBeenCalled();
    expect(deps.onRecipientUnreachable).toHaveBeenCalledWith(lead.id);
  });

  it("calls onRecipientUnreachable and rethrows a RecipientUnreachableError", async () => {
    const { tool, deps } = loadTool(worker);
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([lead, worker]);
    const error = new RecipientUnreachableError(lead.id);
    vi.spyOn(messaging, "sendAgentMessage").mockRejectedValue(error);

    await expect(
      tool.execute("call", { recipient: "lead", subject: "s", content: "c", expectReply: true }),
    ).rejects.toBe(error);
    expect(deps.onRecipientUnreachable).toHaveBeenCalledWith(lead.id);
    expect(deps.onMessageSent).not.toHaveBeenCalled();
  });

  it("does not call onRecipientUnreachable for other send errors", async () => {
    const { tool, deps } = loadTool(worker);
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([lead, worker]);
    const error = new Error("boom");
    vi.spyOn(messaging, "sendAgentMessage").mockRejectedValue(error);

    await expect(
      tool.execute("call", { recipient: "lead", subject: "s", content: "c", expectReply: false }),
    ).rejects.toBe(error);
    expect(deps.onRecipientUnreachable).not.toHaveBeenCalled();
  });

  it("does not call onRecipientUnreachable when the recipient is not visible", async () => {
    const { tool, deps } = loadTool(worker);
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([lead, worker]);

    await expect(
      tool.execute("call", { recipient: "nobody1", subject: "s", content: "c", expectReply: false }),
    ).rejects.toThrow(/Unknown recipient/);
    expect(deps.onRecipientUnreachable).not.toHaveBeenCalled();
    expect(deps.onMessageSent).not.toHaveBeenCalled();
  });
});
