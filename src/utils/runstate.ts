import fs from "node:fs";
import path from "node:path";
import { agentIdStatePath, registryDir } from "./paths";
import { ensurePrivateDir } from "./transport";

/**
 * Per-agent run state, published by the agent's own session.
 *
 * An agent is busy between `agent_start` and `agent_settled`: the whole
 * settle cycle, including parked run-hold time and queued follow-up runs,
 * not just one low-level run. `agent_settled` is the ultimate sign the
 * agent is done, because pi will not continue on its own past it.
 */
export interface RunState {
  /** True while a run cycle is in progress. */
  busy: boolean;
  /** Epoch milliseconds when this state was written. Used to expire stale states. */
  since: number;
}

/**
 * A busy state older than this is treated as Idling.
 *
 * `agent_settled` normally clears busy, but a crash, kill -9, or SIGKILL from
 * close_myself can leave a stale busy file behind. The timestamp expires it.
 */
export const BUSY_STALE_MS = 10 * 60_000;

/**
 * Publish the calling agent's run state atomically.
 *
 * Writes to a temp file in the state directory, then renames it into place so
 * readers never see a partial file, matching the registry's write pattern.
 *
 * @param id - 8-character agent id of the caller
 * @param busy - Whether the agent is inside a run cycle
 * @throws Error when the state file cannot be written
 */
export function writeRunState(id: string, busy: boolean): void {
  ensurePrivateDir(path.join(registryDir(), "state"));
  const file = agentIdStatePath(id);
  const state: RunState = { busy, since: Date.now() };
  const tmp = path.join(path.dirname(file), `.tmp-state-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Remove the calling agent's state file; ENOENT is ignored. */
export function removeRunState(id: string): void {
  try {
    fs.rmSync(agentIdStatePath(id), { force: true });
  } catch (_e) {
    // ignore: state is advisory
  }
}

/**
 * Read whether an agent is currently busy.
 *
 * A missing, unreadable, or unparseable state file means not busy. A busy
 * state older than {@link BUSY_STALE_MS} is treated as not busy, so a killed
 * session does not look busy forever.
 *
 * @param id - Agent id to inspect
 * @returns True when the agent published a fresh busy state
 */
export function isAgentBusy(id: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(agentIdStatePath(id), "utf8");
  } catch {
    return false;
  }
  try {
    const state = JSON.parse(raw) as RunState;
    return state.busy === true && Date.now() - state.since <= BUSY_STALE_MS;
  } catch {
    return false;
  }
}
