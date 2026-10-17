import { describe, expect, it } from "vitest";
import {
  CLOSED_SUBJECT_PREFIX,
  INTERRUPTED_SUBJECT_PREFIX,
  MAX_REMINDERS,
  NO_REPLY_SUBJECT_PREFIX,
  ObligationTracker,
  buildClosedNotice,
  buildInterruptedNotice,
  buildNoReplyNotice,
  buildReminderText,
  obligationsToRemind,
} from "./obligations";

const LEAD = { id: "lead0001", label: "Pi Agent in /repo" };
const PEER = { id: "peer0001", label: "Pi Agent in /other" };
const SELF = "Worker alice in /repo";
const COMPLETED = { outcome: "completed", canContinue: true };

function trackerWith(...senders: { id: string; label: string }[]): ObligationTracker {
  const tracker = new ObligationTracker();
  for (const sender of senders) tracker.record(sender.id, sender.label, `Task from ${sender.id}`);
  return tracker;
}

/** Remind every remindable obligation once, as the extension does per boundary. */
function remindOnce(tracker: ObligationTracker): void {
  tracker.noteReminded(obligationsToRemind(COMPLETED, tracker).map((obligation) => obligation.senderId));
}

describe("ObligationTracker", () => {
  it("starts empty", () => {
    expect(new ObligationTracker().pending()).toEqual([]);
  });

  it("records an obligation with zero reminders", () => {
    expect(trackerWith(LEAD).pending()).toEqual([
      { senderId: LEAD.id, senderLabel: LEAD.label, subject: `Task from ${LEAD.id}`, reminders: 0 },
    ]);
  });

  it("clears an obligation and reports whether one existed", () => {
    const tracker = trackerWith(LEAD);
    expect(tracker.clear(LEAD.id)).toBe(true);
    expect(tracker.clear(LEAD.id)).toBe(false);
    expect(tracker.pending()).toEqual([]);
  });

  it("keeps obligations to other senders when one is cleared", () => {
    const tracker = trackerWith(LEAD, PEER);
    tracker.clear(LEAD.id);
    expect(tracker.pending().map((obligation) => obligation.senderId)).toEqual([PEER.id]);
  });

  it("replaces the subject and resets reminders on a newer request from the same sender", () => {
    const tracker = trackerWith(LEAD);
    remindOnce(tracker);
    tracker.record(LEAD.id, LEAD.label, "Second task");
    expect(tracker.pending()).toEqual([
      { senderId: LEAD.id, senderLabel: LEAD.label, subject: "Second task", reminders: 0 },
    ]);
  });

  it("returns copies so callers cannot mutate tracked state", () => {
    const tracker = trackerWith(LEAD);
    tracker.pending()[0].reminders = 99;
    expect(tracker.pending()[0].reminders).toBe(0);
  });

  it("ignores reminders noted for unknown senders", () => {
    const tracker = trackerWith(LEAD);
    tracker.noteReminded(["missing0"]);
    expect(tracker.pending()[0].reminders).toBe(0);
  });

  it("stops offering an obligation for reminders at the cap", () => {
    const tracker = trackerWith(LEAD);
    for (let i = 0; i < MAX_REMINDERS; i++) {
      expect(tracker.remindable()).toHaveLength(1);
      remindOnce(tracker);
    }
    expect(tracker.remindable()).toEqual([]);
  });

  it("expires only obligations that reached the cap", () => {
    const tracker = trackerWith(LEAD);
    for (let i = 0; i < MAX_REMINDERS; i++) remindOnce(tracker);
    tracker.record(PEER.id, PEER.label, "Fresh question");
    const expired = tracker.takeExpired();
    expect(expired.map((obligation) => obligation.senderId)).toEqual([LEAD.id]);
    expect(tracker.pending().map((obligation) => obligation.senderId)).toEqual([PEER.id]);
  });

  it("takes every obligation at once", () => {
    const tracker = trackerWith(LEAD, PEER);
    expect(tracker.takeAll()).toHaveLength(2);
    expect(tracker.pending()).toEqual([]);
  });
});

describe("obligationsToRemind", () => {
  it("returns nothing when no reply is owed", () => {
    expect(obligationsToRemind(COMPLETED, new ObligationTracker())).toEqual([]);
  });

  it("reminds every owed sender in one boundary", () => {
    const owed = obligationsToRemind(COMPLETED, trackerWith(LEAD, PEER));
    expect(owed.map((obligation) => obligation.senderId)).toEqual([LEAD.id, PEER.id]);
  });

  it("never reminds an aborted run", () => {
    expect(obligationsToRemind({ outcome: "aborted", canContinue: true }, trackerWith(LEAD))).toEqual([]);
  });

  it("never reminds a failed run", () => {
    expect(obligationsToRemind({ outcome: "error", canContinue: true }, trackerWith(LEAD))).toEqual([]);
  });

  it("never reminds when the run cannot continue", () => {
    expect(obligationsToRemind({ outcome: "completed", canContinue: false }, trackerWith(LEAD))).toEqual([]);
  });

  it("stops after the cap so the reminder loop ends", () => {
    const tracker = trackerWith(LEAD);
    let boundaries = 0;
    while (obligationsToRemind(COMPLETED, tracker).length > 0) {
      remindOnce(tracker);
      boundaries++;
    }
    expect(boundaries).toBe(MAX_REMINDERS);
  });

  it("stops reminding once the agent replies", () => {
    const tracker = trackerWith(LEAD);
    remindOnce(tracker);
    tracker.clear(LEAD.id);
    expect(obligationsToRemind(COMPLETED, tracker)).toEqual([]);
  });
});

describe("buildReminderText", () => {
  it("names the waiting sender, its id, the subject, and the reply call", () => {
    const text = buildReminderText(trackerWith(LEAD).pending());
    expect(text).toBe(
      `Reminder: ${LEAD.label} (${LEAD.id}) is expecting a reply to "Task from ${LEAD.id}". ` +
        `Notify it with send_message(recipient="${LEAD.id}").`,
    );
  });

  it("puts one line per waiting sender", () => {
    const lines = buildReminderText(trackerWith(LEAD, PEER).pending()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`(${PEER.id})`);
  });
});

describe("notices", () => {
  const obligation = trackerWith(LEAD).pending()[0];

  it("builds the no-reply notice without quoting the agent's own text", () => {
    expect(buildNoReplyNotice(SELF, obligation)).toEqual({
      recipientId: LEAD.id,
      subject: `${NO_REPLY_SUBJECT_PREFIX} ${SELF}`,
      text: `${SELF} did not reply to "Task from ${LEAD.id}" after ${MAX_REMINDERS} reminders.`,
    });
  });

  it("builds the interrupted notice", () => {
    expect(buildInterruptedNotice(SELF, obligation)).toEqual({
      recipientId: LEAD.id,
      subject: `${INTERRUPTED_SUBJECT_PREFIX} ${SELF}`,
      text: `${SELF} was interrupted before replying to "Task from ${LEAD.id}".`,
    });
  });

  it("builds the closed notice", () => {
    expect(buildClosedNotice(SELF, obligation)).toEqual({
      recipientId: LEAD.id,
      subject: `${CLOSED_SUBJECT_PREFIX} ${SELF}`,
      text: `${SELF} closed itself before replying to "Task from ${LEAD.id}".`,
    });
  });
});
