import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as messaging from "../src/utils/messaging";
import { readAgentRecords } from "../src/utils/registry";
import type { AgentRecord } from "../src/utils/models";
import type { ObligationTracker } from "../src/utils/obligations";
import { buildClosedNotice } from "../src/utils/obligations";
import * as teams from "../src/utils/teams";
import { type MessageListener, RecipientUnreachableError } from "../src/utils/transport";
import type { TerminalAdapter } from "../src/utils/terminal-adapter";
import { registerFsTools } from "./fs-tools";
import { getLastUserMessageText } from "./index";

/** Session state required by shared and worker tool registrations. */
export interface SharedToolDeps {
  agentName: string;
  agentId: string;
  isWorker: boolean;
  messageListener: MessageListener | null;
  /** Called with the id of every recipient that accepted a message. */
  onMessageSent: (recipientId: string) => void;
  /** Called with the id of every recipient that was not reachable. */
  onRecipientUnreachable: (recipientId: string) => void;
  /** Replies this agent owes to senders that requested one with `expectReply`. */
  obligations: ObligationTracker;
  terminal: TerminalAdapter | null;
  selfRecord: AgentRecord | null;
}

function asPiToolSchema<TSchemaLike>(schema: TSchemaLike): TSchemaLike {
  return schema as TSchemaLike;
}

function formatAgent(record: AgentRecord): string {
  return `${messaging.agentLabel(record)} (${record.id})`;
}

const NO_REPLY_NOTE =
  "No reply is expected. If you wish to change this, send another message with " +
  "'Please reply with update' with expectReply set to true.";
const REPLY_EXPECTED_NOTE =
  "A reply is expected and will arrive as a user message. End your turn; do not wait or poll.";

function replyNote(expectReply: boolean): string {
  return expectReply ? REPLY_EXPECTED_NOTE : NO_REPLY_NOTE;
}

function formatBroadcastFailures(
  failed: { record: AgentRecord; reason: string }[],
): string {
  return failed
    .map(({ record, reason }) => `${formatAgent(record)}: ${reason}`)
    .join("; ");
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
      `Set recipient to "all" to send it to every visible agent. ` +
      "Do not use a broadcast just to answer the team-lead. Name the team-lead as the recipient instead. " +
      "The tool fails at once when the recipient is not running.",
    parameters: asPiToolSchema(
      Type.Object({
        recipient: Type.String({
          description:
            `An 8-character agent id from list_agents, one of your worker names, "${messaging.LEAD_ALIAS}" for your lead, or "all".`,
        }),
        subject: Type.String({
          description: "Short subject line for the message.",
        }),
        content: Type.String({ description: "Full message body." }),
        expectReply: Type.Boolean({
          description:
            "Set to true when you need an answer: assigning a task, asking a question, or requesting a status update. " +
            "The recipient is reminded until it messages you back. " +
            "Set to false for replies, reports, acknowledgments, and updates that need no answer.",
        }),
        summary: Type.Optional(
          Type.String({ description: "Optional brief summary." }),
        ),
      }),
    ) as any,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const selfRecord = deps.selfRecord;
      if (!selfRecord) {
        throw new Error("This session is not registered in the agent registry.");
      }

      const records = readAgentRecords();
      if (params.recipient === "all") {
        const result = await messaging.broadcastAgentMessage(
          selfRecord,
          params.subject,
          params.content,
          params.expectReply,
          params.summary,
          records,
        );
        for (const record of result.delivered) {
          deps.onMessageSent(record.id);
        }
        // AgentBroadcastResult carries only the reason text, not the error type,
        // so every failed recipient is reported as unreachable.
        for (const { record } of result.failed) {
          deps.onRecipientUnreachable(record.id);
        }
        if (result.delivered.length === 0 && result.failed.length > 0) {
          throw new Error(
            `Broadcast reached no one. ${formatBroadcastFailures(result.failed)}`,
          );
        }
        const delivered = result.delivered.map(formatAgent).join(", ") || "no one";
        const failureNote =
          result.failed.length > 0
            ? `\nNot reached: ${formatBroadcastFailures(result.failed)}`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${delivered}. ${replyNote(params.expectReply)}${failureNote}`,
            },
          ],
          details: { delivered: result.delivered, failed: result.failed },
        };
      }

      const target = messaging.resolveRecipient(selfRecord, params.recipient, records);
      let recipient: AgentRecord;
      try {
        recipient = await messaging.sendAgentMessage(
          selfRecord,
          params.recipient,
          params.subject,
          params.content,
          params.expectReply,
          params.summary,
          records,
        );
      } catch (error) {
        if (error instanceof RecipientUnreachableError) {
          deps.onRecipientUnreachable(target.id);
        }
        throw error;
      }
      deps.onMessageSent(recipient.id);
      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${formatAgent(recipient)}. ${replyNote(params.expectReply)}\n\n${params.content}`,
          },
        ],
        details: { recipient },
      };
    },
  });

}

/**
 * Register close_myself for a spawned session: workers and spawned team-leads.
 * Interactive lead sessions never register it (see extensions/index.ts).
 */
export function registerCloseMyself(
  pi: ExtensionAPI,
  deps: SharedToolDeps,
): void {
  pi.registerTool({
    name: "close_myself",
    label: "Close Myself",
    description:
      "Close this agent: clean up your state files, and terminate your own process and terminal pane or window. " +
      "Do not run this unless your instructions told you to run it. When your lead tells you to close yourself, call this tool instead of ending your turn or running kill commands. " +
      "Before closing, answer with send_message any agent that is waiting for your reply; agents still waiting are told that you closed.",
    parameters: asPiToolSchema(Type.Object({})) as any,
    async execute() {
      const selfRecord = deps.selfRecord;
      if (selfRecord) {
        const selfLabel = messaging.agentLabel(selfRecord);
        for (const obligation of deps.obligations.takeAll()) {
          const notice = buildClosedNotice(selfLabel, obligation);
          try {
            await messaging.sendAgentMessage(
              selfRecord,
              notice.recipientId,
              notice.subject,
              notice.text,
              false,
            );
          } catch (_e) {
            // Ignore send errors; closing proceeds regardless.
          }
        }
      }

      // removeAgent removes this agent's registry record and socket, closes
      // the pane or window hosting this process, and SIGKILLs this process.
      // The result is never delivered; the agent terminates mid-execute.
      const agentId = selfRecord?.id ?? deps.agentId;
      if (!agentId) {
        throw new Error("This session is not registered in the agent registry.");
      }
      await teams.removeAgent({
        agentId,
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
