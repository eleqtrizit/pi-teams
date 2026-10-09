// Project: pi-teams
import fs from "node:fs";

/**
 * Age (ms) after which a lock is considered stale even when its recorded pid
 * is alive (the pid may have been recycled). A dead pid makes a lock stale
 * immediately.
 */
const STALE_LOCK_TIMEOUT = 30000;
const RETRY_INTERVAL_MS = 100;
/**
 * Default retry budget. 300 x 100 ms = 30 s, at least as long as the stale
 * timeout, so a lock left by a killed process is reaped within one wait and
 * callers do not fail with "Could not acquire lock" while it is reaped.
 */
const DEFAULT_RETRIES = 300;

/** Read the pid recorded in a lock file, or null when unreadable. */
function readLockPid(lockFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (_e) {
    return null;
  }
}

/** True when no live process holds the given pid. */
function isPidDead(pid: number | null): boolean {
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/**
 * Remove a lock only when it is genuinely stale.
 *
 * The unlink runs on a renamed copy so two waiters cannot both judge the same
 * lock stale and then delete each other's fresh locks: the rename is atomic,
 * and a waiter that loses the rename finds the lock file gone, not stale.
 */
function reapStaleLock(lockFile: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(lockFile);
  } catch (_e) {
    return; // Gone already.
  }
  const pid = readLockPid(lockFile);
  const age = Date.now() - stats.mtimeMs;
  const staleByPid = pid !== null && isPidDead(pid);
  // A live pid does not prove ownership: the OS recycles pids. Any lock older
  // than the timeout is stale, whatever its pid says.
  const staleByAge = age > STALE_LOCK_TIMEOUT;
  if (!staleByPid && !staleByAge) return;

  const reaped = `${lockFile}.reaped.${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockFile, reaped);
    fs.unlinkSync(reaped);
  } catch (_e) {
    // Someone else reaped or replaced it first; the retry loop rechecks.
  }
}

/**
 * Run `fn` while holding an exclusive lock file at `${lockPath}.lock`.
 *
 * The lock records the holder's pid. A lock whose pid is dead is reaped
 * immediately, so a crashed holder never blocks longer than one retry
 * interval. Acquisition failures other than "lock exists" (for example a
 * missing parent directory) are rethrown, not swallowed as busy-ness.
 *
 * @param lockPath - Path whose sibling `.lock` file guards the critical section
 * @param fn - Critical section to run
 * @param retries - Retry budget; each retry waits RETRY_INTERVAL_MS
 * @returns Whatever `fn` returns
 * @throws Error When the lock cannot be acquired within the retry budget
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  retries: number = DEFAULT_RETRIES,
): Promise<T> {
  const lockFile = `${lockPath}.lock`;
  let attempts = retries;
  let acquired = false;

  while (attempts > 0) {
    try {
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: "wx" });
      acquired = true;
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw e;
      }
      reapStaleLock(lockFile);
      attempts--;
      if (attempts > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    }
  }

  if (!acquired) {
    throw new Error("Could not acquire lock");
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch (_e) {
      // ignore
    }
  }
}
