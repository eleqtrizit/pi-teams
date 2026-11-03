/**
 * Pure logic for the pi-teams mod: the tool table, the listener's line
 * protocol, and the text Claude reads when a message arrives. Nothing here
 * touches `$`, so every function is unit-testable.
 */

/** Plugin name; the model calls the tools as `mcp__pi-teams__<name>`. */
export const PLUGIN = 'pi-teams'
export const SEND_TOOL = `mcp__${PLUGIN}__send_message`

/** Where to get the CLI, shown whenever it cannot run. */
export const CLI_INSTALL = 'npm i -g @eleqtrizit/pi-teams-cli'
export const EXTENSION_INSTALL = 'pi install https://github.com/eleqtrizit/pi-teams'

/** A message as the CLI's `listen` command prints it. */
export type TeamMessage = {
  id: string
  from: string
  to: string
  fromLabel: string
  subject: string
  text: string
  timestamp: string
  expectReply?: boolean
}

/** One line of `pi-teams listen` output. */
export type ListenerLine =
  | { type: 'ready'; id: string; cwd: string; adopted: string[] }
  | { type: 'message'; message: TeamMessage }

/**
 * Split streamed text into complete lines.
 *
 * @param buffer text left over from the previous chunk
 * @param chunk newly arrived text, which may end mid-line
 * @returns the complete lines, and the unfinished remainder
 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim() !== ''), rest }
}

/** Parse one listener line; undefined for anything that is not a known object. */
export function parseListenerLine(line: string): ListenerLine | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.type === 'ready' && typeof v.id === 'string') {
    return {
      type: 'ready',
      id: v.id,
      cwd: typeof v.cwd === 'string' ? v.cwd : '',
      adopted: Array.isArray(v.adopted) ? v.adopted.filter(a => typeof a === 'string') : [],
    }
  }
  if (v.type === 'message' && typeof v.message === 'object' && v.message !== null) {
    const m = v.message as Record<string, unknown>
    const text = ['id', 'from', 'to', 'fromLabel', 'subject', 'text', 'timestamp'].every(
      k => typeof m[k] === 'string',
    )
    if (text) return { type: 'message', message: m as unknown as TeamMessage }
  }
  return undefined
}

/**
 * The text Claude reads for delivered messages, shaped like what a pi agent
 * reads so replies work the same way: who sent it, whether it wants an
 * answer, and the tool call that answers it.
 */
export function formatDelivered(messages: readonly TeamMessage[], selfId: string): string {
  if (messages.length === 0) return ''
  const one = (m: TeamMessage): string => {
    const ts = m.timestamp.replace('T', ' ').slice(0, 19)
    return [
      `**From:** ${m.fromLabel} (${m.from})`,
      `**To:** ${m.to === selfId ? `You (${m.to})` : m.to}`,
      m.expectReply === true
        ? `Reply expected: yes. Answer with ${SEND_TOOL}(recipient="${m.from}", expectReply=false).`
        : `Reply expected: no.`,
      `**Subject:** ${m.subject}`,
      `**Timestamp:** ${ts}`,
      '',
      m.text,
    ].join('\n')
  }
  if (messages.length === 1) return one(messages[0])
  return [
    'Multiple pi-teams messages were delivered. Address all of them:',
    ...messages.map((m, i) => `<delivered-message index="${i + 1}">\n${one(m)}\n</delivered-message>`),
  ].join('\n\n')
}

/** What to run for one tool call. */
export type Invocation = {
  /** Arguments after the CLI path. */
  argv: string[]
  /** Text written to the CLI's standard input. */
  stdin?: string
  /** Longest the call may take; spawns wait for the worker's socket. */
  timeoutMs: number
}

type Args = Record<string, unknown>

function text(args: Args, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`"${key}" is required and must be a non-empty string.`)
  return v
}

function optText(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string.`)
  return v
}

const SHORT = 15_000
const SPAWN = 60_000

/** One tool the mod offers the model. */
export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Whether the call acts as this session's lead, so the CLI needs `--as <id>`. */
  needsId: boolean
  /** Build the CLI invocation; throws a readable Error for bad arguments. */
  build: (args: Args, id: string) => Invocation
}

const NAME = { type: 'string', description: 'Short worker name: letters, digits, hyphens, underscores.' }
const MODEL = {
  type: 'string',
  description: 'Fully qualified provider/model. Call get_models first and pick from its lists.',
}
const WINDOW = { type: 'boolean', description: 'Open in a separate OS window instead of a pane.' }

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'send_message',
    description:
      'Send a message to a pi-teams agent. It arrives immediately as a user message in that agent. ' +
      'Set recipient to "all" to message every worker you spawned. The tool fails at once when the ' +
      'recipient is not running. Replies to you arrive on their own as new turns: never poll or sleep.',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'An 8-character agent id from list_agents, one of your worker names, or "all".',
        },
        subject: { type: 'string', description: 'Short subject line.' },
        content: { type: 'string', description: 'Full message body.' },
        expectReply: {
          type: 'boolean',
          description:
            'true when you need an answer (a task, a question, a status request): the recipient is reminded ' +
            'until it replies. false for replies, reports and acknowledgments.',
        },
        summary: { type: 'string', description: 'Optional brief summary.' },
      },
      required: ['recipient', 'subject', 'content', 'expectReply'],
    },
    needsId: true,
    build: (a, id) => {
      if (typeof a.expectReply !== 'boolean') throw new Error('"expectReply" is required and must be true or false.')
      const summary = optText(a, 'summary')
      return {
        argv: [
          'send', '--as', id, '--subject', text(a, 'subject'),
          ...(a.expectReply ? ['--expect-reply'] : []),
          ...(summary ? ['--summary', summary] : []),
          '--', text(a, 'recipient'),
        ],
        stdin: text(a, 'content'),
        timeoutMs: SHORT,
      }
    },
  },
  {
    name: 'list_agents',
    description:
      'List the pi-teams agents you can reach: your own workers first, then peer leads by directory ' +
      'proximity, each with an 8-character id and an Idling, Busy or Offline status. Use the id with send_message.',
    inputSchema: {
      type: 'object',
      properties: { onlineOnly: { type: 'boolean', description: 'Omit Offline agents.' } },
    },
    needsId: true,
    build: (a, id) => ({
      argv: ['list', '--as', id, ...(a.onlineOnly === true ? ['--online-only'] : [])],
      timeoutMs: SHORT,
    }),
  },
  {
    name: 'get_models',
    description:
      'Read the model lists from pi settings: orchestrator, worker (coding) and swarm (read-only gathering) ' +
      'when flavors are set, plus every enabled model. Pick a spawn model from here.',
    inputSchema: { type: 'object', properties: {} },
    needsId: false,
    build: () => ({ argv: ['models'], timeoutMs: SHORT }),
  },
  {
    name: 'spawn_teammate',
    description:
      'Spawn a pi worker in a terminal pane (a tmux, iTerm2, zellij, wezterm, herdr or Orca pane next to ' +
      'this session). It starts idle: give it its task with send_message(expectReply=true). It reports back ' +
      'with a message that wakes you.',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME,
        model: MODEL,
        cwd: { type: 'string', description: 'Working directory: this session\'s directory (default) or a subdirectory.' },
        thinking: { type: 'string', enum: ['off', 'minimal', 'low', 'medium', 'high'] },
        separate_window: WINDOW,
      },
      required: ['name', 'model'],
    },
    needsId: true,
    build: (a, id) => ({
      argv: [
        'spawn', '--as', id, '--name', text(a, 'name'), '--model', text(a, 'model'),
        ...(optText(a, 'cwd') ? ['--cwd', optText(a, 'cwd') as string] : []),
        ...(optText(a, 'thinking') ? ['--thinking', optText(a, 'thinking') as string] : []),
        ...(a.separate_window === true ? ['--window'] : []),
      ],
      timeoutMs: SPAWN,
    }),
  },
  {
    name: 'spawn_readonly_worker',
    description:
      'Spawn a read-only pi worker that can only read, grep, find and ls files and message you. ' +
      'Use it for research and investigation. Give it its task with send_message(expectReply=true).',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME,
        model: MODEL,
        cwd: { type: 'string', description: 'Working directory: this session\'s directory (default) or a subdirectory.' },
      },
      required: ['name', 'model'],
    },
    needsId: true,
    build: (a, id) => ({
      argv: [
        'spawn', '--as', id, '--readonly', '--name', text(a, 'name'), '--model', text(a, 'model'),
        ...(optText(a, 'cwd') ? ['--cwd', optText(a, 'cwd') as string] : []),
      ],
      timeoutMs: SPAWN,
    }),
  },
  {
    name: 'spawn_team_lead',
    description:
      'Spawn an independent peer pi lead in an existing folder, anywhere on disk. It does not join your team ' +
      'and you cannot close it. Talk to it with send_message(recipient=<id>).',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Existing directory for the new lead; a leading ~ expands.' },
        model: { type: 'string', description: 'Fully qualified provider/model. Omit for pi\'s default.' },
        separate_window: WINDOW,
      },
      required: ['folder'],
    },
    needsId: true,
    build: (a, id) => ({
      argv: [
        'spawn-lead', '--as', id, '--folder', text(a, 'folder'),
        ...(optText(a, 'model') ? ['--model', optText(a, 'model') as string] : []),
        ...(a.separate_window === true ? ['--window'] : []),
      ],
      timeoutMs: SPAWN,
    }),
  },
  {
    name: 'close_worker',
    description: 'Close one of your own workers by its 8-character id or its name.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Worker id or name.' } },
      required: ['agent'],
    },
    needsId: true,
    build: (a, id) => ({ argv: ['close', '--as', id, '--', text(a, 'agent')], timeoutMs: SHORT }),
  },
  {
    name: 'close_all_workers',
    description: 'Close every worker you spawned.',
    inputSchema: { type: 'object', properties: {} },
    needsId: true,
    build: (_a, id) => ({ argv: ['close', '--as', id, '--all'], timeoutMs: SHORT }),
  },
]
