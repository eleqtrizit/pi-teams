import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  pendingReminder,
  appendMessage,
  readInbox,
  drainUndelivered,
  sendPlainMessage,
  broadcastMessage,
  needsReminderMessage,
  updateLastReminderTime,
  updateLastReportTime,
} from "./messaging";
import * as paths from "./paths";
import type { InboxMessage } from "./models";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-test-" + Date.now());

describe("Messaging Utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // Seed a minimal team config so sendPlainMessage's recipient validation passes.
    const inboxesDir = path.join(testDir, "inboxes");
    fs.mkdirSync(inboxesDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, "config.json"),
      JSON.stringify({
        name: "test-team",
        members: [{ name: "team-lead" }, { name: "worker-1" }, { name: "receiver" }, { name: "bob" }],
      }),
    );

    // Override paths to use testDir
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "inboxes", `${agentName}.json`);
    });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation((teamName) => {
      return path.join(testDir, "config.json");
    });
    vi.spyOn(paths, "lastReminderPath").mockImplementation(
      (teamName, agentName) => {
        return path.join(testDir, `${agentName}.lastReminder`);
      },
    );
    vi.spyOn(paths, "lastReportPath").mockImplementation(
      (teamName, agentName) => {
        return path.join(testDir, `${agentName}.lastReport`);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should append a message successfully", async () => {
    const msg = {
      id: "abc12345",
      from: "sender",
      to: "receiver",
      subject: "Test",
      text: "hello",
      timestamp: "now",
      delivered: false,
    };
    await appendMessage("test-team", "receiver", msg);

    const inbox = await readInbox("test-team", "receiver", false);
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toBe("hello");
    expect(inbox[0].subject).toBe("Test");
    expect(inbox[0].id).toBe("abc12345");
  });

  it("should handle concurrent appends (Stress Test)", async () => {
    const numMessages = 100;
    const promises = [];
    for (let i = 0; i < numMessages; i++) {
      promises.push(
        sendPlainMessage(
          "test-team",
          `sender-${i}`,
          "receiver",
          `subject-${i}`,
          `msg-${i}`,
          `summary-${i}`,
        ),
      );
    }

    await Promise.all(promises);

    const inbox = await readInbox("test-team", "receiver", false);
    expect(inbox.length).toBe(numMessages);

    // Verify all messages are present
    const texts = inbox.map((m) => m.text).sort();
    for (let i = 0; i < numMessages; i++) {
      expect(texts).toContain(`msg-${i}`);
    }
  });

  it("should not lose or double-deliver messages under concurrent drain-vs-append", async () => {
    // Exercises the central atomicity claim: drainUndelivered reads + marks
    // delivered under the same lock appendMessage acquires, so a concurrent
    // append cannot interleave between the read and the mark/write.
    const numMessages = 50;
    const drainedBatches: InboxMessage[][] = [];

    // Appenders and drainers run concurrently. Drainers keep draining until
    // all appends have settled and the inbox is fully drained.
    const appenders = Array.from({ length: numMessages }, (_, i) =>
      sendPlainMessage(
        "test-team",
        `sender-${i}`,
        "receiver",
        `subject-${i}`,
        `msg-${i}`,
        `summary-${i}`,
      ),
    );

    // Spawn a drainer that loops until appends resolve and nothing is left.
    const drainer = (async () => {
      while (true) {
        const batch = await drainUndelivered("test-team", "receiver");
        if (batch.length > 0) drainedBatches.push(batch);
        // Stop once the inbox is empty AND all appenders have at least started.
        const remaining = await readInbox("test-team", "receiver", true);
        if (remaining.length === 0) {
          // Yield to let any in-flight append land, then re-check.
          await new Promise((r) => setTimeout(r, 5));
          const recheck = await readInbox("test-team", "receiver", true);
          if (recheck.length === 0) break;
        }
      }
    })();

    await Promise.all(appenders);
    // Appends have settled; drain whatever landed after the loop exited.
    const finalBatch = await drainUndelivered("test-team", "receiver");
    if (finalBatch.length > 0) drainedBatches.push(finalBatch);
    await drainer;

    // Collect every delivered message ID across all batches.
    const deliveredIds = drainedBatches.flat().map((m) => m.id);
    const deliveredSet = new Set(deliveredIds);

    // No message was delivered twice (no duplicate IDs across batches).
    expect(deliveredIds.length).toBe(deliveredSet.size);

    // Every message was delivered exactly once (no losses).
    const allInbox = await readInbox("test-team", "receiver", false);
    expect(allInbox.length).toBe(numMessages);
    const inboxIds = new Set(allInbox.map((m) => m.id));
    expect(inboxIds.size).toBe(deliveredSet.size);
    for (const id of inboxIds) expect(deliveredSet.has(id)).toBe(true);

    // Every message in the inbox is now marked delivered.
    expect(allInbox.every((m) => m.delivered)).toBe(true);
  });

  it("should drain undelivered messages and mark them delivered", async () => {
    await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "Subject 1",
      "msg1",
      "summary1",
    );
    await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "Subject 2",
      "msg2",
      "summary2",
    );

    const drained = await drainUndelivered("test-team", "receiver");
    expect(drained.length).toBe(2);
    expect(drained[0].text).toBe("msg1");
    expect(drained[1].text).toBe("msg2");
    expect(drained[0].delivered).toBe(true);
    expect(drained[1].delivered).toBe(true);

    // A second drain returns nothing
    const drainedAgain = await drainUndelivered("test-team", "receiver");
    expect(drainedAgain.length).toBe(0);

    // The inbox still holds the messages, now all delivered
    const all = await readInbox("test-team", "receiver", false);
    expect(all.length).toBe(2);
    expect(all.every((m) => m.delivered)).toBe(true);

    // Undelivered-only view is now empty
    const undelivered = await readInbox("test-team", "receiver", true);
    expect(undelivered.length).toBe(0);
  });

  it("should return only undelivered messages when undeliveredOnly is true", async () => {
    await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "Subject 1",
      "msg1",
      "summary1",
    );
    await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "Subject 2",
      "msg2",
      "summary2",
    );

    // Drain marks both as delivered
    await drainUndelivered("test-team", "receiver");

    // A new message arrives after the drain
    await sendPlainMessage(
      "test-team",
      "sender",
      "receiver",
      "Subject 3",
      "msg3",
      "summary3",
    );

    const undelivered = await readInbox("test-team", "receiver", true);
    expect(undelivered.length).toBe(1);
    expect(undelivered[0].text).toBe("msg3");
  });

  it("should return an empty array when draining an empty inbox", async () => {
    const drained = await drainUndelivered("test-team", "nobody");
    expect(drained).toEqual([]);
  });

  it("should broadcast message to all members except the sender", async () => {
    // Setup team config
    const config = {
      name: "test-team",
      members: [{ name: "sender" }, { name: "member1" }, { name: "member2" }],
    };
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify(config));

    await broadcastMessage(
      "test-team",
      "sender",
      "Broadcast Subject",
      "broadcast text",
      "summary",
    );

    // Check member1's inbox
    const inbox1 = await readInbox("test-team", "member1", false);
    expect(inbox1.length).toBe(1);
    expect(inbox1[0].text).toBe("broadcast text");
    expect(inbox1[0].from).toBe("sender");
    expect(inbox1[0].subject).toBe("Broadcast Subject");

    // Check member2's inbox
    const inbox2 = await readInbox("test-team", "member2", false);
    expect(inbox2.length).toBe(1);
    expect(inbox2[0].text).toBe("broadcast text");
    expect(inbox2[0].from).toBe("sender");
    expect(inbox2[0].subject).toBe("Broadcast Subject");

    // Check sender's inbox (should be empty)
    const inboxSender = await readInbox("test-team", "sender", false);
    expect(inboxSender.length).toBe(0);
  });

  it("should complete a broadcast even with no recipients", async () => {
    const config = {
      name: "test-team",
      members: [{ name: "sender" }],
    };
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify(config));

    await broadcastMessage(
      "test-team",
      "sender",
      "Broadcast Subject",
      "broadcast text",
      "summary",
    );

    // The only member is the sender, so nothing is delivered.
    expect(fs.existsSync(path.join(testDir, "inboxes", "team-lead.json"))).toBe(false);
  });

  it("should include id and subject in messages created by sendPlainMessage", async () => {
    await sendPlainMessage(
      "test-team",
      "alice",
      "bob",
      "Greeting",
      "Hello Bob!",
      "hi there",
    );

    const inbox = await readInbox("test-team", "bob", false);
    expect(inbox.length).toBe(1);
    expect(inbox[0].id).toBeDefined();
    expect(inbox[0].id.length).toBe(8);
    expect(inbox[0].subject).toBe("Greeting");
    expect(inbox[0].from).toBe("alice");
    expect(inbox[0].to).toBe("bob");
    expect(inbox[0].text).toBe("Hello Bob!");
    expect(inbox[0].delivered).toBe(false);
  });

  describe("needsReminderMessage", () => {
    it("should return false when there are no team-lead instructions", () => {
      const result = needsReminderMessage("test-team", "worker", null, false);
      expect(result).toBe(false);
    });

    it("should return false when instructions are not yet delivered", () => {
      const result = needsReminderMessage(
        "test-team",
        "worker",
        Date.now(),
        true,
      );
      expect(result).toBe(false);
    });

    it("should return true when instructions are delivered and agent never responded", () => {
      const ts = Date.now();
      const result = needsReminderMessage("test-team", "worker", ts, false);
      expect(result).toBe(true);
    });

    it("should return true when last report was before the latest instruction", () => {
      const instructionTs = Date.now();
      const responseTs = instructionTs - 60_000;

      // Write last report time to simulate earlier response to team-lead
      const lastReportFilePath = (paths as any).lastReportPath(
        "test-team",
        "worker",
      );
      fs.writeFileSync(lastReportFilePath, responseTs.toString());

      const result = needsReminderMessage(
        "test-team",
        "worker",
        instructionTs,
        false,
      );
      expect(result).toBe(true);
    });

    it("should return false when agent reported to team-lead after instructions", () => {
      const instructionTs = Date.now() - 120_000;
      updateLastReportTime("test-team", "worker");

      const result = needsReminderMessage(
        "test-team",
        "worker",
        instructionTs,
        false,
      );
      expect(result).toBe(false);
    });

    it("should return true when agent sent message to peer but not to team-lead", () => {
      const instructionTs = Date.now() - 120_000;
      // A peer message no longer exists as state; without a report to the
      // team-lead after the instruction, a reminder is due.

      const result = needsReminderMessage(
        "test-team",
        "worker",
        instructionTs,
        false,
      );
      expect(result).toBe(true);
    });

    it("should return false when a reminder was already sent for the latest instruction", () => {
      const instructionTs = Date.now() - 60_000;
      updateLastReminderTime("test-team", "worker");

      const result = needsReminderMessage(
        "test-team",
        "worker",
        instructionTs,
        false,
      );
      expect(result).toBe(false);
    });

    it("should return false when a reminder was sent long ago but after the latest instruction", () => {
      const instructionTs = Date.now() - 120_000;
      const lastReminderFilePath = (paths as any).lastReminderPath(
        "test-team",
        "worker",
      );
      fs.writeFileSync(
        lastReminderFilePath,
        (instructionTs + 60_000).toString(),
      );

      const result = needsReminderMessage(
        "test-team",
        "worker",
        instructionTs,
        false,
      );
      expect(result).toBe(false);
    });

    it("should return true after new instructions arrive (beyond previous reminder cycle)", () => {
      // Simulate a past cycle: old instructions delivered, agent responded, reminder sent
      updateLastReminderTime("test-team", "worker");
      const lastReportFilePath = (paths as any).lastReportPath(
        "test-team",
        "worker",
      );
      fs.writeFileSync(lastReportFilePath, (Date.now() - 60_000).toString());

      // New instructions arrive well after the previous cycle ended
      const newInstructionTs = Date.now() + 10_000;
      const result = needsReminderMessage(
        "test-team",
        "worker",
        newInstructionTs,
        false,
      );
      expect(result).toBe(true);
    });
  });
});

describe("sendPlainMessage validation", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, "inboxes"), { recursive: true });
    vi.spyOn(paths, "inboxPath").mockImplementation((_t, a) => path.join(testDir, "inboxes", `${a}.json`));
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation(() => path.join(testDir, "config.json"));
    vi.spyOn(paths, "lastReportPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReport`));
    vi.spyOn(paths, "lastReminderPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReminder`));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("rejects a recipient who is not a team member", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({ name: "test-team", members: [{ name: "worker-1" }] }));
    await expect(sendPlainMessage("test-team", "worker-1", "wrker-1", "s", "t")).rejects.toThrow(/not a member/);
    expect(fs.existsSync(path.join(testDir, "inboxes", "wrker-1.json"))).toBe(false);
  });

  it("rejects a message to a team that does not exist", async () => {
    await expect(sendPlainMessage("ghost-team", "a", "b", "s", "t")).rejects.toThrow(/not found/);
    expect(fs.existsSync(path.join(testDir, "ghost-team"))).toBe(false);
  });

  it("still delivers to a valid member", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({ name: "test-team", members: [{ name: "worker-1" }] }));
    await sendPlainMessage("test-team", "team-lead", "worker-1", "s", "t");
    const inbox = JSON.parse(fs.readFileSync(path.join(testDir, "inboxes", "worker-1.json"), "utf-8"));
    expect(inbox).toHaveLength(1);
  });
});

describe("pendingReminder", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, "inboxes"), { recursive: true });
    vi.spyOn(paths, "inboxPath").mockImplementation((_t, a) => path.join(testDir, "inboxes", `${a}.json`));
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation(() => path.join(testDir, "config.json"));
    vi.spyOn(paths, "lastReportPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReport`));
    vi.spyOn(paths, "lastReminderPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReminder`));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  const seed = async (messages: Partial<InboxMessage>[]) => {
    fs.writeFileSync(
      path.join(testDir, "inboxes", "worker.json"),
      JSON.stringify(
        messages.map((m, i) => ({
          id: `id-${i}`,
          from: "team-lead",
          to: "worker",
          subject: "s",
          text: "t",
          timestamp: new Date(Date.now() - 120000 + i * 1000).toISOString(),
          delivered: true,
          ...m,
        })),
      ),
    );
  };

  it("returns null when there are no team-lead messages", async () => {
    await seed([{ from: "peer" }]);
    expect(await pendingReminder("test-team", "worker")).toBeNull();
  });

  it("returns the reminder text and stamps the reminder time when due", async () => {
    await appendMessage("test-team", "worker", {
      id: "i1", from: "team-lead", to: "worker", subject: "s", text: "t",
      timestamp: new Date(Date.now() - 60000).toISOString(), delivered: true,
    });
    const result = await pendingReminder("test-team", "worker");
    expect(result).toContain("Report back to the team-lead");
    // Stamped: a second call returns null (one reminder per instruction).
    expect(await pendingReminder("test-team", "worker")).toBeNull();
  });

  it("returns null when the agent already reported after the instruction", async () => {
    await appendMessage("test-team", "worker", {
      id: "i1", from: "team-lead", to: "worker", subject: "s", text: "t",
      timestamp: new Date(Date.now() - 120000).toISOString(), delivered: true,
    });
    updateLastReportTime("test-team", "worker");
    expect(await pendingReminder("test-team", "worker")).toBeNull();
  });
});

describe("drainUndelivered pruning", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, "inboxes"), { recursive: true });
    vi.spyOn(paths, "inboxPath").mockImplementation((_t, a) => path.join(testDir, "inboxes", `${a}.json`));
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation(() => path.join(testDir, "config.json"));
    vi.spyOn(paths, "lastReportPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReport`));
    vi.spyOn(paths, "lastReminderPath").mockImplementation((_t, a) => path.join(testDir, `${a}.lastReminder`));
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({ name: "t", members: [{ name: "worker" }] }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("prunes old delivered messages but keeps the newest team-lead message and undelivered ones", async () => {
    for (let i = 0; i < 60; i++) {
      await appendMessage("test-team", "worker", {
        id: `m${i}`,
        from: i === 0 ? "team-lead" : "peer",
        to: "worker",
        subject: "s",
        text: "t",
        timestamp: new Date(Date.now() - 600000 + i * 1000).toISOString(),
        delivered: true,
      });
    }
    // One undelivered message that must survive pruning.
    await appendMessage("test-team", "worker", {
      id: "undelivered", from: "peer", to: "worker", subject: "s", text: "t",
      timestamp: new Date().toISOString(), delivered: false,
    });
    const drained = await drainUndelivered("test-team", "worker");
    expect(drained).toHaveLength(1);

    const all = JSON.parse(fs.readFileSync(path.join(testDir, "inboxes", "worker.json"), "utf-8"));
    expect(all.length).toBeLessThanOrEqual(51);
    expect(all.some((m: InboxMessage) => m.id === "m0")).toBe(true); // newest team-lead kept
    expect(all.some((m: InboxMessage) => m.id === "undelivered")).toBe(true);
  });
});
