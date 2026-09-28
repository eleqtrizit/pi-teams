import fs from "node:fs";
import * as path from "node:path";
import { TeamConfig, Member } from "./models";
import * as paths from "./paths";
import { withLock } from "./lock";
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
  separateWindows?: boolean
): TeamConfig {
  const dir = paths.teamDir(name);
  // Always wipe the team directory so no state files (inboxes, awoken markers,
  // reminder timestamps, PIDs, etc.) leak from a previous run of the same team.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const tasksDir = paths.taskDir(name);
  if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true, force: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
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
 * The list covers liveness markers (pid, activity), message state (last
 * message, report, reminder, awoken timestamps), first-activation stamps, and
 * the inbox file. A removed agent must leave none of these behind: stale
 * activity markers make the lead's liveness checks report the agent as alive,
 * and leftover timestamps would leak into a respawned agent of the same name.
 *
 * @param team - Name of the team the agent belongs to
 * @param agentName - Name of the agent
 * @returns Paths of the agent's state files
 */
function agentStateFiles(team: string, agentName: string): string[] {
  const teamDirectory = paths.teamDir(team);
  return [
    path.join(teamDirectory, `${agentName}.pid`),
    path.join(teamDirectory, `${agentName}.active`),
    paths.lastMessagePath(team, agentName),
    paths.lastReportPath(team, agentName),
    paths.lastAwokenPath(team, agentName),
    paths.lastReminderPath(team, agentName),
    paths.firstActivationPath(team, agentName),
    paths.inboxPath(team, agentName),
  ];
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
  teamDirectory: string,
  agentName: string,
): number | null {
  const pidFile = path.join(teamDirectory, `${agentName}.pid`);
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

  const teamDirectory = paths.teamDir(team);
  // Capture the pid before state cleanup; the pid file is deleted below.
  const pid = options.ownPid ?? readPidFromPidFile(teamDirectory, agentName);

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

  for (const stateFile of agentStateFiles(team, agentName)) {
    try {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    } catch (_e) {
      // ignore
    }
  }

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
    try {
      process.kill(pid, "SIGKILL");
    } catch (_e) {
      // The process may already be gone.
    }
  }
}
