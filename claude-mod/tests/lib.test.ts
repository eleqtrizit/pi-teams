import { expect, test } from 'claude-code/testing'

import { TOOLS, formatDelivered, parseListenerLine, splitLines } from '../hooks/lib'
import type { TeamMessage } from '../hooks/lib'

const msg = (over: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'm1',
  from: 'wrkeraa1',
  to: 'leadaaaa',
  fromLabel: 'Worker alice in /w/a',
  subject: 'done',
  text: 'All finished.',
  timestamp: '2026-11-03T18:13:29.071Z',
  ...over,
})

const tool = (name: string) => {
  const found = TOOLS.find(t => t.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

test('splitLines keeps a partial line for the next chunk', () => {
  const first = splitLines('', '{"a":1}\n{"b"')
  expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  expect(splitLines(first.rest, ':2}\n\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
})

test('parseListenerLine reads ready and message lines and ignores the rest', () => {
  expect(parseListenerLine('{"type":"ready","id":"abcd1234","cwd":"/w","adopted":["x"]}')).toEqual({
    type: 'ready',
    id: 'abcd1234',
    cwd: '/w',
    adopted: ['x'],
  })
  const m = msg()
  expect(parseListenerLine(JSON.stringify({ type: 'message', message: m }))).toEqual({ type: 'message', message: m })
  expect(parseListenerLine('not json')).toBeUndefined()
  expect(parseListenerLine('{"type":"message","message":{"id":1}}')).toBeUndefined()
  expect(parseListenerLine('{"type":"other"}')).toBeUndefined()
})

test('formatDelivered tells the model who wrote and how to answer', () => {
  const text = formatDelivered([msg({ expectReply: true })], 'leadaaaa')
  expect(text).toContain('**From:** Worker alice in /w/a (wrkeraa1)')
  expect(text).toContain('**To:** You (leadaaaa)')
  expect(text).toContain('Reply expected: yes. Answer with mcp__pi-teams__send_message(recipient="wrkeraa1", expectReply=false).')
  expect(text).toContain('**Timestamp:** 2026-11-03 18:13:29')
  expect(text.endsWith('All finished.')).toBe(true)
})

test('formatDelivered says no reply is expected unless asked, and wraps several messages', () => {
  expect(formatDelivered([msg()], 'leadaaaa')).toContain('Reply expected: no.')
  const many = formatDelivered([msg({ id: 'a' }), msg({ id: 'b', text: 'second' })], 'leadaaaa')
  expect(many).toContain('Multiple pi-teams messages were delivered')
  expect(many).toContain('<delivered-message index="2">')
  expect(many).toContain('second')
  expect(formatDelivered([], 'leadaaaa')).toBe('')
})

test('every tool has a schema whose required fields the build step enforces', () => {
  expect(TOOLS.map(t => t.name)).toEqual([
    'send_message', 'list_agents', 'get_models', 'spawn_teammate',
    'spawn_readonly_worker', 'spawn_team_lead', 'close_worker', 'close_all_workers',
  ])
  for (const t of TOOLS) expect((t.inputSchema as { type: string }).type).toBe('object')
})

test('send_message passes the body on stdin and puts the recipient after --', () => {
  const inv = tool('send_message').build(
    { recipient: '-rf', subject: 'S', content: 'body text', expectReply: true, summary: 'sum' },
    'leadaaaa',
  )
  expect(inv.argv).toEqual(['send', '--as', 'leadaaaa', '--subject', 'S', '--expect-reply', '--summary', 'sum', '--', '-rf'])
  expect(inv.stdin).toBe('body text')
  expect(tool('send_message').build({ recipient: 'a', subject: 'S', content: 'c', expectReply: false }, 'x').argv).not.toContain(
    '--expect-reply',
  )
})

test('send_message rejects missing fields with a readable error', () => {
  expect(() => tool('send_message').build({ recipient: 'a', subject: 'S', content: 'c' }, 'x')).toThrow(/expectReply/)
  expect(() => tool('send_message').build({ recipient: '', subject: 'S', content: 'c', expectReply: true }, 'x')).toThrow(/recipient/)
})

test('spawn tools build the CLI flags', () => {
  expect(
    tool('spawn_teammate').build({ name: 'alice', model: 'p/m', cwd: 'sub', thinking: 'high', separate_window: true }, 'leadaaaa').argv,
  ).toEqual(['spawn', '--as', 'leadaaaa', '--name', 'alice', '--model', 'p/m', '--cwd', 'sub', '--thinking', 'high', '--window'])
  expect(tool('spawn_readonly_worker').build({ name: 'scout', model: 'p/m' }, 'leadaaaa').argv).toEqual([
    'spawn', '--as', 'leadaaaa', '--readonly', '--name', 'scout', '--model', 'p/m',
  ])
  expect(tool('spawn_team_lead').build({ folder: '~/repo', model: 'p/m' }, 'leadaaaa').argv).toEqual([
    'spawn-lead', '--as', 'leadaaaa', '--folder', '~/repo', '--model', 'p/m',
  ])
  expect(() => tool('spawn_teammate').build({ name: 'alice' }, 'x')).toThrow(/model/)
  expect(tool('spawn_teammate').build({ name: 'alice', model: 'p/m' }, 'leadaaaa').stdin).toBeUndefined()
  expect(tool('spawn_teammate').build({ name: 'alice', model: 'p/m', initial_prompt: 'Fix the parser' }, 'leadaaaa')).toMatchObject({
    argv: ['spawn', '--as', 'leadaaaa', '--name', 'alice', '--model', 'p/m', '--prompt-stdin'],
    stdin: 'Fix the parser',
  })
  expect(tool('spawn_readonly_worker').build({ name: 'scout', model: 'p/m', initial_prompt: 'Map the adapters' }, 'leadaaaa')).toMatchObject({
    argv: ['spawn', '--as', 'leadaaaa', '--readonly', '--name', 'scout', '--model', 'p/m', '--prompt-stdin'],
    stdin: 'Map the adapters',
  })
})

test('list, close and models build their commands', () => {
  expect(tool('list_agents').build({ onlineOnly: true }, 'leadaaaa').argv).toEqual(['list', '--as', 'leadaaaa', '--online-only'])
  expect(tool('close_worker').build({ agent: 'alice' }, 'leadaaaa').argv).toEqual(['close', '--as', 'leadaaaa', '--', 'alice'])
  expect(tool('close_all_workers').build({}, 'leadaaaa').argv).toEqual(['close', '--as', 'leadaaaa', '--all'])
  expect(tool('get_models').needsId).toBe(false)
  expect(tool('get_models').build({}, '').argv).toEqual(['models'])
})
