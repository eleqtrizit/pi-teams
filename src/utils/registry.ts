import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AgentKind, AgentRecord } from "./models";
import { agentRecordPath, agentRecordsDir, registryDir, AGENT_ID_PATTERN } from "./paths";
import { ensurePrivateDir } from "./transport";

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
  const file = agentRecordPath(id);
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
}
