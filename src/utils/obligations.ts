/**
 * Reply obligations for the `expectReply` flow.
 *
 * When an agent receives a message sent with `expectReply: true`, it owes the
 * sender a reply. The extension reminds the agent at `agent_before_settle`
 * until it messages the sender, up to {@link MAX_REMINDERS} times. After the
 * cap, the obligation expires and the waiting sender gets a fixed notice. This
 * module holds the pure state and text; the extension wires it to Pi events.
 */

/** Most reminders one obligation receives before it expires. */
export const MAX_REMINDERS = 3;

/** `customType` of the reminder entry injected at `agent_before_settle`. */
export const REMINDER_CUSTOM_TYPE = "pi-teams-reminder";

/** Subject prefix of the notice sent when an obligation expires unanswered. */
export const NO_REPLY_SUBJECT_PREFIX = "No reply from";

/** Subject prefix of the notice sent when a run is interrupted before replying. */
export const INTERRUPTED_SUBJECT_PREFIX = "Interrupted:";

/** Subject prefix of the notice sent when an agent closes itself before replying. */
export const CLOSED_SUBJECT_PREFIX = "Closed:";

/** One pending reply this agent owes to a sender. */
export interface Obligation {
  /** Agent id of the sender waiting for the reply. */
  senderId: string;
  /** Human-readable sender label, such as "Worker alice in /path". */
  senderLabel: string;
  /** Subject of the newest message that requested the reply. */
  subject: string;
  /** Reminders already sent for this obligation. */
  reminders: number;
}

/** A notice to send to one waiting sender. */
export interface ObligationNotice {
  recipientId: string;
  subject: string;
  text: string;
}

/**
 * In-memory set of replies this agent owes, keyed by sender id.
 *
 * Obligations persist across settle cycles until the agent messages the
 * sender, the sender becomes unreachable, or the reminder cap expires them.
 */
export class ObligationTracker {
  private readonly owed = new Map<string, Obligation>();

  /**
   * Record that a sender expects a reply.
   *
   * A newer request from the same sender replaces the subject and resets the
   * reminder count, because it is a fresh question.
   *
   * @param senderId - Agent id of the sender
   * @param senderLabel - Human-readable label of the sender
   * @param subject - Subject of the message that requested the reply
   */
  record(senderId: string, senderLabel: string, subject: string): void {
    this.owed.set(senderId, { senderId, senderLabel, subject, reminders: 0 });
  }

  /**
   * Clear the obligation to one sender.
   *
   * @param senderId - Agent id of the sender that was answered or is gone
   * @returns True when an obligation existed and was removed
   */
  clear(senderId: string): boolean {
    return this.owed.delete(senderId);
  }

  /** Every pending obligation, in the order the senders were first recorded. */
  pending(): Obligation[] {
    return [...this.owed.values()].map((obligation) => ({ ...obligation }));
  }

  /**
   * Obligations that may still receive a reminder.
   *
   * @param cap - Most reminders one obligation receives
   * @returns Obligations whose reminder count is below the cap
   */
  remindable(cap: number = MAX_REMINDERS): Obligation[] {
    return this.pending().filter((obligation) => obligation.reminders < cap);
  }

  /**
   * Count one reminder against each given sender.
   *
   * @param senderIds - Senders named in the reminder that was just sent
   */
  noteReminded(senderIds: readonly string[]): void {
    for (const senderId of senderIds) {
      const obligation = this.owed.get(senderId);
      if (obligation) obligation.reminders++;
    }
  }

  /**
   * Remove and return obligations that reached the reminder cap.
   *
   * @param cap - Most reminders one obligation receives
   * @returns The expired obligations; they are no longer tracked
   */
  takeExpired(cap: number = MAX_REMINDERS): Obligation[] {
    const expired = this.pending().filter((obligation) => obligation.reminders >= cap);
    for (const obligation of expired) this.owed.delete(obligation.senderId);
    return expired;
  }

  /**
   * Remove and return every pending obligation.
   *
   * @returns All obligations that were pending; none remain tracked
   */
  takeAll(): Obligation[] {
    const all = this.pending();
    this.owed.clear();
    return all;
  }
}

/** Facts about a run that is about to settle, as reported by `agent_before_settle`. */
export interface SettleBoundary {
  /** Outcome of the run: "completed", "aborted", or "error". */
  outcome: string;
  /** Whether Pi can make one more provider request in this run. */
  canContinue: boolean;
}

/**
 * Decide which obligations to remind at the settle boundary.
 *
 * A reminder goes out only for a completed run that can continue. Aborted and
 * failed runs never receive a reminder; the extension sends interruption
 * notices for them at `agent_settled` instead.
 *
 * @param boundary - Outcome and continuation ability of the settling run
 * @param tracker - The agent's pending reply obligations
 * @param cap - Most reminders one obligation receives
 * @returns The obligations to remind now, or an empty list for no reminder
 */
export function obligationsToRemind(
  boundary: SettleBoundary,
  tracker: ObligationTracker,
  cap: number = MAX_REMINDERS,
): Obligation[] {
  if (boundary.outcome !== "completed" || !boundary.canContinue) return [];
  return tracker.remindable(cap);
}

/**
 * Build the reminder text that names every waiting sender.
 *
 * @param obligations - Obligations to remind, at least one
 * @returns One reminder line per waiting sender
 */
export function buildReminderText(obligations: readonly Obligation[]): string {
  return obligations
    .map(
      (obligation) =>
        `Reminder: ${obligation.senderLabel} (${obligation.senderId}) is expecting a reply to ` +
        `"${obligation.subject}". Notify it with send_message(recipient="${obligation.senderId}").`,
    )
    .join("\n");
}

/**
 * Build the notice sent to a sender whose obligation expired unanswered.
 *
 * The body is fixed text and never quotes the agent's own words, so it cannot
 * echo content back to the sender.
 *
 * @param selfLabel - Human-readable label of the agent that did not reply
 * @param obligation - The expired obligation
 * @param cap - Reminder cap that was reached
 * @returns The notice for the waiting sender
 */
export function buildNoReplyNotice(
  selfLabel: string,
  obligation: Obligation,
  cap: number = MAX_REMINDERS,
): ObligationNotice {
  return {
    recipientId: obligation.senderId,
    subject: `${NO_REPLY_SUBJECT_PREFIX} ${selfLabel}`,
    text: `${selfLabel} did not reply to "${obligation.subject}" after ${cap} reminders.`,
  };
}

/**
 * Build the notice sent to a sender when the agent's run was interrupted
 * before it replied. The obligation stays pending.
 *
 * @param selfLabel - Human-readable label of the interrupted agent
 * @param obligation - The pending obligation
 * @returns The notice for the waiting sender
 */
export function buildInterruptedNotice(selfLabel: string, obligation: Obligation): ObligationNotice {
  return {
    recipientId: obligation.senderId,
    subject: `${INTERRUPTED_SUBJECT_PREFIX} ${selfLabel}`,
    text: `${selfLabel} was interrupted before replying to "${obligation.subject}".`,
  };
}

/**
 * Build the notice sent to a sender when the agent closes itself before replying.
 *
 * @param selfLabel - Human-readable label of the closing agent
 * @param obligation - The pending obligation
 * @returns The notice for the waiting sender
 */
export function buildClosedNotice(selfLabel: string, obligation: Obligation): ObligationNotice {
  return {
    recipientId: obligation.senderId,
    subject: `${CLOSED_SUBJECT_PREFIX} ${selfLabel}`,
    text: `${selfLabel} closed itself before replying to "${obligation.subject}".`,
  };
}
