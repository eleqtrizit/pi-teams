import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWorkerCommand, extensionLoadFlags, resolveSpawnDirectory, spawnWorkerProcess } from "./spawn";

const FLAGS = extensionLoadFlags("/x/extensions/index.ts");
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import type { TerminalAdapter } from "./terminal-adapter";

/** Minimal terminal adapter that records spawn calls. */
function fakeAdapter(overrides: Partial<TerminalAdapter> = {}): TerminalAdapter {
  return {
    name: "fake",
    detect: vi.fn(),
    spawn: vi.fn(() => "pane-1"),
    kill: vi.fn(),
    isAlive: vi.fn(),
    setTitle: vi.fn(),
    supportsWindows: vi.fn(() => false),
    spawnWindow: vi.fn(() => "win-1"),
    setWindowTitle: vi.fn(),
    killWindow: vi.fn(),
    isWindowAlive: vi.fn(),
    ...overrides,
  };
}

describe("extensionLoadFlags", () => {
  it("shell-quotes the entry path", () => {
    expect(extensionLoadFlags("/a b/it's/index.ts")).toBe("-ne -e '/a b/it'\\''s/index.ts'");
  });
});

describe("resolveSpawnDirectory", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-spawn-"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("defaults to the base directory", () => {
    expect(resolveSpawnDirectory(undefined, base)).toBe(base);
  });

  it("accepts a subdirectory", () => {
    fs.mkdirSync(path.join(base, "sub", "dir"), { recursive: true });
    expect(resolveSpawnDirectory("sub/dir", base)).toBe(path.join(base, "sub", "dir"));
  });

  it("rejects a path outside the base directory", () => {
    expect(() => resolveSpawnDirectory("../outside", base)).toThrow(
      /not within the current directory/,
    );
    expect(() => resolveSpawnDirectory("/etc", base)).toThrow(
      /not within the current directory/,
    );
  });

  it("rejects a missing directory", () => {
    expect(() => resolveSpawnDirectory("nope", base)).toThrow(/does not exist/);
  });
});

describe("buildWorkerCommand", () => {
  it("shell-quotes the model argument", () => {
    const { piCmd } = buildWorkerCommand(
      { readonlyWorker: false },
      "prov/model; rm -rf /", FLAGS);
    expect(piCmd).toContain("--model 'prov/model; rm -rf /'");
  });

  it("quotes the node binary path", () => {
    const { piCmd } = buildWorkerCommand(
      { readonlyWorker: false },
      "prov/model", FLAGS);
    // piBinary is `node <quoted argv[1]>` when argv[1] exists.
    expect(piCmd).toMatch(/^node '.+' /);
  });

  it("appends thinking level only for non-readonly workers", () => {
    const withThinking = buildWorkerCommand(
      { readonlyWorker: false, thinking: "high" },
      "prov/model", FLAGS);
    expect(withThinking.piCmd.endsWith("prov/model':high")).toBe(true);
    const readonlyWithThinking = buildWorkerCommand(
      { readonlyWorker: true, thinking: "high" },
      "prov/model", FLAGS);
    expect(readonlyWithThinking.piCmd).not.toContain(":high");
  });

  it("restricts tools and agent type for readonly workers", () => {
    const result = buildWorkerCommand({ readonlyWorker: true }, "prov/model", FLAGS);
    expect(result.agentType).toBe("readonly-worker");
    expect(result.piCmd).toContain("--tools read,grep,find,ls,send_message,close_myself");
  });

  it("uses teammate agent type for regular workers", () => {
    const result = buildWorkerCommand({ readonlyWorker: false }, "prov/model", FLAGS);
    expect(result.agentType).toBe("teammate");
    expect(result.piCmd).not.toContain("--tools");
  });
});

describe("spawnWorkerProcess", () => {
  const base = {
    teamName: "team",
    name: "worker",
    cwd: "/tmp",
    piCmd: "pi",
    env: { PI_TEAM_NAME: "team" },
    members: [],
    useSeparateWindow: false,
    readonlyWorker: false,
  };

  it("spawns into a window when requested", () => {
    const terminal = fakeAdapter();
    const id = spawnWorkerProcess(terminal, { ...base, useSeparateWindow: true });
    expect(id).toBe("win-1");
    expect(terminal.spawnWindow).toHaveBeenCalled();
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("spawns into a pane otherwise", () => {
    const terminal = fakeAdapter();
    const id = spawnWorkerProcess(terminal, base);
    expect(id).toBe("pane-1");
    expect(terminal.spawn).toHaveBeenCalled();
  });

  it("sets the iTerm2 spawn context from the last teammate pane", () => {
    const adapter = new Iterm2Adapter();
    const setContext = vi.spyOn(adapter, "setSpawnContext");
    vi.spyOn(adapter, "spawn").mockReturnValue("iterm_new");
    spawnWorkerProcess(adapter, {
      ...base,
      members: [
        {
          name: "lead",
          agentId: "lead",
          agentType: "lead",
          joinedAt: 0,
          tmuxPaneId: "iterm_abc",
          cwd: "/tmp",
          subscriptions: [],
        },
        {
          name: "w1",
          agentId: "w1",
          agentType: "teammate",
          joinedAt: 0,
          tmuxPaneId: "iterm_def",
          cwd: "/tmp",
          subscriptions: [],
        },
      ],
    });
    expect(setContext).toHaveBeenCalledWith({ lastSessionId: "def" });
  });
});
