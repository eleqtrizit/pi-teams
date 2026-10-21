/**
 * Herdr Terminal Adapter
 *
 * Implements the TerminalAdapter interface for the herdr terminal multiplexer.
 * Uses the `herdr` CLI, which prints JSON responses for every command.
 *
 * - Panes: the first worker splits the lead's pane to the right; later workers
 *   split the previous worker's pane downward (main-vertical layout).
 * - Windows: herdr has no OS windows, so a separate window maps to a herdr tab
 *   in the lead's workspace.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

/** Prefix for pane ids returned by spawn(). */
const PANE_PREFIX = "herdr_";
/** Prefix for tab ids returned by spawnWindow(). */
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
 * Build `--env KEY=VALUE` arguments for the PI_ variables in an environment.
 *
 * @param env - Full environment for the spawned process
 * @returns Flattened `--env` arguments
 */
function piEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k]) => k.startsWith("PI_"))
    .flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

/**
 * Start a command in a herdr pane's shell. `exec` replaces the shell, so the
 * pane closes when pi exits.
 *
 * @param paneId - Herdr pane id (for example `w1:p2`)
 * @param command - Command line to run
 * @throws Error if herdr rejects the input
 */
function runInPane(paneId: string, command: string): void {
  const res = execCommand("herdr", ["pane", "run", paneId, `exec ${command}`]);
  if (res.status !== 0) {
    throw new Error(`herdr pane run failed with status ${res.status}: ${res.stderr}`);
  }
}

/**
 * Check a herdr object by its `get` command; herdr exits 1 on `*_not_found`.
 *
 * @param kind - `pane` or `tab`
 * @param id - Herdr id
 * @returns true if the object exists
 */
function herdrExists(kind: "pane" | "tab", id: string): boolean {
  return execCommand("herdr", [kind, "get", id]).status === 0;
}

export class HerdrAdapter implements TerminalAdapter {
  readonly name = "herdr";
  /** Last pane this adapter spawned, used to stack later workers below it. */
  private lastPaneId: string | null = null;

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
   * Split a pane and start the command in it.
   *
   * @param options - Spawn configuration
   * @returns Pane id in the format `herdr_<pane_id>`
   * @throws Error if the split or the command start fails
   */
  spawn(options: SpawnOptions): string {
    const stackBelow = this.lastPaneId !== null && herdrExists("pane", this.lastPaneId);
    const target = stackBelow ? this.lastPaneId! : process.env.HERDR_PANE_ID!;
    const result = herdrJson([
      "pane", "split", target,
      "--direction", stackBelow ? "down" : "right",
      "--cwd", options.cwd,
      ...piEnvArgs(options.env),
      "--no-focus",
    ]);
    const paneId: string | undefined = result.pane?.pane_id;
    if (!paneId) {
      throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(result)}`);
    }
    runInPane(paneId, options.command);
    this.lastPaneId = paneId;
    return `${PANE_PREFIX}${paneId}`;
  }

  /**
   * Close a herdr pane. Idempotent.
   *
   * @param paneId - Id returned from spawn()
   */
  kill(paneId: string): void {
    if (!paneId?.startsWith(PANE_PREFIX) || paneId.startsWith(TAB_PREFIX)) return;
    execCommand("herdr", ["pane", "close", paneId.slice(PANE_PREFIX.length)]);
  }

  /**
   * @param paneId - Id returned from spawn()
   * @returns true if the herdr pane still exists
   */
  isAlive(paneId: string): boolean {
    if (!paneId?.startsWith(PANE_PREFIX) || paneId.startsWith(TAB_PREFIX)) return false;
    return herdrExists("pane", paneId.slice(PANE_PREFIX.length));
  }

  /**
   * Label the current herdr pane.
   *
   * @param title - The label to set
   */
  setTitle(title: string): void {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) return;
    execCommand("herdr", ["pane", "rename", paneId, title]);
  }

  /** Separate windows map to herdr tabs. */
  supportsWindows(): boolean {
    return true;
  }

  /**
   * Create a herdr tab in the current workspace and start the command in its
   * root pane.
   *
   * @param options - Spawn configuration
   * @returns Tab id in the format `herdr_tab_<tab_id>`
   * @throws Error if tab creation or the command start fails
   */
  spawnWindow(options: SpawnOptions): string {
    const workspace = process.env.HERDR_WORKSPACE_ID;
    const title = options.teamName ? `${options.teamName}: ${options.name}` : options.name;
    const result = herdrJson([
      "tab", "create",
      ...(workspace ? ["--workspace", workspace] : []),
      "--cwd", options.cwd,
      "--label", title,
      ...piEnvArgs(options.env),
      "--no-focus",
    ]);
    const tabId: string | undefined = result.tab?.tab_id;
    const paneId: string | undefined = result.root_pane?.pane_id;
    if (!tabId || !paneId) {
      throw new Error(`herdr tab create returned unexpected response: ${JSON.stringify(result)}`);
    }
    runInPane(paneId, options.command);
    return `${TAB_PREFIX}${tabId}`;
  }

  /**
   * Rename a herdr tab.
   *
   * @param windowId - Id returned from spawnWindow()
   * @param title - The label to set
   */
  setWindowTitle(windowId: string, title: string): void {
    if (!windowId?.startsWith(TAB_PREFIX)) return;
    execCommand("herdr", ["tab", "rename", windowId.slice(TAB_PREFIX.length), title]);
  }

  /**
   * Close a herdr tab. Idempotent.
   *
   * @param windowId - Id returned from spawnWindow()
   */
  killWindow(windowId: string): void {
    if (!windowId?.startsWith(TAB_PREFIX)) return;
    execCommand("herdr", ["tab", "close", windowId.slice(TAB_PREFIX.length)]);
  }

  /**
   * @param windowId - Id returned from spawnWindow()
   * @returns true if the herdr tab still exists
   */
  isWindowAlive(windowId: string): boolean {
    if (!windowId?.startsWith(TAB_PREFIX)) return false;
    return herdrExists("tab", windowId.slice(TAB_PREFIX.length));
  }
}
