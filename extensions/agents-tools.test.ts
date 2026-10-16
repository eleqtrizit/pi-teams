import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentKind, AgentStatus, type AgentRecord } from "../src/utils/models";
import { pruneAndList } from "../src/utils/registry";
import { registerAgentTools } from "./agents-tools";

vi.mock("../src/utils/registry", () => ({
  pruneAndList: vi.fn(),
}));

/**
 * Load registerAgentTools into a mock pi API and return the `list_agents`
 * tool definition registered under the given self-record provider.
 */
function loadListAgentsTool(getSelfRecord: () => AgentRecord | null): any {
  const tools = new Map<string, any>();
  registerAgentTools(
    {
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    } as any,
    { getSelfRecord },
  );
  return tools.get("list_agents");
}

/** Run the tool and return its rendered text and details. */
async function runListAgents(
  getSelfRecord: () => AgentRecord | null,
): Promise<{ text: string; details: any }> {
  const tool = loadListAgentsTool(getSelfRecord);
  const result = await tool.execute("call-1", {}, undefined, undefined, {});
  return { text: result.content[0].text, details: result.details };
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    kind: AgentKind.Lead,
    cwd: "/w/alpha",
    pid: 1,
    startedAt: 1000,
    ...overrides,
  };
}

/** Two leads (A in /w/alpha, B in /w/beta), one offline lead (C in /w/gamma),
 *  and one worker per online lead. */
const leadA = makeRecord({ id: "aaaaaaaa", cwd: "/w/alpha", startedAt: 1000 });
const leadB = makeRecord({ id: "bbbbbbbb", cwd: "/w/beta", startedAt: 2000 });
const leadC = makeRecord({ id: "cccccccc", cwd: "/w/gamma", startedAt: 3000 });
const workerA = makeRecord({
  id: "d1d1d1d1",
  kind: AgentKind.Teammate,
  leadId: "aaaaaaaa",
  name: "alpha-worker",
  cwd: "/w/alpha",
  pid: 4,
  startedAt: 1500,
});
const workerB = makeRecord({
  id: "e2e2e2e2",
  kind: AgentKind.Teammate,
  leadId: "bbbbbbbb",
  name: "beta-worker",
  cwd: "/w/beta",
  pid: 5,
  startedAt: 2500,
});

/** Survivors of a mocked pruneAndList: every lead plus both online workers. */
function seededEntries() {
  vi.mocked(pruneAndList).mockResolvedValue([
    { record: leadA, status: AgentStatus.Online },
    { record: leadB, status: AgentStatus.Online },
    { record: leadC, status: AgentStatus.Offline },
    { record: workerA, status: AgentStatus.Online },
    { record: workerB, status: AgentStatus.Online },
  ]);
}

describe("list_agents", () => {
  beforeEach(() => {
    vi.mocked(pruneAndList).mockReset();
  });

  it("lists peer leads and own workers for a lead, excluding other leads' workers", async () => {
    seededEntries();

    const { text, details } = await runListAgents(() => leadA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online (you)",
        "Pi Agent in /w/beta: bbbbbbbb: Online",
        "Pi Agent in /w/gamma: cccccccc: Offline",
        "Worker alpha-worker in /w/alpha: d1d1d1d1: Online",
      ].join("\n"),
    );
    expect(text).not.toContain("e2e2e2e2");
    expect(text).not.toContain("beta-worker");
    const offlineLines = text.split("\n").filter((line) => line.endsWith("Offline"));
    expect(offlineLines).toHaveLength(1);
    expect(offlineLines[0]).toContain("cccccccc");

    expect(details.agents).toEqual([
      { id: "aaaaaaaa", kind: "lead", cwd: "/w/alpha", status: "Online" },
      { id: "bbbbbbbb", kind: "lead", cwd: "/w/beta", status: "Online" },
      { id: "cccccccc", kind: "lead", cwd: "/w/gamma", status: "Offline" },
      {
        id: "d1d1d1d1",
        kind: "teammate",
        cwd: "/w/alpha",
        name: "alpha-worker",
        status: "Online",
      },
    ]);
  });

  it("lists own lead and sibling workers for a worker, excluding peer leads", async () => {
    seededEntries();
    const sibling = makeRecord({
      id: "f3f3f3f3",
      kind: AgentKind.Teammate,
      leadId: "aaaaaaaa",
      name: "alpha-two",
      cwd: "/w/alpha",
      pid: 6,
      startedAt: 1600,
    });
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadA, status: AgentStatus.Online },
      { record: leadB, status: AgentStatus.Online },
      { record: leadC, status: AgentStatus.Offline },
      { record: workerA, status: AgentStatus.Online },
      { record: workerB, status: AgentStatus.Online },
      { record: sibling, status: AgentStatus.Online },
    ]);

    const { text } = await runListAgents(() => workerA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online",
        "Worker alpha-two in /w/alpha: f3f3f3f3: Online",
        "Worker alpha-worker in /w/alpha: d1d1d1d1: Online (you)",
      ].join("\n"),
    );
    expect(text).not.toContain("bbbbbbbb");
    expect(text).not.toContain("cccccccc");
    expect(text).not.toContain("e2e2e2e2");
  });

  it("includes self as Online when the registry has no record for this session", async () => {
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadB, status: AgentStatus.Online },
      { record: leadC, status: AgentStatus.Offline },
      { record: workerB, status: AgentStatus.Online },
    ]);

    const { text, details } = await runListAgents(() => leadA);

    expect(text).toBe(
      [
        "Pi Agent in /w/alpha: aaaaaaaa: Online (you)",
        "Pi Agent in /w/beta: bbbbbbbb: Online",
        "Pi Agent in /w/gamma: cccccccc: Offline",
      ].join("\n"),
    );
    expect(details.agents[0]).toEqual({
      id: "aaaaaaaa",
      kind: "lead",
      cwd: "/w/alpha",
      status: "Online",
    });
  });

  it("forces self Online when its registry entry probed Offline", async () => {
    vi.mocked(pruneAndList).mockResolvedValue([
      { record: leadA, status: AgentStatus.Offline },
      { record: workerA, status: AgentStatus.Online },
    ]);

    const { text } = await runListAgents(() => leadA);

    expect(text).toContain("Pi Agent in /w/alpha: aaaaaaaa: Online (you)");
    expect(text).not.toContain("aaaaaaaa: Offline");
  });

  it("shows only self for a worker with no leadId", async () => {
    seededEntries();
    const orphan = makeRecord({
      id: "a1b2c3d4",
      kind: AgentKind.Teammate,
      name: "lonely",
      cwd: "/w/theta",
      pid: 7,
      startedAt: 1200,
    });

    const { text, details } = await runListAgents(() => orphan);

    expect(text).toBe("Worker lonely in /w/theta: a1b2c3d4: Online (you)");
    expect(details.agents).toEqual([
      { id: "a1b2c3d4", kind: "teammate", cwd: "/w/theta", name: "lonely", status: "Online" },
    ]);
  });

  it("throws when the session is not registered in the agent registry", async () => {
    await expect(runListAgents(() => null)).rejects.toThrow(
      "This session is not registered in the agent registry.",
    );
  });
});
