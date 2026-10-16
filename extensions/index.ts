import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { registerFsTools } from "./fs-tools";
import * as messaging from "../src/utils/messaging";
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
  buildWorkerCommand,
  spawnWorkerProcess,
  seedWorkerStateFiles,
  resolveSpawnModel,
  resolveSpawnDirectory,
} from "../src/utils/spawn";
import {
  registerLeadTools,
  runFlavorMigration,
  type SpawnWorkerGoals,
  type SpawnedWorker,
} from "./lead-tools";
export { classifyModel, executeGetModels } from "./lead-tools";



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
/**
 * Describe the members a broadcast could not reach.
 *
 * @param failed - The failed deliveries with their reasons
 * @returns A one-line summary naming each member
 */
function formatBroadcastFailures(failed: { name: string; reason: string }[]): string {
  return failed.map((f) => `${f.name} (${f.reason})`).join("; ");
}

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
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

    const { piCmd, agentType } = buildWorkerCommand(goals, model);
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
    registerLeadTools(pi, {
      spawnTeamWorker,
      terminal: terminal ?? undefined,
      ensureListener,
      getTeamName: () => teamName,
      setTeamName: (nextTeamName) => {
        teamName = nextTeamName;
      },
      getPendingMigrationNotice: () => pendingMigrationNotice,
      setPendingMigrationNotice: (notice) => {
        pendingMigrationNotice = notice;
      },
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
