import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { withLock } from "./lock";
import { InboxMessage, TeamConfig } from "./models";
import {
  inboxPath,
  lastAwokenPath,
  lastMessagePath,
  lastReminderPath,
  lastReportPath,
} from "./paths";
import { readConfig } from "./teams";

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Get the timestamp of the last message sent by this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no message has been sent
 */
export function getLastMessageTime(
  teamName: string,
  agentName: string,
): number | null {
  const p = lastMessagePath(teamName, agentName);
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    const timestamp = parseInt(content, 10);
    return isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
}

/**
 * Update the last message sent timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastMessageTime(
  teamName: string,
  agentName: string,
): void {
  const p = lastMessagePath(teamName, agentName);
  fs.writeFileSync(p, Date.now().toString());
}

/**
 * Get the timestamp when the agent last went from inactive to active.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if the agent has never been active
 */
export function getLastAwokenTime(
  teamName: string,
  agentName: string,
): number | null {
  const p = lastAwokenPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    const timestamp = parseInt(content, 10);
    return isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
}

/**
 * Update the last awoken timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastAwokenTime(
  teamName: string,
  agentName: string,
): void {
  const p = lastAwokenPath(teamName, agentName);
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
  const p = lastReminderPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    const timestamp = parseInt(content, 10);
    return isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
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
  const p = lastReminderPath(teamName, agentName);
  fs.writeFileSync(p, Date.now().toString());
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
  const p = lastReportPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;
  try {
    const content = fs.readFileSync(p, "utf-8").trim();
    const timestamp = parseInt(content, 10);
    return isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
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
  const p = lastReportPath(teamName, agentName);
  fs.writeFileSync(p, Date.now().toString());
}

/** Minimum delay between repeated report reminders for the same instruction. */
const REMINDER_COOLDOWN_MS = 30 * 1000;

/**
 * Determine whether the agent needs a reminder to report back to the team-lead.
 *
 * With direct delivery, messages no longer wait in an inbox for the agent to
 * fetch them; the polling loop delivers each message as a user message the
 * moment it arrives. So the only signal we need is: the agent received a
 * team-lead instruction (delivered) but has not sent a report back to the
 * team-lead since.
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
  if (
    lastReminderTime !== null &&
    lastReminderTime >= latestInstructionTs &&
    Date.now() - lastReminderTime < REMINDER_COOLDOWN_MS
  )
    return false;

  // If instructions have not been delivered yet, let the polling loop deliver
  // them first; the delivery itself wakes the agent.
  if (hasUndeliveredInstructions) return false;

  return true;
}

export async function appendMessage(
  teamName: string,
  agentName: string,
  message: InboxMessage,
) {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await withLock(p, async () => {
    let msgs: InboxMessage[] = [];
    if (fs.existsSync(p)) {
      msgs = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
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
    const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));

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
    const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, "utf-8"));

    const toDeliver = allMsgs.filter((m) => !m.delivered);
    if (toDeliver.length === 0) return [];

    for (const m of allMsgs) {
      if (!m.delivered) m.delivered = true;
    }
    fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));

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
  const msg: InboxMessage = {
    // 8-char hex prefix of a v4 UUID — 32 bits of entropy. Collision
    // risk is accepted: ~1 in 42M per inbox; unambiguous in practice.
    id: uuidv4().slice(0, 8),
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
  // Track that the sender has sent a message
  updateLastMessageTime(teamName, fromName);
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
  updateLastMessageTime(teamName, fromName);

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
