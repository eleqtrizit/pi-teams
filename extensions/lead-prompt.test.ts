import { afterEach, describe, expect, it, vi } from "vitest";
import theExtension, { buildPeerLeadPrompt } from "./index";

vi.mock("../src/adapters/terminal-registry", () => ({
  getTerminalAdapter: () => null,
  supportsWindows: () => false,
}));

/** Marker unique to the non-interactive run-hold note for leads. */
const NON_INTERACTIVE_MARKER = "Non-interactive session:";
/** Marker unique to the peer-lead collaboration block. */
const PEER_BLOCK_MARKERS = [
  "Other Pi agents (peer leads)",
  "You are Pi Agent in",
];

/**
 * Load the extension into a mock pi API and return the registered event
 * handlers. The extension reads PI_* environment variables at load time, so
 * callers stub the environment before calling this helper.
 */
function loadHandlers(): Map<string, any> {
  const handlers = new Map<string, any>();
  theExtension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any);
  return handlers;
}

async function runBeforeAgentStart(
  handlers: Map<string, any>,
  hasUI: boolean,
): Promise<string | undefined> {
  const result = await handlers.get("before_agent_start")(
    { systemPrompt: "BASE PROMPT" },
    { hasUI },
  );
  return result?.systemPrompt;
}

describe("buildPeerLeadPrompt", () => {
  it("includes the identity and the peer-lead tool guidance", () => {
    const prompt = buildPeerLeadPrompt({ id: "prmpld01", cwd: "/tmp/leaddir" });

    expect(prompt).toContain("prmpld01");
    expect(prompt).toContain("/tmp/leaddir");
    expect(prompt).toContain("list_agents");
    expect(prompt).toContain('spawn_team_lead(folder="<dir>")');
    expect(prompt).toContain('send_message(recipient="<id>"');
    expect(prompt).toContain("expectReply=true");
    expect(prompt).toContain("make-tasks");
    expect(prompt).toContain("implement-tasks");
  });
});

describe("before_agent_start peer-lead guidance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("appends the peer-lead block on every interactive lead turn", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", "prmpld01");

    const handlers = loadHandlers();
    for (let turn = 0; turn < 2; turn++) {
      const systemPrompt = await runBeforeAgentStart(handlers, true);
      expect(systemPrompt).toContain("BASE PROMPT");
      for (const marker of PEER_BLOCK_MARKERS) {
        expect(systemPrompt).toContain(marker);
      }
      expect(systemPrompt).not.toContain(NON_INTERACTIVE_MARKER);
    }
  });

  it("appends both the non-interactive note and the peer-lead block to a lead without a UI", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", "prmpld01");

    const handlers = loadHandlers();
    const systemPrompt = await runBeforeAgentStart(handlers, false);

    expect(systemPrompt).toContain("BASE PROMPT");
    expect(systemPrompt).toContain(NON_INTERACTIVE_MARKER);
    for (const marker of PEER_BLOCK_MARKERS) {
      expect(systemPrompt).toContain(marker);
    }
  });

  it("never appends the peer-lead block to a teammate", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", "prmpwk01");
    vi.stubEnv("PI_LEAD_ID", "prmpld01");

    const handlers = loadHandlers();
    const systemPrompt = await runBeforeAgentStart(handlers, false);

    expect(systemPrompt).toContain("You are teammate 'worker-1'.");
    expect(systemPrompt).toContain("Your lead's agent id is prmpld01.");
    for (const marker of PEER_BLOCK_MARKERS) {
      expect(systemPrompt).not.toContain(marker);
    }
    expect(systemPrompt).not.toContain(NON_INTERACTIVE_MARKER);
  });

  it("includes expectReply guidance in the worker prompt", async () => {
    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", "prmpwk01");
    vi.stubEnv("PI_LEAD_ID", "prmpld01");

    const handlers = loadHandlers();
    const systemPrompt = await runBeforeAgentStart(handlers, false);

    expect(systemPrompt).toContain("expectReply=false");
    expect(systemPrompt).toContain("Reply expected: yes");
    expect(systemPrompt).not.toContain("sent to the team-lead automatically");
  });

  it("includes the new-files guidance in lead and worker prompts", async () => {
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_AGENT_ID", "prmpld01");
    const leadPrompt = await runBeforeAgentStart(loadHandlers(), true);
    expect(leadPrompt).toContain(
      "## New Files\n\nUse write tool over bash tool to write new files.",
    );

    vi.stubEnv("PI_AGENT_NAME", "worker-1");
    vi.stubEnv("PI_AGENT_TYPE", "teammate");
    vi.stubEnv("PI_AGENT_ID", "prmpwk01");
    vi.stubEnv("PI_LEAD_ID", "prmpld01");
    const workerPrompt = await runBeforeAgentStart(loadHandlers(), false);
    expect(workerPrompt).toContain(
      "## New Files\n\nUse write tool over bash tool to write new files.",
    );
  });
});
