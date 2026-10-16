import { describe, expect, it } from "vitest";
import {
  countLiveWorkers,
  shouldGuideLead,
  shouldHoldWhileTeamActive,
  shouldReleaseRun,
} from "./hold";
import { AgentKind, AgentRecord } from "./models";

function leadRecord(): AgentRecord {
  return {
    id: "lead01",
    kind: AgentKind.Lead,
    cwd: "/",
    pid: 1,
    startedAt: 0,
  };
}

function workerRecord(id: string, pid: number, leadId: string = "lead01"): AgentRecord {
  return {
    id,
    kind: AgentKind.Teammate,
    cwd: "/",
    pid,
    leadId,
    name: id,
    startedAt: 0,
  };
}

function snapshot(
  workerCount: number,
  liveWorkerCount: number,
): { workerCount: number; liveWorkerCount: number } {
  return { workerCount, liveWorkerCount };
}

describe("shouldHoldWhileTeamActive", () => {
  it("does not hold for workers", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isWorker: true, ownWorkerCount: 1 }),
    ).toBe(false);
  });

  it("does not hold without own workers", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isWorker: false, ownWorkerCount: 0 }),
    ).toBe(false);
  });

  it("does not hold in sessions with dialog-capable UI", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: true, isWorker: false, ownWorkerCount: 1 }),
    ).toBe(false);
  });

  it("holds for the lead in a non-interactive session with own workers", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isWorker: false, ownWorkerCount: 2 }),
    ).toBe(true);
  });
});

describe("shouldGuideLead", () => {
  it("guides the lead in a non-interactive session", () => {
    expect(shouldGuideLead({ hasUI: false, isWorker: false })).toBe(true);
  });

  it("does not guide the lead when UI is available", () => {
    expect(shouldGuideLead({ hasUI: true, isWorker: false })).toBe(false);
  });

  it("does not guide workers", () => {
    expect(shouldGuideLead({ hasUI: false, isWorker: true })).toBe(false);
  });
});

describe("countLiveWorkers", () => {
  it("returns zero with no workers", () => {
    expect(countLiveWorkers([], () => true)).toBe(0);
  });

  it("returns zero when every worker is dead", () => {
    const workers = [workerRecord("alice", 1), workerRecord("bob", 2)];
    expect(countLiveWorkers(workers, () => false)).toBe(0);
  });

  it("counts the workers that are alive", () => {
    const workers = [workerRecord("alice", 1), workerRecord("bob", 2)];
    expect(countLiveWorkers(workers, (pid) => pid === 2)).toBe(1);
  });

  it("ignores lead records", () => {
    const workers = [leadRecord(), workerRecord("alice", 1)];
    expect(countLiveWorkers(workers, () => true)).toBe(1);
  });
});

describe("shouldReleaseRun", () => {
  it("releases immediately when there are no workers", () => {
    expect(shouldReleaseRun(snapshot(0, 0), 0)).toBe(true);
  });

  it("does not release while a worker is alive", () => {
    expect(shouldReleaseRun(snapshot(2, 1), 1)).toBe(false);
  });

  it("does not release on the first failed liveness check", () => {
    expect(shouldReleaseRun(snapshot(1, 0), 1)).toBe(false);
    expect(shouldReleaseRun(snapshot(1, 0), 2)).toBe(false);
  });

  it("releases after the failure threshold so booting workers survive", () => {
    expect(shouldReleaseRun(snapshot(1, 0), 3)).toBe(true);
  });
});
