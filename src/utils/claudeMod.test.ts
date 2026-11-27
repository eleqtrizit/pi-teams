import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkClaudeMod,
  type CommandRunner,
  modUpdateMode,
  MOD_PLUGIN_ID,
  readModInstalls,
  RETRY_AFTER_MS,
} from "./claudeMod";

describe("claude mod check", () => {
  let originalRegistry: string | undefined;
  let registry: string;
  let config: string;

  const writeInstalls = (entries: unknown[]): void => {
    fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { [MOD_PLUGIN_ID]: entries, "other@x": [{ scope: "user", version: "0.0.1" }] } }),
    );
  };

  /** Runner that records calls and, on `plugin update`, bumps the install to `to`. */
  const fakeRunner = (calls: string[][], to?: string, fail?: string): CommandRunner =>
    async (cmd, args, cwd) => {
      calls.push([cmd, ...args, ...(cwd ? [`cwd=${cwd}`] : [])]);
      if (fail && args.includes(fail)) throw new Error("boom");
      if (to && args[1] === "update" && args[2] === MOD_PLUGIN_ID) {
        writeInstalls([{ scope: "user", version: to }]);
      }
    };

  beforeEach(() => {
    originalRegistry = process.env.PI_TEAMS_REGISTRY_DIR;
    registry = fs.mkdtempSync(path.join(os.tmpdir(), "m"));
    config = fs.mkdtempSync(path.join(os.tmpdir(), "c"));
    process.env.PI_TEAMS_REGISTRY_DIR = registry;
  });

  afterEach(() => {
    process.env.PI_TEAMS_REGISTRY_DIR = originalRegistry;
    fs.rmSync(registry, { recursive: true, force: true });
    fs.rmSync(config, { recursive: true, force: true });
  });

  it("reads the mod's installs and ignores other plugins", () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }, { scope: "project", version: "0.8.1", projectPath: "/p" }]);
    expect(readModInstalls(config)).toEqual([
      { scope: "user", version: "0.8.9" },
      { scope: "project", version: "0.8.1", projectPath: "/p" },
    ]);
  });

  it("does nothing when Claude Code or the mod is not installed", async () => {
    const calls: string[][] = [];
    expect(await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls), mode: "auto" })).toEqual({ action: "none" });
    expect(calls).toEqual([]);
  });

  it("does nothing when the mod is current or newer", async () => {
    writeInstalls([{ scope: "user", version: "0.9.1" }]);
    const calls: string[][] = [];
    expect((await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls), mode: "auto" })).action).toBe("none");
    expect(calls).toEqual([]);
  });

  it("refreshes the marketplace then updates each outdated scope", async () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }, { scope: "project", version: "0.8.1", projectPath: "/p" }]);
    const calls: string[][] = [];
    const result = await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls, "0.9.0"), mode: "auto" });
    expect(result).toMatchObject({ action: "updated", installed: "0.8.1", target: "0.9.0" });
    expect(calls).toEqual([
      ["claude", "plugin", "marketplace", "update", "pi-teams"],
      ["claude", "plugin", "update", MOD_PLUGIN_ID, "--scope", "user"],
      ["claude", "plugin", "update", MOD_PLUGIN_ID, "--scope", "project", "cwd=/p"],
    ]);
    expect(fs.existsSync(path.join(registry, "claude-mod-update.lock"))).toBe(false);
  });

  it("reports a failure with the manual commands and does not retry within a day", async () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }]);
    let clock = 1_000_000;
    const calls: string[][] = [];
    const opts = { configDir: config, run: fakeRunner(calls, undefined, "marketplace"), mode: "auto" as const, now: () => clock };
    const first = await checkClaudeMod("0.9.0", opts);
    expect(first.action).toBe("failed");
    expect(first.action !== "none" && first.message).toMatch(/claude plugin marketplace update pi-teams/);
    expect((await checkClaudeMod("0.9.0", opts)).action).toBe("none");
    expect(calls).toHaveLength(1);
    clock += RETRY_AFTER_MS + 1;
    expect((await checkClaudeMod("0.9.0", opts)).action).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("reports when the update left the mod behind", async () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }]);
    const result = await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner([]), mode: "auto" });
    expect(result).toMatchObject({ action: "failed", installed: "0.8.9" });
  });

  it("skips while another session holds a fresh lock", async () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }]);
    fs.writeFileSync(path.join(registry, "claude-mod-update.lock"), "1");
    const calls: string[][] = [];
    expect((await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls), mode: "auto" })).action).toBe("none");
    expect(calls).toEqual([]);
  });

  it("only reports in notify mode, and skips in off mode", async () => {
    writeInstalls([{ scope: "user", version: "0.8.9" }]);
    const calls: string[][] = [];
    expect((await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls), mode: "notify" })).action).toBe("outdated");
    expect((await checkClaudeMod("0.9.0", { configDir: config, run: fakeRunner(calls), mode: "off" })).action).toBe("none");
    expect(calls).toEqual([]);
  });

  it("parses the mode variable", () => {
    expect(modUpdateMode({})).toBe("auto");
    expect(modUpdateMode({ PI_TEAMS_CLAUDE_MOD_UPDATE: "notify" })).toBe("notify");
    expect(modUpdateMode({ PI_TEAMS_CLAUDE_MOD_UPDATE: "OFF" })).toBe("off");
    expect(modUpdateMode({ PI_TEAMS_CLAUDE_MOD_UPDATE: "0" })).toBe("off");
  });
});
