import { AgentKind, type AgentRecord } from "./models";

/** Worker kinds: everything that is not a lead. */
const isWorker = (record: AgentRecord): boolean => record.kind !== AgentKind.Lead;

/** True when the record is a worker owned by the given lead. */
const isOwnedBy = (leadId: string | undefined, record: AgentRecord): boolean =>
  leadId !== undefined && isWorker(record) && record.leadId === leadId;

/**
 * Records visible to the viewer in the registry.
 *
 * A lead sees every lead (including itself) plus the workers it owns; it never
 * sees workers owned by another lead. A worker sees its own lead plus workers
 * that share its `leadId`; it never sees another lead. The viewer itself is
 * always included, even when absent from `records` (list output marks "(you)").
 *
 * @param viewer The record of the agent asking for the list.
 * @param records All registered agent records.
 * @returns The visible records, in input order, with the viewer appended last
 * when it is not already part of `records`.
 */
export function visibleTo(viewer: AgentRecord, records: AgentRecord[]): AgentRecord[] {
  const visible =
    viewer.kind === AgentKind.Lead
      ? records.filter((record) => record.kind === AgentKind.Lead || isOwnedBy(viewer.id, record))
      : records.filter(
          (record) =>
            (record.kind === AgentKind.Lead && record.id === viewer.leadId) ||
            isOwnedBy(viewer.leadId, record),
        );

  if (visible.some((record) => record.id === viewer.id)) {
    return visible;
  }
  return [...visible, viewer];
}

/**
 * Whether a sender is allowed to deliver a message to one agent.
 *
 * Self-delivery is never allowed; otherwise the recipient must be visible to
 * the sender.
 *
 * @param from The record of the sending agent.
 * @param toId The id of the candidate recipient.
 * @param records All registered agent records.
 * @returns True when the sender may message the recipient.
 */
export function canMessage(from: AgentRecord, toId: string, records: AgentRecord[]): boolean {
  if (toId === from.id) {
    return false;
  }
  return visibleTo(from, records).some((record) => record.id === toId);
}

/**
 * Recipients of a broadcast (`all`) from the given sender.
 *
 * A lead broadcasts to the workers it owns only; peer leads are excluded. A
 * worker broadcasts to its own lead plus its siblings. The sender is always
 * excluded.
 *
 * @param from The record of the broadcasting agent.
 * @param records All registered agent records.
 * @returns The broadcast recipients, in input order.
 */
export function broadcastTargets(from: AgentRecord, records: AgentRecord[]): AgentRecord[] {
  if (from.kind === AgentKind.Lead) {
    return records.filter((record) => isOwnedBy(from.id, record));
  }
  return records.filter(
    (record) =>
      (record.kind === AgentKind.Lead && record.id === from.leadId) ||
      (isOwnedBy(from.leadId, record) && record.id !== from.id),
  );
}
