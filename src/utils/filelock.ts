import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "./pid";

/** Elapsed time before an unreadable lock can be treated as stale. */
const STEAL_TIMEOUT_MS = 2_000;
/** Maximum time to wait for a live lock holder. */
const LOCK_WAIT_TIMEOUT_MS = 2_000;
/** Interval between acquisition attempts while another process holds the lock. */
const RETRY_TICK_MS = 10;

/** Error raised when a live process continues to hold a lock past the wait limit. */
export class LockHeldError extends Error {
  constructor(lockPath: string) {
    super(`Lock is held by a live process: ${lockPath}`);
    this.name = "LockHeldError";
  }
}

/**
 * Sleep synchronously without spinning.
 *
 * `Atomics.wait` on a fresh zeroed buffer never wakes early, and Node allows
 * it on the main thread (this is how `child_process.execSync` blocks too).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read the holder pid recorded in a lock file. */
function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** A unique scratch name under the lock's directory. */
function scratchName(lockPath: string, tag: string): string {
  return `${lockPath}.${tag}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Steal a stale lock, fencing the rename against successors.
 *
 * A lock whose holder pid is dead is stolen immediately; a lock with an
 * unreadable (corrupt or empty) pid is stolen only after STEAL_TIMEOUT_MS;
 * a lock held by a live process is never stolen. The lock may change
 * between inspection and rename, so the renamed file is compared with the
 * inspected inode and restored when the lock path is free.
 */
function stealStaleLock(lockPath: string): void {
  let statBefore: fs.Stats;
  try {
    statBefore = fs.statSync(lockPath);
  } catch {
    return; // vanished; the next acquire wins
  }

  const holderPid = readLockPid(lockPath);
  const holderDead = holderPid !== undefined && !isPidAlive(holderPid);
  const holderUnknown = holderPid === undefined;
  const lockAgeMs = Date.now() - statBefore.mtimeMs;
  if (!holderDead && !(holderUnknown && lockAgeMs >= STEAL_TIMEOUT_MS)) return;

  const stale = scratchName(lockPath, "stale");
  try {
    fs.renameSync(lockPath, stale);
    const statAfter = fs.statSync(stale);
    if (statAfter.ino !== statBefore.ino || statAfter.mtimeMs !== statBefore.mtimeMs) {
      try {
        fs.linkSync(stale, lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    fs.rmSync(stale, { force: true });
  } catch {
    // Another waiter stole it first, or it vanished: retry the acquire.
  }
}

/** Run `fn` while holding the lock, and release only our own lock. */
function runHoldingLock<T>(lockPath: string, fn: () => T): T {
  try {
    return fn();
  } finally {
    // A steal may have replaced the file while we ran. Deleting it must not
    // clobber the successor's lock, so release only what we still own.
    if (readLockPid(lockPath) === process.pid) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Run `fn` while holding the lock file at `lockPath`.
 *
 * Acquisition writes the pid to a unique scratch file, then hard-links the
 * scratch file onto the lock path: `link` fails with EEXIST when the lock
 * exists, so exactly one process wins, and the lock file always carries the
 * holder's pid from its first visible moment (no window where the lock
 * exists but its owner is unknown).
 *
 * If another process holds the lock, the caller sleeps in short ticks and
 * steals the lock when the recorded holder pid is dead (immediately) or
 * unreadable (after STEAL_TIMEOUT_MS); a live holder is never stolen. The
 * wait blocks synchronously (`Atomics.wait`), so the worst case is roughly
 * LOCK_WAIT_TIMEOUT_MS of no event-loop progress; after
 * LOCK_WAIT_TIMEOUT_MS the call throws {@link LockHeldError}.
 *
 * Not reentrant: `fn` must not acquire the same lock path again.
 *
 * @param lockPath - Lock file path; its parent directory is created 0700 if missing
 * @param fn - Critical section; its return value is passed through
 * @returns Whatever `fn` returns
 */
export function withLockFile<T>(lockPath: string, fn: () => T): T {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const waitStartedAt = Date.now();
  for (;;) {
    const scratch = scratchName(lockPath, "tmp");
    fs.writeFileSync(scratch, String(process.pid), { mode: 0o600 });
    let acquired = false;
    try {
      fs.linkSync(scratch, lockPath);
      acquired = true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      stealStaleLock(lockPath);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    if (acquired) return runHoldingLock(lockPath, fn);
    if (Date.now() - waitStartedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new LockHeldError(lockPath);
    }
    sleepSync(RETRY_TICK_MS);
  }
}
