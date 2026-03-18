# pi-teams

**Multi-agent collaboration for the pi coding agent.**

> **Note:** This repository is a fork of [burggraf/pi-teams](https://github.com/burggraf/pi-teams).

Orchestrate teams of AI agents that work together on complex coding tasks. pi-teams enables you to spawn specialized agents, coordinate communication, and automate workflows with hooks.

## Quickstart

```bash
pi install https://github.com/eleqtrizit/pi-teams
```

Goes well with Pi-Tasks:

https://github.com/eleqtrizit/pi-tasks

```bash
pi install https://github.com/eleqtrizit/pi-tasks
```

![pi-teams in action](https://raw.githubusercontent.com/burggraf/pi-teams/main/pi-team-in-action.png)

## Features

- **🏢 Team Management**: Create teams with custom names, descriptions, and default AI models
- **🤖 Agent Spawning**: Launch specialized teammates with different models and thinking levels
- **💬 Inter-Agent Messaging**: Agents communicate autonomously via inbox system
- **🔔 Automated Reminders**: System prompts idle agents to report back to team-lead
- **🖥️ Terminal Integration**: Native support for tmux, Zellij, iTerm2, and WezTerm
- **🔒 Lock System**: Thread-safe operations with automatic stale lock cleanup
- **📊 Model Resolution**: Smart provider selection with priority-based model matching

## Installation

pi-teams is a pi package. Install it through your pi configuration:

```bash
# Add to your pi config
pi config add-package @burggraf/pi-teams
```

Or reference it directly in your project:

```bash
# Clone the repository
git clone https://github.com/burggraf/pi-teams.git
cd pi-teams
npm install
```

## Quick Start

1. Create a team called my-team.
2. Create a team called research-team with model gpt-4o.
3. Spawn a teammate called security-bot to review the codebase.
4. Spawn a teammate called architect with model gpt-4o and thinking level high.
5. Send a message to security-bot to focus on the auth module.
6. Broadcast a message to the entire team about the API endpoint change.
7. Read the inbox of security-bot.

## Thinking Levels

Control reasoning depth for cost and performance optimization:

| Level | Use Case | Cost/Speed |
|-------|----------|------------|
| `off` | Formatting, renaming, moving code | Fastest / Cheapest |
| `minimal` | Quick refactors, straightforward bugfixes | Very fast |
| `low` | Standard feature implementation, tests | Fast |
| `medium` | Complex work, architecture decisions | Balanced (default) |
| `high` | Security reviews, major refactors, design specs | Thorough / Slower |

## Model Selection

Use different models for different roles:

- **`gpt-4o`** (OpenAI) - High-quality reasoning, expensive
- **`haiku`** (Anthropic) - Fast, cost-effective for routine work
- **`glm-4.7`**, **`glm-5`** (Zhipu AI) - Alternative high-performance models
- **Custom providers** - Any model available in your pi configuration

Create a mixed-speed team with an architect using gpt-4o, a coder using haiku, and a reviewer using gpt-4o.

## Terminal Integration

pi-teams automatically detects and integrates with your terminal environment:

| Terminal | Detection | Pane Management |
|----------|-----------|-----------------|
| **tmux** | `TMUX` env var | `tmux split-window` |
| **Zellij** | `ZELLIJ` env var | `zellij run` |
| **iTerm2** | macOS detection | AppleScript window splits |
| **WezTerm** | Cross-platform | `wezterm cli spawn` |

### Window Title Support

Team member windows are titled with format: `{teamName}: {agentName}`

Supported terminals:
- **iTerm2**: Escape sequences via AppleScript
- **WezTerm**: CLI `set-window-title` command
- **tmux/Zellij**: Pane titles within session

## Automated Behavior

### Idle Polling

Teammates automatically check for new messages every **30 seconds** when idle, ensuring responsiveness without manual intervention.

### Reminder System

If a teammate completes work without reporting back to the team-lead, the system automatically sends a one-time reminder:

> "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

The reminder system uses instruction-based timestamps to avoid false positives from incidental wake cycles.

### Context Injection

Each teammate receives a custom system prompt including:
- Their role and instructions
- Team context (team name, member list)
- Available tools
- Team environment guidelines

## Data Storage

All team data is stored in `~/.pi/`:

```
~/.pi/
├── teams/
│   └── <team-name>/
│       └── config.json          # Team configuration
└── messages/
    └── <team-name>/
        ├── <agent-name>.json    # Message inboxes
        └── index.json           # Message index
```

## Security

- **Lock files** prevent concurrent modifications with automatic stale lock cleanup (60s timeout)
- **Race condition protection** for multi-agent operations
- **Input validation** on all task and message data
- **File-based isolation** between teams

## Troubleshooting

### Teammate Not Responding

```javascript
// Check status and list all teammates
list_teammates({ team_name: "my-team" })

// Read their inbox
read_inbox({ team_name: "my-team", agent_name: "security-bot", unread_only: false })

// Force kill and remove if needed
process_shutdown_approved({ team_name: "my-team", agent_name: "security-bot" })
```

### Model Errors

Verify model name is available in your pi config:
```javascript
// Resolve model to full provider/model format
resolve_model({ model_name: "gpt-4o" })
```

## API Reference

Full documentation available in [`docs/reference.md`](docs/reference.md) and [`docs/guide.md`](docs/guide.md).

### Core Tools

- `team_create` - Create new team
- `spawn_teammate` - Launch agent
- `send_message` / `broadcast_message` / `read_inbox` - Messaging
- `list_teammates` - List and check teammate status
- `process_shutdown_approved` - Gracefully shut down teammate
- `team_shutdown` - Shutdown entire team
- `resolve_model` - Find correct provider/model name

## Examples

- Spawn a team called averagejoes and create a worker to do a code review.

- Make a team called joeblows and give tasks to workers. Use model openai/gpt5.4 for the workers.

- Create a worker to research the bug and use model gpt5.3 nano.

See workflow examples in:
- [Usage Guide](docs/guide.md) - Common patterns and best practices
- [Research Findings](findings.md) - Terminal integration details

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
