---
name: implement-tasks
description: Divide tasks among a team of worker agents and implement code fixes in parallel. Covers team setup, model selection, spawning workers, assigning tasks, and the worker instruction template (diagnosis, fix, verification, output format). Use when the user asks to "implement tasks", "fix the tasks", or fan out work to workers.
---

# Implement tasks

Use the tasks from the task list. Divide them among a team of workers and run the work in parallel where the blockers allow it.

## Team setup

Requires the pi-tasks task tools (`task_create`, `get_batch_of_tasks`, ...). If they are not available, tell the user to install the pi-tasks extension and stop.

Spawn one worker per ready task, as many workers as there are ready tasks. Omit the `model` argument when spawning so `spawn_teammate` clones your own model for each worker. If you want provider-diverse models instead, run `get_models` and pick from the worker list.

Workers are agents of flavor class "worker".

Assign one task per worker. Send each worker detailed instructions in the message, including which files to look in when known. Instruct worker models to close themselves when they are done.  At the end of a round, check for stale workers and close any stragglers who failed to close. While waiting for workers to finish, just stop by outputting "I'm waiting for workers to finish."  You will be automatically notified when any worker is done.

## Worker instruction template

Send each agent instructions in this form, substituting the task's objective and details:

```
## Code fix

<task objective and details>

**1. Diagnosis & root cause analysis**
- Do not start coding immediately.
- Trace the execution flow to find the exact file and line causing the issue.

**2. Implementation strategy**
- Isolate: If possible, write a failing test case that reproduces the bug.
- Fix: Apply the minimal change required to resolve the issue.
- Refactor: Only clean up code if it directly relates to the bug fix. Do not refactor unrelated code.

**3. Verification**
- Run unit tests relevant to the changed area.
- Ensure no other tests were broken by the change.
- Check for edge cases (e.g., empty inputs, null values).

**4. Output format**
- Return the **File Path** and the **Diff/Code Block**.
- Briefly explain what changed and why.

**Constraints:**
- Do not introduce new dependencies unless absolutely necessary.
- Maintain existing code style (indentation, naming conventions).
```

## Notes

- One worker per ready task.
- If a task depends on unfinished work, do not assign it until its blockers are completed. Use `get_batch_of_tasks` to see which tasks are ready.
- If a worker stalls (repeats a failed approach, makes smaller and smaller edits, or declares the task impossible after two corrections), close it with `close_worker` and spawn a fresh worker. Send the fresh worker the original task, the current state of the work, and one line on what failed. Do not send it the stalled worker's full history. A long session anchors the agent to its own failed attempts; a fresh context makes larger, bolder changes.
