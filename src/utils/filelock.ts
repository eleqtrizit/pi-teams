import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "./pid";

/**
 * Steal a lock when its file is older than this, even if the holder pid is
 * alive (covers a wedged holder). Critical sections are milliseconds, so the
 * worst-case event-loop block stays short.
 */
const STEAL_TIMEOUT_MS = 2_000;
/** Interval between acquisition attempts while another process holds the lock. */
const RETRY_TICK_MS = 10;

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

/** Lock age in milliseconds; undefined when the file is gone. */
function lockAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** A unique scratch name under the lock's directory. */
function scratchName(lockPath: string, tag: string): string {
  return `${lockPath}.${tag}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Steal a stale lock by renaming it to a unique name.
 *
 * A steal is warranted only when the lock file itself is old: its holder pid
 * is dead (crashed or SIGKILLed while holding), or the file has been held
 * past {@link STEAL_TIMEOUT_MS}. A fresh lock is never stolen, whatever its
 * content looks like, because the holder may still be running.
 *
 * Renaming is the steal: `rename` is atomic, so when several waiters try to
 * steal the same stale lock, exactly one wins and the others see the file
 * vanish and simply retry the acquire.
 */
function stealStaleLock(lockPath: string): void {
  const age = lockAgeMs(lockPath);
  if (age === undefined) return; // vanished; the next acquire wins
  const holderPid = readLockPid(lockPath);
  const holderDead = holderPid !== undefined && !isPidAlive(holderPid);
  if (!holderDead && age < STEAL_TIMEOUT_MS) return; // alive and fresh: wait

  const stale = scratchName(lockPath, "stale");
  try {
    fs.renameSync(lockPath, stale);
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
 * steals only when the lock file is genuinely stale (dead holder pid, or
 * the file has been held past {@link STEAL_TIMEOUT_MS}), so writers always
 * make progress. A stolen-write race can lose one `lastSeenAt` stamp, which
 * the next list pass re-stamps.
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
    sleepSync(RETRY_TICK_MS);
  }
}
