import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as messaging from "../src/utils/messaging";
import { appendReply, buildClosingReport } from "../src/utils/report";
import type { AgentRecord, Member } from "../src/utils/models";
import * as teams from "../src/utils/teams";
import { isListening, type MessageListener } from "../src/utils/transport";
import type { TerminalAdapter } from "../src/utils/terminal-adapter";
import { registerFsTools } from "./fs-tools";
import { getLastUserMessageText } from "./index";

/** Session state required by shared and worker tool registrations. */
export interface SharedToolDeps {
  agentName: string;
  agentId: string;
  isTeammate: boolean;
  getTeamName: () => string | undefined;
  messageListener: MessageListener | null;
  isMemberAlive: (team: string, member: Member) => boolean;
  isAgentActive: (team: string, agent: string) => boolean;
  setReportedToLead: (reported: boolean) => void;
  cycleReplies: readonly string[];
  currentRunText: string | null;
  terminal: TerminalAdapter | null;
  selfRecord: AgentRecord | null;
}

const LISTEN_PROBE_TIMEOUT_MS = 500;

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

function formatBroadcastFailures(failed: { name: string; reason: string }[]): string {
  return failed.map((f) => `${f.name} (${f.reason})`).join("; ");
}

/** Register shared messaging, status, filesystem tools, and the keep_last command. */
export function registerSharedTools(pi: ExtensionAPI, deps: SharedToolDeps): void {
  registerFsTools(pi);

  pi.registerCommand("keep_last", {
    description: "Remove all session history except the last user message",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const branch = ctx.sessionManager.getBranch();
      const text = getLastUserMessageText(branch);
      if (!text) {
        ctx.ui.notify("No user message to keep in this session", "error");
        return;
      }
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      // The old session file is preserved on disk through parentSession, so the
      // trimmed history stays recoverable. The replacement session starts
      // empty; in interactive mode the kept message is placed in the editor so
      // it can be reviewed and sent again against a clean context.
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          if (replacementCtx.mode === "tui") {
            replacementCtx.ui.setEditorText(text);
            replacementCtx.ui.notify(
              "History cleared; last message moved to the editor",
              "info",
            );
          }
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("Cancelled", "info");
      }
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to a teammate/worker/subagent. The message arrives immediately as a user message. " +
      `Set recipient to "${messaging.BROADCAST_RECIPIENT}" to send it to every other team member. ` +
      "Do not use a broadcast just to answer the team-lead. Name the team-lead as the recipient instead. " +
      "The tool fails at once when the recipient is not running.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.Optional(
          Type.String({ description: "Defaults to your current team." }),
        ),
        recipient: Type.String({
          description: `A team member name, or "${messaging.BROADCAST_RECIPIENT}" for every other member.`,
        }),
        subject: Type.String({
          description: "Short subject line for the message.",
        }),
        content: Type.String({ description: "Full message body." }),
        summary: Type.Optional(
          Type.String({ description: "Optional brief summary." }),
        ),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const resolvedTeam = params.team_name || deps.getTeamName();
      if (!resolvedTeam)
        throw new Error("team_name is required (no team is currently active).");

      if (params.recipient === messaging.BROADCAST_RECIPIENT) {
        const result = await messaging.broadcastMessage(
          resolvedTeam,
          deps.agentId,
          deps.agentName,
          params.subject,
          params.content,
          params.summary,
        );
        // A broadcast reaches the lead, so it counts as a report.
        if (result.delivered.includes("team-lead")) deps.setReportedToLead(true);
        if (result.delivered.length === 0 && result.failed.length > 0) {
          throw new Error(`Broadcast reached no one. ${formatBroadcastFailures(result.failed)}`);
        }
        const failureNote =
          result.failed.length > 0 ? `\nNot reached: ${formatBroadcastFailures(result.failed)}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${result.delivered.join(", ") || "no one"}.${failureNote}`,
            },
          ],
          details: { delivered: result.delivered, failed: result.failed },
        };
      }

      await messaging.sendPlainMessage(
        resolvedTeam,
        deps.agentId,
        deps.agentName,
        params.recipient,
        params.subject,
        params.content,
        params.summary,
      );
      if (params.recipient === "team-lead") deps.setReportedToLead(true);
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${params.recipient}.\n\n${params.content}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List all teammates/workers/subagents in a team with their status.",
    parameters: asPiToolSchema(
      Type.Object({
        team_name: Type.String(),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const teammates = await Promise.all(
        config.members.map(async (member) => {
          const alive =
            member.name === "team-lead" && !deps.isTeammate
              ? true
              : deps.isMemberAlive(params.team_name, member);
          const listening =
            member.name === deps.agentName && deps.messageListener
              ? true
              : member.registryId
                ? await isListening(member.registryId, LISTEN_PROBE_TIMEOUT_MS)
                : false;
          const active = deps.isAgentActive(params.team_name, member.name);
          return {
            name: member.name,
            agentType: member.agentType,
            model: member.model,
            alive,
            active,
            listening,
          };
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(teammates, null, 2) }],
        details: { teammates },
      };
    },
  });
}

/** Register close_myself for a spawned worker. */
export function registerWorkerTools(pi: ExtensionAPI, deps: SharedToolDeps): void {
  pi.registerTool({
    name: "close_myself",
    label: "Close Myself",
    description:
      "Close this agent: remove yourself from the team config, clean up your state files, and terminate your own process and terminal pane or window. " +
      "Do not run this unless your instructions told you to run it. When the team-lead tells you to close yourself, call this tool instead of ending your turn or running kill commands. " +
      "Write your final report as text in the same turn before the call. The extension sends that text to the team-lead as your last report, because you stop running when this tool runs.",
    parameters: asPiToolSchema(Type.Object({})) as any,
    async execute() {
      const activeTeam = deps.getTeamName();
      if (!activeTeam) {
        throw new Error(
          "No team is active for this agent, so there is nothing to close.",
        );
      }

      // A closing worker never reaches agent_settled, so report its replies
      // now, while the lead can still receive them.
      const report = buildClosingReport(
        deps.agentName,
        appendReply(deps.cycleReplies, deps.currentRunText),
      );
      try {
        await messaging.sendPlainMessage(activeTeam, deps.agentId, deps.agentName, "team-lead", report.subject, report.text);
      } catch (_e) {
        // The lead or the team can be gone already. Closing still proceeds.
      }

      // removeAgent removes this member from the team config, deletes every
      // state file for this agent, closes the pane or window hosting this
      // process, and SIGKILLs this process. The result is never delivered;
      // the agent terminates mid-execute.
      await teams.removeAgent({
        team: activeTeam,
        agentName: deps.agentName,
        ownPid: process.pid,
        terminal: deps.terminal,
      });

      // Unreachable at runtime: removeAgent terminated this process, but the
      // tool contract requires a result to satisfy the type system.
      return {
        content: [
          { type: "text", text: `Agent ${deps.agentName} closed itself.` },
        ],
        details: {},
      };
    },
  });
}
