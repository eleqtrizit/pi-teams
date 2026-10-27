import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import util from "node:util";
import { ensurePrivateDir } from "./transport";

/** Default maximum wait for a live holder before {@link LockHeldError} throws. */
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 2_000;
/** Environment override for the wait limit, in milliseconds. */
const LOCK_WAIT_TIMEOUT_ENV = "PI_TEAMS_LOCK_WAIT_TIMEOUT_MS";
/** Interval between acquisition attempts while another process holds the lock. */
const RETRY_TICK_MS = 10;

/**
 * Supported-platform sentence shared by the load-failure error and warning.
 *
 * The adapter package ships prebuilds for more targets (Windows, Android);
 * pi-teams tests and supports only these.
 */
const PLATFORM_SUPPORT =
  "pi-teams supports macOS and glibc Linux on arm64 and x64. " +
  "fs-native-extensions ships prebuilds for other platforms; " +
  "pi-teams does not test or support them there.";

/** The subset of the native lock API that {@link withLockFile} uses. */
interface NativeLockApi {
  /** Try to take an exclusive advisory lock; `false` means it is held. */
  tryLock: (fd: number) => boolean;
  /** Release the lock taken by `tryLock` on this descriptor. */
  unlock: (fd: number) => void;
}

/**
 * Why cross-process locking cannot run.
 *
 * Both reasons share one recovery contract at the caller: skip history work
 * and self-heal later. They differ in remedy and in persistence.
 */
export enum LockUnavailableReason {
  /** The adapter module cannot load: no prebuild, or a broken install. */
  AdapterMissing = "adapter-missing",
  /** The filesystem cannot provide advisory locking (NFS, SMB, some FUSE). */
  FilesystemUnsupported = "filesystem-unsupported",
}

/**
 * Error raised when cross-process locking cannot run: the adapter cannot
 * load ({@link LockUnavailableReason.AdapterMissing}) or the filesystem
 * rejects advisory locks ({@link LockUnavailableReason.FilesystemUnsupported}).
 *
 * Distinct from {@link LockHeldError} on purpose: contention is a transient
 * condition a caller can retry or skip, while lock unavailability is an
 * environment fault that persists until the user acts on the remedy in the
 * message. Self-healing callers catch both and skip history work, keeping
 * messaging and teardown alive; the one-time warning from the loader or the
 * acquire loop is the visible signal.
 */
export class LockUnavailableError extends Error {
  /** Which unavailability case this is; selects the remedy in the message. */
  readonly reason: LockUnavailableReason;

  constructor(reason: LockUnavailableReason, message: string, options: { cause: Error }) {
    super(message, options);
    this.name = "LockUnavailableError";
    this.reason = reason;
  }
}

/**
 * Kernel errnos that mean "this filesystem cannot provide advisory
 * locking", not a programmer error: ENOLCK (NFS without lockd), ENOTSUP and
 * EOPNOTSUPP (SMB, some FUSE), ENOSYS (the operation is not implemented).
 * Everything else - EBADF, EINVAL, EIO, EPERM - can signal our own bug and
 * must propagate raw so it fails fast.
 *
 * The adapter maps errno through libuv's `uv_err_name`, which has no entry
 * for ENOLCK or EOPNOTSUPP: those surface as "Unknown system error -N", not
 * as their symbolic names. The map is therefore keyed by every shape the
 * adapter can emit - the symbolic name plus `getSystemErrorName`'s rendering
 * - and maps back to the canonical POSIX name so messages read "ENOLCK".
 *
 * First entry wins: on Linux EOPNOTSUPP and ENOTSUP share errno 95, so both
 * resolve to the ENOTSUP canonical name.
 */
const UNSUPPORTED_LOCK_CODES: ReadonlyMap<string, string> = (() => {
  const names = ["ENOLCK", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"] as const;
  const map = new Map<string, string>();
  for (const name of names) {
    map.set(name, name);
    const num = os.constants.errno[name];
    if (typeof num === "number" && num > 0) {
      // What libuv actually prints for this errno on this platform.
      const emitted = util.getSystemErrorName(-num);
      if (!map.has(emitted)) map.set(emitted, name);
      // The literal libuv fallback, in case a future version changes
      // getSystemErrorName's rendering for unknown codes.
      const literal = `Unknown system error -${num}`;
      if (!map.has(literal)) map.set(literal, name);
    }
  }
  return map;
})();

/**
 * Classify an error thrown by `tryLock` as a filesystem-unable-to-lock
 * condition, by its `code` (never its message text).
 *
 * @returns The emitted code and its canonical POSIX name, or undefined when
 *   the error is not an unsupported-lock errno
 */
function classifyUnsupportedLockError(error: unknown): { code: string; canonical: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== "string") return undefined;
  const canonical = UNSUPPORTED_LOCK_CODES.get(code);
  return canonical === undefined ? undefined : { code, canonical };
}

/**
 * The native lock API, loaded on first use instead of at module load.
 *
 * A load failure must not take down the whole pi-teams extension (a static
 * import would break messaging along with locking), so the module loads
 * lazily and failures surface as {@link LockUnavailableError} at the first
 * lock use, with one warning written to stderr per process per reason.
 *
 * @internal
 */
let nativeLock: NativeLockApi | undefined;

/**
 * Cached adapter-load failure, so later calls throw without retrying the
 * loader. Only module loads are cached: a filesystem rejection (ENOLCK and
 * friends) can be transient or path-specific and is never cached.
 */
let adapterLoadFailure: Error | undefined;

/** The active adapter loader; replaced by tests to force failures. */
let nativeLockLoader: () => NativeLockApi = loadNativeLockFromModule;

/** Reasons already warned about in this process; each warns once. */
const warnedReasons = new Set<LockUnavailableReason>();

/**
 * Load the native lock adapter from its module.
 *
 * @returns The adapter's `tryLock`/`unlock` pair
 * @throws Whatever the module load throws (no prebuilt binary, broken install)
 */
function loadNativeLockFromModule(): NativeLockApi {
  // `require` through the compiled module path: this file is CommonJS (the
  // package has no "type": "module"), so `require` resolves the addon
  // relative to the package, not the caller's working directory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const adapter = require("fs-native-extensions") as NativeLockApi;
  if (typeof adapter.tryLock !== "function" || typeof adapter.unlock !== "function") {
    throw new Error("fs-native-extensions does not expose tryLock/unlock");
  }
  return adapter;
}

/**
 * Write a reason's one-time warning to stderr, in every session mode.
 *
 * stderr, not ctx.ui.notify: it reaches noninteractive `pi -p` sessions and
 * runtime-first-use alike.
 */
function warnOnce(reason: LockUnavailableReason, message: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  process.stderr.write(message);
}

/**
 * Resolve the native lock adapter, caching success and load failure alike.
 *
 * @returns The adapter's `tryLock`/`unlock` pair
 * @throws LockUnavailableError when the adapter cannot load
 */
function resolveNativeLock(): NativeLockApi {
  if (nativeLock !== undefined) return nativeLock;
  if (adapterLoadFailure !== undefined) throw adapterUnavailableError(adapterLoadFailure);
  try {
    nativeLock = nativeLockLoader();
    return nativeLock;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    adapterLoadFailure = cause;
    warnOnce(LockUnavailableReason.AdapterMissing, LOAD_FAILURE_WARNING);
    throw adapterUnavailableError(cause);
  }
}

/** Build the AdapterMissing error for a loader failure. */
function adapterUnavailableError(cause: Error): LockUnavailableError {
  return new LockUnavailableError(
    LockUnavailableReason.AdapterMissing,
    `pi-teams cannot load its native lock adapter (fs-native-extensions) on ` +
      `${process.platform}-${process.arch}, so cross-process history locking ` +
      `is unavailable. ${PLATFORM_SUPPORT} If this platform is supported, ` +
      `reinstall the pi-teams package (npm install) to restore a broken ` +
      `install; on unsupported platforms, history recording stays disabled. ` +
      `Original error: ${cause.message}`,
    { cause },
  );
}

/** Warning shown on first history-lock use when the adapter fails to load. */
const LOAD_FAILURE_WARNING =
  `pi-teams warning: the fs-native-extensions module failed to load on ` +
  `${process.platform}-${process.arch}; history recording is disabled for ` +
  `this session. ${PLATFORM_SUPPORT} Reinstall the pi-teams package ` +
  `(npm install) if this platform is supported.\n`;

/**
 * Build the FilesystemUnsupported error for a rejected `tryLock`.
 *
 * Operation-aware: it names the lock path and the errno, never module
 * loading, because the adapter loaded fine and the mount refused the lock.
 */
function filesystemUnsupportedError(
  lockPath: string,
  cause: NodeJS.ErrnoException,
  canonical: string,
): LockUnavailableError {
  return new LockUnavailableError(
    LockUnavailableReason.FilesystemUnsupported,
    `pi-teams cannot take the advisory lock on ${lockPath}: the filesystem ` +
      `rejected it with ${canonical} (no advisory locking support, for ` +
      `example NFS without lockd or an SMB/FUSE mount). History locking is ` +
      `skipped while the filesystem refuses locks.`,
    { cause },
  );
}

/** One-time warning text for a rejected `tryLock`. */
function filesystemUnsupportedWarning(lockPath: string, canonical: string): string {
  return (
    `pi-teams warning: the filesystem rejected the advisory lock on ` +
    `${lockPath} with ${canonical}; history recording is disabled while ` +
    `this mount refuses locks.\n`
  );
}

/**
 * Replace the adapter loader for tests; `undefined` restores the default.
 * The injected loader runs lazily on the next lock use, so a throwing loader
 * persists until it is cleared. Clearing also resets the cached failure and
 * the once-per-reason warning state, so each test can assert the warning
 * independently.
 *
 * @internal
 */
export function __setNativeLockLoaderForTests(loader?: () => NativeLockApi): void {
  nativeLockLoader = loader ?? loadNativeLockFromModule;
  nativeLock = undefined;
  adapterLoadFailure = undefined;
  warnedReasons.clear();
}

/**
 * Whether an error means a caller can safely skip history work and
 * self-heal later: transient contention ({@link LockHeldError}) or
 * unavailable locking ({@link LockUnavailableError}). Anything else is a
 * real fault and must propagate.
 *
 * @param error - The error caught around history mutations
 * @returns true when skipping history work is the documented recovery
 */
export function isLockSkippable(error: unknown): boolean {
  return error instanceof LockHeldError || error instanceof LockUnavailableError;
}

/** Options for {@link withLockFile}. */
export interface LockOptions {
  /**
   * Maximum wait for a live holder, in milliseconds. `0` makes the call a
   * single try-lock: the caller gets {@link LockHeldError} at once instead
   * of waiting, for hot paths whose work self-heals on a later pass.
   * Defaults to `PI_TEAMS_LOCK_WAIT_TIMEOUT_MS` or 2 seconds.
   */
  waitMs?: number;
}

/** Upper bound for the configurable wait; above it the default applies. */
const MAX_LOCK_WAIT_TIMEOUT_MS = 30_000;

/**
 * Resolve the maximum wait for a live lock holder, in milliseconds.
 *
 * The environment variable is read on each call so tests can stub a short
 * limit instead of blocking for seconds per assertion. It accepts a positive
 * integer up to {@link MAX_LOCK_WAIT_TIMEOUT_MS}: unset, zero, non-numeric,
 * non-positive, or oversized values fall back to the default, so a typo
 * cannot freeze the event loop for minutes per contended call. (A zero wait
 * is still available to code through `options.waitMs: 0`, the in-code
 * try-lock; the environment variable cannot select it.)
 */
function lockWaitTimeoutMs(): number {
  const raw = process.env[LOCK_WAIT_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LOCK_WAIT_TIMEOUT_MS) {
    return DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  }
  return parsed;
}

/** Error raised when a live holder keeps a lock past the wait limit. */
export class LockHeldError extends Error {
  constructor(lockPath: string, holderPid?: number) {
    super(
      holderPid === undefined
        ? `Lock is held by another process: ${lockPath}`
        : `Lock is held by pid ${holderPid} (last recorded holder): ${lockPath}`,
    );
    this.name = "LockHeldError";
  }
}

/**
 * Reusable zeroed waiter for {@link sleepSync}.
 *
 * `Atomics.wait` never mutates the buffer, so one allocation serves every
 * 10ms poll tick for the process lifetime.
 */
const SLEEP_WAITER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Sleep synchronously without spinning.
 *
 * `Atomics.wait` on a zeroed buffer never wakes early, and Node allows it on
 * the main thread (this is how `child_process.execSync` blocks too).
 */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_WAITER, 0, 0, ms);
}

/**
 * Parse the holder pid recorded in a lock file, for diagnostics only.
 *
 * The lock's authority is the kernel advisory lock, never this file's
 * content, so a strict grammar is enough: a positive decimal integer within
 * the OS pid bound. Anything else (including partial numbers like
 * `1corrupt`) yields undefined instead of a misleading pid.
 */
function parseHolderPid(raw: string): number | undefined {
  const pid = raw.trim();
  if (!/^[1-9]\d{0,9}$/.test(pid)) return undefined;
  const parsed = Number(pid);
  return parsed <= 0x7fffffff ? parsed : undefined;
}

/** Read the pid recorded in a lock file, for the LockHeldError message. */
function readHolderPid(lockPath: string): number | undefined {
  try {
    return parseHolderPid(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` while holding an exclusive advisory kernel lock on `lockPath`.
 *
 * The lock lives on a permanent inode: the file is created once and never
 * unlinked or renamed, so the path's identity is stable and the kernel
 * arbitrates every contender. On macOS the adapter uses `flock(2)` and on
 * Linux `fcntl(F_OFD_SETLK)`; both are open-file-description locks, so they
 * exclude across processes, release automatically when the holder's
 * descriptor closes (a crash, SIGKILL), and stay held across SIGSTOP. A
 * reused pid holds no descriptor of the dead process, so there is no steal
 * path, no age cap, and no pid identity check. A holder that stays alive but
 * stops progressing keeps exclusive access: contenders receive
 * {@link LockHeldError} at the wait limit rather than taking the lock from a
 * live process, because no userland check before a final write can fence an
 * arbitrarily suspended writer.
 *
 * On success the holder pid is written to the file for diagnostics only
 * (`LockHeldError` messages); the content never authorizes access. If
 * another process holds the lock, the caller sleeps in short ticks until the
 * deadline measured with `performance.now()`. The wait blocks the calling
 * thread with `Atomics.wait`, so callers whose work self-heals on a later
 * pass should pass `{ waitMs: 0 }` or catch {@link LockHeldError} and skip
 * instead of holding the event loop.
 *
 * Not reentrant: `fn` must not acquire the same lock path again.
 *
 * @param lockPath - Lock file path; its parent directory is ensured 0700
 * @param fn - Critical section; its return value is passed through
 * @param options - See {@link LockOptions}
 * @returns Whatever `fn` returns
 * @throws LockHeldError when a live holder keeps the lock past the wait limit
 * @throws LockUnavailableError when the adapter cannot load, or the
 *   filesystem rejects advisory locking (ENOLCK, ENOTSUP, EOPNOTSUPP, ENOSYS)
 */
export function withLockFile<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  // Resolve the adapter first: when a previous load failure is cached, this
  // throws before any directory or lock-file work, so hot paths pay nothing
  // but the throw.
  const lock = resolveNativeLock();

  // Reuse the registry's directory contract: created 0700, rejected when it
  // is a symlink or owned by another uid (ensurePrivateDir no-ops on
  // Windows, so create the directory there directly).
  if (process.platform === "win32") {
    if (!fs.existsSync(path.dirname(lockPath))) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    }
  } else {
    ensurePrivateDir(path.dirname(lockPath));
  }

  // A non-finite or negative wait would make the deadline NaN, which no
  // comparison ever satisfies; fall back to the configured default.
  const waitMs =
    options.waitMs !== undefined && Number.isFinite(options.waitMs) && options.waitMs >= 0
      ? options.waitMs
      : lockWaitTimeoutMs();
  const fd = fs.openSync(lockPath, "a+", 0o600);
  // True once tryLock succeeds; the release path unlocks only then, so a
  // failed attempt never makes a stray unlock syscall. Unlocking an unheld
  // descriptor is harmless (locks belong to the open file description), but
  // the acquired flag keeps the release honest.
  let acquired = false;
  try {
    // Measured from after the adapter load and the open: the first call's
    // module dlopen must not come out of the caller's wait budget.
    const deadline = performance.now() + waitMs;
    for (;;) {
      try {
        if (lock.tryLock(fd)) {
          acquired = true;
          break;
        }
      } catch (error) {
        const classified = classifyUnsupportedLockError(error);
        if (classified !== undefined) {
          warnOnce(
            LockUnavailableReason.FilesystemUnsupported,
            filesystemUnsupportedWarning(lockPath, classified.canonical),
          );
          throw filesystemUnsupportedError(lockPath, error as NodeJS.ErrnoException, classified.canonical);
        }
        throw error;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new LockHeldError(lockPath, readHolderPid(lockPath));
      }
      // Never sleep past the deadline: a short budget must not overshoot by
      // a full tick.
      sleepSync(Math.min(RETRY_TICK_MS, Math.ceil(remaining)));
    }
    try {
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, `${process.pid}\n`);
    } catch {
      // Diagnostics only: an unwritable holder pid degrades the error
      // message, never the lock.
    }
    return fn();
  } finally {
    if (acquired) {
      try {
        lock.unlock(fd);
      } catch {
        // The kernel releases the lock at close regardless.
      }
    }
    fs.closeSync(fd);
  }
}
