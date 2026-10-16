import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEAD_ALIAS,
  agentLabel,
  broadcastAgentMessage,
  resolveRecipient,
  sendAgentMessage,
} from "./messaging";
import { AgentKind, AgentRecord, TeamMessage } from "./models";
import { MessageListener, RecipientUnreachableError, startListener } from "./transport";

function lead(id: string, cwd: string): AgentRecord {
  return { id, kind: AgentKind.Lead, cwd, pid: 1, startedAt: 1 };
}

function worker(id: string, leadId: string, name: string, cwd = "/w/a"): AgentRecord {
  return { id, kind: AgentKind.Teammate, cwd, pid: 1, startedAt: 1, leadId, name };
}

const leadA = lead("leadaaaa", "/w/a");
const leadB = lead("leadbbbb", "/w/b");
const alice = worker("wrkeraa1", "leadaaaa", "alice");
const zoe = worker("wrkeraa2", "leadaaaa", "zoe");
const bob = worker("wrkerbb1", "leadbbbb", "bob", "/w/b");

/** Common registry: two leads, leadA owns alice and zoe, leadB owns bob. */
function registry(): AgentRecord[] {
  return [leadA, leadB, alice, zoe, bob];
}

/**
 * Tests run real socket listeners. `os.tmpdir` is mocked to a short temp
 * directory because socket paths must stay under 90 characters.
 */
describe("registry messaging", () => {
  let tmp: string;
  let listeners: MessageListener[];

  /** Start a listener for one agent id and collect what it receives. */
  async function listen(id: string): Promise<TeamMessage[]> {
    const received: TeamMessage[] = [];
    listeners.push(
      await startListener(id, (m) => {
        received.push(m);
      }),
    );
    return received;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "m"));
    vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
    listeners = [];
  });

  afterEach(async () => {
    await Promise.all(listeners.map((l) => l.close()));
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("agentLabel", () => {
    it("labels a lead by its directory", () => {
      expect(agentLabel(leadA)).toBe("Pi Agent in /w/a");
    });

    it("labels a named worker by name and directory", () => {
      expect(agentLabel(alice)).toBe("Worker alice in /w/a");
    });

    it("falls back to the id for an unnamed worker", () => {
      const unnamed: AgentRecord = { ...alice, id: "wrkeraa9", name: undefined };
      expect(agentLabel(unnamed)).toBe("Worker wrkeraa9 in /w/a");
    });
  });

  describe("resolveRecipient", () => {
    it("resolves a peer lead by id", () => {
      expect(resolveRecipient(leadA, "leadbbbb", registry())).toEqual(leadB);
    });

    it("resolves the alias for a worker sender to its own lead", () => {
      expect(resolveRecipient(alice, LEAD_ALIAS, registry())).toEqual(leadA);
    });

    it("resolves an own worker by id and by name", () => {
      expect(resolveRecipient(leadA, "wrkeraa1", registry())).toEqual(alice);
      expect(resolveRecipient(leadA, "alice", registry())).toEqual(alice);
    });

    it("rejects another lead's worker by id and by name", () => {
      expect(() => resolveRecipient(leadA, "wrkerbb1", registry())).toThrow(/not visible/);
      expect(() => resolveRecipient(leadA, "bob", registry())).toThrow(/not visible/);
    });

    it("rejects a worker sending to another lead", () => {
      expect(() => resolveRecipient(alice, "leadbbbb", registry())).toThrow(/not visible/);
    });

    it("rejects a worker sending to a non-sibling worker", () => {
      expect(() => resolveRecipient(alice, "wrkerbb1", registry())).toThrow(/not visible/);
    });

    it("rejects self-delivery", () => {
      expect(() => resolveRecipient(leadA, "leadaaaa", registry())).toThrow(/not visible/);
    });

    it("throws for an unknown id and an unknown name", () => {
      expect(() => resolveRecipient(leadA, "nope0001", registry())).toThrow(/Unknown recipient "nope0001"/);
      expect(() => resolveRecipient(leadA, "carol", registry())).toThrow(/Unknown recipient "carol"/);
    });

    it("resolves an 8-char lowercase worker name that looks like an id", () => {
      const reviewer = worker("wrkeraa9", "leadaaaa", "reviewer");
      expect(resolveRecipient(leadA, "reviewer", [...registry(), reviewer])).toEqual(reviewer);
    });

    it("throws and lists ids when a name matches several workers", () => {
      const alias = worker("wrkeraa3", "leadaaaa", "alice");
      const records = [leadA, leadB, alice, alias, zoe, bob];
      expect(() => resolveRecipient(leadA, "alice", records)).toThrow(
        /Ambiguous recipient "alice".*wrkeraa1, wrkeraa3/s,
      );
    });

    it("throws when a worker alias sender has no lead", () => {
      expect(() => resolveRecipient({ ...alice, leadId: undefined }, LEAD_ALIAS, registry())).toThrow(
        /no lead/,
      );
    });

    it("throws when the recipient string is the broadcast alias", () => {
      expect(() => resolveRecipient(alice, "all", registry())).toThrow(/broadcast/);
    });
  });

  describe("sendAgentMessage", () => {
    it("delivers lead to peer lead by id and returns the recipient", async () => {
      const inbox = await listen("leadbbbb");

      const resolved = await sendAgentMessage(leadA, "leadbbbb", "Greeting", "Hello!", "hi", registry());

      expect(resolved).toEqual(leadB);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].id).toHaveLength(8);
      expect(Number.isNaN(Date.parse(inbox[0].timestamp))).toBe(false);
      expect(inbox[0]).toMatchObject({
        from: "leadaaaa",
        to: "leadbbbb",
        fromLabel: "Pi Agent in /w/a",
        subject: "Greeting",
        text: "Hello!",
        summary: "hi",
      });
    });

    it("delivers lead to own worker by name", async () => {
      const inbox = await listen("wrkeraa1");

      await sendAgentMessage(leadA, "alice", "Task", "Work", undefined, registry());

      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        to: "wrkeraa1",
        fromLabel: "Pi Agent in /w/a",
        subject: "Task",
      });
    });

    it("delivers lead to own worker by id", async () => {
      const inbox = await listen("wrkeraa2");

      await sendAgentMessage(leadA, "wrkeraa2", "Task", "Work", undefined, registry());

      expect(inbox).toHaveLength(1);
      expect(inbox[0].to).toBe("wrkeraa2");
    });

    it("rejects a lead messaging another lead's worker by id and by name", async () => {
      await expect(sendAgentMessage(leadA, "wrkerbb1", "s", "t", undefined, registry())).rejects.toThrow(
        /not visible/,
      );
      await expect(sendAgentMessage(leadA, "bob", "s", "t", undefined, registry())).rejects.toThrow(
        /not visible/,
      );
    });

    it("delivers worker to its lead through the alias", async () => {
      const inbox = await listen("leadaaaa");

      await sendAgentMessage(alice, LEAD_ALIAS, "Report", "Done", undefined, registry());

      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        from: "wrkeraa1",
        to: "leadaaaa",
        fromLabel: "Worker alice in /w/a",
        subject: "Report",
      });
    });

    it("delivers worker to a sibling worker by name", async () => {
      const inbox = await listen("wrkeraa2");

      await sendAgentMessage(alice, "zoe", "s", "t", undefined, registry());

      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ from: "wrkeraa1", to: "wrkeraa2" });
    });

    it("rejects a worker messaging another lead", async () => {
      await expect(sendAgentMessage(alice, "leadbbbb", "s", "t", undefined, registry())).rejects.toThrow(
        /not visible/,
      );
    });

    it("suggests spawn_team_lead when the resolved lead is offline", async () => {
      const err = await sendAgentMessage(leadA, "leadbbbb", "s", "t", undefined, registry()).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RecipientUnreachableError);
      expect((err as Error).message).toMatch(/spawn_team_lead\(folder="\/w\/b"\)/);
    });

    it("does not suggest spawn_team_lead for an offline worker", async () => {
      const err = await sendAgentMessage(leadA, "zoe", "s", "t", undefined, registry()).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RecipientUnreachableError);
      expect((err as Error).message).toMatch(/not reachable/);
      expect((err as Error).message).not.toMatch(/spawn_team_lead/);
    });
  });

  describe("broadcastAgentMessage", () => {
    it("exposes the broadcast recipient name", () => {
      expect("all").toBe("all");
    });

    it("reaches only the lead's own workers, never peer leads or their workers", async () => {
      const aliceInbox = await listen("wrkeraa1");
      const zoeInbox = await listen("wrkeraa2");
      const leadBInbox = await listen("leadbbbb");
      const bobInbox = await listen("wrkerbb1");

      const result = await broadcastAgentMessage(leadA, "Status", "anything", "sum", registry());

      expect(result.delivered.map((r) => r.id).sort()).toEqual(["wrkeraa1", "wrkeraa2"]);
      expect(result.failed).toEqual([]);
      expect(aliceInbox).toHaveLength(1);
      expect(aliceInbox[0]).toMatchObject({
        from: "leadaaaa",
        to: "wrkeraa1",
        fromLabel: "Pi Agent in /w/a",
        subject: "Status",
        summary: "sum",
      });
      expect(zoeInbox[0].to).toBe("wrkeraa2");
      expect(leadBInbox).toHaveLength(0);
      expect(bobInbox).toHaveLength(0);
    });

    it("reaches the worker's own lead and siblings only", async () => {
      const leadAInbox = await listen("leadaaaa");
      const zoeInbox = await listen("wrkeraa2");
      const leadBInbox = await listen("leadbbbb");
      const bobInbox = await listen("wrkerbb1");

      const result = await broadcastAgentMessage(alice, "s", "t", undefined, registry());

      expect(result.delivered.map((r) => r.id).sort()).toEqual(["leadaaaa", "wrkeraa2"]);
      expect(result.failed).toEqual([]);
      expect(leadAInbox).toHaveLength(1);
      expect(leadAInbox[0].fromLabel).toBe("Worker alice in /w/a");
      expect(zoeInbox).toHaveLength(1);
      expect(leadBInbox).toHaveLength(0);
      expect(bobInbox).toHaveLength(0);
    });

    it("reports unreachable targets as failed and still delivers to the rest", async () => {
      const aliceInbox = await listen("wrkeraa1");

      const result = await broadcastAgentMessage(leadA, "s", "t", undefined, registry());

      expect(result.delivered.map((r) => r.id)).toEqual(["wrkeraa1"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].record.id).toBe("wrkeraa2");
      expect(result.failed[0].reason).toMatch(/not reachable/);
      expect(aliceInbox).toHaveLength(1);
    });

    it("completes with no targets", async () => {
      const result = await broadcastAgentMessage(leadA, "s", "t", undefined, [leadA, leadB]);
      expect(result).toEqual({ delivered: [], failed: [] });
    });
  });
});
