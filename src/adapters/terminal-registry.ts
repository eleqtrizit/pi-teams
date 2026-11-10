/**
 * Terminal Registry
 * 
 * Manages terminal adapters and provides automatic selection based on
 * the current environment.
 */

import { TerminalAdapter } from "../utils/terminal-adapter";
import { HerdrCoreAdapter } from "./herdr-core-adapter";
import { HerdrAdapter } from "./herdr-adapter";
import { OrcaAdapter } from "./orca-adapter";
import { TmuxAdapter } from "./tmux-adapter";
import { Iterm2Adapter } from "./iterm2-adapter";
import { ZellijAdapter } from "./zellij-adapter";
import { WezTermAdapter } from "./wezterm-adapter";

/**
 * Available terminal adapters, ordered by priority
 *
 * Detection order (first match wins):
 * 1. herdr-core - if HC_TERMINAL_ID and HC_TERMINAL_SOCKET are set (herdr-app
 *    panes carry both HC_* and HERDR_* vars, so the core layer wins)
 * 2. herdr - if HERDR_ENV=1 and HERDR_PANE_ID are set (innermost multiplexer wins)
 * 3. Orca - if TERM_PROGRAM=Orca
 * 4. tmux - if TMUX env is set
 * 5. Zellij - if ZELLIJ env is set and not in tmux
 * 6. iTerm2 - if TERM_PROGRAM=iTerm.app and not in tmux/zellij
 * 7. WezTerm - if WEZTERM_PANE env is set and not in tmux/zellij
 */
const adapters: TerminalAdapter[] = [
  new HerdrCoreAdapter(),
  new HerdrAdapter(),
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
 * 1. herdr-core - if HC_TERMINAL_ID and HC_TERMINAL_SOCKET are set (herdr-app
 *    panes carry both HC_* and HERDR_* vars, so the core layer wins)
 * 2. herdr - if HERDR_ENV=1 and HERDR_PANE_ID is set (innermost multiplexer wins)
 * 3. Orca - if TERM_PROGRAM=Orca
 * 4. tmux - if TMUX env is set
 * 5. Zellij - if ZELLIJ env is set and not in tmux
 * 6. iTerm2 - if TERM_PROGRAM=iTerm.app and not in tmux/zellij
 * 7. WezTerm - if WEZTERM_PANE env is set and not in tmux/zellij
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
 * @returns true if the detected terminal supports windows (iTerm2, WezTerm, herdr tabs)
 */
export function supportsWindows(): boolean {
  const adapter = getTerminalAdapter();
  return adapter?.supportsWindows() ?? false;
}
