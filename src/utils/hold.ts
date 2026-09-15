import { Member, TeamConfig } from "./models";

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
  /** True when this agent is a teammate instead of the team-lead. */
  isTeammate: boolean;
  /** Name of the team the lead is coordinating, when one is active. */
  teamName: string | undefined;
};

/**
 * Inputs for the lead-guidance decision.
 */
export type LeadGuideOptions = {
  /** True when dialog-capable UI is available, which is TUI and RPC modes. */
  hasUI: boolean;
  /** True when this agent is a teammate instead of the team-lead. */
  isTeammate: boolean;
};

/** What the hold loop needs to know about one team's state right now. */
export type TeamLivenessSnapshot = {
  /** False when the team directory is gone, which means team_shutdown ran. */
  teamExists: boolean;
  /** Number of non-lead members in the team configuration. */
  workerCount: number;
  /** Number of those members that can still produce work or messages. */
  liveWorkerCount: number;
};

/** Predicate that decides liveness for one team member. */
export type MemberAliveCheck = (member: Member) => boolean;

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
 * active. Only non-interactive host modes need the hold.
 *
 * @param options - hasUI flag, teammate flag, and active team name
 * @returns True when the run should be held open for the active team
 */
export function shouldHoldWhileTeamActive(options: RunHoldOptions): boolean {
  return (
    !options.isTeammate &&
    isNonInteractiveMode(options) &&
    options.teamName !== undefined &&
    options.teamName !== ""
  );
}

/**
 * Determine whether the team-lead should receive guidance about the hold in
 * its system prompt. The note applies regardless of whether a team exists at
 * prompt time, because the lead can create a team mid-run.
 *
 * @param options - hasUI flag and teammate flag
 * @returns True when the lead runs in a non-interactive host mode
 */
export function shouldGuideLead(options: LeadGuideOptions): boolean {
  return !options.isTeammate && isNonInteractiveMode(options);
}

/**
 * Count the team members that can still produce work or messages. Team-lead
 * members are never counted; the lead does not hold itself open.
 *
 * @param config - Parsed team configuration
 * @param isMemberAlive - Predicate that decides liveness for one member
 * @returns Number of non-lead members that are alive
 */
export function countLiveWorkers(
  config: TeamConfig,
  isMemberAlive: MemberAliveCheck,
): number {
  return config.members.filter(
    (member) => member.name !== "team-lead" && isMemberAlive(member),
  ).length;
}

/**
 * Decide whether the hold should release based on one team-liveness snapshot.
 *
 * The run releases when the team directory is gone (team_shutdown ran), when
 * the team has no workers at all, or when no worker has been alive for
 * RUN_HOLD_RELEASE_FAILURES consecutive checks. Workers need a moment to boot
 * and write their pid file, so the first failed check never releases alone.
 *
 * @param snapshot - Current team-liveness snapshot
 * @param consecutiveFailures - Failed liveness checks so far, counting this one
 * @returns True when the run should release and settle
 */
export function shouldReleaseRun(
  snapshot: TeamLivenessSnapshot,
  consecutiveFailures: number,
): boolean {
  if (!snapshot.teamExists) return true;
  if (snapshot.workerCount === 0) return true;
  if (snapshot.liveWorkerCount > 0) return false;
  return consecutiveFailures >= RUN_HOLD_RELEASE_FAILURES;
}
