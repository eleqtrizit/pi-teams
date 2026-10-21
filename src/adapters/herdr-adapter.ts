/**
 * Herdr Terminal Adapter
 *
 * Implements the TerminalAdapter interface for the herdr terminal multiplexer.
 * Uses the `herdr` CLI, which prints JSON responses for every command.
 *
 * Every spawned agent gets a full herdr tab in the lead's workspace, labeled
 * with the agent name. Herdr has no OS windows, so pane and window requests
 * both open a tab; read-only workers, which never request a window, get the
 * same layout.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

/** Prefix for tab ids returned by spawn() and spawnWindow(). */
const TAB_PREFIX = "herdr_tab_";

/**
 * Run a herdr CLI command and parse its JSON `result`.
 *
 * @param args - Arguments after `herdr`
 * @returns The parsed `result` object
 * @throws Error if the command fails or prints no result
 */
function herdrJson(args: string[]): Record<string, any> {
  const res = execCommand("herdr", args);
  if (res.status !== 0) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed with status ${res.status}: ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout);
  if (!parsed.result) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} returned unexpected response: ${res.stdout}`);
  }
  return parsed.result;
}

/**
 * Extract the herdr tab id from an id returned by this adapter.
 *
 * @param id - Id returned from spawn() or spawnWindow()
 * @returns The herdr tab id, or null for ids owned by another adapter
 */
function tabIdOf(id: string): string | null {
  return id?.startsWith(TAB_PREFIX) ? id.slice(TAB_PREFIX.length) : null;
}

export class HerdrAdapter implements TerminalAdapter {
  readonly name = "herdr";

  /**
   * Detect a herdr-managed pane. Herdr sets HERDR_ENV=1 and HERDR_PANE_ID in
   * every pane process.
   *
   * @returns true if running inside a herdr pane
   */
  detect(): boolean {
    return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
  }

  /**
   * Open a herdr tab in the current workspace and start the command in its
   * root pane. PI_ variables pass through `--env`. `exec` replaces the shell,
   * so the tab closes when pi exits.
   *
   * @param options - Spawn configuration
   * @returns Tab id in the format `herdr_tab_<tab_id>`
   * @throws Error if tab creation or the command start fails
   */
  spawn(options: SpawnOptions): string {
    const workspace = process.env.HERDR_WORKSPACE_ID;
    const label = options.teamName ? `${options.teamName}: ${options.name}` : options.name;
    const envArgs = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const result = herdrJson([
      "tab", "create",
      ...(workspace ? ["--workspace", workspace] : []),
      "--cwd", options.cwd,
      "--label", label,
      ...envArgs,
      "--no-focus",
    ]);
    const tabId: string | undefined = result.tab?.tab_id;
    const paneId: string | undefined = result.root_pane?.pane_id;
    if (!tabId || !paneId) {
      throw new Error(`herdr tab create returned unexpected response: ${JSON.stringify(result)}`);
    }
    const run = execCommand("herdr", ["pane", "run", paneId, `exec ${options.command}`]);
    if (run.status !== 0) {
      throw new Error(`herdr pane run failed with status ${run.status}: ${run.stderr}`);
    }
    return `${TAB_PREFIX}${tabId}`;
  }

  /**
   * Close a herdr tab. Idempotent.
   *
   * @param paneId - Id returned from spawn()
   */
  kill(paneId: string): void {
    const tabId = tabIdOf(paneId);
    if (tabId) execCommand("herdr", ["tab", "close", tabId]);
  }

  /**
   * @param paneId - Id returned from spawn()
   * @returns true if the herdr tab still exists (herdr exits 1 on tab_not_found)
   */
  isAlive(paneId: string): boolean {
    const tabId = tabIdOf(paneId);
    return tabId !== null && execCommand("herdr", ["tab", "get", tabId]).status === 0;
  }

  /**
   * Label the current herdr pane.
   *
   * @param title - The label to set
   */
  setTitle(title: string): void {
    const paneId = process.env.HERDR_PANE_ID;
    if (paneId) execCommand("herdr", ["pane", "rename", paneId, title]);
  }

  /** Separate windows are herdr tabs, the same as panes. */
  supportsWindows(): boolean {
    return true;
  }

  spawnWindow(options: SpawnOptions): string {
    return this.spawn(options);
  }

  /**
   * Rename a herdr tab.
   *
   * @param windowId - Id returned from spawnWindow()
   * @param title - The label to set
   */
  setWindowTitle(windowId: string, title: string): void {
    const tabId = tabIdOf(windowId);
    if (tabId) execCommand("herdr", ["tab", "rename", tabId, title]);
  }

  killWindow(windowId: string): void {
    this.kill(windowId);
  }

  isWindowAlive(windowId: string): boolean {
    return this.isAlive(windowId);
  }
}
