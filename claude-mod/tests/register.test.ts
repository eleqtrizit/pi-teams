import { expect, mock, test } from 'claude-code/testing'

const ID = 'abcd1234'
const READY = JSON.stringify({ type: 'ready', id: ID, cwd: '/work', adopted: [] }) + '\n'
const NEVER = 1e12

const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'message',
    message: {
      id: 'm1',
      from: 'wrkeraa1',
      to: ID,
      fromLabel: 'Worker alice in /work',
      subject: 'done',
      text: 'All finished.',
      timestamp: '2026-11-03T18:13:29.071Z',
      expectReply: false,
      ...over,
    },
  }) + '\n'

type Stdout = { stream: 'stdout' | 'stderr'; text: string }

/**
 * Stand in for the engine: every call the mod makes is answered and recorded.
 * `listener` scripts what `pi-teams listen` prints, then holds the child open.
 */
function stubEngine(
  on: Parameters<Parameters<typeof test>[1]>[1],
  clock: ReturnType<typeof mock.clock>,
  listener: (Stdout | { wait: number })[],
  exit: { code: number | null } | undefined = undefined,
  runDeny: string | undefined = undefined,
) {
  const seen = {
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    registered: [] as string[],
    spawned: [] as string[][],
    runs: [] as { argv: readonly string[]; stdin?: string }[],
    prompts: [] as string[],
    runStdout: '{"delivered":[{"id":"wrkeraa1","name":"alice"}],"failed":[]}',
    dropFirstPrompt: false,
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => (seen.registered.push(e.name), { value: { tool: `mcp__pi-teams__${e.name}` } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', (_, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.status', (_, e) => (seen.statuses.push(e.text), { value: undefined }))
  on('process.run', (_, e) => {
    seen.runs.push({ argv: e.argv, stdin: (e.init as { stdin?: string } | undefined)?.stdin })
    if (runDeny) return { deny: runDeny }
    return { value: { exitCode: 0, stdout: seen.runStdout, stderr: '' } }
  })
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    if (seen.dropFirstPrompt && seen.prompts.length === 1) {
      return { drop: 'the session was stopped and nobody has sent input since' }
    }
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('process.spawn', async function* (_, e) {
    seen.spawned.push([...e.argv])
    for (const step of listener) {
      if ('wait' in step) await clock.sleep(step.wait)
      else yield step
    }
    if (exit) return { value: { code: exit.code, signal: null } }
    await clock.sleep(NEVER)
    return { value: { code: 0, signal: null } }
  })
  return seen
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

test('connects as a lead, registers the tools, and wakes the model on a message', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [
    { stream: 'stdout', text: READY },
    { wait: 10 },
    { stream: 'stdout', text: message({ expectReply: true }) },
  ])

  await $.session.start(START)
  await clock.advance(1)

  expect(seen.registered).toEqual([
    'send_message', 'list_agents', 'get_models', 'spawn_teammate',
    'spawn_readonly_worker', 'spawn_team_lead', 'close_worker', 'close_all_workers',
  ])
  expect(seen.spawned).toEqual([['pi-teams', 'listen', '--cwd', '/work', '--client', 'Claude Code']])
  expect(seen.toasts).toContain(`pi-teams: connected as ${ID}`)

  await clock.advance(10)
  expect(seen.prompts).toEqual([]) // held for the batch window
  await clock.advance(300)
  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('**From:** Worker alice in /work (wrkeraa1)')
  expect(seen.prompts[0]).toContain(`**To:** You (${ID})`)
  expect(seen.prompts[0]).toContain('Reply expected: yes.')
  expect(seen.prompts[0]).toContain('All finished.')
})

test('messages that arrive together are delivered as one turn', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [
    { stream: 'stdout', text: READY },
    { stream: 'stdout', text: message({ id: 'a', text: 'first' }) + message({ id: 'b', text: 'second' }) },
  ])

  await $.session.start(START)
  await clock.advance(1)
  await clock.advance(300)

  expect(seen.prompts).toHaveLength(1)
  expect(seen.prompts[0]).toContain('Multiple pi-teams messages were delivered')
  expect(seen.prompts[0]).toContain('first')
  expect(seen.prompts[0]).toContain('second')
})

test('a model tool call runs the CLI as this lead, with the body on stdin', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY }])

  await $.session.start(START)
  await clock.advance(1)
  const out = await $.tool.call({
    tool: 'mcp__pi-teams__send_message',
    recipient: 'alice',
    subject: 'go',
    content: 'do the thing',
    expectReply: true,
  })

  expect(out).toEqual({ result: seen.runStdout })
  expect(seen.runs).toEqual([
    {
      argv: ['pi-teams', 'send', '--as', ID, '--subject', 'go', '--expect-reply', '--', 'alice'],
      stdin: 'do the thing',
    },
  ])
})

test('a bad tool argument comes back as a readable error, and the CLI is not run', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY }])

  await $.session.start(START)
  await clock.advance(1)
  const out = await $.tool.call({ tool: 'mcp__pi-teams__send_message', recipient: 'alice', subject: 's', content: 'c' })

  expect(out).toEqual({ result: 'Error: "expectReply" is required and must be true or false.' })
  expect(seen.runs).toEqual([])
})

test('a failed version check is told to the model and the listener is not restarted', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(
    on,
    clock,
    [{ stream: 'stderr', text: 'pi-teams: /x/version.txt is missing, so pi-teams has not run in pi on this machine.\n' }],
    { code: 3 },
  )

  await $.session.start(START)
  await clock.advance(1)
  await clock.advance(60_000)

  expect(seen.spawned).toHaveLength(1)
  expect(seen.statuses.at(-1)).toContain('version.txt is missing')
  const out = await $.tool.call({ tool: 'mcp__pi-teams__list_agents' })
  expect(out).toEqual({ result: expect.stringContaining('Error: /x/version.txt is missing') })
  expect(seen.runs).toEqual([])
})

test('a listener that crashes is restarted with a pause, then left stopped', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stderr', text: 'boom\n' }], { code: 1 })

  await $.session.start(START)
  await clock.advance(1)
  expect(seen.spawned).toHaveLength(1)
  await clock.advance(2000)
  expect(seen.spawned).toHaveLength(2)
  await clock.advance(4000)
  expect(seen.spawned).toHaveLength(3)
  await clock.advance(6000)
  expect(seen.spawned).toHaveLength(4)
  await clock.advance(60_000)
  expect(seen.spawned).toHaveLength(4) // MAX_RESTARTS reached
  expect(seen.statuses.at(-1)).toContain('boom')
})

test('a missing CLI is reported with the install command', async ($, on) => {
  const clock = mock.clock(on)
  stubEngine(on, clock, [{ stream: 'stdout', text: READY }], undefined, 'spawn pi-teams ENOENT')

  await $.session.start(START)
  const out = await $.tool.call({ tool: 'mcp__pi-teams__get_models' })

  expect(out.result).toContain('cannot run "pi-teams"')
  expect(out.result).toContain('npm i -g @eleqtrizit/pi-teams-cli')
})

test('a message the engine declines is resubmitted at the next turn end', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY + message() }])
  seen.dropFirstPrompt = true

  await $.session.start(START)
  await clock.advance(1)
  await clock.advance(300)
  expect(seen.prompts).toHaveLength(1)

  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null })
  await clock.advance(1)
  expect(seen.prompts).toHaveLength(2)
  expect(seen.prompts[1]).toBe(seen.prompts[0])
})

test('turns publish busy and idle for list_agents', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY }])

  await $.session.start(START)
  await clock.advance(1)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, usage: null })

  expect(seen.runs.map(r => r.argv.slice(1))).toEqual([
    ['state', '--as', ID, 'busy'],
    ['state', '--as', ID, 'idle'],
  ])
})

test('/pi-teams shows the connection and the reachable agents', async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY }])
  seen.runStdout = `Claude Code in /work: ${ID}: Idling (you)`

  const before = await $.command.run({ command: 'pi-teams', args: '' })
  expect(before.text).toContain('not connected')

  await $.session.start(START)
  await clock.advance(1)
  const after = await $.command.run({ command: 'pi-teams', args: '' })
  expect(after.text).toContain(`connected as ${ID} (Claude Code)`)
  expect(after.text).toContain('Idling (you)')
})

test('the configured CLI path and client name are used', { options: { cli_path: '/opt/pt', client_name: 'Claude (laptop)' } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stubEngine(on, clock, [{ stream: 'stdout', text: READY }])

  await $.session.start(START)
  await clock.advance(1)

  expect(seen.spawned).toEqual([['/opt/pt', 'listen', '--cwd', '/work', '--client', 'Claude (laptop)']])
})
