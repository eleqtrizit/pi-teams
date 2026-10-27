import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import closeMyselfExtension from "./index";
import { registerCloseMyself } from "./shared-tools";
import * as messaging from "../src/utils/messaging";
import { AgentKind, type AgentRecord } from "../src/utils/models";
import { ObligationTracker } from "../src/utils/obligations";
import type { SharedToolDeps } from "./shared-tools";
import type { TerminalAdapter } from "../src/utils/terminal-adapter";

const teamsMocks = vi.hoisted(() => ({
  removeAgent: vi.fn(),
}));

vi.mock("../src/utils/teams", () => ({
  removeAgent: teamsMocks.removeAgent,
}));

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

const workerId = "clswrk01";
const leadId = "clsled01";
const peerId = "peer1111";
const leadRecord: AgentRecord = {
  id: leadId,
  kind: AgentKind.Lead,
  cwd: process.cwd(),
  pid: process.pid,
  startedAt: 1,
};

/**
 * Load the extension into a mock pi API and return the registered tools.
 * The extension reads PI_* environment variables when it runs, so tests
 * stub the environment before calling this helper.
 */
function registerExtensionForCurrentEnv(): Map<string, any> {
  const registered = new Map<string, any>();
  closeMyselfExtension({
    on: vi.fn(),
    registerTool: (tool: any) => registered.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return registered;
}

describe("close_myself registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // The extension writes PI_AGENT_ID back into process.env on every run,
    // so unstubAllEnvs alone leaves a preassigned id behind.
    delete process.env.PI_AGENT_ID;
    delete process.env.PI_LEAD_ID;
    vi.restoreAllMocks();
  });

  it("registers close_myself for teammates", () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");

    const tools = registerExtensionForCurrentEnv();
    const closeMyself = tools.get("close_myself");

    expect(closeMyself).toBeDefined();
    expect(closeMyself.label).toBe("Close Myself");
    expect(closeMyself.description).toContain(
      "Do not run this unless your instructions told you to run it.",
    );
  });

  it("does not register close_myself for the interactive lead session", () => {
    vi.stubEnv("PI_AGENT_NAME", "");

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(false);
  });

  it("registers close_myself for a spawned lead (preassigned PI_AGENT_ID)", () => {
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", leadId);

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(true);
  });

  it("registers close_myself for a read-only worker", () => {
    vi.stubEnv("PI_AGENT_NAME", "audit-1");
    vi.stubEnv("PI_AGENT_TYPE", "readonly-worker");

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(true);
  });
});

/** Build a minimal selfRecord for a worker with a lead. */
function makeSelfRecord(): AgentRecord {
  return {
    id: workerId,
    kind: AgentKind.Teammate,
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: 1,
    name: "worker-1",
    leadId,
  };
}

/** Register close_myself with custom deps and return the tool. */
function registerCloseMyselfTool(deps: Partial<SharedToolDeps>): any {
  const registered = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => registered.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any;
  const fullDeps: SharedToolDeps = {
    agentName: "worker-1",
    agentId: workerId,
    isWorker: true,
    messageListener: null,
    onMessageSent: vi.fn(),
    onRecipientUnreachable: vi.fn(),
    obligations: new ObligationTracker(),
    terminal: null as TerminalAdapter | null,
    selfRecord: makeSelfRecord(),
    ...deps,
  };
  registerCloseMyself(pi, fullDeps);
  return registered.get("close_myself");
}

function stubWorkerEnv(): void {
  vi.stubEnv("PI_AGENT_NAME", "worker-1");
  vi.stubEnv("PI_AGENT_TYPE", "teammate");
  vi.stubEnv("PI_AGENT_ID", workerId);
  vi.stubEnv("PI_LEAD_ID", leadId);
}

describe("close_myself execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkerEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.PI_AGENT_ID;
    delete process.env.PI_LEAD_ID;
    vi.restoreAllMocks();
  });

  it("delegates self-termination to removeAgent with its own process id", async () => {
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const tools = registerExtensionForCurrentEnv();
    const closeMyself = tools.get("close_myself");

    const result = await closeMyself.execute(
      "tool-call-1",
      {},
      undefined,
      undefined,
      {},
    );

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: workerId,
      ownPid: process.pid,
      terminal: null,
    });
    expect(result.content[0].text).toContain("closed itself");
  });

  it("sends one Closed notice per owed obligation before removing itself", async () => {
    const tracker = new ObligationTracker();
    tracker.record(leadId, "Pi Agent in /lead", "Question 1");
    tracker.record(peerId, "Peer Lead in /other", "Question 2");

    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const closeMyself = registerCloseMyselfTool({ obligations: tracker });

    await closeMyself.execute("tool-call-1", {}, undefined, undefined, {});

    // Closed notices sent before removeAgent
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const calls = sendSpy.mock.calls;
    expect(calls[0][1]).toBe(leadId);
    expect(calls[0][2]).toBe("Closed: Worker worker-1 in " + process.cwd());
    expect(calls[0][3]).toContain('closed itself before replying to "Question 1"');
    expect(calls[0][4]).toBe(false);
    expect(calls[1][1]).toBe(peerId);
    expect(calls[1][2]).toBe("Closed: Worker worker-1 in " + process.cwd());
    expect(calls[1][3]).toContain('closed itself before replying to "Question 2"');
    expect(calls[1][4]).toBe(false);
    // removeAgent called after notices
    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when no obligations are owed and still removes itself", async () => {
    const tracker = new ObligationTracker();
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const closeMyself = registerCloseMyselfTool({ obligations: tracker });

    await closeMyself.execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy).not.toHaveBeenCalled();
    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("continues removal even when a notice send fails", async () => {
    const tracker = new ObligationTracker();
    tracker.record(leadId, "Pi Agent in /lead", "Question 1");
    tracker.record(peerId, "Peer Lead in /other", "Question 2");

    const sendSpy = vi.spyOn(messaging, "sendAgentMessage")
      .mockImplementationOnce(async () => { throw new Error("lead down"); })
      .mockImplementationOnce(async () => leadRecord);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const closeMyself = registerCloseMyselfTool({ obligations: tracker });

    await closeMyself.execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("skips notices when selfRecord is null", async () => {
    const tracker = new ObligationTracker();
    tracker.record(leadId, "Pi Agent in /lead", "Question 1");
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const closeMyself = registerCloseMyselfTool({ obligations: tracker, selfRecord: null });

    await closeMyself.execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy).not.toHaveBeenCalled();
    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("removes itself without sending notices when a spawned lead closes itself", async () => {
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", leadId);
    vi.stubEnv("PI_LEAD_ID", "");
    teamsMocks.removeAgent.mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage");

    const tools = registerExtensionForCurrentEnv();

    const result = await tools.get("close_myself").execute(
      "tool-call-1",
      {},
      undefined,
      undefined,
      {},
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: leadId,
      ownPid: process.pid,
      terminal: null,
    });
    expect(result.content[0].text).toContain("closed itself");
  });

  it("closes itself even when no team name is set", async () => {
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const tools = registerExtensionForCurrentEnv();
    const closeMyself = tools.get("close_myself");

    const result = await closeMyself.execute(
      "tool-call-1",
      {},
      undefined,
      undefined,
      {},
    );

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("closed itself");
  });
});
