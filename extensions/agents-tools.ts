/**
 * Registration of the `list_agents` tool for every session (leads and
 * workers) and the lead-only `spawn_team_lead` tool. Kept separate from
 * `shared-tools.ts` so the registry-backed listing stays independently
 * testable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentEntry } from "../src/utils/agentFormat";
import { formatAgentLine, sortAgentLines } from "../src/utils/agentFormat";
import { readAgentHistory } from "../src/utils/history";
import { AgentStatus, type AgentRecord } from "../src/utils/models";
import { generateAgentId, pruneAndList } from "../src/utils/registry";
import {
  buildLeadCommand,
  buildLeadEnv,
  resolveLeadFolder,
  resolveSpawnModel,
} from "../src/utils/spawn";
import type { TerminalAdapter } from "../src/utils/terminal-adapter";
import { waitForListener } from "../src/utils/transport";
import { visibleTo } from "../src/utils/visibility";

/** Session state required by the agent tools registration. */
export interface AgentToolDeps {
  /** Returns this session's registry record, or null before it registers. */
  getSelfRecord: () => AgentRecord | null;
  /**
   * Whether this session may spawn peer leads. The registry record is set at
   * session_start, after tool registration, so the caller passes its own
   * lead identity here. Defaults to false: workers never see the tool.
   */
  isLead?: boolean;
  /** Terminal adapter used to launch spawned leads. Null when none is detected. */
  terminal?: TerminalAdapter | null;
  /**
   * Returns `lastSeenAt` epoch milliseconds per agent id, used to order
   * offline peers by how recently they were last online. Defaults to reading
   * agents.jsonl; overridden in tests.
   */
  getLastSeenAt?: () => ReadonlyMap<string, number>;
}

/** Time spawn_team_lead waits for the new lead's socket, mirroring worker spawns. */
const LEAD_LISTEN_TIMEOUT_MS = 30_000;

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

/**
 * Register `list_agents` for a session, plus `spawn_team_lead` for leads.
 *
 * `list_agents` prunes stale registry records, filters the survivors by
 * visibility rules, and renders one line per agent. The calling agent is
 * always listed with status Idling. Registered for every session, lead and
 * worker alike.
 *
 * `spawn_team_lead` launches an independent peer lead in an existing folder.
 * It is registered only when `deps.isLead` is true; the registry record is
 * created at `session_start`, after tool registration, so lead identity comes
 * from the caller.
 *
 * @param pi - The extension API to register the tool on.
 * @param deps - Provides this session's registry record lazily, plus the
 *   caller's lead identity and terminal adapter for spawn_team_lead.
 */
export function registerAgentTools(
  pi: ExtensionAPI,
  deps: AgentToolDeps,
): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List peer Pi agents (leads) and your own workers with their 8-char id and " +
      "Idling/Offline/Busy status (Idling = settled, no run in progress). Workers come first, then peers ordered by " +
      "directory proximity (closest first), ties by the most recent last-online " +
      "time. Use the id with send_message. Pass onlineOnly=true to omit Offline agents.",
    parameters: asPiToolSchema(
      Type.Object({
        onlineOnly: Type.Optional(
          Type.Boolean({
            default: false,
            description:
              "When true, list only agents that are online right now " +
              "(Idling or Busy); omit Offline agents. Defaults to false.",
          }),
        ),
      }),
    ) as any,
    async execute(_toolCallId, params: { onlineOnly?: boolean }) {
      const self = deps.getSelfRecord();
      if (!self) {
        throw new Error(
          "This session is not registered in the agent registry.",
        );
      }

      const entries = await pruneAndList();
      const entryById = new Map(
        entries.map((entry) => [entry.record.id, entry]),
      );
      const visibleRecords = visibleTo(
        self,
        entries.map((entry) => entry.record),
      );

      // visibleTo appends the viewer when it is missing from the registry.
      // Self is always shown Idling, even when a liveness probe raced the call.
      const onlineOnly = params.onlineOnly === true;
      const visibleEntries: AgentEntry[] = visibleRecords
        .map((record) => {
          if (record.id === self.id) {
            return { record, status: AgentStatus.Idling };
          }
          return (
            entryById.get(record.id) ?? { record, status: AgentStatus.Offline }
          );
        })
        .filter((entry) => !onlineOnly || entry.status !== AgentStatus.Offline);

      // Online agents are online right now; offline ones order by the last
      // time they were seen online (history lastSeenAt, startedAt fallback).
      const now = Date.now();
      const lastSeenAt =
        deps.getLastSeenAt?.() ??
        new Map(
          readAgentHistory().map((entry) => [entry.id, entry.lastSeenAt]),
        );
      const lastOnlineAt = new Map<string, number>();
      for (const entry of visibleEntries) {
        lastOnlineAt.set(
          entry.record.id,
          entry.status === AgentStatus.Offline
            ? (lastSeenAt.get(entry.record.id) ?? entry.record.startedAt)
            : now,
        );
      }

      const ordered = sortAgentLines(visibleEntries, self.cwd, lastOnlineAt);
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

  // ── Lead-only tools ─────────────────────────────────────────────────────
  // The registry record is written at session_start, after registration, so
  // the caller decides lead identity through deps.isLead.
  if (deps.isLead === true) {
    pi.registerTool({
      name: "spawn_team_lead",
      label: "Spawn Team Lead",
      description:
        "Spawn a peer Pi lead agent (not a worker) in a terminal pane or separate " +
        "window. Use it to bring an Offline directory back online, or to add another " +
        "lead's help in a directory. The new lead is independent: it does not join " +
        "your team, you cannot close it with close_worker, and it runs its own " +
        "extensions. After it starts, talk to it with send_message(recipient=<id>).",
      parameters: asPiToolSchema(
        Type.Object({
          folder: Type.String({
            description:
              "Working directory for the new lead. A leading ~ expands to the home " +
              "directory. The directory must already exist.",
          }),
          model: Type.Optional(
            Type.String({
              description:
                "Fully-qualified provider/model, e.g. from resolve_model. " +
                "Omit to use your own model.",
            }),
          ),
          separate_window: Type.Optional(
            Type.Boolean({
              default: false,
              description:
                "Open the new lead in a separate OS window instead of a pane",
            }),
          ),
        }),
      ) as any,
      async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
        const terminal = deps.terminal ?? null;
        if (!terminal) {
          throw new Error("No terminal adapter detected.");
        }
        const folder = resolveLeadFolder(params.folder);
        const model = resolveSpawnModel(ctx, params.model);
        const useSeparateWindow = params.separate_window ?? false;
        if (useSeparateWindow && !terminal.supportsWindows()) {
          throw new Error(
            `Separate windows mode is not supported in ${terminal.name}.`,
          );
        }

        const id = generateAgentId();
        const name = `pi-lead-${id}`;
        const env = buildLeadEnv(process.env, id);
        const command = buildLeadCommand(model);

        // The spawner does not own the new lead: no member record, no seeded
        // state, no roll-back path. A failed launch surfaces the adapter error.
        let terminalId = "";
        try {
          terminalId = useSeparateWindow
            ? terminal.spawnWindow({ name, cwd: folder, command, env })
            : terminal.spawn({ name, cwd: folder, command, env });
        } catch (e) {
          throw new Error(
            `Failed to spawn ${terminal.name} ${useSeparateWindow ? "window" : "pane"}: ${e}`,
          );
        }

        const listening = await waitForListener(id, LEAD_LISTEN_TIMEOUT_MS);
        const status = listening ? "Idling" : "started but not listening yet";
        return {
          content: [
            {
              type: "text",
              text: `Pi Agent in ${folder}: ${id}: ${status}`,
            },
          ],
          details: {
            id,
            cwd: folder,
            terminalId,
            isWindow: useSeparateWindow,
            listening,
          },
        };
      },
    });
  }
}
