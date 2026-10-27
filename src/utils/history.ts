import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentRecord } from "./models";
import { agentHistoryLockPath, agentHistoryPath, registryDir } from "./paths";
import { ensurePrivateDir } from "./transport";
import { withLockFile } from "./filelock";

/**
 * `lastSeenAt` side table for registered agent records, keyed by
 * `(cwd, startedAt)` instead of the ephemeral agent id.
 *
 * Every mutation runs under the cross-process lock file next to
 * `agents.jsonl`, so two pi sessions can never lose each other's writes.
 * An entry exists only while its record file exists: registration creates
 * it, `list_agents` refreshes `lastSeenAt` for online records and
 * self-heals missing entries for surviving records, the list pass drops
 * entries whose record no longer exists in the registry, and record
 * removal deletes it. Cwds whose records are all offline are compacted to
 * a single entry by the list pass. `model` is kept for future
 * load-distribution use.
 */
export interface AgentHistoryEntry {
  cwd: string;
  startedAt: number;
  model?: string;
  /** Timestamp of the last history write for this record. */
  lastSeenAt: number;
}

/**
 * Stable join key shared by the history readers and writers.
 *
 * Paths may contain `\n`, but a cwd's final numeric component (`startedAt`,
 * serialized by JSON) cannot, so `(cwd, startedAt)` pairs never collide on
 * the concatenated key.
 */
export function historyKey(cwd: string, startedAt: number): string {
  return `${cwd}\n${startedAt}`;
}

/** Read every valid history entry, skipping blank or unparseable lines. */
function readHistoryEntries(): AgentHistoryEntry[] {
  const file = agentHistoryPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const entries: AgentHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    // Number.isFinite rejects NaN and Infinity, which JSON.stringify would
    // otherwise round-trip as null and poison Math operations downstream.
    if (typeof rec.cwd !== "string" || !Number.isFinite(rec.startedAt)) continue;
    const startedAt = rec.startedAt as number;
    entries.push({
      cwd: rec.cwd,
      startedAt,
      ...(typeof rec.model === "string" && { model: rec.model }),
      lastSeenAt:
        typeof rec.lastSeenAt === "number" && Number.isFinite(rec.lastSeenAt)
          ? rec.lastSeenAt
          : startedAt, // a session was never online before it started
    });
  }
  return entries;
}

/**
 * Write history entries atomically, one JSON line per entry.
 *
 * Sorts by cwd, then startedAt, so the file reads as an index of where and
 * when each agent ran. Writes to a temp file in the same directory and
 * renames it into place, matching the registry's atomic-write pattern.
 *
 * @param entries - Deduplicated entries to persist
 */
export function compareHistoryEntries(a: AgentHistoryEntry, b: AgentHistoryEntry): number {
  return a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt;
}

function writeHistoryEntries(entries: AgentHistoryEntry[]): void {
  ensurePrivateDir(registryDir());
  const sorted = [...entries].sort(compareHistoryEntries);
  const body = sorted.map((entry) => JSON.stringify(entry)).join("\n") + (sorted.length ? "\n" : "");

  const file = agentHistoryPath();
  const tmp = path.join(
    path.dirname(file),
    `.tmp-agents-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jsonl`,
  );
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Run one read-modify-write cycle under the cross-process lock.
 *
 * `apply` receives the current entries and returns the next entries, or
 * null to leave the file untouched (no write, preserved mtime). The read
 * happens inside the lock, so a concurrent session's write can never be
 * lost to a stale read.
 */
function mutateEntries(
  apply: (entries: AgentHistoryEntry[]) => AgentHistoryEntry[] | null,
): void {
  ensurePrivateDir(registryDir());
  withLockFile(agentHistoryLockPath(), () => {
    const next = apply(readHistoryEntries());
    if (next !== null) writeHistoryEntries(next);
  });
}

/**
 * Read every valid history entry from agents.jsonl.
 *
 * Corrupt or blank lines are skipped, so a truncated write or a hand-edited
 * file never breaks the readers. Entries written by older versions carry
 * extra fields, which are dropped on read.
 *
 * @returns History entries in file order (sorted by cwd, startedAt)
 */
export function readAgentHistory(): AgentHistoryEntry[] {
  return readHistoryEntries();
}

/**
 * Create or refresh the history entry for one agent record, keyed by
 * `(cwd, startedAt)`. Agents that share a cwd and started timestamp merge
 * into one entry, which is harmless: same-cwd records share recency.
 *
 * @param rec - Agent record to record in the history
 */
export function upsertAgentHistory(rec: AgentRecord): void {
  const key = historyKey(rec.cwd, rec.startedAt);
  mutateEntries((entries) => {
    const others = entries.filter((e) => historyKey(e.cwd, e.startedAt) !== key);
    others.push({
      cwd: rec.cwd,
      startedAt: rec.startedAt,
      ...(rec.model !== undefined && { model: rec.model }),
      lastSeenAt: Date.now(),
    });
    return others;
  });
}

/**
 * Delete the history entry of a record that was shut down.
 *
 * No-op when no entry matches, so callers do not need to check first. The
 * list pass removes pruned entries through {@link syncAgentHistory} instead,
 * which preserves the directory's recency; this path is for `removeAgent`
 * (a closed worker or lead), where the caller has already checked that no
 * surviving sibling shares the key.
 *
 * @param cwd - Working directory of the removed record
 * @param startedAt - Start timestamp of the removed record
 */
export function removeFromAgentHistory(cwd: string, startedAt: number): void {
  const key = historyKey(cwd, startedAt);
  mutateEntries((entries) => {
    const kept = entries.filter((e) => historyKey(e.cwd, e.startedAt) !== key);
    return kept.length !== entries.length ? kept : null;
  });
}

/**
 * Delete the history entries of several records in one locked pass.
 *
 * Unlike {@link removeFromAgentHistory}, which the shutdown path calls per
 * record, this is the batch form for the registry's trim pass: N stale
 * records cost one history transaction, not N. Callers must hold the
 * surviving records' keys themselves: the trim pass removes only records
 * whose cwd is gone from disk, so no surviving record shares a removed key.
 *
 * @param records - Key fields of the records whose entries to delete
 */
export function removeHistoryEntries(records: ReadonlyArray<HistoryRecordKey>): void {
  const keys = new Set(records.map((rec) => historyKey(rec.cwd, rec.startedAt)));
  if (keys.size === 0) return;
  mutateEntries((entries) => {
    const kept = entries.filter((e) => !keys.has(historyKey(e.cwd, e.startedAt)));
    return kept.length !== entries.length ? kept : null;
  });
}

/** One record's history identity, the three fields the side table tracks. */
export type HistoryRecordKey = Pick<AgentRecord, "cwd" | "startedAt" | "model">;

/**
 * One list-pass sync of the history side table, computed from a single
 * probed snapshot.
 *
 * All steps run as one read-modify-write cycle under the lock, so the file
 * is written at most once per pass and no step observes another step's
 * half-finished state.
 */
export interface HistorySyncInput {
  /** Records the probe found online: their entries get `lastSeenAt = now`. */
  onlineRecords: ReadonlyArray<HistoryRecordKey>;
  /**
   * Every record in the probed snapshot: online, kept, and removed. An
   * entry that is not concurrent and matches none of them has no record
   * file anymore, so Step 3 drops it instead of orphaning it forever.
   */
  allRecords: ReadonlyArray<HistoryRecordKey>;
  /** Records that survive the prune: they key the compaction keepers. */
  keepRecords: ReadonlyArray<HistoryRecordKey>;
  /** Epoch ms at which the snapshot was read. See the guard notes below. */
  snapshotTime: number;
}

/** Group entries by cwd, preserving first-seen order inside each group. */
function groupByCwd(
  entries: ReadonlyArray<AgentHistoryEntry>,
): Map<string, AgentHistoryEntry[]> {
  const byCwd = new Map<string, AgentHistoryEntry[]>();
  for (const entry of entries) {
    const group = byCwd.get(entry.cwd);
    if (group) group.push(entry);
    else byCwd.set(entry.cwd, [entry]);
  }
  return byCwd;
}

/** Stamp online entries and self-heal missing online and surviving keys. */
export function stampOnline(
  entries: ReadonlyArray<AgentHistoryEntry>,
  onlineRecords: ReadonlyArray<HistoryRecordKey>,
  keepRecords: ReadonlyArray<HistoryRecordKey>,
  now: number,
): AgentHistoryEntry[] {
  const keyOf = (entry: { cwd: string; startedAt: number }): string =>
    historyKey(entry.cwd, entry.startedAt);
  const onlineKeys = new Set(onlineRecords.map(keyOf));
  const stamped = entries.map((entry) =>
    onlineKeys.has(keyOf(entry)) ? { ...entry, lastSeenAt: now } : entry,
  );
  const stampedKeys = new Set(stamped.map(keyOf));

  for (const rec of onlineRecords) {
    const key = keyOf(rec);
    if (stampedKeys.has(key)) continue;
    stamped.push({
      cwd: rec.cwd,
      startedAt: rec.startedAt,
      ...(rec.model !== undefined && { model: rec.model }),
      lastSeenAt: now,
    });
    stampedKeys.add(key);
  }
  for (const rec of keepRecords) {
    const key = keyOf(rec);
    if (stampedKeys.has(key)) continue;
    stamped.push({
      cwd: rec.cwd,
      startedAt: rec.startedAt,
      ...(rec.model !== undefined && { model: rec.model }),
      lastSeenAt: rec.startedAt,
    });
    stampedKeys.add(key);
  }
  return stamped;
}

/** Compute compacted entries for fully offline cwds without concurrent records. */
export function computeHistoryKeepers(
  entries: ReadonlyArray<AgentHistoryEntry>,
  onlineRecords: ReadonlyArray<HistoryRecordKey>,
  keepRecords: ReadonlyArray<HistoryRecordKey>,
  isConcurrent: (entry: AgentHistoryEntry) => boolean,
): Map<string, AgentHistoryEntry> {
  const onlineCwds = new Set(onlineRecords.map((rec) => rec.cwd));
  const newestKeepByCwd = new Map<string, HistoryRecordKey>();
  for (const rec of keepRecords) {
    const current = newestKeepByCwd.get(rec.cwd);
    if (current === undefined || rec.startedAt > current.startedAt) {
      newestKeepByCwd.set(rec.cwd, rec);
    }
  }

  const keepers = new Map<string, AgentHistoryEntry>();
  for (const [cwd, group] of groupByCwd(entries)) {
    if (onlineCwds.has(cwd) || group.length < 2 || group.some(isConcurrent)) continue;
    const record = newestKeepByCwd.get(cwd);
    if (record === undefined) continue;
    const lastSeenAt = Math.max(...group.map((entry) => entry.lastSeenAt));
    keepers.set(cwd, {
      cwd,
      startedAt: record.startedAt,
      ...(record.model !== undefined && { model: record.model }),
      lastSeenAt,
    });
  }
  return keepers;
}

/**
 * Apply one {@link HistorySyncInput} to the history file.
 *
 * Order matters inside the transaction:
 *
 * 1. Stamp and self-heal online keys. A missing entry for an online record
 *    is created (upserted) rather than skipped, so an entry lost anywhere
 *    (a stolen write, a past race) is restored on the next list pass. A
 *    missing entry for a surviving offline record is created with
 *    `lastSeenAt = startedAt` (a session is never seen before it starts),
 *    which also guarantees Step 3 meets an entry for every keeper key.
 * 2. Compute compaction keepers for each cwd that has no online record and
 *    at least two entries. The keeper is keyed to the cwd's newest surviving
 *    record and carries the group's newest `lastSeenAt`, so recency that
 *    lives on a soon-to-be-dropped entry is preserved (an offline lead
 *    pruned next to its newer sibling must not drag the directory's recency
 *    down with it).
 * 3. Rebuild the entry list. Entries for cwd directories that no longer
 *    exist on disk are dropped, and non-concurrent entries whose key
 *    matches no record in the snapshot are dropped: their record file is
 *    gone, and keeping them would orphan them forever, because a cwd with
 *    an online record never compacts. Every compacted cwd collapses to its
 *    single keeper. A pruned record's entry survives the pruning pass (its
 *    key is in `allRecords`) and either folds into the cwd's keeper through
 *    compaction or drops on the next pass as an orphan.
 *
 * Two guards keep the pass safe against records registered while the
 * socket probes were awaited (the snapshot is stale for them):
 *
 * - Entries with `lastSeenAt > snapshotTime` or `startedAt > snapshotTime`
 *   are never dropped or counted for compaction. `upsertAgentHistory`
 *   stamps `lastSeenAt` with the write time, so an entry written while the
 *   probes ran always carries a `lastSeenAt` after the snapshot read. The
 *   `startedAt` clause remains as a fallback: `startedAt` is stamped at
 *   session start, before the record and its history entry are written, so
 *   a write landing in the same millisecond as the snapshot still reads as
 *   concurrent.
 * - A cwd containing one of those entries never compacts at all, even when
 *   every known record in it is offline.
 */
export function syncAgentHistory(input: HistorySyncInput): void {
  mutateEntries((entries) => {
    const keyOf = (entry: { cwd: string; startedAt: number }): string =>
      historyKey(entry.cwd, entry.startedAt);
    const concurrent = (entry: AgentHistoryEntry): boolean =>
      entry.lastSeenAt > input.snapshotTime || entry.startedAt > input.snapshotTime;
    const stamped = stampOnline(entries, input.onlineRecords, input.keepRecords, Date.now());
    const keepers = computeHistoryKeepers(
      stamped,
      input.onlineRecords,
      input.keepRecords,
      concurrent,
    );
    const allKeys = new Set(input.allRecords.map(keyOf));
    const emitted = new Set<string>();
    const next: AgentHistoryEntry[] = [];

    for (const entry of stamped) {
      if (!fs.existsSync(entry.cwd)) continue;
      if (!concurrent(entry) && !allKeys.has(keyOf(entry))) continue;
      const keeper = keepers.get(entry.cwd);
      if (keeper === undefined) next.push(entry);
      else if (!emitted.has(entry.cwd)) {
        emitted.add(entry.cwd);
        next.push(keeper);
      }
    }

    next.sort(compareHistoryEntries);
    const current = [...entries].sort(compareHistoryEntries);
    return JSON.stringify(next) === JSON.stringify(current) ? null : next;
  });
}
