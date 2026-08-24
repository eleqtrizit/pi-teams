# Pi Teams

The team-lead is the coordinator. The team-leader spawns team members (agents) to work on tasks.

## Overview

Team members sit idle until a message is delivered to them. A programmatic loop polls each agent's inbox file every second; when undelivered messages are found, it drains them (atomically marking them delivered under a file lock) and injects their full bodies as user messages, waking the agent for a new turn. Active agents are interrupted via `abort_current_tool` when a delivery arrives, ensuring responsiveness.

## Messaging

- **Messages have UUIDs** — each message has a unique ID, a subject line, a sender identity, a recipient, and a body.
- **Direct delivery** — agents never call a tool to read their own messages. The polling loop delivers each message's full body (with from/to/subject/timestamp header) directly as a user message. Multiple messages arriving in the same tick are merged into one delivery.
- **Mid-run vs idle** — if a message arrives while the agent is mid-turn, it is queued and flushed as a follow-up at the run boundary so it never interrupts active tool work. If the agent is idle, the delivery wakes it for a fresh turn.
- **Sending** — agents use `send_message` (to a named recipient) or `broadcast_message` (to all teammates except themselves) to send messages to others.

## Reminder System (Automated, No LLM)

If a team member receives a team-lead instruction but finishes its turn without reporting back, a reminder is sent automatically:

> "Report back to the team-lead with your results."

A reminder can fire from two places (belt-and-suspenders): the `turn_end` handler steers the agent immediately if it ended a turn without responding, and the polling loop re-fires the reminder after a 30-second cooldown if the agent is still idle and unresponsive. Reminders re-fire every cooldown period until the agent sends a message to the team-lead, so a permanently stuck agent is nudged repeatedly rather than only once. The logic lives in `needsReminderMessage` (`src/utils/messaging.ts`) and keys off the `delivered` flag on instructions plus `lastReportTime`/`lastReminderTime` timestamps — never off agent read state.

**Important:** Delivery and reminders are fully automated — they do NOT involve LLM cycles for the polling itself. The system handles draining, marking delivered, and sending reminders programmatically.

## Worker Types

- **Regular workers** — full agents spawned by the team-lead with access to all tools.
- **Read-only workers** — spawned via `spawn_readonly_worker`. These have restricted tool access (read, grep, find, ls) plus messaging (send_message, broadcast_message) for team communication. Useful for research/investigation tasks.

## Agent Lifecycle

- Idle state is managed via event-driven timers with a shared mutable context object.
- When an undelivered message is found, the polling loop drains and delivers it as a user message, which wakes the idle agent for a new turn.
- The reminder steer at `turn_end` (and its cooldown-gated re-fire in the poller) covers the case where an agent ended its turn without reporting back to the team-lead.

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
