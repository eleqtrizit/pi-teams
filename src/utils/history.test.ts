import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentKind } from "./models";
import { markAgentHistoryRemoved, readAgentHistory, upsertAgentHistory } from "./history";

let tmpDir: string;
let originalTmpdir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-test-"));
  originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpDir;
});

afterEach(() => {
  process.env.TMPDIR = originalTmpdir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function record(id: string, cwd: string, startedAt: number) {
  return {
    id,
    kind: AgentKind.Lead,
    cwd,
    pid: 1234,
    startedAt,
  };
}

describe("agent history", () => {
  it("creates the file with one entry on first upsert", () => {
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 100));
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "aaaaaaaa", cwd: "/repo/a", startedAt: 100 });
    expect(fs.existsSync(path.join(tmpDir, `pi-${process.getuid()}`, "agents.jsonl"))).toBe(true);
  });

  it("keeps the file unique by agent id on update", () => {
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 100));
    upsertAgentHistory({ ...record("aaaaaaaa", "/repo/a", 100), pid: 999 });
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(999);
  });

  it("sorts entries by cwd then startedAt", () => {
    upsertAgentHistory(record("cccccccc", "/repo/b", 200));
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 300));
    upsertAgentHistory(record("bbbbbbbb", "/repo/a", 100));
    const entries = readAgentHistory();
    expect(entries.map((e) => e.id)).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
  });

  it("marks removed without deleting the entry, idempotently", () => {
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 100));
    markAgentHistoryRemoved("aaaaaaaa");
    const first = readAgentHistory();
    expect(first[0].removedAt).toBeDefined();
    markAgentHistoryRemoved("aaaaaaaa");
    expect(readAgentHistory()[0].removedAt).toBe(first[0].removedAt);
  });

  it("preserves an existing removedAt marker on later upserts", () => {
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 100));
    markAgentHistoryRemoved("aaaaaaaa");
    const removedAt = readAgentHistory()[0].removedAt;
    upsertAgentHistory({ ...record("aaaaaaaa", "/repo/a", 100), pid: 555 });
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].removedAt).toBe(removedAt);
    expect(entries[0].pid).toBe(555);
  });

  it("skips corrupt lines instead of failing", () => {
    const file = path.join(tmpDir, "agents.jsonl");
    fs.writeFileSync(file, "{not json\n");
    upsertAgentHistory(record("aaaaaaaa", "/repo/a", 100));
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("aaaaaaaa");
  });
});
