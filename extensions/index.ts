import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { registerFsTools } from "./fs-tools";
import * as messaging from "../src/utils/messaging";
import * as flavoredModels from "../src/utils/flavoredModels";
import {
  FLAVOR_VALUES,
  type FlavorKey,
  type FlavorValue,
  type FlavoredModelsResult,
  type ModelFlavor,
} from "../src/utils/flavoredModels";
import * as holdRun from "../src/utils/hold";
import { appendReply, buildClosingReport, buildWorkerReport, extractFinalReply } from "../src/utils/report";
import { Member, TeamMessage } from "../src/utils/models";
import * as paths from "../src/utils/paths";
import {
  type MessageListener,
  isListening,
  startListener,
  waitForListener,
} from "../src/utils/transport";
import * as teams from "../src/utils/teams";
import {
  getTopModelMatches,
  resolveModelWithProvider,
} from "../src/utils/modelSearch";
import {
  buildWorkerCommand,
  spawnWorkerProcess,
  seedWorkerStateFiles,
  extensionLoadFlags,
  resolveSpawnModel,
  resolveSpawnDirectory,
  READONLY_WORKER_TOOLS,
} from "../src/utils/spawn";
import { shQuote } from "../src/utils/terminal-adapter";

// Absolute path of the pi-teams extension entry loaded into THIS session.
// jiti provides __filename (and resolves import.meta.url) to the real module
// file whether pi-teams runs from a git checkout, a package install, or a
// standalone file. Spawned agents load exactly this entry with "-ne -e <path>"
// so they share the parent session's pi-teams copy instead of re-discovering
// it, which would double-register tools and fail to load.
const EXTENSION_ENTRY: string =
  typeof __filename !== "undefined" && __filename
    ? __filename
    : // @ts-expect-error: jiti resolves import.meta.url to the real module
      // file at runtime; tsc rejects it because the package builds into CJS.
      fileURLToPath(import.meta.url);



export function formatDeliveredMessages(messages: TeamMessage[]): string {
  if (messages.length === 0) return "";

  const formatOne = (m: TeamMessage): string => {
    const ts = new Date(m.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return [
      `**From:** ${m.from}`,
      `**To:** ${m.to}`,
      `**Subject:** ${m.subject}`,
      `**Timestamp:** ${ts}`,
      "",
      m.text,
    ].join("\n");
  };

  if (messages.length === 1) return formatOne(messages[0]);

  const sections = messages.map(
    (m, index) =>
      `<delivered-message index="${index + 1}">\n${formatOne(m)}\n</delivered-message>`,
  );
  return [
    "Multiple messages were delivered. Address all of them:",
    ...sections,
  ].join("\n\n");
}

export function mergeQueuedMessages(messages: readonly string[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0];

  const sections = messages.map(
    (message, index) =>
      `<queued-message index="${index + 1}">\n${message}\n</queued-message>`,
  );

  return [
    "Multiple queued messages were produced. Address all of them:",
    ...sections,
  ].join("\n\n");
}

/** Delay before a follow-up that failed to queue is flushed again while no run is active. */
const FOLLOW_UP_RETRY_MS = 2000;

/** Longest time a spawn tool waits for a new worker to start listening. */
const WORKER_LISTEN_TIMEOUT_MS = 30_000;

/** Longest time list_teammates waits for one member's socket to answer. */
const LISTEN_PROBE_TIMEOUT_MS = 500;

/**
 * Warn the lead when a new worker has not started listening yet.
 *
 * @param spawned - The spawn result
 * @returns An empty string when the worker listens, otherwise a warning sentence
 */
function listeningNote(spawned: { listening: boolean }): string {
  return spawned.listening
    ? ""
    : " The worker is not accepting messages yet. Check list_teammates before you send it a message.";
}

/**
 * Describe the members a broadcast could not reach.
 *
 * @param failed - The failed deliveries with their reasons
 * @returns A one-line summary naming each member
 */
function formatBroadcastFailures(failed: { name: string; reason: string }[]): string {
  return failed.map((f) => `${f.name} (${f.reason})`).join("; ");
}

export class FollowUpMessageQueue {
  private messages: string[] = [];

  enqueue(message: string): void {
    const trimmedMessage = message.trim();
    if (trimmedMessage) {
      this.messages.push(trimmedMessage);
    }
  }

  clear(): void {
    this.messages = [];
  }

  flush(send: (message: string) => void): void {
    const messages = this.messages;
    this.messages = [];

    const mergedMessage = mergeQueuedMessages(messages);
    if (mergedMessage) {
      send(mergedMessage);
    }
  }
}

/**
 * Minimal model-registry interface used by this extension.
 */
function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

// ── Model categorization ───────────────────────────────────────────────────

/** Categorized enabled-model lists returned by the get_models tool. */
export interface GetModelsResult {
  oss: string[];
  frontier: string[];
}

// ── Flavored models ─────────────────────────────────────────────────────────

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

/**
 * Migrate legacy high/med/fast settings to orchestrator/worker/swarm.
 *
 * Failures are reported as an error notice instead of thrown, so a malformed
 * settings file never blocks session start.
 *
 * @returns The warning text when a migration ran, the error text when it
 *   failed, or undefined when there was nothing to migrate
 */
function runFlavorMigration(): { text: string; failed: boolean } | undefined {
  try {
    const result = flavoredModels.migrateLegacyFlavors();
    return result
      ? { text: flavoredModels.buildMigrationNotice(result), failed: false }
      : undefined;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { text: `Flavored model migration failed: ${reason}`, failed: true };
  }
}

/**
 * Classify a model identifier as frontier (GPT/Claude) or OSS.
 *
 * @param modelId - The full model identifier (e.g. "openai-codex/gpt-5.5")
 * @return "frontier" if the model id contains "gpt" or "claude" (case-insensitive), "oss" otherwise
 */
export function classifyModel(modelId: string): "frontier" | "oss" {
  const lower = modelId.toLowerCase();
  return lower.includes("gpt") || lower.includes("claude") ? "frontier" : "oss";
}

/**
 * Execute the get_models tool: read enabled models from pi settings.json and
 * return two lists: OSS (non-frontier) and frontier (GPT/Claude).
 *
 * @return Tool result content plus categorized model details
 * @throws If the settings file cannot be read or parsed
 */
export function executeGetModels(): {
  content: { type: "text"; text: string }[];
  details: GetModelsResult;
} {
  const models = flavoredModels.readEnabledModels();

  const oss = models.filter((m) => classifyModel(m) === "oss");
  const frontier = models.filter((m) => classifyModel(m) === "frontier");

  const output = [
    "## OSS Models",
    ...(oss.length > 0 ? oss.map((m) => `  - ${m}`) : ["  (none)"]),
    "",
    "## Frontier Models",
    ...(frontier.length > 0 ? frontier.map((m) => `  - ${m}`) : ["  (none)"]),
  ].join("\n");

  return {
    content: [{ type: "text", text: output }],
    details: { oss, frontier },
  };
}

/**
 * Theme for the flavored-models SettingsList.
 *
 * @param theme - The TUI theme object for applying color functions
 * @returns A fully-configured SettingsListTheme
 */
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

/**
 * Execute the get-flavored-models tool: read flavor-categorized models from
 * pi settings.json and return three lists (orchestrator/worker/swarm).
 *
 * @param migrationNotice - Pending migration warning to prepend to the output
 * @returns Tool result content plus flavor details
 * @throws If the settings file cannot be read or parsed
 */
function executeGetFlavoredModels(migrationNotice?: string): {
  content: { type: "text"; text: string }[];
  details: FlavoredModelsResult;
} {
  const flavors = flavoredModels.readFlavoredModels();

  const sections = FLAVOR_KEYS.flatMap((flavor) => {
    const items = flavors[flavor];
    return [
      `## ${FLAVOR_LABELS[flavor]} Models`,
      ...(items.length > 0
        ? items.map((m) => `  - ${m}`)
        : ["  (none configured)"]),
      "",
    ];
  });

  return {
    content: [
      {
        type: "text",
        text: migrationNotice
          ? `${migrationNotice}\n\n${sections.join("\n")}`
          : sections.join("\n"),
      },
    ],
    details: flavors,
  };
}

/**
 * Handler for the /flavored-models command.
 *
 * Opens an interactive SettingsList UI that lets the user assign each
 * enabled model to a flavor (orchestrator/worker/swarm/none). Changes are saved to
 * settings.json when the dialog closes.
 *
 * @param ctx - The extension context providing the UI interface
 */
async function handleFlavoredModelsCommand(
  ctx: ExtensionContext,
): Promise<void> {
  // ── Phase 1: Read current state ───────────────────────────────────────────

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

  // Build in-memory flavor state
  const modelFlavors: ModelFlavor[] = flavoredModels.buildModelFlavors(
    enabledModels,
    flavors,
  );

  // ── Phase 2: Open interactive UI ──────────────────────────────────────────

  await ctx.ui.custom<void>(
    (tui: any, theme: any, _kb: unknown, done: (result?: void) => void) => {
      // Build SettingItems from current state
      const items: SettingItem[] = modelFlavors.map((mf) => ({
        id: mf.id,
        label: mf.id,
        currentValue: mf.flavor,
        values: [...FLAVOR_VALUES],
      }));

      const container = new Container();

      // Header
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Flavored Model Configuration")),
        ),
      );
      container.addChild(new Spacer());

      // SettingsList
      const settingsTheme = buildSettingsListTheme(theme);
      const maxVisible = Math.min(items.length + 2, 15);

      const settingsList = new SettingsList(
        items,
        maxVisible,
        settingsTheme,
        (id: string, newValue: string) => {
          // Update in-memory state (no disk write yet)
          const mf = modelFlavors.find((f) => f.id === id);
          if (mf) {
            mf.flavor = newValue as FlavorValue;
          }
        },
        () => {
          // Cancel: discard changes, close dialog
          done(undefined);
        },
      );

      container.addChild(settingsList);
      container.addChild(new Spacer());

      // Footer hint
      const summary = flavoredModels.buildFooterSummary(modelFlavors);
      container.addChild(
        new Text(theme.fg("dim", `Enter/Space to cycle \u2022 Esc to cancel`)),
      );
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

  // ── Phase 3: Save on close ────────────────────────────────────────────────

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

/** Minimal shape of a message content block that carries text. */
interface TextContentBlock {
  type: string;
  text: string;
}

/**
 * Extract the text of the most recent user message on the branch, walking
 * backwards so tool results and non-user entries in between are skipped.
 *
 * @param entries - Branch entries in path order (oldest first)
 * @returns The last user message's text content, or null when the branch has no user message with text
 */
export function getLastUserMessageText(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const message = (
      entry as {
        message?: { role?: string; content?: string | TextContentBlock[] };
      }
    ).message;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      const trimmed = message.content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    const text = (message.content ?? [])
      .filter(
        (block): block is TextContentBlock =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text.trim())
      .filter((text) => text.length > 0)
      .join("\n");
    if (text) return text;
  }
  return null;
}

/** Tools granted to read-only workers at spawn and reported in spawn results. */


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


export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentType = process.env.PI_AGENT_TYPE || "lead";
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  let teamName = process.env.PI_TEAM_NAME;

  // Tool identity: spawned workers carry PI_AGENT_TYPE "teammate" or
  // "readonly-worker"; every other session (the interactive lead or a lead
  // window) is the team-lead. A worker named "team-lead" is excluded from
  // worker tools because removeAgent refuses to remove any agent with that
  // name, so a close_myself call would silently leave it running.
  const isLead = agentType === "lead";
  const isWorker =
    (agentType === "teammate" || agentType === "readonly-worker") &&
    agentName !== "team-lead";

  // ── Spawn plumbing ────────────────────────────────────────────────────
  // spawn_teammate and spawn_readonly_worker share this path: model
  // resolution, member record, state pre-seed, then launch through the
  // terminal adapter.

  interface SpawnWorkerGoals {
    team: string;
    name: string;
    /** Raw cwd input: undefined resolves to the lead's current directory */
    cwd?: string;
    /** Raw model input: undefined or "default" resolves to the lead's model */
    modelRequest?: string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
    separateWindow?: boolean;
    readonlyWorker: boolean;
  }

  interface SpawnedWorker {
    member: Member;
    terminalId: string;
    isWindow: boolean;
    model: string;
    /** True when the worker accepted connections before the wait ended. */
    listening: boolean;
  }

  async function spawnTeamWorker(
    ctx: ExtensionContext,
    goals: SpawnWorkerGoals,
  ): Promise<SpawnedWorker> {
    const safeName = paths.sanitizeName(goals.name);
    const safeTeamName = paths.sanitizeName(goals.team);
    if (!teams.teamExists(safeTeamName)) {
      throw new Error(`Team ${goals.team} does not exist`);
    }
    if (!terminal) {
      throw new Error("No terminal adapter detected.");
    }
    const teamConfig = await teams.readConfig(safeTeamName);
    const cwd = resolveSpawnDirectory(goals.cwd);
    const model = resolveSpawnModel(ctx, goals.modelRequest);
    const useSeparateWindow =
      !goals.readonlyWorker &&
      (goals.separateWindow ?? teamConfig.separateWindows ?? false);
    if (useSeparateWindow && !terminal.supportsWindows()) {
      throw new Error(
        `Separate windows mode is not supported in ${terminal.name}.`,
      );
    }

    const { piCmd, agentType } = buildWorkerCommand(goals, model, extensionLoadFlags(EXTENSION_ENTRY));
    // Reject duplicate names up front: two members with the same name would
    // share an inbox and pid file, and removeMember would remove both records.
    if (teamConfig.members.some((m) => m.name === safeName)) {
      throw new Error(`A member named "${safeName}" already exists in team "${goals.team}".`);
    }
    const member: Member = {
      agentId: `${safeName}@${safeTeamName}`,
      name: safeName,
      agentType,
      model,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd,
      subscriptions: [],
      color: goals.readonlyWorker ? "green" : "blue",
      thinking: goals.readonlyWorker ? undefined : goals.thinking,
    };
    await teams.addMember(safeTeamName, member);

    const env: Record<string, string> = {
      ...process.env,
      PI_TEAM_NAME: safeTeamName,
      PI_AGENT_NAME: safeName,
      PI_AGENT_TYPE: agentType,
    };
    seedWorkerStateFiles(safeTeamName, safeName);

    let terminalId = "";
    try {
      terminalId = spawnWorkerProcess(terminal, {
        teamName: safeTeamName,
        name: safeName,
        cwd,
        piCmd,
        env,
        members: teamConfig.members,
        useSeparateWindow,
        readonlyWorker: goals.readonlyWorker,
      });
    } catch (e) {
      // Roll back the member record and seeded state so a failed spawn does
      // not leave a ghost member in the config.
      await teams.removeMember(safeTeamName, safeName).catch(() => {});
      teams.resetAgentState(safeTeamName, safeName);
      throw new Error(
        `Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`,
      );
    }
    await teams.updateMember(
      safeTeamName,
      safeName,
      useSeparateWindow ? { windowId: terminalId } : { tmuxPaneId: terminalId },
    );

    // The first message can arrive before the worker boots. Wait for its
    // socket so a send right after the spawn does not fail.
    const listening = await waitForListener(safeTeamName, safeName, WORKER_LISTEN_TIMEOUT_MS);

    return { member, terminalId, isWindow: useSeparateWindow, model, listening };
  }

  const terminal = getTerminalAdapter();
  /** Socket listener that receives messages for this agent. */
  let messageListener: MessageListener | null = null;
  /** Team the current listener belongs to, so a new team replaces it. */
  let listenerTeam: string | undefined;
  /** Timer that retries a follow-up that could not be queued. */
  let followUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let titleRefreshTimeouts: ReturnType<typeof setTimeout>[] = [];
  let isAgentRunning = false;
  /** Final replies of the runs in the current settle cycle, captured at agent_end for the report. */
  let cycleReplies: string[] = [];
  /** Newest assistant text of the run in progress, kept so close_myself can report it. */
  let currentRunText: string | null = null;
  /** True once this worker messaged the team-lead during the current run cycle. */
  let reportedToLead = false;
  /** Migration warning shown to the model on its next get_flavored_models call */
  let pendingMigrationNotice: string | undefined;
  // Captured from the first context that carries a model registry, so the
  // Increments once a follow-up message has actually reached the agent's
  // followUp queue. The agent_end hold loop watches this counter to decide
  // when the run should continue with queued worker results.
  let followUpEpoch = 0;
  const pendingInboxNotifications = new FollowUpMessageQueue();

  function clearFollowUpRetryTimer(): void {
    if (followUpRetryTimer == null) return;
    clearTimeout(followUpRetryTimer);
    followUpRetryTimer = null;
  }

  function clearTitleRefreshTimeouts(): void {
    for (const timeoutId of titleRefreshTimeouts) {
      clearTimeout(timeoutId);
    }
    titleRefreshTimeouts = [];
  }

  function setSessionTitle(ctx: ExtensionContext, title: string): void {
    ctx.ui.setTitle(title);
    terminal?.setTitle(title);
  }

  function scheduleTerminalTitleRefreshes(title: string): void {
    if (!terminal) {
      return;
    }
    clearTitleRefreshTimeouts();
    for (const delayMs of [500, 2000, 5000]) {
      const timeoutId = setTimeout(() => {
        terminal.setTitle(title);
      }, delayMs);
      titleRefreshTimeouts.push(timeoutId);
    }
  }

  function sendFollowUp(message: string): void {
    // deliverAs: 'followUp' queues the message and delivers it as a user
    // message at the start of the agent's next natural turn boundary.
    // This avoids interrupting mid-turn operations while still providing
    // real-time context before the agent begins new work.
    void (async () => {
      try {
        // Increment only after the promise resolves: the agent_end hold loop
        // must not observe the epoch change before the message has actually
        // reached the agent's followUp queue.
        await pi.sendUserMessage(message, { deliverAs: "followUp" });
        followUpEpoch++;
      } catch (_err) {
        // A transient failure (for example compaction in progress) must not
        // lose the message. Re-queue it. The next agent_end flushes it, and
        // when no run is active the retry timer flushes it instead.
        pendingInboxNotifications.enqueue(message);
        scheduleFollowUpRetry();
      }
    })();
  }

  /**
   * Deliver a formatted message body to this agent. While the agent is mid-run,
   * the message is queued and flushed as a follow-up at the run boundary so it
   * never interrupts active tool work. When idle, it is sent immediately to
   * wake the agent for a new turn.
   */
  function deliverPendingMessage(message: string): void {
    if (isAgentRunning) {
      pendingInboxNotifications.enqueue(message);
      return;
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage) {
      sendFollowUp(trimmedMessage);
    }
  }

  /** Retry a failed follow-up after a short delay when no run will flush it. */
  function scheduleFollowUpRetry(): void {
    if (isAgentRunning || followUpRetryTimer != null) return;
    followUpRetryTimer = setTimeout(() => {
      followUpRetryTimer = null;
      pendingInboxNotifications.flush(sendFollowUp);
    }, FOLLOW_UP_RETRY_MS);
  }

  /**
   * Receive one message from a teammate. The transport calls this before it
   * acknowledges the sender, so a message the agent cannot take is reported
   * back to the sender.
   */
  function receiveTeamMessage(message: TeamMessage): void {
    deliverPendingMessage(formatDeliveredMessages([message]));
  }

  /**
   * Listen for messages addressed to this agent. Starts a new listener when
   * the team changed since the last call and does nothing otherwise.
   *
   * @throws Error when the socket cannot be created
   */
  async function ensureListener(): Promise<void> {
    if (!teamName || (messageListener && listenerTeam === teamName)) return;
    await closeListener();
    messageListener = await startListener(teamName, agentName, receiveTeamMessage);
    listenerTeam = teamName;
  }

  async function closeListener(): Promise<void> {
    const current = messageListener;
    messageListener = null;
    listenerTeam = undefined;
    await current?.close();
  }

  // Block "sleep N" bash commands for agents that participate in a team.
  // Waiting agents must end their turn; an incoming message wakes them
  // automatically. Sleeping wastes wall time and
  // tokens and delays responses to the team-lead.
  const SLEEP_COMMAND_PATTERN = /^sleep\s+\d+/;
  pi.on("tool_call", async (event) => {
    // Only enforce while a team is online; otherwise this would interfere
    // with ordinary sleep usage in standalone pi sessions.
    if (!teamName || !teams.teamExists(teamName)) {
      return;
    }
    if (event.toolName !== "bash") {
      return;
    }
    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string") {
      return;
    }
    if (!SLEEP_COMMAND_PATTERN.test(input.command.trim())) {
      return;
    }
    return {
      block: true,
      reason:
        "Blocked: do not run sleep commands to wait for incoming messages. Stop sleeping and simply end your turn. Messages are delivered to you automatically; the system will notify you as soon as a new one arrives. Just say you are waiting and stop.",
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    isAgentRunning = false;
    if (isLead) {
      const migration = runFlavorMigration();
      if (migration) {
        ctx.ui.notify(migration.text, migration.failed ? "error" : "warning");
        if (!migration.failed) {
          pendingMigrationNotice = migration.text;
        }
      }
    }
    pendingInboxNotifications.clear();
    paths.ensureDirs();
    if (isTeammate) {
      ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");
      ctx.ui.setStatus("00-pi-teams", `[${agentName.toUpperCase()}]`);

      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      setSessionTitle(ctx, fullTitle);
      scheduleTerminalTitleRefreshes(fullTitle);

      // On first spawn, purge ALL stale state from any previous session and
      // stamp the firstActivationFile immediately, before the listener starts.
      if (teamName) {
        const firstActivationFile = paths.firstActivationPath(
          teamName,
          agentName,
        );
        if (!fs.existsSync(firstActivationFile)) {
          teams.resetAgentState(teamName, agentName);
          fs.writeFileSync(firstActivationFile, Date.now().toString());
        }
        // Record the pid after cleanup: resetAgentState deletes the pid file.
        fs.writeFileSync(paths.pidPath(teamName, agentName), process.pid.toString());
      }

    } else if (teamName) {
      ctx.ui.setStatus("pi-teams", `Lead @ ${teamName}`);
    }
    try {
      await ensureListener();
    } catch (e) {
      ctx.ui.notify(`pi-teams: cannot receive messages: ${e}`, "error");
    }
  });

  function setActiveStatus(active: boolean) {
    if (!teamName) return;
    const teamDirectory = paths.teamDir(teamName);
    if (!fs.existsSync(teamDirectory)) {
      fs.mkdirSync(teamDirectory, { recursive: true });
    }
    const activeFile = paths.activePath(teamName, agentName);
    if (active) {
      fs.writeFileSync(activeFile, Date.now().toString());
    } else {
      if (fs.existsSync(activeFile)) {
        fs.unlinkSync(activeFile);
      }
    }
  }

  function isAgentActive(team: string, agent: string): boolean {
    const activeFile = paths.activePath(team, agent);
    if (!fs.existsSync(activeFile)) return false;
    try {
      const timestamp = parseInt(fs.readFileSync(activeFile, "utf-8").trim());
      const age = Date.now() - timestamp;
      return age < 5 * 60 * 1000; // Consider stale if older than 5 minutes
    } catch {
      return false;
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    setActiveStatus(true);
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      setSessionTitle(ctx, fullTitle);
    }
  });

  /**
   * Resolve after the given delay.
   *
   * @param ms - Delay in milliseconds
   */
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Decide liveness for one teammate. The pid file written at the member's
   * session_start is the most reliable signal: it needs only a filesystem
   * read plus a signal-0 probe, and it appears before the member's first
   * turn so booting workers count as alive. Pane and window probes and the
   * fresh activity marker remain as fallbacks.
   *
   * @param team - Name of the team the member belongs to
   * @param member - Team member to evaluate
   * @returns True when the member can still produce work or messages
   */
  function isMemberAlive(team: string, member: Member): boolean {
    if (isProcessAlive(paths.pidPath(team, member.name))) {
      return true;
    }
    if (member.windowId && terminal?.isWindowAlive(member.windowId))
      return true;
    if (member.tmuxPaneId && terminal?.isAlive(member.tmuxPaneId)) return true;
    return isAgentActive(team, member.name);
  }

  /**
   * Check whether the process named by a pid file is still running.
   *
   * @param pidPath - Path to the pid file to probe
   * @returns True when the process is alive
   */
  function isProcessAlive(pidPath: string): boolean {
    if (!fs.existsSync(pidPath)) return false;
    try {
      const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isFinite(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but is owned by another user, which
      // still counts as running.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Capture what the hold loop needs to know about a team's state. A config
   * read error returns null so a transient file-lock wait never releases the
   * run by mistake.
   *
   * @param team - Name of the team to evaluate
   * @returns Team-liveness snapshot, or null when the config cannot be read
   */
  async function teamLivenessSnapshot(
    team: string,
  ): Promise<holdRun.TeamLivenessSnapshot | null> {
    if (!teams.teamExists(team)) {
      return { teamExists: false, workerCount: 0, liveWorkerCount: 0 };
    }
    try {
      const config = await teams.readConfig(team);
      const workers = config.members.filter((m) => m.name !== "team-lead");
      return {
        teamExists: true,
        workerCount: workers.length,
        liveWorkerCount: holdRun.countLiveWorkers(config, (member) =>
          isMemberAlive(team, member),
        ),
      };
    } catch (_err) {
      return null;
    }
  }

  /**
   * Hold the agent run open while the team is active so the host process does
   * not exit before workers report back.
   *
   * In print-like host modes pi exits as soon as the run settles, which would
   * strand spawned workers. Parking inside the agent_end handler keeps the run
   * alive with no LLM activity between worker updates. When a worker message
   * is queued as a followUp, the epoch counter changes, the hold releases, and
   * agent.continue() wakes the lead with the queued results.
   *
   * @param ctx - Extension context providing the run mode and abort signal
   * @param epochAtEntry - followUpEpoch value captured before pending inbox
   *   notifications were flushed
   */
  async function holdRunOpenForActiveTeam(
    ctx: ExtensionContext,
    epochAtEntry: number,
  ): Promise<void> {
    if (
      !holdRun.shouldHoldWhileTeamActive({
        hasUI: ctx.hasUI,
        isTeammate,
        teamName,
      })
    ) {
      return;
    }
    const activeTeam = teamName;
    if (!activeTeam) return;

    let livenessFailures = 0;
    for (let poll = 0; ; poll++) {
      if (followUpEpoch !== epochAtEntry) return;
      if (poll % holdRun.RUN_HOLD_LIVENESS_POLL_EVERY === 0) {
        const snapshot = await teamLivenessSnapshot(activeTeam);
        if (snapshot !== null) {
          livenessFailures =
            snapshot.liveWorkerCount > 0 ? 0 : livenessFailures + 1;
          if (holdRun.shouldReleaseRun(snapshot, livenessFailures)) return;
        }
      }
      await wait(holdRun.RUN_HOLD_MESSAGE_POLL_MS);
    }
  }

  pi.on("agent_start", async () => {
    isAgentRunning = true;
    // Do not clear pendingInboxNotifications here: messages queued by a failed
    // sendFollowUp retry, or queued mid-run for the boundary flush, would be
    // lost because no copy exists on disk. The queue is flushed at agent_end
    // and cleared only on session_shutdown.
  });

  pi.on("agent_end", async (_event, ctx) => {
    isAgentRunning = false;
    // Capture before the flush: messages queued by the flush advance the
    // epoch, so the hold releases immediately and the run continues with the
    // queued worker results instead of batching them while parked.
    const epochAtEntry = followUpEpoch;
    pendingInboxNotifications.flush(sendFollowUp);
    await holdRunOpenForActiveTeam(ctx, epochAtEntry);
  });

  pi.on("turn_end", async () => {
    setActiveStatus(false);
  });

  // Track the newest assistant text of the running run. A worker that closes
  // itself never reaches agent_end, so close_myself reads this value.
  pi.on("message_end", async (event) => {
    if (!isWorker) return;
    currentRunText = extractFinalReply([event.message]) ?? currentRunText;
  });

  // agent_end fires once per low-level run; retries and queued work can start
  // more runs before the session settles. Keep every run's reply, in order.
  pi.on("agent_end", async (event) => {
    if (!isWorker) return;
    cycleReplies = appendReply(cycleReplies, extractFinalReply(event.messages));
    currentRunText = null;
  });

  // agent_settled means Pi will not continue on its own. For a worker, that is
  // the moment to report to the team-lead, unless the worker already did.
  pi.on("agent_settled", async (event) => {
    if (!isWorker || !teamName) return;
    const replies = cycleReplies;
    const alreadyReported = reportedToLead;
    cycleReplies = [];
    reportedToLead = false;
    if (alreadyReported && !event.aborted) return;
    const report = buildWorkerReport(agentName, replies, event.aborted);
    try {
      await messaging.sendPlainMessage(
        teamName,
        agentName,
        "team-lead",
        report.subject,
        report.text,
      );
    } catch (_e) {
      // The team directory can be gone after team_shutdown or close_worker.
    }
  });

  pi.on("session_shutdown", async () => {
    clearFollowUpRetryTimer();
    await closeListener();
    clearTitleRefreshTimeouts();
    isAgentRunning = false;
    pendingInboxNotifications.clear();
    // Remove our own pid file so a later removeAgent cannot mistake the
    // (now reusable) pid for a live worker.
    if (isTeammate && teamName) {
      try {
        const pidFile = paths.pidPath(teamName, agentName);
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch (_e) {
        // ignore
      }
    }
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    // Lead running in an auto-exit host mode: the extension holds the run open
    // while the team is active. Tell the lead so it ends its turn instead of
    // polling, and releases the session through team_shutdown when done.
    if (
      !isTeammate &&
      holdRun.shouldGuideLead({ hasUI: ctx.hasUI, isTeammate })
    ) {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nNon-interactive session: when a team is active, the session stays alive after you end a turn. Worker messages arrive automatically as user messages; never poll, sleep, or run wait commands because they are blocked while a team is online. Respond with your plan or status and end your turn when workers are running. When every teammate has reported back and the work is complete, call team_shutdown with the team name; the team closes and the session exits normally.`,
      };
    }

    if (isTeammate && firstTurn) {
      firstTurn = false;

      let modelInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find((m) => m.name === agentName);
          if (member && member.model) {
            modelInfo = `\nYou are currently using model: ${member.model}`;
            if (member.thinking) {
              modelInfo += ` with thinking level: ${member.thinking}`;
            }
            modelInfo += `. When reporting your model or thinking level, use these exact values.`;
          }
        } catch (e) {
          // Ignore
        }
      }

      const roleDescription =
        agentType === "readonly-worker" ? "read-only worker" : "teammate";

      const capabilitiesNote =
        agentType === "readonly-worker"
          ? "\nYou are limited to reading files (read, grep, find, ls), messaging (send_message), and close_myself. You cannot write, edit, or execute commands. Close yourself with close_myself only when your instructions tell you to."
          : "";

      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nYou are ${roleDescription} '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${capabilitiesNote}\nMessages from teammates are delivered to you automatically as user messages; you do not need to fetch them. When your work is done, end your turn and stop. Your final reply is sent to the team-lead automatically, so make it a complete report. Use send_message only for extra messages, such as a question mid-task. You will be woken automatically when the next message arrives.\n\nHARD RULES (violating these wastes tokens and breaks the team):\n- NEVER run sleep, polling, or wait commands (e.g. 'sleep 30', 'while true; do ...; done').\n- NEVER loop or poll to wait for messages. They arrive on their own.\n- When your work is done, simply stop. Do not announce that you are 'sleeping' or 'waiting' with a command. Just end your turn.`,
      };
    }
  });

  // ── Team-lead tools ─────────────────────────────────────────────────────
  // Everything a lead session needs to build, staff, inspect, and disband a
  // team. Registered for any session that is not a spawned worker.

  if (isLead) {
    pi.registerTool({
      name: "team_create",
      label: "Create Team",
      description: "Create a new agent team.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          description: Type.Optional(Type.String()),
          default_model: Type.Optional(Type.String()),
          separate_windows: Type.Optional(
            Type.Boolean({
              default: false,
              description:
                "Open teammates in separate OS windows instead of panes",
            }),
          ),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const config = teams.createTeam(
          params.team_name,
          "local-session",
          "lead-agent",
          params.description,
          params.default_model,
          params.separate_windows,
        );
        teamName = params.team_name;
        process.env.PI_TEAM_NAME = params.team_name;
        await ensureListener();
        return {
          content: [
            { type: "text", text: `Team ${params.team_name} created.` },
          ],
          details: { config },
        };
      },
    });
    pi.registerTool({
      name: "resolve_model",
      label: "Resolve Model",
      description:
        'Resolve a provider/model name for use in spawn_teammate. ALWAYS provide the full <provider>/<model> format (e.g., "anthropic/claude-sonnet-4-20250514", "bighank/Qwen35Coder-35B-NoThinking"). ' +
        'To find what provider/model pairs are available: call get_available_models() or use "DEFAULT MODEL" which is the team-leader\'s own model. ' +
        "This tool ONLY searches within the specified provider when a provider prefix is given. Bare names resolve through a priority ladder: flavored models from pi settings first, then the scoped models (pi --models flag or the enabledModels list), then the full registry. If no match is found, try a different provider or use DEFAULT MODEL.",
      parameters: asPiToolSchema(
        Type.Object({
          model_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const requested = params.model_name.trim();
        if (!requested) {
          throw new Error("model_name must not be empty.");
        }

        const topMatches = getTopModelMatches(requested, ctx.modelRegistry, 5);
        const defaultModel = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : null;
        const resolved = resolveModelWithProvider(requested, ctx.modelRegistry);
        if (!resolved) {
          const matchesText = topMatches.map((m) => m.model).join(", ");
          const outputText = defaultModel
            ? `DEFAULT MODEL: ${defaultModel}, Best matches: ${matchesText}`
            : matchesText;
          return {
            content: [
              {
                type: "text",
                text: outputText,
              },
            ],
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
        "Model selection: before spawning, call get_flavored_models to see the " +
        "configured orchestrator/worker/swarm model lists. Pick from the worker " +
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
          team_name: Type.String(),
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
                "get_flavored_models guidance (flavor-matched, provider-diverse, " +
                "falling back to the team lead's model).",
            }),
          ),
          thinking: Type.Optional(
            StringEnum(["off", "minimal", "low", "medium", "high"]),
          ),
          separate_window: Type.Optional(Type.Boolean({ default: false })),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const spawned = await spawnTeamWorker(ctx, {
          team: params.team_name,
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
              text: `Teammate ${params.name} spawned in ${spawned.isWindow ? "window" : "pane"} ${spawned.terminalId}.${listeningNote(spawned)}`,
            },
          ],
          details: {
            agentId: spawned.member.agentId,
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
        "Model selection: before spawning, call get_flavored_models and pick a " +
        "model from the swarm list. If the swarm list is empty, pick from the " +
        "worker list. If that is empty too, spawn the same model as yours (the " +
        "team lead's). Prefer spreading teammates/workers/subagents across different providers " +
        "unless the user names specific models.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
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
                "get_flavored_models lists. Omit to use the team lead's model.",
            }),
          ),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const spawned = await spawnTeamWorker(ctx, {
          team: params.team_name,
          name: params.name,
          cwd: params.cwd,
          modelRequest: params.model,
          readonlyWorker: true,
        });
        return {
          content: [
            {
              type: "text",
              text: `Read-only worker ${params.name} spawned in pane ${spawned.terminalId}. Restricted to: read, grep, find, ls, messaging (send_message), and close_myself.${listeningNote(spawned)}`,
            },
          ],
          details: {
            agentId: spawned.member.agentId,
            terminalId: spawned.terminalId,
            listening: spawned.listening,
            tools: [...READONLY_WORKER_TOOLS],
          },
        };
      },
    });
    pi.registerTool({
      name: "spawn_lead_window",
      label: "Spawn Lead Window",
      description: "Open the team lead in a separate OS window.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          cwd: Type.Optional(Type.String()),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const safeTeamName = paths.sanitizeName(params.team_name);
        if (!teams.teamExists(safeTeamName))
          throw new Error(`Team ${params.team_name} does not exist`);
        if (!terminal || !terminal.supportsWindows())
          throw new Error("Windows mode not supported.");

        const teamConfig = await teams.readConfig(safeTeamName);
        const cwd = params.cwd || process.cwd();
        const piBinary = process.argv[1] ? `node ${shQuote(process.argv[1])}` : "pi";
        let piCmd = `${piBinary} ${extensionLoadFlags(EXTENSION_ENTRY)}`;
        if (teamConfig.defaultModel) {
          // Use the combined --model provider/model format; shQuote keeps shell
          // metacharacters in the model name from changing the command.
          piCmd = `${piCmd} --model ${shQuote(teamConfig.defaultModel)}`;
        }

        const env = {
          ...process.env,
          PI_TEAM_NAME: safeTeamName,
          PI_AGENT_NAME: "team-lead",
        };
        try {
          const windowId = terminal.spawnWindow({
            name: "team-lead",
            cwd,
            command: piCmd,
            env,
            teamName: safeTeamName,
          });
          await teams.updateMember(safeTeamName, "team-lead", { windowId });
          return {
            content: [
              { type: "text", text: `Lead window spawned: ${windowId}` },
            ],
            details: { windowId },
          };
        } catch (e) {
          throw new Error(`Failed: ${e}`);
        }
      },
    });
    pi.registerTool({
      name: "team_shutdown",
      label: "Shutdown Team",
      description: "Shutdown the entire team and close all panes/windows.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const teamName = params.team_name;
        try {
          const config = await teams.readConfig(teamName);
          for (const member of config.members) {
            await teams.removeAgent({
              team: teamName,
              agentName: member.name,
              terminal,
            });
          }
          const dir = paths.teamDir(teamName);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
          return {
            content: [{ type: "text", text: `Team ${teamName} shut down.` }],
            details: {},
          };
        } catch (e) {
          throw new Error(`Failed to shutdown team: ${e}`);
        }
      },
    });
    pi.registerTool({
      name: "close_worker",
      label: "Close Worker",
      description: "Process a teammate/worker/subagent's shutdown.",
      parameters: asPiToolSchema(
        Type.Object({
          team_name: Type.String(),
          agent_name: Type.String(),
        }),
      ) as any,
      async execute(toolCallId, params: any, signal, onUpdate, ctx) {
        const config = await teams.readConfig(params.team_name);
        const member = config.members.find((m) => m.name === params.agent_name);
        if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

        await teams.removeAgent({
          team: params.team_name,
          agentName: params.agent_name,
          terminal,
        });
        return {
          content: [
            {
              type: "text",
              text: `Teammate ${params.agent_name} has been shut down.`,
            },
          ],
          details: {},
        };
      },
    });

    // Flavored models: tool + interactive command
    pi.registerTool({
      name: "get_flavored_models",
      label: "Get Flavored Models",
      description:
        "Read flavor-categorized models from pi settings.json and return three " +
        "lists: orchestrator (orchestrating, planning, coordinating), worker " +
        "(coding), and swarm (read-only information gathering).",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        try {
          const notice = pendingMigrationNotice;
          pendingMigrationNotice = undefined;
          return executeGetFlavoredModels(notice);
        } catch (e) {
          throw new Error(`Failed to read flavored models: ${e}`);
        }
      },
      renderCall(_args: any, theme: any): any {
        const text = new Text("", 0, 0);
        text.setText(theme.fg("toolTitle", theme.bold("get_flavored_models")));
        return text;
      },
      renderResult(
        result: any,
        _options: { expanded: boolean },
        theme: any,
      ): any {
        const text = new Text("", 0, 0);
        const details = result.details as FlavoredModelsResult | undefined;
        if (!details) {
          text.setText(theme.fg("error", "[no result]"));
          return text;
        }

        const lines = FLAVOR_KEYS.flatMap((key) => {
          const items = details[key];
          const color = FLAVOR_COLOR[key];
          const modelLines =
            items.length > 0
              ? items.map(
                  (m) => `  ${theme.fg(color, FLAVOR_BULLET[key])} ${m}`,
                )
              : [theme.fg("dim", "  (none configured)")];
          return [
            theme.fg("toolTitle", theme.bold(`${FLAVOR_LABELS[key]} Models`)),
            ...modelLines,
            "",
          ];
        });

        text.setText(lines.join("\n"));
        return text;
      },
    });

    pi.registerTool({
      name: "get_models",
      label: "Get Models",
      description:
        "Read enabled models from pi settings.json and return two lists: " +
        'OSS (models not containing "gpt" or "claude", e.g. Qwen, DeepSeek, ' +
        'Nemotron) and frontier (models containing "gpt" or "claude", e.g. ' +
        "GPT-5.x, Claude Sonnet).",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        try {
          return executeGetModels();
        } catch (e) {
          throw new Error(`Failed to read enabled models: ${e}`);
        }
      },
      renderCall(_args: any, theme: any): any {
        const text = new Text("", 0, 0);
        text.setText(theme.fg("toolTitle", theme.bold("get_models")));
        return text;
      },
      renderResult(
        result: any,
        _options: { expanded: boolean },
        theme: any,
      ): any {
        const text = new Text("", 0, 0);
        const details = result.details as GetModelsResult | undefined;
        if (!details) {
          text.setText(theme.fg("error", "[no result]"));
          return text;
        }

        const ossList =
          details.oss.length > 0
            ? details.oss
                .map((m) => `  ${theme.fg("success", "\u25CF")} ${m}`)
                .join("\n")
            : theme.fg("dim", "  (none)");
        const frontierList =
          details.frontier.length > 0
            ? details.frontier
                .map((m) => `  ${theme.fg("accent", "\u25C6")} ${m}`)
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
      },
    });

    pi.registerCommand("flavored-models", {
      description:
        "Configure model flavor assignments (orchestrator/worker/swarm/none)",
      handler: (_args: string, ctx: ExtensionContext) =>
        handleFlavoredModelsCommand(ctx),
    });
  }
  // ── Shared tools ─────────────────────────────────────────────────────────
  // Messaging and team status. Available to the team-lead and to workers.

  // Hash-guarded read/edit/write overrides (see fs-tools.ts). These replace
  // pi's built-ins so every session on the team holds fresh content hashes.
  registerFsTools(pi);

  pi.registerCommand("keep_last", {
    description: "Remove all session history except the last user message",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const branch = ctx.sessionManager.getBranch();
      const text = getLastUserMessageText(branch);
      if (!text) {
        ctx.ui.notify("No user message to keep in this session", "error");
        return;
      }
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      // The old session file is preserved on disk through parentSession, so the
      // trimmed history stays recoverable. The replacement session starts
      // empty; in interactive mode the kept message is placed in the editor so
      // it can be reviewed and sent again against a clean context.
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          if (replacementCtx.mode === "tui") {
            replacementCtx.ui.setEditorText(text);
            replacementCtx.ui.notify(
              "History cleared; last message moved to the editor",
              "info",
            );
          }
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("Cancelled", "info");
      }
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to a teammate/worker/subagent. The message arrives immediately as a user message. " +
      `Set recipient to "${messaging.BROADCAST_RECIPIENT}" to send it to every other team member. ` +
      "Do not use a broadcast just to answer the team-lead. Name the team-lead as the recipient instead. " +
      "The tool fails at once when the recipient is not running.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.Optional(
          Type.String({ description: "Defaults to your current team." }),
        ),
        recipient: Type.String({
          description: `A team member name, or "${messaging.BROADCAST_RECIPIENT}" for every other member.`,
        }),
        subject: Type.String({
          description: "Short subject line for the message.",
        }),
        content: Type.String({ description: "Full message body." }),
        summary: Type.Optional(
          Type.String({ description: "Optional brief summary." }),
        ),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const resolvedTeam = params.team_name || teamName;
      if (!resolvedTeam)
        throw new Error("team_name is required (no team is currently active).");

      if (params.recipient === messaging.BROADCAST_RECIPIENT) {
        const result = await messaging.broadcastMessage(
          resolvedTeam,
          agentName,
          params.subject,
          params.content,
          params.summary,
        );
        // A broadcast reaches the lead, so it counts as a report.
        if (result.delivered.includes("team-lead")) reportedToLead = true;
        if (result.delivered.length === 0 && result.failed.length > 0) {
          throw new Error(`Broadcast reached no one. ${formatBroadcastFailures(result.failed)}`);
        }
        const failureNote =
          result.failed.length > 0 ? `\nNot reached: ${formatBroadcastFailures(result.failed)}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${result.delivered.join(", ") || "no one"}.${failureNote}`,
            },
          ],
          details: { delivered: result.delivered, failed: result.failed },
        };
      }

      await messaging.sendPlainMessage(
        resolvedTeam,
        agentName,
        params.recipient,
        params.subject,
        params.content,
        params.summary,
      );
      if (params.recipient === "team-lead") reportedToLead = true;
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${params.recipient}.\n\n${params.content}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List all teammates/workers/subagents in a team with their status.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.String(),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const teammates = await Promise.all(
        config.members.map(async (m) => {
          const alive =
            m.name === "team-lead" && !isTeammate
              ? true
              : isMemberAlive(params.team_name, m);
          const listening =
            m.name === agentName && messageListener
              ? true
              : await isListening(params.team_name, m.name, LISTEN_PROBE_TIMEOUT_MS);
          const active = isAgentActive(params.team_name, m.name);
          return {
            name: m.name,
            agentType: m.agentType,
            model: m.model,
            alive,
            active,
            listening,
          };
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(teammates, null, 2) }],
        details: { teammates },
      };
    },
  });

  // ── Worker tools ─────────────────────────────────────────────────────────
  // Tools for spawned workers only. The gate mirrors what removeAgent can
  // remove: any spawned worker, never the team-lead, never the interactive
  // lead session.

  if (isWorker) {
    pi.registerTool({
      name: "close_myself",
      label: "Close Myself",
      description:
        "Close this agent: remove yourself from the team config, clean up your state files, and terminate your own process and terminal pane or window. " +
        "Do not run this unless your instructions told you to run it. When the team-lead tells you to close yourself, call this tool instead of ending your turn or running kill commands. " +
        "Write your final report as text in the same turn before the call. The extension sends that text to the team-lead as your last report, because you stop running when this tool runs.",
      parameters: asPiToolSchema(Type.Object({})) as any,
      async execute() {
        const activeTeam = teamName;
        if (!activeTeam) {
          throw new Error(
            "No team is active for this agent, so there is nothing to close.",
          );
        }

        // A closing worker never reaches agent_settled, so report its replies
        // now, while the lead can still receive them.
        const report = buildClosingReport(agentName, appendReply(cycleReplies, currentRunText));
        try {
          await messaging.sendPlainMessage(activeTeam, agentName, "team-lead", report.subject, report.text);
        } catch (_e) {
          // The lead or the team can be gone already. Closing still proceeds.
        }

        // removeAgent removes this member from the team config, deletes every
        // state file for this agent, closes the pane or window hosting this
        // process, and SIGKILLs this process. The result is never delivered;
        // the agent terminates mid-execute.
        await teams.removeAgent({
          team: activeTeam,
          agentName,
          ownPid: process.pid,
          terminal,
        });

        // Unreachable at runtime: removeAgent terminated this process, but the
        // tool contract requires a result to satisfy the type system.
        return {
          content: [
            { type: "text", text: `Agent ${agentName} closed itself.` },
          ],
          details: {},
        };
      },
    });
  }
}
