import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockHeldError, withLockFile } from "./filelock";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filelock-test-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Backdate a lock file to test whether elapsed time alone affects ownership. */
function ageLock(lockPath: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, past, past);
}

/** Plant a lock file with the given content and optional age. */
function plantLock(lockPath: string, content: string, ageMs = 0): void {
  fs.writeFileSync(lockPath, content, { mode: 0o600 });
  if (ageMs > 0) ageLock(lockPath, ageMs);
}

describe("withLockFile", () => {
  it("runs the critical section and releases the lock", () => {
    const result = withLockFile(lockPath, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("records the holder pid and nonce while held", () => {
    withLockFile(lockPath, () => {
      const [pid, nonce] = fs.readFileSync(lockPath, "utf8").split(":");
      expect(pid).toBe(String(process.pid));
      expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(tmpDir, "a", "b", "test.lock");
    withLockFile(nested, () => undefined);
    expect(fs.existsSync(nested)).toBe(false); // released, but the dir was made
    expect(fs.existsSync(path.dirname(nested))).toBe(true);
  });

  it("steals a lock held by a dead pid", async () => {
    // Spawn and fully reap a child, so its pid is provably gone. A killed
    // but unreaped child stays a zombie, and zombies still answer kill(0).
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid as number;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    plantLock(lockPath, `${pid}:deadbeef`);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not steal a live holder's lock younger than the cap", () => {
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "100");
    plantLock(lockPath, `${process.pid}:aaaa`, 3_000);

    expect(() => withLockFile(lockPath, () => "unexpected")).toThrow(
      `Lock is held by live pid ${process.pid}: ${lockPath}`,
    );
  });

  it("steals a live holder's lock older than the cap", () => {
    // A lock older than the cap is leaked: release was skipped, so no active
    // holder exists even though the pid is still alive.
    plantLock(lockPath, `${process.pid}:aaaa`, 31_000);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("steals an old unreadable lock after the timeout", () => {
    // A corrupt pid file is untrusted content, not a live holder: the
    // timeout steals it so waiters always make progress.
    plantLock(lockPath, "not-a-pid", 3_000);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not steal a fresh unreadable lock before the timeout", () => {
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "100");
    plantLock(lockPath, "not-a-pid");

    expect(() => withLockFile(lockPath, () => "unexpected")).toThrow(
      `Lock is held by an unknown holder: ${lockPath}`,
    );
  });

  it("uses the default wait when the override is malformed", () => {
    // parseInt would read "50abc" as 50; Number plus an integer check rejects
    // it, so the call uses the default wait instead of a shortened one the
    // operator did not ask for.
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "50abc");
    plantLock(lockPath, `${process.pid}:held`);

    const startedAt = Date.now();
    expect(() => withLockFile(lockPath, () => "unexpected")).toThrow(LockHeldError);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
    fs.rmSync(lockPath, { force: true });
  });

  it("does not delete a lock that was stolen from us mid-critical-section", () => {
    withLockFile(lockPath, () => {
      // Simulate a steal: the file no longer carries our nonce.
      fs.writeFileSync(lockPath, "424242:someoneelse", { mode: 0o600 });
    });
    // Our release saw a foreign nonce and left the file alone.
    expect(fs.readFileSync(lockPath, "utf8")).toBe("424242:someoneelse");
    fs.rmSync(lockPath, { force: true });
  });

  it("returns the same value from the last call when used sequentially", () => {
    const results = [1, 2, 3].map((n) => withLockFile(lockPath, () => n));
    expect(results).toEqual([1, 2, 3]);
  });

  // ── Deterministic interleavings ─────────────────────────────────────────
  // The steal protocol must survive a successor appearing between inspection
  // and replacement, and two stealers racing the same stale lock. Both are
  // unschedulable from the outside, so the LockHooks seam fires the successor
  // or the second stealer at the exact syscall boundary.

  it("aborts the steal when a fresh holder appears before the rename", () => {
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "120");
    plantLock(lockPath, "not-a-pid", 3_000);
    const freshContent = `${process.pid}:freshholder`;
    let criticalRuns = 0;
    let injected = false;

    expect(() =>
      withLockFile(
        lockPath,
        () => {
          criticalRuns += 1;
        },
        {
          afterStaleInspection: () => {
            if (injected) return;
            injected = true;
            // A successor acquires and holds the lock after our inspection.
            fs.writeFileSync(lockPath, freshContent, { mode: 0o600 });
          },
        },
      ),
    ).toThrow(`Lock is held by live pid ${process.pid}: ${lockPath}`);

    // The stealer re-verified under the claim, saw the live successor, and
    // never entered the critical section or clobbered the fresh lock.
    expect(criticalRuns).toBe(0);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(freshContent);
    fs.rmSync(lockPath, { force: true });
  });

  it("keeps the lock path present and unacquirable through a steal", () => {
    plantLock(lockPath, "not-a-pid", 3_000);
    const present: boolean[] = [];

    withLockFile(
      lockPath,
      () => {
        present.push(fs.existsSync(lockPath));
      },
      {
        afterStaleInspection: () => present.push(fs.existsSync(lockPath)),
        beforeStealRename: () => {
          present.push(fs.existsSync(lockPath));
          // The reviewer's reproduction: a third process must not be able to
          // link its own lock while a takeover is in flight. The path still
          // exists, so the link fails and no third holder enters.
          const probe = `${lockPath}.probe`;
          fs.writeFileSync(probe, `${process.pid}:probe`, { mode: 0o600 });
          expect(() => fs.linkSync(probe, lockPath)).toThrow(/EEXIST/);
          fs.rmSync(probe, { force: true });
        },
      },
    );

    // Inspected, re-verified, and held: the path is present at every step, so
    // no successor can link its own lock during a takeover.
    expect(present).toEqual([true, true, true]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("lets only one stealer take over a stale lock at a time", () => {
    vi.stubEnv("PI_TEAMS_LOCK_WAIT_TIMEOUT_MS", "120");
    plantLock(lockPath, "not-a-pid", 3_000);
    const runs: string[] = [];
    let nested = false;

    const result = withLockFile(
      lockPath,
      () => {
        runs.push("A");
        return "A";
      },
      {
        beforeStealRename: () => {
          if (nested) return;
          nested = true;
          // A holds the exclusive claim here. A second stealer must see the
          // live claim and wait out its own limit instead of stealing.
          expect(() =>
            withLockFile(lockPath, () => {
              runs.push("B");
              return "B";
            }),
          ).toThrow(LockHeldError);
        },
      },
    );

    expect(result).toBe("A");
    expect(runs).toEqual(["A"]);
  });

  it("reclaims a steal claim left behind by a dead claimer", () => {
    plantLock(lockPath, "not-a-pid", 3_000);
    // A stealer died after creating its claim; the unparseable claim target
    // has no live owner, so the next stealer reclaims it and proceeds.
    fs.symlinkSync("not-a-pid", `${lockPath}.steal`);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.steal`)).toBe(false);
  });

  // The lock's ownership bugs (stolen-release deletion, stale-steal TOCTOU)
  // only reproduce with real processes racing each other, so spawn real
  // vitest children through the dedicated test/filelock-child config.
  const contentionTest = process.platform === "win32" ? it.skip : it;
  contentionTest(
    "serializes competing processes: every increment lands exactly once",
    async () => {
      const children = 3;
      const iterations = 150;
      const counterFile = path.join(tmpDir, "counter");
      const childLock = path.join(tmpDir, "contend.lock");
      fs.writeFileSync(counterFile, "");

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
          let stderr = "";
          child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
          child.once("error", reject);
          child.once("exit", (code) => resolve({ code, stderr }));
        }),
      );
      const results = await Promise.all(procs);
      for (const { code } of results) {
        expect(code).toBe(0);
      }

      expect(fs.readFileSync(counterFile, "utf8").trim()).toBe(
        String(children * iterations),
      );
      expect(fs.existsSync(childLock)).toBe(false);
    },
    120_000,
  );

  // Pre-planted dead-pid takeover. A true interleaving (a steal landing
  // between one contender's inspection and replacement) is not schedulable
  // from the outside; that path is covered deterministically above through the
  // LockHooks seam. This test fixes the ordering instead: a dead-pid lock is
  // planted, then a racer child and the parent contend for it. Exactly one
  // steals the dead lock; the other waits on the now-live holder. The exact
  // counter proves mutual exclusion end to end across real processes.
  contentionTest(
    "steals a pre-planted dead-pid lock while a racer contends",
    async () => {
      const iterations = 50;
      const counterFile = path.join(tmpDir, "counter");
      const takeoverLock = path.join(tmpDir, "takeover.lock");
      fs.writeFileSync(counterFile, "");

      // Spawn and fully reap a child, so its pid is provably dead.
      const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
      plantLock(takeoverLock, `${dead.pid}:deadbeef`);

      const vitestBin = path.join(process.cwd(), "node_modules", ".bin", "vitest");
      const childArgs = [
        vitestBin,
        "run",
        "--config",
        "test/filelock-child.config.ts",
        "test/filelock-child.test.ts",
      ];
      const racer = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, childArgs, {
          env: {
            ...process.env,
            COUNTER_FILE: counterFile,
            LOCK_FILE: takeoverLock,
            ITERATIONS: String(iterations),
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, stderr }));
      });

      const parent = (async () => {
        for (let i = 0; i < iterations; i++) {
          withLockFile(takeoverLock, () => {
            const value = Number(fs.readFileSync(counterFile, "utf8").trim() || "0");
            fs.writeFileSync(counterFile, String(value + 1));
          });
        }
      })();

      const [racerResult] = await Promise.all([racer, parent]);
      expect(racerResult.code).toBe(0);

      expect(fs.readFileSync(counterFile, "utf8").trim()).toBe(String(2 * iterations));
      expect(fs.existsSync(takeoverLock)).toBe(false);
    },
    120_000,
  );
});
