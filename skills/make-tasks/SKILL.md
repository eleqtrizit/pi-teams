---
name: make-tasks
description: Analyze an objective and produce a structured, dependency-aware task list in the pi-tasks extension. Covers task rules, output format, parallelism waves, and the task_create/task_update interface. Use when the user asks to "make tasks", break down an objective into tasks, or plan work as a task list.
---

# Make tasks

Analyze the given objective and produce a structured task list, then create the tasks with the pi-tasks extension tools.

## Objective

Use the objective the user provides. If the user gave no objective, ask for one before creating tasks.

## Task rules

1. **Single responsibility** — each task does exactly one thing. If a task can be split, split it.
2. **Thorough description** — include enough context for an agent with no prior knowledge to execute the task independently:
   - Relevant file paths already identified
   - Specific classes, functions, interfaces, enums, or globals to create or modify
   - Expected inputs and outputs
   - Edge cases or constraints to be aware of
3. **Explicit blockers** — list every task that must complete before this one can start. If a task has no blockers, state "None". This enables maximum parallelism.
4. **Handoff note** — end every task with:
   > **Handoff:** Update dependent tasks with any relevant information discovered during this task — file paths, symbols (classes/functions/globals/enums/interfaces), design decisions, or API contracts that another agent will need.

## Output format

Use the following structure for each task:

```
## Task N: <Short Title>

**Description:**
<Detailed description of what must be done and why.>

**Acceptance Criteria:**
- <Verifiable condition 1>
- <Verifiable condition 2>

**Relevant Context:**
- Files: <list known relevant files, or "TBD">
- Symbols: <list known relevant symbols, or "TBD">

**Blockers:** <Task numbers that must complete first, or "None">

**Handoff:** Update dependent tasks with relevant information performed during this task, including file paths, classes/functions/globals/enums/interfaces, and any design decisions made.
```

## Parallelism plan

After listing all tasks, include a **Parallelism Plan** section that groups tasks into execution waves — each wave contains tasks that can run concurrently given their blockers.

```
## Parallelism Plan

- Wave 1 (parallel): Task 1, Task 2, Task 3
- Wave 2 (parallel): Task 4, Task 5  ← blocked on Wave 1
- Wave 3 (sequential): Task 6        ← blocked on Wave 2
```

## pi-tasks extension interface

Create the tasks with `task_create`. Use `task_update` to add dependencies you could not declare at creation time.

| Tool | Purpose | Key Fields |
|------|---------|------------|
| `task_create` | Create a task | `subject` (required), `addBlockedBy` (required, can be `[]`), `description`, `activeForm`, `metadata` |
| `task_update` | Update status/owner/deps | `taskId` (required), `status`, `owner`, `addBlockedBy`, `addBlocks`, `subject`, `description` |
| `task_get` | Get single task details | `taskId` |
| `task_list` | List all tasks with blocked state | (none) |
| `get_batch_of_tasks` | Get ready-to-run tasks | (none) |
| `clear_tasks` | Delete all tasks | (none) |

### How blockers work

- **`addBlockedBy`** — declare which task IDs must complete first. When task A depends on task B, the system automatically adds A to B's `blocks` list. You only specify `addBlockedBy`.
- **Status flow:** `pending → in_progress → completed`. An in-progress task can go back to `pending`; a completed task cannot.
- **Blocked tasks cannot transition** to `in_progress` or `completed`. The system rejects it with: `Task #X is blocked by unfinished dependencies.`
- **`get_batch_of_tasks()`** returns only tasks where `status === "pending"` AND all dependencies are completed — ready for parallel execution.

### Task IDs are assigned at creation

IDs are auto-incremented strings (`"1"`, `"2"`, `"3"`...). You **cannot** reference a task that has not been created yet. Create tasks in dependency order: foundation tasks first with `addBlockedBy: []`, then dependent tasks using the returned IDs.

```
task_create({ subject: "Setup", addBlockedBy: [] })    → #1
task_create({ subject: "Config", addBlockedBy: [] })   → #2
task_create({ subject: "Build", addBlockedBy: ["1"] }) → #3
```

**Fallback if you do not know IDs yet:** Normally create tasks in dependency order so each `task_create` can reference the returned IDs of its blockers. Only when a dependency graph makes that impossible, create all tasks with `addBlockedBy: []`, then use `task_update` to add dependencies afterward. This creates a window with no real blockers; do not use it routinely.

### Common pitfalls

- **Circular dependencies** — A blocks B and B blocks A. Avoid.
- **Self-reference** — `addBlockedBy: ["1"]` in task #1 → error.
- **Non-existent IDs** — referencing a task that has not been created → error.
- **Too many deps** — every dependency is a serialization point. Only add true blockers.
- **Completing blocked tasks** — fails with `Task #X is blocked by unfinished dependencies.`
