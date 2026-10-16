/**
 * Registration of the `list_agents` tool for every session (leads and
 * workers). Kept separate from `shared-tools.ts` so the registry-backed
 * listing stays independently testable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentEntry } from "../src/utils/agentFormat";
import { formatAgentLine, sortAgentLines } from "../src/utils/agentFormat";
import { AgentStatus, type AgentRecord } from "../src/utils/models";
import { pruneAndList } from "../src/utils/registry";
import { visibleTo } from "../src/utils/visibility";

/** Session state required by the agent tools registration. */
export interface AgentToolDeps {
  /** Returns this session's registry record, or null before it registers. */
  getSelfRecord: () => AgentRecord | null;
}

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

/**
 * Register `list_agents` for a session.
 *
 * The tool prunes stale registry records, filters the survivors by visibility
 * rules, and renders one line per agent. The calling agent is always listed
 * with status Online. Registered for every session, lead and worker alike.
 *
 * @param pi - The extension API to register the tool on.
 * @param deps - Provides this session's registry record lazily, because the
 *   record is created at `session_start`, after tool registration.
 */
export function registerAgentTools(pi: ExtensionAPI, deps: AgentToolDeps): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List peer Pi agents (leads) and your own workers with their 8-char id and " +
      "Online/Offline status. Use the id with send_message.",
    parameters: asPiToolSchema(Type.Object({})) as any,
    async execute() {
      const self = deps.getSelfRecord();
      if (!self) {
        throw new Error("This session is not registered in the agent registry.");
      }

      const entries = await pruneAndList();
      const entryById = new Map(entries.map((entry) => [entry.record.id, entry]));
      const visibleRecords = visibleTo(
        self,
        entries.map((entry) => entry.record),
      );

      // visibleTo appends the viewer when it is missing from the registry.
      // Self is always shown Online, even when a liveness probe raced the call.
      const visibleEntries: AgentEntry[] = visibleRecords.map((record) => {
        if (record.id === self.id) {
          return { record, status: AgentStatus.Online };
        }
        return entryById.get(record.id) ?? { record, status: AgentStatus.Offline };
      });

      const ordered = sortAgentLines(visibleEntries);
      const text = ordered
        .map((entry) => formatAgentLine(entry.record, entry.status, self.id))
        .join("\n");
      const agents = ordered.map((entry) => ({
        id: entry.record.id,
        kind: entry.record.kind,
        cwd: entry.record.cwd,
        ...(entry.record.name !== undefined ? { name: entry.record.name } : {}),
        status: entry.status,
      }));

      return {
        content: [{ type: "text", text }],
        details: { agents },
      };
    },
  });
}
