import { execCommand } from "./terminal-adapter";
import type { TerminalAdapter } from "./terminal-adapter";
import { readAgentRecord, removeAgentRecord, removeStaleSocket } from "./registry";
import { removeRunState } from "./runstate";

/** Options for removing an agent from the registry and terminating it. */
export interface RemoveAgentOptions {
  /** 8-character agent registry identifier. */
  agentId: string;
  /** Process id to terminate when the caller knows it, for example its own process. */
  ownPid?: number;
  /** Terminal pane id when the caller already holds it. */
  paneId?: string;
  /** Terminal window id when the caller already holds it. */
  windowId?: string;
  /** Terminal adapter used to close the agent's pane or window. */
  terminal?: TerminalAdapter | null;
}

const PI_WORKER_COMMAND_PATTERN = /\s--model\s/;

function pidLooksLikePiWorker(pid: number): boolean {
  try {
    const result = execCommand("ps", ["-p", String(pid), "-o", "command="]);
    return result.status === 0 && PI_WORKER_COMMAND_PATTERN.test(result.stdout);
  } catch (_e) {
    return false;
  }
}

export async function removeAgent(options: RemoveAgentOptions): Promise<void> {
  const { agentId } = options;
  const record = readAgentRecord(agentId);

  if (record) {
    removeAgentRecord(agentId);
    removeStaleSocket(agentId);
    removeRunState(agentId);
  }

  const terminal = options.terminal ?? null;
  if (terminal) {
    try {
      const windowId = options.windowId ?? record?.windowId ?? "";
      if (windowId) terminal.killWindow(windowId);
    } catch (_e) {
      // ignore
    }
    try {
      const paneId = options.paneId ?? record?.paneId ?? "";
      if (paneId) terminal.kill(paneId);
    } catch (_e) {
      // ignore
    }
  }

  const pid = options.ownPid ?? record?.pid ?? null;
  if (pid === null || (options.ownPid !== pid && !pidLooksLikePiWorker(pid))) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch (_e) {
    // The process may already be gone.
  }
}
