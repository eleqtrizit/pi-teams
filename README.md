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
Broadcast a message to the entire team about the API endpoint change.
```

```
Read the inbox of security-bot.
```

## Core Tools

### Team Management

- **`team_create`** - Create new agent team with custom name, description, default model, and window mode
- **`team_shutdown`** - Shutdown entire team and close all panes/windows
- **`list_teammates`** - List all teammates with their status (alive, active, unread count)

### Agent Spawning

- **`spawn_teammate`** - Launch agent in terminal pane or separate OS window
  - Supports custom model and thinking level (off/minimal/low/medium/high)
  - Can spawn in separate windows for better isolation
- **`spawn_readonly_worker`** - Launch a read-only worker restricted to `read`, `grep`, `find`, `ls`
  - No `bash`, `write`, or `edit` access — safe for code review, auditing, exploration
  - Uses the team leader's model automatically
  - Lighter than `spawn_teammate`; no model or thinking parameters needed
- **`spawn_lead_window`** - Open team lead in a separate OS window
- **`process_shutdown_approved`** - Gracefully shut down individual teammate

### Messaging System

- **`send_message`** - Send direct message to specific teammate
- **`broadcast_message`** - Broadcast message to all team members (with optional color)
- **`read_inbox`** - Read messages from an agent's inbox (unread-only or all)

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
- Agents communicate autonomously via file-based inbox system
- Direct messaging between specific teammates
- Broadcasting to all team members with optional colors
- Unread message tracking and notifications

### 🔔 Automated Reminders
- System prompts idle agents to report back to team-lead
- Smart reminder logic based on instruction timestamps (not wake cycles)
- One-time reminders per instruction cycle to avoid spam

### 🖥️ Terminal Integration
- **tmux** - Pane-based spawning with `tmux split-window`
- **Zellij** - Pane-based spawning with `zellij run`
- **iTerm2** - macOS native with AppleScript window/pane management
- **WezTerm** - Cross-platform with CLI-based pane and window management

### 🔒 Lock System
- Thread-safe operations with file-based locking
- Automatic stale lock cleanup (60s timeout)
- Race condition protection for multi-agent operations

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

| Terminal | Detection | Pane Management | Window Support |
|----------|-----------|-----------------|----------------|
| **tmux** | `TMUX` env var | `tmux split-window` | ❌ |
| **Zellij** | `ZELLIJ` env var | `zellij run` | ❌ |
| **iTerm2** | `TERM_PROGRAM=iTerm.app` | AppleScript splits | ✅ |
| **WezTerm** | `WEZTERM_PANE` env var | `wezterm cli split-pane` | ✅ |

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

### Idle Polling

Teammates automatically check for new messages every **1 second** when idle, ensuring responsiveness without manual intervention.

### Reminder System

If a teammate completes work without reporting back to the team-lead, the system automatically sends a one-time reminder:

> "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

**Smart Logic**: The reminder system uses instruction-based timestamps to avoid false positives from incidental wake cycles. A reminder is only sent if:
1. Inbox contains team-lead instructions
2. All instructions have been read
3. Agent hasn't sent a message since the latest instruction
4. No reminder has been sent for this instruction cycle

### Context Injection

Each teammate receives a custom system prompt including:
- Their role and instructions
- Team context (team name, member list)
- Available tools
- Model and thinking level information
- Team environment guidelines

## Data Storage

All team data is stored in `~/.pi/`:

```
~/.pi/
├── teams/
│   └── <team-name>/
│       ├── config.json          # Team configuration
│       ├── <agent-name>.pid     # Process ID files
│       ├── <agent-name>.active  # Activity timestamps
│       └── tasks/               # Task storage (if using pi-tasks)
└── messages/
    └── <team-name>/
        ├── <agent-name>.json    # Message inboxes
        ├── <agent-name>.last-message  # Last sent message timestamp
        ├── <agent-name>.last-awoken   # Last activation timestamp
        └── <agent-name>.last-reminder # Last reminder timestamp
```

## Security

- **Lock files** prevent concurrent modifications with automatic stale lock cleanup (60s timeout)
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
│       ├── messaging.ts             # Inbox/messaging system
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

See `WEZTERM_SUPPORT.md` for an example implementation.

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
