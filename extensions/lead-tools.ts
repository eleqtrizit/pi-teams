import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readAgentRecords } from "../src/utils/registry";
import { AgentKind } from "../src/utils/models";
import * as flavoredModels from "../src/utils/flavoredModels";
import {
  FLAVOR_VALUES,
  type FlavorKey,
  type FlavorValue,
  type FlavoredModelsResult,
  type ModelFlavor,
} from "../src/utils/flavoredModels";
import * as teams from "../src/utils/teams";
import { getTopModelMatches, resolveModelWithProvider } from "../src/utils/modelSearch";
import { READONLY_WORKER_TOOLS } from "../src/utils/spawn";
import { type TerminalAdapter } from "../src/utils/terminal-adapter";

export interface SpawnWorkerGoals {
  name: string;
  cwd?: string;
  modelRequest?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  separateWindow?: boolean;
  readonlyWorker: boolean;
}

export interface SpawnedWorker {
  agentId: string;
  terminalId: string;
  isWindow: boolean;
  model: string;
  listening: boolean;
}

/** Dependencies captured from the extension session state and spawn plumbing. */
export interface LeadToolDeps {
  spawnTeamWorker: (ctx: ExtensionContext, goals: SpawnWorkerGoals) => Promise<SpawnedWorker>;
  terminal: TerminalAdapter | null | undefined;
  ensureListener: () => Promise<void>;
  getPendingMigrationNotice: () => string | undefined;
  setPendingMigrationNotice: (notice: string | undefined) => void;
}

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

export function classifyModel(modelId: string): "frontier" | "oss" {
  const lower = modelId.toLowerCase();
  return lower.includes("gpt") || lower.includes("claude") ? "frontier" : "oss";
}

export interface GetModelsResult {
  oss: string[];
  frontier: string[];
  /** Set when flavored models are configured and drove the result. */
  flavors?: FlavoredModelsResult;
}

const FLAVOR_KEYS: readonly FlavorKey[] = ["orchestrator", "worker", "swarm"];
const FLAVOR_LABELS: Record<FlavorKey, string> = {
  orchestrator: "Orchestrator (planning, coordinating)",
  worker: "Worker (coding)",
  swarm: "Swarm (read-only information gathering)",
};
const FLAVOR_BULLET: Record<FlavorKey, string> = {
  orchestrator: "\u25C6",
  worker: "\u25CF",
  swarm: "\u25B8",
};
const FLAVOR_COLOR: Record<FlavorKey, string> = {
  orchestrator: "accent",
  worker: "success",
  swarm: "warning",
};

export function runFlavorMigration(): { text: string; failed: boolean } | undefined {
  try {
    const result = flavoredModels.migrateLegacyFlavors();
    return result
      ? { text: flavoredModels.buildMigrationNotice(result), failed: false }
      : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `Flavored model migration failed: ${reason}`, failed: true };
  }
}

/** Union of the three flavor lists, deduplicated and order-preserving. */
function flavorUnion(flavors: FlavoredModelsResult): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const model of [...flavors.orchestrator, ...flavors.worker, ...flavors.swarm]) {
    if (!seen.has(model)) {
      seen.add(model);
      union.push(model);
    }
  }
  return union;
}

export function executeGetModels(): {
  content: { type: "text"; text: string }[];
  details: GetModelsResult;
} {
  const flavors = flavoredModels.readFlavoredModels();
  if (flavorUnion(flavors).length > 0) {
    return executeGetFlavoredModels(flavors);
  }
  const models = flavoredModels.readEnabledModels();
  const oss = models.filter((model) => classifyModel(model) === "oss");
  const frontier = models.filter((model) => classifyModel(model) === "frontier");
  const output = [
    "## OSS Models",
    ...(oss.length > 0 ? oss.map((model) => `  - ${model}`) : ["  (none)"]),
    "",
    "## Frontier Models",
    ...(frontier.length > 0 ? frontier.map((model) => `  - ${model}`) : ["  (none)"]),
  ].join("\n");
  return {
    content: [{ type: "text", text: output }],
    details: { oss, frontier },
  };
}

function buildSettingsListTheme(theme: {
  fg: (color: string, text: string) => string;
}): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) =>
      selected ? theme.fg("accent", text) : text,
    value: (text: string, selected: boolean) =>
      selected ? theme.fg("warning", text) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "\u2192"),
    hint: (text: string) => theme.fg("dim", text),
  };
}

function executeGetFlavoredModels(flavors: FlavoredModelsResult): {
  content: { type: "text"; text: string }[];
  details: GetModelsResult;
} {
  const union = flavorUnion(flavors);
  const sections = FLAVOR_KEYS.flatMap((flavor) => {
    const items = flavors[flavor];
    return [
      `## ${FLAVOR_LABELS[flavor]} Models`,
      ...(items.length > 0 ? items.map((model) => `  - ${model}`) : ["  (none configured)"]),
      "",
    ];
  });
  return {
    content: [{ type: "text", text: sections.join("\n") }],
    details: {
      oss: union.filter((model) => classifyModel(model) === "oss"),
      frontier: union.filter((model) => classifyModel(model) === "frontier"),
      flavors,
    },
  };
}

async function handleFlavoredModelsCommand(ctx: ExtensionContext): Promise<void> {
  let enabledModels: string[];
  try {
    enabledModels = flavoredModels.readEnabledModels();
  } catch (err) {
    ctx.ui.notify(
      `Failed to read settings: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  let flavors: FlavoredModelsResult;
  try {
    flavors = flavoredModels.readFlavoredModels();
  } catch (err) {
    ctx.ui.notify(
      `Failed to read flavors: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return;
  }

  const modelFlavors: ModelFlavor[] = flavoredModels.buildModelFlavors(enabledModels, flavors);
  await ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: unknown, done: (result?: void) => void) => {
      const items: SettingItem[] = modelFlavors.map((modelFlavor) => ({
        id: modelFlavor.id,
        label: modelFlavor.id,
        currentValue: modelFlavor.flavor,
        values: [...FLAVOR_VALUES],
      }));
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Flavored Model Configuration"))),
      );
      container.addChild(new Spacer());
      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        buildSettingsListTheme(theme),
        (id: string, newValue: string) => {
          const modelFlavor = modelFlavors.find((item) => item.id === id);
          if (modelFlavor) modelFlavor.flavor = newValue as FlavorValue;
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(new Spacer());
      const summary = flavoredModels.buildFooterSummary(modelFlavors);
      container.addChild(new Text(theme.fg("dim", `Enter/Space to cycle \u2022 Esc to cancel`)));
      container.addChild(new Text(theme.fg("muted", summary)));
      return {
        render(width: number): string[] {
          return container.render(width);
        },
        invalidate(): void {
          container.invalidate();
        },
        handleInput(data: string): void {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  try {
    flavoredModels.writeFlavorsToSettings(modelFlavors);
    ctx.ui.notify(
      `Flavored models saved (${flavoredModels.buildFooterSummary(modelFlavors)})`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `Failed to save flavored-models config: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

function listeningNote(spawned: { listening: boolean }): string {
  return spawned.listening
    ? ""
    : " The worker is not accepting messages yet. Check list_agents before you send it a message.";
}

/** Register the tools and command available to a team-lead session. */
export function registerLeadTools(pi: ExtensionAPI, deps: LeadToolDeps): void {
  pi.registerTool({
    name: "resolve_model",
    label: "Resolve Model",
    description:
      'Resolve a provider/model name for use in spawn_teammate. ALWAYS provide the full <provider>/<model> format (e.g., "anthropic/claude-sonnet-4-20250514", "bighank/Qwen35Coder-35B-NoThinking"). ' +
      'To find what provider/model pairs are available: call get_available_models() or use "DEFAULT MODEL" which is the team-leader\'s own model. ' +
      "This tool ONLY searches within the specified provider when a provider prefix is given. Bare names resolve through a priority ladder: flavored models from pi settings first, then the scoped models (pi --models flag or the enabledModels list), then the full registry. If no match is found, try a different provider or use DEFAULT MODEL.",
    parameters: asPiToolSchema(Type.Object({ model_name: Type.String() })) as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const requested = params.model_name.trim();
      if (!requested) throw new Error("model_name must not be empty.");
      const topMatches = getTopModelMatches(requested, ctx.modelRegistry, 5);
      const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
      const resolved = resolveModelWithProvider(requested, ctx.modelRegistry);
      if (!resolved) {
        const matchesText = topMatches.map((match) => match.model).join(", ");
        const outputText = defaultModel
          ? `DEFAULT MODEL: ${defaultModel}, Best matches: ${matchesText}`
          : matchesText;
        return {
          content: [{ type: "text", text: outputText }],
          details: {
            requested,
            resolved_model: null,
            top_matches: topMatches,
            default_model: defaultModel,
          },
        };
      }
      return {
        content: [{ type: "text", text: resolved }],
        details: {
          requested,
          resolved_model: resolved,
          top_matches: topMatches,
          default_model: defaultModel,
        },
      };
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description:
      "Spawn a new teammate/worker/subagent in a terminal pane or separate window.\n\n" +
      "Model selection: before spawning, call get_models to see the " +
      "configured orchestrator/worker/swarm model lists (it falls back to " +
      "OSS/frontier lists when no flavors are set). Pick from the worker " +
      "list for coding. Pick from the orchestrator list only for a " +
      "teammate/worker/subagent " +
      "that plans or coordinates other work. Never pick from the swarm list " +
      "(read-only gathering). Prefer spreading teammates/workers/subagents across different " +
      "providers unless the user names specific models. If no worker models " +
      "are configured, spawn the same model as yours (the team lead's).\n\n" +
      "If you pass a model explicitly, it must be fully qualified as " +
      "provider/model. Use resolve_model first if you only know a model name.",
    parameters: asPiToolSchema(
      Type.Object({
        name: Type.String(),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory for the worker. Must be the current " +
              "directory (the default) or one of its subdirectories.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Fully-qualified provider/model. Omit to follow the " +
              "get_models guidance (flavor-matched, provider-diverse, " +
              "falling back to the team lead's model).",
          }),
        ),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high"])),
        separate_window: Type.Optional(Type.Boolean({ default: false })),
      }),
    ) as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const spawned = await deps.spawnTeamWorker(ctx, {
        name: params.name,
        cwd: params.cwd,
        modelRequest: params.model,
        thinking: params.thinking,
        separateWindow: params.separate_window,
        readonlyWorker: false,
      });
      return {
        content: [
          {
            type: "text",
            text: `Teammate ${params.name} spawned in ${spawned.isWindow ? "window" : "pane"} ${spawned.terminalId} (agent ID: ${spawned.agentId}).${listeningNote(spawned)}`,
          },
        ],
        details: {
          agentId: spawned.agentId,
          terminalId: spawned.terminalId,
          isWindow: spawned.isWindow,
          listening: spawned.listening,
        },
      };
    },
  });

  pi.registerTool({
    name: "spawn_readonly_worker",
    label: "Spawn Read-Only Worker",
    description:
      "Spawn a read-only teammate/worker/subagent agent that can only read, grep, find, and ls files. No bash, write, or edit access. Despite being read-only, the teammate/worker/subagent can still use messaging tools (send_message) to communicate with the team lead, and it can close itself with close_myself.\n\n" +
      "Model selection: before spawning, call get_models and pick a " +
      "model from the swarm list. If the swarm list is empty, pick from the " +
      "worker list. If that is empty too, spawn the same model as yours (the " +
      "team lead's). Prefer spreading teammates/workers/subagents across different providers " +
      "unless the user names specific models.",
    parameters: asPiToolSchema(
      Type.Object({
        name: Type.String(),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory for the worker. Must be the current " +
              "directory (the default) or one of its subdirectories.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Fully-qualified provider/model, e.g. from the " +
              "get_models lists. Omit to use the team lead's model.",
          }),
        ),
      }),
    ) as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const spawned = await deps.spawnTeamWorker(ctx, {
        name: params.name,
        cwd: params.cwd,
        modelRequest: params.model,
        readonlyWorker: true,
      });
      return {
        content: [
          {
            type: "text",
            text: `Read-only worker ${params.name} spawned in pane ${spawned.terminalId} (agent ID: ${spawned.agentId}). Restricted to: read, grep, find, ls, messaging (send_message), and close_myself.${listeningNote(spawned)}`,
          },
        ],
        details: {
          agentId: spawned.agentId,
          terminalId: spawned.terminalId,
          listening: spawned.listening,
          tools: [...READONLY_WORKER_TOOLS],
        },
      };
    },
  });

  pi.registerTool({
    name: "close_all_workers",
    label: "Close All Workers",
    description: "Close every worker you spawned.",
    parameters: asPiToolSchema(Type.Object({})) as any,
    async execute() {
      const callerId = process.env.PI_AGENT_ID;
      if (!callerId) throw new Error("PI_AGENT_ID is not set");

      const records = readAgentRecords();
      const ownWorkers = records.filter(
        (r) => r.leadId === callerId && r.kind !== AgentKind.Lead,
      );

      for (const worker of ownWorkers) {
        await teams.removeAgent({
          agentId: worker.id,
          terminal: deps.terminal,
        });
      }

      return {
        content: [{ type: "text", text: `Closed ${ownWorkers.length} worker(s).` }],
        details: { closed: ownWorkers.length },
      };
    },
  });

  pi.registerTool({
    name: "close_worker",
    label: "Close Worker",
    description: "Close one of your own workers by its 8-character agent id or worker name.",
    parameters: asPiToolSchema(Type.Object({ agent: Type.String() })) as any,
    async execute(_toolCallId, params: any) {
      const callerId = process.env.PI_AGENT_ID;
      if (!callerId) throw new Error("PI_AGENT_ID is not set");

      const records = readAgentRecords();
      const ownWorkers = records.filter(
        (r) => r.leadId === callerId && r.kind !== AgentKind.Lead,
      );

      // Resolve agent param to a record among the caller's own workers.
      let target: typeof ownWorkers[0] | undefined;
      if (/^[a-z0-9]{8}$/.test(params.agent)) {
        target = ownWorkers.find((r) => r.id === params.agent);
      } else {
        target = ownWorkers.find((r) => r.name === params.agent);
      }

      if (!target) {
        // Provide a clear error for peer leads and other leads' workers.
        const allMatching = records.filter(
          (r) => r.id === params.agent || r.name === params.agent,
        );
        const peerLead = allMatching.find((r) => r.kind === AgentKind.Lead);
        if (peerLead) {
          throw new Error(`Cannot close a peer lead (${peerLead.id})`);
        }
        const otherWorker = allMatching.find((r) => r.leadId !== callerId);
        if (otherWorker) {
          throw new Error(
            `Cannot close another lead's worker (${otherWorker.id})`,
          );
        }
        throw new Error(
          `Worker ${params.agent} not found among your workers`,
        );
      }

      await teams.removeAgent({
        agentId: target.id,
        terminal: deps.terminal,
      });

      return {
        content: [
          {
            type: "text",
            text: `Worker ${target.name ?? target.id} has been shut down.`,
          },
        ],
        details: {},
      };
    },
  });

  const runGetModels = async () => {
    try {
      const notice = deps.getPendingMigrationNotice();
      deps.setPendingMigrationNotice(undefined);
      const result = executeGetModels();
      if (notice) {
        result.content[0].text = `${notice}\n\n${result.content[0].text}`;
      }
      return result;
    } catch (error) {
      throw new Error(`Failed to read enabled models: ${error}`);
    }
  };
  const getModelsDescription =
    "Read model lists from pi settings.json. When flavored models are " +
    "configured, return three flavor lists: orchestrator (orchestrating, " +
    "planning, coordinating), worker (coding), and swarm (read-only " +
    "information gathering). Otherwise, return two lists: OSS (models not " +
    'containing "gpt" or "claude", e.g. Qwen, DeepSeek, Nemotron) and ' +
    'frontier (models containing "gpt" or "claude", e.g. GPT-5.x, Claude ' +
    "Sonnet).";
  const renderGetModelsResult = (result: any, _options: { expanded: boolean }, theme: any): any => {
    const text = new Text("", 0, 0);
    const details = result.details as GetModelsResult | undefined;
    if (!details) {
      text.setText(theme.fg("error", "[no result]"));
      return text;
    }
    if (details.flavors) {
      const lines = FLAVOR_KEYS.flatMap((key) => {
        const items = details.flavors![key];
        const color = FLAVOR_COLOR[key];
        const modelLines =
          items.length > 0
            ? items.map((model) => `  ${theme.fg(color, FLAVOR_BULLET[key])} ${model}`)
            : [theme.fg("dim", "  (none configured)")];
        return [
          theme.fg("toolTitle", theme.bold(`${FLAVOR_LABELS[key]} Models`)),
          ...modelLines,
          "",
        ];
      });
      text.setText(lines.join("\n"));
      return text;
    }
    const ossList =
      details.oss.length > 0
        ? details.oss
            .map((model) => `  ${theme.fg("success", "\u25CF")} ${model}`)
            .join("\n")
        : theme.fg("dim", "  (none)");
    const frontierList =
      details.frontier.length > 0
        ? details.frontier
            .map((model) => `  ${theme.fg("accent", "\u25C6")} ${model}`)
            .join("\n")
        : theme.fg("dim", "  (none)");
    text.setText(
      [
        theme.fg("toolTitle", theme.bold("OSS Models")),
        ossList,
        "",
        theme.fg("toolTitle", theme.bold("Frontier Models")),
        frontierList,
      ].join("\n"),
    );
    return text;
  };

  // Backwards-compatible alias: identical behavior to get_models. Remove once
  // prompts and skills no longer reference it.
  pi.registerTool({
    name: "get_flavored_models",
    label: "Get Flavored Models",
    description:
      "Alias for get_models. Returns the orchestrator/worker/swarm lists " +
      "when flavored models are configured, otherwise the OSS/frontier lists.",
    parameters: asPiToolSchema(Type.Object({})) as any,
    execute: runGetModels,
    renderCall(_args: any, theme: any): any {
      const text = new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("get_flavored_models")));
      return text;
    },
    renderResult: renderGetModelsResult,
  });

  pi.registerTool({
    name: "get_models",
    label: "Get Models",
    description: getModelsDescription,
    parameters: asPiToolSchema(Type.Object({})) as any,
    execute: runGetModels,
    renderCall(_args: any, theme: any): any {
      const text = new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("get_models")));
      return text;
    },
    renderResult: renderGetModelsResult,
  });

  pi.registerCommand("flavored-models", {
    description:
      "Configure model flavor assignments (orchestrator/worker/swarm/none)",
    handler: (_args: string, ctx: ExtensionContext) =>
      handleFlavoredModelsCommand(ctx),
  });
}
