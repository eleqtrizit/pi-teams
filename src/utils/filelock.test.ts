import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import util from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLockSkippable,
  LockHeldError,
  LockUnavailableError,
  LockUnavailableReason,
  withLockFile,
  __setNativeLockLoaderForTests,
} from "./filelock";

let tmpDir: string;
let lockPath: string;
/** Holder children still alive; killed in afterEach so a ready-wait failure never leaks one. */
let spawnedChildren: ReturnType<typeof spawn>[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filelock-test-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  __setNativeLockLoaderForTests();
  for (const child of spawnedChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  spawnedChildren = [];
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Reusable zeroed waiter for the ready-file poll; Atomics.wait never mutates it. */
const POLL_WAITER = new Int32Array(new SharedArrayBuffer(4));

/** Spawn a child that acquires the lock, signals a ready file, and sleeps. */
function spawnHolder(lockPath: string, readyFile: string, killSignal?: "SIGKILL" | "SIGSTOP") {
  const stderrFile = path.join(tmpDir, `holder-${Date.now()}.stderr`);
  const stderrFd = fs.openSync(stderrFile, "a");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");const {tryLock}=require("fs-native-extensions");
       const fd=fs.openSync(${JSON.stringify(lockPath)},"a+",0o600);
       if(!tryLock(fd)) process.exit(3);
       fs.ftruncateSync(fd,0);
       fs.writeFileSync(fd,process.pid+"\\n");
       fs.writeFileSync(${JSON.stringify(readyFile)},"1");
       setTimeout(()=>{},60000);`,
    ],
    { stdio: ["ignore", "ignore", stderrFd] },
  );
  spawnedChildren.push(child);
  // The child holds its own copy of the descriptor; the parent's side is
  // not needed after spawn and would leak through the test's lifetime.
  fs.closeSync(stderrFd);
  // Wait until the child provably holds the lock.
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(readyFile)) {
    if (Date.now() > deadline) {
      // Name the cause: a generic timeout hides a child that crashed on
      // startup (a missing addon, a bad script) behind a 10-second stall.
      const stderr = fs.readFileSync(stderrFile, "utf8").slice(-2_000);
      throw new Error(`holder child never acquired the lock; stderr tail: ${stderr}`);
    }
    Atomics.wait(POLL_WAITER, 0, 0, 10);
  }
  if (killSignal !== undefined) process.kill(child.pid as number, killSignal);
  return child;
}

describe("withLockFile", () => {
  it("runs the critical section and releases the lock", () => {
    const result = withLockFile(lockPath, () => 42);
    expect(result).toBe(42);
    // The inode is permanent: it stays behind so the flock identity of the
    // path never changes between acquisitions.
    expect(fs.existsSync(lockPath)).toBe(true);
    // The released lock is immediately acquirable again.
    expect(withLockFile(lockPath, () => "again")).toBe("again");
  });

  it("records the holder pid while held", () => {
    withLockFile(lockPath, () => {
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
    });
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(tmpDir, "a", "b", "test.lock");
    withLockFile(nested, () => undefined);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
  });

  it("never takes the lock from a live holder, regardless of file age", () => {
    withLockFile(lockPath, () => {
      // Age used to make a live holder's lock stealable; with the kernel
      // lock, content and mtime carry no authority at all.
      const past = new Date(Date.now() - 31_000);
      fs.utimesSync(lockPath, past, past);

      expect(() =>
        withLockFile(lockPath, () => "unexpected", { waitMs: 100 }),
      ).toThrow(`Lock is held by pid ${process.pid} (last recorded holder): ${lockPath}`);
    });
  });

  it("does not authorize access from file content", () => {
    // A corrupt or stale content string cannot grant or deny the lock: the
    // kernel flock is the only authority. No holder holds the flock, so the
    // acquisition succeeds whatever the file says.
    fs.writeFileSync(lockPath, "1corrupt", { mode: 0o600 });
    expect(withLockFile(lockPath, () => "ok")).toBe("ok");
  });

  it("reports another process's pid when the wait runs out", () => {
    // Hold in a real child process so the pid in the message is foreign.
    const readyFile = path.join(tmpDir, "ready");
    const child = spawnHolder(lockPath, readyFile, undefined);
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "100");
    let message = "";
    try {
      withLockFile(lockPath, () => "unexpected");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`Lock is held by pid ${child.pid} (last recorded holder): ${lockPath}`);
    expect(message).not.toContain("undefined");
  });

  it("throws at once from a try-lock when the lock is held", () => {
    const readyFile = path.join(tmpDir, "ready");
    spawnHolder(lockPath, readyFile, undefined);
    const startedAt = performance.now();
    expect(() => withLockFile(lockPath, () => "unexpected", { waitMs: 0 })).toThrow(LockHeldError);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  it("uses the default wait when the override is malformed", () => {
    // parseInt would read "50abc" as 50; Number plus an integer check rejects
    // it, so the call uses the default wait instead of a shortened one the
    // operator did not ask for.
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "50abc");
    const readyFile = path.join(tmpDir, "ready");
    spawnHolder(lockPath, readyFile, undefined);
    const startedAt = Date.now();
    expect(() => withLockFile(lockPath, () => "unexpected")).toThrow(LockHeldError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
  }, 10_000);

  it("acquires immediately once a SIGKILLed holder's descriptor closes", () => {
    const readyFile = path.join(tmpDir, "ready");
    spawnHolder(lockPath, readyFile, "SIGKILL");
    // No reap wait: the pid may linger as a zombie, which is exactly the
    // pid-reuse class of staleness. The flock releases with the descriptor,
    // so the next acquire succeeds without consulting any pid.
    const startedAt = Date.now();
    expect(withLockFile(lockPath, () => "recovered")).toBe("recovered");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps the lock exclusive while a SIGSTOPped holder stays alive", () => {
    const readyFile = path.join(tmpDir, "ready");
    const child = spawnHolder(lockPath, readyFile, "SIGSTOP");
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "150");
    const startedAt = Date.now();
    expect(() => withLockFile(lockPath, () => "unexpected")).toThrow(LockHeldError);
    // A suspended holder keeps exclusivity: the contender waits out its
    // whole limit instead of stealing.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    // Resume the suspended child; afterEach kills every survivor.
    process.kill(child.pid as number, "SIGCONT");
  });

  it("releases the kernel lock when the critical section throws", () => {
    expect(() =>
      withLockFile(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(withLockFile(lockPath, () => "acquired")).toBe("acquired");
  });

  it("classifies an unsupported filesystem as LockUnavailableError and never runs the section", () => {
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: Uint8Array | string) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    const errnos: string[] = [];
    // The adapter maps errno through libuv's uv_err_name, which renders
    // ENOLCK as "Unknown system error -N" on macOS and Linux. Only an
    // injection built with getSystemErrorName proves the classification
    // matches what the real adapter throws.
    const errnoCode = util.getSystemErrorName(-os.constants.errno.ENOLCK);
    __setNativeLockLoaderForTests(() => ({
      tryLock: () => {
        const error = new Error("lockd not running on this mount") as NodeJS.ErrnoException;
        error.code = errnoCode;
        errnos.push(error.code);
        throw error;
      },
      unlock: () => undefined,
    }));
    try {
      let sectionRan = 0;
      let caught: unknown;
      try {
        withLockFile(lockPath, () => {
          sectionRan += 1;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LockUnavailableError);
      expect((caught as LockUnavailableError).reason).toBe(
        LockUnavailableReason.FilesystemUnsupported,
      );
      // Never cached (NFS can recover) and never run unlocked.
      expect(() =>
        withLockFile(lockPath, () => {
          sectionRan += 1;
        }),
      ).toThrow(LockUnavailableError);
      expect(sectionRan).toBe(0);
      expect(errnos).toEqual([errnoCode, errnoCode]);
      // One warning for the FilesystemUnsupported reason, naming the
      // canonical errno rather than the raw libuv string.
      const locked = writes.filter((w) => w.includes("ENOLCK"));
      expect(locked).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("propagates a descriptor bug from tryLock raw instead of classifying it", () => {
    __setNativeLockLoaderForTests(() => ({
      tryLock: () => {
        const error = new Error("bad file descriptor") as NodeJS.ErrnoException;
        error.code = "EBADF";
        throw error;
      },
      unlock: () => undefined,
    }));
    let caught: unknown;
    try {
      withLockFile(lockPath, () => "never");
    } catch (error) {
      caught = error;
    }
    // Our own bugs must fail fast: not skippable, not wrapped.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe("EBADF");
    expect(caught).not.toBeInstanceOf(LockUnavailableError);
    expect(isLockSkippable(caught)).toBe(false);
  });

  it("throws LockUnavailableError and warns exactly once when the adapter cannot load", () => {
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: Uint8Array | string) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    __setNativeLockLoaderForTests(() => {
      throw new Error("no prebuilt binary for this platform");
    });
    try {
      let sectionRan = 0;
      expect(() =>
        withLockFile(lockPath, () => {
          sectionRan += 1;
        }),
      ).toThrow(LockUnavailableError);
      expect(() =>
        withLockFile(lockPath, () => {
          sectionRan += 1;
        }),
      ).toThrow(LockUnavailableError);
      // No lock, no critical section; one warning per process, not per call.
      expect(sectionRan).toBe(0);
      expect(writes.filter((w) => w.includes("fs-native-extensions"))).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns the same value from the last call when used sequentially", () => {
    const results = [1, 2, 3].map((n) => withLockFile(lockPath, () => n));
    expect(results).toEqual([1, 2, 3]);
  });

  // ── Real cross-process exclusion ────────────────────────────────────────
  // Ownership bugs only reproduce with real processes racing each other, so
  // spawn real vitest children through the dedicated test/filelock-child
  // config. The exact counter proves mutual exclusion end to end.

  const contentionTest = process.platform === "win32" ? it.skip : it;
  contentionTest(
    "serializes competing processes: every increment lands exactly once",
    async () => {
      const children = 3;
      const iterations = 150;
      const counterFile = path.join(tmpDir, "counter");
      const childLock = path.join(tmpDir, "contend.lock");
      fs.writeFileSync(counterFile, "");
      // Stale content with no lock behind it: the kernel lock ignores it
      // and the first acquirer takes the lock at once. Planting it here
      // gives this claim real contention - three children racing from the
      // same pre-planted lock - instead of a token single racer.
      fs.writeFileSync(childLock, "999999:preplanted", { mode: 0o600 });

      const vitestBin = path.join(process.cwd(), "node_modules", ".bin", "vitest");
      const childArgs = [
        vitestBin,
        "run",
        "--config",
        "test/filelock-child.config.ts",
        "test/filelock-child.test.ts",
      ];

      const procs = Array.from({ length: children }, () =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, childArgs, {
            env: {
              ...process.env,
              COUNTER_FILE: counterFile,
              LOCK_FILE: childLock,
              ITERATIONS: String(iterations),
            },
            stdio: ["ignore", "ignore", "pipe"],
          });
          // Tracked so a failed test never leaks a running child past
          // afterEach's cleanup.
          spawnedChildren.push(child);
          let stderr = "";
          child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
          child.once("error", reject);
          child.once("exit", (code) => resolve({ code, stderr }));
        }),
      );
      const results = await Promise.all(procs);
      for (const { code, stderr } of results) {
        expect(code, stderr).toBe(0);
      }

      expect(fs.readFileSync(counterFile, "utf8").trim()).toBe(String(children * iterations));
      // The lock inode persists; a later acquisition still succeeds.
      expect(fs.existsSync(childLock)).toBe(true);
    },
    120_000,
  );
});
