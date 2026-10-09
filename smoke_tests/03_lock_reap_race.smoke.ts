// CLAIM S3: two waiters that see the same dead-pid lock can both enter the critical section.
// reapStaleLock does stat -> read pid -> rename; the rename is not conditional on the file still being the stale one.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHILD = path.resolve(__dirname, "helpers/lock_child.ts");
const WAITERS = 10;
const ROUNDS = 25;

function runRound(dir: string, out: string): Promise<void> {
  const target = path.join(dir, "x");
  fs.writeFileSync(`${target}.lock`, "999999999"); // dead pid
  const barrier = Date.now() + 700;
  const kids = Array.from({ length: WAITERS }, () =>
    new Promise<void>((res) => {
      const c = spawn(process.execPath, [CHILD, target, String(barrier), out], { stdio: "inherit" });
      c.on("exit", () => res());
    }),
  );
  return Promise.all(kids).then(() => undefined);
}

describe("S3 stale-lock reap race", () => {
  it("never lets two holders overlap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-race-"));
    const out = path.join(dir, "violations.txt");
    for (let i = 0; i < ROUNDS; i++) await runRound(dir, out);
    const v = fs.existsSync(out) ? fs.readFileSync(out, "utf-8").trim().split("\n").length : 0;
    console.log("violations:", v, "over", ROUNDS, "rounds x", WAITERS, "waiters");
    expect(v).toBe(0);
  }, 120000);
});
