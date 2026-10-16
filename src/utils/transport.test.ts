import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamMessage } from "./models";
import { agentSocketPath, registryDir } from "./paths";
import {
  MAX_MESSAGE_BYTES,
  MessageListener,
  RecipientUnreachableError,
  isListening,
  isSocketListening,
  sendToAgent,
  startListener,
  waitForListener,
} from "./transport";

const posixOnly = process.platform === "win32" ? it.skip : it;
const makeId = (): string => randomUUID().replace(/-/g, "").slice(0, 8);
function makeMessage(to: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return { id: "abcd1234", from: "from1234", to, fromLabel: "team-lead", subject: "subject", text: "body", timestamp: new Date().toISOString(), ...overrides };
}
function sendRaw(agentId: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(agentSocketPath(agentId));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

describe("socket transport", () => {
  let agentId: string;
  let listener: MessageListener | undefined;
  beforeEach(() => { agentId = makeId(); });
  afterEach(async () => { await listener?.close(); listener = undefined; });

  it("delivers a message and resolves after the handler ran", async () => {
    const received: TeamMessage[] = [];
    listener = await startListener(agentId, (message) => { received.push(message); });
    await sendToAgent(makeMessage(agentId, { text: "hello" }));
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
  });
  it("preserves unicode and newlines in the body", async () => {
    const received: TeamMessage[] = [];
    listener = await startListener(agentId, (message) => { received.push(message); });
    const text = "line one\nline two\n\u00e9\u4e2d\ud83d\ude00";
    await sendToAgent(makeMessage(agentId, { text }));
    expect(received[0].text).toBe(text);
  });
  it("delivers many concurrent messages", async () => {
    const received: string[] = [];
    listener = await startListener(agentId, (message) => { received.push(message.id); });
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    await Promise.all(ids.map((id) => sendToAgent(makeMessage(agentId, { id }))));
    expect(received.sort()).toEqual([...ids].sort());
  });
  it("rejects with RecipientUnreachableError when nothing listens", async () => {
    await expect(sendToAgent(makeMessage(agentId))).rejects.toBeInstanceOf(RecipientUnreachableError);
  });
  it("rejects after the listener closes", async () => {
    listener = await startListener(agentId, () => {});
    await listener.close(); listener = undefined;
    await expect(sendToAgent(makeMessage(agentId))).rejects.toBeInstanceOf(RecipientUnreachableError);
  });
  it("returns the handler error to the sender", async () => {
    listener = await startListener(agentId, () => { throw new Error("agent is shutting down"); });
    await expect(sendToAgent(makeMessage(agentId))).rejects.toThrow(/agent is shutting down/);
  });
  it("rejects a message addressed to a different agent", async () => {
    listener = await startListener(agentId, () => {});
    expect(await sendRaw(agentId, `${JSON.stringify(makeMessage(makeId()))}\n`)).toMatch(/^error:.*message is addressed/);
  });
  it("requires fromLabel to be a string", async () => {
    let calls = 0;
    listener = await startListener(agentId, () => { calls++; });
    const valid = makeMessage(agentId);
    expect(await sendRaw(agentId, `${JSON.stringify({ ...valid, fromLabel: undefined })}\n`)).toMatch(/^error:.*fromLabel/);
    expect(await sendRaw(agentId, `${JSON.stringify({ ...valid, fromLabel: 5 })}\n`)).toMatch(/^error:.*fromLabel/);
    expect(calls).toBe(0);
  });
  it("rejects malformed JSON and invalid fields without calling the handler", async () => {
    let calls = 0;
    listener = await startListener(agentId, () => { calls++; });
    expect(await sendRaw(agentId, "not json\n")).toMatch(/^error:/);
    expect(await sendRaw(agentId, `${JSON.stringify({ ...makeMessage(agentId), text: 5 })}\n`)).toMatch(/^error:.*text/);
    expect(await sendRaw(agentId, "null\n")).toMatch(/^error:/);
    expect(calls).toBe(0);
  });
  it("rejects an oversized message on the sender side", async () => {
    listener = await startListener(agentId, () => {});
    await expect(sendToAgent(makeMessage(agentId, { text: "x".repeat(MAX_MESSAGE_BYTES) }))).rejects.toThrow(/larger than/);
  });
  it("answers an oversized raw stream with an error", async () => {
    listener = await startListener(agentId, () => {});
    expect(await sendRaw(agentId, "x".repeat(MAX_MESSAGE_BYTES + 10))).toMatch(/^error:.*larger than/);
  });
  it("times out when the handler never finishes", async () => {
    listener = await startListener(agentId, () => new Promise<void>(() => {}));
    await expect(sendToAgent(makeMessage(agentId), 100)).rejects.toThrow(/Timed out/);
  });
  it("ignores probe connections that send no data", async () => {
    let calls = 0;
    listener = await startListener(agentId, () => { calls++; });
    expect(await isListening(agentId)).toBe(true);
    expect(calls).toBe(0);
  });
  it("reports isListening false for an agent without a socket", async () => {
    expect(await isListening(makeId())).toBe(false);
  });
  it("isSocketListening accepts the listener's raw address", async () => {
    listener = await startListener(agentId, () => {});
    expect(await isSocketListening(listener.path)).toBe(true);
  });
  it("isSocketListening reports false for an unused address", async () => {
    expect(await isSocketListening(agentSocketPath(makeId()))).toBe(false);
  });
  it("isSocketListening reports false after the listener closes", async () => {
    listener = await startListener(agentId, () => {});
    const address = listener.path;
    await listener.close(); listener = undefined;
    expect(await isSocketListening(address)).toBe(false);
  });
  it("replaces a stale socket file left by a dead process", async () => {
    listener = await startListener(agentId, () => {});
    const stale = agentSocketPath(agentId);
    await listener.close(); listener = undefined;
    if (process.platform !== "win32") fs.writeFileSync(stale, "stale");
    const received: string[] = [];
    listener = await startListener(agentId, (message) => { received.push(message.id); });
    await sendToAgent(makeMessage(agentId, { id: "fresh" }));
    expect(received).toEqual(["fresh"]);
  });
  posixOnly("creates the socket with mode 0600 inside a 0700 directory", async () => {
    listener = await startListener(agentId, () => {});
    expect(fs.statSync(agentSocketPath(agentId)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${registryDir()}/s`).mode & 0o777).toBe(0o700);
  });
  posixOnly("removes the socket file on close", async () => {
    listener = await startListener(agentId, () => {});
    const address = listener.path;
    await listener.close(); listener = undefined;
    expect(fs.existsSync(address)).toBe(false);
  });
  posixOnly("close does not delete a socket file that another process replaced", async () => {
    const first = await startListener(agentId, () => {});
    const address = first.path;
    listener = await startListener(agentId, () => {});
    await first.close();
    expect(fs.existsSync(address)).toBe(true);
    await expect(sendToAgent(makeMessage(agentId))).resolves.toBeUndefined();
  });
});

describe("waitForListener", () => {
  it("returns true once the agent starts listening", async () => {
    const agentId = makeId();
    const pending = waitForListener(agentId, 3000, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listener = await startListener(agentId, () => {});
    try { await expect(pending).resolves.toBe(true); } finally { await listener.close(); }
  });
  it("returns false when the agent never listens", async () => {
    await expect(waitForListener(makeId(), 150, 20)).resolves.toBe(false);
  });
});
