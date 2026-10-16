import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as paths from "../src/utils/paths";
import closeMyselfExtension from "./index";
import * as messaging from "../src/utils/messaging";
import { AgentKind, type AgentRecord } from "../src/utils/models";

const teamsMocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  removeMember: vi.fn(),
  removeAgent: vi.fn(),
}));

vi.mock("../src/utils/teams", () => ({
  teamExists: vi.fn(() => true),
  readConfig: teamsMocks.readConfig,
  removeMember: teamsMocks.removeMember,
  removeAgent: teamsMocks.removeAgent,
  createTeam: vi.fn(),
  addMember: vi.fn(),
  updateMember: vi.fn(),
  resetAgentState: vi.fn(),
}));

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

const workerId = "clswrk01";
const leadId = "clsled01";
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

  it("registers close_myself for a read-only worker", () => {
    vi.stubEnv("PI_AGENT_NAME", "audit-1");
    vi.stubEnv("PI_AGENT_TYPE", "readonly-worker");

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(true);
  });
});

/** Load the extension and keep both the tools and the event handlers. */
function registerWithHandlers(): { tools: Map<string, any>; handlers: { get(name: string): (...a: any[]) => Promise<void> } } {
  const tools = new Map<string, any>();
  const registered = new Map<string, any[]>();
  closeMyselfExtension({
    on: (name: string, handler: any) => registered.set(name, [...(registered.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  const handlers = {
    get: (name: string) => async (...args: any[]) => {
      for (const handler of registered.get(name) ?? []) await handler(...args);
    },
  };
  return { tools, handlers };
}

async function initializeWorkerSession(
  handlers: { get(name: string): (...args: any[]) => Promise<void> },
): Promise<void> {
  paths.ensureDirs();
  await handlers.get("session_start")({}, {
    ui: { notify: vi.fn(), setStatus: vi.fn(), setTitle: vi.fn() },
    hasUI: false,
  });
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

  it("reports its replies to the registered lead before it removes itself", async () => {
    const order: string[] = [];
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockImplementation(async () => {
      order.push("report");
      return leadRecord;
    });
    teamsMocks.removeAgent.mockImplementation(async () => {
      order.push("remove");
    });

    const { tools, handlers } = registerWithHandlers();
    await initializeWorkerSession(handlers);
    await handlers.get("agent_end")(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "first run" }] }] },
      { hasUI: true },
    );
    await handlers.get("message_end")({
      message: { role: "assistant", content: [{ type: "text", text: "wrote the file" }] },
    });
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(order).toEqual(["report", "remove"]);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: workerId, leadId }),
      messaging.LEAD_ALIAS,
      "Report from worker-1",
      expect.stringContaining("first run"),
    );
    const body = sendSpy.mock.calls[0][3] as string;
    expect(body).toContain("first run");
    expect(body).toContain("wrote the file");
    expect(body).toContain("closed itself");
  });

  it("still removes itself when the report cannot be sent", async () => {
    vi.spyOn(messaging, "sendAgentMessage").mockRejectedValue(new Error("lead gone"));
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const { tools } = registerWithHandlers();
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("does not count a tool-call-only message as text", async () => {
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage").mockResolvedValue(leadRecord);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const { tools, handlers } = registerWithHandlers();
    await initializeWorkerSession(handlers);
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "kept" }] } });
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "toolCall", name: "close_myself" }] } });
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy.mock.calls[0][3]).toContain("kept");
  });

  it("skips the report when the worker has no lead id", async () => {
    vi.stubEnv("PI_LEAD_ID", "");
    teamsMocks.removeAgent.mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(messaging, "sendAgentMessage");

    const { tools } = registerWithHandlers();
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy).not.toHaveBeenCalled();
    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
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
