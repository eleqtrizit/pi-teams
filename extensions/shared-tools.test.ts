import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKind, type AgentRecord } from "../src/utils/models";
import * as messaging from "../src/utils/messaging";
import * as registry from "../src/utils/registry";
import { registerSharedTools } from "./shared-tools";

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
    isTeammate: selfRecord?.kind !== AgentKind.Lead,
    getTeamName: () => undefined,
    messageListener: null,
    isMemberAlive: () => false,
    isAgentActive: () => false,
    setReportedToLead: vi.fn(),
    markRepliedToPeer: vi.fn(),
    cycleReplies: [],
    currentRunText: null,
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
    const { tool, deps } = loadTool(worker);
    const records = [lead, worker];
    const readSpy = vi.spyOn(registry, "readAgentRecords").mockReturnValue(records);
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(lead);

    const result = await tool.execute("call", {
      recipient: "lead",
      subject: "Status",
      content: "Done",
      summary: "Finished",
    });

    expect(readSpy).toHaveBeenCalledOnce();
    expect(sendSpy).toHaveBeenCalledWith(
      worker,
      "lead",
      "Status",
      "Done",
      "Finished",
      records,
    );
    expect(deps.setReportedToLead).toHaveBeenCalledWith(true);
    expect(result.content[0].text).toBe(
      `Message sent to ${messaging.agentLabel(lead)} (${lead.id}).\n\nDone`,
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
    const { tool, deps } = loadTool(worker);
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
    });

    expect(deps.setReportedToLead).toHaveBeenCalledWith(true);
    expect(result.content[0].text).toBe(
      `Message sent to ${messaging.agentLabel(lead)} (${lead.id}).\n` +
        `Not reached: ${messaging.agentLabel(sibling)} (${sibling.id}): socket closed`,
    );
  });

  it("requires the session to have a registry record", async () => {
    const { tool } = loadTool(null);
    await expect(
      tool.execute("call", { recipient: "someone", subject: "s", content: "c" }),
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
      tool.execute("call", { recipient: "all", subject: "s", content: "c" }),
    ).rejects.toThrow(/Broadcast reached no one.*offline/);
  });
});
