# pi-teams

**Multi-agent collaboration for the pi coding agent.**

> **Note:** This repository is a fork of [burggraf/pi-teams](https://github.com/burggraf/pi-teams). Many credits to him!

Orchestrate teams of AI agents that work together on complex coding tasks. pi-teams enables you to spawn specialized agents, coordinate communication, and automate workflows with hooks.

![pi-teams in action](https://raw.githubusercontent.com/eleqtrizit/pi-teams/main/pi-team-in-action.png)

## Quickstart

```bash
pi install https://github.com/eleqtrizit/pi-teams
```

Goes well with Pi-Tasks:

```bash
pi install https://github.com/eleqtrizit/pi-tasks
```

## Quick Start

Use simple phrasing in the chat window to spawn workers and communicate:

```
Spawn a teammate called security-bot to review the codebase.
```

```
Spawn a teammate called architect with model gpt-4o and thinking level high.
```

```
Send a message to security-bot to focus on the auth module.
```

```
Tell the entire team about the API endpoint change.
```

```
List agents to see who is online.
```

```
Spawn a team lead in /home/user/other-project to get help there.
```


## Core Tools

Tool registration follows each session's identity: sessions spawned with `PI_AGENT_TYPE` `teammate` or `readonly-worker` are workers, and every other session, including a lead window, is the team-lead. Worker tools contain only `close_myself`; messaging and status tools are shared; the rest are lead-only.

### Team Management

- **`list_agents`** - List all visible agents with their 8-char id and status (Online/Offline)
- **`close_myself`** - Let an agent close itself
  - Removes the agent's registry record, cleans up its socket, and terminates its own process and terminal pane or window
  - Available to teammates only; the lead closes workers with `close_worker` or `close_all_workers`
  - Do not run this unless your instructions told you to run it

### Agent Spawning

- **`spawn_teammate`** - Launch agent in terminal pane or separate OS window
  - Supports custom model and thinking level (off/minimal/low/medium/high)
  - Can spawn in separate windows for better isolation
  - Follows flavored-model guidance (see Flavored Models below)
- **`spawn_readonly_worker`** - Launch a read-only worker restricted to `read`, `grep`, `find`, `ls`
  - No `bash`, `write`, or `edit` access: safe for code review, auditing, exploration
  - Can still message the team lead via `send_message`
  - Accepts an optional `model` parameter; defaults to the `swarm` list, then the `worker` list, then the team leader's model
- **`spawn_team_lead`** - Spawn a peer lead in another directory
  - The new lead is independent: it does not join your team, you cannot close it with `close_worker`, and it runs its own extensions
  - After it starts, talk to it with `send_message(recipient=<id>)`
- **`close_worker`** - Close one of your own workers by its 8-character agent id or worker name
- **`close_all_workers`** - Close every worker you spawned at once

### Model Categorization

- **`get_models`** - Read enabled models from pi settings.json, split into OSS and frontier (GPT/Claude) lists
- **`get_flavored_models`** - Read the orchestrator, worker, and swarm model lists from pi settings.json
- **`/flavored-models`** - Interactive command to assign each enabled model to a flavor

### Messaging System

- **`send_message`** - Send a message to one agent. Use the recipient `all` to reach every visible agent
  - Accepted recipients: an 8-char agent id from `list_agents`, one of your worker names, the alias `lead` (workers only), or `all`
  - The message arrives immediately as a user message
  - The tool fails at once when the recipient is not running
  - The required `expectReply` flag says whether you need an answer: `true` for tasks, questions, and status requests; `false` for replies, reports, and acknowledgments

### Model Resolution

- **`resolve_model`** - Find correct provider/model name for spawn_teammate
  - Smart fuzzy matching with Levenshtein distance
  - Provider priority (OAuth/subscription first, then API-key providers)
  - Supports partial names like "haiku", "claude-3.5", "qwen3-coder"
  - Returns top 5 matches if exact resolution fails

## Features

### 🤖 Agent Spawning

- Launch specialized teammates with different models and thinking levels
- Support for separate OS windows (iTerm2, WezTerm), one herdr tab per agent, or terminal panes (tmux, Zellij)
- Automatic model resolution with fuzzy matching
- Spawn peer leads in other directories for cross-project collaboration

### 💬 Inter-Agent Messaging

- Agents communicate autonomously over local Unix domain sockets
- Direct messaging between specific agents by id or name
- Broadcasting to all visible agents with the recipient `all`
- Immediate delivery with an acknowledgement, and an instant error when the recipient is not running
- Visibility rules keep leads from seeing other leads' workers

### 🔔 Reply Reminders

- Agents report with `send_message`; the extension never sends an agent's own text for it
- A message sent with `expectReply: true` makes the recipient owe the sender a reply
- An agent that owes a reply is reminded before its run ends, up to 3 times
- When the reminders run out, the waiting sender receives a `No reply from` notice
- An interrupted run or a `close_myself` call tells every waiting sender

### 🖥️ Terminal Integration

- **herdr** - Every agent opens in its own tab with `herdr tab create`
- **Orca** - Every agent opens in its own worktree tab with `orca terminal create`
- **tmux** - Pane-based spawning with `tmux split-window`
- **Zellij** - Pane-based spawning with `zellij run`
- **iTerm2** - macOS native with AppleScript window/pane management
- **WezTerm** - Cross-platform with CLI-based pane and window management

### 🍦 Flavored Models

- Categorize your enabled models into flavors: `orchestrator` (orchestrating, planning, coordinating), `worker` (coding), `swarm` (read-only information gathering)
- Configured in `~/.pi/agent/settings.json` via `enabledModelsOrchestrator`, `enabledModelsWorker`, and `enabledModelsSwarm`
- `/flavored-models` opens an interactive settings UI (team-lead sessions only)
- Spawn tools follow flavor guidance: match the flavor to the task, spread teammates across providers, and fall back to the team lead's model when no matching models are set
- Older settings migrate automatically (see Migrating from high, med, and fast)

### 📊 Model Resolution

- Smart provider selection with priority-based matching
- Fuzzy search with Levenshtein distance for typo tolerance
- Provider priority: OAuth/subscription providers first (cheaper), then API-key providers
- Composite-aware token matching (e.g., "qwen35b" matches "qwen3-coder-35b")

### 🎨 Window Title Support

- Automatic window/pane titles: `{teamName}: {agentName}`
- Terminal-specific implementations:
  - **iTerm2**: Escape sequences via AppleScript
  - **WezTerm**: CLI `set-window-title` command
  - **herdr**: `herdr tab rename` on the session's own tab
  - **tmux/Zellij**: Pane titles within session

## Terminal Integration Details

pi-teams automatically detects and integrates with your terminal environment:

| Terminal    | Detection                | Pane Management          | Window Support |
| ----------- | ------------------------ | ------------------------ | -------------- |
| **herdr**   | `HERDR_ENV=1` and `HERDR_PANE_ID` | `herdr tab create` | ✅ (tabs) |
| **Orca**    | `TERM_PROGRAM=Orca`      | `orca terminal create`   | ✅             |
| **tmux**    | `TMUX` env var           | `tmux split-window`      | ❌             |
| **Zellij**  | `ZELLIJ` env var         | `zellij run`             | ❌             |
| **iTerm2**  | `TERM_PROGRAM=iTerm.app` | AppleScript splits       | ✅             |
| **WezTerm** | `WEZTERM_PANE` env var   | `wezterm cli split-pane` | ✅             |

### Detection Priority Order

1. **herdr** - if `HERDR_ENV=1` and `HERDR_PANE_ID` are set; herdr wins because it is the innermost multiplexer
2. **Orca** - if `TERM_PROGRAM=Orca`
3. **tmux** - if `TMUX` env is set
4. **Zellij** - if `ZELLIJ` env is set and not in tmux
5. **iTerm2** - if `TERM_PROGRAM=iTerm.app` and not in tmux/zellij
6. **WezTerm** - if `WEZTERM_PANE` env is set and not in tmux/zellij

### herdr Layout

- Every spawned agent, including read-only workers, opens in a new tab in the lead's workspace
- The tab label is the agent name; `separate_window` has no extra effect in herdr
- Each tab runs `exec pi ...`, so the tab closes when pi exits

### WezTerm Auto-Layout

- First pane: splits left (30% width)
- Subsequent panes: split bottom (50% height)
- Cross-platform support (macOS, Linux, Windows)

## Automated Behavior

### Message Delivery

Each agent listens on a socket keyed by its 8-character agent id. A message reaches the recipient as soon as the sender writes it, and a recipient that is idle wakes for a new turn. A recipient that is mid-run receives the message at the end of its current run.

A lead sees every lead (including itself) plus its own workers; it never sees workers owned by another lead. A worker sees its own lead plus its sibling workers; it never sees another lead. These visibility rules are enforced on both the sender and the receiver.

### Reply Reminders

Every `send_message` call sets the required `expectReply` flag. The recipient sees `Reply expected: yes` or `Reply expected: no` in the message header. Requires Pi 1.1.0 or later.

- When a message with `expectReply: true` arrives, the recipient owes the sender a reply. Any message from the recipient back to that sender clears it.
- Before the recipient's run ends, the extension adds a reminder that names every waiting sender, and the run continues so the agent can answer. Each owed reply gets at most 3 reminders.
- When the reminders run out, the waiting sender receives `No reply from <label>`.
- When the run is aborted, the waiting sender receives `Interrupted: <label>`, and the reminders continue on the next run.
- When the agent calls `close_myself`, every waiting sender receives `Closed: <label>`.

A reply sent with `expectReply: false` creates no new obligation, so a request and its answer end the exchange between two agents.

### Context Injection

Each teammate receives a custom system prompt including:

- Their role and instructions
- Available tools
- Model and thinking level information
- Team environment guidelines

Leads receive peer-lead collaboration guidance on every turn: instructions to run `list_agents`, spawn peer leads with `spawn_team_lead`, and message them by id.

### Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi normally exits as soon as the lead's run settles, leaving spawned workers stranded. The extension holds the run open while the lead's workers are active:

1. The lead spawns workers and ends its turn. The `agent_end` handler parks the run with no LLM activity.
2. Worker messages arrive through the socket listener and are queued as follow-ups.
3. A queued message releases the hold and continues the run, waking the lead with the results.
4. When every worker has reported back, the lead calls `close_all_workers` and the session exits normally.

Spawned workers start as plain pi sessions and load their own configured extensions, such as pi-teams and pi-sandbox. The spawn command passes no extension flags, because `-ne` would drop every configured extension. Configure pi-teams once, as a settings package or a project package, so a worker does not discover two copies. The hold releases when the lead has no workers, when no worker has been alive for three consecutive liveness checks, or when a follow-up is queued. Liveness uses the worker's pid file as the primary signal with pane probes as fallbacks. Decision logic lives in `src/utils/hold.ts`.

## Data Storage

All agent data is stored in the per-user registry under your home directory, so it survives a reboot:

```
~/.pi/agent/pi-teams/
├── agents/
│   └── <id>.json            # Agent registry record
├── state/
│   └── <id>.json            # Busy/available run state
├── agents.jsonl             # lastSeenAt side table, one entry per registered record
├── agents.jsonl.flock       # Permanent lock inode guarding agents.jsonl mutations
└── s/
    └── <id>.sock            # Unix domain socket for messaging
```

The directory has mode 0700 and each socket has mode 0600, so only your user can send messages to your agents. Messages are not stored on disk. If the recipient is not running, the sender gets an error.

Every load of the registry trims agents whose working directory no longer exists: the record file, stale socket, and history entry are removed. Set `PI_TEAMS_REGISTRY_DIR` to relocate the registry root.

## Security

- **File-based isolation** between agents through private directory permissions
- **Input validation** on all task and message data
- **Environment variable filtering** (only `PI_*` prefixed vars passed to teammates)

## Model Resolution Details

The `resolve_model` tool provides intelligent model name resolution:

### Search Strategies

1. **Exact match** - Case-insensitive exact model name match
2. **Token match** - Partial matching with tokenization
3. **Fuzzy match** - Levenshtein distance for typo tolerance
4. **Composite match** - Handles composite names like "qwen35b" → "qwen3-coder-35b"

### Provider Priority

Models are ranked by provider cost-effectiveness:

1. Google Gemini CLI (OAuth, free tier)
2. GitHub Copilot (subscription)
3. Kimi (subscription)
4. Anthropic, OpenAI, Google, etc. (API key)
5. Other providers (Azure, Bedrock, Mistral, Groq, etc.)

### Example Usage

```
resolve_model(model_name="haiku")
# Returns: "anthropic/claude-3-haiku-20240307"

resolve_model(model_name="qwen3-coder")
# Returns: "qwen/qwen3-coder-480b" (or best match)

resolve_model(model_name="claude-3.5")
# Returns: "anthropic/claude-3.5-sonnet"
```

### Flavored Model Selection

When flavor lists are configured, the team lead uses them to choose models
when spawning teammates:

1. Before spawning, the lead calls `get_flavored_models` to read the lists
2. It picks a model whose flavor matches the task:
   - `spawn_teammate` uses the `worker` list. It uses the `orchestrator` list
     only for a teammate that plans or coordinates other work.
   - `spawn_readonly_worker` uses the `swarm` list, then the `worker` list.
     Nothing spawns from the `swarm` list except read-only workers.
3. It prefers spreading teammates across different providers unless the user
   names specific models
4. If no matching models are configured, it spawns the same model as the team
   lead

```json
// ~/.pi/agent/settings.json
{
  "enabledModels": [
    "anthropic/claude-opus-4",
    "anthropic/claude-3.5-haiku",
    "google/gemini-2.5-flash"
  ],
  "enabledModelsOrchestrator": ["anthropic/claude-opus-4"],
  "enabledModelsWorker": ["google/gemini-2.5-flash"],
  "enabledModelsSwarm": ["anthropic/claude-3.5-haiku"]
}
```

Run `/flavored-models` in a team-lead session to edit these lists interactively.

### Migrating from high, med, and fast

Earlier versions used the `enabledModelsHigh`, `enabledModelsMed`, and
`enabledModelsFast` keys. When a team-lead session starts and finds any of them,
it migrates the settings once:

| Old list | New list       |
| -------- | -------------- |
| `high`   | `orchestrator` |
| `med`    | `worker`       |
| `fast`   | `worker`       |

- The migration appends to existing lists, removes duplicates, deletes the old
  keys, and writes `settings.json` atomically.
- The session shows a warning that names the moved models. The next
  `get_flavored_models` call repeats the warning for the model.
- No models move to `swarm`. Assign them with `/flavored-models`.
- Review your prompts and skills that mention high, med, or fast models, and
  update them.

## Requirements

- **pi coding agent** (https://github.com/mariozechner/pi-coding-agent)
- **Node.js** (for extension runtime)
- **Terminal emulator**: herdr, tmux, Zellij, iTerm2, WezTerm, or Orca

The cross-process lock uses `fs-native-extensions`, a prebuilt N-API module
that needs no compiler at install time and survives Node major-version
upgrades. pi-teams supports macOS and glibc Linux on arm64 and x64.
fs-native-extensions ships prebuilds for other platforms; pi-teams does not
test or support them there. When the module cannot load, or when the
filesystem rejects advisory locking (an NFS mount without lockd, an SMB or
FUSE mount), pi-teams runs degraded: team features work, `lastSeenAt` history
recording is skipped, and one warning on the first history-lock use of the
session names the limitation.

**Upgrading pi-teams across the lock-protocol boundary requires stopping
every pi session before starting any new one.** Sessions running the old
link-based lock and sessions running the new advisory lock do not exclude
each other, so a mixed-version window can lose `agents.jsonl` writes. The
leftover `agents.jsonl.lock` file from the old scheme is inert under the new
one and safe to delete by hand once every session has stopped; it is never
removed automatically.

## Development

### Project Structure

```
pi-teams/
├── extensions/
│   ├── index.ts              # Main extension entry point
│   ├── lead-tools.ts         # Lead-only tool registrations
│   ├── shared-tools.ts       # Shared and worker tool registrations
│   └── agents-tools.ts       # list_agents and spawn_team_lead registrations
├── src/
│   ├── adapters/
│   │   ├── terminal-adapter.ts      # Interface definition
│   │   ├── terminal-registry.ts     # Adapter detection/registry
│   │   ├── tmux-adapter.ts          # tmux implementation
│   │   ├── zellij-adapter.ts        # Zellij implementation
│   │   ├── iterm2-adapter.ts        # iTerm2 implementation
│   │   ├── herdr-adapter.ts         # herdr implementation
│   │   ├── orca-adapter.ts          # Orca implementation
│   │   └── wezterm-adapter.ts       # WezTerm implementation
│   └── utils/
│       ├── teams.ts                 # Shared removal path
│       ├── transport.ts             # Unix socket listener and acknowledged send
│       ├── messaging.ts             # Send and broadcast
│       ├── obligations.ts           # Reply obligations, reminders, and notices for expectReply
│       ├── paths.ts                 # Registry and socket path utilities
│       ├── registry.ts            # Agent record I/O and liveness
│       ├── visibility.ts          # Lead/worker visibility rules
│       └── models.ts                # TypeScript type definitions
├── docs/                          # Research and planning docs
└── tests/                         # Test files
```

### Running Tests

```bash
npm test
```

### Adding New Terminal Support

The modular adapter design makes it easy to add new terminal support:

1. Implement `TerminalAdapter` interface (`detect`, `spawn`, `kill`, `isAlive`, `setTitle`)
2. Add adapter to `terminal-registry.ts`
3. Write tests
4. Update documentation

See `docs/notes/WEZTERM_SUPPORT.md` for an example implementation.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - See [LICENSE](LICENSE) for details.

## Credits

Ported from [claude-code-teams-mcp](https://github.com/burggraf/claude-code-teams-mcp) for the pi coding agent ecosystem.

---

Built for the [pi coding agent](https://github.com/mariozechner/pi-coding-agent).
