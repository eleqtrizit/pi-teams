import fs from "node:fs";
import path from "node:path";
import { AgentKind, AgentRecord } from "./models";
import { agentHistoryPath, registryDir } from "./paths";
import { ensurePrivateDir } from "./transport";

/**
 * One historical entry about an agent, keyed uniquely by its agent ID.
 *
 * `cwd` and `startedAt` come from the agent record at the moment the agent
 * started, so entries can be indexed and sorted by where and when each agent
 * ran. `removedAt` is set once the agent's live record is deleted; the entry
 * itself stays so offline agents remain visible.
 */
export interface AgentHistoryEntry {
  id: string;
  kind: AgentKind;
  cwd: string;
  pid: number;
  startedAt: number;
  name?: string;
  model?: string;
  /** Timestamp of the last history upsert for this agent. */
  lastSeenAt: number;
  /** Timestamp when the agent's live record was removed; absent while alive. */
  removedAt?: number;
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
    try {
      const parsed = JSON.parse(line) as AgentHistoryEntry;
      if (typeof parsed.id === "string" && typeof parsed.startedAt === "number") {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Write history entries atomically, one JSON line per entry.
 *
 * Sorts by cwd, then startedAt, then id, so the file reads as an index of
 * where and when each agent ran. Writes to a temp file in the same directory
 * and renames it into place, matching the registry's atomic-write pattern.
 *
 * @param entries - Deduplicated entries to persist
 */
function writeHistoryEntries(entries: AgentHistoryEntry[]): void {
  ensurePrivateDir(registryDir());
  const sorted = [...entries].sort(
    (a, b) =>
      a.cwd.localeCompare(b.cwd) || a.startedAt - b.startedAt || a.id.localeCompare(b.id),
  );
  const body = sorted.map((entry) => JSON.stringify(entry)).join("\n") + (sorted.length ? "\n" : "");

  const file = agentHistoryPath();
  const tmp = path.join(path.dirname(file), `.tmp-agents-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read every valid history entry from agents.jsonl.
 *
 * Corrupt or blank lines are skipped, so a truncated write or a hand-edited
 * file never breaks the readers.
 *
 * @returns History entries in file order (sorted by cwd, startedAt, id)
 */
export function readAgentHistory(): AgentHistoryEntry[] {
  return readHistoryEntries();
}

/**
 * Insert or update the history entry for one agent record.
 *
 * Keeps the file unique by agent ID: any previous entry with the same ID is
 * replaced, preserving its `removedAt` marker when one exists.
 *
 * @param rec - Agent record to record in the history
 */
export function upsertAgentHistory(rec: AgentRecord): void {
  const entries = readHistoryEntries();
  const previous = entries.find((e) => e.id === rec.id);
  const others = entries.filter((e) => e.id !== rec.id);
  others.push({
    id: rec.id,
    kind: rec.kind,
    cwd: rec.cwd,
    pid: rec.pid,
    startedAt: rec.startedAt,
    ...(rec.name !== undefined && { name: rec.name }),
    ...(rec.model !== undefined && { model: rec.model }),
    lastSeenAt: Date.now(),
    ...(previous?.removedAt !== undefined && { removedAt: previous.removedAt }),
  });
  writeHistoryEntries(others);
}

/**
 * Refresh `lastSeenAt` for agents that were just observed online.
 *
 * Stamps `lastSeenAt` on every listed id that has a history entry, and
 * clears a stale `removedAt` marker because the id was just seen alive.
 * Ids without an entry are skipped. The file is written once, only when at
 * least one entry changed.
 *
 * @param ids - Agent ids observed online.
 * @param now - Epoch milliseconds to stamp; defaults to Date.now(). Overridden in tests.
 */
export function touchLastSeen(ids: Iterable<string>, now: number = Date.now()): void {
  const idSet = new Set(ids);
  if (idSet.size === 0) return;
  const entries = readHistoryEntries();
  let changed = false;
  const updated = entries.map((entry) => {
    if (!idSet.has(entry.id)) return entry;
    changed = true;
    return { ...entry, lastSeenAt: now, removedAt: undefined };
  });
  if (changed) writeHistoryEntries(updated);
}

/**
 * Mark an agent as removed in the history without deleting its entry.
 *
 * Idempotent: a missing entry or an already-removed entry is left as is.
 *
 * @param id - Agent ID to mark removed
 */
export function markAgentHistoryRemoved(id: string): void {
  const entries = readHistoryEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.removedAt !== undefined) return;
  entry.removedAt = Date.now();
  writeHistoryEntries(entries);
}
