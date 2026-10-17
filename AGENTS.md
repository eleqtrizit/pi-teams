# Pi Teams

The team-lead is the coordinator. The team-lead spawns team members (agents) to work on tasks. Other leads run in other directories as independent peers.

## Overview

Team members sit idle until a message is delivered to them. Each agent listens on a Unix domain socket. A sender connects, writes one JSON message, and waits for an acknowledgement. The receiving extension injects the full body as a user message right away and wakes the agent for a new turn. No file holds the message, and nothing polls.

## Tools

Tools are registered in `extensions/index.ts`, split by session identity into three sections: team-lead tools under `if (isLead)`, shared tools for every session, and worker tools under `if (isWorker)`. `isLead` is true when `PI_AGENT_TYPE` is unset or `"lead"`; `isWorker` is true for `PI_AGENT_TYPE` `"teammate"` or `"readonly-worker"` when the agent is not named `team-lead`.

| Tool                    | Section | What it does                                         | Supporting files                                                |
| ----------------------- | ------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `resolve_model`         | lead    | Resolve a provider/model name for spawn calls        | `extensions/lead-tools.ts`                                      |
| `spawn_teammate`        | lead    | Spawn a worker in a pane or separate window          | `src/adapters/*`, `src/utils/spawn.ts`, `src/utils/registry.ts` |
| `spawn_readonly_worker` | lead    | Spawn a read-only worker with a restricted tool list | same as `spawn_teammate`                                        |
| `spawn_team_lead`       | lead    | Spawn a peer lead in a pane or separate window       | `src/adapters/*`, `src/utils/spawn.ts`                          |
| `close_all_workers`     | lead    | Close every worker spawned by this lead              | `src/utils/teams.ts` (`removeAgent`)                            |
| `close_worker`          | lead    | Close one of your own workers                        | `src/utils/teams.ts` (`removeAgent`)                            |
| `get_flavored_models`   | lead    | Show the orchestrator/worker/swarm model lists       | `src/utils/flavoredModels.ts`                                   |
| `get_models`            | lead    | Show OSS and frontier model lists                    | `src/utils/flavoredModels.ts`                                   |
| `send_message`          | shared  | Deliver a message to one agent, or to all (`all`)    | `src/utils/messaging.ts`, `src/utils/transport.ts`                |
| `list_agents`           | shared  | Show visible agents with status and socket availability | `src/utils/registry.ts`, `src/utils/transport.ts`             |
| `close_myself`          | worker + spawned leads | Terminate the calling agent           | `src/utils/teams.ts` (`removeAgent` with `ownPid: process.pid`) |

`close_myself` registers for workers and for spawned leads (a lead session with a preassigned `PI_AGENT_ID`, i.e. started by `spawn_team_lead`). The interactive top-level lead session never registers it, so it cannot kill itself with one tool call. A spawned lead closing itself sends no report (it has no lead of its own); `extensions/index.ts` holds the registration gate, `registerCloseMyself` in `extensions/shared-tools.ts` holds the tool.
| `read`                  | shared  | Read a file; text results end with `content_hash:`   | `extensions/fs-tools.ts`                                        |
| `edit`                  | shared  | One targeted replacement; takes `readHash`           | `extensions/fs-tools.ts`                                        |
| `write`                 | shared  | Full-file write; takes `readHash`                    | `extensions/fs-tools.ts`                                        |

The `flavored-models` slash command is registered with the team-lead tools. It opens the interactive SettingsList and saves flavor assignments through `src/utils/flavoredModels.ts`.

Flavors are `orchestrator` (orchestrating, planning, coordinating), `worker` (coding), and `swarm` (read-only information gathering), stored as `enabledModelsOrchestrator`, `enabledModelsWorker`, and `enabledModelsSwarm`. `spawn_teammate` picks from `worker` (and `orchestrator` for a planning or coordinating teammate). `spawn_readonly_worker` picks from `swarm`, then `worker`, then the lead's model. On the lead's `session_start`, `migrateLegacyFlavors` converts the legacy `enabledModelsHigh/Med/Fast` keys once (`high` to orchestrator, `med` and `fast` to worker), shows a warning that names the moved models, and queues the same warning onto the next `get_flavored_models` result. `pi-oneturnagent` keeps its own read-only reader for both key sets and never migrates.

The dollar-prefixed one-turn model substitution inputs (`$<model> <prompt...>` and `$$<model> <prompt...>`) moved to the pi-oneturnagent package (`~/repos/pi/pi-oneturnagent`). pi-teams no longer registers them.

## Stale-Write Guard

`extensions/fs-tools.ts` registers hash-guarded `read`, `edit`, and `write`
overrides (shared section of `extensions/index.ts`). Every text `read` result
ends with a `content_hash: xxxxxxxx` line (first 8 hex chars of sha256 of the
file bytes). `edit` and `write` take a required `readHash` parameter: if the
file exists and the hash does not match its current on-disk content, the call
is rejected and the agent must re-read. Successful `edit` and `write` results
append the file's fresh hash, so follow-up edits need no extra read. Pass
`"new"` as the hash for a file that does not exist yet. The tool ordering
guarantee (`description` first per parameter) is tested in
`extensions/fs-tools.test.ts`.

This guard moved here from the pi-journal package; pi-journal now journals
`edit`/`write` mutations passively from `tool_result` events and registers no
tools itself.

Read-only workers are additionally filtered by pi's `--tools` set at spawn, so they effectively see `read`, `grep`, `find`, `ls`, `send_message`, and `close_myself` only.

## Messaging

- **Messages have UUIDs:** each message has a unique ID, a subject line, a sender identity, a recipient, and a body.
- **Direct delivery:** agents never call a tool to read their own messages. The socket listener hands each message's full body (with from/to/subject/timestamp header) to the extension, which sends it as a user message. Messages that arrive while the agent is mid-run are merged into one follow-up at the run boundary.
- **Acknowledged sends:** `send_message` resolves only after the recipient's extension accepted the message. If the recipient is not running, the send fails at once with `RecipientUnreachableError`. There is no mailbox, so a message to a stopped agent is never stored.
- **Mid-run vs idle:** if a message arrives while the agent is mid-turn, it is queued and flushed as a follow-up at the run boundary so it never interrupts active tool work. If the agent is idle, the delivery wakes it for a fresh turn.
- **Sending:** agents use `send_message` with a recipient. Accepted forms are an 8-character agent id from `list_agents`, one of your worker names, the alias `"lead"` for your lead (workers only), or `"all"` to reach every visible agent. A broadcast reports the members it could not reach and still delivers to the rest.
- **Visibility rules:** a lead sees every lead (including itself) plus the workers it owns; it never sees workers owned by another lead. A worker sees its own lead plus its sibling workers; it never sees another lead. `authorizeSender` (in `src/utils/messaging.ts`) enforces these rules on the receiver side as well, so a sender that addresses an invisible agent gets an error.
- **Message header:** every delivered message includes a `fromLabel` such as `Worker alice in /path` or `Pi Agent in /path`, plus the sender's agent id.

## Worker Reports (Automated, No LLM)

When a worker's run settles, the extension sends the worker's final reply to its lead by agent id. The worker does not need to remember to report.

- The `agent_end` handler records the newest assistant text of each low-level run (`extractFinalReply` in `src/utils/report.ts`) and appends it to the cycle's reply list. A retry or follow-up run can follow `agent_end`, so the report waits.
- The `agent_settled` handler fires when Pi will not continue on its own. It sends every reply of the cycle, in order, to the lead through `sendAgentMessage`, with the subject `Report from <agent>`. One reply goes out unchanged. Several replies are numbered (`Reply 1 of 2`). A report carries at most 20 replies.
- If the worker called `send_message` to `lead` (or broadcast with recipient `all`) during the cycle, the auto-report is skipped. The in-memory `reportedToLead` flag tracks this and resets at every settle.
- If the run was aborted (`event.aborted`), the extension sends an interruption notice instead, with the replies attached when any exist. The notice is sent even after a manual report.
- A run with no assistant text sends `EMPTY_REPORT_TEXT`, so the lead always hears from the worker.
- `close_myself` kills the worker before its run can settle, so the tool sends the report itself (`buildClosingReport`) before `removeAgent` runs. The report holds the cycle's replies plus the text of the run in progress (tracked from `message_end`), followed by a note that the worker closed itself. The lead's run hold ends when the worker count reaches zero, so the report must arrive first; it does because the send waits for the lead's acknowledgement.
- Reports go through `sendAgentMessage`, so the lead receives them like any other message. If the lead or the worker is gone (`close_all_workers`, `close_worker`), the send fails and the handler ignores the error.

**Peer-lead auto-reply:** when a lead receives a message from another lead during a settle cycle, it adds that peer's id to `peerLeadsToReply`. At `agent_settled`, if the lead has not already messaged that peer during the cycle, it sends one automatic reply with the subject `Reply from <label>` and the cycle's own replies as the body. This prevents infinite loops because the reply subject starts with `Reply from `, so the receiving lead does not queue another auto-reply.

The report logic is pure and unit-tested in `src/utils/report.test.ts`. The handler wiring is tested in `extensions/auto-report.test.ts`. The extension requires Pi 1.1.0 or later because `aborted` on `agent_settled` arrived in that release.

## Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi exits as soon as the lead's run settles, which would strand spawned workers in their panes. The extension holds the run open instead:

- While this lead has live workers in the registry, the `agent_end` handler parks the run. No LLM activity happens while parked; worker messages arrive through the socket listener and are queued as follow-ups. Sleeping is not involved; the hold happens in the extension, not in bash commands.
- A queued worker message releases the hold and continues the run, waking the lead with the results.
- The hold releases when this lead has no workers in the registry, when no worker has been alive for three consecutive liveness checks (workers need a moment to boot), or when a follow-up is queued.
- Idle workers do not release the hold. Completion is the lead's decision, made by calling `close_all_workers` when every teammate has reported back; the run then settles and the session exits normally.
- Worker liveness uses the worker's pid file (written at its `session_start`, before its first turn) as the primary signal, with pane/window probes and the activity marker as fallbacks. Spawned workers start as plain pi sessions with no extension flags, so they load their own configured extensions (pi-teams, pi-sandbox). Never add `-ne`: it drops every configured extension, including the sandbox.

The decision logic lives in `src/utils/hold.ts` (`shouldHoldWhileTeamActive`, `countLiveWorkers`, `shouldReleaseRun`, all unit-tested). The hold loop checks for queued follow-ups every second; worker liveness checks run every 5 seconds because terminal liveness probes shell out to the terminal multiplexer.

## Worker Types

- **Regular workers** - full agents with the shared tools plus `close_myself`; they never see the team-lead tools.
- **Read-only workers** - spawned via `spawn_readonly_worker`. pi's `--tools` filter at spawn leaves them `read`, `grep`, `find`, `ls`, the messaging tools, and `close_myself` only. Useful for research and investigation tasks.

## Agent Lifecycle

- Idle state is managed via event-driven timers with a shared mutable context object.
- When the socket listener receives a message, the extension delivers it as a user message, which wakes the idle agent for a new turn.
- The `agent_settled` auto-report covers the case where an agent ended its run without reporting back to its lead.

## Team Shutdown

- `close_all_workers` closes every worker spawned by the calling lead.
- `close_worker` (lead) and `close_myself` (worker) close one agent each.
- All three paths run the shared removal in `removeAgent` (`src/utils/teams.ts`).
- `list_agents` shows visible agents with their status and whether each one accepts messages.

## Logs

- **`.pi/tool.log`** (per workspace): no longer written here. The `edit`/`write` audit trail moved to the separate `pi-journal` extension.
- **Agent records** under `<tmpdir>/pi-<uid>/agents/<id>.json`: one JSON file per registered agent. Written by `src/utils/registry.ts` and read by every tool that needs to resolve or list agents.
- **Sockets** under `<tmpdir>/pi-<uid>/s/`: one `<id>.sock` per listening agent, mode 0600 inside a 0700 directory. Written by `src/utils/transport.ts`.

## Model Resolution

- `resolveModel` walks a priority ladder for bare-name requests: flavored models from pi settings (the union of the orchestrator, worker, and swarm lists) first, then the scoped models (pi `--models` flag, or the enabledModels list when the flag is absent), then the entire registry. The fuzzy match runs only against the first non-empty group, so a configured group always wins.
- Provider-prefixed requests still resolve strictly within the named provider.
- Model resolution uses a smart priority system that handles OAuth provider precedence.
- Models can be specified at spawn time and overridden per teammate.
- Thinking level (reasoning effort) can also be customized per teammate.

## File hierarchy

```
pi-teams/
├── extensions/                       # pi extension entry and lifecycle handlers
│   ├── index.ts                      # tool registration (one lead block, shared, worker), socket listener, hold
│   ├── index.test.ts                 # tests for pure helpers: formatting and queueing
│   ├── close-myself.test.ts          # close_myself registration and execute tests
│   ├── auto-report.test.ts           # agent_settled auto-report handler tests
│   ├── tool-registration.test.ts     # registration-by-identity contract tests
│   ├── fs-tools.ts                 # hash-guarded read/edit/write overrides
│   ├── lead-tools.ts               # lead-only tool registrations
│   ├── shared-tools.ts             # shared and worker tool registrations
│   └── agents-tools.ts             # list_agents and spawn_team_lead registrations
├── src/
│   ├── adapters/                     # one TerminalAdapter implementation per terminal multiplexer
│   │   ├── terminal-registry.ts      # picks the adapter for the current environment
│   │   ├── tmux-adapter.ts           # plus iterm2-, zellij-, wezterm-, orca-adapter.ts
│   │   └── *.test.ts                 # adapter unit tests
│   └── utils/                        # all state mutation and decision logic
│       ├── terminal-adapter.ts       # TerminalAdapter interface that the adapters implement
│       ├── teams.ts                  # shared removeAgent removal path
│       ├── report.ts                 # final-reply extraction and worker report text for agent_settled
│       ├── transport.ts              # Unix socket listener and acknowledged send
│       ├── messaging.ts            # send and broadcast through the transport
│       ├── paths.ts                  # registry and socket path builders and sanitizeName
│       ├── registry.ts             # agent record I/O, id generation, prune/collapse, liveness
│       ├── agentFormat.ts          # list_agents line formatting and sort order
│       ├── modelSearch.ts            # model resolution ladder and fuzzy top matches
│       ├── spawn.ts                  # buildWorkerCommand, spawnWorkerProcess, lead spawn helpers
│       ├── hold.ts                   # run-hold decisions for non-interactive lead sessions
│       ├── models.ts                 # AgentKind, AgentStatus, AgentRecord, TeamMessage types
│       ├── visibility.ts           # lead/worker visibility and broadcast rules
│       └── flavoredModels.ts         # orchestrator/worker/swarm lists, legacy migration
├── docs/                             # terminal research and release notes (working notes under docs/notes)
├── AGENTS.md                         # this file
├── README.md                         # user-facing documentation
└── package.json                      # pi-package manifest: extension entry points
```

## How the parts fit together

- **Load:** every pi session runs `extensions/index.ts`. It picks a terminal adapter (`src/adapters/terminal-registry.ts`), computes `isLead` and `isWorker` from `PI_AGENT_TYPE`, registers tools by identity, and installs lifecycle handlers.
- **Registration:** at `session_start` the extension writes an `AgentRecord` to the per-user tmp-dir registry (`src/utils/registry.ts`) and starts a socket listener through `src/utils/transport.ts`. One-shot `pi -p` sessions that were not spawned by pi-teams skip registration when they have no preassigned id and no UI.
- **Spawn:** the lead's spawn tools generate a fresh agent id, build a launch command (`src/utils/spawn.ts`), and launch a child pi process through the adapter. The child loads its own configured extensions; `PI_AGENT_ID`, `PI_LEAD_ID`, `PI_AGENT_NAME`, and `PI_AGENT_TYPE` drive its identity.
- **Delivery:** `src/utils/messaging.ts` sends to a recipient's socket and waits for the acknowledgement. The extension injects the received body as a user message. `spawn_teammate` and `spawn_readonly_worker` wait up to 30 seconds for the worker's socket before they return.
- **Concurrency:** the transport needs no lock because each message is one connection. Registry writes are atomic (temp file + rename), so two sessions never clobber the same record.
- **Removal:** every shutdown path (`close_myself`, `close_worker`, `close_all_workers`) runs `removeAgent` (`src/utils/teams.ts`): registry record removal, socket cleanup, pane or window close through the adapter, then SIGKILL by pid.
- **Run hold:** `src/utils/hold.ts` decides when a non-interactive lead's run stays parked, using registry worker counts and pid checks for liveness.
- **State on disk:** agent state lives under `<tmpdir>/pi-<uid>/`: `agents/<id>.json` records and `s/<id>.sock` sockets. The directory has mode 0700 and files have mode 0600, so only your user can read or message your agents.

## Peer leads

Independent leads run in other directories. They are not subordinate to each other; they can message each other and spawn workers in their own directories.

- **list_agents** output: one line per agent in the form `Pi Agent in <cwd>: <id>: <status>` for leads, and `Worker <name> in <cwd>: <id>: <status>` for workers. The calling agent is marked `(you)` and always shown as Online. Offline leads are collapsed to one record per directory (the newest by `startedAt`), unless an online lead exists in that directory.
- **spawn_team_lead** starts a fresh lead session in an existing folder. It does not join your team; you cannot close it with `close_worker`, and it runs its own extensions. After it starts, talk to it with `send_message(recipient=<id>)`.
- **Peer auto-reply:** when a lead receives a message from another lead, it sends one automatic reply at settle time. The reply subject starts with `Reply from ` so the receiving lead does not send another auto-reply in response.
