import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MockInstance } from "vitest";
import { removeAgent } from "./teams";
import * as terminalAdapter from "./terminal-adapter";
import type { TerminalAdapter } from "./terminal-adapter";
import { AgentKind, AgentRecord } from "./models";
import { writeAgentRecord } from "./registry";
import { agentHistoryLockPath, agentRecordPath, agentSocketPath } from "./paths";
import { tryLock, unlock } from "fs-native-extensions";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r"));

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
  let originalRegistryDir: string | undefined;
  let killProcessSpy: MockInstance;

  beforeEach(() => {
    originalRegistryDir = process.env.PI_TEAMS_REGISTRY_DIR;
    process.env.PI_TEAMS_REGISTRY_DIR = tmpDir;
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "node /path/to/pi --model 'prov/x'",
      stderr: "",
      status: 0,
    });
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    killProcessSpy = vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalRegistryDir !== undefined) process.env.PI_TEAMS_REGISTRY_DIR = originalRegistryDir;
    else delete process.env.PI_TEAMS_REGISTRY_DIR;
  });

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

  it("removes registry data and closes the terminal and process", async () => {
    seedRegistryRecord({ id: "wk123456", name: "worker-1", paneId: "pane-1" });
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk123456", terminal });
    expect(fs.existsSync(agentRecordPath("wk123456"))).toBe(false);
    expect(fs.existsSync(agentSocketPath("wk123456"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("pane-1");
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("uses the registry pid without a terminal adapter", async () => {
    seedRegistryRecord({ id: "wk223456", pid: 888 });
    await expect(removeAgent({ agentId: "wk223456", terminal: null })).resolves.toBeUndefined();
    expect(killProcessSpy).toHaveBeenCalledWith(888, "SIGKILL");
  });

  it("prefers an explicit ownPid over the registry pid", async () => {
    seedRegistryRecord({ id: "wk323456", paneId: "pane-3", pid: 999 });
    await removeAgent({ agentId: "wk323456", ownPid: 123, terminal: fakeTerminal() });
    expect(killProcessSpy).toHaveBeenCalledWith(123, "SIGKILL");
  });

  it("uses explicit paneId and windowId when provided", async () => {
    seedRegistryRecord({ id: "wk423456", paneId: "old-pane", windowId: "old-win" });
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk423456", paneId: "new-pane", windowId: "new-win", terminal });
    expect(terminal.kill).toHaveBeenCalledWith("new-pane");
    expect(terminal.killWindow).toHaveBeenCalledWith("new-win");
  });

  it("uses terminal IDs from the registry when no explicit IDs are provided", async () => {
    seedRegistryRecord({ id: "wk523456", paneId: "reg-pane", windowId: "reg-win" });
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "wk523456", terminal });
    expect(terminal.kill).toHaveBeenCalledWith("reg-pane");
    expect(terminal.killWindow).toHaveBeenCalledWith("reg-win");
  });

  it("is tolerant of a missing registry record and terminates ownPid", async () => {
    const terminal = fakeTerminal();
    await removeAgent({ agentId: "missing1", ownPid: 777, terminal });
    expect(killProcessSpy).toHaveBeenCalledWith(777, "SIGKILL");
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it("removes registry records without a config file", async () => {
    seedRegistryRecord({ id: "wk623456", pid: 555 });
    await removeAgent({ agentId: "wk623456", terminal: fakeTerminal() });
    expect(killProcessSpy).toHaveBeenCalledWith(555, "SIGKILL");
    expect(fs.existsSync(agentRecordPath("wk623456"))).toBe(false);
  });

  it("does not kill a pid whose command line is not pi", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    seedRegistryRecord({ id: "wk723456", pid: 4242 });
    await removeAgent({ agentId: "wk723456" });
    expect(killProcessSpy).not.toHaveBeenCalled();
  });

  it("always kills ownPid without verification", async () => {
    vi.spyOn(terminalAdapter, "execCommand").mockReturnValue({
      stdout: "/usr/bin/somethingelse --watch",
      stderr: "",
      status: 0,
    });
    seedRegistryRecord({ id: "wk823456", pid: 4242 });
    await removeAgent({ agentId: "wk823456", ownPid: 4242 });
    expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("completes teardown when the history lock is held", async () => {
    seedRegistryRecord({ id: "wk923456", name: "worker-1", paneId: "pane-9", pid: 4242 });
    // Another process holds the history lock: a real exclusive advisory
    // lock on a held-open fd. No env stub: the zero-wait history delete is
    // asserted by the wall-time bound below, so a regression to the default
    // 2-second wait fails this test instead of being masked.
    const fd = fs.openSync(agentHistoryLockPath(), "a+", 0o600);
    if (!tryLock(fd)) throw new Error("history lock already held");

    try {
      const terminal = fakeTerminal();
      const startedAt = Date.now();
      await expect(removeAgent({ agentId: "wk923456", terminal })).resolves.toBeUndefined();
      // The history delete was a zero-wait try-lock that skipped; teardown
      // itself must stay fast instead of stalling on the held lock.
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      // The history delete was skipped, but teardown must still run: record
      // and socket gone, pane closed, process killed.
      expect(fs.existsSync(agentRecordPath("wk923456"))).toBe(false);
      expect(fs.existsSync(agentSocketPath("wk923456"))).toBe(false);
      expect(terminal.kill).toHaveBeenCalledWith("pane-9");
      expect(killProcessSpy).toHaveBeenCalledWith(4242, "SIGKILL");
    } finally {
      unlock(fd);
      fs.closeSync(fd);
    }
  });
});
