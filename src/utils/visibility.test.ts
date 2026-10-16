import { describe, expect, it } from "vitest";
import { AgentKind, type AgentRecord } from "./models";
import { broadcastTargets, canMessage, visibleTo } from "./visibility";

let nextPid = 1;
const record = (over: Partial<AgentRecord> & Pick<AgentRecord, "id" | "kind">): AgentRecord => ({
  cwd: "/tmp",
  pid: nextPid++,
  startedAt: 0,
  ...over,
});

const leadA: AgentRecord = record({ id: "aaaaaaa1", kind: AgentKind.Lead, name: "lead-a" });
const leadB: AgentRecord = record({ id: "bbbbbbb1", kind: AgentKind.Lead, name: "lead-b" });
const workerA1: AgentRecord = record({
  id: "aaaaaaa2",
  kind: AgentKind.Teammate,
  leadId: leadA.id,
  name: "a1",
});
const workerA2: AgentRecord = record({
  id: "aaaaaaa3",
  kind: AgentKind.ReadonlyWorker,
  leadId: leadA.id,
  name: "a2",
});
const workerB1: AgentRecord = record({
  id: "bbbbbbb2",
  kind: AgentKind.Teammate,
  leadId: leadB.id,
  name: "b1",
});

const allRecords = [leadA, leadB, workerA1, workerA2, workerB1];

describe("visibleTo", () => {
  it("shows a lead every lead plus its own workers", () => {
    const visible = visibleTo(leadA, allRecords);
    expect(visible).toContainEqual(leadA);
    expect(visible).toContainEqual(leadB);
    expect(visible).toContainEqual(workerA1);
    expect(visible).toContainEqual(workerA2);
    expect(visible).not.toContainEqual(workerB1);
    expect(visible).toHaveLength(4);
  });

  it("never shows a lead another lead's workers", () => {
    expect(visibleTo(leadB, allRecords).map((r) => r.id)).toEqual(
      expect.arrayContaining([leadB.id, leadA.id, workerB1.id]),
    );
    expect(visibleTo(leadB, allRecords).map((r) => r.id)).not.toContain(workerA1.id);
  });

  it("shows a worker its lead and siblings only", () => {
    expect(visibleTo(workerA1, allRecords).map((r) => r.id)).toEqual(
      expect.arrayContaining([leadA.id, workerA1.id, workerA2.id]),
    );
    const ids = visibleTo(workerA1, allRecords).map((r) => r.id);
    expect(ids).not.toContain(leadB.id);
    expect(ids).not.toContain(workerB1.id);
    expect(ids).toHaveLength(3);
  });

  it("includes the viewer even when the viewer is missing from the records", () => {
    const orphanLead: AgentRecord = record({ id: "ccccccc1", kind: AgentKind.Lead });
    expect(visibleTo(orphanLead, [leadA, workerA1]).map((r) => r.id)).toEqual(
      expect.arrayContaining([leadA.id, orphanLead.id]),
    );

    const orphanWorker: AgentRecord = record({
      id: "ccccccc2",
      kind: AgentKind.Teammate,
      leadId: leadA.id,
    });
    expect(visibleTo(orphanWorker, [leadA, workerA1])).toContainEqual(orphanWorker);
  });

  it("shows a worker with no leadId only itself", () => {
    const stray: AgentRecord = record({ id: "ddddddd1", kind: AgentKind.Teammate });
    expect(visibleTo(stray, allRecords).map((r) => r.id)).toEqual([stray.id]);
  });

  it("returns the viewer alone for an empty registry", () => {
    expect(visibleTo(workerA1, [])).toEqual([workerA1]);
    expect(visibleTo(leadA, [])).toEqual([leadA]);
  });
});

describe("canMessage", () => {
  it("lets a lead message peer leads and its own workers", () => {
    expect(canMessage(leadA, leadB.id, allRecords)).toBe(true);
    expect(canMessage(leadA, workerA1.id, allRecords)).toBe(true);
    expect(canMessage(leadA, workerA2.id, allRecords)).toBe(true);
  });

  it("blocks a lead from messaging another lead's workers and itself", () => {
    expect(canMessage(leadA, workerB1.id, allRecords)).toBe(false);
    expect(canMessage(leadA, leadA.id, allRecords)).toBe(false);
  });

  it("lets a worker message its lead and siblings", () => {
    expect(canMessage(workerA1, leadA.id, allRecords)).toBe(true);
    expect(canMessage(workerA1, workerA2.id, allRecords)).toBe(true);
  });

  it("blocks a worker from other leads, their workers, itself, and unknown ids", () => {
    expect(canMessage(workerA1, leadB.id, allRecords)).toBe(false);
    expect(canMessage(workerA1, workerB1.id, allRecords)).toBe(false);
    expect(canMessage(workerA1, workerA1.id, allRecords)).toBe(false);
    expect(canMessage(workerA1, "zzzzzzz9", allRecords)).toBe(false);
  });
});

describe("broadcastTargets", () => {
  it("targets a lead's broadcast at its own workers only", () => {
    expect(broadcastTargets(leadA, allRecords)).toEqual([workerA1, workerA2]);
  });

  it("targets a worker's broadcast at its lead and siblings", () => {
    expect(broadcastTargets(workerA1, allRecords)).toEqual([leadA, workerA2]);
  });

  it("excludes the sender and other leads in every case", () => {
    const fromLeadB = broadcastTargets(leadB, allRecords);
    expect(fromLeadB).toEqual([workerB1]);
    expect(broadcastTargets(workerB1, allRecords)).toEqual([leadB]);
  });

  it("returns an empty list when the sender owns no workers or has no leadId", () => {
    expect(broadcastTargets(leadA, [leadA, leadB])).toEqual([]);
    const stray: AgentRecord = record({ id: "ddddddd1", kind: AgentKind.Teammate });
    expect(broadcastTargets(stray, allRecords)).toEqual([]);
  });

  it("returns an empty list for an empty registry", () => {
    expect(broadcastTargets(leadA, [])).toEqual([]);
    expect(broadcastTargets(workerA1, [])).toEqual([]);
  });
});

describe("orphan workers", () => {
  it("does not group workers that have no leadId", () => {
    const a = { id: "orphan01", kind: AgentKind.Teammate, cwd: "/a", pid: 1, startedAt: 1 };
    const b = { id: "orphan02", kind: AgentKind.Teammate, cwd: "/b", pid: 2, startedAt: 2 };
    expect(visibleTo(a, [a, b]).map((r) => r.id)).toEqual(["orphan01"]);
    expect(canMessage(a, "orphan02", [a, b])).toBe(false);
    expect(broadcastTargets(a, [a, b])).toEqual([]);
  });
});
