# Reminder Flow

## Purpose

When a team member finishes work without sending a message to the team-lead,
inject a one-time reminder into their inbox.

## Actors

| Actor | Role |
|-------|------|
| **Polling loop** (`setInterval` in `extensions/index.ts`) | Runs every 1 s while the agent is idle. Calls `ensureReminderMessage`, then `readInbox` to surface unread messages. |
| **`ensureReminderMessage`** (`messaging.ts`) | Decides whether a reminder is needed and appends it to the inbox file. |
| **`needsReminderMessage`** (`messaging.ts`) | Pure decision function — compares timestamps to answer "should we remind?" |
| **`sendPlainMessage`** (`messaging.ts`) | Records `lastMessageTime` for the sender when they send a message. |

## Current (Broken) Flow — `lastAwokenTime` comparison

### Trigger condition

```
needsReminderMessage returns true when:
  lastMessageTime < lastAwokenTime   (or lastMessageTime is null)
```

### Timeline of the bug

```
T1  turn_start → setActiveStatus(true) → .active missing → updateLastAwokenTime(T1)
T2  Agent reads inbox (team-lead instruction)
T3  Agent does work
T4  Agent calls send_message → updateLastMessageTime(T4)       // T4 > T1 ✓
T5  turn_end → setActiveStatus(false) → deletes .active
T6  Agent text output causes another turn cycle
T7  turn_start → .active missing again → updateLastAwokenTime(T7)  // T7 > T4 !!
T8  Brief turn, no send_message call
T9  turn_end → deletes .active
T10 Interval fires → ensureReminderMessage:
      lastMessageTime = T4
      lastAwokenTime  = T7
      T4 < T7 → TRUE → REMINDER FIRES (false positive)
```

### Root cause

`lastAwokenTime` resets on **every** idle → active transition, including
incidental ones (notification wakes, output continuations). Any wake after the
agent sent a message makes `lastAwokenTime > lastMessageTime`, triggering a
false-positive reminder even though the agent already reported.

## Fixed Flow — instruction-based comparison

### Trigger condition

```
needsReminderMessage returns true when:
  1. Inbox contains at least one team-lead message (instructions exist)
  2. All team-lead messages are read (agent had a chance to respond)
  3. lastMessageTime is null OR lastMessageTime < latestInstructionTimestamp
  4. No unread system reminder already exists
  5. No reminder already sent for this instruction cycle
```

### Why this works

The comparison anchors on the **instruction timestamp** — a value that only
changes when the team-lead sends new instructions — not on the wake cycle.
Once the agent sends a message after the latest instruction, the condition
stays false regardless of how many times the agent wakes and sleeps.

### Timeline (fixed)

```
T1  team-lead sends instruction → inbox has message with timestamp T1
T2  Agent wakes, reads inbox → all team-lead messages now marked read
T3  Agent does work
T4  Agent calls send_message → lastMessageTime = T4       // T4 > T1 ✓
T5  Agent goes idle, wakes again (incidental)
T6  Interval fires → ensureReminderMessage:
      latestInstructionTimestamp = T1
      lastMessageTime = T4
      T4 > T1 → FALSE → no reminder ✓
```

### Correct reminder scenario

```
T1  team-lead sends instruction → inbox timestamp T1
T2  Agent wakes, reads inbox → marked read
T3  Agent does work but does NOT call send_message
T4  Agent goes idle
T5  Interval fires → ensureReminderMessage:
      latestInstructionTimestamp = T1
      lastMessageTime = null (or < T1)
      → TRUE → reminder appended (once)
```
