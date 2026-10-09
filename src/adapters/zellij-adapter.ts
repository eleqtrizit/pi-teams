/**
 * Zellij Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for Zellij terminal multiplexer.
 * Note: Zellij uses --close-on-exit, so explicit kill is not needed.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class ZellijAdapter implements TerminalAdapter {
  readonly name = "zellij";

  detect(): boolean {
    // Zellij is available if ZELLIJ env is set and not in tmux
    return !!process.env.ZELLIJ && !process.env.TMUX;
  }

  spawn(options: SpawnOptions): string {
    const zellijArgs = [
      "run",
      "--name", options.name,
      "--cwd", options.cwd,
      "--close-on-exit",
      "--",
      "env",
      ...Object.entries(options.env)
        .filter(([k]) => k.startsWith("PI_"))
        .map(([k, v]) => `${k}=${v}`),
      "sh", "-c", options.command
    ];

    const result = execCommand("zellij", zellijArgs);
    
    if (result.status !== 0) {
      throw new Error(`zellij spawn failed with status ${result.status}: ${result.stderr}`);
    }

    // Zellij doesn't return a pane ID, so we create a synthetic one
    return `zellij_${options.name}`;
  }

  kill(_paneId: string): void {
    // Zellij uses --close-on-exit, so panes close automatically
    // when the process exits. No explicit kill needed.
  }

  isAlive(_paneId: string): boolean {
    // Zellij gives us no reliable pane handle (spawn returns a synthetic id),
    // so we cannot probe the pane. Liveness for zellij workers comes from the
    // pid file (isMemberAlive checks it first); reporting true here would make
    // a crashed worker appear alive forever and park the lead's run hold.
    return false;
  }

  setTitle(_title: string): void {
    // Zellij pane titles are set via --name at spawn time
    // No runtime title changing supported
  }

  /**
   * Zellij does not support spawning separate OS windows
   */
  supportsWindows(): boolean {
    return false;
  }

  /**
   * Not supported - throws error
   */
  spawnWindow(_options: SpawnOptions): string {
    throw new Error("Zellij does not support spawning separate OS windows. Use iTerm2 or WezTerm instead.");
  }

  /**
   * Not supported - no-op
   */
  setWindowTitle(_windowId: string, _title: string): void {
    // Not supported
  }

  /**
   * Not supported - no-op
   */
  killWindow(_windowId: string): void {
    // Not supported
  }

  /**
   * Not supported - always returns false
   */
  isWindowAlive(_windowId: string): boolean {
    return false;
  }
}
