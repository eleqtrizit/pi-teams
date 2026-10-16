import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autoReportExtension from "./index";
import * as fs from "node:fs";
import * as messaging from "../src/utils/messaging";
import * as registry from "../src/utils/registry";
import * as paths from "../src/utils/paths";
import { AgentKind, type AgentRecord } from "../src/utils/models";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

/** Load the extension as a worker and return its handlers and tools. */
function loadWorker(): { handlers: Map<string, any>; tools: Map<string, any> } {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  autoReportExtension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return { handlers, tools };
}

const assistantMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const leadRecord: AgentRecord = {
  id: "autold01",
  kind: AgentKind.Lead,
  cwd: "/tmp/report-lead",
  pid: 1,
  startedAt: 1,
};
const workerRecord: AgentRecord = {
  id: "autowk01",
  kind: AgentKind.Teammate,
  cwd: "/tmp/report-worker",
  pid: 2,
  leadId: leadRecord.id,
  name: "worker-1",
  startedAt: 1,
};
const siblingRecord: AgentRecord = {
  id: "autowk02",
  kind: AgentKind.Teammate,
  cwd: "/tmp/report-sibling",
  pid: 3,
  leadId: leadRecord.id,
  name: "worker-2",
  startedAt: 1,
};
const agentRecords = [leadRecord, workerRecord, siblingRecord];

async function initializeWorkerSession(handlers: Map<string, any>): Promise<void> {
  paths.ensureDirs();
  const teamDirectory = paths.teamDir("report-team");
  if (!fs.existsSync(teamDirectory)) {
    fs.mkdirSync(teamDirectory, { recursive: true });
  }
  await handlers.get("session_start")({}, {
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
    hasUI: false,
  });
  vi.spyOn(registry, "readAgentRecords").mockReturnValue(agentRecords);
}

describe("worker auto-report on agent_settled", () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", workerRecord.id);
    vi.stubEnv("PI_LEAD_ID", leadRecord.id);
    vi.stubEnv("PI_TEAM_NAME", "report-team");
    sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the full final reply to the registered lead when the run settles", async () => {
    const { handlers } = loadWorker();
    await initializeWorkerSession(handlers);
    await handlers.get("agent_end")({ messages: [assistantMessage("Here are the results.")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: workerRecord.id, leadId: leadRecord.id }),
      messaging.LEAD_ALIAS,
      "Report from worker-1",
      "Here are the results.",
    );
  });

  it("reports every run's reply when several runs settle together", async () => {
    const { handlers } = loadWorker();
    await initializeWorkerSession(handlers);
    await handlers.get("agent_end")({ messages: [assistantMessage("first")] });
    await handlers.get("agent_end")({ messages: [{ role: "assistant", content: [] }] });
    await handlers.get("agent_end")({ messages: [assistantMessage("second")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][3]).toContain("Reply 1 of 2:\n\nfirst");
    expect(sendSpy.mock.calls[0][3]).toContain("Reply 2 of 2:\n\nsecond");
  });

  it("starts the next cycle with no replies from the last one", async () => {
    const { handlers } = loadWorker();
    await initializeWorkerSession(handlers);
    await handlers.get("agent_end")({ messages: [assistantMessage("old")] });
    await handlers.get("agent_settled")({ aborted: false });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("new")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy.mock.calls[0][3]).toBe("new");
  });

  it("skips the report when the worker already messaged the lead", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    const manualSendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    await tools.get("send_message").execute("id", {
      recipient: "lead",
      subject: "s",
      content: "manual report",
    });
    expect(manualSendSpy).toHaveBeenCalledOnce();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(manualSendSpy).toHaveBeenCalledOnce();
  });

  it("reports again on the next cycle after skipping once", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    await tools.get("send_message").execute("id", { recipient: "lead", subject: "s", content: "c" });
    await handlers.get("agent_settled")({ aborted: false });
    sendSpy.mockClear();

    await handlers.get("agent_end")({ messages: [assistantMessage("second cycle")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("does not count a message to another worker as a report", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(siblingRecord);
    await tools.get("send_message").execute("id", { recipient: "worker-2", subject: "s", content: "c" });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("counts a broadcast that reached the lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    const broadcastSpy = vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({ delivered: [leadRecord, siblingRecord], failed: [] });
    await tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" });
    expect(broadcastSpy).toHaveBeenCalledOnce();
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(broadcastSpy).toHaveBeenCalledOnce();
  });

  it("does not count a broadcast that missed the lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [siblingRecord],
      failed: [{ record: leadRecord, reason: "not reachable" }],
    });
    const result = await tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" });
    expect(result.content[0].text).toContain(`${messaging.agentLabel(leadRecord)} (${leadRecord.id})`);
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("fails a broadcast that reached no one", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "broadcastAgentMessage").mockResolvedValue({
      delivered: [],
      failed: [{ record: leadRecord, reason: "not reachable" }],
    });
    await expect(
      tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" }),
    ).rejects.toThrow(/reached no one/);
  });

  it("does not count a failed send to the lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "sendAgentMessage").mockRejectedValueOnce(new Error("not reachable"));
    await expect(
      tools.get("send_message").execute("id", { recipient: "lead", subject: "s", content: "c" }),
    ).rejects.toThrow(/not reachable/);
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an interruption notice for an aborted run even after a manual report", async () => {
    const { handlers, tools } = loadWorker();
    await initializeWorkerSession(handlers);
    vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    await tools.get("send_message").execute("id", { recipient: "lead", subject: "s", content: "c" });
    sendSpy.mockClear();
    await handlers.get("agent_settled")({ aborted: true });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][3]).toContain("interrupted");
  });

  it("survives a send failure", async () => {
    const { handlers } = loadWorker();
    sendSpy.mockRejectedValue(new Error("Lead not found"));
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await expect(handlers.get("agent_settled")({ aborted: false })).resolves.toBeUndefined();
  });

  it("skips silently when no lead id is registered", async () => {
    vi.stubEnv("PI_LEAD_ID", "");
    const { handlers } = loadWorker();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does nothing for the team-lead session", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("PI_TEAM_NAME", "report-team");
    const { handlers } = loadWorker();
    await handlers.get("agent_end")?.({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
