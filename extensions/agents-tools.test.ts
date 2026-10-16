import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentKind, AgentStatus, type AgentRecord } from "../src/utils/models";
import { generateAgentId, pruneAndList } from "../src/utils/registry";
import type { SpawnOptions, TerminalAdapter } from "../src/utils/terminal-adapter";
import { waitForListener } from "../src/utils/transport";
import { registerAgentTools, type AgentToolDeps } from "./agents-tools";

vi.mock("../src/utils/registry", () => ({
  pruneAndList: vi.fn(),
  generateAgentId: vi.fn(),
}));

// Only waitForListener is consumed by agents-tools.ts; the socket probes
// behind it would hang for the full spawn timeout in every test.
vi.mock("../src/utils/transport", () => ({
  waitForListener: vi.fn(),
}));

/**
 * Load registerAgentTools into a mock pi API and return the `list_agents`
 * tool definition registered under the given self-record provider.
 */
function loadListAgentsTool(getSelfRecord: () => AgentRecord | null): any {
  const tools = new Map<string, any>();
  registerAgentTools(
    {
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    } as any,
    { getSelfRecord },
  );
  return tools.get("list_agents");
}

/** Run the tool and return its rendered text and details. */
async function runListAgents(
  getSelfRecord: () => AgentRecord | null,
): Promise<{ text: string; details: any }> {
  const tool = loadListAgentsTool(getSelfRecord);
  const result = await tool.execute("call-1", {}, undefined, undefined, {});
  return { text: result.content[0].text, details: result.details };
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    kind: AgentKind.Lead,
    cwd: "/w/alpha",
    pid: 1,
    startedAt: 1000,
    ...overrides,
  };
}

/** Two leads (A in /w/alpha, B in /w/beta), one offline lead (C in /w/gamma),
 *  and one worker per online lead. */
const leadA = makeRecord({ id: "aaaaaaaa", cwd: "/w/alpha", startedAt: 1000 });
const leadB = makeRecord({ id: "bbbbbbbb", cwd: "/w/beta", startedAt: 2000 });
const leadC = makeRecord({ id: "cccccccc", cwd: "/w/gamma", startedAt: 3000 });
const workerA = makeRecord({
  id: "d1d1d1d1",
  kind: AgentKind.Teammate,
  leadId: "aaaaaaaa",
  name: "alpha-worker",
  cwd: "/w/alpha",
  pid: 4,
  startedAt: 1500,
});
const workerB = makeRecord({
  id: "e2e2e2e2",
  kind: AgentKind.Teammate,
  leadId: "bbbbbbbb",
  name: "beta-worker",
  cwd: "/w/beta",
  pid: 5,
  startedAt: 2500,
});

/** Survivors of a mocked pruneAndList: every lead plus both online workers. */
function seededEntries() {
  vi.mocked(pruneAndList).mockResolvedValue([
    { record: leadA, status: AgentStatus.Online },
    { record: leadB, status: AgentStatus.Online },
    { record: leadC, status: AgentStatus.Offline },
    { record: workerA, status: AgentStatus.Online },
    { record: workerB, status: AgentStatus.Online },
  ]);
}

describe("list_agents", () => {
  beforeEach(() => {
    vi.mocked(pruneAndList).mockReset();
  });

  it("lists peer leads and own workers for a lead, excluding other leads' workers", async () => {
    seededEntries();

    const { text, details } = await runListAgents(() => leadA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online (you)",
        "Pi Agent in /w/beta: bbbbbbbb: Online",
        "Pi Agent in /w/gamma: cccccccc: Offline",
        "Worker alpha-worker in /w/alpha: d1d1d1d1: Online",
      ].join("\n"),
    );
    expect(text).not.toContain("e2e2e2e2");
    expect(text).not.toContain("beta-worker");
    const offlineLines = text.split("\n").filter((line) => line.endsWith("Offline"));
    expect(offlineLines).toHaveLength(1);
    expect(offlineLines[0]).toContain("cccccccc");

    expect(details.agents).toEqual([
      { id: "aaaaaaaa", kind: "lead", cwd: "/w/alpha", status: "Online" },
      { id: "bbbbbbbb", kind: "lead", cwd: "/w/beta", status: "Online" },
      { id: "cccccccc", kind: "lead", cwd: "/w/gamma", status: "Offline" },
      {
        id: "d1d1d1d1",
        kind: "teammate",
        cwd: "/w/alpha",
        name: "alpha-worker",
        status: "Online",
      },
    ]);
  });

  it("lists own lead and sibling workers for a worker, excluding peer leads", async () => {
    seededEntries();
    const sibling = makeRecord({
      id: "f3f3f3f3",
      kind: AgentKind.Teammate,
      leadId: "aaaaaaaa",
      name: "alpha-two",
      cwd: "/w/alpha",
      pid: 6,
      startedAt: 1600,
    });
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadA, status: AgentStatus.Online },
      { record: leadB, status: AgentStatus.Online },
      { record: leadC, status: AgentStatus.Offline },
      { record: workerA, status: AgentStatus.Online },
      { record: workerB, status: AgentStatus.Online },
      { record: sibling, status: AgentStatus.Online },
    ]);

    const { text } = await runListAgents(() => workerA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online",
        "Worker alpha-two in /w/alpha: f3f3f3f3: Online",
        "Worker alpha-worker in /w/alpha: d1d1d1d1: Online (you)",
      ].join("\n"),
    );
    expect(text).not.toContain("bbbbbbbb");
    expect(text).not.toContain("cccccccc");
    expect(text).not.toContain("e2e2e2e2");
  });

  it("includes self as Online when the registry has no record for this session", async () => {
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadB, status: AgentStatus.Online },
      { record: leadC, status: AgentStatus.Offline },
      { record: workerB, status: AgentStatus.Online },
    ]);

    const { text, details } = await runListAgents(() => leadA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online (you)",
        "Pi Agent in /w/beta: bbbbbbbb: Online",
        "Pi Agent in /w/gamma: cccccccc: Offline",
      ].join("\n"),
    );
    expect(details.agents[0]).toEqual({
      id: "aaaaaaaa",
      kind: "lead",
      cwd: "/w/alpha",
      status: "Online",
    });
  });

  it("forces self Online when its registry entry probed Offline", async () => {
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadA, status: AgentStatus.Offline },
      { record: workerA, status: AgentStatus.Online },
    ]);

    const { text } = await runListAgents(() => leadA);

    expect(text).toContain("Pi Agent in /w/alpha: aaaaaaaa: Online (you)");
    expect(text).not.toContain("aaaaaaaa: Offline");
  });

  it("shows only self for a worker with no leadId", async () => {
    seededEntries();
    const orphan = makeRecord({
      id: "a1b2c3d4",
      kind: AgentKind.Teammate,
      name: "lonely",
      cwd: "/w/theta",
      pid: 7,
      startedAt: 1200,
    });

    const { text, details } = await runListAgents(() => orphan);

    expect(text).toBe("Worker lonely in /w/theta: a1b2c3d4: Online (you)");
    expect(details.agents).toEqual([
      { id: "a1b2c3d4", kind: "teammate", cwd: "/w/theta", name: "lonely", status: "Online" },
    ]);
  });

  it("throws when the session is not registered in the agent registry", async () => {
    await expect(runListAgents(() => null)).rejects.toThrow(
      "This session is not registered in the agent registry.",
    );
  });
});

// ── spawn_team_lead ──────────────────────────────────────────────────────

/** Minimal terminal adapter that records spawn and spawnWindow calls. */
function fakeTerminal(
  overrides: Partial<TerminalAdapter> = {},
): TerminalAdapter & { spawnCalls: SpawnOptions[]; windowCalls: SpawnOptions[] } {
  const spawnCalls: SpawnOptions[] = [];
  const windowCalls: SpawnOptions[] = [];
  const adapter: TerminalAdapter = {
    name: "fake",
    detect: () => true,
    spawn: (options) => {
      spawnCalls.push(options);
      return "pane-1";
    },
    kill: () => {},
    isAlive: () => true,
    setTitle: () => {},
    supportsWindows: () => false,
    spawnWindow: (options) => {
      windowCalls.push(options);
      return "win-1";
    },
    setWindowTitle: () => {},
    killWindow: () => {},
    isWindowAlive: () => false,
    ...overrides,
  };
  return Object.assign(adapter, { spawnCalls, windowCalls });
}

/** Extension context stub: a single provider/model pair in the registry. */
const fakeCtx = {
  model: { provider: "provider", id: "model" },
  modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
} as unknown as ExtensionContext;

/** Register the agent tools with a mock pi API and return them by name. */
function loadAgentTools(deps: Partial<AgentToolDeps>): Map<string, any> {
  const tools = new Map<string, any>();
  registerAgentTools(
    {
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    } as any,
    { getSelfRecord: () => leadA, isLead: true, ...deps },
  );
  return tools;
}

/** Execute the spawn_team_lead tool with the stubbed context. */
async function runSpawnLead(
  tool: any,
  params: Record<string, unknown>,
): Promise<{ text: string; details: any }> {
  const result = await tool.execute("call-1", params, undefined, undefined, fakeCtx);
  return { text: result.content[0].text, details: result.details };
}

describe("spawn_team_lead", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.mocked(generateAgentId).mockReturnValue("abcd1234");
    vi.mocked(waitForListener).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  /** A fresh existing directory to spawn the lead into. */
  function makeFolder(): string {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-lead-"));
    tempDirs.push(folder);
    return folder;
  }

  it("registers only for leads, while list_agents stays registered for everyone", () => {
    expect(loadAgentTools({ isLead: true, terminal: fakeTerminal() }).get("spawn_team_lead")).toBeDefined();

    const workerTools = loadAgentTools({ isLead: false, terminal: fakeTerminal() });
    expect(workerTools.get("spawn_team_lead")).toBeUndefined();
    expect(workerTools.get("list_agents")).toBeDefined();

    // Omitted isLead defaults to false: workers never see the tool.
    const omittedTools = new Map<string, any>();
    registerAgentTools(
      {
        registerTool: (tool: { name: string }) => omittedTools.set(tool.name, tool),
      } as any,
      { getSelfRecord: () => leadA, terminal: fakeTerminal() },
    );
    expect(omittedTools.get("spawn_team_lead")).toBeUndefined();
    expect(omittedTools.get("list_agents")).toBeDefined();
  });

  it("spawns a peer lead in a pane with the resolved folder, env, and command", async () => {
    const folder = makeFolder();
    const terminal = fakeTerminal();
    const tool = loadAgentTools({ terminal }).get("spawn_team_lead");

    const { text, details } = await runSpawnLead(tool, { folder, model: "provider/model" });

    expect(terminal.spawnCalls).toHaveLength(1);
    const call = terminal.spawnCalls[0];
    expect(call.name).toBe("pi-lead-abcd1234");
    expect(call.cwd).toBe(folder);
    expect(call.command).toContain("--model 'provider/model'");
    expect(call.env.PI_AGENT_ID).toBe("abcd1234");
    expect(call.env.PI_AGENT_TYPE).toBe("lead");

    expect(vi.mocked(waitForListener)).toHaveBeenCalledWith("abcd1234", 30_000);
    expect(text).toBe(`Pi Agent in ${folder}: abcd1234: Online`);
    expect(details).toEqual({
      id: "abcd1234",
      cwd: folder,
      terminalId: "pane-1",
      isWindow: false,
      listening: true,
    });
  });

  it("strips the spawner's identity from the lead environment", async () => {
    vi.stubEnv("PI_TEAM_NAME", "some-team");
    vi.stubEnv("PI_AGENT_NAME", "spawner-name");
    vi.stubEnv("PI_LEAD_ID", "lead9999");
    vi.stubEnv("PI_AGENT_ID", "lead9999");

    const terminal = fakeTerminal();
    const tool = loadAgentTools({ terminal }).get("spawn_team_lead");
    await runSpawnLead(tool, { folder: makeFolder() });

    const env = terminal.spawnCalls[0].env;
    expect(env.PI_TEAM_NAME).toBeUndefined();
    expect(env.PI_AGENT_NAME).toBeUndefined();
    expect(env.PI_LEAD_ID).toBeUndefined();
    expect(env.PI_AGENT_ID).toBe("abcd1234");
  });

  it("falls back to the spawner's model when model is omitted", async () => {
    const terminal = fakeTerminal();
    const tool = loadAgentTools({ terminal }).get("spawn_team_lead");
    await runSpawnLead(tool, { folder: makeFolder() });

    expect(terminal.spawnCalls[0].command).toContain("--model 'provider/model'");
  });

  it("reports started but not listening yet when the socket never appears", async () => {
    vi.mocked(waitForListener).mockResolvedValue(false);
    const folder = makeFolder();
    const tool = loadAgentTools({ terminal: fakeTerminal() }).get("spawn_team_lead");

    const { text, details } = await runSpawnLead(tool, { folder });

    expect(text).toBe(`Pi Agent in ${folder}: abcd1234: started but not listening yet`);
    expect(details.listening).toBe(false);
  });

  it("opens a separate window when requested and supported", async () => {
    const folder = makeFolder();
    const terminal = fakeTerminal({ supportsWindows: () => true });
    const tool = loadAgentTools({ terminal }).get("spawn_team_lead");

    const { text, details } = await runSpawnLead(tool, { folder, separate_window: true });

    expect(terminal.spawnCalls).toHaveLength(0);
    expect(terminal.windowCalls).toHaveLength(1);
    expect(terminal.windowCalls[0].cwd).toBe(folder);
    expect(terminal.windowCalls[0].name).toBe("pi-lead-abcd1234");
    expect(text).toBe(`Pi Agent in ${folder}: abcd1234: Online`);
    expect(details).toEqual({
      id: "abcd1234",
      cwd: folder,
      terminalId: "win-1",
      isWindow: true,
      listening: true,
    });
  });

  it("throws when separate_window is requested without window support", async () => {
    const tool = loadAgentTools({ terminal: fakeTerminal() }).get("spawn_team_lead");
    await expect(runSpawnLead(tool, { folder: makeFolder(), separate_window: true })).rejects.toThrow(
      "Separate windows mode is not supported in fake.",
    );
  });

  it("throws when no terminal adapter is detected", async () => {
    const tool = loadAgentTools({ terminal: null }).get("spawn_team_lead");
    await expect(runSpawnLead(tool, { folder: makeFolder() })).rejects.toThrow(
      "No terminal adapter detected.",
    );
  });

  it("throws when the folder does not exist or is not a directory", async () => {
    const missing = path.join(makeFolder(), "missing-subdir");
    const tool = loadAgentTools({ terminal: fakeTerminal() }).get("spawn_team_lead");
    await expect(runSpawnLead(tool, { folder: missing })).rejects.toThrow(
      `Directory '${missing}' does not exist or is not a directory.`,
    );
  });

  it("throws when the model is not fully qualified", async () => {
    const tool = loadAgentTools({ terminal: fakeTerminal() }).get("spawn_team_lead");
    await expect(runSpawnLead(tool, { folder: makeFolder(), model: "model" })).rejects.toThrow(
      /not fully qualified/,
    );
  });

  it("throws when the model is not in the registry", async () => {
    const tool = loadAgentTools({ terminal: fakeTerminal() }).get("spawn_team_lead");
    await expect(
      runSpawnLead(tool, { folder: makeFolder(), model: "provider/other" }),
    ).rejects.toThrow(/not available in the current registry/);
  });

  it("wraps a terminal adapter failure", async () => {
    const terminal = fakeTerminal({
      spawn: () => {
        throw new Error("boom");
      },
    });
    const tool = loadAgentTools({ terminal }).get("spawn_team_lead");
    await expect(runSpawnLead(tool, { folder: makeFolder() })).rejects.toThrow(
      "Failed to spawn fake pane: Error: boom",
    );
  });
});
