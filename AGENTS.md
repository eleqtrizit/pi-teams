# Pi Teams

The team-lead is the coordinator. The team-leader spawns team members (agents) to work on tasks.

## Overview

Team members sit idle until a message is received in their inbox. A programmatic loop watches the inbox and triggers the agent when new messages arrive. Active agents are interrupted via `abort_current_tool` when an inbox notification arrives, ensuring responsiveness.

## Inbox & Messaging

- **Messages have UUIDs** — each message has a unique ID, a subject line, a sender identity, and a body.
- **Use `read_inbox`** to list unread messages (shows a table with subject, sender, and ID).
- **Use `read_message`** with the message ID to read the full body — this marks the message as read.
- **Notifications are delivered as steer messages** — when a message arrives for an agent, the system steers the agent (interrupting idle loops or active tools) to surface the notification.
- **Empty inbox sleep hint** — when the inbox is empty, the loop outputs a hint for the agent to sleep rather than busy-polling.

## Reminder System (Automated, No LLM)

If a team member finishes work but has not sent a report back to the team-lead, a reminder is sent automatically:

> "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

The reminder fires only when the last active time is greater than the last sent message time. Only one reminder is sent per agent, and it relies on messages being properly marked read via `read_message`.

**Important:** Inbox reads and reminders are fully automated — they do NOT involve LLM cycles. The system handles polling, marking read, and sending reminders programmatically.

## Worker Types

- **Regular workers** — full agents spawned by the team-lead with access to all tools.
- **Read-only workers** — spawned via `spawn_readonly_worker`. These have restricted tool access (read, search, browse) but still get messaging tools for team communication. Useful for research/investigation tasks.

## Agent Lifecycle

- Idle state is managed via event-driven timers with a shared mutable context object.
- When an inbox notification arrives, the idle loop is interrupted via abort before the steer message is delivered.
- The steer-to-worker pattern replaces inbox reminders: workers are directly steered rather than receiving inbox messages and then waiting for a separate reminder.

## Team Shutdown

- A `shutdown_team` command cleanly terminates all team processes.
- A `list_teammates` command shows active teammates and their status.

## Logs

- **`.pi/tool.log`** (per workspace) — tab-separated audit of every `edit`/`write` tool call. Columns: ISO timestamp, level, tool, path, description. Written by `extensions/index.ts`.
- **Team state files** under `~/.pi/teams/<team>/` — one file per piece of state (inboxes, pid, activation markers). Written by `src/utils/messaging.ts` and `extensions/index.ts`.

## Model Resolution

- Model resolution uses a smart priority system that handles OAuth provider precedence.
- Models can be specified at the team level and overridden per teammate.
- Thinking level (reasoning effort) can also be customized per teammate.
