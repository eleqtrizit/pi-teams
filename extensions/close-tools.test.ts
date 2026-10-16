import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { AgentKind, AgentRecord } from "../src/utils/models";
import { registerLeadTools } from "./lead-tools";
import type { TerminalAdapter } from "../src/utils/terminal-adapter";

const registryMocks = vi.hoisted(() => ({
  readAgentRecords: vi.fn(),
}));

const teamsMocks = vi.hoisted(() => ({
  removeAgent: vi.fn(),
}));

vi.mock("../src/utils/registry", () => ({
  readAgentRecords: registryMocks.readAgentRecords,
}));

vi.mock("../src/utils/teams", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/teams")>(
    "../src/utils/teams",
  );
  return {
    ...actual,
    removeAgent: teamsMocks.removeAgent,
  };
});

function fakeTerminal(): TerminalAdapter {
  return {
    name: "fake",
    detect: vi.fn(),
    spawn: vi.fn(),
    kill: vi.fn(),
    isAlive: vi.fn(),
    setTitle: vi.fn(),
    supportsWindows: vi.fn(),
    spawnWindow: vi.fn(),
    setWindowTitle: vi.fn(),
    killWindow: vi.fn(),
    isWindowAlive: vi.fn(),
  };
}

function makeDeps(overrides: Partial<any> = {}) {
  return {
    spawnTeamWorker: vi.fn(),
    terminal: fakeTerminal(),
    ensureListener: vi.fn(),
    getTeamName: () => "test-team",
    setTeamName: vi.fn(),
    getPendingMigrationNotice: () => undefined,
    setPendingMigrationNotice: vi.fn(),
    ...overrides,
  };
}

function loadTools(deps: any) {
  const tools = new Map<string, any>();
  registerLeadTools(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      sendUserMessage: vi.fn(),
    } as any,
    deps,
  );
  return tools;
}

function workerRecord(id: string, name: string, leadId: string): AgentRecord {
  return {
    id,
    kind: AgentKind.Teammate,
    cwd: "/tmp",
    pid: 1234,
    leadId,
    name,
    startedAt: 1000,
  };
}

describe("close_worker", () => {
  beforeEach(() => {
    vi.stubEnv("PI_AGENT_ID", "lead1234");
    teamsMocks.removeAgent.mockClear();
    registryMocks.readAgentRecords.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("closes an own worker by 8-char id", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      workerRecord("w1w1w1w1", "worker-1", "lead1234"),
    ]);

    const tools = loadTools(makeDeps());
    const result = await tools
      .get("close_worker")
      .execute("call-1", { agent: "w1w1w1w1" });

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(1);
    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: "w1w1w1w1",
      terminal: expect.anything(),
    });
    expect(result.content[0].text).toContain("shut down");
  });

  it("closes an own worker by name", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      workerRecord("w2w2w2w2", "alice", "lead1234"),
    ]);

    const tools = loadTools(makeDeps());
    await tools.get("close_worker").execute("call-1", { agent: "alice" });

    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: "w2w2w2w2",
      terminal: expect.anything(),
    });
  });

  it("refuses a non-existent worker", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      workerRecord("w3w3w3w3", "bob", "lead1234"),
    ]);

    const tools = loadTools(makeDeps());
    await expect(
      tools.get("close_worker").execute("call-1", { agent: "charlie" }),
    ).rejects.toThrow(/charlie not found among your workers/);
    expect(teamsMocks.removeAgent).not.toHaveBeenCalled();
  });

  it("refuses a peer lead by id", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      { id: "lead9999", kind: AgentKind.Lead, cwd: "/tmp", pid: 1, startedAt: 1000 },
    ]);

    const tools = loadTools(makeDeps());
    await expect(
      tools.get("close_worker").execute("call-1", { agent: "lead9999" }),
    ).rejects.toThrow(/Cannot close a peer lead/);
    expect(teamsMocks.removeAgent).not.toHaveBeenCalled();
  });

  it("refuses another lead's worker", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      workerRecord("w4w4w4w4", "dave", "other-lead"),
    ]);

    const tools = loadTools(makeDeps());
    await expect(
      tools.get("close_worker").execute("call-1", { agent: "w4w4w4w4" }),
    ).rejects.toThrow(/Cannot close another lead's worker/);
    expect(teamsMocks.removeAgent).not.toHaveBeenCalled();
  });

  it("throws when PI_AGENT_ID is missing", async () => {
    vi.stubEnv("PI_AGENT_ID", "");
    registryMocks.readAgentRecords.mockReturnValue([]);

    const tools = loadTools(makeDeps());
    await expect(
      tools.get("close_worker").execute("call-1", { agent: "any" }),
    ).rejects.toThrow(/PI_AGENT_ID is not set/);
  });
});

describe("close_all_workers", () => {
  beforeEach(() => {
    vi.stubEnv("PI_AGENT_ID", "lead1234");
    teamsMocks.removeAgent.mockClear();
    registryMocks.readAgentRecords.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("closes every own worker", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      workerRecord("w1w1w1w1", "worker-1", "lead1234"),
      workerRecord("w2w2w2w2", "worker-2", "lead1234"),
      workerRecord("w3w3w3w3", "peer-worker", "other-lead"),
      { id: "lead9999", kind: AgentKind.Lead, cwd: "/tmp", pid: 1, startedAt: 1000 },
    ]);

    const tools = loadTools(makeDeps());
    const result = await tools.get("close_all_workers").execute("call-1", {});

    expect(teamsMocks.removeAgent).toHaveBeenCalledTimes(2);
    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: "w1w1w1w1",
      terminal: expect.anything(),
    });
    expect(teamsMocks.removeAgent).toHaveBeenCalledWith({
      agentId: "w2w2w2w2",
      terminal: expect.anything(),
    });
    expect(result.content[0].text).toBe("Closed 2 worker(s).");
  });

  it("reports zero when the lead has no workers", async () => {
    registryMocks.readAgentRecords.mockReturnValue([
      { id: "lead9999", kind: AgentKind.Lead, cwd: "/tmp", pid: 1, startedAt: 1000 },
      workerRecord("w5w5w5w5", "other", "other-lead"),
    ]);

    const tools = loadTools(makeDeps());
    const result = await tools.get("close_all_workers").execute("call-1", {});

    expect(teamsMocks.removeAgent).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Closed 0 worker(s).");
  });

  it("throws when PI_AGENT_ID is missing", async () => {
    vi.stubEnv("PI_AGENT_ID", "");
    registryMocks.readAgentRecords.mockReturnValue([]);

    const tools = loadTools(makeDeps());
    await expect(
      tools.get("close_all_workers").execute("call-1", {}),
    ).rejects.toThrow(/PI_AGENT_ID is not set/);
  });
});
