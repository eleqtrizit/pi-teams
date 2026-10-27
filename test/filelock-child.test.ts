/**
 * Child suite for the filelock contention test. Never loaded by the main
 * vitest config (which only includes src/ and extensions/); the parent test
 * spawns it as a separate vitest process per contender via
 * test/filelock-child.config.ts.
 *
 * Each child performs ITERATIONS locked read-increment-write cycles on the
 * shared counter file named by COUNTER_FILE, serializing with the real
 * withLockFile on LOCK_FILE. With the lock working, the sum of every child's
 * increments is exact; a lost update loses count.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { withLockFile } from "../src/utils/filelock";

const counterFile = process.env.COUNTER_FILE ?? "";
const lockFile = process.env.LOCK_FILE ?? "";
const iterations = Number(process.env.ITERATIONS ?? "0");

function readCounter(): number {
  const raw = fs.readFileSync(counterFile, "utf8").trim();
  return raw === "" ? 0 : Number(raw);
}

describe("filelock contention child", () => {
  it("increments the shared counter under the lock", () => {
    expect(counterFile).not.toBe("");
    expect(lockFile).not.toBe("");
    expect(iterations).toBeGreaterThan(0);

    for (let i = 0; i < iterations; i++) {
      withLockFile(lockFile, () => {
        const value = readCounter();
        fs.writeFileSync(counterFile, String(value + 1));
        return value;
      });
    }
  });
});
