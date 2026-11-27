/**
 * Keeps the pi-teams Claude Code mod in step with the pi extension.
 *
 * At an interactive lead's `session_start` the extension reads Claude Code's
 * plugin registry (`<claude config>/plugins/installed_plugins.json`). When the
 * `pi-teams@pi-teams` mod is installed at a version older than this extension,
 * it refreshes the marketplace and updates the mod with the `claude` CLI, in
 * the background. Nothing happens when Claude Code or the mod is not installed.
 *
 * `PI_TEAMS_CLAUDE_MOD_UPDATE` sets the mode: `auto` (default) updates,
 * `notify` only reports the outdated mod, `off` skips the check.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryDir } from "./paths";
import { ensurePrivateDir } from "./transport";
import { compareVersions } from "./version";

/** Plugin id of the mod in Claude Code's registry. */
export const MOD_PLUGIN_ID = "pi-teams@pi-teams";
/** Marketplace name the mod is installed from. */
export const MOD_MARKETPLACE = "pi-teams";
/** A failed or ineffective attempt for the same target is not retried sooner than this. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** A lock older than this is from a crashed attempt and is taken over. */
export const LOCK_STALE_MS = 10 * 60 * 1000;
/** Per-command timeout for the `claude` CLI. */
const COMMAND_TIMEOUT_MS = 120_000;

export type ModUpdateMode = "auto" | "notify" | "off";

/** One install of the mod, as Claude Code records it. */
export interface ModInstall {
  scope: string;
  version: string;
  projectPath?: string;
}

/** Runs a command; rejects on a non-zero exit or a spawn error. */
export type CommandRunner = (cmd: string, args: string[], cwd?: string) => Promise<void>;

/** What {@link checkClaudeMod} did, for the caller to show. */
export type ModCheckResult =
  | { action: "none" }
  | { action: "outdated"; installed: string; target: string; message: string }
  | { action: "updated"; installed: string; target: string; message: string }
  | { action: "failed"; installed: string; target: string; message: string };

/** Manual commands that update the mod, as the README lists them. */
export const MANUAL_UPDATE_COMMANDS =
  `claude plugin marketplace update ${MOD_MARKETPLACE} && claude plugin update ${MOD_PLUGIN_ID}`;

/** The mode from `PI_TEAMS_CLAUDE_MOD_UPDATE`; anything unrecognised means `auto`. */
export function modUpdateMode(env: NodeJS.ProcessEnv = process.env): ModUpdateMode {
  const raw = env.PI_TEAMS_CLAUDE_MOD_UPDATE?.trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "notify") return "notify";
  return "auto";
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/**
 * Installs of the mod recorded by Claude Code.
 *
 * @returns One entry per scope, or [] when Claude Code, its registry, or the mod is absent
 */
export function readModInstalls(configDir: string = claudeConfigDir()): ModInstall[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = (data as { plugins?: Record<string, unknown> })?.plugins;
  const entries = plugins?.[MOD_PLUGIN_ID];
  if (!Array.isArray(entries)) return [];
  const installs: ModInstall[] = [];
  for (const entry of entries) {
    const e = entry as { scope?: unknown; version?: unknown; projectPath?: unknown };
    if (typeof e.scope !== "string" || typeof e.version !== "string") continue;
    installs.push({
      scope: e.scope,
      version: e.version,
      ...(typeof e.projectPath === "string" ? { projectPath: e.projectPath } : {}),
    });
  }
  return installs;
}

/** Installs older than `target`; an install with an unparseable version is left alone. */
export function outdatedInstalls(installs: ModInstall[], target: string): ModInstall[] {
  return installs.filter((install) => {
    try {
      return compareVersions(install.version, target) < 0;
    } catch {
      return false;
    }
  });
}

/** Default runner: `execFile` with a timeout and no shell. */
export const execRunner: CommandRunner = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ");
        reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
      } else {
        resolve();
      }
    });
  });

function attemptFile(): string {
  return path.join(registryDir(), "claude-mod-update.json");
}

function lockFile(): string {
  return path.join(registryDir(), "claude-mod-update.lock");
}

/** True when an attempt for `target` ran within {@link RETRY_AFTER_MS}. */
function attemptedRecently(target: string, now: number): boolean {
  try {
    const last = JSON.parse(fs.readFileSync(attemptFile(), "utf8")) as { target?: string; at?: number };
    return last.target === target && typeof last.at === "number" && now - last.at < RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

function recordAttempt(target: string, now: number): void {
  try {
    fs.writeFileSync(attemptFile(), `${JSON.stringify({ target, at: now })}\n`, { mode: 0o600 });
  } catch {
    // Without the record the next session retries; that is acceptable.
  }
}

/** Take the cross-process lock, or return false when another session holds it. */
function acquireLock(now: number): boolean {
  const file = lockFile();
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    try {
      if (now - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return false;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock(): void {
  fs.rmSync(lockFile(), { force: true });
}

/**
 * Check the installed mod against `target` and, in `auto` mode, update it.
 *
 * Only one session updates at a time, and an attempt for the same target is
 * not repeated within a day, whether it failed or left the mod behind (for
 * example when the published mod has not caught up with a local extension).
 *
 * @param target - The extension's version
 * @param options - Overrides for tests: mode, config dir, runner, clock
 */
export async function checkClaudeMod(
  target: string,
  options: {
    mode?: ModUpdateMode;
    configDir?: string;
    run?: CommandRunner;
    now?: () => number;
  } = {},
): Promise<ModCheckResult> {
  const mode = options.mode ?? modUpdateMode();
  if (mode === "off") return { action: "none" };
  const configDir = options.configDir ?? claudeConfigDir();
  const stale = outdatedInstalls(readModInstalls(configDir), target);
  if (stale.length === 0) return { action: "none" };
  const installed = stale.map((i) => i.version).sort(compareVersions)[0];

  if (mode === "notify") {
    return {
      action: "outdated",
      installed,
      target,
      message: `pi-teams: the Claude Code mod (${installed}) is older than the pi extension (${target}). Update it with: ${MANUAL_UPDATE_COMMANDS}`,
    };
  }

  const now = options.now ?? Date.now;
  ensurePrivateDir(registryDir());
  if (attemptedRecently(target, now()) || !acquireLock(now())) return { action: "none" };
  const run = options.run ?? execRunner;
  try {
    recordAttempt(target, now());
    await run("claude", ["plugin", "marketplace", "update", MOD_MARKETPLACE]);
    for (const install of stale) {
      await run("claude", ["plugin", "update", MOD_PLUGIN_ID, "--scope", install.scope], install.projectPath);
    }
  } catch (error) {
    return {
      action: "failed",
      installed,
      target,
      message: `pi-teams: could not update the Claude Code mod (${installed}) to ${target}: ${(error as Error).message}. Update it by hand: ${MANUAL_UPDATE_COMMANDS}`,
    };
  } finally {
    releaseLock();
  }

  const after = outdatedInstalls(readModInstalls(configDir), target);
  if (after.length > 0) {
    const still = after.map((i) => i.version).sort(compareVersions)[0];
    return {
      action: "failed",
      installed: still,
      target,
      message: `pi-teams: updated the Claude Code mod, but it is still at ${still}, behind the pi extension (${target}). The published mod may not have caught up yet.`,
    };
  }
  return {
    action: "updated",
    installed,
    target,
    message: `pi-teams: updated the Claude Code mod from ${installed} to ${target}. Restart running Claude Code sessions, or run /reload-plugins in them, to load it.`,
  };
}
