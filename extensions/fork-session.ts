/**
 * Fork the lead's session into a session file for a new worker, so the worker
 * starts with everything the lead has already read and worked out.
 *
 * The fork is a copy made with pi's own SessionManager. Three things are
 * appended so the copy is a valid, idle conversation that knows its new role:
 * results for the lead's in-flight tool calls (the spawn call itself has no
 * result yet), a user notice, and an assistant acknowledgement.
 */
import * as fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Result text given to tool calls the lead had in flight at fork time. */
export const FORK_PENDING_TOOL_RESULT =
  "[pi-teams] This call was made by the team lead and was still running when " +
  "this session was forked. Its result is not part of your context.";

export interface ForkIdentity {
  workerName: string;
  leadId: string;
  readonlyWorker: boolean;
}

/** The user turn that tells a forked worker it is no longer the lead. */
export function buildForkNotice(identity: ForkIdentity): string {
  const role = identity.readonlyWorker ? "read-only worker" : "teammate";
  return (
    `[pi-teams] This session was forked from the team lead's context. ` +
    `Everything above is the lead's history, shared so you do not have to rediscover it.\n\n` +
    `From here on you are NOT the team lead. You are ${role} '${identity.workerName}', ` +
    `a worker of that lead (agent id ${identity.leadId}). ` +
    `The lead's tasks, plans, and owed replies above are the lead's, not yours: ` +
    `do not continue them, and do not spawn, message, or close agents on its behalf. ` +
    `Your tools may differ from the ones used above. ` +
    `Files may have changed since the fork, so re-read a file before you rely on or edit it.\n\n` +
    `Your task arrives as a message from the lead. Do nothing until it does. ` +
    `Reply YES if you understand.`
  );
}

/** The assistant turn that closes the notice, leaving the worker idle. */
export function buildForkAck(identity: ForkIdentity): string {
  const role = identity.readonlyWorker ? "read-only worker" : "teammate";
  return `YES. I am ${role} '${identity.workerName}', forked from the team lead. I will wait for my task from the lead.`;
}

/**
 * Share of the worker model's context window one fork may fill, given how many
 * forked workers the lead will have: a half for one or two, then 1/count.
 */
export function forkContextFraction(forkCount: number): number {
  return 1 / Math.max(2, forkCount);
}

/**
 * Refuse a fork whose cost is too high: it would leave the worker too little
 * room, or the lead already carries too many forked workers for its context size.
 * Unknown sizes pass: pi reports no token count right after a compaction.
 *
 * @param leadTokens - The lead's current context tokens, if known
 * @param workerWindow - The worker model's context window, if known
 * @param forkCount - The lead's forked workers counting this one (live, plus spawns in progress)
 * @throws If the lead's context exceeds the allowed share of the worker's window
 */
export function assertForkFits(
  leadTokens: number | null | undefined,
  workerWindow: number | undefined,
  forkCount = 1,
): void {
  if (!leadTokens || !workerWindow) return;
  const fraction = forkContextFraction(forkCount);
  if (leadTokens <= workerWindow * fraction) return;
  const percent = Math.round((leadTokens / workerWindow) * 100);
  const limit = Math.round(fraction * 100);
  const others =
    forkCount > 1
      ? ` You already have ${forkCount - 1} forked worker(s), and the limit shrinks to 1/N of the window for N forked workers.`
      : "";
  throw new Error(
    `fork_context refused: your context is ${leadTokens} tokens, ${percent}% of this ` +
      `worker model's ${workerWindow}-token window; the limit for forked worker ` +
      `number ${forkCount} is ${limit}%.${others} This worker was not spawned. ` +
      `Spawn it without fork_context and put what it needs in its task, or pick ` +
      `a model with a larger context window.`,
  );
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Copy the lead's session into a new session file for a worker.
 *
 * @param leadSessionFile - The lead's session file, or undefined when the lead does not persist one
 * @param workerCwd - The worker's working directory; the fork is stored under its session directory
 * @param identity - Who the worker is, for the notice
 * @param sessionDir - Session directory override (tests); defaults to pi's directory for workerCwd
 * @returns Path of the new session file, to open with `pi --session`
 * @throws If the lead has no saved session or no assistant turn to fork from
 */
export function forkLeadSession(
  leadSessionFile: string | undefined,
  workerCwd: string,
  identity: ForkIdentity,
  sessionDir?: string,
): string {
  if (!leadSessionFile || !fs.existsSync(leadSessionFile)) {
    throw new Error(
      "fork_context needs a saved session, and this session has none " +
        "(pi runs with --no-session). Spawn without fork_context.",
    );
  }
  const fork = SessionManager.forkFrom(leadSessionFile, workerCwd, sessionDir);
  const forkFile = fork.getSessionFile();
  try {
    const lastAssistant = fork
      .getBranch()
      .map((entry, index) => ({ entry, index }))
      .reverse()
      .find(({ entry }) => entry.type === "message" && entry.message.role === "assistant");
    if (!lastAssistant || lastAssistant.entry.type !== "message" || lastAssistant.entry.message.role !== "assistant") {
      throw new Error("fork_context found no assistant turn to fork from.");
    }
    const assistant = lastAssistant.entry.message;

    // The lead is mid-turn: its last assistant message holds the spawn call
    // (and any parallel calls) without results. Providers reject a tool call
    // with no result, so close each one.
    const answered = new Set<string>();
    for (const entry of fork.getBranch().slice(lastAssistant.index + 1)) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        answered.add(entry.message.toolCallId);
      }
    }
    for (const block of assistant.content) {
      if (block.type !== "toolCall" || answered.has(block.id)) continue;
      fork.appendMessage({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: FORK_PENDING_TOOL_RESULT }],
        isError: false,
        timestamp: Date.now(),
      });
    }

    fork.appendMessage({ role: "user", content: buildForkNotice(identity), timestamp: Date.now() });
    fork.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: buildForkAck(identity) }],
      api: assistant.api,
      provider: assistant.provider,
      model: assistant.model,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  } catch (e) {
    if (forkFile) fs.rmSync(forkFile, { force: true });
    throw e;
  }
  if (!forkFile) throw new Error("fork_context could not create a session file.");
  return forkFile;
}
