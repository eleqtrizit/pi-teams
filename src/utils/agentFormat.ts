/**
 * Formatting and ordering for `list_agents` output lines.
 *
 * Pure helpers over the agent registry records defined in `models.ts`, kept
 * separate from the registry itself so both stay independently testable.
 */
import { AgentKind, AgentRecord, AgentStatus } from "./models";

/**
 * The `{record, status}` pair that the registry yields for each agent.
 */
export interface AgentEntry {
  record: AgentRecord;
  status: AgentStatus;
}

/**
 * Render one agent as a human-readable line.
 *
 * The lead shape is `Pi Agent in <cwd>: <id>: <status>`; workers render
 * `Worker <name> in <cwd>: <id>: <status>`, falling back to the id when the
 * record carries no name. The suffix ` (you)` marks the calling agent.
 *
 * @param rec - The agent registry record to render.
 * @param status - Current liveness state of the agent.
 * @param selfId - Id of the agent rendering the list, used for the `(you)` marker.
 * @returns The formatted line without a trailing newline.
 */
export function formatAgentLine(
  rec: AgentRecord,
  status: AgentStatus,
  selfId: string,
): string {
  const who =
    rec.kind === AgentKind.Lead
      ? "Pi Agent"
      : `Worker ${rec.name ?? rec.id}`;
  const self = rec.id === selfId ? " (you)" : "";
  return `${who} in ${rec.cwd}: ${rec.id}: ${status}${self}`;
}

/**
 * Order agent entries for display: leads first, then workers.
 *
 * @param entries - Unordered `{record, status}` pairs from the registry.
 * @returns A new array; leads sorted by cwd then startedAt, workers sorted by
 *   display name (falling back to id), ties broken by startedAt.
 */
export function sortAgentLines(entries: AgentEntry[]): AgentEntry[] {
  const leads = entries.filter((e) => e.record.kind === AgentKind.Lead);
  const workers = entries.filter((e) => e.record.kind !== AgentKind.Lead);

  const byCwdThenStarted = (a: AgentEntry, b: AgentEntry): number =>
    a.record.cwd.localeCompare(b.record.cwd) ||
    a.record.startedAt - b.record.startedAt;

  const byName = (a: AgentEntry, b: AgentEntry): number =>
    (a.record.name ?? a.record.id).localeCompare(b.record.name ?? b.record.id) ||
    a.record.startedAt - b.record.startedAt;

  return [...leads.sort(byCwdThenStarted), ...workers.sort(byName)];
}
