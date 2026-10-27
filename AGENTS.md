# Pi Teams

The team-lead is the coordinator. The team-lead spawns team members (agents) to work on tasks. Other leads run in other directories as independent peers.

## Overview

Team members sit idle until a message is delivered to them. Each agent listens on a Unix domain socket. A sender connects, writes one JSON message, and waits for an acknowledgement. The receiving extension injects the full body as a user message right away and wakes the agent for a new turn. No file holds the message, and nothing polls.

## Tools

Tools are registered in `extensions/index.ts`, split by session identity into three sections: team-lead tools under `if (isLead)`, shared tools for every session, and worker tools under `if (isWorker)`. `isLead` is true when `PI_AGENT_TYPE` is unset or `"lead"`; `isWorker` is true for `PI_AGENT_TYPE` `"teammate"` or `"readonly-worker"` when the agent is not named `team-lead`.

| Tool                    | Section                | What it does                                                              | Supporting files                                                               |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `resolve_model`         | lead                   | Resolve a provider/model name for spawn calls                             | `extensions/lead-tools.ts`                                                     |
| `spawn_teammate`        | lead                   | Spawn a worker in a pane or separate window                               | `src/adapters/*`, `src/utils/spawn.ts`, `src/utils/registry.ts`                |
| `spawn_readonly_worker` | lead                   | Spawn a read-only worker with a restricted tool list                      | same as `spawn_teammate`                                                       |
| `spawn_team_lead`       | lead                   | Spawn a peer lead in a pane or separate window                            | `src/adapters/*`, `src/utils/spawn.ts`                                         |
| `close_all_workers`     | lead                   | Close every worker spawned by this lead                                   | `src/utils/teams.ts` (`removeAgent`)                                           |
| `close_worker`          | lead                   | Close one of your own workers                                             | `src/utils/teams.ts` (`removeAgent`)                                           |
| `get_flavored_models`   | lead                   | Show the orchestrator/worker/swarm model lists                            | `src/utils/flavoredModels.ts`                                                  |
| `get_models`            | lead                   | Show OSS and frontier model lists                                         | `src/utils/flavoredModels.ts`                                                  |
| `send_message`          | shared                 | Deliver a message to one agent, or to all (`all`); required `expectReply` | `src/utils/messaging.ts`, `src/utils/transport.ts`, `src/utils/obligations.ts` |
| `list_agents`           | shared                 | Show visible agents with status and socket availability                   | `src/utils/registry.ts`, `src/utils/transport.ts`                              |
| `close_myself`          | worker + spawned leads | Terminate the calling agent                                               | `src/utils/teams.ts` (`removeAgent` with `ownPid: process.pid`)                |

`close_myself` registers for workers and for spawned leads (a lead session with a preassigned `PI_AGENT_ID`, i.e. started by `spawn_team_lead`). The interactive top-level lead session never registers it, so it cannot kill itself with one tool call. Before it removes itself, `close_myself` sends a `Closed: <label>` notice to every agent still waiting for a reply (see [Reply obligations](#reply-obligations-expectreply)); it sends nothing else. `extensions/index.ts` holds the registration gate, `registerCloseMyself` in `extensions/shared-tools.ts` holds the tool.
| `read` | shared | Read a file; text results end with `file_hash:` | `extensions/fs-tools.ts` |
| `edit` | shared | One targeted replacement; takes `fileHash` | `extensions/fs-tools.ts` |
| `write` | shared | Full-file write; takes `fileHash` | `extensions/fs-tools.ts` |
| `amend` | shared | Complete a rejected edit or write with just the missing fields | `extensions/fs-tools.ts` |

The `flavored-models` slash command is registered with the team-lead tools. It opens the interactive SettingsList and saves flavor assignments through `src/utils/flavoredModels.ts`.

Flavors are `orchestrator` (orchestrating, planning, coordinating), `worker` (coding), and `swarm` (read-only information gathering), stored as `enabledModelsOrchestrator`, `enabledModelsWorker`, and `enabledModelsSwarm`. `spawn_teammate` picks from `worker` (and `orchestrator` for a planning or coordinating teammate). `spawn_readonly_worker` picks from `swarm`, then `worker`, then the lead's model. On the lead's `session_start`, `migrateLegacyFlavors` converts the legacy `enabledModelsHigh/Med/Fast` keys once (`high` to orchestrator, `med` and `fast` to worker), shows a warning that names the moved models, and queues the same warning onto the next `get_flavored_models` result. `pi-oneturnagent` keeps its own read-only reader for both key sets and never migrates.

The dollar-prefixed one-turn model substitution inputs (`$<model> <prompt...>` and `$$<model> <prompt...>`) moved to the pi-oneturnagent package (`~/repos/pi/pi-oneturnagent`). pi-teams no longer registers them.

## Stale-Write Guard

`extensions/fs-tools.ts` registers hash-guarded `read`, `edit`, and `write`
overrides (shared section of `extensions/index.ts`). Every text `read` result
ends with a `file_hash: xxxxxxxx` line (first 8 hex chars of sha256 of the
file bytes). `edit` and `write` take a required `fileHash` parameter: if the
file exists and the hash does not match its current on-disk content, the call
is rejected and the agent must re-read. Successful `edit` and `write` results
append the file's fresh hash, so follow-up edits need no extra read. Pass
`"new"` as the hash for a file that does not exist yet. The tool ordering
guarantee (`description` first per parameter) is tested in
`extensions/fs-tools.test.ts`.

`description` and `fileHash` are schema-optional but required in practice;
`requireAll` validates them inside `execute` so a rejection names every required
parameter and which ones are missing, instead of pi core's schema error naming
only one. The rejected partial is stored, and the `amend` tool completes it:
`amend(tool="edit"|"write", fields={...})` merges the missing fields over the
stored partial and executes the completed call. A merge that still misses
fields keeps the merged partial stored, so a follow-up amend can continue.

Bash can still create files, so `extensions/bash-hash.ts` registers a
`tool_result` handler for `bash` results: it detects files the command wrote
(output redirection and `tee`), verifies each path on disk, and appends
`file_hash: <hash> (bash-written: <path>)` lines to the result. The hash
guard therefore covers bash-written files too.

This guard moved here from the pi-journal package; pi-journal now journals
`edit`/`write` mutations passively from `tool_result` events and registers no
tools itself.

Read-only workers are additionally filtered by pi's `--tools` set at spawn, so they effectively see `read`, `grep`, `find`, `ls`, `send_message`, and `close_myself` only.

## Messaging

- **Messages have UUIDs:** each message has a unique ID, a subject line, a sender identity, a recipient, and a body.
- **Direct delivery:** agents never call a tool to read their own messages. The socket listener hands each message's full body (with from/to/subject/timestamp header) to the extension, which sends it as a user message. Messages that arrive while the agent is mid-run are merged into one follow-up at the run boundary.
- **Acknowledged sends:** `send_message` resolves only after the recipient's extension accepted the message. If the recipient is not running, the send fails at once with `RecipientUnreachableError`. There is no mailbox, so a message to a stopped agent is never stored.
- **Mid-run vs idle:** if a message arrives while the agent is mid-turn, it is queued and flushed as a follow-up at the run boundary so it never interrupts active tool work. If the agent is idle, the delivery wakes it for a fresh turn.
- **Sending:** agents use `send_message` with a recipient. Accepted forms are an 8-character agent id from `list_agents`, one of your worker names, the alias `"lead"` for your lead (workers only), or `"all"` to reach every visible agent. A broadcast reports the members it could not reach and still delivers to the rest. Every send sets the required boolean `expectReply`: `true` when the sender needs an answer (a task, a question, a status request), `false` for replies, reports, and acknowledgments.
- **Visibility rules:** a lead sees every lead (including itself) plus the workers it owns; it never sees workers owned by another lead. A worker sees its own lead plus its sibling workers; it never sees another lead. `authorizeSender` (in `src/utils/messaging.ts`) enforces these rules on the receiver side as well, so a sender that addresses an invisible agent gets an error.
- **Message header:** every delivered message includes a `fromLabel` such as `Worker alice in /path` or `Pi Agent in /path`, plus the sender's agent id. It also carries `Reply expected: yes. Answer with send_message(recipient="<id>").` or `Reply expected: no.`, from the message's `expectReply` field (`formatDeliveredMessages` in `extensions/index.ts`).

## Reply obligations (expectReply)

The extension never sends an agent's own text on its behalf. Agents report with `send_message`. A sender that needs an answer sets `expectReply: true`, and the extension reminds the recipient until it answers.

- **Recording:** when a message with `expectReply: true` arrives, `receiveTeamMessage` records an obligation to the sender in the session's `ObligationTracker` (`src/utils/obligations.ts`). A newer request from the same sender replaces the subject and resets the reminder count.
- **Clearing:** any `send_message` from the recipient to that sender clears the obligation, whatever its `expectReply` value. A send that fails with `RecipientUnreachableError` also clears it, because the sender is gone. The `onMessageSent` and `onRecipientUnreachable` hooks on `SharedToolDeps` connect the tool to the tracker.
- **Reminders:** the `agent_before_settle` handler runs at the last point where Pi can still continue a run. For a completed run that can continue, it appends one `custom_message` entry (`customType` `pi-teams-reminder`) that names every waiting sender, and returns `continue: true`. The reminder reaches the model as user text in the same run, so the agent stays Busy and no new settle cycle starts. Each obligation gets at most `MAX_REMINDERS` (3) reminders. Aborted runs, failed runs, and runs that cannot continue get none.
- **Expiry:** at `agent_settled`, every obligation that reached the cap is removed and its sender receives `No reply from <label>`, with fixed text that never quotes the agent. The notice also releases a `pi -p` lead parked in the run hold.
- **Interruption:** when a run is aborted, every waiting sender receives `Interrupted: <label>`. The obligations stay pending, so the next run reminds again.
- **Closing:** `close_myself` sends `Closed: <label>` to every waiting sender before `removeAgent` runs.
- **Loop termination:** a reply sent with `expectReply: false` creates no obligation on the original sender, so a request and its answer end the exchange. Only agents that mark every message as needing an answer can extend it, and the reminder cap bounds each obligation.
- **Notices** are sent with `expectReply: false`, and send errors are ignored because the recipient can be gone.

The pure logic is unit-tested in `src/utils/obligations.test.ts`. The handler wiring and the end-to-end scenarios (silent worker, early reply, two leads, broadcast, run-hold release) are tested in `extensions/expect-reply.test.ts`. `agent_before_settle` arrived in Pi 0.87.0, and `aborted` on `agent_settled` arrived in Pi 1.1.0, so the extension requires Pi 1.1.0 or later.

## Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi exits as soon as the lead's run settles, which would strand spawned workers in their panes. The extension holds the run open instead:

- While this lead has live workers in the registry, the `agent_end` handler parks the run. No LLM activity happens while parked; worker messages arrive through the socket listener and are queued as follow-ups. Sleeping is not involved; the hold happens in the extension, not in bash commands.
- A queued worker message releases the hold and continues the run, waking the lead with the results. A worker's `send_message` report and the `No reply from`, `Interrupted:`, and `Closed:` notices all arrive this way.
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
- An agent that owes a reply is reminded at `agent_before_settle`, and its sender is told at `agent_settled` when the reminders run out (see [Reply obligations](#reply-obligations-expectreply)).

## Team Shutdown

- `close_all_workers` closes every worker spawned by the calling lead.
- `close_worker` (lead) and `close_myself` (worker) close one agent each.
- All three paths run the shared removal in `removeAgent` (`src/utils/teams.ts`).
- `list_agents` shows visible agents with their status and whether each one accepts messages.

## Logs

- **`.pi/tool.log`** (per workspace): no longer written here. The `edit`/`write` audit trail moved to the separate `pi-journal` extension.
- **Agent records** under `~/.pi/agent/pi-teams/agents/<id>.json`: one JSON file per registered agent. Written by `src/utils/registry.ts` and read by every tool that needs to resolve or list agents. Set `PI_TEAMS_REGISTRY_DIR` to relocate the registry root (the test suite uses it for isolation).
- **Sockets** under `~/.pi/agent/pi-teams/s/`: one `<id>.sock` per listening agent, mode 0600 inside a 0700 directory. Written by `src/utils/transport.ts`.
- **Trim on load:** `readAgentRecords` loads the records, checks that each record's `cwd` still exists, removes every dangling record file, its stale socket, and its `agents.jsonl` history entry, then reloads. Agents whose working directory was deleted disappear from every tool automatically.

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
│   ├── expect-reply.test.ts          # reply obligations: recording, reminders, notices, end-to-end scenarios
│   ├── tool-registration.test.ts     # registration-by-identity contract tests
│   ├── fs-tools.ts                 # hash-guarded read/edit/write overrides
│   ├── bash-hash.ts                # appends file_hash lines for bash-written files
│   ├── lead-tools.ts               # lead-only tool registrations
│   ├── shared-tools.ts             # shared and worker tool registrations
│   └── agents-tools.ts             # list_agents and spawn_team_lead registrations
├── src/
│   ├── adapters/                     # one TerminalAdapter implementation per terminal multiplexer
│   │   ├── terminal-registry.ts      # picks the adapter for the current environment
│   │   ├── tmux-adapter.ts           # plus herdr-, iterm2-, zellij-, wezterm-, orca-adapter.ts
│   │   └── *.test.ts                 # adapter unit tests
│   └── utils/                        # all state mutation and decision logic
│       ├── terminal-adapter.ts       # TerminalAdapter interface that the adapters implement
│       ├── teams.ts                  # shared removeAgent removal path
│       ├── obligations.ts            # ObligationTracker, reminder text, and notices for expectReply
│       ├── transport.ts              # Unix socket listener and acknowledged send
│       ├── messaging.ts            # send and broadcast through the transport
│       ├── paths.ts                  # registry and socket path builders and sanitizeName
│       ├── registry.ts             # agent record I/O, id generation, prune/collapse, liveness
│       ├── filelock.ts              # cross-process lock that serializes agents.jsonl writes
│       ├── pid.ts                   # shared isPidAlive liveness check
│       ├── history.ts               # agents.jsonl lastSeenAt side table: upsert, remove, and the locked sync pass
│       ├── agentFormat.ts          # list_agents line formatting and sort order
│       ├── modelSearch.ts            # model resolution ladder and fuzzy top matches
│       ├── spawn.ts                  # buildWorkerCommand, spawnWorkerProcess, lead spawn helpers
│       ├── hold.ts                   # run-hold decisions for non-interactive lead sessions
│       ├── models.ts                 # AgentKind, AgentStatus, AgentRecord, TeamMessage types
│       ├── visibility.ts           # lead/worker visibility and broadcast rules
│       └── flavoredModels.ts         # orchestrator/worker/swarm lists, legacy migration
├── docs/                             # terminal research and release notes (working notes under docs/notes)
├── test/                             # child suites spawned by the filelock contention test
├── AGENTS.md                         # this file
├── README.md                         # user-facing documentation
└── package.json                      # pi-package manifest: extension entry points
```

## How the parts fit together

- **Load:** every pi session runs `extensions/index.ts`. It picks a terminal adapter (`src/adapters/terminal-registry.ts`), computes `isLead` and `isWorker` from `PI_AGENT_TYPE`, registers tools by identity, and installs lifecycle handlers.
- **Registration:** at `session_start` the extension writes an `AgentRecord` to the per-user registry at `~/.pi/agent/pi-teams/` (`src/utils/registry.ts`) and starts a socket listener through `src/utils/transport.ts`. The registry lives under the home directory, so records, sockets, run state, and the `agents.jsonl` history survive a reboot; `readAgentRecords` trims records whose `cwd` no longer exists on every load. One-shot `pi -p` sessions that were not spawned by pi-teams skip registration when they have no preassigned id and no UI.
- **Spawn:** the lead's spawn tools generate a fresh agent id, build a launch command (`src/utils/spawn.ts`), and launch a child pi process through the adapter. The child loads its own configured extensions; `PI_AGENT_ID`, `PI_LEAD_ID`, `PI_AGENT_NAME`, and `PI_AGENT_TYPE` drive its identity.
- **Delivery:** `src/utils/messaging.ts` sends to a recipient's socket and waits for the acknowledgement. The extension injects the received body as a user message. `spawn_teammate` and `spawn_readonly_worker` wait up to 30 seconds for the worker's socket before they return.
- **Concurrency:** the transport needs no lock because each message is one connection. Registry writes are atomic (temp file + rename), so two sessions never clobber the same record. `agents.jsonl` is shared by every session, so its read-modify-write cycles run under a cross-process lock (`src/utils/filelock.ts`: scratch-file plus atomic `link` acquisition that writes `pid:nonce`, so the lock always carries its owner; a stale steal replaces the lock path atomically with a scratch file and is serialized by an exclusive `<lock>.steal` symlink claim, so the path is never free; a dead holder is stolen immediately, an unreadable pid after 2 seconds, a live holder after a 30-second cap; release unlinks the lock only when the nonce matches; and the bounded wait throws `LockHeldError` after `PI_TEAMS_LOCK_WAIT_TIMEOUT_MS`, default 2 seconds) at `agents.jsonl.lock`. History callers that can skip (`writeAgentRecord`, the `readAgentRecords` trim, `removeAgentRecord`, `pruneAndList`) catch `LockHeldError` and leave the entry for the next list pass to self-heal. One list pass runs a single locked `syncAgentHistory` transaction (`src/utils/history.ts`): it stamps online records, upserts missing entries for online and surviving records so losses self-heal, drops entries whose record no longer exists in the registry (keeping them would orphan them forever, because a cwd with an online record never compacts), collapses cwds whose records are all offline (socket-probed) to one entry keyed to the newest surviving record while preserving each directory's newest `lastSeenAt`, and drops entries whose cwd directory is gone. A pruned record's entry survives the pass that prunes it and either folds into the cwd's keeper through compaction or drops on the next pass. Entries written or started at or after the probed snapshot are never touched: they belong to sessions that registered while the probes ran, and their presence blocks compaction of the whole cwd. The shutdown path (`removeAgent`) deletes a history entry only when no surviving record shares its `(cwd, startedAt)` key.
- **Removal:** every shutdown path (`close_myself`, `close_worker`, `close_all_workers`) runs `removeAgent` (`src/utils/teams.ts`): registry record removal, socket cleanup, pane or window close through the adapter, then SIGKILL by pid.
- **Run hold:** `src/utils/hold.ts` decides when a non-interactive lead's run stays parked, using registry worker counts and pid checks for liveness.
- **State on disk:** agent state lives under `~/.pi/agent/pi-teams/`: `agents/<id>.json` records, `s/<id>.sock` sockets, `state/<id>.json` run state, the `agents.jsonl` history, and its `agents.jsonl.lock` lock file. The directory has mode 0700 and files have mode 0600, so only your user can read or message your agents.

## Peer leads

Independent leads run in other directories. They are not subordinate to each other; they can message each other and spawn workers in their own directories.

- **list_agents** output: one line per agent in the form `Pi Agent in <cwd>: <id>: <status>` for leads, and `Worker <name> in <cwd>: <id>: <status>` for workers. Statuses: `Idling` (alive and settled, no run in progress; socket accepts connections and the run-state file is not fresh-busy), `Busy` (mid-run cycle), `Offline` (pid dead or socket not listening). The calling agent is marked `(you)` and always shown as Idling. Offline leads are collapsed to one record per directory (the newest by `startedAt`), unless an online lead exists in that directory. Lines are ordered with the viewer's workers first, then everyone else by directory proximity to the viewer (`pathDistance` in `src/utils/agentFormat.ts`: one point per directory hop up or down the tree), ties broken by the most recent last-online time. `pruneAndList` stamps `lastSeenAt` in `agents.jsonl` for every agent it finds online, so offline peers sort by when they were actually last online rather than by when they started.
- **spawn_team_lead** starts a fresh lead session in an existing folder. It does not join your team; you cannot close it with `close_worker`, and it runs its own extensions. After it starts, talk to it with `send_message(recipient=<id>)`.
- **Peer replies:** leads answer each other with `send_message`; nothing is sent automatically. A lead that needs an answer sets `expectReply: true`, and the receiving lead is reminded until it replies (see [Reply obligations](#reply-obligations-expectreply)).
