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
 * it, `list_agents` refreshes `lastSeenAt` for online records, and record
 * removal deletes it. Cwds whose records are all offline are compacted to a
 * single entry by the list pass. `model` is kept for future
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
 * The `\n` separator cannot appear in an `cwd` value (paths never contain
 * newlines), and `startedAt` serializes without one, so `(cwd, startedAt)`
 * pairs never collide on the concatenated key.
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
function writeHistoryEntries(entries: AgentHistoryEntry[]): void {
  ensurePrivateDir(registryDir());
  const sorted = [...entries].sort(
    (a, b) => a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt,
  );
  const body = sorted.map((entry) => JSON.stringify(entry)).join("\n") + (sorted.length ? "\n" : "");

  const file = agentHistoryPath();
  const tmp = path.join(path.dirname(file), `.tmp-agents-${process.pid}-${Date.now()}.jsonl`);
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
  /** Records the prune removed: their entries are dropped. */
  removedRecords: ReadonlyArray<HistoryRecordKey>;
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

/** The newest record per cwd, to key each compaction keeper. */
function newestRecordByCwd(
  records: ReadonlyArray<HistoryRecordKey>,
): Map<string, HistoryRecordKey> {
  const newest = new Map<string, HistoryRecordKey>();
  for (const rec of records) {
    const current = newest.get(rec.cwd);
    if (current === undefined || rec.startedAt > current.startedAt) {
      newest.set(rec.cwd, rec);
    }
  }
  return newest;
}

/**
 * Apply one {@link HistorySyncInput} to the history file.
 *
 * Order matters inside the transaction:
 *
 * 1. Stamp and self-heal online keys. A missing entry for an online record
 *    is created (upserted) rather than skipped, so an entry lost anywhere
 *    (a stolen write, a past race) is restored on the next list pass.
 * 2. Compute compaction keepers for each cwd that has no online record and
 *    at least two entries. The keeper is keyed to the cwd's newest surviving
 *    record and carries the group's newest `lastSeenAt`, so recency that
 *    lives on a soon-to-be-dropped entry is preserved (an offline lead
 *    pruned next to its newer sibling must not drag the directory's recency
 *    down with it).
 * 3. Rebuild the entry list: orphaned entries for cwd directories that no
 *    longer exist on disk are dropped, pruned-record entries are dropped,
 *    and every compacted cwd collapses to its single keeper.
 *
 * Two guards keep the pass safe against records registered while the
 * socket probes were awaited (the snapshot is stale for them):
 *
 * - Entries with `startedAt > snapshotTime` are never modified, dropped, or
 *   counted for compaction. A registration during the probe always starts
 *   after the snapshot read, so this is exactly the concurrent case.
 * - A cwd containing one of those entry never compacts at all, even when
 *   every known record in it is offline.
 */
export function syncAgentHistory(input: HistorySyncInput): void {
  const { onlineRecords, removedRecords, keepRecords, snapshotTime } = input;
  mutateEntries((entries) => {
    const now = Date.now();
    const keyOf = (e: { cwd: string; startedAt: number }) => historyKey(e.cwd, e.startedAt);
    const onlineKeys = new Set(onlineRecords.map(keyOf));
    const removedKeys = new Set(removedRecords.map(keyOf));
    const keepKeys = new Set(keepRecords.map(keyOf));

    // 1. Stamp online entries; upsert the missing ones.
    let stamped = entries.map((e) => (onlineKeys.has(keyOf(e)) ? { ...e, lastSeenAt: now } : e));
    for (const rec of onlineRecords) {
      if (stamped.some((e) => keyOf(e) === keyOf(rec))) continue;
      stamped.push({
        cwd: rec.cwd,
        startedAt: rec.startedAt,
        ...(rec.model !== undefined && { model: rec.model }),
        lastSeenAt: now,
      });
    }

    // 2. Compaction keepers for fully offline, fully snapshotted cwds.
    const onlineCwds = new Set(onlineRecords.map((rec) => rec.cwd));
    const newestKeepByCwd = newestRecordByCwd(keepRecords);
    const keepers = new Map<string, AgentHistoryEntry>();
    for (const [cwd, group] of groupByCwd(stamped)) {
      if (onlineCwds.has(cwd) || group.length < 2) continue;
      if (group.some((e) => e.startedAt > snapshotTime)) continue; // concurrent registration
      const keeperKey = newestKeepByCwd.get(cwd);
      if (keeperKey === undefined) continue; // nothing survives to look the entry up
      let lastSeenAt = group[0].lastSeenAt;
      for (const e of group) if (e.lastSeenAt > lastSeenAt) lastSeenAt = e.lastSeenAt;
      keepers.set(cwd, {
        cwd,
        startedAt: keeperKey.startedAt,
        ...(keeperKey.model !== undefined && { model: keeperKey.model }),
        lastSeenAt,
      });
    }

    // 3. Rebuild: drop dead-directory orphans and pruned entries, collapse
    //    compacted cwds to their keeper.
    const emitted = new Set<string>();
    const next: AgentHistoryEntry[] = [];
    for (const e of stamped) {
      if (!fs.existsSync(e.cwd)) continue; // orphan: its record was trimmed with its directory
      if (e.startedAt <= snapshotTime && removedKeys.has(keyOf(e)) && !keepKeys.has(keyOf(e))) {
        continue; // pruned record's entry, unless a surviving sibling shares it
      }
      const keeper = keepers.get(e.cwd);
      if (keeper !== undefined) {
        if (emitted.has(e.cwd)) continue;
        emitted.add(e.cwd);
        next.push(keeper);
      } else {
        next.push(e);
      }
    }
    const canon = (list: ReadonlyArray<AgentHistoryEntry>): string =>
      JSON.stringify(
        [...list].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt),
      );
    return canon(next) === canon(entries) ? null : next;
  });
}
