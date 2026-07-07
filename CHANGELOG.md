# Changelog

## fix(extensions): enforce provider-scoped model resolution and update tool description (`927023e`)

`resolveModelWithProvider` no longer falls through to cross-provider matching
when a `<provider>/<model>` pair is requested but not found under that provider.
Previously, `vyper/Qwen-35B` could silently return `bighank/Qwen-35B`. Now it
returns `null` — only exact or scoped matches within the named provider are
accepted.

Update the `resolve_model` tool description to instruct agents to always use
`<provider>/<model>` format and call `get_available_models()` to discover
valid pairs.

## refactor(extensions): remove inter-agent edit/write notification system (`0850b79`)

Remove the near-real-time notification queue (`sendNotification`,
`sendNotificationToAll`, `pollNotification`) that alerted teammates when an
agent edited or wrote a file. The tool.log audit trail is preserved.

## fix(messaging): use JSONL queue for notifications to prevent overwriting (`351d559`)

Switch notification files from single-write JSON to append-only JSONL queues
so rapid edits from the same agent no longer clobber each other. Poll now
drains all pending notifications atomically via rename-then-read, and the
consumer joins them into a single follow-up message to prevent flooding.

Also fix unhandled async on `sendNotificationToAll` in edit/write tool
wrappers and switch delivery from `steer` to `followUp` to avoid
interrupting mid-turn work.
