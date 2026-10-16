import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLeadCommand,
  buildLeadEnv,
  buildWorkerCommand,
  resolveLeadFolder,
  resolveSpawnDirectory,
  spawnWorkerProcess,
} from "./spawn";
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
  it("passes no extension flags, so the worker loads its own configured extensions", () => {
    const { piCmd } = buildWorkerCommand({ readonlyWorker: false }, "prov/model");
    expect(piCmd).not.toMatch(/\s(-ne|--no-extensions|-e|--extension)\s/);
    expect(piCmd).toMatch(/^node '.+' --model 'prov\/model'$/);
  });

  it("shell-quotes the model argument", () => {
    const { piCmd } = buildWorkerCommand(
      { readonlyWorker: false },
      "prov/model; rm -rf /");
    expect(piCmd).toContain("--model 'prov/model; rm -rf /'");
  });

  it("quotes the node binary path", () => {
    const { piCmd } = buildWorkerCommand(
      { readonlyWorker: false },
      "prov/model");
    // piBinary is `node <quoted argv[1]>` when argv[1] exists.
    expect(piCmd).toMatch(/^node '.+' /);
  });

  it("appends thinking level only for non-readonly workers", () => {
    const withThinking = buildWorkerCommand(
      { readonlyWorker: false, thinking: "high" },
      "prov/model");
    expect(withThinking.piCmd.endsWith("prov/model':high")).toBe(true);
    const readonlyWithThinking = buildWorkerCommand(
      { readonlyWorker: true, thinking: "high" },
      "prov/model");
    expect(readonlyWithThinking.piCmd).not.toContain(":high");
  });

  it("restricts tools and agent type for readonly workers", () => {
    const result = buildWorkerCommand({ readonlyWorker: true }, "prov/model");
    expect(result.agentType).toBe("readonly-worker");
    expect(result.piCmd).toContain("--tools read,grep,find,ls,send_message,close_myself");
  });

  it("uses teammate agent type for regular workers", () => {
    const result = buildWorkerCommand({ readonlyWorker: false }, "prov/model");
    expect(result.agentType).toBe("teammate");
    expect(result.piCmd).not.toContain("--tools");
  });
});

describe("buildLeadEnv", () => {
  it("strips the spawner's identity variables and sets the lead identity", () => {
    const env = buildLeadEnv(
      {
        PI_TEAM_NAME: "old-team",
        PI_AGENT_NAME: "old-name",
        PI_LEAD_ID: "old-lead",
        PI_AGENT_ID: "old-agent",
        PATH: "/usr/bin",
        HOME: "/home/test",
      },
      "abc12345",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      PI_AGENT_ID: "abc12345",
      PI_AGENT_TYPE: "lead",
    });
  });

  it("forces PI_AGENT_TYPE to lead over an inherited value", () => {
    const env = buildLeadEnv({ PI_AGENT_TYPE: "teammate" }, "abc12345");
    expect(env.PI_AGENT_TYPE).toBe("lead");
  });

  it("drops undefined values from the base environment", () => {
    const env = buildLeadEnv({ UNDEF_VAR: undefined, PATH: "/bin" }, "abc12345");
    expect(env).toEqual({ PATH: "/bin", PI_AGENT_ID: "abc12345", PI_AGENT_TYPE: "lead" });
  });

  it("rejects an invalid agent ID", () => {
    expect(() => buildLeadEnv({}, "not an id")).toThrow(/Invalid agent ID/);
  });
});

describe("buildLeadCommand", () => {
  it("returns the bare pi binary when no model is given", () => {
    expect(buildLeadCommand()).not.toContain("--model");
    expect(buildLeadCommand("")).not.toContain("--model");
  });

  it("appends a shell-quoted model when given", () => {
    expect(buildLeadCommand("prov/model")).toContain("--model 'prov/model'");
    expect(buildLeadCommand("prov/model; rm -rf /")).toContain(
      "--model 'prov/model; rm -rf /'",
    );
  });

  it("passes no extension or tools flags", () => {
    const cmd = buildLeadCommand("prov/model");
    expect(cmd).not.toMatch(/\s(-ne|--no-extensions|-e|--extension|--tools)\s/);
  });
});

describe("resolveLeadFolder", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-lead-"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("expands a leading tilde to the home directory", () => {
    expect(resolveLeadFolder("~")).toBe(path.resolve(os.homedir()));
    expect(resolveLeadFolder("~/")).toBe(path.resolve(os.homedir()));
  });

  it("rejects a missing directory under the expanded home path", () => {
    expect(() => resolveLeadFolder("~/no-such-dir-for-pi-teams-test")).toThrow(
      /does not exist or is not a directory/,
    );
  });

  it("accepts any existing directory, not only subdirectories", () => {
    expect(resolveLeadFolder(base)).toBe(base);
    expect(resolveLeadFolder("/tmp")).toBe("/tmp");
  });

  it("resolves a relative path against the current working directory", () => {
    const sub = fs.mkdtempSync(path.join(base, "sub-"));
    const rel = path.relative(process.cwd(), sub);
    expect(resolveLeadFolder(rel)).toBe(sub);
  });

  it("rejects a missing directory", () => {
    expect(() => resolveLeadFolder("nope")).toThrow(/does not exist/);
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
