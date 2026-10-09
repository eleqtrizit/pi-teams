/**
 * Spawn plumbing for pi-teams: build the pi launch command for a worker and
 * launch it through a terminal adapter. Shared by spawn_teammate and
 * spawn_readonly_worker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Iterm2Adapter } from "../adapters/iterm2-adapter";
import { shQuote, type TerminalAdapter } from "./terminal-adapter";
import { getAvailableModels } from "./modelSearch";
import * as paths from "./paths";
import * as teams from "./teams";
import { Member } from "./models";

/**
 * CLI flags that make a spawned agent load exactly one extension instance.
 * Discovery is disabled so no other pi-teams copy (settings package or
 * project-local package) can register the same tools alongside it.
 *
 * @param extensionEntry - Absolute path of the extension entry file (extensions/index.ts)
 * @returns The shell-quoted flag string
 */
export function extensionLoadFlags(extensionEntry: string): string {
  return `-ne -e ${shQuote(extensionEntry)}`;
}

export const READONLY_WORKER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "send_message",
  "broadcast_message",
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
 * Build the pi launch command and member identity for a spawned worker.
 *
 * Read-only workers receive the restricted tool list; teammates honor the
 * thinking level in the combined --model provider/model:thinking form.
 *
 * @param goals - Worker goals including readonlyWorker and thinking
 * @param chosenModel - Fully qualified provider/model resolved for the worker
 * @param loadFlags - Extension load flags from {@link extensionLoadFlags}
 * @returns The launch command and the member agent type
 */

export function buildWorkerCommand(
  goals: {
    readonlyWorker: boolean;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
  },
  chosenModel: string,
  loadFlags: string,
): { piCmd: string; agentType: "teammate" | "readonly-worker" } {
  const agentType = goals.readonlyWorker ? "readonly-worker" : "teammate";
  // Spawned agents must load exactly the pi-teams copy running in this
  // session: without -ne they would re-discover it (settings package and
  // project-local package) and fail to load on duplicate tool registration.
  // Use the combined --model provider/model:thinking format.
  const piBinary = process.argv[1] ? `node ${shQuote(process.argv[1])}` : "pi";
  let piCmd = `${piBinary} ${loadFlags} --model ${shQuote(chosenModel)}`;
  if (!goals.readonlyWorker && goals.thinking) {
    piCmd = `${piCmd}:${goals.thinking}`;
  }
  if (goals.readonlyWorker) {
    piCmd = `${piCmd} --tools ${READONLY_WORKER_TOOLS.join(",")}`;
  }
  return { piCmd, agentType };
}

/**
 * Launch a worker process through the terminal adapter.
 *
 * Spawns a separate OS window when requested; otherwise spawns a pane next to
 * the last matching teammate pane in iTerm2.
 *
 * @param terminal - Detected terminal adapter
 * @param args - Launch details: sanitized names, command, environment, and team members
 * @returns The spawned terminal id (a window id or a pane id)
 */

export function spawnWorkerProcess(
  terminal: TerminalAdapter,
  args: {
    teamName: string;
    name: string;
    cwd: string;
    piCmd: string;
    env: Record<string, string>;
    members: Member[];
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
      teamName: args.teamName,
    });
  }
  if (terminal instanceof Iterm2Adapter) {
    // iTerm2 panes spawn next to the last teammate pane; read-only workers
    // also follow teammates.
    const candidates = args.members.filter(
      (m) =>
        m.tmuxPaneId.startsWith("iterm_") &&
        (args.readonlyWorker || m.agentType === "teammate"),
    );
    const lastCandidate =
      candidates.length > 0 ? candidates[candidates.length - 1] : null;
    terminal.setSpawnContext(
      lastCandidate?.tmuxPaneId
        ? { lastSessionId: lastCandidate.tmuxPaneId.replace("iterm_", "") }
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

/**
 * Pre-seed a worker's state files before its terminal process starts.
 *
 * Stamping the first-activation file makes the worker's session_start skip the
 * inbox-deletion cleanup, so messages delivered to the worker before or during
 * its boot are preserved.
 *
 * @param safeTeamName - Sanitized team name
 * @param safeName - Sanitized worker name
 */

export function seedWorkerStateFiles(safeTeamName: string, safeName: string): void {
  // Clear prior timestamps but keep any inbox content so messages delivered
  // during boot survive, then stamp first activation so session_start skips
  // the stale-state cleanup.
  teams.resetAgentState(safeTeamName, safeName, { keepInbox: true, keepFirstActivation: true });
  fs.mkdirSync(path.dirname(paths.firstActivationPath(safeTeamName, safeName)), { recursive: true });
  fs.writeFileSync(
    paths.firstActivationPath(safeTeamName, safeName),
    Date.now().toString(),
  );
}
