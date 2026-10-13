import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import autoReportExtension from "./index";
import * as messaging from "../src/utils/messaging";

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

describe("worker auto-report on agent_settled", () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_TEAM_NAME", "report-team");
    sendSpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends the full final reply to the team-lead when the run settles", async () => {
    const { handlers } = loadWorker();
    await handlers.get("agent_end")({ messages: [assistantMessage("Here are the results.")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      "report-team",
      "worker-1",
      "team-lead",
      "Report from worker-1",
      "Here are the results.",
    );
  });

  it("reports every run's reply when several runs settle together", async () => {
    const { handlers } = loadWorker();
    await handlers.get("agent_end")({ messages: [assistantMessage("first")] });
    await handlers.get("agent_end")({ messages: [{ role: "assistant", content: [] }] });
    await handlers.get("agent_end")({ messages: [assistantMessage("second")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const body = sendSpy.mock.calls[0][4] as string;
    expect(body).toContain("Reply 1 of 2:\n\nfirst");
    expect(body).toContain("Reply 2 of 2:\n\nsecond");
  });

  it("starts the next cycle with no replies from the last one", async () => {
    const { handlers } = loadWorker();
    await handlers.get("agent_end")({ messages: [assistantMessage("old")] });
    await handlers.get("agent_settled")({ aborted: false });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("new")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy.mock.calls[0][4]).toBe("new");
  });

  it("skips the report when the worker already messaged the team-lead", async () => {
    const { handlers, tools } = loadWorker();
    await tools.get("send_message").execute("id", {
      recipient: "team-lead",
      subject: "s",
      content: "manual report",
    });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("reports again on the next cycle after skipping once", async () => {
    const { handlers, tools } = loadWorker();
    await tools.get("send_message").execute("id", { recipient: "team-lead", subject: "s", content: "c" });
    await handlers.get("agent_settled")({ aborted: false });
    sendSpy.mockClear();

    await handlers.get("agent_end")({ messages: [assistantMessage("second cycle")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("does not count a message to another worker as a report", async () => {
    const { handlers, tools } = loadWorker();
    await tools.get("send_message").execute("id", { recipient: "worker-2", subject: "s", content: "c" });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("counts a broadcast that reached the team-lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    vi.spyOn(messaging, "broadcastMessage").mockResolvedValue({ delivered: ["team-lead", "worker-2"], failed: [] });
    await tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" });
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("does not count a broadcast that missed the team-lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    vi.spyOn(messaging, "broadcastMessage").mockResolvedValue({
      delivered: ["worker-2"],
      failed: [{ name: "team-lead", reason: "not reachable" }],
    });
    const result = await tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" });
    expect(result.content[0].text).toContain("Not reached: team-lead");
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("fails a broadcast that reached no one", async () => {
    const { tools } = loadWorker();
    vi.spyOn(messaging, "broadcastMessage").mockResolvedValue({
      delivered: [],
      failed: [{ name: "team-lead", reason: "not reachable" }],
    });
    await expect(
      tools.get("send_message").execute("id", { recipient: "all", subject: "s", content: "c" }),
    ).rejects.toThrow(/reached no one/);
  });

  it("does not count a failed send to the team-lead as a report", async () => {
    const { handlers, tools } = loadWorker();
    sendSpy.mockRejectedValueOnce(new Error("not reachable"));
    await expect(
      tools.get("send_message").execute("id", { recipient: "team-lead", subject: "s", content: "c" }),
    ).rejects.toThrow(/not reachable/);
    sendSpy.mockClear();
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await handlers.get("agent_settled")({ aborted: false });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("sends an interruption notice for an aborted run even after a manual report", async () => {
    const { handlers, tools } = loadWorker();
    await tools.get("send_message").execute("id", { recipient: "team-lead", subject: "s", content: "c" });
    sendSpy.mockClear();
    await handlers.get("agent_settled")({ aborted: true });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][4]).toContain("interrupted");
  });

  it("survives a send failure", async () => {
    const { handlers } = loadWorker();
    sendSpy.mockRejectedValue(new Error("Team not found"));
    await handlers.get("agent_end")({ messages: [assistantMessage("done")] });
    await expect(handlers.get("agent_settled")({ aborted: false })).resolves.toBeUndefined();
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
