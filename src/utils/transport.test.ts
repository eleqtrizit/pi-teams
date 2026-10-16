import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamMessage } from "./models";
import { socketDir, socketPath } from "./paths";
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

function makeMessage(to: string, overrides: Partial<TeamMessage> = {}): TeamMessage {
  return {
    id: "abcd1234",
    from: "team-lead",
    to,
    subject: "subject",
    text: "body",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Write raw bytes to an agent socket and return everything the listener replies. */
function sendRaw(team: string, agent: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath(team, agent));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

describe("socket transport", () => {
  let team: string;
  let listener: MessageListener | undefined;

  beforeEach(() => {
    team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  });

  afterEach(async () => {
    await listener?.close();
    listener = undefined;
  });

  it("delivers a message and resolves after the handler ran", async () => {
    const received: TeamMessage[] = [];
    listener = await startListener(team, "worker", (m) => {
      received.push(m);
    });
    await sendToAgent(team, makeMessage("worker", { text: "hello" }));
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
  });

  it("preserves unicode and newlines in the body", async () => {
    const received: TeamMessage[] = [];
    listener = await startListener(team, "worker", (m) => {
      received.push(m);
    });
    const text = "line one\nline two\n\u00e9\u4e2d\ud83d\ude00";
    await sendToAgent(team, makeMessage("worker", { text }));
    expect(received[0].text).toBe(text);
  });

  it("delivers many concurrent messages", async () => {
    const received: string[] = [];
    listener = await startListener(team, "worker", (m) => {
      received.push(m.id);
    });
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    await Promise.all(ids.map((id) => sendToAgent(team, makeMessage("worker", { id }))));
    expect(received.sort()).toEqual([...ids].sort());
  });

  it("rejects with RecipientUnreachableError when nothing listens", async () => {
    await expect(sendToAgent(team, makeMessage("ghost"))).rejects.toBeInstanceOf(RecipientUnreachableError);
  });

  it("rejects after the listener closes", async () => {
    listener = await startListener(team, "worker", () => {});
    await listener.close();
    listener = undefined;
    await expect(sendToAgent(team, makeMessage("worker"))).rejects.toBeInstanceOf(RecipientUnreachableError);
  });

  it("returns the handler error to the sender", async () => {
    listener = await startListener(team, "worker", () => {
      throw new Error("agent is shutting down");
    });
    await expect(sendToAgent(team, makeMessage("worker"))).rejects.toThrow(/agent is shutting down/);
  });

  it("rejects a message addressed to a different agent", async () => {
    listener = await startListener(team, "worker", () => {});
    const reply = await sendRaw(team, "worker", `${JSON.stringify(makeMessage("someone-else"))}\n`);
    expect(reply).toMatch(/^error:.*someone-else/);
  });

  it("rejects malformed JSON and invalid fields without calling the handler", async () => {
    let calls = 0;
    listener = await startListener(team, "worker", () => {
      calls++;
    });
    expect(await sendRaw(team, "worker", "not json\n")).toMatch(/^error:/);
    expect(await sendRaw(team, "worker", `${JSON.stringify({ ...makeMessage("worker"), text: 5 })}\n`)).toMatch(
      /^error:.*text/,
    );
    expect(await sendRaw(team, "worker", "null\n")).toMatch(/^error:/);
    expect(calls).toBe(0);
  });

  it("rejects an oversized message on the sender side", async () => {
    listener = await startListener(team, "worker", () => {});
    const text = "x".repeat(MAX_MESSAGE_BYTES);
    await expect(sendToAgent(team, makeMessage("worker", { text }))).rejects.toThrow(/larger than/);
  });

  it("answers an oversized raw stream with an error", async () => {
    listener = await startListener(team, "worker", () => {});
    const reply = await sendRaw(team, "worker", "x".repeat(MAX_MESSAGE_BYTES + 10));
    expect(reply).toMatch(/^error:.*larger than/);
  });

  it("times out when the handler never finishes", async () => {
    listener = await startListener(team, "worker", () => new Promise<void>(() => {}));
    await expect(sendToAgent(team, makeMessage("worker"), 100)).rejects.toThrow(/Timed out/);
  });

  it("ignores probe connections that send no data", async () => {
    let calls = 0;
    listener = await startListener(team, "worker", () => {
      calls++;
    });
    expect(await isListening(team, "worker")).toBe(true);
    expect(calls).toBe(0);
  });

  it("reports isListening false for an agent without a socket", async () => {
    expect(await isListening(team, "ghost")).toBe(false);
  });

  it("isSocketListening accepts the listener's raw address", async () => {
    listener = await startListener(team, "worker", () => {});
    expect(await isSocketListening(listener.path)).toBe(true);
  });

  it("isSocketListening reports false for an address nothing listens on", async () => {
    const address = `${socketDir()}/nothing-here.sock`;
    expect(await isSocketListening(address)).toBe(false);
  });

  it("isSocketListening reports false after the listener closes", async () => {
    listener = await startListener(team, "worker", () => {});
    const address = listener.path;
    await listener.close();
    listener = undefined;
    expect(await isSocketListening(address)).toBe(false);
  });

  it("replaces a stale socket file left by a dead process", async () => {
    listener = await startListener(team, "worker", () => {});
    // Simulate a crash: drop the server's file but not through close().
    const stale = socketPath(team, "worker");
    await listener.close();
    listener = undefined;
    if (process.platform !== "win32") fs.writeFileSync(stale, "stale");
    const received: string[] = [];
    listener = await startListener(team, "worker", (m) => {
      received.push(m.id);
    });
    await sendToAgent(team, makeMessage("worker", { id: "fresh" }));
    expect(received).toEqual(["fresh"]);
  });

  posixOnly("creates the socket with mode 0600 inside a 0700 directory", async () => {
    listener = await startListener(team, "worker", () => {});
    expect(fs.statSync(socketPath(team, "worker")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(socketDir()).mode & 0o777).toBe(0o700);
  });

  posixOnly("removes the socket file on close", async () => {
    listener = await startListener(team, "worker", () => {});
    const address = listener.path;
    await listener.close();
    listener = undefined;
    expect(fs.existsSync(address)).toBe(false);
  });

  posixOnly("close does not delete a socket file that another process replaced", async () => {
    const first = await startListener(team, "worker", () => {});
    const address = first.path;
    // A second listener replaces the file, as a restarted agent would.
    listener = await startListener(team, "worker", () => {});
    await first.close();
    expect(fs.existsSync(address)).toBe(true);
    await expect(sendToAgent(team, makeMessage("worker"))).resolves.toBeUndefined();
  });
});

describe("waitForListener", () => {
  it("returns true once the agent starts listening", async () => {
    const team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const pending = waitForListener(team, "late", 3000, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listener = await startListener(team, "late", () => {});
    try {
      await expect(pending).resolves.toBe(true);
    } finally {
      await listener.close();
    }
  });

  it("returns false when the agent never listens", async () => {
    const team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await expect(waitForListener(team, "never", 150, 20)).resolves.toBe(false);
  });
});

describe("socketPath", () => {
  it("gives different agents different paths", () => {
    expect(socketPath("team", "a")).not.toBe(socketPath("team", "b"));
    expect(socketPath("team-a", "w")).not.toBe(socketPath("team-b", "w"));
  });

  it("does not let team and agent names collide across the separator", () => {
    expect(socketPath("ab", "c")).not.toBe(socketPath("a", "bc"));
  });

  it("stays short regardless of name length", () => {
    expect(socketPath("t".repeat(200), "a".repeat(200)).length).toBeLessThan(101);
  });

  it("rejects invalid names", () => {
    expect(() => socketPath("../etc", "a")).toThrow(/Invalid name/);
    expect(() => socketPath("team", "a/b")).toThrow(/Invalid name/);
  });
});
