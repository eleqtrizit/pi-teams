import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpawnOptions, TerminalAdapter } from "../src/utils/terminal-adapter";
import * as spawn from "../src/utils/spawn";
import * as registry from "../src/utils/registry";
import * as transport from "../src/utils/transport";
import * as terminalRegistry from "../src/adapters/terminal-registry";
import { AgentKind, type AgentRecord } from "../src/utils/models";
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

const leadRecord: AgentRecord = {
  id: leadId,
  kind: AgentKind.Lead,
  cwd: process.cwd(),
  pid: process.pid,
  startedAt: 1,
};

describe("spawned worker identity environment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    capturedOptions.length = 0;
  });

  it("passes worker identity variables and stores its pane in the registry", async () => {
    vi.stubEnv("PI_AGENT_ID", leadId);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    const workerRecord: AgentRecord = {
      id: "work1234",
      kind: AgentKind.Teammate,
      leadId,
      name: "worker",
      cwd: process.cwd(),
      pid: process.pid,
      startedAt: 2,
    };
    const readRecords = vi.spyOn(registry, "readAgentRecords").mockReturnValue([leadRecord]);
    const updateRecord = vi.spyOn(registry, "updateAgentRecord").mockImplementation((_id, patch) => {
      Object.assign(workerRecord, patch);
      readRecords.mockReturnValue([leadRecord, workerRecord]);
    });
    vi.spyOn(registry, "generateAgentId").mockReturnValue("work1234");
    vi.spyOn(spawn, "resolveSpawnDirectory").mockReturnValue(process.cwd());
    vi.spyOn(spawn, "resolveSpawnModel").mockReturnValue("provider/model");
    vi.spyOn(spawn, "spawnWorkerProcess").mockImplementation((_terminal, args) => {
      capturedOptions.push({ name: args.name, cwd: args.cwd, command: args.piCmd, env: args.env });
      return "pane-1";
    });
    vi.spyOn(transport, "waitForListener").mockResolvedValue(true);

    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    const api = {
      on: vi.fn(),
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
      { name: "worker" },
      undefined,
      undefined,
      {
        hasUI: true,
        model: { provider: "provider", id: "model" },
        modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
      } as unknown as ExtensionContext,
    );

    expect(capturedOptions[0].env).toMatchObject({
      PI_AGENT_NAME: "worker",
      PI_AGENT_TYPE: "teammate",
      PI_AGENT_ID: "work1234",
      PI_LEAD_ID: leadId,
    });
    expect(updateRecord).toHaveBeenCalledWith("work1234", { paneId: "pane-1" });
  });

  it("rejects a same-name worker owned by this lead", async () => {
    vi.stubEnv("PI_AGENT_ID", leadId);
    vi.stubEnv("PI_AGENT_NAME", "");
    vi.stubEnv("PI_AGENT_TYPE", "");
    vi.spyOn(registry, "readAgentRecords").mockReturnValue([
      leadRecord,
      {
        id: "work1234",
        kind: AgentKind.Teammate,
        leadId,
        name: "worker",
        cwd: process.cwd(),
        pid: process.pid,
        startedAt: 2,
      },
    ]);
    vi.spyOn(spawn, "resolveSpawnDirectory").mockReturnValue(process.cwd());
    vi.spyOn(spawn, "resolveSpawnModel").mockReturnValue("provider/model");
    vi.spyOn(terminalRegistry, "getTerminalAdapter").mockReturnValue(fakeTerminal);

    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    extension({
      on: vi.fn(),
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) =>
        tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI);

    await expect(
      tools.get("spawn_teammate")!.execute(
        "call",
        { name: "worker" },
        undefined,
        undefined,
        {
          hasUI: true,
          model: { provider: "provider", id: "model" },
          modelRegistry: { getAvailable: () => [{ provider: "provider", id: "model" }] },
        } as unknown as ExtensionContext,
      ),
    ).rejects.toThrow(/already exists/);
  });
});
