// CLAIM S2: a lock file whose recorded pid was recycled by a live, unrelated process is never reaped.
// The previous implementation reaped any lock older than 30 s regardless of pid.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "../src/utils/lock";

describe("S2 lock with recycled pid", () => {
  it("reaps a 1-hour-old lock even when its pid is alive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-lock-"));
    const target = path.join(dir, "x");
    const lockFile = `${target}.lock`;
    fs.writeFileSync(lockFile, String(process.ppid)); // live process, not a lock holder
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(lockFile, old, old);
    await expect(withLock(target, async () => "ok", 3)).resolves.toBe("ok");
  });
});
