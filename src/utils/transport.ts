/**
 * Socket transport for messages between team members.
 *
 * Each agent listens on a Unix domain socket (a named pipe on Windows). A
 * sender connects, writes one JSON message ended by a newline, and waits for
 * an acknowledgement. The acknowledgement means the recipient handed the
 * message to its handler. A sender gets an error at once when the recipient
 * does not listen, so no message waits for an agent that is gone.
 *
 * Security model: the socket directory belongs to the current user and has
 * mode 0700, and each socket has mode 0600. Only processes of the same user
 * can connect.
 */
import fs from "node:fs";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { TeamMessage } from "./models";
import { socketDir, socketPath } from "./paths";

/** Largest message the transport accepts, in bytes of the encoded JSON line. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Time a sender waits for the connection and the acknowledgement. */
export const SEND_TIMEOUT_MS = 5000;

/** Time a listener waits for a client to finish sending its message. */
export const RECEIVE_TIMEOUT_MS = 5000;

/** Acknowledgement line a listener returns after it accepts a message. */
const ACK_LINE = "ok";

/** Prefix of the rejection line a listener returns when it refuses a message. */
const ERROR_PREFIX = "error:";

const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const IS_WINDOWS = process.platform === "win32";

/** Thrown when the recipient has no listening socket. */
export class RecipientUnreachableError extends Error {
  constructor(agentName: string) {
    super(`Agent "${agentName}" is not reachable. It is not running, or it has not started listening yet.`);
    this.name = "RecipientUnreachableError";
  }
}

/** Handler that receives each message delivered to a listener. */
export type MessageHandler = (message: TeamMessage) => void | Promise<void>;

/** A running socket listener. */
export interface MessageListener {
  /** Address the listener accepts connections on. */
  readonly path: string;
  /** Stop listening, close open connections, and remove the socket file. */
  close(): Promise<void>;
}

/**
 * Check that a value is a well-formed message addressed to the given agent.
 *
 * @param value - The parsed JSON value
 * @param agentName - The name of the agent that must be the recipient
 * @returns The message when valid
 * @throws Error with a short reason when the value is not a valid message
 */
function parseTeamMessage(value: unknown, agentName: string): TeamMessage {
  if (typeof value !== "object" || value === null) throw new Error("message is not an object");
  const record = value as Record<string, unknown>;
  for (const key of ["id", "from", "to", "subject", "text", "timestamp"]) {
    if (typeof record[key] !== "string") throw new Error(`field "${key}" must be a string`);
  }
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new Error('field "summary" must be a string');
  }
  if (record.to !== agentName) throw new Error(`message is addressed to "${String(record.to)}"`);
  return record as unknown as TeamMessage;
}

/**
 * Create a private directory, or confirm that an existing one is safe.
 *
 * The directory is created with mode 0700. If it already exists, it must be
 * a real directory (not a symlink), owned by the current user, and have no
 * group or other permission bits set.
 *
 * @param dir - Absolute path of the directory to ensure
 * @throws Error when the path is not a directory, is a symbolic link, or belongs to another user
 */
export function ensurePrivateDir(dir: string): void {
  if (IS_WINDOWS) return;
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error(`Directory ${dir} is a symbolic link.`);
  if (!stat.isDirectory()) throw new Error(`Directory ${dir} is not a directory.`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Directory ${dir} belongs to another user.`);
  }
  if ((stat.mode & GROUP_AND_OTHER_BITS) !== 0) fs.chmodSync(dir, DIR_MODE);
}

/**
 * Create the per-user socket directory, or confirm that an existing one is safe.
 *
 * @throws Error when the path is not a directory, is a symbolic link, or belongs to another user
 */
function ensureSocketDir(): void {
  if (IS_WINDOWS) return;
  ensurePrivateDir(socketDir());
}

/**
 * Read one newline-terminated line from a client and hand it to the handler.
 *
 * Connections that close without data (liveness probes) are ignored.
 *
 * @param socket - The accepted client connection
 * @param agentName - Name of the agent this listener serves
 * @param onMessage - Handler that receives the valid message
 */
function serveConnection(socket: net.Socket, agentName: string, onMessage: MessageHandler): void {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.setTimeout(RECEIVE_TIMEOUT_MS, () => socket.destroy());

  const reply = (line: string): void => {
    socket.end(`${line}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    try {
      const message = parseTeamMessage(JSON.parse(line), agentName);
      await onMessage(message);
      reply(ACK_LINE);
    } catch (e) {
      reply(`${ERROR_PREFIX} ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  socket.on("data", (chunk: string) => {
    if (handled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      handled = true;
      reply(`${ERROR_PREFIX} message is larger than ${MAX_MESSAGE_BYTES} bytes`);
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    void handleLine(buffer.slice(0, newline));
  });
  socket.on("error", () => socket.destroy());
}

/**
 * Start listening for messages addressed to one agent.
 *
 * A socket file left by a process that no longer runs is replaced. When a live
 * listener already uses the address, the new listener takes over the address.
 *
 * @param teamName - Name of the team
 * @param agentName - Name of the agent that receives the messages
 * @param onMessage - Handler called for each valid message before the sender gets its acknowledgement
 * @returns The running listener
 * @throws Error when the socket directory is unsafe or the socket cannot be created
 */
export async function startListener(
  teamName: string,
  agentName: string,
  onMessage: MessageHandler,
): Promise<MessageListener> {
  ensureSocketDir();
  const address = socketPath(teamName, agentName);
  // A closing net.Server unlinks the path it listened on. Listening on a
  // unique temporary path and renaming it to the address keeps an older
  // listener from deleting the socket file of a newer one.
  const listenPath = IS_WINDOWS ? address : `${address}.${randomBytes(3).toString("hex")}`;

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveConnection(socket, agentName, onMessage);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let inode: number | null = null;
  if (!IS_WINDOWS) {
    fs.chmodSync(listenPath, SOCKET_MODE);
    inode = fs.statSync(listenPath).ino;
    // The rename replaces a socket file left by a process that no longer runs.
    fs.renameSync(listenPath, address);
  }

  return {
    path: address,
    async close(): Promise<void> {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (inode === null) return;
      // Another listener can have replaced the socket file after this one
      // started, for example a lead window. Remove the file only when it is ours.
      try {
        if (fs.statSync(address).ino === inode) fs.rmSync(address, { force: true });
      } catch {
        // The file is already gone.
      }
    },
  };
}

/**
 * Send one message to a listening agent and wait for its acknowledgement.
 *
 * @param teamName - Name of the team
 * @param message - The message; `message.to` selects the recipient socket
 * @param timeoutMs - Time to wait for the connection and the acknowledgement
 * @throws RecipientUnreachableError when the recipient has no listening socket
 * @throws Error when the message is too large, the recipient rejects it, or the wait times out
 */
export async function sendToAgent(
  teamName: string,
  message: TeamMessage,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<void> {
  const payload = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) {
    throw new Error(`Message is larger than ${MAX_MESSAGE_BYTES} bytes.`);
  }
  const address = socketPath(teamName, message.to);

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(address);
    let response = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs} ms while sending to "${message.to}".`)),
      timeoutMs,
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      const line = response.slice(0, newline).trim();
      if (line === ACK_LINE) finish();
      else finish(new Error(`"${message.to}" rejected the message: ${line.replace(ERROR_PREFIX, "").trim()}`));
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      const unreachable = e.code === "ENOENT" || e.code === "ECONNREFUSED";
      finish(unreachable ? new RecipientUnreachableError(message.to) : e);
    });
    socket.on("close", () => finish(new Error(`"${message.to}" closed the connection without acknowledging.`)));
  });
}

/**
 * Check whether an agent has a listening socket.
 *
 * Opens and closes a connection without sending data. The listener ignores
 * such probes.
 *
 * @param teamName - Name of the team
 * @param agentName - Name of the agent to probe
 * @param timeoutMs - Time to wait for the connection
 * @returns True when the agent accepts connections
 */
export async function isListening(
  teamName: string,
  agentName: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let address: string;
    try {
      address = socketPath(teamName, agentName);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.createConnection(address);
    const finish = (listening: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

/** Pause between probes while waiting for an agent to start listening. */
export const LISTEN_POLL_INTERVAL_MS = 100;

/**
 * Wait until an agent accepts connections.
 *
 * A spawned worker needs a few seconds to boot before it listens. Call this
 * after a spawn so the first message does not race the boot.
 *
 * @param teamName - Name of the team
 * @param agentName - Name of the agent to wait for
 * @param timeoutMs - Longest time to wait
 * @param intervalMs - Pause between probes
 * @returns True when the agent listens, false when the wait timed out
 */
export async function waitForListener(
  teamName: string,
  agentName: string,
  timeoutMs: number,
  intervalMs: number = LISTEN_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isListening(teamName, agentName, intervalMs * 5)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
