import { randomUUID } from "node:crypto";
import { TeamMessage } from "./models";
import { readConfig } from "./teams";
import { sendToAgent } from "./transport";

/** Recipient name that addresses every team member except the sender. */
export const BROADCAST_RECIPIENT = "all";

/** Outcome of a broadcast: which members got the message and which did not. */
export interface BroadcastResult {
  /** Names of the members that received the message. */
  delivered: string[];
  /** Members that could not be reached, with the reason for each. */
  failed: { name: string; reason: string }[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a message with a fresh identifier and the current time.
 *
 * @param fromName - Name of the sender
 * @param toName - Name of the recipient
 * @param subject - Short subject line
 * @param text - Full message body
 * @param summary - Optional brief summary
 * @returns The message, ready to send
 */
function buildMessage(
  fromName: string,
  toName: string,
  subject: string,
  text: string,
  summary?: string,
): TeamMessage {
  return {
    // 8-char hex prefix of a v4 UUID: 32 bits of entropy, unambiguous in practice.
    id: randomUUID().slice(0, 8),
    from: fromName,
    to: toName,
    subject,
    text,
    timestamp: nowIso(),
    summary,
  };
}

/**
 * Send a message to one team member and wait until the member accepted it.
 *
 * @param teamName - Name of the team
 * @param fromName - Name of the sender
 * @param toName - Name of the recipient, who must be a member of the team
 * @param subject - Short subject line
 * @param text - Full message body
 * @param summary - Optional brief summary
 * @throws Error when the team does not exist or the recipient is not a member
 * @throws RecipientUnreachableError when the recipient is not running
 */
export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  subject: string,
  text: string,
  summary?: string,
): Promise<void> {
  // Validate the recipient first: a typo should produce a clear error, not a
  // connection failure.
  const config = await readConfig(teamName);
  if (!config.members.some((m) => m.name === toName)) {
    throw new Error(`Recipient "${toName}" is not a member of team "${teamName}".`);
  }
  await sendToAgent(teamName, buildMessage(fromName, toName, subject, text, summary));
}

/**
 * Send a message to every team member except the sender.
 *
 * Members that cannot be reached do not stop the broadcast. The result lists
 * them so the caller can tell the sender.
 *
 * @param teamName - Name of the team
 * @param fromName - Name of the sender
 * @param subject - Short subject line
 * @param text - Full message body
 * @param summary - Optional brief summary
 * @returns The members that received the message and the members that did not
 * @throws Error when the team does not exist
 */
export async function broadcastMessage(
  teamName: string,
  fromName: string,
  subject: string,
  text: string,
  summary?: string,
): Promise<BroadcastResult> {
  const config = await readConfig(teamName);
  const recipients = config.members.filter((member) => member.name !== fromName);
  const outcomes = await Promise.allSettled(
    recipients.map((member) =>
      sendToAgent(teamName, buildMessage(fromName, member.name, subject, text, summary)),
    ),
  );

  const result: BroadcastResult = { delivered: [], failed: [] };
  outcomes.forEach((outcome, index) => {
    const name = recipients[index].name;
    if (outcome.status === "fulfilled") {
      result.delivered.push(name);
      return;
    }
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    result.failed.push({ name, reason });
  });
  return result;
}
