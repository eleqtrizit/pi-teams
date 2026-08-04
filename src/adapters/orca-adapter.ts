/**
 * Orca Terminal Adapter
 *
 * Implements the TerminalAdapter interface for the Orca app's built-in terminal.
 * Uses the `orca` CLI for terminal lifecycle management (create, close, list, rename).
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class OrcaAdapter implements TerminalAdapter {
  readonly name = "Orca";

  /**
   * Detect if we are running inside an Orca-managed terminal.
   *
   * Orca sets TERM_PROGRAM=Orca for all its terminals. We check this first
   * so Orca takes priority over tmux/Zellij/iTerm2 when embedded inside Orca.
   *
   * @returns true if running inside an Orca terminal
   */
  detect(): boolean {
    return process.env.TERM_PROGRAM === "Orca";
  }

  /**
   * Spawn a new terminal tab in the active Orca worktree.
   *
   * Uses `orca terminal create --worktree active --title <title> --command <cmd> --json`.
   * PI_ environment variables are passed as `env` prefixes in the command string,
   * matching the pattern used by tmux/WezTerm/Zellij adapters.
   *
   * @param options - Spawn configuration
   * @returns Terminal ID in the format `orca_<handle>`
   * @throws Error if spawn fails
   */
  spawn(options: SpawnOptions): string {
    const envArgs = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`);

    const fullCommand =
      envArgs.length > 0
        ? `env ${envArgs.join(" ")} ${options.command}`
        : options.command;

    const title = options.teamName
      ? `${options.teamName}: ${options.name}`
      : options.name;

    const args = [
      "terminal", "create",
      "--worktree", "active",
      "--title", title,
      "--command", fullCommand,
      "--json",
    ];

    const result = execCommand("orca", args);

    if (result.status !== 0) {
      throw new Error(
        `orca terminal create failed with status ${result.status}: ${result.stderr}`,
      );
    }

    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok || !parsed.result?.terminal?.handle) {
      throw new Error(
        `orca terminal create returned unexpected response: ${result.stdout}`,
      );
    }

    const handle = parsed.result.terminal.handle as string;
    return `orca_${handle}`;
  }

  /**
   * Kill/terminate an Orca terminal by handle.
   * Idempotent — no error if the terminal is already gone.
   *
   * @param paneId - Terminal ID in the format `orca_<handle>`
   */
  kill(paneId: string): void {
    if (!paneId?.startsWith("orca_")) return;

    const handle = paneId.replace("orca_", "");
    try {
      execCommand("orca", [
        "terminal", "close",
        "--terminal", handle,
        "--json",
      ]);
    } catch {
      // Terminal may already be closed — ignore
    }
  }

  /**
   * Check if an Orca terminal is still alive.
   *
   * Queries `orca terminal list --worktree active --json` and checks
   * whether the handle appears in the terminals list.
   *
   * @param paneId - Terminal ID in the format `orca_<handle>`
   * @returns true if the terminal exists and is active
   */
  isAlive(paneId: string): boolean {
    if (!paneId?.startsWith("orca_")) return false;

    const handle = paneId.replace("orca_", "");

    try {
      const result = execCommand("orca", [
        "terminal", "list",
        "--worktree", "active",
        "--json",
      ]);
      if (result.status !== 0) return false;

      const parsed = JSON.parse(result.stdout);
      if (!parsed.ok || !parsed.result?.terminals) return false;

      return parsed.result.terminals.some(
        (t: { handle: string }) => t.handle === handle,
      );
    } catch {
      return false;
    }
  }

  /**
   * Set the title of the current Orca terminal tab.
   *
   * If running inside an Orca terminal (ORCA_TERMINAL_HANDLE is set),
   * uses `orca terminal rename` to rename that specific terminal.
   * Otherwise, falls back to the UI escape sequence via stdout.
   *
   * @param title - The title to set
   */
  setTitle(title: string): void {
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if (!handle) return;

    try {
      execCommand("orca", [
        "terminal", "rename",
        "--terminal", handle,
        "--title", title,
        "--json",
      ]);
    } catch {
      // Ignore errors — title is cosmetic
    }
  }

  /**
   * Orca terminals are tabs within a worktree, not separate OS windows.
   *
   * @returns false
   */
  supportsWindows(): boolean {
    return false;
  }

  spawnWindow(_options: SpawnOptions): string {
    throw new Error(
      "Orca does not support spawning separate OS windows. Use spawn() for terminal tabs instead.",
    );
  }

  setWindowTitle(_windowId: string, _title: string): void {
    // Not supported — Orca manages tabs, not OS windows
  }

  killWindow(_windowId: string): void {
    // Not supported
  }

  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
