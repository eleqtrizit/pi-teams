import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MockInstance } from "vitest";
import { createTeam, addMember, readConfig, removeAgent } from "./teams";
import * as paths from "./paths";
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
    vi.spyOn(paths, "inboxPath").mockImplementation((_t, agentName) =>
      path.join(testDir, "inboxes", `${agentName}.json`),
    );
    vi.spyOn(paths, "lastMessagePath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.lastMessage`),
    );
    vi.spyOn(paths, "lastReportPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.lastReport`),
    );
    vi.spyOn(paths, "lastAwokenPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.awoken`),
    );
    vi.spyOn(paths, "lastReminderPath").mockImplementation((_t, agentName) =>
      path.join(testDir, `${agentName}.lastReminder`),
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
      path.join(testDir, `${agentName}.lastMessage`),
      path.join(testDir, `${agentName}.lastReport`),
      path.join(testDir, `${agentName}.awoken`),
      path.join(testDir, `${agentName}.lastReminder`),
      path.join(testDir, `${agentName}.firstActivation`),
    ];
    fs.mkdirSync(path.join(testDir, "inboxes"), { recursive: true });
    for (const statePath of statePaths) {
      fs.writeFileSync(statePath, "x");
    }
    fs.writeFileSync(path.join(testDir, "inboxes", `${agentName}.json`), "[]");
    fs.writeFileSync(path.join(testDir, `${agentName}.pid`), pid);
    return [...statePaths, path.join(testDir, "inboxes", `${agentName}.json`)];
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
