import { describe, expect, it, afterEach, vi } from "vitest";
import theExtension from "./index";

const LEAD_TOOLS = [
  "resolve_model",
  "spawn_teammate",
  "spawn_readonly_worker",
  "close_all_workers",
  "close_worker",
  "get_flavored_models",
  "get_models",
  "spawn_team_lead",
];
const SHARED_TOOLS = ["send_message"];
const WORKER_TOOLS = ["close_myself"];
/** Registered for every session, lead and worker alike. */
const AGENT_TOOLS = ["list_agents"];

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
      registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return names;
}

describe("tool registration by identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // The extension writes PI_AGENT_ID back into process.env on every run,
    // so unstubAllEnvs alone leaves a preassigned id behind.
    delete process.env.PI_AGENT_ID;
    delete process.env.PI_LEAD_ID;
    vi.restoreAllMocks();
  });

  it("registers lead, shared, and close_myself tools for a spawned lead", () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", "spwnld01");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of AGENT_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(true);
  });

  it("registers lead and shared tools for the interactive lead", () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of AGENT_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(false);
  });

  it("registers shared and worker tools for a teammate, and no lead tools", () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(false);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of AGENT_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(true);
  });

  it("registers shared and worker tools for a read-only worker", () => {
    vi.stubEnv("PI_AGENT_NAME", "audit-1");
    vi.stubEnv("PI_AGENT_TYPE", "readonly-worker");

    const names = registeredToolNames();
    for (const name of LEAD_TOOLS) expect(names.has(name)).toBe(false);
    for (const name of SHARED_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of AGENT_TOOLS) expect(names.has(name)).toBe(true);
    for (const name of WORKER_TOOLS) expect(names.has(name)).toBe(true);
  });
});

describe("command registration by identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers the insta-worker commands for lead sessions", () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");

    const commands: string[] = [];
    theExtension({
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: (name: string) => commands.push(name),
      sendUserMessage: vi.fn(),
    } as any);
    expect(commands).toContain("flavored-models");
    expect(commands).not.toContain("sub");
    expect(commands).not.toContain("insta-worker");
    expect(commands).not.toContain("insta-worker-ro");
  });

  it("registers no commands for a teammate", () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");

    const commands: string[] = [];
    theExtension({
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: (name: string) => commands.push(name),
      sendUserMessage: vi.fn(),
    } as any);
    // keep_last is a shared command: every identity gets it.
    expect(commands).toEqual(["keep_last"]);
  });
});


