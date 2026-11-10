/**
 * Herdr-Core Terminal Adapter
 *
 * Implements the TerminalAdapter interface for herdr-core, the terminal
 * layer behind herdr-app and headless `hc` sessions. Uses the `hc` CLI.
 *
 * Every spawned agent runs in its own herdr-core terminal, labeled with
 * the `herdr.space` of the space that shows the lead's terminal, so the
 * herdr-app window gives it a tab alongside the lead. Terminals live in the
 * core, so they stay alive when the window closes; without the label (no
 * window open, or the lead has no pane in it) they run hidden instead.
 * Terminals are removed from the core when their program ends. herdr-core
 * has no OS windows of its own, so pane and window requests both start a
 * terminal.
 *
 * New terminals inherit the core's environment, not the caller's, and the
 * `hc run` CLI cannot pass env vars, so PI_* identity vars ride in the
 * command line: `hc run` turns a single argv string with spaces into an
 * `sh -c` line, where `VAR=value exec pi ...` sets them for the agent.
 */

import { TerminalAdapter, SpawnOptions, execCommand, shQuote } from "../utils/terminal-adapter";

/** Prefix for terminal addresses returned by spawn() and spawnWindow(). */
const TERMINAL_PREFIX = "hc_";

/** Maximum length of an `hc run --name`, per its CLI contract. */
const HC_NAME_MAX = 32;

/**
 * Run a `hc` CLI command and parse its JSON output.
 *
 * @param args - Arguments after `hc`
 * @returns The parsed stdout JSON
 * @throws Error if the command fails or prints no JSON
 */
function hcJson(args: string[]): Record<string, any> {
  const res = execCommand("hc", args);
  if (res.status !== 0) {
    throw new Error(`hc ${args.slice(0, 2).join(" ")} failed with status ${res.status}: ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`hc ${args.slice(0, 2).join(" ")} returned unexpected response: ${res.stdout}`);
  }
  return parsed as Record<string, any>;
}

/**
 * Run a `herdr-app` CLI command.
 *
 * @param args - Arguments after `herdr-app`
 * @returns The command result, or null when the app is missing or no window is open
 */
function runApp(args: string[]): { stdout: string; status: number | null } | null {
  const res = execCommand("herdr-app", args);
  return res.status === 0 ? res : null;
}

/**
 * Find the space and tab showing a terminal in the herdr-app window.
 *
 * @param terminalAddress - The hc terminal address to look for
 * @returns The space and tab ids, or null when the window is closed, the
 *   output is unexpected, or the terminal has no pane in the window
 */
function locateTerminal(terminalAddress: string): { spaceId: string | null; tabId: string | null } | null {
  const ls = runApp(["ls"]);
  if (!ls || !terminalAddress) return null;
  let lsJson: Record<string, any>;
  try {
    lsJson = JSON.parse(ls.stdout);
  } catch {
    return null;
  }
  for (const space of lsJson?.spaces ?? []) {
    for (const tab of space.tabs ?? []) {
      for (const terminal of tab.terminals ?? []) {
        if (terminal.terminal === terminalAddress) {
          return {
            spaceId: typeof space.id === "string" && space.id ? space.id : null,
            tabId: typeof tab.id === "string" && tab.id ? tab.id : null,
          };
        }
      }
    }
  }
  return null;
}

/**
 * Extract the hc terminal address from an id returned by this adapter.
 *
 * @param id - Id returned from spawn() or spawnWindow()
 * @returns The hc terminal address, or null for ids owned by another adapter
 */
function addressOf(id: string): string | null {
  return id?.startsWith(TERMINAL_PREFIX) ? id.slice(TERMINAL_PREFIX.length) : null;
}

/**
 * Sanitize a worker name for `hc run --name`: 1-32 chars of a-z 0-9 - _.
 *
 * @param name - The raw worker name
 * @returns A name accepted by hc, never empty
 */
function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "worker";
}

/**
 * Build a unique `hc run --name` from a worker name and its agent id.
 *
 * @param name - The raw worker name
 * @param agentId - The worker's agent id, or "" when unknown
 * @returns A name of at most HC_NAME_MAX chars, ending in the agent id when given
 */
function terminalName(name: string, agentId: string): string {
  const base = sanitizeName(name);
  if (!agentId) return base.slice(0, HC_NAME_MAX);
  const room = Math.max(1, HC_NAME_MAX - agentId.length - 1);
  return `${base.slice(0, room).replace(/-+$/, "")}-${agentId}`.slice(0, HC_NAME_MAX);
}

/**
 * Rename a tab in the herdr-app window. Best-effort: a closed window or a
 * terminal without a pane makes this a silent no-op.
 *
 * @param tabId - The tab id from `herdr-app ls`
 * @param title - The label to set
 */
function renameTab(tabId: string, title: string): void {
  runApp(["do", "tab.rename", "--id", tabId, "--name", title]);
}

export class HerdrCoreAdapter implements TerminalAdapter {
  readonly name = "herdr-core";

  /** Tab id of this session's own terminal in the herdr-app window, when known. */
  private cachedOwnTabId: string | null = null;

  /**
   * Detect a herdr-core terminal. herdr-core sets HC_TERMINAL_ID and
   * HC_TERMINAL_SOCKET in every terminal it runs, including panes of the
   * herdr-app window.
   *
   * @returns true if running inside a herdr-core terminal
   */
  detect(): boolean {
    return !!process.env.HC_TERMINAL_ID && !!process.env.HC_TERMINAL_SOCKET;
  }

  /**
   * Start a herdr-core terminal running the command. The terminal is a
   * child of this session's terminal (--no-notify keeps hc from typing
   * notes into it) and outlives it (--outlive-parent), like panes in the
   * other adapters. --rm removes it from the core once its program ends.
   * The `herdr.space` label is looked up on every spawn from the space that
   * shows this session's own terminal, never the window's active space, so
   * workers follow their lead. PI_ variables ride in the command line
   * because new terminals inherit the core's environment, not the caller's.
   * The worker labels its own tab through setTitle() once it starts.
   *
   * @param options - Spawn configuration
   * @returns Terminal address in the format `hc_<address>`
   * @throws Error if the launch fails
   */
  spawn(options: SpawnOptions): string {
    const spaceId = locateTerminal(process.env.HC_TERMINAL_ID ?? "")?.spaceId ?? null;
    const uniqueName = terminalName(options.name, options.env.PI_AGENT_ID ?? "");
    const assignments = Object.entries(options.env)
      .filter(([k, v]) => k.startsWith("PI_") && v)
      .map(([k, v]) => `${k}=${shQuote(v as string)}`)
      .join(" ");
    const line = [assignments, `exec ${options.command}`].filter(Boolean).join(" ");
    const run = hcJson([
      "run", "--bg", "--json",
      "--name", uniqueName,
      "--cwd", options.cwd,
      "--no-notify",
      "--outlive-parent",
      "--rm",
      ...(spaceId ? ["--label", `herdr.space=${spaceId}`] : []),
      line,
    ]);
    const address: string | undefined = run.address ?? run.terminal?.address;
    if (!address) {
      throw new Error(`hc run returned unexpected response: ${JSON.stringify(run)}`);
    }
    return `${TERMINAL_PREFIX}${address}`;
  }

  /**
   * End a terminal's program and remove the finished terminal from the
   * core. Idempotent: both commands fail quietly on a terminal that is
   * already gone (`--rm` usually removes it first).
   *
   * @param paneId - Id returned from spawn()
   */
  kill(paneId: string): void {
    const address = addressOf(paneId);
    if (!address) return;
    execCommand("hc", ["kill", address]);
    execCommand("hc", ["rm", address]);
  }

  /**
   * @param paneId - Id returned from spawn()
   * @returns true if the terminal exists and is still live
   */
  isAlive(paneId: string): boolean {
    const address = addressOf(paneId);
    if (!address) return false;
    try {
      return hcJson(["get", "--json", address]).state === "live";
    } catch {
      return false;
    }
  }

  /**
   * Label this session's own tab in the herdr-app window, like tmux's
   * pane titles. Best-effort: a closed window makes this a no-op.
   *
   * @param title - The label to set
   */
  setTitle(title: string): void {
    if (!this.cachedOwnTabId) {
      this.cachedOwnTabId = locateTerminal(process.env.HC_TERMINAL_ID ?? "")?.tabId ?? null;
    }
    if (this.cachedOwnTabId) renameTab(this.cachedOwnTabId, title);
  }

  /** Separate windows are herdr-core terminals, the same as panes. */
  supportsWindows(): boolean {
    return true;
  }

  spawnWindow(options: SpawnOptions): string {
    return this.spawn(options);
  }

  /**
   * Rename the tab showing a worker terminal. Best-effort: hidden
   * terminals and closed windows make this a no-op.
   *
   * @param windowId - Id returned from spawnWindow()
   * @param title - The label to set
   */
  setWindowTitle(windowId: string, title: string): void {
    const address = addressOf(windowId);
    const tabId = address ? locateTerminal(address)?.tabId : null;
    if (tabId) renameTab(tabId, title);
  }

  killWindow(windowId: string): void {
    this.kill(windowId);
  }

  isWindowAlive(windowId: string): boolean {
    return this.isAlive(windowId);
  }
}
