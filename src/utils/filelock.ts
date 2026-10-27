import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "./pid";

/** Elapsed time before a lock with an unreadable holder can be treated as stale. */
const STEAL_TIMEOUT_MS = 2_000;
/** Elapsed time after which a live holder's lock is treated as leaked and stealable. */
const LIVE_HOLDER_CAP_MS = 30_000;
/** Default maximum wait for a live holder before {@link LockHeldError} throws. */
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 2_000;
/** Environment override for the wait limit, in milliseconds. */
const LOCK_WAIT_TIMEOUT_ENV = "PI_TEAMS_LOCK_WAIT_TIMEOUT_MS";
/** Interval between acquisition attempts while another process holds the lock. */
const RETRY_TICK_MS = 10;

/** The holder pid and per-acquisition nonce recorded in a lock file. */
interface LockInfo {
  /** Holder pid, or undefined when the content is missing or unparseable. */
  pid: number | undefined;
  /** Per-acquisition nonce, or undefined when the content is unparseable. */
  nonce: string | undefined;
  /** Last modification time in milliseconds; used for age-based staleness. */
  mtimeMs: number;
}

/**
 * Interleaving hooks used by tests to force a specific syscall ordering.
 *
 * Production callers omit them. They exist so a test can inject a successor
 * lock or a second stealer at an otherwise unschedulable moment, turning the
 * race into a deterministic assertion.
 *
 * @internal
 */
export interface LockHooks {
  /** Called after a stale lock is inspected and before the steal claim is taken. */
  afterStaleInspection?: (lockPath: string) => void;
  /** Called after the claim is won and staleness re-verified, before the rename. */
  beforeStealRename?: (lockPath: string) => void;
}

/**
 * Resolve the maximum wait for a live lock holder, in milliseconds.
 *
 * The environment variable is read on each call so tests can stub a short
 * limit instead of blocking for seconds per assertion. Unset, non-numeric,
 * or non-positive values fall back to the default.
 */
function lockWaitTimeoutMs(): number {
  const raw = process.env[LOCK_WAIT_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_WAIT_TIMEOUT_MS;
}

/** Error raised when a live or unknown holder keeps a lock past the wait limit. */
export class LockHeldError extends Error {
  constructor(lockPath: string, holderPid?: number) {
    super(
      holderPid === undefined
        ? `Lock is held by an unknown holder: ${lockPath}`
        : `Lock is held by live pid ${holderPid}: ${lockPath}`,
    );
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

/** Parse a lock file's `pid:nonce` content; either part is undefined when unparseable. */
function parseLockContent(raw: string): { pid: number | undefined; nonce: string | undefined } {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(":");
  const pidPart = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const noncePart = separator === -1 ? "" : trimmed.slice(separator + 1);
  const pid = Number.parseInt(pidPart, 10);
  return {
    pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
    nonce: noncePart.length > 0 ? noncePart : undefined,
  };
}

/**
 * Read a lock's holder pid, nonce, and mtime.
 *
 * Returns undefined only when the lock path is absent. When the path exists
 * but its content is unreadable, the pid and nonce are undefined so the
 * caller can apply the unreadable-holder timeout.
 */
function readLockInfo(lockPath: string): LockInfo | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
  try {
    const { pid, nonce } = parseLockContent(fs.readFileSync(lockPath, "utf8"));
    return { pid, nonce, mtimeMs };
  } catch {
    return { pid: undefined, nonce: undefined, mtimeMs };
  }
}

/** Read the holder pid recorded in a lock file, if any. */
function readLockPid(lockPath: string): number | undefined {
  return readLockInfo(lockPath)?.pid;
}

/** Read the pid recorded in a steal-claim symlink, if any. */
function readClaimPid(claimPath: string): number | undefined {
  try {
    return parseLockContent(fs.readlinkSync(claimPath)).pid;
  } catch {
    return undefined;
  }
}

/**
 * Whether an inspected lock can be taken over.
 *
 * A dead holder is stealable at once. A lock whose content is missing or
 * unparseable is untrusted content, not a live holder, so it is stealable
 * after {@link STEAL_TIMEOUT_MS}. A live holder is stealable only once the
 * lock is older than {@link LIVE_HOLDER_CAP_MS}, which recovers locks leaked
 * by a crashed release or a reused pid without racing a short critical
 * section.
 */
function isStaleLock(info: LockInfo, now: number): boolean {
  if (info.pid === undefined) return now - info.mtimeMs >= STEAL_TIMEOUT_MS;
  if (!isPidAlive(info.pid)) return true;
  return now - info.mtimeMs >= LIVE_HOLDER_CAP_MS;
}

/** A unique scratch name under the lock's directory. */
function scratchName(lockPath: string, tag: string): string {
  return `${lockPath}.${tag}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/** The steal-claim path for a lock; derived from the full lock path so locks never collide. */
function claimName(lockPath: string): string {
  return `${lockPath}.steal`;
}

/**
 * Take over a stale lock by replacing it atomically, without ever freeing the
 * lock path.
 *
 * A stale lock is replaced with a scratch file that carries our `pid:nonce`
 * through `renameSync`, which atomically overwrites the lock path. Because the
 * path never disappears, a concurrent acquirer's `linkSync` always sees EEXIST
 * and no third process can enter while a takeover is in flight. Steals are
 * single-winner: only the holder of the exclusive symlink claim performs the
 * rename, and it re-verifies staleness under the claim before doing so. A
 * claim left by a dead stealer is reclaimed.
 *
 * Residual window: the claim fences stealers against each other, but a live
 * holder whose lock passed {@link LIVE_HOLDER_CAP_MS} can still release in the
 * single syscall between the re-verification and the rename. That is the
 * price of recovering a genuinely leaked lock; critical sections are
 * milliseconds and the cap is orders of magnitude larger, so the window is not
 * reachable by an active holder in normal operation.
 *
 * @param lockPath - Lock file path
 * @param content - Our `pid:nonce` lock content
 * @param nonce - Our nonce, used to confirm we still own the path after the rename
 * @param hooks - Test-only interleaving hooks
 * @returns true when the lock path now carries our nonce
 */
function stealStaleLock(lockPath: string, content: string, nonce: string, hooks: LockHooks): boolean {
  const observed = readLockInfo(lockPath);
  if (observed === undefined || !isStaleLock(observed, Date.now())) return false;
  hooks.afterStaleInspection?.(lockPath);

  const claim = claimName(lockPath);
  try {
    fs.symlinkSync(content, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const claimerPid = readClaimPid(claim);
      if (claimerPid === undefined || !isPidAlive(claimerPid)) {
        fs.rmSync(claim, { force: true });
      }
      return false;
    }
    throw error;
  }

  try {
    const current = readLockInfo(lockPath);
    if (current === undefined || !isStaleLock(current, Date.now())) return false;
    hooks.beforeStealRename?.(lockPath);
    const scratch = scratchName(lockPath, "takeover");
    try {
      fs.writeFileSync(scratch, content, { mode: 0o600 });
      fs.renameSync(scratch, lockPath);
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    return readLockInfo(lockPath)?.nonce === nonce;
  } finally {
    fs.rmSync(claim, { force: true });
  }
}

/** Run `fn` while holding the lock, and release only our own lock. */
function runHoldingLock<T>(lockPath: string, nonce: string, fn: () => T): T {
  try {
    return fn();
  } finally {
    // A steal may have replaced the file while we ran. Deleting it must not
    // clobber the successor's lock, so release only the lock whose nonce is
    // ours. Release is not atomic against a rename-over steal, but that steal
    // only targets a lock older than LIVE_HOLDER_CAP_MS, so an active holder's
    // millisecond release never races it in normal operation.
    if (readLockInfo(lockPath)?.nonce === nonce) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Run `fn` while holding the lock file at `lockPath`.
 *
 * Acquisition writes `pid:nonce` to a unique scratch file, then hard-links the
 * scratch onto the lock path: `link` fails with EEXIST when the lock exists,
 * so exactly one process wins, and the lock file always carries its owner from
 * its first visible moment (there is no window where the lock exists but its
 * owner is unknown). Release removes the lock only when its nonce matches
 * ours, so a lock taken over by another process is never clobbered.
 *
 * If another process holds the lock, the caller sleeps in short ticks and
 * steals it when the recorded holder pid is dead (immediately), the content is
 * unparseable (after {@link STEAL_TIMEOUT_MS}), or a live holder's lock is
 * older than {@link LIVE_HOLDER_CAP_MS}. A steal replaces the lock path
 * atomically through a single-winner claim, so the path never becomes free and
 * a third process can never enter while a takeover is in flight. Once the wait
 * limit (2 seconds by default, or `PI_TEAMS_LOCK_WAIT_TIMEOUT_MS`) is
 * reached, the call throws {@link LockHeldError}, naming the live holder pid
 * when the lock file is readable. The wait blocks the calling thread with
 * `Atomics.wait`, so callers whose work self-heals on a later pass should
 * catch {@link LockHeldError} and skip instead of holding the event loop.
 *
 * Not reentrant: `fn` must not acquire the same lock path again.
 *
 * @param lockPath - Lock file path; its parent directory is created 0700 if missing
 * @param fn - Critical section; its return value is passed through
 * @param hooks - Test-only interleaving hooks; omit in production
 * @returns Whatever `fn` returns
 * @throws LockHeldError when a live or unknown holder keeps the lock past the wait limit
 */
export function withLockFile<T>(lockPath: string, fn: () => T, hooks: LockHooks = {}): T {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const waitTimeoutMs = lockWaitTimeoutMs();
  const waitStartedAt = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const content = `${process.pid}:${nonce}`;

  for (;;) {
    const scratch = scratchName(lockPath, "tmp");
    fs.writeFileSync(scratch, content, { mode: 0o600 });
    let acquired = false;
    try {
      fs.linkSync(scratch, lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(scratch, { force: true });
    }
    if (!acquired) acquired = stealStaleLock(lockPath, content, nonce, hooks);
    if (acquired) return runHoldingLock(lockPath, nonce, fn);
    if (Date.now() - waitStartedAt >= waitTimeoutMs) {
      throw new LockHeldError(lockPath, readLockPid(lockPath));
    }
    sleepSync(RETRY_TICK_MS);
  }
}
