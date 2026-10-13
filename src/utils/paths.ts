import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

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

/** Prefix of the per-user socket directory and of Windows pipe names. */
const SOCKET_NAME_PREFIX = "pi-teams";

/** Length of the hash that names one agent's socket. */
const SOCKET_HASH_LENGTH = 12;

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

/**
 * Directory that holds the sockets of the current user.
 *
 * The directory sits under the OS temp directory so the path stays short. The
 * transport creates it with mode 0700 and refuses to use one that another
 * user owns.
 *
 * @returns Absolute path of the per-user socket directory
 */
export function socketDir(): string {
  return path.join(os.tmpdir(), `${SOCKET_NAME_PREFIX}-${socketUserId()}`);
}

/**
 * Address of one agent's message socket.
 *
 * The file name is a hash of the team and agent names, so the path length does
 * not depend on the names.
 *
 * @param teamName - Name of the team
 * @param agentName - Name of the agent
 * @returns A Unix socket path, or a named pipe path on Windows
 * @throws Error when a name is invalid or the temp directory makes the path too long
 */
export function socketPath(teamName: string, agentName: string): string {
  const id = createHash("sha256")
    .update(`${sanitizeName(teamName)}\0${sanitizeName(agentName)}`)
    .digest("hex")
    .slice(0, SOCKET_HASH_LENGTH);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${SOCKET_NAME_PREFIX}-${socketUserId()}-${id}`;
  }
  const socket = path.join(socketDir(), `${id}.sock`);
  if (socket.length > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `Socket path is ${socket.length} characters, over the ${MAX_UNIX_SOCKET_PATH} limit. ` +
        "Set TMPDIR to a shorter directory.",
    );
  }
  return socket;
}
