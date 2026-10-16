import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MockInstance } from "vitest";
import { createTeam, addMember, removeAgent } from "./teams";
import * as paths from "./paths";
import * as terminalAdapter from "./terminal-adapter";
import type { TerminalAdapter } from "./terminal-adapter";
import type { Member } from "./models";
import { AgentKind, AgentRecord } from "./models";
import { writeAgentRecord } from "./registry";
import { agentRecordPath, agentSocketPath } from "./paths";
import * as teams from "./teams";

const testTeamsRoot = path.join(os.tmpdir(), "ptt-" + Date.now());
const testDir = path.join(testTeamsRoot, "team");
const tmpDir = path.join("/tmp", "ptr-" + Date.now());

/** Build a teammate member record with sane defaults. */
function makeMember(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@test`,
    name,
    agentType: "teammate",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: "/tmp",
    subscriptions: [],
    ...overrides,
  };
}

/** Build a terminal adapter with spies for every pane-management method. */
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

describe("removeAgent", () => {
  let originalTmpdir: string | undefined;
  let killProcessSpy: MockInstance;

  beforeEach(() => {
    originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpDir;

    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "node /path/to/pi --model 'prov/x'",
      stderr: "",
      status: 0,
    });

    if (fs.existsSync(testTeamsRoot)) fs.rmSync(testTeamsRoot, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "teamsDir").mockReturnValue(testTeamsRoot);
    vi.spyOn(paths, "configPath").mockImplementation(
      () => path.join(testDir, "config.json"),
    );
    vi.spyOn(paths, "taskDir").mockImplementation(
      () => path.join(testDir, "tasks"),
    );
    vi.spyOn(paths, "pidPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.pid`),
    );
    vi.spyOn(paths, "activePath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.active`),
    );
    vi.spyOn(paths, "firstActivationPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.firstActivation`),
    );

    killProcessSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testTeamsRoot)) fs.rmSync(testTeamsRoot, { recursive: true });
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    if (originalTmpdir !== undefined) {
      process.env.TMPDIR = originalTmpdir;
    } else {
      delete process.env.TMPDIR;
    }
  });

  /** Create every per-agent state file so tests prove the cleanup deletes them. */
  function writeStateFiles(agentName: string, pid: string): string[] {
    const statePaths = [
      path.join(testDir, `${agentName}.pid`),
      path.join(testDir, `${agentName}.active`),
      path.join(testDir, `${agentName}.firstActivation`),
    ];
    for (const statePath of statePaths) {
      fs.writeFileSync(statePath, "x");
    }
    fs.writeFileSync(path.join(testDir, `${agentName}.pid`), pid);
    return statePaths;
  }

  /** Create a registry record and socket for an agent. */
  function seedRegistryRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
    const rec: AgentRecord = {
      kind: AgentKind.Teammate,
      cwd: "/tmp",
      pid: 4242,
      startedAt: 1000,
      ...overrides,
    };
    writeAgentRecord(rec);
    fs.writeFileSync(agentSocketPath(rec.id), "");
    return rec;
  }

  it("removes the registry record, deletes the socket, closes pane, and kills pid", async () => {
    seedRegistryRecord({ id: "wk123456", name: "worker-1", paneId: "pane-1" });
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk123456", terminal });

    expect(fs.existsSync(agentRecordPath("wk123456"))).toBe(false);
    expect(fs.existsSync(agentSocketPath("wk123456"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("pane-1");
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("still kills the pid when no terminal adapter is available", async () => {
    seedRegistryRecord({ id: "wk223456", name: "worker-1", pid: 888 });
    createTeam("t2", "sess-1", "lead-agent");
    await addMember("t2", makeMember("worker-1", { registryId: "wk223456" }));
    writeStateFiles("worker-1", "888");

    await expect(
      removeAgent({ agentId: "wk223456", terminal: null }),
    ).resolves.toBeUndefined();

    expect(killProcessSpy).toHaveBeenCalledWith(888, "SIGKILL");
  });

  it("prefers an explicit ownPid over the registry record pid", async () => {
    seedRegistryRecord({ id: "wk323456", name: "worker-1", paneId: "pane-3", pid: 999 });
    createTeam("t3", "sess-1", "lead-agent");
    await addMember("t3", makeMember("worker-1", { registryId: "wk323456" }));
    writeStateFiles("worker-1", "999");

    await removeAgent({
      agentId: "wk323456",
      ownPid: 123,
      terminal: fakeTerminal(),
    });

    expect(killProcessSpy).toHaveBeenCalledWith(123, "SIGKILL");
  });

  it("uses explicit paneId and windowId when provided", async () => {
    seedRegistryRecord({ id: "wk423456", name: "worker-1", paneId: "old-pane", windowId: "old-win" });

    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk423456", paneId: "new-pane", windowId: "new-win", terminal });

    expect(terminal.kill).toHaveBeenCalledWith("new-pane");
    expect(terminal.killWindow).toHaveBeenCalledWith("new-win");
  });

  it("falls back to registry paneId and windowId when no explicit ids are given", async () => {
    seedRegistryRecord({ id: "wk523456", name: "worker-1", paneId: "reg-pane", windowId: "reg-win" });

    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk523456", terminal });

    expect(terminal.kill).toHaveBeenCalledWith("reg-pane");
    expect(terminal.killWindow).toHaveBeenCalledWith("reg-win");
  });

  it("falls back to the team config member's pane when the record has no terminal ids", async () => {
    seedRegistryRecord({ id: "wk623456", name: "worker-1" });
    createTeam("t6", "sess-1", "lead-agent");
    await addMember("t6", makeMember("worker-1", { registryId: "wk623456", tmuxPaneId: "cfg-pane" }));

    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk623456", terminal });

    expect(terminal.kill).toHaveBeenCalledWith("cfg-pane");
  });

  it("is tolerant to a missing registry record and still terminates the ownPid", async () => {
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "missing1", ownPid: 777, terminal });

    expect(killProcessSpy).toHaveBeenCalledWith(777, "SIGKILL");
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it("is tolerant to a missing team config and still terminates the pid from registry", async () => {
    seedRegistryRecord({ id: "wk623456", name: "worker-1", pid: 555 });
    // No team config created.

    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk623456", terminal });

    expect(killProcessSpy).toHaveBeenCalledWith(555, "SIGKILL");
    expect(fs.existsSync(agentRecordPath("wk623456"))).toBe(false);
  });

  it("does not kill a pid whose command line is not pi", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    seedRegistryRecord({ id: "wk723456", name: "worker-1", pid: 4242 });
    createTeam("t1", "sess-1", "lead-agent");
    await addMember("t1", makeMember("worker-1", { registryId: "wk723456" }));

    await removeAgent({ agentId: "wk723456" });
    expect(killProcessSpy).not.toHaveBeenCalled();
  });

  it("always kills ownPid without verification", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    seedRegistryRecord({ id: "wk823456", name: "worker-1", pid: 4242 });
    createTeam("t1", "sess-1", "lead-agent");
    await addMember("t1", makeMember("worker-1", { registryId: "wk823456" }));

    await removeAgent({ agentId: "wk823456", ownPid: 4242 });
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

});

describe("createTeam overwrite guard", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "taskDir").mockReturnValue(path.join(testDir, "..", "tasks"));
    vi.spyOn(paths, "configPath").mockImplementation(() => path.join(testDir, "config.json"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("refuses to overwrite an existing team and preserves its directory", () => {
    createTeam("t1", "sess-1", "lead-agent");
    fs.writeFileSync(path.join(testDir, "keep.txt"), "state");
    expect(() => createTeam("t1", "sess-2", "lead-agent")).toThrow(/already exists/);
    expect(fs.existsSync(path.join(testDir, "keep.txt"))).toBe(true);
  });

  it("wipes a stale leftover directory with no config", () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "junk.json"), "{}");
    expect(() => createTeam("t1", "sess-1", "lead-agent")).not.toThrow();
    expect(fs.existsSync(path.join(testDir, "junk.json"))).toBe(false);
    expect(fs.existsSync(path.join(testDir, "config.json"))).toBe(true);
  });

  it("stores the lead registry ID on its member record", () => {
    const config = createTeam("t1", "sess-1", "lead-agent", "", undefined, false, "lead1234");
    expect(config.members[0].registryId).toBe("lead1234");
  });
});

describe("findConfigMemberByRegistryId", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-root-"));
    vi.spyOn(paths, "teamsDir").mockReturnValue(root);
    vi.spyOn(paths, "configPath").mockImplementation((team) => path.join(root, team, "config.json"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeTeamConfig(team: string, body: string): void {
    fs.mkdirSync(path.join(root, team), { recursive: true });
    fs.writeFileSync(path.join(root, team, "config.json"), body);
  }

  it("returns the team and member when a config contains the registry id", () => {
    writeTeamConfig(
      "alpha",
      JSON.stringify({
        name: "alpha",
        members: [
          { name: "team-lead", agentId: "lead", registryId: "lead1111" },
          { name: "w1", agentId: "w1", registryId: "wk111111" },
        ],
      }),
    );

    const found = teams.findConfigMemberByRegistryId("wk111111");
    expect(found?.team).toBe("alpha");
    expect(found?.member.name).toBe("w1");
  });

  it("returns null when no config contains the registry id", () => {
    writeTeamConfig("beta", JSON.stringify({ name: "beta", members: [{ name: "team-lead", agentId: "lead" }] }));
    expect(teams.findConfigMemberByRegistryId("missing1")).toBeNull();
  });

  it("returns null when the teams directory does not exist", () => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(teams.findConfigMemberByRegistryId("any")).toBeNull();
  });

  it("skips unreadable config files", () => {
    writeTeamConfig("gamma", "not json");
    expect(teams.findConfigMemberByRegistryId("any")).toBeNull();
  });
});

