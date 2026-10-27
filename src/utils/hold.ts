import { AgentRecord, AgentKind } from "./models";
import { isPidAlive } from "./pid";

/** Interval between worker-message queue checks while the run is on hold. */
export const RUN_HOLD_MESSAGE_POLL_MS = 1000;

/** Number of message polls between worker-liveness checks while on hold. */
export const RUN_HOLD_LIVENESS_POLL_EVERY = 5;

/**
 * Number of consecutive failed worker-liveness checks after which the run
 * releases. Workers need a moment to boot and write their pid file, so a
 * single failed check must not release the run.
 */
export const RUN_HOLD_RELEASE_FAILURES = 3;

/**
 * Inputs for the run-hold decision.
 */
export type RunHoldOptions = {
  /** True when dialog-capable UI is available, which is TUI and RPC modes. */
  hasUI: boolean;
  /** True when this agent is a worker instead of the team-lead. */
  isWorker: boolean;
  /** Number of workers in the registry that belong to this lead. */
  ownWorkerCount: number;
};

/**
 * Inputs for the lead-guidance decision.
 */
export type LeadGuideOptions = {
  /** True when dialog-capable UI is available, which is TUI and RPC modes. */
  hasUI: boolean;
  /** True when this agent is a worker instead of the team-lead. */
  isWorker: boolean;
};

/** What the hold loop needs to know about this lead's workers right now. */
export type TeamLivenessSnapshot = {
  /** Number of workers belonging to this lead in the registry. */
  workerCount: number;
  /** Number of those workers with a live pid. */
  liveWorkerCount: number;
};

/**
 * Determine whether the pi host is in a mode that exits on its own when the
 * agent run settles. Print-like modes run without dialog-capable UI; TUI and
 * RPC sessions keep the process alive through their own lifecycles.
 *
 * @param options - Contains the hasUI flag for the current run
 * @returns True for print-like modes where exit is automatic
 */
function isNonInteractiveMode(options: { hasUI: boolean }): boolean {
  return !options.hasUI;
}

/**
 * Determine whether the team-lead run must be held open while the team is
 * active. Only non-interactive host modes need the hold, and only when this
 * lead has at least one worker in the registry. Peer leads never hold.
 *
 * @param options - hasUI flag, teammate flag, and own worker count
 * @returns True when the run should be held open for active workers
 */
export function shouldHoldWhileTeamActive(options: RunHoldOptions): boolean {
  return (
    !options.isWorker &&
    isNonInteractiveMode(options) &&
    options.ownWorkerCount > 0
  );
}

/**
 * Determine whether the team-lead should receive guidance about the hold in
 * its system prompt. The note applies regardless of whether workers exist at
 * prompt time, because the lead can spawn workers mid-run.
 *
 * @param options - hasUI flag and worker flag
 * @returns True when the lead runs in a non-interactive host mode
 */
export function shouldGuideLead(options: LeadGuideOptions): boolean {
  return !options.isWorker && isNonInteractiveMode(options);
}

/**
 * Count the workers that are alive by pid check. Lead records are ignored
 * so callers can pass the full registry if convenient.
 *
 * @param workers - Registry records to evaluate
 * @param pidAlive - Predicate that checks whether a pid is alive
 * @returns Number of workers with a live pid
 */
export function countLiveWorkers(
  workers: AgentRecord[],
  pidAlive: (pid: number) => boolean = isPidAlive,
): number {
  return workers.filter(
    (w) => w.kind !== AgentKind.Lead && pidAlive(w.pid),
  ).length;
}

/**
 * Decide whether the hold should release based on one liveness snapshot.
 *
 * The run releases when there are no workers at all, or when no worker has
 * been alive for RUN_HOLD_RELEASE_FAILURES consecutive checks. Workers need a
 * moment to boot and write their pid file, so the first failed check never
 * releases alone.
 *
 * @param snapshot - Current liveness snapshot
 * @param consecutiveFailures - Failed liveness checks so far, counting this one
 * @returns True when the run should release and settle
 */
export function shouldReleaseRun(
  snapshot: TeamLivenessSnapshot,
  consecutiveFailures: number,
): boolean {
  if (snapshot.workerCount === 0) return true;
  if (snapshot.liveWorkerCount > 0) return false;
  return consecutiveFailures >= RUN_HOLD_RELEASE_FAILURES;
}
