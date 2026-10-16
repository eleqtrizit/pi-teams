import fs from "node:fs";
import { TeamConfig, Member } from "./models";
import * as paths from "./paths";
import { withLock } from "./lock";
import { execCommand } from "./terminal-adapter";
import type { TerminalAdapter } from "./terminal-adapter";

export function teamExists(teamName: string) {
  return fs.existsSync(paths.configPath(teamName));
}

export function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean,
  leadRegistryId?: string,
): TeamConfig {
  // Refuse to overwrite a live team: its workers would be orphaned (running
  // with a deleted config, inboxes, and pid files) and its task list erased.
  if (fs.existsSync(paths.configPath(name))) {
    throw new Error(`Team "${name}" already exists. Run team_shutdown first.`);
  }
  const dir = paths.teamDir(name);
  // Wipe stale leftovers from a previous run without a config (a crashed
  // createTeam), so no state files can leak into the new team.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const tasksDir = paths.taskDir(name);
  if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true, force: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
    ...(leadRegistryId ? { registryId: leadRegistryId } : {}),
    name: "team-lead",
    agentType: "lead",
    joinedAt: Date.now(),
    tmuxPaneId: process.env.TMUX_PANE || "",
    cwd: process.cwd(),
    subscriptions: [],
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: sessionId,
    members: [leadMember],
    defaultModel,
    separateWindows,
  };

  fs.writeFileSync(paths.configPath(name), JSON.stringify(config, null, 2));
  return config;
}

function readConfigRaw(p: string): TeamConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export async function readConfig(teamName: string): Promise<TeamConfig> {
  const p = paths.configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return await withLock(p, async () => {
    return readConfigRaw(p);
  });
}

export async function addMember(teamName: string, member: Member) {
  const p = paths.configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members.push(member);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
  });
}

export async function removeMember(teamName: string, agentName: string) {
  const p = paths.configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members = config.members.filter(m => m.name !== agentName);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
  });
}

export async function updateMember(teamName: string, agentName: string, updates: Partial<Member>) {
  const p = paths.configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const m = config.members.find(m => m.name === agentName);
    if (m) {
      Object.assign(m, updates);
      fs.writeFileSync(p, JSON.stringify(config, null, 2));
    }
  });
}

/**
 * Paths of every per-agent state file the extension maintains for one agent.
 *
 * The list covers liveness markers (pid, activity), first-activation stamps,
 * and the message socket. A removed agent must leave none of these behind:
 * stale activity markers make the lead's liveness checks report the agent as
 * alive, and a leftover socket file makes senders connect to a dead agent.
 *
 * @param team - Name of the team the agent belongs to
 * @param agentName - Name of the agent
 * @returns Paths of the agent's state files
 */
function agentStateFiles(team: string, agentName: string): string[] {
  return [
    paths.pidPath(team, agentName),
    paths.activePath(team, agentName),
    paths.firstActivationPath(team, agentName),
  ];
}

/**
 * Delete every per-agent state file, ignoring the ones an option keeps.
 *
 * Shared by agent removal, worker seeding, and first-activation cleanup so
 * the state-file list lives only in {@link agentStateFiles}.
 *
 * @param team - Name of the team the agent belongs to
 * @param agentName - Name of the agent
 * @param options - keepFirstActivation preserves the first-activation stamp
 */
export function resetAgentState(
  team: string,
  agentName: string,
  options: { keepFirstActivation?: boolean } = {},
): void {
  for (const stateFile of agentStateFiles(team, agentName)) {
    if (
      options.keepFirstActivation &&
      stateFile === paths.firstActivationPath(team, agentName)
    ) {
      continue;
    }
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch (_e) {
      // ignore
    }
  }
}

/**
 * Read the process id recorded in an agent's pid file.
 *
 * The extension writes the agent's process id to the file at session start.
 *
 * @param teamDirectory - Team directory holding the pid file
 * @param agentName - Name of the agent
 * @returns The recorded process id, or null when the file is missing or malformed
 */
function readPidFromPidFile(
  team: string,
  agentName: string,
): number | null {
  const pidFile = paths.pidPath(team, agentName);
  if (!fs.existsSync(pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Options for removing an agent from its team and terminating it.
 */
export interface RemoveAgentOptions {
  /** Name of the team the agent belongs to */
  team: string;
  /** Name of the agent to remove and terminate */
  agentName: string;
  /** Process id to terminate when the caller knows it, for example its own process. When omitted, the pid is read from the agent's pid file */
  ownPid?: number;
  /** Terminal window id when the caller already holds it; otherwise it is read from the team config */
  windowId?: string;
  /** Terminal pane id when the caller already holds it; otherwise it is read from the team config */
  paneId?: string;
  /** Terminal adapter used to close the agent's pane or window. When omitted, only config, state, and pid removal run */
  terminal?: TerminalAdapter | null;
}

/**
 * Check whether the process with the given pid still looks like a pi worker.
 *
 * Pid files can outlive their process: after a crash the OS may hand the pid
 * to an unrelated program, and a blind SIGKILL would kill that program. The
 * pid is only trusted when its command line has the `--model` flag that
 * every spawned worker is launched with.
 *
 * @param pid - Process id from the agent's pid file
 * @returns True when the command line matches pi; unknown shapes are skipped
 */
/**
 * Workers launch as `node <pi cli> --model <provider/model> ...`. The flag
 * identifies a pi worker; a bare path component named "pi" does not.
 */
const PI_WORKER_COMMAND_PATTERN = /\s--model\s/;

function pidLooksLikePiWorker(pid: number): boolean {
  try {
    const result = execCommand("ps", ["-p", String(pid), "-o", "command="]);
    if (result.status !== 0) return false;
    return PI_WORKER_COMMAND_PATTERN.test(result.stdout);
  } catch (_e) {
    return false;
  }
}

/**
 * Remove an agent from its team, clean up its state, and terminate it.
 *
 * This is the single removal path for worker termination: team shutdown,
 * approved shutdown, and an agent closing itself all run these steps. The
 * team-lead is never removed because the lead coordinates shutdowns itself.
 *
 * Every step is tolerant to missing state: a missing team config, member
 * record, state file, or process does not stop the remaining steps.
 *
 * @param options - Team, agent name, optional explicit pid and terminal ids, and an optional terminal adapter
 */
export async function removeAgent(options: RemoveAgentOptions): Promise<void> {
  const { team, agentName } = options;
  // The lead coordinates shutdowns itself and is never removed.
  if (agentName === "team-lead") return;

  // Capture the pid before state cleanup; the pid file is deleted below.
  const pid = options.ownPid ?? readPidFromPidFile(team, agentName);

  // Capture terminal ids from the team config when the caller did not pass
  // them: the member record disappears from the config after removal.
  let windowId = options.windowId ?? "";
  let paneId = options.paneId ?? "";
  try {
    const config = await readConfig(team);
    const member = config.members.find((m) => m.name === agentName);
    windowId = windowId || member?.windowId || "";
    paneId = paneId || member?.tmuxPaneId || "";
  } catch (_e) {
    // A missing team config does not stop removal.
  }

  try {
    await removeMember(team, agentName);
  } catch (_e) {
    // The config may already be gone; termination still matters.
  }

  resetAgentState(team, agentName);

  const terminal = options.terminal ?? null;
  if (terminal) {
    try {
      if (windowId) terminal.killWindow(windowId);
    } catch (_e) {
      // ignore
    }
    try {
      if (paneId) terminal.kill(paneId);
    } catch (_e) {
      // ignore
    }
  }

  if (pid !== null) {
    // Only a pid the caller vouches for (close_myself passes its own pid) is
    // killed without verification; pid-file pids are checked against the pi
    // command line so pid reuse cannot make us kill an unrelated process.
    if (options.ownPid === pid || pidLooksLikePiWorker(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_e) {
        // The process may already be gone.
      }
    }
  }
}
