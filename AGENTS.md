# Pi Teams

Pi-teams coordinates multiple pi agents. A team-lead spawns teammates (workers) in terminal panes; independent peer leads run in other directories. Agents exchange JSON messages over Unix domain sockets: a sender writes one message and waits for an acknowledgement; the receiver injects it as a user message and wakes for a new turn. Nothing polls, and no message is stored on disk.

## Entry points

- `extensions/index.ts` — loaded by every pi session. Registers tools by session identity, installs the lifecycle handlers, runs the socket listener, and parks the run hold for non-interactive leads.
- `src/cli.ts` — the `pi-teams` CLI (`@eleqtrizit/pi-teams-cli`), the Claude Code client's entry to the network.
- `claude-mod/` — the Claude Code mod (`hooks/register.ts`, `hooks/lib.ts`, `skills/network`, `tests/`).
- `package.json` — pi-package manifest with the extension entry points.

## Commands

- Full test suite: `npm test`
- One test file: `npx vitest run <path>`
- Build the CLI bundle: `npm run build:cli` (esbuild into `cli/pi-teams.cjs`, which is gitignored)
- Publish the CLI: `scripts/publish-cli.sh`
- Mod tests: `cd claude-mod && command claude plugin test`
- A test that spawns workers must unset `HERDR_ENV`, `HERDR_PANE_ID`, and the other multiplexer variables first: herdr has detection priority and opens a real tab.

## Tools

Registered in `extensions/index.ts` in three identity blocks: lead tools under `isLead` (`PI_AGENT_TYPE` unset or `"lead"`), shared tools for every session, worker tools under `isWorker` (`PI_AGENT_TYPE` `"teammate"` or `"readonly-worker"`, except a worker named `team-lead`).

| Tool                    | Who                    | What it does                                                              | Files                                                                          |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `resolve_model`         | lead                   | Resolve a provider/model name for spawn calls                             | `extensions/lead-tools.ts`                                                     |
| `spawn_teammate`        | lead                   | Spawn a worker in a pane or separate window                               | `src/adapters/*`, `src/utils/spawn.ts`, `src/utils/registry.ts`                |
| `spawn_readonly_worker` | lead                   | Spawn a read-only worker with a restricted tool list                      | same as `spawn_teammate`                                                       |
| `spawn_team_lead`       | lead                   | Spawn a peer lead in a pane or separate window                            | `src/adapters/*`, `src/utils/spawn.ts`                                         |
| `close_all_workers`     | lead                   | Close every worker spawned by this lead                                   | `src/utils/teams.ts` (`removeAgent`)                                           |
| `close_worker`          | lead                   | Close one of your own workers                                             | `src/utils/teams.ts` (`removeAgent`)                                           |
| `get_models`            | lead                   | Show the orchestrator/worker/swarm lists when flavors are set             | `src/utils/flavoredModels.ts`                                                  |
| `send_message`          | shared                 | Deliver a message to one agent, or to all (`all`); required `expectReply` | `src/utils/messaging.ts`, `src/utils/transport.ts`, `src/utils/obligations.ts` |
| `list_agents`           | shared                 | Show visible agents with status and socket availability                   | `src/utils/registry.ts`, `src/utils/agentList.ts`                              |
| `close_myself`          | worker + spawned leads | Terminate the calling agent                                               | `extensions/shared-tools.ts`, `src/utils/teams.ts` (`removeAgent`)             |
| `read`                  | shared                 | Read a file; text results end with `file_hash:`                           | `extensions/fs-tools.ts`                                                       |
| `edit`                  | shared                 | One targeted replacement; takes `fileHash`                                | `extensions/fs-tools.ts`                                                       |
| `write`                 | shared                 | Full-file write; takes `fileHash`                                         | `extensions/fs-tools.ts`                                                       |
| `amend`                 | shared                 | Complete a rejected edit or write with just the missing fields            | `extensions/fs-tools.ts`                                                       |

Regular workers get the shared tools plus `close_myself`. Read-only workers are additionally filtered by pi's `--tools` set at spawn, so they see `read`, `grep`, `find`, `ls`, the messaging tools, and `close_myself` only.

## Flow

- **Load:** identity comes from `PI_AGENT_ID`, `PI_LEAD_ID`, `PI_AGENT_NAME`, and `PI_AGENT_TYPE`.
- **Registration:** at `session_start`, write an `AgentRecord` and start the socket listener (`src/utils/registry.ts`, `src/utils/transport.ts`).
- **Spawn:** `src/utils/spawn.ts` builds the launch command; `src/utils/launch.ts` launches the child through a terminal adapter picked by `src/adapters/terminal-registry.ts`.
- **Delivery:** `src/utils/messaging.ts` sends to the recipient's socket and waits for the acknowledgement; the recipient injects the body as a user message.
- **Removal:** every shutdown path (`close_myself`, `close_worker`, `close_all_workers`) runs `removeAgent` in `src/utils/teams.ts`: record removal, socket cleanup, pane or window close, then SIGKILL by pid.
- **Run hold:** `src/utils/hold.ts` decides when a non-interactive lead's run stays parked.

## State on disk

Under `~/.pi/agent/pi-teams/` (mode 0700, files 0600; set `PI_TEAMS_REGISTRY_DIR` to relocate the root, which the test suite uses for isolation):

- `agents/<id>.json` — one record per registered agent (`src/utils/registry.ts`)
- `s/<id>.sock` — one socket per listening agent (`src/utils/transport.ts`)
- `state/<id>.json` — run state (`src/utils/runstate.ts`)
- `version.txt` — the extension version the CLI checks (`src/utils/version.ts`)
- `agents.jsonl` — lastSeenAt history (`src/utils/history.ts`), guarded by `agents.jsonl.flock` (`src/utils/filelock.ts`)

## File hierarchy

```
pi-teams/
├── extensions/                       # pi extension entry and lifecycle handlers
│   ├── index.ts                      # tool registration (one lead block, shared, worker), socket listener, hold
│   ├── index.test.ts                 # tests for pure helpers: formatting and queueing
│   ├── close-myself.test.ts          # close_myself registration and execute tests
│   ├── expect-reply.test.ts          # reply obligations: recording, reminders, notices, end-to-end scenarios
│   ├── lead-prompt.test.ts           # injected prompts for leads, workers, and the spawn guidance
│   ├── tool-registration.test.ts     # registration-by-identity contract tests
│   ├── fs-tools.ts                   # hash-guarded read/edit/write overrides
│   ├── bash-hash.ts                  # appends file_hash lines for bash-written files
│   ├── lead-tools.ts                 # lead-only tool registrations
│   ├── fork-session.ts               # forks the lead's session into a worker session file (fork_context)
│   ├── shared-tools.ts               # shared and worker tool registrations
│   └── agents-tools.ts               # list_agents and spawn_team_lead registrations
├── cli/                              # npm package @eleqtrizit/pi-teams-cli (package.json, README; pi-teams.cjs is built)
├── claude-mod/                       # Claude Code mod: hooks/register.ts, hooks/lib.ts, skills/network, tests/
├── scripts/                          # build-cli.mjs, publish-cli.sh
├── src/
│   ├── cli.ts                        # the pi-teams command
│   ├── cli.test.ts                   # CLI tests, including the built binary
│   ├── adapters/                     # one TerminalAdapter implementation per terminal multiplexer
│   │   ├── terminal-registry.ts      # picks the adapter for the current environment
│   │   ├── tmux-adapter.ts           # plus herdr-core-, herdr-, iterm2-, zellij-, wezterm-, orca-adapter.ts
│   │   └── *.test.ts                 # adapter unit tests
│   └── utils/                        # all state mutation and decision logic
│       ├── terminal-adapter.ts       # TerminalAdapter interface that the adapters implement
│       ├── launch.ts                 # launchWorker and launchLead, shared by the extension and the CLI
│       ├── agentList.ts              # listVisibleAgents, shared by list_agents and the CLI
│       ├── version.ts                # package version and the version.txt check
│       ├── teams.ts                  # shared removeAgent removal path
│       ├── obligations.ts            # ObligationTracker, reminder text, and notices for expectReply
│       ├── transport.ts              # Unix socket listener and acknowledged send
│       ├── messaging.ts              # send and broadcast through the transport
│       ├── paths.ts                  # registry and socket path builders and sanitizeName
│       ├── registry.ts               # agent record I/O, id generation, prune/collapse, liveness
│       ├── filelock.ts               # cross-process lock that serializes agents.jsonl writes
│       ├── pid.ts                    # shared isPidAlive liveness check
│       ├── history.ts                # agents.jsonl lastSeenAt side table: upsert, remove, and the locked sync pass
│       ├── agentFormat.ts            # list_agents line formatting and sort order
│       ├── modelSearch.ts            # model resolution ladder and fuzzy top matches
│       ├── spawn.ts                  # buildWorkerCommand, spawnWorkerProcess, lead spawn helpers
│       ├── hold.ts                   # run-hold decisions for non-interactive lead sessions
│       ├── models.ts                 # AgentKind, AgentStatus, AgentRecord, TeamMessage types
│       ├── visibility.ts             # lead/worker visibility and broadcast rules
│       └── flavoredModels.ts         # orchestrator/worker/swarm lists, legacy migration
├── docs/                             # terminal research and release notes (working notes under docs/notes)
├── test/                             # child suites spawned by the filelock contention test
├── AGENTS.md                         # this file: file map and entry points
├── DECISIONS.md                      # design decisions and rationale
├── README.md                         # user-facing documentation
└── package.json                      # pi-package manifest: extension entry points
```

## Decisions

Design decisions and their rationale live in [DECISIONS.md](DECISIONS.md). Whenever you add or change a design decision, update DECISIONS.md. Keep this file limited to the file map and entry points.
