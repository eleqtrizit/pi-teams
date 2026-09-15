import { describe, expect, it } from "vitest";
import {
  countLiveWorkers,
  shouldGuideLead,
  shouldHoldWhileTeamActive,
  shouldReleaseRun,
} from "./hold";
import { Member, TeamConfig } from "./models";

function leadMember(): Member {
  return {
    agentId: "team-lead@example",
    name: "team-lead",
    agentType: "lead",
    joinedAt: 0,
    tmuxPaneId: "",
    cwd: "/",
    subscriptions: [],
  };
}

function workerMember(name: string, paneId: string): Member {
  return {
    agentId: `${name}@example`,
    name,
    agentType: "teammate",
    joinedAt: 0,
    tmuxPaneId: paneId,
    cwd: "/",
    subscriptions: [],
  };
}

function configWith(members: Member[]): TeamConfig {
  return {
    name: "example",
    description: "",
    createdAt: 0,
    leadAgentId: "team-lead",
    leadSessionId: "session",
    members,
  };
}

function snapshot(
  teamExists: boolean,
  workerCount: number,
  liveWorkerCount: number,
): { teamExists: boolean; workerCount: number; liveWorkerCount: number } {
  return { teamExists, workerCount, liveWorkerCount };
}

describe("shouldHoldWhileTeamActive", () => {
  it("does not hold for teammates", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isTeammate: true, teamName: "example" }),
    ).toBe(false);
  });

  it("does not hold without an active team", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isTeammate: false, teamName: undefined }),
    ).toBe(false);
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isTeammate: false, teamName: "" }),
    ).toBe(false);
  });

  it("does not hold in sessions with dialog-capable UI", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: true, isTeammate: false, teamName: "example" }),
    ).toBe(false);
  });

  it("holds for the lead in a non-interactive session with a team", () => {
    expect(
      shouldHoldWhileTeamActive({ hasUI: false, isTeammate: false, teamName: "example" }),
    ).toBe(true);
  });
});

describe("shouldGuideLead", () => {
  it("guides the lead in a non-interactive session", () => {
    expect(shouldGuideLead({ hasUI: false, isTeammate: false })).toBe(true);
  });

  it("does not guide the lead when UI is available", () => {
    expect(shouldGuideLead({ hasUI: true, isTeammate: false })).toBe(false);
  });

  it("does not guide teammates", () => {
    expect(shouldGuideLead({ hasUI: false, isTeammate: true })).toBe(false);
  });
});

describe("countLiveWorkers", () => {
  it("returns zero for a team with no workers", () => {
    const config = configWith([leadMember()]);
    expect(countLiveWorkers(config, () => true)).toBe(0);
  });

  it("returns zero when every worker is dead", () => {
    const config = configWith([leadMember(), workerMember("alice", "1"), workerMember("bob", "2")]);
    expect(countLiveWorkers(config, () => false)).toBe(0);
  });

  it("counts the workers that are alive", () => {
    const config = configWith([leadMember(), workerMember("alice", "1"), workerMember("bob", "2")]);
    expect(countLiveWorkers(config, (member) => member.name === "bob")).toBe(1);
  });

  it("ignores liveness of the team-lead", () => {
    const config = configWith([leadMember()]);
    expect(
      countLiveWorkers(config, (member) => member.name === "team-lead"),
    ).toBe(0);
  });
});

describe("shouldReleaseRun", () => {
  it("releases when the team directory is gone", () => {
    expect(shouldReleaseRun(snapshot(false, 2, 2), 0)).toBe(true);
  });

  it("releases immediately when the team has no workers", () => {
    expect(shouldReleaseRun(snapshot(true, 0, 0), 0)).toBe(true);
  });

  it("does not release while a worker is alive", () => {
    expect(shouldReleaseRun(snapshot(true, 2, 1), 1)).toBe(false);
  });

  it("does not release on the first failed liveness check", () => {
    expect(shouldReleaseRun(snapshot(true, 1, 0), 1)).toBe(false);
    expect(shouldReleaseRun(snapshot(true, 1, 0), 2)).toBe(false);
  });

  it("releases after the failure threshold so booting workers survive", () => {
    expect(shouldReleaseRun(snapshot(true, 1, 0), 3)).toBe(true);
  });
});
