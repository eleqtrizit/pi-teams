/**
 * Terminal Registry
 * 
 * Manages terminal adapters and provides automatic selection based on
 * the current environment.
 */

import { TerminalAdapter } from "../utils/terminal-adapter";
import { OrcaAdapter } from "./orca-adapter";
import { TmuxAdapter } from "./tmux-adapter";
import { Iterm2Adapter } from "./iterm2-adapter";
import { ZellijAdapter } from "./zellij-adapter";
import { WezTermAdapter } from "./wezterm-adapter";

/**
 * Available terminal adapters, ordered by priority
 *
 * Detection order (first match wins):
 * 1. Orca - if TERM_PROGRAM=Orca (takes priority over all others)
 * 2. tmux - if TMUX env is set
 * 3. Zellij - if ZELLIJ env is set and not in tmux
 * 4. iTerm2 - if TERM_PROGRAM=iTerm.app and not in tmux/zellij
 * 5. WezTerm - if WEZTERM_PANE env is set and not in tmux/zellij
 */
const adapters: TerminalAdapter[] = [
  new OrcaAdapter(),
  new TmuxAdapter(),
  new ZellijAdapter(),
  new Iterm2Adapter(),
  new WezTermAdapter(),
];

/**
 * Cached detected adapter
 */
let cachedAdapter: TerminalAdapter | null = null;

/**
 * Detect and return the appropriate terminal adapter for the current environment.
 *
 * Detection order (first match wins):
 * 1. Orca - if TERM_PROGRAM=Orca
 * 2. tmux - if TMUX env is set
 * 3. Zellij - if ZELLIJ env is set and not in tmux
 * 4. iTerm2 - if TERM_PROGRAM=iTerm.app and not in tmux/zellij
 * 5. WezTerm - if WEZTERM_PANE env is set and not in tmux/zellij
 *
 * @returns The detected terminal adapter, or null if none detected
 */
export function getTerminalAdapter(): TerminalAdapter | null {
  if (cachedAdapter) {
    return cachedAdapter;
  }

  for (const adapter of adapters) {
    if (adapter.detect()) {
      cachedAdapter = adapter;
      return adapter;
    }
  }

  return null;
}

/**
 * Check if the current terminal supports spawning separate OS windows.
 *
 * @returns true if the detected terminal supports windows (iTerm2, WezTerm)
 */
export function supportsWindows(): boolean {
  const adapter = getTerminalAdapter();
  return adapter?.supportsWindows() ?? false;
}
