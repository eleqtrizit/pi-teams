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

function memberId(member: { name: string; registryId?: string }): string {
  if (!member.registryId) {
    throw new Error(`${member.name} has no agent id; it was spawned before the registry existed.`);
  }
  return member.registryId;
}

/** Build a message using sender and recipient agent IDs. */
function buildMessage(
  fromId: string,
  fromName: string,
  toId: string,
  subject: string,
  text: string,
  summary?: string,
): TeamMessage {
  return {
    id: randomUUID().slice(0, 8),
    from: fromId,
    to: toId,
    fromLabel: fromName,
    subject,
    text,
    timestamp: nowIso(),
    summary,
  };
}

/**
 * Send a message to one named team member, addressed by the member's agent ID.
 *
 * @param teamName - Team that contains the recipient
 * @param fromId - Sender agent ID
 * @param fromName - Sender display name
 * @param toName - Recipient member name
 * @param subject - Short subject line
 * @param text - Message body
 * @param summary - Optional brief summary
 * @throws Error when the team or recipient does not exist, or the recipient has no registry ID
 */
export async function sendPlainMessage(
  teamName: string,
  fromId: string,
  fromName: string,
  toName: string,
  subject: string,
  text: string,
  summary?: string,
): Promise<void> {
  const config = await readConfig(teamName);
  const recipient = config.members.find((member) => member.name === toName);
  if (!recipient) throw new Error(`Recipient "${toName}" is not a member of team "${teamName}".`);
  await sendToAgent(buildMessage(fromId, fromName, memberId(recipient), subject, text, summary));
}

/**
 * Send a message to every team member except the sender.
 *
 * @param teamName - Team whose members receive the message
 * @param fromId - Sender agent ID
 * @param fromName - Sender display name
 * @param subject - Short subject line
 * @param text - Message body
 * @param summary - Optional brief summary
 * @returns Names of delivered and failed recipients
 */
export async function broadcastMessage(
  teamName: string,
  fromId: string,
  fromName: string,
  subject: string,
  text: string,
  summary?: string,
): Promise<BroadcastResult> {
  const config = await readConfig(teamName);
  const recipients = config.members.filter((member) => member.name !== fromName);
  const outcomes = await Promise.allSettled(
    recipients.map(async (member) =>
      sendToAgent(buildMessage(fromId, fromName, memberId(member), subject, text, summary)),
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
