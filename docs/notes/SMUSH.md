# Smushing Pending Hook Messages into One Prompt

## The problem

A post-tool hook runs after every edit:

```text
Edit 1 → hook result → queued prompt
Edit 2 → hook result → queued prompt
Edit 3 → hook result → queued prompt
...
```

Even though the agent does not process those prompts until it finishes working,
each call to `sendUserMessage(..., { deliverAs: "followUp" })` creates a separate
future turn.

Ten edits can therefore produce ten follow-up turns.

## The desired behavior

Collect hook results while the agent is working, then send them together:

```text
Edit 1 → buffer result
Edit 2 → buffer result
Edit 3 → buffer result
...
agent_end → merge buffer → send one follow-up prompt
```

This solution belongs in the extension or hook integration. The host agent—Pi
in this example—does not need to be modified.

## 1. Create a per-run message buffer

Store pending feedback in extension memory:

```ts
let pendingHookMessages: string[] = [];

function queueHookMessage(message: string): void {
  if (message.trim()) {
    pendingHookMessages.push(message.trim());
  }
}
```

The buffer should exist for the lifetime of the extension, but its contents
should represent only the active agent run.

## 2. Stop sending from every post-tool hook

The problematic version sends immediately:

```ts
pi.on("tool_result", async (event, ctx) => {
  const feedback = await runPostToolHooks(event, ctx);

  if (feedback) {
    pi.sendUserMessage(feedback, { deliverAs: "followUp" });
  }
});
```

Replace the send with a queue operation:

```ts
pi.on("tool_result", async (event, ctx) => {
  const feedback = await runPostToolHooks(event, ctx);

  if (feedback) {
    queueHookMessage(feedback);
  }
});
```

If several hooks run for one tool result, queue every non-empty result:

```ts
for (const hook of hooks) {
  const feedback = await runHook(hook, event);

  if (feedback) {
    queueHookMessage(feedback);
  }
}
```

Nothing is sent to Pi yet.

## 3. Merge the buffered messages

Preserve a single result unchanged. When several results exist, give them clear
boundaries:

```ts
function mergeHookMessages(messages: readonly string[]): string {
  if (messages.length === 0) return "";
  if (messages.length === 1) return messages[0];

  const sections = messages.map(
    (message, index) =>
      `<hook-result index="${index + 1}">\n${message}\n</hook-result>`,
  );

  return [
    "Multiple hook results were produced. Address all of them:",
    ...sections,
  ].join("\n\n");
}
```

Explicit boundaries prevent separate lint errors, validation failures, or
recommendations from blending together.

## 4. Flush once at the end of the agent run

Drain the buffer during `agent_end`:

```ts
function flushHookMessages(): void {
  const messages = pendingHookMessages;

  // Clear before sending in case sending starts another agent run.
  pendingHookMessages = [];

  const merged = mergeHookMessages(messages);
  if (!merged) return;

  pi.sendUserMessage(merged, { deliverAs: "followUp" });
}

pi.on("agent_end", async () => {
  flushHookMessages();
});
```

Clearing the buffer before calling `sendUserMessage` is important. Sending the
follow-up can trigger another agent run, and the old messages must not leak into
it.

If agent-stop hooks also produce feedback, queue their results first and flush
afterward:

```ts
pi.on("agent_end", async (event, ctx) => {
  const stopFeedback = await runAgentStopHooks(event, ctx);

  for (const message of stopFeedback) {
    queueHookMessage(message);
  }

  flushHookMessages();
});
```

This produces one combined prompt containing both post-tool and agent-stop
feedback.

## 5. Reset stale state

Clear the buffer when a session or agent run starts. This protects against
aborted runs that never reached `agent_end`:

```ts
pi.on("session_start", async () => {
  pendingHookMessages = [];
});

pi.on("agent_start", async () => {
  pendingHookMessages = [];
});
```

Also clear it when hooks are disabled:

```ts
function disableHooks(): void {
  hooksEnabled = false;
  pendingHookMessages = [];
}
```

## 6. Keep immediate messages immediate

Not every message should be buffered.

Pre-tool feedback often needs to influence whether or how the upcoming tool
executes. Continue sending those as steering messages:

```ts
pi.on("tool_call", async (event, ctx) => {
  const feedback = await runPreToolHooks(event, ctx);

  if (feedback) {
    pi.sendUserMessage(feedback, { deliverAs: "steer" });
  }
});
```

A useful rule is:

- Pre-tool feedback: send immediately as `steer`.
- Post-tool feedback: buffer until `agent_end`.
- Agent-stop feedback: add to the buffer, then flush once.
- User-created follow-ups: leave independent unless explicitly intended for
  batching.

## 7. Test the merging behavior

At minimum, verify these cases:

```ts
import { describe, expect, it } from "vitest";

describe("mergeHookMessages", () => {
  it("returns nothing for an empty buffer", () => {
    expect(mergeHookMessages([])).toBe("");
  });

  it("preserves one result unchanged", () => {
    expect(mergeHookMessages(["Fix formatting."])).toBe(
      "Fix formatting.",
    );
  });

  it("combines multiple results in order", () => {
    const merged = mergeHookMessages([
      "Fix formatting.",
      "Add a missing test.",
    ]);

    expect(merged).toContain('<hook-result index="1">');
    expect(merged).toContain("Fix formatting.");
    expect(merged).toContain('<hook-result index="2">');
    expect(merged).toContain("Add a missing test.");
  });
});
```

An integration test should additionally confirm that ten queued results cause
exactly one call to `sendUserMessage`.

## Copy-paste instructions for another agent

```text
Fix the accumulation of queued hook prompts without modifying the host agent.

Currently, each post-tool hook result independently calls sendUserMessage with
deliverAs: "followUp". When an agent performs many edits, this creates one
queued follow-up turn per edit.

Implement batching inside this extension:

1. Add an in-memory message buffer scoped to the active agent run.
2. In post-tool/tool-result handlers, append non-empty hook feedback to the
   buffer instead of calling sendUserMessage.
3. Queue agent-stop feedback in the same buffer.
4. During agent_end, merge all buffered feedback in execution order and make
   exactly one sendUserMessage call using deliverAs: "followUp".
5. Return a single result unchanged. For multiple results, add explicit
   numbered boundaries so separate results remain distinguishable.
6. Clear the buffer before sending to avoid reentrancy or feedback leaking into
   the follow-up run.
7. Clear stale buffered feedback on session_start, agent_start, and when hooks
   are disabled.
8. Do not buffer pre-tool steering or blocking decisions; those must retain
   their immediate timing.
9. Preserve existing hook-output extraction, error handling, and stop-loop
   protection.
10. Add tests for zero, one, and multiple buffered messages, plus verification
    that multiple results produce only one outgoing follow-up call.
11. Make changes only in the extension repository. Do not modify the host
    agent or its dependencies.
```
