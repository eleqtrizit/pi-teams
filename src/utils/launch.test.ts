import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchLead, launchWorker } from "./launch";
import { AgentKind } from "./models";
import { writeAgentRecord } from "./registry";
import type { SpawnOptions, TerminalAdapter } from "./terminal-adapter";

/** A terminal that records spawns instead of opening panes. */
function fakeTerminal(windows = true): TerminalAdapter & { spawned: SpawnOptions[]; windowsSpawned: SpawnOptions[] } {
  const spawned: SpawnOptions[] = [];
  const windowsSpawned: SpawnOptions[] = [];
  return {
    name: "fake",
    spawned,
    windowsSpawned,
    detect: () => true,
    spawn: (o) => (spawned.push(o), "pane-1"),
    kill: () => {},
    isAlive: () => true,
    setTitle: () => {},
    supportsWindows: () => windows,
    spawnWindow: (o) => (windowsSpawned.push(o), "win-1"),
    setWindowTitle: () => {},
    killWindow: () => {},
    isWindowAlive: () => true,
  };
}

describe("launch", () => {
  let dir: string;
  let originalRegistry: string | undefined;

  beforeEach(() => {
    originalRegistry = process.env.PI_TEAMS_REGISTRY_DIR;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l"));
    process.env.PI_TEAMS_REGISTRY_DIR = dir;
  });

  afterEach(() => {
    process.env.PI_TEAMS_REGISTRY_DIR = originalRegistry;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = { leadId: "leadaaaa", leadCwd: os.tmpdir(), model: "p/m", listenTimeoutMs: 50 };

  describe("launchWorker", () => {
    it("requires a terminal", async () => {
      await expect(
        launchWorker({ ...base, terminal: null, goals: { name: "alice", readonlyWorker: false } }),
      ).rejects.toThrow(/No terminal adapter/);
    });

    it("rejects an invalid worker name", async () => {
      await expect(
        launchWorker({ ...base, terminal: fakeTerminal(), goals: { name: "a b", readonlyWorker: false } }),
      ).rejects.toThrow(/Invalid name/);
    });

    it("rejects a cwd outside the lead's directory", async () => {
      await expect(
        launchWorker({
          ...base,
          terminal: fakeTerminal(),
          goals: { name: "alice", cwd: "/", readonlyWorker: false },
        }),
      ).rejects.toThrow(/not within the current directory/);
    });

    it("rejects a duplicate worker name under the same lead", async () => {
      writeAgentRecord({
        id: "wrkeraa1",
        kind: AgentKind.Teammate,
        cwd: os.tmpdir(),
        pid: process.pid,
        startedAt: 1,
        leadId: "leadaaaa",
        name: "alice",
      });
      await expect(
        launchWorker({ ...base, terminal: fakeTerminal(), goals: { name: "alice", readonlyWorker: false } }),
      ).rejects.toThrow(/already exists under this lead/);
    });

    it("rejects separate windows where the terminal has none", async () => {
      await expect(
        launchWorker({
          ...base,
          terminal: fakeTerminal(false),
          goals: { name: "alice", separateWindow: true, readonlyWorker: false },
        }),
      ).rejects.toThrow(/not supported in fake/);
    });

    it("spawns a pane whose environment names the worker and its lead", async () => {
      const terminal = fakeTerminal();
      const result = await launchWorker({
        ...base,
        terminal,
        baseEnv: { KEEP: "yes", DROP: undefined },
        goals: { name: "alice", thinking: "high", readonlyWorker: false },
      });
      expect(terminal.spawned).toHaveLength(1);
      const [call] = terminal.spawned;
      expect(call.env).toMatchObject({
        KEEP: "yes",
        PI_AGENT_NAME: "alice",
        PI_AGENT_TYPE: "teammate",
        PI_LEAD_ID: "leadaaaa",
        PI_AGENT_ID: result.agentId,
      });
      expect(call.env).not.toHaveProperty("DROP");
      expect(call.command).toContain("--model 'p/m':high");
      expect(result).toMatchObject({ terminalId: "pane-1", isWindow: false, model: "p/m", listening: false });
    });

    it("gives a read-only worker the restricted tool list and ignores windows", async () => {
      const terminal = fakeTerminal();
      const result = await launchWorker({
        ...base,
        terminal,
        goals: { name: "scout", separateWindow: true, readonlyWorker: true },
      });
      expect(result.isWindow).toBe(false);
      expect(terminal.windowsSpawned).toHaveLength(0);
      expect(terminal.spawned[0].env.PI_AGENT_TYPE).toBe("readonly-worker");
      expect(terminal.spawned[0].command).toContain("--tools read,grep,find,ls,send_message,close_myself");
    });
  });

  describe("launchLead", () => {
    it("requires a terminal", async () => {
      await expect(launchLead({ terminal: null, folder: os.tmpdir() })).rejects.toThrow(/No terminal adapter/);
    });

    it("rejects a folder that does not exist", async () => {
      await expect(launchLead({ terminal: fakeTerminal(), folder: "/no/such/dir" })).rejects.toThrow(
        /does not exist/,
      );
    });

    it("spawns an independent lead without team identity", async () => {
      const terminal = fakeTerminal();
      const result = await launchLead({
        terminal,
        folder: os.tmpdir(),
        baseEnv: { PI_LEAD_ID: "someone", PI_AGENT_NAME: "x", KEEP: "yes" },
        listenTimeoutMs: 50,
      });
      const [call] = terminal.spawned;
      expect(call.env).toMatchObject({ KEEP: "yes", PI_AGENT_TYPE: "lead", PI_AGENT_ID: result.id });
      expect(call.env).not.toHaveProperty("PI_LEAD_ID");
      expect(call.env).not.toHaveProperty("PI_AGENT_NAME");
      expect(result.cwd).toBe(path.resolve(os.tmpdir()));
      expect(result.listening).toBe(false);
    });
  });
});
