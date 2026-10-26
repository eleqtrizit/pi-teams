import { describe, expect, it } from "vitest";
import { formatAgentLine, pathDistance, sortAgentLines, type AgentEntry } from "./agentFormat";
import { AgentKind, AgentRecord, AgentStatus } from "./models";

const lead = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "abc12345",
  kind: AgentKind.Lead,
  cwd: "/repo",
  pid: 100,
  startedAt: 1000,
  ...overrides,
});

const worker = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "def67890",
  kind: AgentKind.Teammate,
  cwd: "/repo",
  pid: 200,
  leadId: "abc12345",
  name: "alice",
  startedAt: 2000,
  ...overrides,
});

describe("formatAgentLine", () => {
  it("renders an available lead", () => {
    expect(formatAgentLine(lead(), AgentStatus.Idling, "zzzz9999")).toBe(
      "Pi Agent in /repo: abc12345: Idling",
    );
  });

  it("renders an offline lead", () => {
    expect(formatAgentLine(lead(), AgentStatus.Offline, "zzzz9999")).toBe(
      "Pi Agent in /repo: abc12345: Offline",
    );
  });

  it("renders a named worker", () => {
    expect(formatAgentLine(worker(), AgentStatus.Idling, "zzzz9999")).toBe(
      "Worker alice in /repo: def67890: Idling",
    );
  });

  it("falls back to the id for an unnamed worker", () => {
    expect(formatAgentLine(worker({ name: undefined }), AgentStatus.Idling, "zzzz9999")).toBe(
      "Worker def67890 in /repo: def67890: Idling",
    );
  });

  it("marks the calling agent with (you)", () => {
    expect(formatAgentLine(worker(), AgentStatus.Idling, "def67890")).toBe(
      "Worker alice in /repo: def67890: Idling (you)",
    );
  });

  it("marks the calling lead with (you)", () => {
    expect(formatAgentLine(lead(), AgentStatus.Offline, "abc12345")).toBe(
      "Pi Agent in /repo: abc12345: Offline (you)",
    );
  });

  it("marks a readonly worker like any worker", () => {
    const rec = worker({ kind: AgentKind.ReadonlyWorker, name: "scout" });
    expect(formatAgentLine(rec, AgentStatus.Idling, "zzzz9999")).toBe(
      "Worker scout in /repo: def67890: Idling",
    );
  });
});

describe("pathDistance", () => {
  it("returns 0 for the same directory", () => {
    expect(pathDistance("/home/user/repos/pi", "/home/user/repos/pi")).toBe(0);
  });

  it("scores a direct subfolder as 1", () => {
    expect(pathDistance("/home/user/repos/pi", "/home/user/repos/pi/subfolder")).toBe(1);
  });

  it("scores a sibling under a shared parent as 2", () => {
    expect(pathDistance("/home/user/repos/pi", "/home/user/repos/other-directory")).toBe(2);
  });

  it("counts every hop up and down the tree", () => {
    expect(pathDistance("/home/user/some/folder/repos", "/home/user/repo2")).toBe(4);
  });

  it("sums both depths when no root is shared", () => {
    // /srv/app -> /opt/tool is ../../opt/tool: two hops up, two down.
    expect(pathDistance("/srv/app", "/opt/tool")).toBe(4);
  });

  it("ignores trailing slashes and dot segments", () => {
    expect(pathDistance("/home/user/repos/pi/", "/home/user/repos/pi/./sub")).toBe(1);
  });
});

describe("sortAgentLines", () => {
  const entry = (record: AgentRecord): AgentEntry => ({
    record,
    status: AgentStatus.Idling,
  });

  /** Empty stamp map: every agent falls back to its startedAt. */
  const online = (): ReadonlyMap<string, number> => new Map();

  it("returns empty for an empty list", () => {
    expect(sortAgentLines([], "/repo", online())).toEqual([]);
  });

  it("puts workers first, then peers by directory proximity", () => {
    const viewer = "/home/user/repos/pi";
    const subfolderLead = lead({ id: "aaaa0001", cwd: `${viewer}/sub`, startedAt: 100 });
    const siblingLead = lead({ id: "bbbb0002", cwd: "/home/user/repos/other", startedAt: 200 });
    const farLead = lead({ id: "cccc0003", cwd: "/home/user/repo2", startedAt: 300 });
    const peerLead = lead({ id: "dddd0004", cwd: viewer, startedAt: 400 });
    const bob = entry(worker({ id: "e0000005", name: "bob" }));

    const sorted = sortAgentLines(
      [entry(farLead), bob, entry(siblingLead), entry(subfolderLead), entry(peerLead)],
      viewer,
      online(),
    );

    expect(sorted.map((e) => e.record.id)).toEqual([
      "e0000005", // worker in the viewer's workspace
      "dddd0004", // distance 0
      "aaaa0001", // distance 1
      "bbbb0002", // distance 2
      "cccc0003", // distance 4
    ]);
  });

  it("breaks proximity ties by the most recent last-online time", () => {
    const viewer = "/repo";
    const stale = lead({ id: "aaaa0001", cwd: "/other/one", startedAt: 100 });
    const fresh = lead({ id: "bbbb0002", cwd: "/other/two", startedAt: 50 });
    const lastOnline = new Map([
      ["aaaa0001", 5000],
      ["bbbb0002", 6000],
    ]);

    // Fresh is stamped online later than stale, so it leads despite the
    // earlier startedAt.
    const sorted = sortAgentLines([entry(stale), entry(fresh)], viewer, lastOnline);

    expect(sorted.map((e) => e.record.id)).toEqual(["bbbb0002", "aaaa0001"]);
  });

  it("breaks last-online ties by the newest startedAt, then id", () => {
    const viewer = "/repo";
    const older = entry(lead({ id: "aaaa0001", cwd: "/repo", startedAt: 100 }));
    const newerTiedClock = entry(lead({ id: "cccc0003", cwd: "/repo", startedAt: 200 }));
    const newerSameClock = entry(lead({ id: "zzzz0002", cwd: "/repo", startedAt: 200 }));

    const sorted = sortAgentLines([older, newerTiedClock, newerSameClock], viewer, online());

    expect(sorted.map((e) => e.record.id)).toEqual(["cccc0003", "zzzz0002", "aaaa0001"]);
  });

  it("falls back to startedAt when no last-online stamp exists, newest first", () => {
    const viewer = "/repo";
    const early = entry(lead({ id: "aaaa0001", cwd: "/a", startedAt: 100 }));
    const late = entry(lead({ id: "bbbb0002", cwd: "/b", startedAt: 900 }));

    const sorted = sortAgentLines([early, late], viewer, online());

    expect(sorted.map((e) => e.record.id)).toEqual(["bbbb0002", "aaaa0001"]);
  });

  it("sorts unnamed workers by id within the worker group", () => {
    const sorted = sortAgentLines(
      [entry(worker({ id: "zzz", name: undefined })), entry(worker({ id: "aaa", name: undefined }))],
      "/repo",
      online(),
    );
    expect(sorted.map((e) => e.record.id)).toEqual(["aaa", "zzz"]);
  });

  it("does not mutate the input array", () => {
    const input = [entry(worker({ name: "zeta" })), entry(lead({ id: "aaaa0001" }))];
    const snapshot = [...input];
    sortAgentLines(input, "/repo", online());
    expect(input).toEqual(snapshot);
  });
});
