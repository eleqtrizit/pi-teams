import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MockInstance } from "vitest";
import { createTeam, addMember, readConfig, removeAgent } from "./teams";
import * as paths from "./paths";
import * as terminalAdapter from "./terminal-adapter";
import type { TerminalAdapter } from "./terminal-adapter";
import type { Member } from "./models";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-teams-test-" + Date.now());

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
  beforeEach(() => {
    // pid-verification probes ps; report a pi worker so the kill proceeds.
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "node /path/to/pi --model 'prov/x'",
      stderr: "",
      status: 0,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  let killProcessSpy: MockInstance;

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation(
      () => path.join(testDir, "config.json"),
    );
    vi.spyOn(paths, "taskDir").mockImplementation(
      () => path.join(testDir, "tasks"),
    );
    vi.spyOn(paths, "socketPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.sock`),
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
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  /** Create every per-agent state file so tests prove the cleanup deletes them. */
  function writeStateFiles(agentName: string, pid: string): string[] {
    const statePaths = [
      path.join(testDir, `${agentName}.pid`),
      path.join(testDir, `${agentName}.active`),
      path.join(testDir, `${agentName}.firstActivation`),
      path.join(testDir, `${agentName}.sock`),
    ];
    for (const statePath of statePaths) {
      fs.writeFileSync(statePath, "x");
    }
    fs.writeFileSync(path.join(testDir, `${agentName}.pid`), pid);
    return statePaths;
  }

  it("removes the member, deletes every state file, closes its pane, and kills its process", async () => {
    createTeam("t1", "sess-1", "lead-agent");
    await addMember("t1", makeMember("worker-1", { tmuxPaneId: "pane-1" }));
    const statePaths = writeStateFiles("worker-1", "4242");

    const terminal = fakeTerminal();
    await removeAgent({ team: "t1", agentName: "worker-1", terminal });

    const config = await readConfig("t1");
    expect(config.members.map((m) => m.name)).toEqual(["team-lead"]);
    for (const statePath of statePaths) {
      expect(fs.existsSync(statePath), `${statePath} must be deleted`).toBe(
        false,
      );
    }
    expect(terminal.kill).toHaveBeenCalledWith("pane-1");
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("never removes the team-lead", async () => {
    createTeam("t2", "sess-1", "lead-agent");

    const terminal = fakeTerminal();
    await removeAgent({
      team: "t2",
      agentName: "team-lead",
      ownPid: 1,
      terminal,
    });

    const config = await readConfig("t2");
    expect(config.members.map((m) => m.name)).toEqual(["team-lead"]);
    expect(killProcessSpy).not.toHaveBeenCalled();
  });

  it("prefers an explicit ownPid over the pid file", async () => {
    createTeam("t3", "sess-1", "lead-agent");
    await addMember("t3", makeMember("worker-1", { tmuxPaneId: "pane-3" }));
    writeStateFiles("worker-1", "999");

    await removeAgent({
      team: "t3",
      agentName: "worker-1",
      ownPid: 123,
      terminal: fakeTerminal(),
    });

    expect(killProcessSpy).toHaveBeenCalledWith(123, "SIGKILL");
  });

  it("falls back to the pid file when no terminal ids are known", async () => {
    createTeam("t4", "sess-1", "lead-agent");
    await addMember("t4", makeMember("worker-1"));
    writeStateFiles("worker-1", "4242");

    const terminal = fakeTerminal();
    await removeAgent({ team: "t4", agentName: "worker-1", terminal });

    expect(terminal.kill).not.toHaveBeenCalled();
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("is tolerant to a missing team config and still terminates the pid", async () => {
    const terminal = fakeTerminal();
    fs.writeFileSync(path.join(testDir, "worker-9.pid"), "777");

    await expect(
      removeAgent({ team: "t5", agentName: "worker-9", terminal }),
    ).resolves.toBeUndefined();

    expect(killProcessSpy).toHaveBeenCalledWith(777, "SIGKILL");
  });

  it("still kills the pid when no terminal adapter is available", async () => {
    createTeam("t6", "sess-1", "lead-agent");
    await addMember("t6", makeMember("worker-1"));
    writeStateFiles("worker-1", "888");

    await expect(
      removeAgent({ team: "t6", agentName: "worker-1", terminal: null }),
    ).resolves.toBeUndefined();

    expect(killProcessSpy).toHaveBeenCalledWith(888, "SIGKILL");
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
});

describe("removeAgent pid verification", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation(() => path.join(testDir, "config.json"));
    vi.spyOn(paths, "socketPath").mockImplementation((_t, a) => path.join(testDir, `${a}.sock`));
    vi.spyOn(paths, "firstActivationPath").mockImplementation((_t, a) => path.join(testDir, `${a}.firstActivation`));
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not kill a pid whose command line is not pi", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    createTeam("t1", "sess-1", "lead-agent");
    fs.writeFileSync(path.join(testDir, "worker-1.pid"), "4242");
    await removeAgent({ team: "t1", agentName: "worker-1" });
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("always kills ownPid without verification", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    createTeam("t1", "sess-1", "lead-agent");
    await removeAgent({ team: "t1", agentName: "worker-1", ownPid: 4242 });
    expect(killSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });
});
