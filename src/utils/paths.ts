import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PI_DIR = path.join(os.homedir(), ".pi");
export const TEAMS_DIR = path.join(PI_DIR, "teams");
export const TASKS_DIR = path.join(PI_DIR, "tasks");

export function ensureDirs() {
  if (!fs.existsSync(PI_DIR)) fs.mkdirSync(PI_DIR);
  if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR);
  if (!fs.existsSync(TASKS_DIR)) fs.mkdirSync(TASKS_DIR);
}

export function sanitizeName(name: string): string {
  // Allow only alphanumeric characters, hyphens, and underscores.
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  }
  return name;
}

/** Directory that holds one subdirectory per team. A function so tests can redirect it. */
export function teamsDir(): string {
  return TEAMS_DIR;
}

export function teamDir(teamName: string) {
  return path.join(TEAMS_DIR, sanitizeName(teamName));
}

export function taskDir(teamName: string) {
  return path.join(TASKS_DIR, sanitizeName(teamName));
}

export function configPath(teamName: string) {
  return path.join(teamDir(teamName), "config.json");
}

export function pidPath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), `${sanitizeName(agentName)}.pid`);
}

export function activePath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), `${sanitizeName(agentName)}.active`);
}

export function firstActivationPath(teamName: string, agentName: string) {
  return path.join(teamDir(teamName), `${sanitizeName(agentName)}.firstActivation`);
}

/**
 * Longest Unix socket path that works on every supported platform. macOS
 * limits the path to 104 bytes including the terminator. The limit leaves room
 * for the temporary suffix the transport appends while it starts a listener.
 */
const MAX_UNIX_SOCKET_PATH = 90;

/**
 * Identify the current user in a file or pipe name.
 *
 * @returns The numeric uid on POSIX systems, otherwise the sanitized user name
 */
function socketUserId(): string {
  if (typeof process.getuid === "function") return String(process.getuid());
  return os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Pattern every agent ID must match. Fixed-width lowercase hex-style IDs keep paths predictable and block traversal. */
export const AGENT_ID_PATTERN = /^[a-z0-9]{8}$/;

/**
 * Validate one agent ID.
 *
 * @param id - Agent ID to check
 * @throws Error when the ID is not exactly 8 lowercase alphanumeric characters
 */
export function assertAgentId(id: string): void {
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid agent ID: "${id}". Agent IDs must match ${AGENT_ID_PATTERN.source}.`);
  }
}

/**
 * Directory that holds the per-user agent registry.
 *
 * @returns Absolute path of the per-user registry directory
 */
export function registryDir(): string {
  return path.join(os.tmpdir(), `pi-${socketUserId()}`);
}

/**
 * Directory that holds one JSON record per registered agent.
 *
 * @returns Absolute path of the agent records directory
 */
export function agentRecordsDir(): string {
  return path.join(registryDir(), "agents");
}

/**
 * Path of one agent's JSON record file.
 *
 * @param id - Agent ID
 * @returns Absolute path of the agent record
 * @throws Error when the ID is invalid
 */
export function agentRecordPath(id: string): string {
  assertAgentId(id);
  return path.join(agentRecordsDir(), `${id}.json`);
}

/**
 * Address of one agent's socket, keyed by agent ID instead of team and name.
 *
 * @param id - Agent ID
 * @returns A Unix socket path, or a named pipe path on Windows
 * @throws Error when the ID is invalid or the path is too long
 */
export function agentSocketPath(id: string): string {
  assertAgentId(id);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-${socketUserId()}-${id}`;
  }
  const socket = path.join(registryDir(), "s", `${id}.sock`);
  if (socket.length > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `Socket path is ${socket.length} characters, over the ${MAX_UNIX_SOCKET_PATH} limit. ` +
        "Set TMPDIR to a shorter directory.",
    );
  }
  return socket;
}
