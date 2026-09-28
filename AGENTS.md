# Pi Teams

The team-lead is the coordinator. The team-leader spawns team members (agents) to work on tasks.

## Overview

Team members sit idle until a message is delivered to them. A programmatic loop polls each agent's inbox file every second; when undelivered messages are found, it drains them (atomically marking them delivered under a file lock) and injects their full bodies as user messages, waking the agent for a new turn. Active agents are interrupted via `abort_current_tool` when a delivery arrives, ensuring responsiveness.

## Tools

All 13 tools are registered in `extensions/index.ts`, split by session identity into three sections: team-lead tools under `if (isLead)`, shared tools for every session, and worker tools under `if (isWorker)`. `isLead` is true when `PI_AGENT_TYPE` is unset or `"lead"`; `isWorker` is true for `PI_AGENT_TYPE` `"teammate"` or `"readonly-worker"` when the agent is not named `team-lead`.

| Tool | Section | What it does | Supporting files |
|---|---|---|---|
| `team_create` | lead | Create a team with seeded config and task directory | `src/utils/teams.ts` |
| `resolve_model` | lead | Resolve a provider/model name for spawn calls | `extensions/index.ts` |
| `spawn_teammate` | lead | Spawn a worker in a pane or separate window | `src/adapters/*`, `src/utils/teams.ts`, `src/utils/paths.ts` |
| `spawn_readonly_worker` | lead | Spawn a read-only worker with a restricted tool list | same as `spawn_teammate` |
| `spawn_lead_window` | lead | Open the team-lead in its own OS window | `src/adapters/*`, `src/utils/teams.ts` |
| `team_shutdown` | lead | Remove every member, then wipe the team directory | `src/utils/teams.ts` (`removeAgent`) |
| `close_worker` | lead | Close one teammate | `src/utils/teams.ts` (`removeAgent`) |
| `get_flavored_models` | lead | Show the high/med/fast model lists | `src/utils/flavoredModels.ts` |
| `get_models` | lead | Show OSS and frontier model lists | `src/utils/flavoredModels.ts` |
| `send_message` | shared | Deliver a message to one agent | `src/utils/messaging.ts`, `src/utils/paths.ts` |
| `broadcast_message` | shared | Deliver a message to every member | `src/utils/messaging.ts` |
| `list_teammates` | shared | Show members with status and undelivered counts | `src/utils/teams.ts`, `src/utils/messaging.ts` |
| `close_myself` | worker | Terminate the calling agent | `src/utils/teams.ts` (`removeAgent` with `ownPid: process.pid`) |

The `flavored-models` slash command is registered with the team-lead tools. It opens the interactive SettingsList and saves flavor assignments through `src/utils/flavoredModels.ts`.

Read-only workers are additionally filtered by pi's `--tools` set at spawn, so they effectively see `read`, `grep`, `find`, `ls`, `send_message`, `broadcast_message`, and `close_myself` only.

## Messaging

- **Messages have UUIDs** — each message has a unique ID, a subject line, a sender identity, a recipient, and a body.
- **Direct delivery** — agents never call a tool to read their own messages. The polling loop delivers each message's full body (with from/to/subject/timestamp header) directly as a user message. Multiple messages arriving in the same tick are merged into one delivery.
- **Mid-run vs idle** — if a message arrives while the agent is mid-turn, it is queued and flushed as a follow-up at the run boundary so it never interrupts active tool work. If the agent is idle, the delivery wakes it for a fresh turn.
- **Sending** — agents use `send_message` (to a named recipient) or `broadcast_message` (to all teammates except themselves) to send messages to others.

## Reminder System (Automated, No LLM)

If a team member receives a team-lead instruction but finishes its turn without reporting back, a reminder is sent automatically:

> "Report back to the team-lead with your results, if you haven't already done so."

A reminder can fire from two places (belt-and-suspenders): the `turn_end` handler steers the agent immediately if it ended a turn without responding (queued for the run boundary when the agent is still running, so it never injects midstream), and the polling loop fires the reminder if the agent is still idle and unresponsive. At most one reminder fires per instruction: reminders do not re-fire on a timer, so a permanently stuck agent gets exactly one nudge per team-lead message. The logic lives in `needsReminderMessage` (`src/utils/messaging.ts`) and keys off the `delivered` flag on instructions plus `lastReportTime`/`lastReminderTime` timestamps — never off agent read state.

**Important:** Delivery and reminders are fully automated — they do NOT involve LLM cycles for the polling itself. The system handles draining, marking delivered, and sending reminders programmatically.

## Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi exits as soon as the lead's run settles, which would strand spawned workers in their panes. The extension holds the run open instead:

- While the team has live workers, the `agent_end` handler parks the run. No LLM activity happens while parked; worker messages arrive through the normal 1-second inbox poller and are queued as follow-ups. Sleeping is not involved — the hold happens in the extension, not in bash commands.
- A queued worker message releases the hold and continues the run, waking the lead with the results.
- The hold releases when the team directory is removed (`team_shutdown`), when the team has no workers, when no worker has been alive for three consecutive liveness checks (workers need a moment to boot), or when a follow-up is queued.
- Idle workers do not release the hold. Completion is the lead's decision, made by calling `team_shutdown` when every teammate has reported back; the run then settles and the session exits normally.
- Worker liveness uses the worker's pid file (written at its `session_start`, before its first turn) as the primary signal, with pane/window probes and the activity marker as fallbacks. Spawned workers load exactly the parent session's pi-teams copy via `"-ne -e <path>"`, which prevents duplicate tool registration when the lead runs pi-teams from a project-local package.

The decision logic lives in `src/utils/hold.ts` (`shouldHoldWhileTeamActive`, `countLiveWorkers`, `shouldReleaseRun`, all unit-tested). Message polls run every second; worker liveness checks run every 5 seconds because terminal liveness probes shell out to the terminal multiplexer.

## Worker Types

- **Regular workers** - full agents with the shared tools plus `close_myself`; they never see the team-lead tools.
- **Read-only workers** - spawned via `spawn_readonly_worker`. pi's `--tools` filter at spawn leaves them `read`, `grep`, `find`, `ls`, the messaging tools, and `close_myself`. Useful for research and investigation tasks.

## Agent Lifecycle

- Idle state is managed via event-driven timers with a shared mutable context object.
- When an undelivered message is found, the polling loop drains and delivers it as a user message, which wakes the idle agent for a new turn.
- The reminder steer at `turn_end` (queued to run boundary while the agent is still running) covers the case where an agent ended its turn without reporting back to the team-lead.

## Team Shutdown

- `team_shutdown` removes every member and wipes the team directory; the run then settles.
- `close_worker` (lead) and `close_myself` (worker) close one agent each.
- All three paths run the shared removal in `removeAgent` (`src/utils/teams.ts`).
- `list_teammates` shows members with their status and undelivered message counts.

## Logs

- **`.pi/tool.log`** (per workspace) — no longer written here. The `edit`/`write` audit trail moved to the separate `pi-journal` extension.
- **Team state files** under `~/.pi/teams/<team>/` — one file per piece of state (inboxes, pid, activation markers). Written by `src/utils/messaging.ts` and `extensions/index.ts`.

## Model Resolution

- Model resolution uses a smart priority system that handles OAuth provider precedence.
- Models can be specified at the team level and overridden per teammate.
- Thinking level (reasoning effort) can also be customized per teammate.

## File hierarchy

```
pi-teams/
├── extensions/                       # pi extension entry and lifecycle handlers
│   ├── index.ts                      # tool registration (lead/shared/worker), pollers, spawn commands
│   ├── index.test.ts                 # tests for pure helpers: formatting and model matching
│   ├── close-myself.test.ts          # close_myself registration and execute tests
│   └── tool-registration.test.ts     # registration-by-identity contract tests
├── src/
│   ├── adapters/                     # one TerminalAdapter implementation per terminal multiplexer
│   │   ├── terminal-registry.ts      # picks the adapter for the current environment
│   │   ├── tmux-adapter.ts           # plus iterm2-, zellij-, wezterm-, orca-adapter.ts
│   │   └── *.test.ts                 # adapter unit tests
│   └── utils/                        # all state mutation and decision logic
│       ├── terminal-adapter.ts       # TerminalAdapter interface that the adapters implement
│       ├── teams.ts                  # team config CRUD and the shared removeAgent removal path
│       ├── messaging.ts              # inboxes, delivery, reminders, needsReminderMessage
│       ├── paths.ts                  # ~/.pi/teams path builders and sanitizeName
│       ├── lock.ts                   # withLock locking for concurrent config and inbox writes
│       ├── hold.ts                   # run-hold decisions for non-interactive lead sessions
│       ├── models.ts                 # Member, TeamConfig, InboxMessage types
│       └── flavoredModels.ts         # high/med/fast flavor lists in pi settings.json
├── docs/                             # terminal research and release notes
├── AGENTS.md                         # this file
├── README.md                         # user-facing documentation
└── package.json                      # pi-package manifest: extension entry points
```

## How the parts fit together

- **Load:** every pi session runs `extensions/index.ts`. It picks a terminal adapter (`src/adapters/terminal-registry.ts`), computes `isLead` and `isWorker` from `PI_AGENT_TYPE` and `PI_AGENT_NAME`, registers tools by identity, and installs lifecycle handlers.
- **Spawn:** the lead's spawn tools build a member record (`src/utils/teams.ts`), pre-seed state files through `src/utils/paths.ts`, and launch a child pi process through the adapter. `-ne -e <entry>` pins the worker to this extension copy; `PI_TEAM_NAME`, `PI_AGENT_NAME`, and `PI_AGENT_TYPE` drive its identity.
- **Delivery:** `extensions/index.ts` polls inbox files once per second. `src/utils/messaging.ts` drains undelivered messages, and the extension injects their full bodies as user messages. Reminders travel through the same path.
- **Concurrency:** config reads and writes and inbox appends pass through `withLock` (`src/utils/lock.ts`), so two sessions never clobber the same file.
- **Removal:** every shutdown path (`close_myself`, `close_worker`, `team_shutdown`) runs `removeAgent` (`src/utils/teams.ts`): config removal, state-file cleanup, pane or window close through the adapter, then SIGKILL by pid.
- **Run hold:** `src/utils/hold.ts` decides when a non-interactive lead's run stays parked, using pid files and pane probes for worker liveness.
- **State on disk:** team state lives under `~/.pi/teams/<team>/`: `config.json`, `inboxes/<agent>.json`, and one marker file per agent (pid, activity, timestamps). Team tasks live under `~/.pi/tasks/<team>/`.
