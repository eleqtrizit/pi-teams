import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import closeMyselfExtension from "./index";
import * as messaging from "../src/utils/messaging";

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
}));

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

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
    vi.stubEnv("PI_TEAM_NAME", "close-myself-team");

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
    vi.stubEnv("PI_TEAM_NAME", "");

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(false);
    expect(tools.has("team_create")).toBe(true);
  });

  it("does not register close_myself for a lead window (PI_AGENT_NAME=team-lead)", () => {
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_TEAM_NAME", "close-myself-team");

    const tools = registerExtensionForCurrentEnv();

    expect(tools.has("close_myself")).toBe(false);
    expect(tools.has("team_create")).toBe(true);
  });

  it("registers close_myself for a read-only worker", () => {
    vi.stubEnv("PI_AGENT_NAME", "audit-1");
    vi.stubEnv("PI_AGENT_TYPE", "readonly-worker");
    vi.stubEnv("PI_TEAM_NAME", "close-myself-team");

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

describe("close_myself execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_TEAM_NAME", "close-myself-team");
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
      team: "close-myself-team",
      agentName: "worker-1",
      ownPid: process.pid,
      terminal: null,
    });
    expect(result.content[0].text).toContain("closed itself");
  });

  it("reports its replies to the team-lead before it removes itself", async () => {
    const order: string[] = [];
    const sendSpy = vi.spyOn(messaging, "sendPlainMessage").mockImplementation(async () => {
      order.push("report");
    });
    teamsMocks.removeAgent.mockImplementation(async () => {
      order.push("remove");
    });

    const { tools, handlers } = registerWithHandlers();
    await handlers.get("agent_end")(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "first run" }] }] },
      { hasUI: true },
    );
    await handlers.get("message_end")({
      message: { role: "assistant", content: [{ type: "text", text: "wrote the file" }] },
    });
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(order).toEqual(["report", "remove"]);
    const body = sendSpy.mock.calls[0][5] as string;
    expect(body).toContain("first run");
    expect(body).toContain("wrote the file");
    expect(body).toContain("closed itself");
    expect(sendSpy.mock.calls[0][3]).toBe("team-lead");
  });

  it("still removes itself when the report cannot be sent", async () => {
    vi.spyOn(messaging, "sendPlainMessage").mockRejectedValue(new Error("lead gone"));
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const { tools } = registerWithHandlers();
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
  });

  it("does not count a tool-call-only message as text", async () => {
    const sendSpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined);
    teamsMocks.removeAgent.mockResolvedValue(undefined);

    const { tools, handlers } = registerWithHandlers();
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "kept" }] } });
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "toolCall", name: "close_myself" }] } });
    await tools.get("close_myself").execute("tool-call-1", {}, undefined, undefined, {});

    expect(sendSpy.mock.calls[0][5]).toContain("kept");
  });

  it("throws when no team is active for this agent", async () => {
    vi.stubEnv("PI_TEAM_NAME", "");

    const tools = registerExtensionForCurrentEnv();
    const closeMyself = tools.get("close_myself");

    await expect(
      closeMyself.execute("tool-call-1", {}, undefined, undefined, {}),
    ).rejects.toThrow(
      "No team is active for this agent, so there is nothing to close.",
    );
    expect(teamsMocks.removeAgent).not.toHaveBeenCalled();
  });
});
