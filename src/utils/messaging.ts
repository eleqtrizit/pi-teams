import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withLock } from "./lock";
import { InboxMessage, TeamConfig } from "./models";
import {
  inboxPath,
  lastReminderPath,
  lastReportPath,
} from "./paths";
import { readConfig } from "./teams";

/**
 * Delivered messages kept in an inbox after a drain. Old messages are pruned
 * so the per-second poller never reparses an unbounded file, but the newest
 * team-lead message is always retained because needsReminderMessage reads its
 * timestamp.
 */
const MAX_RETAINED_DELIVERED = 50;

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Read a millisecond timestamp written by one of the update*Time helpers.
 * @param p Absolute path of the timestamp file
 * @returns The timestamp in milliseconds, or null when the file is absent or unparseable
 */
function readTimestamp(p: string): number | null {
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    const timestamp = parseInt(content, 10);
    return Number.isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
}

/**
 * Stamp a file with the current wall-clock time in milliseconds.
 * @param p Absolute path of the timestamp file
 */
function writeNow(p: string): void {
  fs.writeFileSync(p, Date.now().toString());
}

/**
 * Get the timestamp of the last reminder sent to this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no reminder has been sent
 */
export function getLastReminderTime(
  teamName: string,
  agentName: string,
): number | null {
  return readTimestamp(lastReminderPath(teamName, agentName));
}

/**
 * Update the last reminder sent timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastReminderTime(
  teamName: string,
  agentName: string,
): void {
  writeNow(lastReminderPath(teamName, agentName));
}

/**
 * Get the timestamp of the last report sent by this agent to the team-lead.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no report has been sent
 */
export function getLastReportTime(
  teamName: string,
  agentName: string,
): number | null {
  return readTimestamp(lastReportPath(teamName, agentName));
}

/**
 * Update the last report timestamp for this agent (messages sent to team-lead only).
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastReportTime(
  teamName: string,
  agentName: string,
): void {
  writeNow(lastReportPath(teamName, agentName));
}

/**
 * Determine whether the agent needs a reminder to report back to the team-lead.
 *
 * With direct delivery, messages no longer wait in an inbox for the agent to
 * fetch them; the polling loop delivers each message as a user message the
 * moment it arrives. So the only signal we need is: the agent received a
 * team-lead instruction (delivered) but has not sent a report back to the
 * team-lead since.
 *
 * At most one reminder fires per instruction: once a reminder has been sent
 * after the latest team-lead message, no further reminders fire until a newer
 * instruction arrives.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param latestInstructionTs Epoch-ms timestamp of the most recent team-lead message, or null if none exist
 * @param hasUndeliveredInstructions True when any team-lead message has not yet been delivered
 * @returns true if a reminder message should be added
 */
export function needsReminderMessage(
  teamName: string,
  agentName: string,
  latestInstructionTs: number | null,
  hasUndeliveredInstructions: boolean,
): boolean {
  if (latestInstructionTs === null) return false;

  const lastReportTime = getLastReportTime(teamName, agentName);
  if (lastReportTime !== null && lastReportTime >= latestInstructionTs)
    return false;

  const lastReminderTime = getLastReminderTime(teamName, agentName);
  if (lastReminderTime !== null && lastReminderTime >= latestInstructionTs)
    return false;

  // If instructions have not been delivered yet, let the polling loop deliver
  // them first; the delivery itself wakes the agent.
  if (hasUndeliveredInstructions) return false;

  return true;
}

/**
 * Parse an inbox file, quarantining it when it is not valid JSON.
 *
 * A corrupt file would otherwise throw on every poll tick forever. The file is
 * renamed to `<inbox>.corrupt-<timestamp>` for inspection and the inbox
 * restarts empty. Must run under the inbox lock.
 *
 * @param p Absolute path of the inbox file
 * @returns The parsed messages, or an empty list after quarantine
 */
function parseInboxFile(p: string): InboxMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to quarantine
  }
  try {
    fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
  } catch {
    // ignore: the file may already be gone
  }
  return [];
}

export const REPORT_REMINDER_TEXT =
  "Report back to the team-lead with your results, if you haven't already done so.";

/**
 * Compute, stamp, and return a pending reminder for an agent.
 *
 * Encapsulates the reminder rule used by both the polling loop and the
 * turn_end handler: read the inbox, find the newest team-lead instruction,
 * and ask needsReminderMessage whether a reminder is due. When it is, the
 * last-reminder timestamp is stamped here so callers cannot forget it.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns REMINDER text when a reminder is due, otherwise null
 */
export async function pendingReminder(
  teamName: string,
  agentName: string,
): Promise<string | null> {
  const allMsgs = await readInbox(teamName, agentName, false);
  const teamLeadMsgs = allMsgs.filter((m) => m.from === "team-lead");
  if (teamLeadMsgs.length === 0) return null;

  const latestInstructionTs = Math.max(...teamLeadMsgs.map((m) => new Date(m.timestamp).getTime()));
  const hasUndelivered = teamLeadMsgs.some((m) => !m.delivered);
  if (!needsReminderMessage(teamName, agentName, latestInstructionTs, hasUndelivered)) {
    return null;
  }
  updateLastReminderTime(teamName, agentName);
  return REPORT_REMINDER_TEXT;
}

export async function appendMessage(
  teamName: string,
  agentName: string,
  message: InboxMessage,
) {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  // Non-recursive: a missing team directory is an error, not something to
  // create silently. Caller (sendPlainMessage) validates the team first.
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  await withLock(p, async () => {
    const msgs: InboxMessage[] = fs.existsSync(p) ? parseInboxFile(p) : [];
    msgs.push(message);
    fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
  });
}

/**
 * Read messages from an agent's inbox without modifying state.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param undeliveredOnly When true, only return messages not yet delivered to the agent
 * @returns A list of inbox messages (shallow copies, delivered state preserved)
 */
export async function readInbox(
  teamName: string,
  agentName: string,
  undeliveredOnly = true,
): Promise<InboxMessage[]> {
  const p = inboxPath(teamName, agentName);

  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const allMsgs: InboxMessage[] = parseInboxFile(p);

    const toReturn = undeliveredOnly
      ? allMsgs.filter((m) => !m.delivered)
      : allMsgs;
    return toReturn.map((m) => ({ ...m }));
  });
}

/**
 * Atomically drain and mark all undelivered messages as delivered.
 *
 * The polling loop calls this to fetch messages it is about to deliver to the
 * recipient agent as user messages. Marking happens under the same lock as the
 * read so a concurrent ``appendMessage`` cannot interleave.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The messages that were drained (now marked delivered), in inbox order
 */
export async function drainUndelivered(
  teamName: string,
  agentName: string,
): Promise<InboxMessage[]> {
  const p = inboxPath(teamName, agentName);

  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const allMsgs: InboxMessage[] = parseInboxFile(p);

    const toDeliver = allMsgs.filter((m) => !m.delivered);
    if (toDeliver.length === 0) return [];

    for (const m of allMsgs) {
      if (!m.delivered) m.delivered = true;
    }

    // Prune old delivered messages (see MAX_RETAINED_DELIVERED). Undelivered
    // messages are never dropped. The newest team-lead message survives as
    // the anchor for needsReminderMessage, which reads its timestamp.
    const withTs = (m: InboxMessage) => new Date(m.timestamp).getTime();
    const teamLeadMsgs = allMsgs.filter((m) => m.from === "team-lead");
    const newestTeamLead =
      teamLeadMsgs.length > 0
        ? teamLeadMsgs.reduce((a, b) => (withTs(b) > withTs(a) ? b : a))
        : null;
    const keptDelivered = allMsgs.filter((m) => m.delivered).slice(-MAX_RETAINED_DELIVERED);
    if (newestTeamLead && newestTeamLead.delivered && !keptDelivered.includes(newestTeamLead)) {
      keptDelivered.unshift(newestTeamLead);
    }
    const pruned = [...keptDelivered, ...allMsgs.filter((m) => !m.delivered)];
    fs.writeFileSync(p, JSON.stringify(pruned, null, 2));

    return toDeliver.map((m) => ({ ...m }));
  });
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  subject: string,
  text: string,
  summary?: string,
  color?: string,
) {
  // Validate the recipient before writing: a typo would otherwise create a
  // ghost inbox file that no agent polls, and the send would report success.
  const config = await readConfig(teamName);
  if (!config.members.some((m) => m.name === toName)) {
    throw new Error(`Recipient "${toName}" is not a member of team "${teamName}".`);
  }
  const msg: InboxMessage = {
    // 8-char hex prefix of a v4 UUID — 32 bits of entropy. Collision
    // risk is accepted: ~1 in 42M per inbox; unambiguous in practice.
    id: randomUUID().slice(0, 8),
    from: fromName,
    to: toName,
    subject,
    text,
    timestamp: nowIso(),
    delivered: false,
    summary,
    color,
  };
  await appendMessage(teamName, toName, msg);
  // Track reports to the team-lead separately (used by reminder logic)
  if (toName === "team-lead") {
    updateLastReportTime(teamName, fromName);
  }
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */

export async function broadcastMessage(
  teamName: string,
  fromName: string,
  subject: string,
  text: string,
  summary?: string,
  color?: string,
) {
  let config: TeamConfig;
  try {
    config = await readConfig(teamName);
  } catch {
    // Team not found — silently skip broadcast
    return;
  }
  // Create an array of delivery promises for all members except the sender
  const deliveryPromises = config.members
    .filter((member) => member.name !== fromName)
    .map((member) =>
      sendPlainMessage(
        teamName,
        fromName,
        member.name,
        subject,
        text,
        summary,
        color,
      ),
    );

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length > 0) {
    console.error(
      `Broadcast partially failed: ${failures.length} messages could not be delivered.`,
    );
    // Optionally log individual errors
    failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
  }
}
