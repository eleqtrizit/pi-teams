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

Use simple phrasing in the chat window to make teams and workers:

```
Create a team called my-team.
```

```
Create a team called research-team with model gpt-4o.
```

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


## Core Tools

Tool registration follows each session's identity: sessions spawned with `PI_AGENT_TYPE` `teammate` or `readonly-worker` are workers, and every other session, including a lead window, is the team-lead. Worker tools contain only `close_myself`; messaging and status tools are shared; the rest are lead-only.

### Team Management

- **`team_create`** - Create new agent team with custom name, description, default model, and window mode
- **`team_shutdown`** - Shutdown entire team and close all panes/windows
- **`list_teammates`** - List all teammates with their status (alive, active, listening)
- **`close_myself`** - Let an agent close itself
  - Removes the agent from the team config, cleans up its pid and activity markers, and terminates its own process and terminal pane or window
  - Available to teammates only; the lead closes the whole team with `team_shutdown`
  - Do not run this unless your instructions told you to run it

### Agent Spawning

- **`spawn_teammate`** - Launch agent in terminal pane or separate OS window
  - Supports custom model and thinking level (off/minimal/low/medium/high)
  - Can spawn in separate windows for better isolation
  - Follows flavored-model guidance (see Flavored Models below)
- **`spawn_readonly_worker`** - Launch a read-only worker restricted to `read`, `grep`, `find`, `ls`
  - No `bash`, `write`, or `edit` access — safe for code review, auditing, exploration
  - Can still message the team lead via `send_message`
  - Accepts an optional `model` parameter; defaults to the `swarm` list, then the `worker` list, then the team leader's model
- **`spawn_lead_window`** - Open team lead in a separate OS window
- **`close_worker`** - Close one teammate: remove it from the team config, clean up its state, and terminate its process and pane

### Model Categorization

- **`get_models`** - Read enabled models from pi settings.json, split into OSS and frontier (GPT/Claude) lists
- **`get_flavored_models`** - Read the orchestrator, worker, and swarm model lists from pi settings.json
- **`/flavored-models`** - Interactive command to assign each enabled model to a flavor

### Messaging System

- **`send_message`** - Send a message to one teammate. Use the recipient `all` to reach every other team member
  - The message arrives immediately as a user message
  - The tool fails at once when the recipient is not running

### Model Resolution

- **`resolve_model`** - Find correct provider/model name for spawn_teammate
  - Smart fuzzy matching with Levenshtein distance
  - Provider priority (OAuth/subscription first, then API-key providers)
  - Supports partial names like "haiku", "claude-3.5", "qwen3-coder"
  - Returns top 5 matches if exact resolution fails

## Features

### 🏢 Team Management

- Create teams with custom names, descriptions, and default AI models
- Configure separate OS windows vs terminal panes for teammates
- Persistent team configuration stored locally

### 🤖 Agent Spawning

- Launch specialized teammates with different models and thinking levels
- Support for separate OS windows (iTerm2, WezTerm) or terminal panes (tmux, Zellij)
- Automatic model resolution with fuzzy matching

### 💬 Inter-Agent Messaging

- Agents communicate autonomously over local Unix domain sockets
- Direct messaging between specific teammates
- Broadcasting to all team members with the recipient `all`
- Immediate delivery with an acknowledgement, and an instant error when the recipient is not running

### 🔔 Automatic Reports

- When a teammate finishes, its final reply goes to the team-lead automatically
- A teammate that already messaged the team-lead during the run sends no duplicate
- An interrupted run sends the team-lead an interruption notice
- A teammate that closes itself with `close_myself` sends its last replies to the team-lead first

### 🖥️ Terminal Integration

- **tmux** - Pane-based spawning with `tmux split-window`
- **Zellij** - Pane-based spawning with `zellij run`
- **iTerm2** - macOS native with AppleScript window/pane management
- **WezTerm** - Cross-platform with CLI-based pane and window management

### 🔒 Lock System

- Thread-safe operations with file-based locking
- Automatic stale lock cleanup (30s timeout)
- Race condition protection for multi-agent operations

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
  - **tmux/Zellij**: Pane titles within session

## Terminal Integration Details

pi-teams automatically detects and integrates with your terminal environment:

| Terminal    | Detection                | Pane Management          | Window Support |
| ----------- | ------------------------ | ------------------------ | -------------- |
| **tmux**    | `TMUX` env var           | `tmux split-window`      | ❌             |
| **Zellij**  | `ZELLIJ` env var         | `zellij run`             | ❌             |
| **iTerm2**  | `TERM_PROGRAM=iTerm.app` | AppleScript splits       | ✅             |
| **WezTerm** | `WEZTERM_PANE` env var   | `wezterm cli split-pane` | ✅             |

### Detection Priority Order

1. **tmux** - if `TMUX` env is set
2. **Zellij** - if `ZELLIJ` env is set and not in tmux
3. **iTerm2** - if `TERM_PROGRAM=iTerm.app` and not in tmux/zellij
4. **WezTerm** - if `WEZTERM_PANE` env is set and not in tmux/zellij

### WezTerm Auto-Layout

- First pane: splits left (30% width)
- Subsequent panes: split bottom (50% height)
- Cross-platform support (macOS, Linux, Windows)

## Automated Behavior

### Message Delivery

Each agent listens on a socket. A message reaches the recipient as soon as the sender writes it, and a recipient that is idle wakes for a new turn. A recipient that is mid-run receives the message at the end of its current run.

### Automatic Reports

When a teammate's run settles (Pi has no retries, compaction, or queued work left), the extension sends the teammate's full final replies to the team-lead with the subject `Report from <agent>`. When a message starts a second run before the first run's report is sent, the report numbers each reply. Requires Pi 1.1.0 or later.

- If the teammate sent a message to `team-lead` during the run, no automatic report is sent.
- If the run was aborted, the team-lead receives an interruption notice instead, with the replies attached when any exist.
- If the run produced no text, the team-lead receives a note that the run finished without a text reply.

### Context Injection

Each teammate receives a custom system prompt including:

- Their role and instructions
- Team context (team name, member list)
- Available tools
- Model and thinking level information
- Team environment guidelines

### Non-Interactive Sessions (Run Hold)

When the team-lead runs with `pi -p` (or `--mode json`), pi normally exits as soon as the lead's run settles, leaving spawned workers stranded. The extension holds the run open while the team is active:

1. The lead spawns workers and ends its turn. The `agent_end` handler parks the run with no LLM activity.
2. Worker messages arrive through the socket listener and are queued as follow-ups.
3. A queued message releases the hold and continues the run, waking the lead with the results.
4. When every worker has reported back, the lead calls `team_shutdown` and the session exits normally.

Spawned workers start as plain pi sessions and load their own configured extensions, such as pi-teams and pi-sandbox. The spawn command passes no extension flags, because `-ne` would drop every configured extension. Configure pi-teams once, as a settings package or a project package, so a worker does not discover two copies. The hold releases when the team directory is removed, when the team has no workers, when no worker has been alive for three consecutive liveness checks, or when a follow-up is queued. Liveness uses the worker's pid file as the primary signal with pane probes as fallbacks. Decision logic lives in `src/utils/hold.ts`.

## Data Storage

All team data is stored in `~/.pi/`:

```
~/.pi/
├── teams/
│   └── <team-name>/
│       ├── config.json          # Team configuration
│       ├── <agent-name>.pid     # Process ID files
│       └── <agent-name>.active  # Activity timestamps
└── tasks/
    └── <team-name>/             # Task storage (if using pi-tasks)
```

Message sockets live outside `~/.pi/`, in `$TMPDIR/pi-teams-<uid>/`, because Unix socket paths have a short length limit. The directory has mode 0700 and each socket has mode 0600, so only your user can send messages to your agents. Messages are not stored on disk. If the recipient is not running, the sender gets an error.

## Security

- **Lock files** prevent concurrent modifications with automatic stale lock cleanup (30s timeout)
- **Race condition protection** for multi-agent operations
- **Input validation** on all task and message data
- **File-based isolation** between teams
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
   - Nothing spawns from the `swarm` list except read-only workers.
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
- **Terminal emulator**: tmux, Zellij, iTerm2, or WezTerm

## Development

### Project Structure

```
pi-teams/
├── extensions/
│   └── index.ts              # Main extension entry point
├── src/
│   ├── adapters/
│   │   ├── terminal-adapter.ts      # Interface definition
│   │   ├── terminal-registry.ts     # Adapter detection/registry
│   │   ├── tmux-adapter.ts          # tmux implementation
│   │   ├── zellij-adapter.ts        # Zellij implementation
│   │   ├── iterm2-adapter.ts        # iTerm2 implementation
│   │   └── wezterm-adapter.ts       # WezTerm implementation
│   └── utils/
│       ├── teams.ts                 # Team management
│       ├── transport.ts             # Unix socket listener and acknowledged send
│       ├── messaging.ts             # Send and broadcast
│       ├── lock.ts                  # File-based locking
│       ├── paths.ts                 # Path utilities
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
