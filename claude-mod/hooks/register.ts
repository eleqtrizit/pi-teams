import type { EngineInterface, Register } from 'claude-code'

import {
  CLI_INSTALL,
  EXTENSION_INSTALL,
  PLUGIN,
  TOOLS,
  formatDelivered,
  parseListenerLine,
  splitLines,
} from './lib'
import type { TeamMessage, ToolDef } from './lib'

// What the engine says when it declines a prompt it cannot start yet: kept and
// resubmitted at the next turn.complete.
const REFUSED = [
  'the session was stopped and nobody has sent input since',
  'was removed from the queue before it ran',
]
// Messages that arrive close together are delivered as one turn.
const BATCH_MS = 300
// A listener that dies is restarted this many times, then left stopped.
const MAX_RESTARTS = 3
// `pi-teams` exits with this code when its version check fails; retrying cannot help.
const EXIT_VERSION = 3

let cli = 'pi-teams'
let client = 'Claude Code'
// This session's id on the pi-teams network, once the listener has registered.
let agentId: string | undefined
// Why the network is unavailable, told to the model by every tool call.
let setupError: string | undefined
let restarts = 0
let queue: TeamMessage[] = []
let flushTimer: { cancel: () => void } | undefined
let refused: string[] = []

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unavailable(): string {
  return setupError ?? 'pi-teams is still connecting. Try again in a moment.'
}

/** Run one CLI command; resolves its stdout, or an "Error:" line the model can read. */
async function runCli(
  $: EngineInterface,
  argv: string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<string> {
  try {
    const r = await $.process.run([cli, ...argv], { stdin, timeoutMs })
    if (r.exitCode === 0) return r.stdout.trim() || 'ok'
    return `Error: ${(r.stderr || r.stdout).trim() || `pi-teams exited with ${r.exitCode}`}`
  } catch (error) {
    return `Error: cannot run "${cli}" (${describe(error)}). Install it with: ${CLI_INSTALL}`
  }
}

async function handleTool($: EngineInterface, tool: ToolDef, args: Record<string, unknown>) {
  if (tool.needsId && agentId === undefined) return { result: `Error: ${unavailable()}` }
  let invocation
  try {
    invocation = tool.build(args, agentId ?? '')
  } catch (error) {
    return { result: `Error: ${describe(error)}` }
  }
  return { result: await runCli($, invocation.argv, invocation.stdin, invocation.timeoutMs) }
}

/** Submit text as a turn without awaiting it; keep it for a retry if the engine declines it. */
async function submit($: EngineInterface, text: string): Promise<void> {
  let reason = ''
  try {
    const result = await $.prompt.submit({ text })
    reason = result?.drop ?? ''
  } catch (error) {
    reason = describe(error)
  }
  if (REFUSED.some(r => reason.includes(r))) refused.push(text)
}

function flush($: EngineInterface): void {
  flushTimer = undefined
  const batch = queue
  queue = []
  if (agentId === undefined || batch.length === 0) return
  void submit($, formatDelivered(batch, agentId))
}

function receive($: EngineInterface, message: TeamMessage): void {
  queue.push(message)
  flushTimer ??= $.clock.after(BATCH_MS, () => flush($))
}

function publishState($: EngineInterface, state: 'busy' | 'idle'): void {
  if (agentId === undefined) return
  $.process.run([cli, 'state', '--as', agentId, state], { timeoutMs: 5000 }).catch(() => undefined)
}

/**
 * Run `pi-teams listen` for the life of the session: it registers this session
 * as a lead and prints one JSON line per inbound message, each of which wakes
 * the model. The child dies with the module.
 */
async function listen($: EngineInterface, cwd: string): Promise<void> {
  let stderr = ''
  let buffer = ''
  let exitCode: number | null = null
  try {
    const child = $.process.spawn({ argv: [cli, 'listen', '--cwd', cwd, '--client', client] })
    for (;;) {
      const step = await child.next()
      if (step.done) {
        exitCode = step.value.code
        break
      }
      if (step.value.stream === 'stderr') {
        stderr += step.value.text
        continue
      }
      const split = splitLines(buffer, step.value.text)
      buffer = split.rest
      for (const line of split.lines) {
        const parsed = parseListenerLine(line)
        if (parsed?.type === 'ready') {
          agentId = parsed.id
          setupError = undefined
          restarts = 0
          $.ui.status(undefined)
          $.ui.toast(`pi-teams: connected as ${parsed.id}`)
        } else if (parsed?.type === 'message') {
          receive($, parsed.message)
        }
      }
    }
  } catch (error) {
    stderr += `cannot run "${cli}" (${describe(error)}). Install it with: ${CLI_INSTALL}`
    exitCode = EXIT_VERSION
  }

  agentId = undefined
  const reason = stderr.trim().replace(/^pi-teams: /, '')
  const retryable = exitCode !== EXIT_VERSION && restarts < MAX_RESTARTS
  setupError = reason || `the pi-teams listener stopped (exit ${exitCode}). ${EXTENSION_INSTALL}`
  if (retryable) {
    restarts += 1
    $.clock.after(2000 * restarts, () => void listen($, cwd))
  } else {
    $.ui.status(`pi-teams: ${setupError}`)
  }
}

export const register: Register = (on, options) => {
  cli = String(options.cli_path || cli)
  client = String(options.client_name || client)

  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        isDeferred: false,
      })
    }
    try {
      await $.command.register({ name: 'pi-teams', description: 'Show the pi-teams connection and the agents you can reach' })
    } catch {
      // A taken name must not stop the rest of the session start.
    }
    void listen($, e.cwd ?? (await $.session.cwd()))
    return next(e)
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: `mcp__${PLUGIN}__${tool.name}` }, ($, e) => handleTool($, tool, e)).catch(() => ({
      result: `Error: the pi-teams ${tool.name} tool failed unexpectedly.`,
    }))
  }

  on('command.run', { command: 'pi-teams' }, async $ => {
    if (agentId === undefined) return { text: `pi-teams: not connected. ${unavailable()}` }
    const agents = await runCli($, ['list', '--as', agentId], undefined, 15_000)
    return { text: `pi-teams: connected as ${agentId} (${client}).\n${agents}` }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) publishState($, 'busy')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      publishState($, 'idle')
      const retry = refused
      refused = []
      for (const text of retry) void submit($, text)
    }
    return next(e)
  })
}
