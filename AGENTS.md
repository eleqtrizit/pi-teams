# Pi Teams

The team-lead is the coordinator. The team-leader spawns team members (agents) to work on tasks.

## Overview

Team members sit idle until a message is delivered to them. Each agent listens on a Unix domain socket. A sender connects, writes one JSON message, and waits for an acknowledgement. The receiving extension injects the full body as a user message right away and wakes the agent for a new turn. No file holds the message, and nothing polls.

## Tools

All 12 tools are registered in `extensions/index.ts`, split by session identity into three sections: team-lead tools under `if (isLead)`, shared tools for every session, and worker tools under `if (isWorker)`. `isLead` is true when `PI_AGENT_TYPE` is unset or `"lead"`; `isWorker` is true for `PI_AGENT_TYPE` `"teammate"` or `"readonly-worker"` when the agent is not named `team-lead`.

| Tool                    | Section | What it does                                         | Supporting files                                                |
| ----------------------- | ------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `team_create`           | lead    | Create a team with seeded config and task directory  | `src/utils/teams.ts`                                            |
| `resolve_model`         | lead    | Resolve a provider/model name for spawn calls        | `extensions/index.ts`                                           |
| `spawn_teammate`        | lead    | Spawn a worker in a pane or separate window          | `src/adapters/*`, `src/utils/teams.ts`, `src/utils/paths.ts`    |
| `spawn_readonly_worker` | lead    | Spawn a read-only worker with a restricted tool list | same as `spawn_teammate`                                        |
| `spawn_lead_window`     | lead    | Open the team-lead in its own OS window              | `src/adapters/*`, `src/utils/teams.ts`                          |
| `team_shutdown`         | lead    | Remove every member, then wipe the team directory    | `src/utils/teams.ts` (`removeAgent`)                            |
| `close_worker`          | lead    | Close one teammate                                   | `src/utils/teams.ts` (`removeAgent`)                            |
| `get_flavored_models`   | lead    | Show the orchestrator/worker/swarm model lists       | `src/utils/flavoredModels.ts`                                   |
| `get_models`            | lead    | Show OSS and frontier model lists                    | `src/utils/flavoredModels.ts`                                   |
| `send_message`          | shared  | Deliver a message to one agent, or to all (`all`)    | `src/utils/messaging.ts`, `src/utils/transport.ts`              |
| `list_teammates`        | shared  | Show members with status and socket availability     | `src/utils/teams.ts`, `src/utils/transport.ts`                  |
| `close_myself`          | worker  | Terminate the calling agent                          | `src/utils/teams.ts` (`removeAgent` with `ownPid: process.pid`) |

The `flavored-models` slash command is registered with the team-lead tools. It opens the interactive SettingsList and saves flavor assignments through `src/utils/flavoredModels.ts`.

Flavors are `orchestrator` (orchestrating, planning, coordinating), `worker` (coding), and `swarm` (read-only information gathering), stored as `enabledModelsOrchestrator`, `enabledModelsWorker`, and `enabledModelsSwarm`. `spawn_teammate` picks from `worker` (and `orchestrator` for a planning or coordinating teammate). `spawn_readonly_worker` picks from `swarm`, then `worker`, then the lead's model. On the lead's `session_start`, `migrateLegacyFlavors` converts the legacy `enabledModelsHigh/Med/Fast` keys once (`high` to orchestrator, `med` and `fast` to worker), shows a warning that names the moved models, and queues the same warning onto the next `get_flavored_models` result. `pi-oneturnagent` keeps its own read-only reader for both key sets and never migrates.

The dollar-prefixed one-turn model substitution inputs (`$<model> <prompt...>` and `$$<model> <prompt...>`) moved to the pi-oneturnagent package (`~/repos/pi/pi-oneturnagent`). pi-teams no longer registers them.

Read-only workers are additionally filtered by pi's `--tools` set at spawn, so they effectively see `read`, `grep`, `find`, `ls`, `send_message`, and `close_myself` only.

## Messaging

- **Messages have UUIDs** — each message has a unique ID, a subject line, a sender identity, a recipient, and a body.
- **Direct delivery** — agents never call a tool to read their own messages. The socket listener hands each message's full body (with from/to/subject/timestamp header) to the extension, which sends it as a user message. Messages that arrive while the agent is mid-run are merged into one follow-up at the run boundary.
- **Acknowledged sends** — `send_message` resolves only after the recipient's extension accepted the message. If the recipient is not running, the send fails at once with `RecipientUnreachableError`. There is no mailbox, so a message to a stopped agent is never stored.
- **Mid-run vs idle** — if a message arrives while the agent is mid-turn, it is queued and flushed as a follow-up at the run boundary so it never interrupts active tool work. If the agent is idle, the delivery wakes it for a fresh turn.
- **Sending** — agents use `send_message` with a member name, or with the recipient `all` to reach every other member. A broadcast reports the members it could not reach and still delivers to the rest.

## Worker Reports (Automated, No LLM)

When a worker's run settles, the extension sends the worker's final reply to the team-lead. The worker does not need to remember to report.

- The `agent_end` handler records the newest assistant text of each low-level run (`extractFinalReply` in `src/utils/report.ts`) and appends it to the cycle's reply list. A retry or follow-up run can follow `agent_end`, so the report waits.
- The `agent_settled` handler fires when Pi will not continue on its own. It sends every reply of the cycle, in order, to `team-lead` through `sendPlainMessage`, with the subject `Report from <agent>`. One reply goes out unchanged. Several replies are numbered (`Reply 1 of 2`). A report carries at most 20 replies.
- If the worker called `send_message` to `team-lead` (or broadcast with recipient `all`) during the cycle, the auto-report is skipped. The in-memory `reportedToLead` flag tracks this and resets at every settle.
- If the run was aborted (`event.aborted`), the extension sends an interruption notice instead, with the replies attached when any exist. The notice is sent even after a manual report.
- A run with no assistant text sends `EMPTY_REPORT_TEXT`, so the lead always hears from the worker.
- `close_myself` kills the worker before its run can settle, so the tool sends the report itself (`buildClosingReport`) before `removeAgent` runs. The report holds the cycle's replies plus the text of the run in progress (tracked from `message_end`), followed by a note that the worker closed itself. The lead's run hold ends when the worker count reaches zero, so the report must arrive first; it does because the send waits for the lead's acknowledgement.
- Reports go through `sendPlainMessage`, so the lead receives them like any other message. If the lead or the team is gone (`team_shutdown`, `close_worker`), the send fails and the handler ignores the error.

The report logic is pure and unit-tested in `src/utils/report.test.ts`. The handler wiring is tested in `extensions/auto-report.test.ts`. The extension requires Pi 1.1.0 or later because `aborted` on `agent_settled` arrived in that release.

## Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi exits as soon as the lead's run settles, which would strand spawned workers in their panes. The extension holds the run open instead:

- While the team has live workers, the `agent_end` handler parks the run. No LLM activity happens while parked; worker messages arrive through the socket listener and are queued as follow-ups. Sleeping is not involved — the hold happens in the extension, not in bash commands.
- A queued worker message releases the hold and continues the run, waking the lead with the results.
- The hold releases when the team directory is removed (`team_shutdown`), when the team has no workers, when no worker has been alive for three consecutive liveness checks (workers need a moment to boot), or when a follow-up is queued.
- Idle workers do not release the hold. Completion is the lead's decision, made by calling `team_shutdown` when every teammate has reported back; the run then settles and the session exits normally.
- Worker liveness uses the worker's pid file (written at its `session_start`, before its first turn) as the primary signal, with pane/window probes and the activity marker as fallbacks. Spawned workers load exactly the parent session's pi-teams copy via `"-ne -e <path>"`, which prevents duplicate tool registration when the lead runs pi-teams from a project-local package.

The decision logic lives in `src/utils/hold.ts` (`shouldHoldWhileTeamActive`, `countLiveWorkers`, `shouldReleaseRun`, all unit-tested). The hold loop checks for queued follow-ups every second; worker liveness checks run every 5 seconds because terminal liveness probes shell out to the terminal multiplexer.

## Worker Types

- **Regular workers** - full agents with the shared tools plus `close_myself`; they never see the team-lead tools.
- **Read-only workers** - spawned via `spawn_readonly_worker`. pi's `--tools` filter at spawn leaves them `read`, `grep`, `find`, `ls`, the messaging tools, and `close_myself`. Useful for research and investigation tasks.

## Agent Lifecycle

- Idle state is managed via event-driven timers with a shared mutable context object.
- When the socket listener receives a message, the extension delivers it as a user message, which wakes the idle agent for a new turn.
- The `agent_settled` auto-report covers the case where an agent ended its run without reporting back to the team-lead.

## Team Shutdown

- `team_shutdown` removes every member and wipes the team directory; the run then settles.
- `close_worker` (lead) and `close_myself` (worker) close one agent each.
- All three paths run the shared removal in `removeAgent` (`src/utils/teams.ts`).
- `list_teammates` shows members with their status and whether each one accepts messages.

## Logs

- **`.pi/tool.log`** (per workspace) — no longer written here. The `edit`/`write` audit trail moved to the separate `pi-journal` extension.
- **Team state files** under `~/.pi/teams/<team>/` — one file per piece of state (pid, activity, and activation markers). Written by `src/utils/teams.ts` and `extensions/index.ts`.
- **Sockets** under `$TMPDIR/pi-teams-<uid>/` — one `<hash>.sock` per listening agent, mode 0600 inside a 0700 directory. Written by `src/utils/transport.ts`.

## Model Resolution

- `resolveModel` walks a priority ladder for bare-name requests: flavored models from pi settings (the union of the orchestrator, worker, and swarm lists) first, then the scoped models (pi `--models` flag, or the enabledModels list when the flag is absent), then the entire registry. The fuzzy match runs only against the first non-empty group, so a configured group always wins.
- Provider-prefixed requests still resolve strictly within the named provider.
- Model resolution uses a smart priority system that handles OAuth provider precedence.
- Models can be specified at the team level and overridden per teammate.
- Thinking level (reasoning effort) can also be customized per teammate.

## File hierarchy

```
pi-teams/
├── extensions/                       # pi extension entry and lifecycle handlers
│   ├── index.ts                      # tool registration (one lead block, shared, worker), socket listener, hold
│   ├── index.test.ts                 # tests for pure helpers: formatting and queueing
│   ├── close-myself.test.ts          # close_myself registration and execute tests
│   ├── auto-report.test.ts           # agent_settled auto-report handler tests
│   └── tool-registration.test.ts     # registration-by-identity contract tests
├── src/
│   ├── adapters/                     # one TerminalAdapter implementation per terminal multiplexer
│   │   ├── terminal-registry.ts      # picks the adapter for the current environment
│   │   ├── tmux-adapter.ts           # plus iterm2-, zellij-, wezterm-, orca-adapter.ts
│   │   └── *.test.ts                 # adapter unit tests
│   └── utils/                        # all state mutation and decision logic
│       ├── terminal-adapter.ts       # TerminalAdapter interface that the adapters implement
│       ├── teams.ts                  # team config CRUD and the shared removeAgent removal path
│       ├── report.ts                 # final-reply extraction and worker report text for agent_settled
│       ├── transport.ts              # Unix socket listener and acknowledged send
│       ├── messaging.ts              # send and broadcast through the transport
│       ├── paths.ts                  # ~/.pi/teams path builders and sanitizeName
│       ├── lock.ts                   # withLock pid-based locking for concurrent config writes
│       ├── modelSearch.ts            # model resolution ladder and fuzzy top matches
│       ├── spawn.ts                  # buildWorkerCommand, spawnWorkerProcess, seedWorkerStateFiles
│       ├── hold.ts                   # run-hold decisions for non-interactive lead sessions
│       ├── models.ts                 # Member, TeamConfig, TeamMessage types
│       └── flavoredModels.ts         # orchestrator/worker/swarm lists, legacy migration
├── docs/                             # terminal research and release notes (working notes under docs/notes)
├── AGENTS.md                         # this file
├── README.md                         # user-facing documentation
└── package.json                      # pi-package manifest: extension entry points
```

## How the parts fit together

- **Load:** every pi session runs `extensions/index.ts`. It picks a terminal adapter (`src/adapters/terminal-registry.ts`), computes `isLead` and `isWorker` from `PI_AGENT_TYPE` and `PI_AGENT_NAME`, registers tools by identity, and installs lifecycle handlers.
- **Spawn:** the lead's spawn tools build a member record (`src/utils/teams.ts`), pre-seed state files through `src/utils/paths.ts`, and launch a child pi process through the adapter. `-ne -e <entry>` pins the worker to this extension copy; `PI_TEAM_NAME`, `PI_AGENT_NAME`, and `PI_AGENT_TYPE` drive its identity.
- **Delivery:** at `session_start` (and at `team_create` for the lead) the extension starts a socket listener through `src/utils/transport.ts`. `src/utils/messaging.ts` sends to a recipient's socket and waits for the acknowledgement. The extension injects the received body as a user message. `spawn_teammate` and `spawn_readonly_worker` wait up to 30 seconds for the worker's socket before they return.
- **Concurrency:** config reads and writes pass through `withLock` (`src/utils/lock.ts`), so two sessions never clobber the same file. The transport needs no lock because each message is one connection.
- **Removal:** every shutdown path (`close_myself`, `close_worker`, `team_shutdown`) runs `removeAgent` (`src/utils/teams.ts`): config removal, state-file cleanup, pane or window close through the adapter, then SIGKILL by pid.
- **Run hold:** `src/utils/hold.ts` decides when a non-interactive lead's run stays parked, using pid files and pane probes for worker liveness.
- **State on disk:** team state lives under `~/.pi/teams/<team>/`: `config.json` and one marker file per agent (pid, activity, first activation). Team tasks live under `~/.pi/tasks/<team>/`.
