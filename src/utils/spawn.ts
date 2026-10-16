/**
 * Spawn plumbing for pi-teams: build the pi launch command for a worker and
 * launch it through a terminal adapter. Shared by spawn_teammate and
 * spawn_readonly_worker.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import { shQuote, type TerminalAdapter } from "./terminal-adapter";
import { getAvailableModels } from "./modelSearch";
import * as paths from "./paths";
import type { AgentRecord } from "./models";

/**
 * Resolve and validate the working directory for a spawned worker.
 *
 * The directory must be the lead's current directory or one of its
 * subdirectories. An undefined request falls back to the lead's current
 * directory.
 *
 * @param cwdRequest - Raw cwd input from the caller, or undefined
 * @param base - The lead's current directory (defaults to process.cwd())
 * @returns The absolute working directory for the worker
 * @throws If the directory does not exist or is not within the lead's directory
 */
export function resolveSpawnDirectory(
  cwdRequest: string | undefined,
  base: string = process.cwd(),
): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, cwdRequest?.trim() || ".");
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Working directory '${resolved}' is not within the current directory ` +
        `'${resolvedBase}'. The worker's cwd must be the current directory or ` +
        `one of its subdirectories.`,
    );
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Working directory '${resolved}' does not exist or is not a directory.`);
  }
  return resolved;
}

export const READONLY_WORKER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "send_message",
  "close_myself",
] as const;

/**
 * Resolve the worker's model from raw spawn input.
 *
 * An undefined request or one matching "default" falls back to the team-lead's
 * current model. Any other request must be fully qualified as provider/model
 * and present in the model registry.
 *
 * @param ctx - Extension context providing the current model and registry
 * @param modelRequest - Raw model input from the caller, or undefined
 * @returns The fully qualified provider/model for the worker
 * @throws If no model resolves or the request is not registry-qualified
 */

export function resolveSpawnModel(
  ctx: ExtensionContext,
  modelRequest: string | undefined,
): string {
  const defaultModel = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : null;
  let chosenModel = modelRequest?.trim();
  if (!chosenModel || /default/i.test(chosenModel)) {
    chosenModel = defaultModel ?? undefined;
  }
  if (!chosenModel) {
    throw new Error(
      "No model is available for the worker. Pass an explicit model or " +
        "ensure the team-lead has a model configured.",
    );
  }
  if (!chosenModel.includes("/")) {
    throw new Error(
      `Model '${chosenModel}' is not fully qualified. ` +
        `Use resolve_model(model_name="${chosenModel}") first, then pass ` +
        `the returned provider/model value.`,
    );
  }
  const slashIndex = chosenModel.indexOf("/");
  const provider = chosenModel.slice(0, slashIndex).toLowerCase();
  const modelId = chosenModel.slice(slashIndex + 1).toLowerCase();
  const isAvailable = getAvailableModels(ctx.modelRegistry).some(
    (m) =>
      m.provider.toLowerCase() === provider &&
      m.model.toLowerCase() === modelId,
  );
  if (!isAvailable) {
    throw new Error(
      `Model '${chosenModel}' is not available in the current registry. ` +
        `Use resolve_model(model_name="...") to find a valid provider/model value.`,
    );
  }
  return chosenModel;
}

/**
 * Build the pi binary portion of a launch command.
 *
 * Uses the running pi entrypoint (`node <argv[1]>`) when available, falling
 * back to the bare `pi` command on PATH. Every launch command shares this
 * helper so leads and workers start the same binary.
 *
 * @returns The quoted pi binary invocation
 */
export function piBinaryCommand(): string {
  return process.argv[1] ? `node ${shQuote(process.argv[1])}` : "pi";
}

/**
 * Build the pi launch command and member identity for a spawned worker.
 *
 * Read-only workers receive the restricted tool list; teammates honor the
 * thinking level in the combined --model provider/model:thinking form.
 *
 * @param goals - Worker goals including readonlyWorker and thinking
 * @param chosenModel - Fully qualified provider/model resolved for the worker
 * @returns The launch command and the member agent type
 */
export function buildWorkerCommand(
  goals: {
    readonlyWorker: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
  },
  chosenModel: string,
): { piCmd: string; agentType: "teammate" | "readonly-worker" } {
  const agentType = goals.readonlyWorker ? "readonly-worker" : "teammate";
  // Workers start like any pi session and load their own configured
  // extensions (pi-teams, pi-sandbox, ...). No extension flags: -ne would drop
  // every configured extension. Use the combined --model provider/model:thinking format.
  const piBinary = piBinaryCommand();
  let piCmd = `${piBinary} --model ${shQuote(chosenModel)}`;
  if (!goals.readonlyWorker && goals.thinking) {
    piCmd = `${piCmd}:${goals.thinking}`;
  }
  if (goals.readonlyWorker) {
    piCmd = `${piCmd} --tools ${READONLY_WORKER_TOOLS.join(",")}`;
  }
  return { piCmd, agentType };
}

/** Environment keys stripped from the base env before a lead is spawned. */
const LEAD_ENV_STRIP: readonly string[] = [
  "PI_AGENT_NAME",
  "PI_LEAD_ID",
  "PI_AGENT_ID",
];

/**
 * Build the environment for a spawned lead session.
 *
 * Inherits the spawning session's environment minus the identity variables of
 * any team the spawner belongs to, so the new session starts as an independent
 * lead. Undefined values are dropped. PI_AGENT_ID is set to the new lead's ID
 * and PI_AGENT_TYPE is forced to "lead", overriding any inherited value.
 *
 * @param base - The spawning session's environment (usually process.env)
 * @param agentId - The new lead's agent ID
 * @returns A fresh environment for the lead process
 * @throws If the agent ID is invalid (see assertAgentId)
 */
export function buildLeadEnv(
  base: NodeJS.ProcessEnv,
  agentId: string,
): Record<string, string> {
  paths.assertAgentId(agentId);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (LEAD_ENV_STRIP.includes(key) || value === undefined) {
      continue;
    }
    env[key] = value;
  }
  env.PI_AGENT_ID = agentId;
  env.PI_AGENT_TYPE = "lead";
  return env;
}

/**
 * Build the pi launch command for a spawned lead session.
 *
 * Uses the same pi binary logic as buildWorkerCommand. An optional model is
 * appended, shell-quoted for safety. The lead loads its own configured
 * extensions, so no -ne or --tools flags appear.
 *
 * @param model - Fully qualified provider/model for the lead, or undefined
 * @returns The launch command
 */
export function buildLeadCommand(model?: string): string {
  let piCmd = piBinaryCommand();
  const chosenModel = model?.trim();
  if (chosenModel) {
    piCmd = `${piCmd} --model ${shQuote(chosenModel)}`;
  }
  return piCmd;
}

/**
 * Resolve and validate the working directory for a spawned lead.
 *
 * Unlike resolveSpawnDirectory, any existing directory is allowed: a lead runs
 * wherever the caller points it. A leading "~" or "~/" expands to the current
 * user's home directory.
 *
 * @param folder - Raw folder input from the caller
 * @returns The absolute working directory for the lead
 * @throws If the expanded directory does not exist or is not a directory
 */
export function resolveLeadFolder(folder: string): string {
  let expanded = folder.trim();
  if (expanded === "~") {
    expanded = os.homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory '${resolved}' does not exist or is not a directory.`);
  }
  return resolved;
}

/**
 * Launch a worker process through the terminal adapter.
 *
 * Spawns a separate OS window when requested; otherwise spawns a pane next to
 * the last registered worker pane in iTerm2.
 *
 * @param terminal - Detected terminal adapter
 * @param args - Launch details: name, command, environment, and own worker records
 * @returns The spawned terminal id (a window id or a pane id)
 */
export function spawnWorkerProcess(
  terminal: TerminalAdapter,
  args: {
    name: string;
    cwd: string;
    piCmd: string;
    env: Record<string, string>;
    agents: AgentRecord[];
    useSeparateWindow: boolean;
    readonlyWorker: boolean;
  },
): string {
  if (args.useSeparateWindow) {
    return terminal.spawnWindow({
      name: args.name,
      cwd: args.cwd,
      command: args.piCmd,
      env: args.env,
    });
  }
  if (terminal instanceof Iterm2Adapter) {
    const candidates = args.agents.filter(
      (record) =>
        record.leadId === args.env.PI_LEAD_ID &&
        record.paneId?.startsWith("iterm_") &&
        record.kind !== "lead",
    );
    const lastCandidate = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    terminal.setSpawnContext(
      lastCandidate?.paneId
        ? { lastSessionId: lastCandidate.paneId.replace("iterm_", "") }
        : {},
    );
  }
  return terminal.spawn({
    name: args.name,
    cwd: args.cwd,
    command: args.piCmd,
    env: args.env,
  });
}
