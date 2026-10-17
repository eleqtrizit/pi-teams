import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentKind, AgentRecord, AgentStatus } from "./models";
import { AgentEntry } from "./agentFormat";
import { agentRecordPath, agentRecordsDir, agentSocketPath, registryDir, AGENT_ID_PATTERN } from "./paths";
import { markAgentHistoryRemoved, touchLastSeen, upsertAgentHistory } from "./history";
import { isAgentBusy } from "./runstate";
import { PROBE_TIMEOUT_MS, ensurePrivateDir, isSocketListening } from "./transport";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;
const REJECTION_THRESHOLD = 252; // 7 * 36 — values 0-251 give uniform distribution over 36 chars

/**
 * Generate a unique 8-character agent ID.
 *
 * Each character is drawn from [a-z0-9] using rejection sampling on
 * cryptographically secure random bytes, eliminating modulo bias.
 *
 * @param exists - Callback that returns true when the ID is already taken
 * @returns A new, unused agent ID
 */
export function generateAgentId(
  exists: (id: string) => boolean = (id) => fs.existsSync(agentRecordPath(id)),
): string {
  for (;;) {
    const bytes = randomBytes(16);
    let id = "";
    for (const byte of bytes) {
      if (byte >= REJECTION_THRESHOLD) continue;
      id += ID_ALPHABET[byte % 36];
      if (id.length === ID_LENGTH) break;
    }
    if (id.length === ID_LENGTH && !exists(id)) return id;
  }
}

/**
 * Create the per-user registry directory and its subdirectories,
 * or confirm that existing ones are safe.
 *
 * Creates `agents/` and `s/` inside the registry dir with mode 0700.
 * Refuses to use a path that is a symlink, not a directory, or owned
 * by another user. Fixes permissions when group or other bits are set.
 *
 * @throws Error when the path is unsafe
 */
export function ensureRegistryDir(): void {
  const base = registryDir();
  ensurePrivateDir(base);
  ensurePrivateDir(path.join(base, "agents"));
  ensurePrivateDir(path.join(base, "s"));
}

/**
 * Write an agent record atomically.
 *
 * Writes to a temporary file in the same directory, sets mode 0600,
 * then renames it into place so readers never see a partial file.
 *
 * @param rec - Agent record to persist
 * @throws Error when the record cannot be written
 */
export function writeAgentRecord(rec: AgentRecord): void {
  const file = agentRecordPath(rec.id);
  ensureRegistryDir();
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${rec.id}-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, file);
  upsertAgentHistory(rec);
}

/**
 * Patch an existing agent record and persist the updated version.
 *
 * @param id - Agent ID to update
 * @param patch - Partial record with the fields to change
 * @throws Error when the record is not found
 */
export function updateAgentRecord(id: string, patch: Partial<AgentRecord>): void {
  const rec = readAgentRecord(id);
  if (!rec) throw new Error(`Agent ${id} not found`);
  const updated: AgentRecord = { ...rec, ...patch, id };
  writeAgentRecord(updated);
}

/**
 * Validate that a parsed JSON value is a well-formed AgentRecord.
 *
 * @param value - Parsed JSON value
 * @returns True when the value matches the AgentRecord shape
 */
function isValidAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;

  if (typeof rec.id !== "string" || !AGENT_ID_PATTERN.test(rec.id)) return false;
  if (!Object.values(AgentKind).includes(rec.kind as AgentKind)) return false;
  if (typeof rec.cwd !== "string") return false;
  if (typeof rec.pid !== "number" || !Number.isFinite(rec.pid)) return false;
  if (rec.leadId !== undefined && (typeof rec.leadId !== "string" || !AGENT_ID_PATTERN.test(rec.leadId))) {
    return false;
  }
  if (rec.name !== undefined && typeof rec.name !== "string") return false;
  if (rec.model !== undefined && typeof rec.model !== "string") return false;
  if (rec.paneId !== undefined && typeof rec.paneId !== "string") return false;
  if (rec.windowId !== undefined && typeof rec.windowId !== "string") return false;
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return false;

  return true;
}

/**
 * Read all valid agent records from the registry.
 *
 * Skips files that cannot be parsed or do not pass validation.
 * Files are a trust boundary, so every field is checked.
 *
 * @returns Array of valid agent records
 */
export function readAgentRecords(): AgentRecord[] {
  const dir = agentRecordsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const records: AgentRecord[] = [];

  for (const file of files) {
    const id = file.slice(0, -5); // remove ".json"
    if (!AGENT_ID_PATTERN.test(id)) continue;

    const fullPath = path.join(dir, file);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!isValidAgentRecord(parsed) || parsed.id !== id) continue;
    records.push(parsed);
  }

  return records;
}

/**
 * Read a single agent record by ID.
 *
 * @param id - Agent ID
 * @returns The record, or undefined when not found or invalid
 */
export function readAgentRecord(id: string): AgentRecord | undefined {
  const records = readAgentRecords();
  return records.find((r) => r.id === id);
}

/**
 * Remove an agent record by ID.
 *
 * Ignores ENOENT (the file is already gone).
 *
 * @param id - Agent ID
 */
export function removeAgentRecord(id: string): void {
  markAgentHistoryRemoved(id);
  const file = agentRecordPath(id);
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}

/**
 * Check whether a process with the given pid exists.
 *
 * Signal 0 performs no signal delivery; it only checks existence and
 * permission. An EPERM error means the process exists but belongs to
 * another user, which still proves it is alive.
 *
 * @param pid - Process id to check
 * @returns True when the process exists
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

/**
 * Check whether a registered agent is online.
 *
 * The agent is online only when its pid is alive and something accepts
 * connections on its socket address. The socket check defends against a
 * reused pid: a live pid that does not own the agent's socket is offline.
 *
 * @param rec - Agent record to check
 * @param probe - Socket probe; overridden in tests
 * @param pidAlive - Pid check; overridden in tests
 * @returns Available when the process is alive and listening and not busy, otherwise Offline
 */
export async function agentStatus(
  rec: AgentRecord,
  probe: (address: string, timeoutMs: number) => Promise<boolean> = isSocketListening,
  pidAlive: (pid: number) => boolean = isPidAlive,
): Promise<AgentStatus> {
  if (!pidAlive(rec.pid)) return AgentStatus.Offline;
  let address: string;
  try {
    address = agentSocketPath(rec.id);
  } catch {
    return AgentStatus.Offline;
  }
  const listening = await probe(address, PROBE_TIMEOUT_MS);
  if (!listening) return AgentStatus.Offline;
  return isAgentBusy(rec.id) ? AgentStatus.Busy : AgentStatus.Available;
}

/**
 * Decide which registered agents survive a registry prune.
 *
 * Rules:
 * - Any worker whose status is not Offline is kept (including Busy, i.e. mid-run).
 * - A directory (cwd) with at least one online lead discards every offline
 *   lead record for that cwd.
 * - A directory with no online lead keeps exactly one offline lead: the
 *   newest by `startedAt`, ties broken by the lexicographically greatest id.
 *
 * A record whose status is missing from the map is treated as Offline.
 *
 * @param records - Agent records to evaluate; never modified
 * @param statuses - Status of each record, keyed by agent id
 * @returns The surviving records and the ids to remove, both in input order
 */
export function pruneRegistry(
  records: AgentRecord[],
  statuses: Map<string, AgentStatus>,
): { keep: AgentRecord[]; remove: string[] } {
  const statusOf = (rec: AgentRecord): AgentStatus =>
    statuses.get(rec.id) ?? AgentStatus.Offline;

  /** A Busy agent (mid-run) is alive and must survive pruning like an Available one. */
  const isOnline = (rec: AgentRecord): boolean => statusOf(rec) !== AgentStatus.Offline;

  const cwdHasOnlineLead = new Set<string>();
  for (const rec of records) {
    if (rec.kind === AgentKind.Lead && isOnline(rec)) {
      cwdHasOnlineLead.add(rec.cwd);
    }
  }

  const newestOfflineLeadByCwd = new Map<string, AgentRecord>();
  const isNewest = (rec: AgentRecord, current: AgentRecord): boolean =>
    rec.startedAt > current.startedAt ||
    (rec.startedAt === current.startedAt && rec.id > current.id);
  for (const rec of records) {
    if (rec.kind !== AgentKind.Lead || isOnline(rec)) continue;
    const current = newestOfflineLeadByCwd.get(rec.cwd);
    if (current === undefined || isNewest(rec, current)) {
      newestOfflineLeadByCwd.set(rec.cwd, rec);
    }
  }

  const keep: AgentRecord[] = [];
  const remove: string[] = [];
  for (const rec of records) {
    if (rec.kind !== AgentKind.Lead) {
      if (isOnline(rec)) keep.push(rec);
      else remove.push(rec.id);
      continue;
    }
    if (isOnline(rec)) {
      keep.push(rec);
      continue;
    }
    if (cwdHasOnlineLead.has(rec.cwd)) {
      remove.push(rec.id);
      continue;
    }
    if (newestOfflineLeadByCwd.get(rec.cwd)?.id === rec.id) keep.push(rec);
    else remove.push(rec.id);
  }

  return { keep, remove };
}

/**
 * Remove the stale socket file of a pruned agent.
 *
 * On Windows the address is a named pipe with no file to delete, so the
 * call is a no-op there. Missing files (ENOENT) are ignored.
 *
 * @param id - Agent ID whose socket file to delete
 * @throws Error when the file exists but cannot be removed
 */
export function removeStaleSocket(id: string): void {
  if (process.platform === "win32") return;
  try {
    fs.rmSync(agentSocketPath(id), { force: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}

/**
 * Prune the registry on disk and list the surviving agents.
 *
 * Computes each record's status, stamps `lastSeenAt` in the history for every
 * online record, applies {@link pruneRegistry}, deletes every removed record
 * along with its stale socket file, and returns the survivors paired with
 * their statuses, in registry read order.
 *
 * @param statusOf - Status function; overridden in tests for determinism
 * @returns One `{record, status}` entry per surviving agent
 */
export async function pruneAndList(
  statusOf: (rec: AgentRecord) => Promise<AgentStatus> = (rec) => agentStatus(rec),
): Promise<AgentEntry[]> {
  const records = readAgentRecords();
  const statuses = new Map<string, AgentStatus>();
  await Promise.all(
    records.map(async (rec) => {
      statuses.set(rec.id, await statusOf(rec));
    }),
  );

  // Agents found online are online right now: record that, so an agent that
  // later goes offline keeps a meaningful "last online" time.
  touchLastSeen(
    records
      .filter((rec) => statuses.get(rec.id) !== AgentStatus.Offline)
      .map((rec) => rec.id),
  );

  const { keep, remove } = pruneRegistry(records, statuses);
  for (const id of remove) {
    removeAgentRecord(id);
    removeStaleSocket(id);
  }

  return keep.map((rec) => ({ record: rec, status: statuses.get(rec.id) ?? AgentStatus.Offline }));
}
