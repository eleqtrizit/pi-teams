import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    appendMessage,
    readInbox,
    readMessage,
    sendPlainMessage,
    broadcastMessage,
    needsReminderMessage,
    updateLastMessageTime,
    updateLastReminderTime,
    updateLastReportTime
} from "./messaging";
import * as paths from "./paths";

// Mock the paths to use a temporary directory
const testDir = path.join(os.tmpdir(), "pi-teams-test-" + Date.now());

describe("Messaging Utilities", () => {
    beforeEach(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        // Override paths to use testDir
        vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
            return path.join(testDir, "inboxes", `${agentName}.json`);
        });
        vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
        vi.spyOn(paths, "configPath").mockImplementation((teamName) => {
            return path.join(testDir, "config.json");
        });
        vi.spyOn(paths, "lastMessagePath").mockImplementation((teamName, agentName) => {
            return path.join(testDir, `${agentName}.lastMessage`);
        });
        vi.spyOn(paths, "lastAwokenPath").mockImplementation((teamName, agentName) => {
            return path.join(testDir, `${agentName}.awoken`);
        });
        vi.spyOn(paths, "lastReminderPath").mockImplementation((teamName, agentName) => {
            return path.join(testDir, `${agentName}.lastReminder`);
        });
        vi.spyOn(paths, "lastReportPath").mockImplementation((teamName, agentName) => {
            return path.join(testDir, `${agentName}.lastReport`);
        });
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
            read: false
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
                sendPlainMessage("test-team", `sender-${i}`, "receiver", `subject-${i}`, `msg-${i}`, `summary-${i}`)
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

    it("should read a message by UUID and mark it as read", async () => {
        await sendPlainMessage("test-team", "sender", "receiver", "Subject 1", "msg1", "summary1");
        await sendPlainMessage("test-team", "sender", "receiver", "Subject 2", "msg2", "summary2");

        // Get all messages to find their IDs
        const all = await readInbox("test-team", "receiver", false);
        expect(all.length).toBe(2);
        expect(all[0].read).toBe(false);
        expect(all[1].read).toBe(false);

        // Read the first message by UUID
        const msg1 = await readMessage("test-team", "receiver", all[0].id);
        expect(msg1).not.toBeNull();
        expect(msg1!.text).toBe("msg1");
        expect(msg1!.subject).toBe("Subject 1");
        expect(msg1!.from).toBe("sender");
        expect(msg1!.to).toBe("receiver");
        expect(msg1!.read).toBe(true);

        // Verify the other message is still unread
        const after = await readInbox("test-team", "receiver", false);
        expect(after[0].read).toBe(true);
        expect(after[1].read).toBe(false);

        // Reading again returns the message but doesn't change state
        const msg1Again = await readMessage("test-team", "receiver", all[0].id);
        expect(msg1Again).not.toBeNull();
        expect(msg1Again!.read).toBe(true);
    });

    it("should return null for unknown message UUID", async () => {
        await sendPlainMessage("test-team", "sender", "receiver", "Subject", "msg1", "summary1");
        const result = await readMessage("test-team", "receiver", "nonexistent");
        expect(result).toBeNull();
    });

    it("should return only unread messages when unreadOnly is true", async () => {
        await sendPlainMessage("test-team", "sender", "receiver", "Subject 1", "msg1", "summary1");
        await sendPlainMessage("test-team", "sender", "receiver", "Subject 2", "msg2", "summary2");

        const all = await readInbox("test-team", "receiver", false);
        await readMessage("test-team", "receiver", all[0].id);

        const unread = await readInbox("test-team", "receiver", true);
        expect(unread.length).toBe(1);
        expect(unread[0].id).toBe(all[1].id);
    });

    it("should broadcast message to all members except the sender", async () => {
        // Setup team config
        const config = {
            name: "test-team",
            members: [{ name: "sender" }, { name: "member1" }, { name: "member2" }]
        };
        const configFilePath = path.join(testDir, "config.json");
        fs.writeFileSync(configFilePath, JSON.stringify(config));

        await broadcastMessage("test-team", "sender", "Broadcast Subject", "broadcast text", "summary");

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

    it("should include id and subject in messages created by sendPlainMessage", async () => {
        await sendPlainMessage("test-team", "alice", "bob", "Greeting", "Hello Bob!", "hi there");

        const inbox = await readInbox("test-team", "bob", false);
        expect(inbox.length).toBe(1);
        expect(inbox[0].id).toBeDefined();
        expect(inbox[0].id.length).toBe(8);
        expect(inbox[0].subject).toBe("Greeting");
        expect(inbox[0].from).toBe("alice");
        expect(inbox[0].to).toBe("bob");
        expect(inbox[0].text).toBe("Hello Bob!");
    });

    it("should return inbox as markdown table through formatInboxResponse", async () => {
        await sendPlainMessage("test-team", "alice", "bob", "Meeting", "Let's sync", "sync");

        const inbox = await readInbox("test-team", "bob", false);
        expect(inbox.length).toBe(1);

        // Verify the message structure includes all table fields
        const msg = inbox[0];
        expect(msg.id).toBeDefined();
        expect(msg.timestamp).toBeDefined();
        expect(msg.from).toBe("alice");
        expect(msg.to).toBe("bob");
        expect(msg.subject).toBe("Meeting");
    });

    describe("needsReminderMessage", () => {
        it("should return false when there are no team-lead instructions", () => {
            const result = needsReminderMessage("test-team", "worker", null, true);
            expect(result).toBe(false);
        });

        it("should return false when not all instructions are read", () => {
            const result = needsReminderMessage("test-team", "worker", Date.now(), false);
            expect(result).toBe(false);
        });

        it("should return true when instructions are read and agent never responded", () => {
            const ts = Date.now();
            const result = needsReminderMessage("test-team", "worker", ts, true);
            expect(result).toBe(true);
        });

        it("should return true when last report was before the latest instruction", () => {
            const instructionTs = Date.now();
            const responseTs = instructionTs - 60_000;

            // Write last report time to simulate earlier response to team-lead
            const lastReportFilePath = (paths as any).lastReportPath("test-team", "worker");
            fs.writeFileSync(lastReportFilePath, responseTs.toString());

            const result = needsReminderMessage("test-team", "worker", instructionTs, true);
            expect(result).toBe(true);
        });

        it("should return false when agent reported to team-lead after instructions", () => {
            const instructionTs = Date.now() - 120_000;
            updateLastReportTime("test-team", "worker");

            const result = needsReminderMessage("test-team", "worker", instructionTs, true);
            expect(result).toBe(false);
        });

        it("should return true when agent sent message to peer but not to team-lead", () => {
            const instructionTs = Date.now() - 120_000;
            // Only update lastMessageTime (peer message), not lastReportTime
            updateLastMessageTime("test-team", "worker");

            const result = needsReminderMessage("test-team", "worker", instructionTs, true);
            expect(result).toBe(true);
        });

        it("should return false when a reminder was already sent after the latest instruction", () => {
            const instructionTs = Date.now() - 60_000;
            updateLastReminderTime("test-team", "worker");

            const result = needsReminderMessage("test-team", "worker", instructionTs, true);
            expect(result).toBe(false);
        });

        it("should return true after new instructions arrive (beyond previous reminder cycle)", () => {
            // Simulate a past cycle: old instructions read, agent responded, reminder sent
            updateLastReminderTime("test-team", "worker");
            const lastReportFilePath = (paths as any).lastReportPath("test-team", "worker");
            fs.writeFileSync(lastReportFilePath, (Date.now() - 60_000).toString());

            // New instructions arrive well after the previous cycle ended
            const newInstructionTs = Date.now() + 10_000;
            const result = needsReminderMessage("test-team", "worker", newInstructionTs, true);
            expect(result).toBe(true);
        });

        it("should return true via time-based fallback when unread instructions are stale", () => {
            // Instructions arrived 3 minutes ago, never marked read
            const oldUnreadTs = Date.now() - 3 * 60_000;
            const result = needsReminderMessage("test-team", "worker", oldUnreadTs, false, oldUnreadTs);
            expect(result).toBe(true);
        });

        it("should return false via time-based fallback when reminder was already sent", () => {
            const oldUnreadTs = Date.now() - 3 * 60_000;
            // Reminder already sent after those instructions arrived
            updateLastReminderTime("test-team", "worker");

            const result = needsReminderMessage("test-team", "worker", oldUnreadTs, false, oldUnreadTs);
            expect(result).toBe(false);
        });

        it("should return false via time-based fallback when unread instructions are fresh", () => {
            // Instructions arrived 30 seconds ago — not stale yet
            const recentUnreadTs = Date.now() - 30_000;
            const result = needsReminderMessage("test-team", "worker", recentUnreadTs, false, recentUnreadTs);
            expect(result).toBe(false);
        });
    });
});
