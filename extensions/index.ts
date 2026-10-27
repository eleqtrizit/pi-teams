import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import * as messaging from "../src/utils/messaging";
import * as holdRun from "../src/utils/hold";
import {
  buildInterruptedNotice,
  buildNoReplyNotice,
  buildReminderText,
  ObligationTracker,
  obligationsToRemind,
  REMINDER_CUSTOM_TYPE,
} from "../src/utils/obligations";
import { removeRunState, writeRunState } from "../src/utils/runstate";
import { TeamMessage } from "../src/utils/models";
import * as paths from "../src/utils/paths";
import {
  type MessageListener,
  startListener,
  waitForListener,
} from "../src/utils/transport";
import {
  buildWorkerCommand,
  spawnWorkerProcess,
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
import { registerCloseMyself, registerSharedTools } from "./shared-tools";
import { registerAgentTools } from "./agents-tools";
import {
  generateAgentId,
  ensureRegistryDir,
  writeAgentRecord,
  readAgentRecords,
  updateAgentRecord,
  adoptOrphanedWorkers,
} from "../src/utils/registry";
import { isPidAlive } from "../src/utils/pid";
import { assertAgentId } from "../src/utils/paths";
import { AgentKind, type AgentRecord } from "../src/utils/models";

/**
 * Format delivered team messages as one user message.
 *
 * @param messages - Messages to format
 * @param selfId - The receiving agent's id; a matching `to` renders as "You (<id>)"
 * @returns Formatted text, or "" for no messages
 */
export function formatDeliveredMessages(
  messages: TeamMessage[],
  selfId: string,
): string {
  if (messages.length === 0) return "";

  const formatOne = (m: TeamMessage): string => {
    const ts = new Date(m.timestamp)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    return [
      `**From:** ${m.fromLabel} (${m.from})`,
      `**To:** ${m.to === selfId ? `You (${m.to})` : m.to}`,
      `Reply with send_message(recipient="${m.from}").`,
      m.expectReply === true
        ? `Reply expected: yes. Answer with send_message(recipient="${m.from}").`
        : `Reply expected: no.`,
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

/**
 * Peer-lead collaboration guidance appended to every lead's system prompt.
 *
 * @param self - Identity for the first line: this agent's id and working directory.
 * @returns The guidance block describing peer leads and how to reach them.
 */
export function buildPeerLeadPrompt(self: { id: string; cwd: string }): string {
  return [
    `You are Pi Agent in ${self.cwd} (id ${self.id}).`,
    "Other Pi agents (peer leads) can run in other directories. Run list_agents to see them with their ids and status. Statuses mean: Idling = alive and settled, no run in progress; Busy = mid-run, it may be doing work or waiting on its own workers; Offline = not running, its socket accepts nothing.",
    'When work belongs to another directory, or you need help: if no agent there is Idling, call spawn_team_lead(folder="<dir>"); then send_message(recipient="<id>", ...).',
    "Set expectReply=true on send_message when you assign a task or ask a question; set it to false for replies, reports, and acknowledgments. A message showing 'Reply expected: yes' must be answered with send_message.",
    "Replies arrive automatically as user messages. Never poll, sleep, or wait in a loop.",
    "You can message peer leads and your own workers only. Other leads' workers are not visible to you.",
    "Agent ids are ephemeral: they change every session. Use them only for send_message; never record them in documents, notes, tasks, or comments. Identify agents by name and working directory instead.",
    "When the user asks to list agents, run list_agents and list all agents, including offline ones; pass onlineOnly only if the user explicitly asks for online agents.",
    "When the user asks to plan work as tasks, use the make-tasks skill. When tasks exist and need implementation by a team, use the implement-tasks skill.",
  ].join("\n");
}

/** Delay before a follow-up that failed to queue is flushed again while no run is active. */
const FOLLOW_UP_RETRY_MS = 2000;

/** Longest time a spawn tool waits for a new worker to start listening. */
const WORKER_LISTEN_TIMEOUT_MS = 30_000;

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
  const idWasPreassigned = !!process.env.PI_AGENT_ID;
  const agentId = process.env.PI_AGENT_ID
    ? (assertAgentId(process.env.PI_AGENT_ID), process.env.PI_AGENT_ID)
    : generateAgentId();
  process.env.PI_AGENT_ID = agentId;

  const agentType = process.env.PI_AGENT_TYPE || "lead";
  const agentName = process.env.PI_AGENT_NAME || "";

  function parseAgentKind(type: string): AgentKind {
    switch (type) {
      case "teammate":
        return AgentKind.Teammate;
      case "readonly-worker":
        return AgentKind.ReadonlyWorker;
      default:
        return AgentKind.Lead;
    }
  }
  const agentKind = parseAgentKind(agentType);
  const isWorker = agentType === "teammate" || agentType === "readonly-worker";
  const isLead = !isWorker;
  const leadId = isWorker ? process.env.PI_LEAD_ID : undefined;
  const workerName = isWorker ? agentName : undefined;

  // ── Spawn plumbing ────────────────────────────────────────────────────
  // Workers belong to this lead through registry records. Spawn setup does
  // not depend on a team config or per-team state files.

  async function spawnTeamWorker(
    ctx: ExtensionContext,
    goals: SpawnWorkerGoals,
  ): Promise<SpawnedWorker> {
    const safeName = paths.sanitizeName(goals.name);
    if (!terminal) {
      throw new Error("No terminal adapter detected.");
    }
    const cwd = resolveSpawnDirectory(goals.cwd);
    const model = resolveSpawnModel(ctx, goals.modelRequest);
    const useSeparateWindow =
      !goals.readonlyWorker && (goals.separateWindow ?? false);
    if (useSeparateWindow && !terminal.supportsWindows()) {
      throw new Error(
        `Separate windows mode is not supported in ${terminal.name}.`,
      );
    }

    const { piCmd, agentType } = buildWorkerCommand(goals, model);
    const ownWorkers = readAgentRecords().filter(
      (record) => record.leadId === agentId,
    );
    if (ownWorkers.some((record) => record.name === safeName)) {
      throw new Error(
        `A worker named "${safeName}" already exists under this lead.`,
      );
    }
    const workerId = generateAgentId();
    const env = { ...process.env } as Record<string, string | undefined>;
    env.PI_AGENT_NAME = safeName;
    env.PI_AGENT_TYPE = agentType;
    env.PI_AGENT_ID = workerId;
    env.PI_LEAD_ID = agentId;

    let terminalId: string;
    try {
      terminalId = spawnWorkerProcess(terminal, {
        name: safeName,
        cwd,
        piCmd,
        env: Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        agents: ownWorkers,
        useSeparateWindow,
        readonlyWorker: goals.readonlyWorker,
      });
    } catch (e) {
      throw new Error(
        `Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`,
      );
    }

    const listening = await waitForListener(workerId, WORKER_LISTEN_TIMEOUT_MS);
    // shortcut: a worker that boots after the wait keeps no terminal ids, so close_worker
    // kills its pid but leaves the pane open; pass the ids via env if that matters.
    if (listening) {
      updateAgentRecord(
        workerId,
        useSeparateWindow ? { windowId: terminalId } : { paneId: terminalId },
      );
    }

    return {
      agentId: workerId,
      terminalId,
      isWindow: useSeparateWindow,
      model,
      listening,
    };
  }

  const terminal = getTerminalAdapter();
  /** Socket listener that receives messages for this agent. */
  let messageListener: MessageListener | null = null;
  /** Timer that retries a follow-up that could not be queued. */
  let followUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let titleRefreshTimeouts: ReturnType<typeof setTimeout>[] = [];
  let isAgentRunning = false;
  /** Replies this agent owes to senders that requested one with `expectReply`. */
  const obligations = new ObligationTracker();
  /** Migration warning shown to the model on its next get_flavored_models call */
  let pendingMigrationNotice: string | undefined;
  // Captured from the first context that carries a model registry, so the
  // Increments once a follow-up message has actually reached the agent's
  // followUp queue. The agent_end hold loop watches this counter to decide
  // when the run should continue with queued worker results.
  let followUpEpoch = 0;
  const pendingInboxNotifications = new FollowUpMessageQueue();
  /** Registry record for this agent, set at session_start. */
  let selfRecord: AgentRecord | null = null;

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
    if (!selfRecord) {
      throw new Error("This session is not registered in the agent registry.");
    }
    const sender = messaging.authorizeSender(message, agentId);
    if (message.expectReply === true) {
      obligations.record(sender.id, message.fromLabel, message.subject);
    }
    deliverPendingMessage(formatDeliveredMessages([message], agentId));
  }

  /** Start the current agent-ID listener once, independently of team membership. */
  async function ensureListener(): Promise<void> {
    if (messageListener) return;
    messageListener = await startListener(agentId, receiveTeamMessage);
  }

  async function closeListener(): Promise<void> {
    const current = messageListener;
    messageListener = null;
    await current?.close();
  }

  // Block "sleep N" bash commands for agents that participate in a team.
  // Waiting agents must end their turn; an incoming message wakes them
  // automatically. Sleeping wastes wall time and
  // tokens and delays responses to the team-lead.
  const SLEEP_COMMAND_PATTERN = /^sleep\s+\d+/;
  pi.on("tool_call", async (event) => {
    // Block sleep for workers and for leads that have active workers.
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
    if (!isWorker) {
      const hasOwnWorkers = readAgentRecords().some(
        (r) => r.kind !== AgentKind.Lead && r.leadId === agentId,
      );
      if (!hasOwnWorkers) return;
    }
    return {
      block: true,
      reason:
        "Blocked: do not run sleep commands to wait for incoming messages. Stop sleeping and simply end your turn. Messages are delivered to you automatically; the system will notify you as soon as a new one arrives. Just say you are waiting and stop.",
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    isAgentRunning = false;
    // Workers and leads run in different cwds, but all of them share the
    // per-user registry (agent records and Unix sockets) under
    // ~/.pi/agent/pi-teams/. Ask pi-sandbox to allow that path for this
    // session. Must fire from session_start so pi-sandbox is already
    // subscribed; the event bus rejects a relative path with a UI warning.
    pi.events?.emit("pi-sandbox:allow-path", { path: paths.registryDir() });
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
    const shouldSkipRegistration = isLead && !ctx.hasUI && !idWasPreassigned;
    if (!shouldSkipRegistration) {
      selfRecord = {
        id: agentId,
        kind: agentKind,
        cwd: process.cwd(),
        pid: process.pid,
        ...(leadId ? { leadId } : {}),
        ...(workerName ? { name: workerName } : {}),
        ...(ctx.model
          ? { model: `${ctx.model.provider}/${ctx.model.id}` }
          : {}),
        startedAt: Date.now(),
      };
      try {
        ensureRegistryDir();
        writeAgentRecord(selfRecord);
        if (isLead) {
          const adopted = adoptOrphanedWorkers(selfRecord);
          if (adopted.length > 0 && ctx.hasUI) {
            ctx.ui.notify(
              `pi-teams: adopted orphaned workers: ${adopted.join(", ")}`,
              "info",
            );
          }
        }
      } catch (e) {
        ctx.ui.notify(`pi-teams: cannot register agent: ${e}`, "error");
      }
    }

    if (isWorker) {
      const fullTitle = `${agentName} (${agentId})`;
      setSessionTitle(ctx, fullTitle);
      ctx.ui.setStatus("00-pi-teams", `[${agentName.toUpperCase()}]`);
      scheduleTerminalTitleRefreshes(fullTitle);
    } else {
      const title = `${basename(ctx.cwd)}: ${agentId}`;
      setSessionTitle(ctx, title);
      ctx.ui.setStatus("pi-teams", title);
    }
    try {
      await ensureListener();
    } catch (e) {
      ctx.ui.notify(`pi-teams: cannot receive messages: ${e}`, "error");
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (isWorker) {
      const fullTitle = `${agentName} (${agentId})`;
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
   * Capture what the hold loop needs to know about this lead's workers.
   * A registry read error returns null so a transient failure never releases
   * the run by mistake.
   *
   * @returns Liveness snapshot, or null when the registry cannot be read
   */
  function teamLivenessSnapshot(): holdRun.TeamLivenessSnapshot | null {
    try {
      const workers = readAgentRecords().filter(
        (r) => r.kind !== AgentKind.Lead && r.leadId === agentId,
      );
      return {
        workerCount: workers.length,
        liveWorkerCount: holdRun.countLiveWorkers(workers, isPidAlive),
      };
    } catch (_err) {
      return null;
    }
  }

  /**
   * Hold the agent run open while this lead's workers are active so the host
   * process does not exit before workers report back.
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
    const ownWorkers = readAgentRecords().filter(
      (r) => r.kind !== AgentKind.Lead && r.leadId === agentId,
    );
    if (
      !holdRun.shouldHoldWhileTeamActive({
        hasUI: ctx.hasUI,
        isWorker,
        ownWorkerCount: ownWorkers.length,
      })
    ) {
      return;
    }

    let livenessFailures = 0;
    for (let poll = 0; ; poll++) {
      if (followUpEpoch !== epochAtEntry) return;
      if (poll % holdRun.RUN_HOLD_LIVENESS_POLL_EVERY === 0) {
        const snapshot = teamLivenessSnapshot();
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
    // Publish busy for the whole settle cycle: agent_settled clears it, so
    // parked run-hold time and queued follow-up runs still report Busy.
    if (selfRecord) writeRunState(selfRecord.id, true);
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
    // Intentionally empty: terminal title refresh happens in turn_start.
  });

  // Remind the agent about owed replies inside the same run: the boundary
  // drafts are persisted in order and `continue: true` guarantees one more
  // provider request, so the model sees the reminder as a user entry on the
  // continuation instead of waiting for the next external message.
  pi.on(
    "agent_before_settle",
    async (
      event: AgentBeforeSettleEvent,
    ): Promise<BoundaryResult | undefined> => {
      const owed = obligationsToRemind(
        { outcome: event.outcome, canContinue: event.context.canContinue },
        obligations,
      );
      if (owed.length === 0) return;
      obligations.noteReminded(owed.map((obligation) => obligation.senderId));
      const reminder: CustomMessageEntryDraft = {
        type: "custom_message",
        customType: REMINDER_CUSTOM_TYPE,
        content: buildReminderText(owed),
        display: true,
      };
      return { entries: [...event.entries, reminder], continue: true };
    },
  );

  // agent_settled means Pi will not continue on its own. Workers report to
  // their lead; leads reply to peer leads that contacted them during the cycle.
  // Settled is the ultimate done signal, so busy clears here, not at agent_end:
  // parked run-hold time and queued follow-up runs keep the agent Busy.
  pi.on("agent_settled", async () => {
    if (selfRecord) writeRunState(selfRecord.id, false);
  });

  pi.on("agent_settled", async (event) => {
    if (!selfRecord) return;
    const selfLabel = messaging.agentLabel(selfRecord);
    const notices = event.aborted
      ? obligations
          .pending()
          .map((obligation) => buildInterruptedNotice(selfLabel, obligation))
      : obligations
          .takeExpired()
          .map((obligation) => buildNoReplyNotice(selfLabel, obligation));
    for (const notice of notices) {
      try {
        await messaging.sendAgentMessage(
          selfRecord,
          notice.recipientId,
          notice.subject,
          notice.text,
          false,
        );
      } catch (_e) {
        // The recipient can stop listening before the notice is sent.
      }
    }
  });

  pi.on("session_shutdown", async () => {
    clearFollowUpRetryTimer();
    await closeListener();
    clearTitleRefreshTimeouts();
    isAgentRunning = false;
    pendingInboxNotifications.clear();
    obligations.takeAll();
    if (selfRecord) removeRunState(selfRecord.id);
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    // Every lead turn gets the peer-lead collaboration guidance. A lead in
    // an auto-exit host mode also gets the run-hold note: the extension
    // holds the run open while the team is active, so the lead ends its
    // turn instead of polling and releases the session when done.
    if (isLead) {
      let systemPrompt = event.systemPrompt;
      if (holdRun.shouldGuideLead({ hasUI: ctx.hasUI, isWorker })) {
        systemPrompt += `\n\nNon-interactive session: when a team is active, the session stays alive after you end a turn. Worker messages arrive automatically as user messages; never poll, sleep, or run wait commands because they are blocked while a team is online. Respond with your plan or status and end your turn when workers are running. When every teammate has reported back and the work is complete, call close_all_workers; the workers close and the session exits normally.`;
      }
      systemPrompt += `\n\n${buildPeerLeadPrompt(
        selfRecord ?? { id: agentId, cwd: process.cwd() },
      )}`;
      return { systemPrompt };
    }

    if (isWorker && firstTurn) {
      firstTurn = false;

      let modelInfo = "";
      if (selfRecord?.model) {
        modelInfo = `\nYou are currently using model: ${selfRecord.model}. When reporting your model or thinking level, use these exact values.`;
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
          `\n\nYou are ${roleDescription} '${agentName}'.${modelInfo}${capabilitiesNote}\nYour lead's agent id is ${leadId}. Reply with send_message(recipient="lead"). Agent ids are ephemeral; use them only for send_message, never in documents or notes.\nMessages from teammates are delivered to you automatically as user messages; you do not need to fetch them. Your final reply is NOT sent anywhere. When your work is done, report it to your lead with send_message(recipient="lead", expectReply=false), then end your turn and stop. If a message shows 'Reply expected: yes', answer that sender with send_message; you are reminded until you do. Set expectReply=true only when you need an answer, such as a question mid-task. You will be woken automatically when the next message arrives.\n\nHARD RULES (violating these wastes tokens and breaks the team):\n- NEVER run sleep, polling, or wait commands (e.g. 'sleep 30', 'while true; do ...; done').\n- NEVER loop or poll to wait for messages. They arrive on their own.\n- When your work is done, report it with send_message and then stop. Do not announce that you are 'sleeping' or 'waiting' with a command. Just end your turn.`,
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
      getPendingMigrationNotice: () => pendingMigrationNotice,
      setPendingMigrationNotice: (notice) => {
        pendingMigrationNotice = notice;
      },
    });
  }
  // ── Shared and worker tools ───────────────────────────────────────────────
  const sharedToolDeps = {
    agentName,
    agentId,
    isWorker,
    get messageListener() {
      return messageListener;
    },
    onMessageSent: (recipientId: string) => {
      obligations.clear(recipientId);
    },
    onRecipientUnreachable: (recipientId: string) => {
      obligations.clear(recipientId);
    },
    obligations,
    terminal,
    get selfRecord() {
      return selfRecord;
    },
  };
  registerAgentTools(pi, { getSelfRecord: () => selfRecord, isLead, terminal });
  registerSharedTools(pi, sharedToolDeps);
  // Workers always get close_myself. Among leads, only spawned leads
  // (spawn_team_lead, detected by a preassigned PI_AGENT_ID) get it; the
  // interactive top-level lead session must not be able to kill itself from
  // a single tool call.
  if (isWorker || (isLead && idWasPreassigned)) {
    registerCloseMyself(pi, sharedToolDeps);
  }
}
