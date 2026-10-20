import os from "node:os";
import path from "node:path";

export function sanitizeName(name: string): string {
  // Allow only alphanumeric characters, hyphens, and underscores.
  if (/[^a-zA-Z0-9_-]/.test(name)) {
    throw new Error(`Invalid name: "${name}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  }
  return name;
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
 * Defaults to `~/.pi/agent/pi-teams/` so records, sockets, run state, and the
 * agent history survive an OS reboot. Set `PI_TEAMS_REGISTRY_DIR` to relocate
 * it; the test suite uses that variable for isolation.
 *
 * @returns Absolute path of the per-user registry directory
 */
export function registryDir(): string {
  const override = process.env.PI_TEAMS_REGISTRY_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".pi", "agent", "pi-teams");
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
 * Path of one agent's run-state file, keyed by agent ID.
 *
 * @param id - Agent ID
 * @returns Absolute path of the agent's state file
 * @throws Error when the ID is invalid
 */
export function agentIdStatePath(id: string): string {
  assertAgentId(id);
  return path.join(registryDir(), "state", `${id}.json`);
}

/**
 * Path of the append-safe agent history file.
 *
 * Holds one JSON line per agent ever registered, keyed uniquely by agent ID,
 * so offline and removed agents stay visible after their live record is gone.
 *
 * @returns Absolute path of the agents.jsonl history file
 */
export function agentHistoryPath(): string {
  return path.join(registryDir(), "agents.jsonl");
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
        "Set PI_TEAMS_REGISTRY_DIR to a shorter directory.",
    );
  }
  return socket;
}
