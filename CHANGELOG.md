# Changelog

## fix(docs): align AGENTS.md and list_teammates field with direct-delivery model (`bd8bc95`)

Follow-up to the inbox-removal refactor (ef8b8aa), addressing findings from an
independent two-reviewer audit. The repo-level AGENTS.md still told teammates
to call the now-removed `read_inbox`/`read_message` tools and described the old
one-reminder-per-agent model; it now documents direct delivery, the
delivered-flag semantics, and the 30s cooldown re-fire behavior. The
`list_teammates` output field `unreadCount` is renamed to `undeliveredCount`
to match the new state. A concurrent drain-vs-append race test is added to
harden the central atomic-delivery claim that was previously verified by
inspection only.


## refactor(messaging): deliver message bodies directly instead of via inbox tools (`ef8b8aa`)

Remove the agent-facing "inbox" abstraction. The polling loop now drains
undelivered messages and delivers their full bodies (with from/to/subject/
timestamp header) as user messages, so teammates no longer call `read_inbox`
and `read_message` tools. The `read` field on `InboxMessage` is renamed to
`delivered`, `drainUndelivered` atomically reads and marks messages delivered,
and `needsReminderMessage` is simplified to a delivered-state + timestamp check.
This cuts a round-trip per message and removes the two-step notify-then-read
dance that previously drove agents to poll and sleep.


## fix(extensions): only block sleep commands while a team is online (`e30504f`)

The sleep-command block previously applied to any agent with a team name in
its environment, even after the team had been shut down. It now also checks
`teams.teamExists(teamName)`, so standalone pi sessions and shut-down teams
can use `sleep` normally.


## fix(extensions): block sleep commands for team agents (`c46344b`)

Prompt-level instructions were not enough to stop teammates from issuing
`sleep N` bash commands while waiting for inbox messages. A `tool_call` hook
now blocks any bash command matching `^sleep\s+\d+` for agents in a team
(teammates and team-lead) and returns a reason telling the agent to stop
sleeping and simply end its turn; the inbox polling loop wakes it
automatically when a message arrives.


## fix(extensions): force teammates to end turn when inbox is empty (`5e2f122`)

Teammate agents were burning tokens issuing `sleep` and poll-loop commands while
waiting for inbox messages. The teammate system prompt now contains hard rules
forbidding sleep/poll commands and read_inbox loops, and the empty-inbox
response is now a direct "stop and end your turn" instruction instead of a
soft suggestion.


## fix(extensions): batch queued inbox notifications (`c8b1d71`)

Buffer inbox notifications produced during an active agent run and deliver them
as one ordered follow-up at the run boundary. This prevents rapid notifications
from creating a separate future turn for every queued message while preserving
immediate idle wake-ups and steering reminders.

## fix(extensions): enforce provider-scoped model resolution and update tool description (`927023e`)

`resolveModelWithProvider` no longer falls through to cross-provider matching
when a `<provider>/<model>` pair is requested but not found under that provider.
Previously, `vyper/Qwen-35B` could silently return `bighank/Qwen-35B`. Now it
returns `null` — only exact or scoped matches within the named provider are
accepted.

Update the `resolve_model` tool description to instruct agents to always use
`<provider>/<model>` format and call `get_available_models()` to discover
valid pairs.

## refactor(extensions): remove inter-agent edit/write notification system (`0850b79`)

Remove the near-real-time notification queue (`sendNotification`,
`sendNotificationToAll`, `pollNotification`) that alerted teammates when an
agent edited or wrote a file. The tool.log audit trail is preserved.

## fix(messaging): use JSONL queue for notifications to prevent overwriting (`351d559`)

Switch notification files from single-write JSON to append-only JSONL queues
so rapid edits from the same agent no longer clobber each other. Poll now
drains all pending notifications atomically via rename-then-read, and the
consumer joins them into a single follow-up message to prevent flooding.

Also fix unhandled async on `sendNotificationToAll` in edit/write tool
wrappers and switch delivery from `steer` to `followUp` to avoid
interrupting mid-turn work.
