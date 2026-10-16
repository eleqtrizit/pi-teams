import { randomUUID } from "node:crypto";
import { AgentKind, AgentRecord, TeamMessage } from "./models";
import { readConfig } from "./teams";
import { AGENT_ID_PATTERN } from "./paths";
import { readAgentRecords } from "./registry";
import { RecipientUnreachableError, sendToAgent } from "./transport";
import { broadcastTargets, canMessage } from "./visibility";

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

/** Alias that addresses the sender's own lead; valid for worker senders only. */
export const LEAD_ALIAS = "lead";

/**
 * Human-readable sender label for message headers.
 *
 * Leads render as `Pi Agent in <cwd>`; workers render as
 * `Worker <name ?? id> in <cwd>`, matching the {@link formatAgentLine} shapes.
 *
 * @param rec - The sending agent's registry record.
 * @returns The label used as the message `fromLabel`.
 */
export function agentLabel(rec: AgentRecord): string {
  const who = rec.kind === AgentKind.Lead ? "Pi Agent" : `Worker ${rec.name ?? rec.id}`;
  return `${who} in ${rec.cwd}`;
}

/** Outcome of a registry-based broadcast: recipient records, not names. */
export interface AgentBroadcastResult {
  /** Recipients that acknowledged the message. */
  delivered: AgentRecord[];
  /** Recipients that could not be reached, with the reason for each. */
  failed: { record: AgentRecord; reason: string }[];
}

function errorUnknown(recipient: string): Error {
  return new Error(
    `Unknown recipient "${recipient}". Run list_agents to see the agents you can message.`,
  );
}

function errorAmbiguous(recipient: string, ids: string[]): Error {
  return new Error(
    `Ambiguous recipient "${recipient}": ${ids.length} agents share this name ` +
      `(ids: ${ids.join(", ")}). Send to one agent id instead.`,
  );
}

function errorNotVisible(recipient: string, id: string): Error {
  return new Error(
    `Recipient "${recipient}" (agent ${id}) is not visible to you, so you cannot message it. ` +
      "Run list_agents to see the agents you can message.",
  );
}

/**
 * Resolve one recipient string against the registry for the given sender.
 *
 * Accepted forms, in order:
 * - an 8-character agent id, matched by id;
 * - the alias `lead` for worker senders, resolving to `sender.leadId`;
 * - a worker name, matched only against workers the sender can message
 *   (a lead's own workers, or siblings for a worker sender).
 *
 * Zero matches throw an error naming the recipient and suggesting
 * `list_agents`; more than one match throws an error listing the matching
 * ids; a match that fails {@link canMessage} throws a "not visible" error.
 *
 * @param sender - The sending agent's registry record.
 * @param recipient - Recipient string: an agent id, the alias `lead`, or a worker name.
 * @param records - All registered agent records.
 * @returns The resolved recipient record.
 * @throws Error when the recipient is unknown, ambiguous, or not visible.
 */
export function resolveRecipient(
  sender: AgentRecord,
  recipient: string,
  records: AgentRecord[],
): AgentRecord {
  if (recipient === BROADCAST_RECIPIENT) {
    throw new Error(
      `"${BROADCAST_RECIPIENT}" addresses every visible agent at once. Send to one agent, or use the broadcast.`,
    );
  }

  // An 8-char lowercase worker name also matches the id pattern, so fall
  // through to name resolution when no record has that id.
  const byId = AGENT_ID_PATTERN.test(recipient) ? records.find((record) => record.id === recipient) : undefined;
  if (byId) {
    if (!canMessage(sender, byId.id, records)) throw errorNotVisible(recipient, byId.id);
    return byId;
  }

  if (recipient === LEAD_ALIAS && sender.kind !== AgentKind.Lead) {
    if (!sender.leadId) {
      throw new Error(`Unknown recipient "${LEAD_ALIAS}": this worker has no lead.`);
    }
    const lead = records.find((record) => record.id === sender.leadId);
    if (!lead) throw errorUnknown(`${LEAD_ALIAS} (${sender.leadId})`);
    return lead;
  }

  const candidates = records.filter(
    (record) => record.kind !== AgentKind.Lead && record.name === recipient,
  );
  if (candidates.length === 0) throw errorUnknown(recipient);

  const reachable = candidates.filter((record) => canMessage(sender, record.id, records));
  if (reachable.length === 0) throw errorNotVisible(recipient, candidates[0].id);
  if (reachable.length > 1) throw errorAmbiguous(recipient, reachable.map((record) => record.id));
  return reachable[0];
}

/**
 * Send a message to one agent in the registry, with visibility checks.
 *
 * Resolves the recipient with {@link resolveRecipient}, builds a message whose
 * `fromLabel` comes from {@link agentLabel}, and sends it over the socket
 * transport. An offline lead produces a {@link RecipientUnreachableError}
 * suggesting `spawn_team_lead(folder)`.
 *
 * @param sender - The sending agent's registry record.
 * @param recipient - Recipient string: an agent id, the alias `lead`, or a worker name.
 * @param subject - Short subject line.
 * @param text - Message body.
 * @param summary - Optional brief summary.
 * @param records - All registered agent records; read from disk by default.
 * @returns The resolved recipient record.
 * @throws Error when the recipient is unknown, ambiguous, or not visible.
 * @throws RecipientUnreachableError when the recipient is not listening.
 */
export async function sendAgentMessage(
  sender: AgentRecord,
  recipient: string,
  subject: string,
  text: string,
  summary?: string,
  records: AgentRecord[] = readAgentRecords(),
): Promise<AgentRecord> {
  const target = resolveRecipient(sender, recipient, records);
  try {
    await sendToAgent(buildMessage(sender.id, agentLabel(sender), target.id, subject, text, summary));
  } catch (e) {
    if (e instanceof RecipientUnreachableError && target.kind === AgentKind.Lead) {
      e.message += ` Bring it online with spawn_team_lead(folder="${target.cwd}").`;
    }
    throw e;
  }
  return target;
}

/**
 * Send a message to every broadcast target of the sender.
 *
 * Targets come from {@link broadcastTargets}: a lead reaches its own workers
 * only; a worker reaches its own lead plus its siblings. Unreachable targets
 * are reported as failures; the rest still receive the message.
 *
 * @param sender - The broadcasting agent's registry record.
 * @param subject - Short subject line.
 * @param text - Message body.
 * @param summary - Optional brief summary.
 * @param records - All registered agent records; read from disk by default.
 * @returns Delivered recipient records and failures with reasons.
 */
export async function broadcastAgentMessage(
  sender: AgentRecord,
  subject: string,
  text: string,
  summary?: string,
  records: AgentRecord[] = readAgentRecords(),
): Promise<AgentBroadcastResult> {
  const recipients = broadcastTargets(sender, records);
  const label = agentLabel(sender);
  const outcomes = await Promise.allSettled(
    recipients.map((target) =>
      sendToAgent(buildMessage(sender.id, label, target.id, subject, text, summary)),
    ),
  );

  const result: AgentBroadcastResult = { delivered: [], failed: [] };
  outcomes.forEach((outcome, index) => {
    const target = recipients[index];
    if (outcome.status === "fulfilled") {
      result.delivered.push(target);
      return;
    }
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    result.failed.push({ record: target, reason });
  });
  return result;
}
