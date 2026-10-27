import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentKind } from "./models";
import {
  readAgentHistory,
  removeFromAgentHistory,
  syncAgentHistory,
  upsertAgentHistory,
} from "./history";
import { agentHistoryPath } from "./paths";

let tmpDir: string;
let originalRegistryDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-test-"));
  originalRegistryDir = process.env.PI_TEAMS_REGISTRY_DIR;
  process.env.PI_TEAMS_REGISTRY_DIR = tmpDir;
});

afterEach(() => {
  process.env.PI_TEAMS_REGISTRY_DIR = originalRegistryDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function record(cwd: string, startedAt: number, model?: string) {
  return {
    id: "aaaaaaaa",
    kind: AgentKind.Lead,
    cwd,
    pid: 1234,
    startedAt,
    model,
  };
}

describe("agent history", () => {
  it("creates the file with one entry on first upsert, keeping model", () => {
    upsertAgentHistory(record("/repo/a", 100, "prov/model"));
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      cwd: "/repo/a",
      startedAt: 100,
      model: "prov/model",
      lastSeenAt: expect.any(Number),
    });
    expect(fs.existsSync(path.join(tmpDir, "agents.jsonl"))).toBe(true);
  });

  it("omits model when the record does not carry one", () => {
    upsertAgentHistory(record("/repo/a", 100));
    expect(readAgentHistory()[0]).not.toHaveProperty("model");
  });

  it("keeps one entry per (cwd, startedAt) key on re-upsert", () => {
    upsertAgentHistory(record("/repo/a", 100, "prov/model"));
    upsertAgentHistory(record("/repo/a", 100, "prov/model-2"));
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].model).toBe("prov/model-2");
  });

  it("keeps separate entries for different startedAt in the same cwd", () => {
    upsertAgentHistory(record("/repo/a", 100));
    upsertAgentHistory(record("/repo/a", 200));
    expect(readAgentHistory()).toHaveLength(2);
  });

  it("sorts entries by cwd then startedAt", () => {
    upsertAgentHistory(record("/repo/b", 200));
    upsertAgentHistory(record("/repo/a", 300));
    upsertAgentHistory(record("/repo/a", 100));
    const entries = readAgentHistory();
    expect(entries.map((e) => e.startedAt)).toEqual([100, 300, 200]);
  });

  it("drops extra fields from entries written by older versions on load", () => {
    fs.writeFileSync(
      agentHistoryPath(),
      JSON.stringify({
        id: "aaaaaaaa",
        kind: "lead",
        cwd: "/repo/a",
        pid: 1,
        startedAt: 100,
        lastSeenAt: 42,
        removedAt: 43,
      }) + "\n",
      { mode: 0o600 },
    );
    expect(readAgentHistory()).toEqual([
      { cwd: "/repo/a", startedAt: 100, lastSeenAt: 42 },
    ]);
  });

  it("skips corrupt lines instead of failing", () => {
    const file = path.join(tmpDir, "agents.jsonl");
    fs.writeFileSync(file, "{not json\n");
    upsertAgentHistory(record("/repo/a", 100));
    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].cwd).toBe("/repo/a");
  });

  it("skips null lines, unparseable numbers, and infinite startedAt values", () => {
    fs.writeFileSync(
      agentHistoryPath(),
      [
        "null",
        '{"cwd":"/repo/a","startedAt":NaN}',
        '{"cwd":"/repo/a","startedAt":1e999}',
        "{not json",
        '{"cwd":"/repo/a","startedAt":100,"lastSeenAt":5}',
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    expect(readAgentHistory()).toEqual([{ cwd: "/repo/a", startedAt: 100, lastSeenAt: 5 }]);
  });

  it("falls back to startedAt when a line carries no usable lastSeenAt", () => {
    fs.writeFileSync(
      agentHistoryPath(),
      JSON.stringify({ cwd: "/repo/a", startedAt: 777, lastSeenAt: null }) + "\n",
      { mode: 0o600 },
    );
    expect(readAgentHistory()).toEqual([{ cwd: "/repo/a", startedAt: 777, lastSeenAt: 777 }]);
  });

  it("removes the entry that matches the key, no-op for the rest", () => {
    upsertAgentHistory(record(tmpDir + "/x", 100));
    upsertAgentHistory(record(tmpDir + "/y", 200));

    removeFromAgentHistory(tmpDir + "/x", 100);
    removeFromAgentHistory(tmpDir + "/zzz", 999);

    const entries = readAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].startedAt).toBe(200);
  });

  describe("syncAgentHistory", () => {
    /** A real scratch cwd: syncAgentHistory drops entries whose cwd is gone. */
    function liveCwd(name: string): string {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }

    function writeLines(pathName: string, entries: unknown[]): void {
      fs.writeFileSync(pathName, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", {
        mode: 0o600,
      });
    }

    it("stamps online keys and self-heals a missing entry for an online record", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [{ cwd: dirA, startedAt: 100, lastSeenAt: 1 }]);

      // The online record has no entry: sync must create (self-heal) it.
      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [{ cwd: dirA, startedAt: 300, model: "prov/model" }],
        removedRecords: [],
        keepRecords: [{ cwd: dirA, startedAt: 300 }],
      });

      const entries = readAgentHistory();
      expect(entries).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 }, // left alone: not an online record
        { cwd: dirA, startedAt: 300, model: "prov/model", lastSeenAt: expect.any(Number) },
      ]);
    });

    it("stamps only the online key, leaving other entries alone", () => {
      const dirA = liveCwd("a");
      const dirB = liveCwd("b");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirB, startedAt: 200, lastSeenAt: 2 },
      ]);

      const clock = vi.spyOn(Date, "now").mockReturnValue(9999);
      try {
        syncAgentHistory({
          snapshotTime: 500,
          onlineRecords: [{ cwd: dirA, startedAt: 100 }],
          removedRecords: [],
          keepRecords: [{ cwd: dirA, startedAt: 100 }],
        });
      } finally {
        clock.mockRestore();
      }

      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 9999 },
        { cwd: dirB, startedAt: 200, lastSeenAt: 2 },
      ]);
    });

    it("writes nothing when the sync is a no-op", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [{ cwd: dirA, startedAt: 100, lastSeenAt: 1 }]);
      const before = fs.statSync(agentHistoryPath()).mtimeMs;

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        removedRecords: [{ cwd: dirA, startedAt: 404 }], // no such entry
        keepRecords: [],
      });

      expect(fs.statSync(agentHistoryPath()).mtimeMs).toBe(before);
    });

    it("collapses an all-offline cwd to the newest keep record, preserving max lastSeenAt", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1000 }, // pruned older lead
        { cwd: dirA, startedAt: 200, lastSeenAt: 500 },
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        removedRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 200, model: "prov/model" }],
      });

      // The keeper is keyed to the survivor but keeps the pruned entry's
      // recency: the directory does not look stale because its older lead
      // was pruned.
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 200, model: "prov/model", lastSeenAt: 1000 },
      ]);
    });

    it("leaves cwds with an online record uncollapsed", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 900 },
        { cwd: dirA, startedAt: 200, lastSeenAt: 300 },
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [{ cwd: dirA, startedAt: 100 }],
        removedRecords: [],
        keepRecords: [{ cwd: dirA, startedAt: 100 }, { cwd: dirA, startedAt: 200 }],
      });

      expect(readAgentHistory()).toHaveLength(2);
    });

    it("drops a pruned record's entry unless a surviving record shares its key", () => {
      const dirA = liveCwd("a");
      const dirB = liveCwd("b");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 7 }, // shares key with a survivor
        { cwd: dirB, startedAt: 100, lastSeenAt: 8 }, // sole owner, pruned
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        removedRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirB, startedAt: 100 },
        ],
        keepRecords: [{ cwd: dirA, startedAt: 100 }], // same-ms sibling
      });

      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 100, lastSeenAt: 7 }]);
    });

    it("never touches entries started after the snapshot time", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 }, // old offline lead
        { cwd: dirA, startedAt: 900, lastSeenAt: 2 }, // registered during the probe
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        removedRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
      });

      // The fresh entry blocks compaction of its cwd, and the old entry is
      // not dropped either: the rebuild keeps both untouched... except the
      // orphan check, which does not apply (dirA exists).
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirA, startedAt: 900, lastSeenAt: 2 },
      ]);
    });

    it("drops entries whose cwd directory no longer exists", () => {
      const dirA = liveCwd("a");
      const dirB = liveCwd("b");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirB, startedAt: 200, lastSeenAt: 2 },
      ]);
      fs.rmSync(dirB, { recursive: true, force: true });

      syncAgentHistory({ snapshotTime: 500, onlineRecords: [], removedRecords: [], keepRecords: [] });

      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 100, lastSeenAt: 1 }]);
    });
  });
});
