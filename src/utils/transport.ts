import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { TeamMessage } from "./models";
import { agentSocketPath, registryDir } from "./paths";

/** Largest message the transport accepts, in bytes of the encoded JSON line. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Time a sender waits for the connection and the acknowledgement. */
export const SEND_TIMEOUT_MS = 5000;
/** Time a listener waits for a client to finish sending its message. */
export const RECEIVE_TIMEOUT_MS = 5000;
/** Default time a liveness probe waits for a socket connection. */
export const PROBE_TIMEOUT_MS = 500;
const ACK_LINE = "ok";
const ERROR_PREFIX = "error:";
const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
const GROUP_AND_OTHER_BITS = 0o077;
const IS_WINDOWS = process.platform === "win32";

/** Thrown when the recipient has no listening socket. */
export class RecipientUnreachableError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" is not reachable. It is not running, or it has not started listening yet.`);
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

/** Validate a parsed message and ensure that it targets this agent ID. */
function parseTeamMessage(value: unknown, agentId: string): TeamMessage {
  if (typeof value !== "object" || value === null) throw new Error("message is not an object");
  const record = value as Record<string, unknown>;
  for (const key of ["id", "from", "to", "fromLabel", "subject", "text", "timestamp"]) {
    if (typeof record[key] !== "string") throw new Error(`field "${key}" must be a string`);
  }
  if (record.summary !== undefined && typeof record.summary !== "string") {
    throw new Error('field "summary" must be a string');
  }
  if (record.expectReply !== undefined && typeof record.expectReply !== "boolean") {
    throw new Error('field "expectReply" must be a boolean');
  }
  if (record.to !== agentId) throw new Error(`message is addressed to "${String(record.to)}"`);
  return record as unknown as TeamMessage;
}

/** Create a private directory, or confirm that an existing one is safe. */
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

/** Ensure the registry directory and its private socket subdirectory exist. */
function ensureSocketDir(): void {
  if (IS_WINDOWS) return;
  const base = registryDir();
  ensurePrivateDir(base);
  ensurePrivateDir(path.join(base, "s"));
}

/** Handle one newline-terminated client message. */
function serveConnection(socket: net.Socket, agentId: string, onMessage: MessageHandler): void {
  let buffer = "";
  let handled = false;
  socket.setEncoding("utf8");
  socket.setTimeout(RECEIVE_TIMEOUT_MS, () => socket.destroy());
  const reply = (line: string): void => {
    socket.end(`${line}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    try {
      const message = parseTeamMessage(JSON.parse(line), agentId);
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

/** Start listening for messages addressed to one agent ID. */
export async function startListener(agentId: string, onMessage: MessageHandler): Promise<MessageListener> {
  ensureSocketDir();
  const address = agentSocketPath(agentId);
  const listenPath = IS_WINDOWS ? address : `${address}.${randomBytes(3).toString("hex")}`;
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    serveConnection(socket, agentId, onMessage);
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
    fs.renameSync(listenPath, address);
  }

  return {
    path: address,
    async close(): Promise<void> {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (inode === null) return;
      try {
        if (fs.statSync(address).ino === inode) fs.rmSync(address, { force: true });
      } catch {
        // The file is already gone.
      }
    },
  };
}

/** Send one message to the agent ID in `message.to` and wait for its acknowledgement. */
export async function sendToAgent(message: TeamMessage, timeoutMs: number = SEND_TIMEOUT_MS): Promise<void> {
  const payload = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) {
    throw new Error(`Message is larger than ${MAX_MESSAGE_BYTES} bytes.`);
  }
  const address = agentSocketPath(message.to);
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

/** Check whether anything accepts connections at a socket address. */
export async function isSocketListening(address: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
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

/** Check whether an agent ID has a listening socket. */
export async function isListening(agentId: string, timeoutMs: number = SEND_TIMEOUT_MS): Promise<boolean> {
  try {
    return await isSocketListening(agentSocketPath(agentId), timeoutMs);
  } catch {
    return false;
  }
}

/** Pause between probes while waiting for an agent to start listening. */
export const LISTEN_POLL_INTERVAL_MS = 100;

/** Wait until an agent ID accepts connections. */
export async function waitForListener(
  agentId: string,
  timeoutMs: number,
  intervalMs: number = LISTEN_POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isListening(agentId, intervalMs * 5)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
