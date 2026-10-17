import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentIdStatePath } from "./paths";
import { BUSY_STALE_MS, isAgentBusy, removeRunState, writeRunState } from "./runstate";

let tmpDir: string;
let originalTmpdir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runstate-test-"));
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
});

afterEach(() => {
  process.env.TMPDIR = originalTmpdir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("run state", () => {
  it("reports busy after a busy write", () => {
    writeRunState("aaaaaaaa", true);
    expect(isAgentBusy("aaaaaaaa")).toBe(true);
    expect(fs.existsSync(agentIdStatePath("aaaaaaaa"))).toBe(true);
  });

  it("reports not busy after a settle write", () => {
    writeRunState("aaaaaaaa", true);
    writeRunState("aaaaaaaa", false);
    expect(isAgentBusy("aaaaaaaa")).toBe(false);
  });

  it("reports not busy when no state file exists", () => {
    expect(isAgentBusy("aaaaaaaa")).toBe(false);
  });

  it("expires a stale busy state", () => {
    writeRunState("aaaaaaaa", true);
    const file = agentIdStatePath("aaaaaaaa");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.since = Date.now() - BUSY_STALE_MS - 1000;
    fs.writeFileSync(file, JSON.stringify(state));
    expect(isAgentBusy("aaaaaaaa")).toBe(false);
  });

  it("removes the state file idempotently", () => {
    writeRunState("aaaaaaaa", true);
    removeRunState("aaaaaaaa");
    expect(fs.existsSync(agentIdStatePath("aaaaaaaa"))).toBe(false);
    expect(() => removeRunState("aaaaaaaa")).not.toThrow();
  });

  it("treats a corrupt state file as not busy", () => {
    fs.mkdirSync(path.join(tmpDir, `pi-${process.getuid()}`, "state"), { recursive: true });
    fs.writeFileSync(agentIdStatePath("aaaaaaaa"), "{not json");
    expect(isAgentBusy("aaaaaaaa")).toBe(false);
  });
});
