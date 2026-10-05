import { describe, expect, test } from 'claude-code/testing'

import { STRONG, firstStrongThenContinue, start, turn, world } from './world.ts'

const TAIL = { options: { send_assistant_tail: true } }

describe('the Jev request', () => {
  test('is a POST to systemone with the bearer key, asking jev-latest', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.fetches).toHaveLength(1)
    expect(w.fetches[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(w.fetches[0]?.method).toBe('POST')
    expect(w.fetches[0]?.headers).toEqual({ authorization: 'Bearer test-key', 'content-type': 'application/json' })
    expect(w.fetches[0]?.body.model).toBe('jev-latest')
  })

  test('the api_key option wins over TYPESAFE_API_KEY', { options: { api_key: 'opt-key' } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.fetches[0]?.headers?.authorization).toBe('Bearer opt-key')
  })

  test('the jev_model option names the Jev model', { options: { jev_model: 'jev-1.13.0' } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.fetches[0]?.body.model).toBe('jev-1.13.0')
  })

  test('a non-user turn sends nothing', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'Background task finished', 't1', { origin: 'task-notification' })
    expect(w.steps).toHaveLength(1)
    expect(w.fetches).toEqual([])
  })
})

describe('send_assistant_tail', () => {
  test("on: the next request carries the last 1000 chars of Claude's reply", TAIL, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: `${'x'.repeat(1500)}Shall I apply?` })
    expect((w.db.get('session:session-1') as any).replyTail).toHaveLength(1000)
    await turn($, 'yes', 't2')
    const tail = w.asked[1].state.previous_reply_tail
    expect(tail).toHaveLength(1000)
    expect(tail.endsWith('Shall I apply?')).toBe(true)
  })

  test("off by default: the reply's end is not kept", async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply?' })
    await turn($, 'yes', 't2')
    expect(w.asked[1].state).not.toHaveProperty('previous_reply_tail')
    expect(w.db.get('session:session-1')).not.toHaveProperty('replyTail')
  })

  test('off by default: a tail kept earlier is not sent', async ($, on) => {
    const w = world(on, { reply: STRONG, store: { 'session:session-1': { replyTail: 'Shall I apply?' } } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked[0].state).not.toHaveProperty('previous_reply_tail')
  })

  test('on, with default_mode off: no session record is written', { options: { send_assistant_tail: true, default_mode: 'off' } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply?' })
    expect([...w.db.keys()].filter(k => k.startsWith('session:'))).toEqual([])
  })

  test('on, without a key: no session record is written', TAIL, async ($, on) => {
    const w = world(on, { reply: STRONG, noKey: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply?' })
    expect([...w.db.keys()].filter(k => k.startsWith('session:'))).toEqual([])
  })
})

describe('on disk', () => {
  const long = `${'a'.repeat(1500)}${'b'.repeat(1500)}`

  test('the session keeps a long prompt clipped to its head and tail', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, long, 't1')
    const prompt = (w.db.get('session:session-1') as any).prompt
    expect(prompt).toHaveLength(1003)
    expect(prompt).toBe(`${'a'.repeat(500)}\n…\n${'b'.repeat(500)}`)
  })

  test("the log keeps a prompt's first 200 chars and its full length", async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, long, 't1')
    const entry = [...w.db].find(([k]) => k.startsWith('log:'))?.[1] as any
    expect(entry.prompt).toBe('a'.repeat(200))
    expect(entry.promptLength).toBe(3000)
  })

  test('the catalog is read from CLAUDE_CONFIG_DIR when set', async ($, on) => {
    const w = world(on, { reply: STRONG, env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.listed).toContain('/cfg/cache/model-catalog')
    expect(w.status.at(-1)).not.toContain('built-in model table')
  })

  test('the catalog is read from $HOME/.claude otherwise', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.listed).toContain('/home/u/.claude/cache/model-catalog')
  })
})
