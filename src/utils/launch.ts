/**
 * Launch plumbing shared by the pi extension and the `pi-teams` CLI: start a
 * worker or a peer lead through the terminal adapter and wait for its socket.
 * Model resolution stays with the caller, because only a pi session has a
 * model registry.
 */
import { sendAgentMessage } from "./messaging";
import { generateAgentId, readAgentRecords, updateAgentRecord } from "./registry";
import * as paths from "./paths";
import {
  buildLeadCommand,
  buildLeadEnv,
  buildWorkerCommand,
  resolveLeadFolder,
  resolveSpawnDirectory,
  spawnWorkerProcess,
} from "./spawn";
import type { TerminalAdapter } from "./terminal-adapter";
import { waitForListener } from "./transport";

/** Time a spawn waits for the new agent's socket before it returns anyway. */
export const LISTEN_TIMEOUT_MS = 30_000;

/** What to launch as a worker. */
export interface WorkerLaunchGoals {
  name: string;
  cwd?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  separateWindow?: boolean;
  readonlyWorker: boolean;
  /**
   * First task for the worker, delivered as a message from the lead once the
   * worker listens, so it starts working without a separate send_message.
   */
  initialPrompt?: string;
}

/** Subject line of the message that carries a worker's initial prompt. */
export const INITIAL_PROMPT_SUBJECT = "Your task";

/** A launched worker. */
export interface LaunchedWorker {
  agentId: string;
  terminalId: string;
  isWindow: boolean;
  model: string;
  listening: boolean;
  /** Present only when an initial prompt was given: whether it reached the worker. */
  promptDelivered?: boolean;
}

/** Inputs for {@link launchWorker}. */
export interface LaunchWorkerArgs {
  terminal: TerminalAdapter | null | undefined;
  /** Agent id of the lead that owns the worker. */
  leadId: string;
  /** The lead's working directory; the worker's cwd must sit inside it. */
  leadCwd: string;
  goals: WorkerLaunchGoals;
  /** Fully qualified provider/model, already resolved by the caller. */
  model: string;
  /** Environment the worker inherits. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  listenTimeoutMs?: number;
}

/**
 * Launch one worker owned by `leadId` and wait for it to listen.
 *
 * @throws Error when no terminal is detected, the name or cwd is invalid, a
 *   worker of that name already exists under the lead, or the launch fails.
 */
export async function launchWorker(args: LaunchWorkerArgs): Promise<LaunchedWorker> {
  const { terminal, goals, model } = args;
  const safeName = paths.sanitizeName(goals.name);
  if (!terminal) throw new Error("No terminal adapter detected.");
  const cwd = resolveSpawnDirectory(goals.cwd, args.leadCwd);
  const useSeparateWindow = !goals.readonlyWorker && (goals.separateWindow ?? false);
  if (useSeparateWindow && !terminal.supportsWindows()) {
    throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
  }

  const { piCmd, agentType } = buildWorkerCommand(goals, model);
  const ownWorkers = readAgentRecords().filter((record) => record.leadId === args.leadId);
  if (ownWorkers.some((record) => record.name === safeName)) {
    throw new Error(`A worker named "${safeName}" already exists under this lead.`);
  }
  const workerId = generateAgentId();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.baseEnv ?? process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PI_AGENT_NAME = safeName;
  env.PI_AGENT_TYPE = agentType;
  env.PI_AGENT_ID = workerId;
  env.PI_LEAD_ID = args.leadId;

  let terminalId: string;
  try {
    terminalId = spawnWorkerProcess(terminal, {
      name: safeName,
      cwd,
      piCmd,
      env,
      agents: ownWorkers,
      useSeparateWindow,
      readonlyWorker: goals.readonlyWorker,
    });
  } catch (e) {
    throw new Error(`Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`);
  }

  const listening = await waitForListener(workerId, args.listenTimeoutMs ?? LISTEN_TIMEOUT_MS);
  // shortcut: a worker that boots after the wait keeps no terminal ids, so close_worker
  // kills its pid but leaves the pane open; pass the ids via env if that matters.
  if (listening) {
    updateAgentRecord(workerId, useSeparateWindow ? { windowId: terminalId } : { paneId: terminalId });
  }
  const launched: LaunchedWorker = { agentId: workerId, terminalId, isWindow: useSeparateWindow, model, listening };
  const initialPrompt = goals.initialPrompt?.trim();
  if (initialPrompt) {
    launched.promptDelivered = listening && (await deliverInitialPrompt(args.leadId, workerId, initialPrompt));
  }
  return launched;
}

/**
 * Send a worker its initial prompt as a reply-expected message from its lead.
 * A failure is reported, not thrown: the worker is already running, and the
 * lead can still send the task with send_message.
 */
async function deliverInitialPrompt(leadId: string, workerId: string, prompt: string): Promise<boolean> {
  try {
    const records = readAgentRecords();
    const lead = records.find((record) => record.id === leadId);
    if (!lead) return false;
    await sendAgentMessage(lead, workerId, INITIAL_PROMPT_SUBJECT, prompt, true, undefined, records);
    return true;
  } catch {
    return false;
  }
}

/** Inputs for {@link launchLead}. */
export interface LaunchLeadArgs {
  terminal: TerminalAdapter | null | undefined;
  /** Raw folder from the caller; `~` expands, the directory must exist. */
  folder: string;
  /** Fully qualified provider/model, already resolved by the caller. */
  model?: string;
  separateWindow?: boolean;
  /** Environment the lead inherits minus team identity. Defaults to this process's. */
  baseEnv?: NodeJS.ProcessEnv;
  listenTimeoutMs?: number;
}

/** A launched peer lead. */
export interface LaunchedLead {
  id: string;
  cwd: string;
  terminalId: string;
  isWindow: boolean;
  listening: boolean;
}

/**
 * Launch an independent peer lead in an existing folder and wait for it to
 * listen. The new lead does not join the spawner's team.
 *
 * @throws Error when no terminal is detected, the folder is invalid, windows
 *   are unsupported, or the launch fails.
 */
export async function launchLead(args: LaunchLeadArgs): Promise<LaunchedLead> {
  const { terminal } = args;
  if (!terminal) throw new Error("No terminal adapter detected.");
  const folder = resolveLeadFolder(args.folder);
  const useSeparateWindow = args.separateWindow ?? false;
  if (useSeparateWindow && !terminal.supportsWindows()) {
    throw new Error(`Separate windows mode is not supported in ${terminal.name}.`);
  }

  const id = generateAgentId();
  const name = `pi-lead-${id}`;
  const env = buildLeadEnv(args.baseEnv ?? process.env, id);
  const command = buildLeadCommand(args.model);

  // The spawner does not own the new lead: no member record, no seeded
  // state, no roll-back path. A failed launch surfaces the adapter error.
  let terminalId = "";
  try {
    terminalId = useSeparateWindow
      ? terminal.spawnWindow({ name, cwd: folder, command, env })
      : terminal.spawn({ name, cwd: folder, command, env });
  } catch (e) {
    throw new Error(`Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`);
  }

  const listening = await waitForListener(id, args.listenTimeoutMs ?? LISTEN_TIMEOUT_MS);
  return { id, cwd: folder, terminalId, isWindow: useSeparateWindow, listening };
}
