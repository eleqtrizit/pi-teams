# pi-teams Tool Reference

Complete documentation of all tools, parameters, and automated behavior.

---

## Table of Contents

- [Team Management](#team-management)
- [Teammates](#teammates)
- [Messaging](#messaging)
- [Automated Behavior](#automated-behavior)
- [Configuration & Data](#configuration--data)

---

## Team Management

### team_create

Start a new team with optional default model.

**Parameters**:
- `team_name` (required): Name for the team
- `description` (optional): Team description
- `default_model` (optional): Default AI model for all teammates (e.g., `gpt-4o`, `haiku`, `glm-4.7`)
- `separate_windows` (optional): If `true`, open teammates in separate OS windows instead of panes

**Examples**:
```javascript
team_create({ team_name: "my-team" })
team_create({ team_name: "research", default_model: "gpt-4o" })
team_create({ team_name: "windows-team", separate_windows: true })
```

---

### team_shutdown

Shutdown the entire team and close all panes/windows.

**Parameters**:
- `team_name` (required): Name of the team to shutdown

**Example**:
```javascript
team_shutdown({ team_name: "my-team" })
```

---

### read_config

Get details about the team and its members.

**Parameters**:
- `team_name` (required): Name of the team

**Returns**: Team configuration including:
- Team name and description
- Default model
- List of members with their models and thinking levels
- Creation timestamp

**Example**:
```javascript
read_config({ team_name: "my-team" })
```

---

## Teammates

### spawn_teammate

Launch a new agent into a terminal pane with a role and instructions.

**Parameters**:
- `team_name` (required): Name of the team
- `name` (required): Friendly name for the teammate (e.g., "security-bot")
- `cwd` (required): Working directory for the teammate
- `model` (optional): AI model for this teammate (overrides team default)
- `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`)
- `separate_window` (optional): If `true`, spawn in separate OS window

**Model Options**:
- Any model available in your pi configuration
- Common models: `gpt-4o`, `haiku` (Anthropic), `glm-4.7`, `glm-5` (Zhipu AI)

**Thinking Levels**:
- `off`: No thinking blocks (fastest)
- `minimal`: Minimal reasoning overhead
- `low`: Light reasoning for quick decisions
- `medium`: Balanced reasoning (default)
- `high`: Extended reasoning for complex problems

**Examples**:
```javascript
// Basic spawn
spawn_teammate({
  team_name: "my-team",
  name: "security-bot",
  cwd: "/path/to/project"
})

// With custom model
spawn_teammate({
  team_name: "my-team",
  name: "speed-bot",
  cwd: "/path/to/project",
  model: "haiku"
})

// With custom model and thinking
spawn_teammate({
  team_name: "my-team",
  name: "architect-bot",
  cwd: "/path/to/project",
  model: "gpt-4o",
  thinking: "high"
})

// In separate window
spawn_teammate({
  team_name: "my-team",
  name: "window-bot",
  cwd: "/path/to/project",
  separate_window: true
})
```

---

### list_teammates

List all teammates in a team with their status.

**Parameters**:
- `team_name` (required): Name of the team

**Returns**: Array of teammates with:
- Name and agent type
- Model used
- Whether they're alive (process running)
- Whether they're active (recently used)
- Unread message count

**Example**:
```javascript
list_teammates({ team_name: "my-team" })
```

---

### process_shutdown_approved

Initiate orderly shutdown for a finished teammate.

**Parameters**:
- `team_name` (required): Name of the team
- `agent_name` (required): Name of the teammate to shut down

**Example**:
```javascript
process_shutdown_approved({ team_name: "my-team", agent_name: "security-bot" })
```

---

## Messaging

### send_message

Send a message to a specific teammate or the team lead.

**Parameters**:
- `team_name` (optional): Name of the team (defaults to current team)
- `recipient` (required): Name of the agent receiving the message
- `content` (required): Full message content
- `summary` (required): Brief summary for message list
- `color` (optional): Message color for UI highlighting

**Example**:
```javascript
send_message({
  team_name: "my-team",
  recipient: "security-bot",
  content: "Please focus on the auth module first",
  summary: "Focus on auth module"
})
```

---

### broadcast_message

Send a message to the entire team (excluding the sender).

**Parameters**:
- `team_name` (optional): Name of the team (defaults to current team)
- `content` (required): Full message content
- `summary` (required): Brief summary for message list
- `color` (optional): Message color for UI highlighting

**Use cases**:
- API endpoint changes
- Database schema updates
- Team announcements
- Priority shifts

**Example**:
```javascript
broadcast_message({
  team_name: "my-team",
  content: "The API endpoint has changed to /v2. Please update your work accordingly.",
  summary: "API endpoint changed to v2"
})
```

---

### read_inbox

Read incoming messages for an agent.

**Parameters**:
- `team_name` (optional): Name of the team (defaults to current team)
- `agent_name` (optional): Whose inbox to read. Defaults to current agent.
- `unread_only` (optional): Only show unread messages. Default: `true`

**Returns**: Array of messages with sender, content, timestamp, and read status.

**Examples**:
```javascript
// Read my unread messages
read_inbox({ team_name: "my-team" })

// Read all messages (including read)
read_inbox({ team_name: "my-team", unread_only: false })

// Read a teammate's inbox (as lead)
read_inbox({ team_name: "my-team", agent_name: "security-bot" })
```

---

## Model Resolution

### resolve_model

Use this tool to find the correct provider/model name to use in spawn_teammate. Use DEFAULT MODEL if no good match is found.

**Parameters**:
- `model_name` (required): Model name to resolve (e.g., "haiku", "gpt-4o")

**Returns**: Full provider/model string (e.g., "anthropic/claude-3-5-haiku")

**Example**:
```javascript
resolve_model({ model_name: "haiku" })
// Returns: "anthropic/claude-3-5-haiku"
```

---

## Automated Behavior

### Initial Greeting

When a teammate is spawned, they automatically:
1. Send a message to the lead announcing they've started
2. Begin checking their inbox for work

**Example message**: "I've started and am checking my inbox for tasks."

---

### Idle Polling

If a teammate is idle (has no active work), they automatically check for new messages every **30 seconds**.

This ensures teammates stay responsive to new tasks, messages, and task reassignments without manual intervention.

---

### Automated Hooks

When a task's status changes to `completed`, pi-teams automatically executes:

`.pi/team-hooks/task_completed.sh`

The hook receives the task data as a JSON string as the first argument.

**Common hook uses**:
- Run test suite
- Run linting
- Notify external systems (Slack, email)
- Trigger deployments
- Generate reports

**See [Usage Guide](guide.md#hook-system) for detailed examples.**

---

### Context Injection

Each teammate is given a custom system prompt that includes:
- Their role and instructions
- Team context (team name, member list)
- Available tools
- Team environment guidelines

This ensures teammates understand their responsibilities and can work autonomously.

---

### Reminder System

If a teammate completes work without reporting back to the team-lead, the system automatically sends a one-time reminder:

> "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

The reminder system uses instruction-based timestamps to avoid false positives from incidental wake cycles.

---

## Configuration & Data

### Data Storage

All pi-teams data is stored in your home directory under `~/.pi/`:

```
~/.pi/
├── teams/
│   └── <team-name>/
│       └── config.json      # Team configuration and member list
├── tasks/
│   └── <team-name>/
│       ├── task_*.json      # Individual task files
│       └── tasks.json       # Task index
└── messages/
    └── <team-name>/
        ├── <agent-name>.json  # Per-agent message history
        └── index.json         # Message index
```

### Team Configuration (config.json)

```json
{
  "name": "my-team",
  "description": "Code review team",
  "defaultModel": "gpt-4o",
  "members": [
    {
      "name": "security-bot",
      "model": "gpt-4o",
      "thinking": "medium",
      "agentType": "teammate"
    },
    {
      "name": "frontend-dev",
      "model": "haiku",
      "thinking": "low",
      "agentType": "teammate"
    }
  ]
}
```

### Message File (<agent-name>.json)

```json
{
  "messages": [
    {
      "id": "msg_def456",
      "from": "team-lead",
      "text": "Please focus on the auth module first",
      "summary": "Focus on auth module",
      "timestamp": "2024-02-22T10:15:00Z",
      "read": false
    }
  ]
}
```

---

## Environment Variables

pi-teams respects the following environment variables:

- `ZELLIJ`: Automatically detected when running inside Zellij. Enables Zellij pane management.
- `TMUX`: Automatically detected when running inside tmux. Enables tmux pane management.
- `PI_TEAM_NAME`: Set automatically when joining a team.
- `PI_AGENT_NAME`: Set automatically to identify the current agent.

---

## Terminal Integration

### tmux Detection

If the `TMUX` environment variable is set, pi-teams uses `tmux split-window` to create panes.

**Layout**: Large lead pane on the left, teammates stacked on the right.

### Zellij Detection

If the `ZELLIJ` environment variable is set, pi-teams uses `zellij run` to create panes.

**Layout**: Same as tmux - large lead pane on left, teammates on right.

### iTerm2 Detection

If neither tmux nor Zellij is detected, and you're on macOS with iTerm2, pi-teams uses AppleScript to split the window.

**Layout**: Same as tmux/Zellij - large lead pane on left, teammates on right.

**Requirements**:
- macOS
- iTerm2 terminal
- Not inside tmux or Zellij

### WezTerm Detection

WezTerm is detected automatically and uses `wezterm cli spawn` to create panes.

**Layout**: Same as tmux/Zellij - large lead pane on left, teammates on right.

---

## Error Handling

### Lock Files

pi-teams uses lock files to prevent concurrent modifications:

```
~/.pi/teams/<team-name>/.lock
~/.pi/tasks/<team-name>/.lock
~/.pi/messages/<team-name>/.lock
```

If a lock file is stale (process no longer running), it's automatically removed after 60 seconds.

### Race Conditions

The locking system prevents race conditions when multiple teammates try to update tasks or send messages simultaneously.

### Recovery

If a lock file persists beyond 60 seconds, it's automatically cleaned up. For manual recovery:

```bash
# Remove stale lock
rm ~/.pi/teams/my-team/.lock
```

---

## Performance Considerations

### Idle Polling Overhead

Teammates poll their inboxes every 30 seconds when idle. This is minimal overhead (one file read per poll).

### Lock Timeout

Lock files timeout after 60 seconds. Adjust if you have very slow operations.

### Message Storage

Messages are stored as JSON. For teams with extensive message history, consider periodic cleanup:

```bash
# Archive old messages
mv ~/.pi/messages/my-team/ ~/.pi/messages-archive/my-team-2024-02-22/
```
