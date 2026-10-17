/**
 * Formatting and ordering for `list_agents` output lines.
 *
 * Pure helpers over the agent registry records defined in `models.ts`, kept
 * separate from the registry itself so both stay independently testable.
 */
import path from "node:path";
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
 * Count directory hops between two directories.
 *
 * The score is the number of segments in the relative path from `viewerDir`
 * down to `agentDir`: every `..` and every named directory counts as one hop.
 * A direct subfolder scores 1, a sibling under a shared parent scores 2, and
 * directories with no shared root score the sum of both depths. Both paths
 * are normalized first; comparison is case-sensitive and literal.
 *
 * @param viewerDir - Directory of the agent rendering the list.
 * @param agentDir - Directory of the listed agent.
 * @returns The hop count; 0 when both agents share the same directory.
 */
export function pathDistance(viewerDir: string, agentDir: string): number {
  const from = path.resolve(viewerDir).split(path.sep).filter(Boolean);
  const to = path.resolve(agentDir).split(path.sep).filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common += 1;
  }
  return from.length - common + (to.length - common);
}

/**
 * Order agent entries for display: workers first, then everyone else by
 * directory proximity to the viewer.
 *
 * Both groups sort by {@link pathDistance} ascending (workers share the
 * viewer's workspace, so they score 0 and lead the list). Ties break by the
 * most recent last-online time first, then by the newest `startedAt`, then by
 * id.
 *
 * @param entries - Unordered `{record, status}` pairs from the registry.
 * @param viewerCwd - Directory of the agent rendering the list.
 * @param lastOnlineAt - Epoch milliseconds each agent was last online;
 *   missing ids fall back to `startedAt`. Online agents are online now, so
 *   callers stamp them with the current time.
 * @returns A new array; workers first, then peers by proximity.
 */
export function sortAgentLines(
  entries: AgentEntry[],
  viewerCwd: string,
  lastOnlineAt: ReadonlyMap<string, number>,
): AgentEntry[] {
  const lastOnlineOf = (entry: AgentEntry): number =>
    lastOnlineAt.get(entry.record.id) ?? entry.record.startedAt;
  const byProximityThenRecency = (a: AgentEntry, b: AgentEntry): number =>
    pathDistance(viewerCwd, a.record.cwd) - pathDistance(viewerCwd, b.record.cwd) ||
    lastOnlineOf(b) - lastOnlineOf(a) ||
    b.record.startedAt - a.record.startedAt ||
    a.record.id.localeCompare(b.record.id);

  const workers = entries.filter((e) => e.record.kind !== AgentKind.Lead);
  const others = entries.filter((e) => e.record.kind === AgentKind.Lead);

  return [...workers.sort(byProximityThenRecency), ...others.sort(byProximityThenRecency)];
}
