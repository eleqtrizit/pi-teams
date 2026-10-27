import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLockFile } from "./filelock";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filelock-test-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Backdate a lock file so it counts as past the steal timeout. */
function ageLock(lockPath: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, past, past);
}

describe("withLockFile", () => {
  it("runs the critical section and releases the lock", () => {
    const result = withLockFile(lockPath, () => 42);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("records the holder pid in the lock while held", () => {
    withLockFile(lockPath, () => {
      expect(fs.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
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
    fs.writeFileSync(lockPath, String(pid), { mode: 0o600 });

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("steals a fresh lock only after the steal timeout, using the file's age", () => {
    // Held by a live pid (ourselves), but backdated past the timeout.
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
    ageLock(lockPath, 3_000);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("steals an old unreadable lock", () => {
    fs.writeFileSync(lockPath, "not-a-pid", { mode: 0o600 });
    ageLock(lockPath, 3_000);

    const result = withLockFile(lockPath, () => "ok");
    expect(result).toBe("ok");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not delete a lock that was stolen from us mid-critical-section", () => {
    withLockFile(lockPath, () => {
      // Simulate a steal: the file no longer carries our pid.
      fs.writeFileSync(lockPath, String(424242), { mode: 0o600 });
    });
    // Our release saw a foreign holder and left the file alone.
    expect(fs.readFileSync(lockPath, "utf8").trim()).toBe("424242");
    fs.rmSync(lockPath, { force: true });
  });

  it("returns the same value from the last call when used sequentially", () => {
    const results = [1, 2, 3].map((n) => withLockFile(lockPath, () => n));
    expect(results).toEqual([1, 2, 3]);
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
});
