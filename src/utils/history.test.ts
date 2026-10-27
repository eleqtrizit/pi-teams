import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentKind } from "./models";
import {
  compareHistoryEntries,
  computeHistoryKeepers,
  readAgentHistory,
  removeFromAgentHistory,
  stampOnline,
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

describe("pure history stages", () => {
  it("stamps online entries and self-heals online and surviving keys once each", () => {
    const entries = [
      { cwd: "/repo/a", startedAt: 100, lastSeenAt: 1 },
      { cwd: "/repo/b", startedAt: 200, lastSeenAt: 2 },
    ];
    const onlineRecords = [
      { cwd: "/repo/a", startedAt: 100, model: "prov/a" },
      { cwd: "/repo/c", startedAt: 300, model: "prov/c" },
    ];
    const keepRecords = [
      { cwd: "/repo/c", startedAt: 300, model: "prov/c" },
      { cwd: "/repo/d", startedAt: 400 },
    ];

    expect(stampOnline(entries, onlineRecords, keepRecords, 999)).toEqual([
      { cwd: "/repo/a", startedAt: 100, lastSeenAt: 999 },
      { cwd: "/repo/b", startedAt: 200, lastSeenAt: 2 },
      { cwd: "/repo/c", startedAt: 300, model: "prov/c", lastSeenAt: 999 },
      { cwd: "/repo/d", startedAt: 400, lastSeenAt: 400 },
    ]);
  });

  it("computes keepers from the newest survivor and the group's max recency", () => {
    const entries = [
      { cwd: "/repo/a", startedAt: 100, lastSeenAt: 900 },
      { cwd: "/repo/a", startedAt: 200, lastSeenAt: 500 },
      { cwd: "/repo/b", startedAt: 100, lastSeenAt: 100 },
      { cwd: "/repo/b", startedAt: 200, lastSeenAt: 200 },
      { cwd: "/repo/c", startedAt: 100, lastSeenAt: 100 },
      { cwd: "/repo/c", startedAt: 200, lastSeenAt: 200 },
    ];
    const result = computeHistoryKeepers(
      entries,
      [{ cwd: "/repo/b", startedAt: 100 }],
      [
        { cwd: "/repo/a", startedAt: 150 },
        { cwd: "/repo/a", startedAt: 250, model: "prov/a" },
        { cwd: "/repo/b", startedAt: 300 },
        { cwd: "/repo/c", startedAt: 300 },
      ],
      (entry) => entry.cwd === "/repo/c" && entry.startedAt === 200,
    );

    expect([...result.values()]).toEqual([
      { cwd: "/repo/a", startedAt: 250, model: "prov/a", lastSeenAt: 900 },
    ]);
  });

  it("compares history by cwd then startedAt", () => {
    const entries = [
      { cwd: "/repo/b", startedAt: 100, lastSeenAt: 1 },
      { cwd: "/repo/a", startedAt: 200, lastSeenAt: 1 },
      { cwd: "/repo/a", startedAt: 100, lastSeenAt: 1 },
    ];

    expect([...entries].sort(compareHistoryEntries).map(({ cwd, startedAt }) => [cwd, startedAt])).toEqual([
      ["/repo/a", 100],
      ["/repo/a", 200],
      ["/repo/b", 100],
    ]);
  });
});

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
        allRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 300, model: "prov/model" },
        ],
        keepRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 300 },
        ],
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
          allRecords: [
            { cwd: dirA, startedAt: 100 },
            { cwd: dirB, startedAt: 200 },
          ],
          keepRecords: [
            { cwd: dirA, startedAt: 100 },
            { cwd: dirB, startedAt: 200 },
          ],
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
        allRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
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
        snapshotTime: 2000, // after every fixture lastSeenAt: none is concurrent
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 100 }, { cwd: dirA, startedAt: 200, model: "prov/model" }],
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
        allRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 200 },
        ],
        keepRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 200 },
        ],
      });

      expect(readAgentHistory()).toHaveLength(2);
    });

    it("keeps a pruned record's entry for its pass, then drops it when no record backs it", () => {
      const dirA = liveCwd("a");
      const dirB = liveCwd("b");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 7 }, // shares key with a survivor
        { cwd: dirB, startedAt: 100, lastSeenAt: 8 }, // sole owner, pruned
      ]);

      // Pass one: both records are still in the registry snapshot (dirB is
      // pruned by it), so both entries survive the pruning pass.
      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirB, startedAt: 100 },
        ],
        keepRecords: [{ cwd: dirA, startedAt: 100 }], // same-ms sibling
      });

      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 7 },
        { cwd: dirB, startedAt: 100, lastSeenAt: 8 },
      ]);

      // Pass two: no record matches the dirB entry anymore, so it drops as
      // an orphan while the survivor-backed entry stays.
      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
      });

      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 100, lastSeenAt: 7 }]);
    });

    it("does not compact a cwd containing a post-snapshot entry", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirA, startedAt: 900, lastSeenAt: 900 }, // registered during the probe
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
      });

      // The post-snapshot entry blocks compaction of its cwd, and nothing
      // is dropped: both entries survive untouched.
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirA, startedAt: 900, lastSeenAt: 900 },
      ]);
    });

    it("does not drop a removed record's entry that is post-snapshot", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 900, lastSeenAt: 900 }, // written during the probe
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 900 }],
        keepRecords: [],
      });

      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 900, lastSeenAt: 900 }]);
    });

    it("does not collapse an entry written after the snapshot with startedAt before it", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 }, // old offline record
        // Registered mid-probe: startedAt was stamped at session start,
        // before the snapshot read, but the history write (and therefore
        // lastSeenAt) landed after it.
        { cwd: dirA, startedAt: 300, lastSeenAt: 600 },
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
      });

      // The startedAt-based guard alone would collapse this cwd; the
      // lastSeenAt guard must keep both entries.
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 1 },
        { cwd: dirA, startedAt: 300, lastSeenAt: 600 },
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

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 100 }],
        keepRecords: [{ cwd: dirA, startedAt: 100 }],
      });

      expect(readAgentHistory()).toEqual([{ cwd: dirA, startedAt: 100, lastSeenAt: 1 }]);
    });

    it("drops a legacy orphan entry in a cwd that has an online lead", () => {
      const dirC = liveCwd("c");
      writeLines(agentHistoryPath(), [
        { cwd: dirC, startedAt: 250, lastSeenAt: 5 }, // no record ever backs this entry
        { cwd: dirC, startedAt: 300, lastSeenAt: 9 },
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [{ cwd: dirC, startedAt: 300 }],
        allRecords: [{ cwd: dirC, startedAt: 300 }],
        keepRecords: [{ cwd: dirC, startedAt: 300 }],
      });

      // The orphan dies even though its cwd never compacts: the online
      // lead's entry is stamped and the stale entry matches no record.
      expect(readAgentHistory()).toEqual([
        { cwd: dirC, startedAt: 300, lastSeenAt: expect.any(Number) },
      ]);
    });

    it("emits the keeper for an offline cwd whose surviving record has no entry", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 55 }, // pruned this pass
        { cwd: dirA, startedAt: 200, lastSeenAt: 400 }, // pruned this pass
      ]);

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 200 },
          { cwd: dirA, startedAt: 300, model: "prov/model" },
        ],
        keepRecords: [{ cwd: dirA, startedAt: 300, model: "prov/model" }],
      });

      // The survivor (300) has no history entry, so Step 1 must self-heal
      // it: the keeper is emitted rather than dropped with the pruned
      // siblings, and it inherits the pruned entries' max lastSeenAt.
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 300, model: "prov/model", lastSeenAt: 400 },
      ]);
    });

    it("folds a pruned entry's recency into the survivor after compaction is blocked", () => {
      const dirA = liveCwd("a");
      writeLines(agentHistoryPath(), [
        { cwd: dirA, startedAt: 100, lastSeenAt: 1200 }, // lead, pruned in pass one
        { cwd: dirA, startedAt: 300, lastSeenAt: 900 }, // stale survivor worker
        { cwd: dirA, startedAt: 1300, lastSeenAt: 1310 }, // session registered during the probe
      ]);

      // Pass one: the probe-registered entry (post-snapshot) blocks
      // compaction. The pruned lead's record is still in the snapshot, so
      // its entry must survive instead of dying with its record: it holds
      // the directory's recent recency.
      syncAgentHistory({
        snapshotTime: 1250,
        onlineRecords: [],
        allRecords: [
          { cwd: dirA, startedAt: 100 },
          { cwd: dirA, startedAt: 300 },
        ],
        keepRecords: [{ cwd: dirA, startedAt: 300 }],
      });

      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 100, lastSeenAt: 1200 },
        { cwd: dirA, startedAt: 300, lastSeenAt: 900 },
        { cwd: dirA, startedAt: 1300, lastSeenAt: 1310 },
      ]);

      // The probe-registered session closes: its entry is removed exactly
      // the way removeAgent removes it (no sibling shares its key).
      removeFromAgentHistory(dirA, 1300);

      // Pass two (fresh snapshot, only the worker survives): the cwd now
      // compacts, and the keeper inherits the pruned lead's 1200 recency
      // instead of the survivor's stale 900, so the directory's history
      // does not sort as if never seen.
      syncAgentHistory({
        snapshotTime: 2000,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 300 }],
        keepRecords: [{ cwd: dirA, startedAt: 300 }],
      });

      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 300, lastSeenAt: 1200 },
      ]);
    });

    it("self-heals a surviving record into an empty history file", () => {
      const dirA = liveCwd("a");

      syncAgentHistory({
        snapshotTime: 500,
        onlineRecords: [],
        allRecords: [{ cwd: dirA, startedAt: 300, model: "prov/model" }],
        keepRecords: [{ cwd: dirA, startedAt: 300, model: "prov/model" }],
      });

      // An offline record has not been seen after it started, so its
      // self-healed entry carries its start time as the recency floor.
      expect(readAgentHistory()).toEqual([
        { cwd: dirA, startedAt: 300, model: "prov/model", lastSeenAt: 300 },
      ]);
    });
  });
});
