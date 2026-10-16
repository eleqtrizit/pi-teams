import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnOptions, TerminalAdapter } from "../src/utils/terminal-adapter";
import * as teams from "../src/utils/teams";
import * as spawn from "../src/utils/spawn";
import * as transport from "../src/utils/transport";
import * as terminalRegistry from "../src/adapters/terminal-registry";
import extension from "./index";

const leadId = "lead1234";
const capturedOptions: SpawnOptions[] = [];
const fakeTerminal: TerminalAdapter = {
  name: "fake",
  detect: () => true,
  spawn: (options) => {
    capturedOptions.push(options);
    return "pane-1";
  },
  kill: () => {},
  isAlive: () => true,
  setTitle: () => {},
  supportsWindows: () => false,
  spawnWindow: () => {
    throw new Error("Windows are unsupported");
  },
  setWindowTitle: () => {},
  killWindow: () => {},
  isWindowAlive: () => false,
};

describe("spawned worker identity environment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    capturedOptions.length = 0;
  });

  it("passes a distinct worker ID and the lead ID to the terminal adapter", async () => {
    vi.stubEnv("PI_AGENT_ID", leadId);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.stubEnv("PI_TEAM_NAME", "");
    vi.spyOn(teams, "teamExists").mockReturnValue(true);
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: leadId,
      leadSessionId: "session",
      members: [],
    });
    vi.spyOn(teams, "addMember").mockResolvedValue();
    vi.spyOn(teams, "updateMember").mockResolvedValue();
    vi.spyOn(teams, "removeMember").mockResolvedValue();
    vi.spyOn(teams, "resetAgentState").mockImplementation(() => {});
    vi.spyOn(spawn, "resolveSpawnDirectory").mockReturnValue(process.cwd());
    vi.spyOn(spawn, "resolveSpawnModel").mockReturnValue("provider/model");
    vi.spyOn(spawn, "seedWorkerStateFiles").mockImplementation(() => {});
    vi.spyOn(spawn, "spawnWorkerProcess").mockImplementation((_terminal, args) => {
      capturedOptions.push({
        name: args.name,
        cwd: args.cwd,
        command: args.piCmd,
        env: args.env,
      });
      return "pane-1";
    });
    vi.spyOn(transport, "waitForListener").mockResolvedValue(true);

    const handlers = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const api = {
      on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) =>
        tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    vi.spyOn(terminalRegistry, "getTerminalAdapter").mockReturnValue(fakeTerminal);
    extension(api);
    const spawnTool = tools.get("spawn_teammate");
    expect(spawnTool).toBeDefined();
    await spawnTool!.execute(
      "call",
      { team_name: "team", name: "worker" },
      undefined,
      undefined,
      {
        hasUI: true,
        model: { provider: "provider", id: "model" },
        modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
      } as unknown as ExtensionContext,
    );

    const workerEnv = capturedOptions[0].env;
    expect(workerEnv.PI_AGENT_ID).toMatch(/^[a-z0-9]{8}$/);
    expect(workerEnv.PI_AGENT_ID).not.toBe(leadId);
    expect(workerEnv.PI_LEAD_ID).toBe(leadId);
  });
});
