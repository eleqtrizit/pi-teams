import { describe, expect, it, afterEach, vi } from "vitest";
import theExtension from "./index";

const LEAD_TOOLS = [
  "team_create",
  "resolve_model",
  "spawn_teammate",
  "spawn_readonly_worker",
  "spawn_lead_window",
  "team_shutdown",
  "close_worker",
  "get_flavored_models",
  "get_models",
];
const SHARED_TOOLS = ["send_message", "broadcast_message", "list_teammates"];
const WORKER_TOOLS = ["close_myself"];

/**
 * Load the extension into a mock pi API and return the registered tool names.
 * The extension reads PI_* environment variables when it runs, so tests stub
 * the environment before calling this helper.
 */
function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  theExtension({
    on: vi.fn(),
    registerTool: (tool: { name: string }) => names.add(tool.name),
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return names;
}

describe("tool registration by identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers lead and shared tools for the interactive lead", () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_TEAM_NAME", "");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(false);
  });

  it("registers lead tools for a lead window (PI_AGENT_NAME=team-lead)", () => {
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_TEAM_NAME", "some-team");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(false);
  });

  it("registers shared and worker tools for a teammate, and no lead tools", () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_TEAM_NAME", "some-team");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(false);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(true);
  });

  it("registers shared and worker tools for a read-only worker", () => {
    vi.stubEnv("PI_AGENT_NAME", "audit-1");
    vi.stubEnv("PI_AGENT_TYPE", "readonly-worker");
    vi.stubEnv("PI_TEAM_NAME", "some-team");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(false);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(true);
  });

  it("excludes worker tools for a worker named team-lead", () => {
    vi.stubEnv("PI_AGENT_NAME", "team-lead");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_TEAM_NAME", "some-team");

    const names = registeredToolNames();
    expect(names.has("close_myself")).toBe(false);
  });
});
