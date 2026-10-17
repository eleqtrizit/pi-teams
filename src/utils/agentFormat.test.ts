import { describe, expect, it } from "vitest";
import { formatAgentLine, sortAgentLines, type AgentEntry } from "./agentFormat";
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
    expect(formatAgentLine(lead(), AgentStatus.Available, "zzzz9999")).toBe(
      "Pi Agent in /repo: abc12345: Available",
    );
  });

  it("renders an offline lead", () => {
    expect(formatAgentLine(lead(), AgentStatus.Offline, "zzzz9999")).toBe(
      "Pi Agent in /repo: abc12345: Offline",
    );
  });

  it("renders a named worker", () => {
    expect(formatAgentLine(worker(), AgentStatus.Available, "zzzz9999")).toBe(
      "Worker alice in /repo: def67890: Available",
    );
  });

  it("falls back to the id for an unnamed worker", () => {
    expect(formatAgentLine(worker({ name: undefined }), AgentStatus.Available, "zzzz9999")).toBe(
      "Worker def67890 in /repo: def67890: Available",
    );
  });

  it("marks the calling agent with (you)", () => {
    expect(formatAgentLine(worker(), AgentStatus.Available, "def67890")).toBe(
      "Worker alice in /repo: def67890: Available (you)",
    );
  });

  it("marks the calling lead with (you)", () => {
    expect(formatAgentLine(lead(), AgentStatus.Offline, "abc12345")).toBe(
      "Pi Agent in /repo: abc12345: Offline (you)",
    );
  });

  it("marks a readonly worker like any worker", () => {
    const rec = worker({ kind: AgentKind.ReadonlyWorker, name: "scout" });
    expect(formatAgentLine(rec, AgentStatus.Available, "zzzz9999")).toBe(
      "Worker scout in /repo: def67890: Available",
    );
  });
});

describe("sortAgentLines", () => {
  const entry = (record: AgentRecord): AgentEntry => ({
    record,
    status: AgentStatus.Available,
  });

  it("returns empty for an empty list", () => {
    expect(sortAgentLines([])).toEqual([]);
  });

  it("puts leads first, sorted by cwd then startedAt, then workers by name", () => {
    const lateLeadInB = lead({ id: "lead02", cwd: "/b", startedAt: 900 });
    const earlyLeadInB = lead({ id: "lead01", cwd: "/b", startedAt: 100 });
    const leadInA = lead({ id: "lead00", cwd: "/a", startedAt: 500 });
    const carol = entry(worker({ id: "c0000003", name: "carol" }));
    const alice = entry(worker({ id: "a0000001", name: "alice" }));
    const bob = entry(worker({ id: "b0000002", name: "bob", startedAt: 10 }));

    const sorted = sortAgentLines([
      carol,
      entry(lateLeadInB),
      bob,
      entry(leadInA),
      alice,
      entry(earlyLeadInB),
    ]);

    expect(sorted.map((e) => e.record.id)).toEqual([
      "lead00", // cwd /a
      "lead01", // cwd /b, earlier startedAt
      "lead02",
      "a0000001", // alice
      "b0000002", // bob
      "c0000003", // carol
    ]);
  });

  it("sorts unnamed workers by their id", () => {
    const sorted = sortAgentLines([
      entry(worker({ id: "zzz", name: undefined })),
      entry(worker({ id: "aaa", name: undefined })),
    ]);
    expect(sorted.map((e) => e.record.id)).toEqual(["aaa", "zzz"]);
  });

  it("does not mutate the input array", () => {
    const input = [entry(worker({ name: "zeta" })), entry(worker({ name: "alpha" }))];
    const snapshot = [...input];
    sortAgentLines(input);
    expect(input).toEqual(snapshot);
  });
});
