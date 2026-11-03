/**
 * The visible, ordered agent list shared by the `list_agents` tool and the
 * `pi-teams list` command.
 */
import { sortAgentLines, type AgentEntry } from "./agentFormat";
import { historyKey, readAgentHistory } from "./history";
import { AgentStatus, type AgentRecord } from "./models";
import { pruneAndList } from "./registry";
import { visibleTo } from "./visibility";

/** Options for {@link listVisibleAgents}. */
export interface ListVisibleOptions {
  /** Omit Offline agents. */
  onlineOnly?: boolean;
  /**
   * `lastSeenAt` epoch milliseconds per `historyKey(cwd, startedAt)`, used to
   * order offline peers. Defaults to reading agents.jsonl.
   */
  lastSeenAt?: ReadonlyMap<string, number>;
}

/**
 * Prune the registry and return the agents visible to `self`, ordered for
 * display: own workers first, then peers by directory proximity, ties by the
 * most recent last-online time. `self` is always present and always Idling,
 * even when a liveness probe raced the call.
 *
 * @param self - Registry record of the agent asking.
 * @param options - Filtering and history source.
 * @returns Ordered `{record, status}` entries.
 */
export async function listVisibleAgents(
  self: AgentRecord,
  options: ListVisibleOptions = {},
): Promise<AgentEntry[]> {
  const entries = await pruneAndList();
  const entryById = new Map(entries.map((entry) => [entry.record.id, entry]));
  const visibleRecords = visibleTo(
    self,
    entries.map((entry) => entry.record),
  );

  const onlineOnly = options.onlineOnly === true;
  const visibleEntries: AgentEntry[] = visibleRecords
    .map((record) => {
      if (record.id === self.id) return { record, status: AgentStatus.Idling };
      return entryById.get(record.id) ?? { record, status: AgentStatus.Offline };
    })
    .filter((entry) => !onlineOnly || entry.status !== AgentStatus.Offline);

  // Online agents are online right now; offline ones order by the last time
  // they were seen online (history lastSeenAt, startedAt fallback).
  const now = Date.now();
  const lastSeenAt =
    options.lastSeenAt ??
    new Map(
      readAgentHistory().map((entry) => [historyKey(entry.cwd, entry.startedAt), entry.lastSeenAt]),
    );
  const lastOnlineAt = new Map<string, number>();
  for (const entry of visibleEntries) {
    const rec = entry.record;
    lastOnlineAt.set(
      rec.id,
      entry.status === AgentStatus.Offline
        ? (lastSeenAt.get(historyKey(rec.cwd, rec.startedAt)) ?? rec.startedAt)
        : now,
    );
  }
  return sortAgentLines(visibleEntries, self.cwd, lastOnlineAt);
}
