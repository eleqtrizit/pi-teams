import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROADCAST_RECIPIENT, broadcastMessage, sendPlainMessage } from "./messaging";
import { TeamMessage } from "./models";
import * as paths from "./paths";
import { MessageListener, RecipientUnreachableError, startListener } from "./transport";
import { vi } from "vitest";

/**
 * Tests use a real team config on disk and real sockets. Team names are
 * unique per test, so parallel test files never share a socket.
 */
describe("messaging over sockets", () => {
  let team: string;
  let configDir: string;
  let listeners: MessageListener[];

  /** Start a listener for one member and collect what it receives. */
  async function listen(agent: string): Promise<TeamMessage[]> {
    const received: TeamMessage[] = [];
    listeners.push(
      await startListener(team, agent, (m) => {
        received.push(m);
      }),
    );
    return received;
  }

  function writeConfig(...members: string[]): void {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ name: team, members: members.map((name) => ({ name })) }),
    );
  }

  beforeEach(() => {
    team = `t${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "msg-test-"));
    listeners = [];
    vi.spyOn(paths, "teamDir").mockReturnValue(configDir);
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(configDir, "config.json"));
  });

  afterEach(async () => {
    await Promise.all(listeners.map((l) => l.close()));
    vi.restoreAllMocks();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  describe("sendPlainMessage", () => {
    it("delivers a message with id, sender, recipient, subject, and body", async () => {
      writeConfig("alice", "bob");
      const received = await listen("bob");

      await sendPlainMessage(team, "alice", "bob", "Greeting", "Hello Bob!", "hi there");

      expect(received).toHaveLength(1);
      expect(received[0].id).toHaveLength(8);
      expect(received[0]).toMatchObject({
        from: "alice",
        to: "bob",
        subject: "Greeting",
        text: "Hello Bob!",
        summary: "hi there",
      });
      expect(Number.isNaN(Date.parse(received[0].timestamp))).toBe(false);
    });

    it("gives each message a different id", async () => {
      writeConfig("alice", "bob");
      const received = await listen("bob");
      await sendPlainMessage(team, "alice", "bob", "s", "one");
      await sendPlainMessage(team, "alice", "bob", "s", "two");
      expect(new Set(received.map((m) => m.id)).size).toBe(2);
    });

    it("keeps the order of sequential messages", async () => {
      writeConfig("alice", "bob");
      const received = await listen("bob");
      for (let i = 0; i < 20; i++) await sendPlainMessage(team, "alice", "bob", "s", `m${i}`);
      expect(received.map((m) => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    });

    it("rejects a recipient who is not a team member", async () => {
      writeConfig("alice");
      await expect(sendPlainMessage(team, "alice", "wrker", "s", "t")).rejects.toThrow(/not a member/);
    });

    it("rejects a message to a team that does not exist", async () => {
      await expect(sendPlainMessage(team, "a", "b", "s", "t")).rejects.toThrow(/not found/);
    });

    it("fails at once with RecipientUnreachableError when the member does not run", async () => {
      writeConfig("alice", "bob");
      await expect(sendPlainMessage(team, "alice", "bob", "s", "t")).rejects.toBeInstanceOf(
        RecipientUnreachableError,
      );
    });
  });

  describe("broadcastMessage", () => {
    it("exposes the broadcast recipient name", () => {
      expect(BROADCAST_RECIPIENT).toBe("all");
    });

    it("delivers to every member except the sender", async () => {
      writeConfig("sender", "member1", "member2");
      const senderInbox = await listen("sender");
      const first = await listen("member1");
      const second = await listen("member2");

      const result = await broadcastMessage(team, "sender", "Broadcast Subject", "broadcast text", "summary");

      expect(result.delivered.sort()).toEqual(["member1", "member2"]);
      expect(result.failed).toEqual([]);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ from: "sender", to: "member1", subject: "Broadcast Subject" });
      expect(second[0].to).toBe("member2");
      expect(senderInbox).toHaveLength(0);
    });

    it("reports members that cannot be reached and still delivers to the rest", async () => {
      writeConfig("sender", "up", "down");
      const upInbox = await listen("up");

      const result = await broadcastMessage(team, "sender", "s", "t");

      expect(result.delivered).toEqual(["up"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].name).toBe("down");
      expect(result.failed[0].reason).toMatch(/not reachable/);
      expect(upInbox).toHaveLength(1);
    });

    it("completes with no recipients", async () => {
      writeConfig("sender");
      await expect(broadcastMessage(team, "sender", "s", "t")).resolves.toEqual({ delivered: [], failed: [] });
    });

    it("rejects a team that does not exist", async () => {
      await expect(broadcastMessage(team, "a", "s", "t")).rejects.toThrow(/not found/);
    });
  });
});
