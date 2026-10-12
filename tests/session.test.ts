import { describe, expect, test } from 'claude-code/testing'

import { AUTO, CONTINUE, EASY, STRONG, command, firstStrongThenContinue, start, switchModel, turn, world } from './world.ts'
import type { World } from './world.ts'

const keys = (w: World, prefix: string) => [...w.db.keys()].filter(k => k.startsWith(prefix))
const records = (prefix: string, n: number, value: unknown = {}) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(3, '0')}`, value]))
const answers = (...replies: unknown[]) => {
  let n = 0
  return (body: any) => {
    const reply = replies[Math.min(n++, replies.length - 1)]
    return typeof reply === 'function' ? reply(body) : reply
  }
}

describe('session decisions', () => {
  test('a resumed session keeps its model and effort', AUTO, async ($, on) => {
    const w = world(on, {
      reply: CONTINUE,
      store: {
        'session:session-1': {
          decided: true,
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          rawEffort: 'high',
          rawModel: 'claude-sonnet-5-5',
        },
      },
    })
    await start($)
    await turn($, 'ok', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'xhigh' }])
  })

  test('a new session id decides its model again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    w.session = 'session-2'
    await turn($, 'redesign the sync engine', 't2')
    expect(w.asked[1].questions.tier).toBeDefined()
  })

  test('the choice made in shadow applies as soon as the session turns auto', async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    await command($, 'auto')
    await turn($, 'ok', 't2')
    expect(w.asked[1].questions.tier).toBeUndefined()
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('a failed first turn leaves the model to the engine for the rest of the session', AUTO, async ($, on) => {
    const w = world(on, { reply: answers('x', firstStrongThenContinue) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'redesign the sync engine', 't2')
    expect(w.asked[1].questions.tier).toBeUndefined()
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test('after a failed first turn, a continuation keeps the effort the engine ran it at', AUTO, async ($, on) => {
    const w = world(on, { reply: answers('x', CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok go ahead', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('a Jev error before any effort was decided leaves the engine effort as it is', { options: { default_mode: 'auto', max_effort: 'xhigh' } }, async ($, on) => {
    const w = world(on, { reply: 'x' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'max' })
    await turn($, 'ok', 't2', { effort: 'max' })
    expect(w.steps.map(s => s.effort)).toEqual(['max', 'max'])
  })

  test('a later Jev error keeps the model and the previous effort, and says why', AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, 'x') })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    await turn($, 'ok', 't2', { effort: 'medium' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).toContain('Jev unreadable answer')
  })

  test('a model switch while Jev is answering is kept', AUTO, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const w = world(on, { reply: firstStrongThenContinue, gate: body => (body.questions.tier ? undefined : held) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const t2 = turn($, 'ok', 't2')
    await w.clock.settle()
    expect(w.asked).toHaveLength(2)
    await switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'command')
    release()
    await t2
    await turn($, 'go on', 't3', { models: ['claude-haiku-4-5-20251001'] })
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
    expect((await command($, '')).text).toContain('your choice (/model)')
  })
})

const REPLY = 'The sync engine now batches writes per peer. '.repeat(6)
const said = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] as [] })
const forked = (...more: World['messages']) => [said('user', 'redesign the sync engine'), said('assistant', REPLY), ...more]

// As the engine does: SessionStart names the new id, then the session goes on under it.
async function goOn($: any, w: World, source: 'resume' | 'fork', messages: World['messages'] = []) {
  await $.classic.SessionStart({ source, session_id: 'session-2' })
  w.session = 'session-2'
  w.messages = messages
}

describe('a conversation that goes on under a new id', () => {
  test('a resumed conversation with no record of it keeps the model it has', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await goOn($, w, 'resume')
    await turn($, 'continue', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
  })

  test('a fork goes on as the session it came from', AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, (body: any) => (body.questions.tier ? EASY : CONTINUE)) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await turn($, 'now the tests', 't2')
    expect(w.asked[1].questions.tier).toBeUndefined()
    expect(w.asked[1].state.previous_prompt).toBe('redesign the sync engine')
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test("a fork finds its session past a long reply that names none", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE, (body: any) => (body.questions.tier ? EASY : CONTINUE)) })
    const between = 'Running the whole suite first, then the flaky sync tests one at a time. '.repeat(3)
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await turn($, 'run the tests', 't2', { answer: 'All green.' })
    await goOn(
      $,
      w,
      'fork',
      forked(said('user', 'run the tests'), said('assistant', between), said('assistant', 'All green.'), said('user', 'now the docs')),
    )
    await turn($, 'now the docs', 't3')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("a fork's /jcmr-auto before its first prompt clears the pin it carries over", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await command($, 'pin sonnet')
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await command($, 'auto')
    await turn($, 'now the tests', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("a fork's own /jcmr-off before its first prompt wins over the mode it carries over", async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await command($, 'auto')
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await command($, 'off')
    await turn($, 'now the tests', 't2')
    expect(w.asked).toHaveLength(1)
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test("a fork does not take its engine effort for a change from the last one of its session", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY, effort: 'medium' })
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await turn($, 'now the tests', 't2', { effort: 'high' })
    expect(w.status.at(-1)).not.toContain('effort pinned')
  })

  test('keeps no more than 200 replies to know forks by, dropping the oldest', AUTO, async ($, on) => {
    const store: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) store[`fork:${String(i).padStart(16, '0')}`] = 'old'
    const w = world(on, { reply: STRONG, store })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    expect(keys(w, 'fork:')).toHaveLength(200)
    expect(w.db.has('fork:0000000000000000')).toBe(false)
  })
})

describe('storage', () => {
  test('one long session keeps no more than 200 decisions', AUTO, async ($, on) => {
    const store: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) store[`log:${1000 + i}:session-:${i}`] = { at: 1000 + i }
    const w = world(on, { reply: firstStrongThenContinue, store })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    const logs = [...w.db.keys()].filter(k => k.startsWith('log:'))
    expect(logs).toHaveLength(200)
    expect(logs[0]).toBe('log:1002:session-:2')
  })

  test('pruning at start keeps the current session even when its record is the oldest', AUTO, async ($, on) => {
    const w = world(on, {
      reply: CONTINUE,
      store: {
        'session:session-1': { decided: true, model: 'claude-opus-5-5' },
        ...records('session:other-', 200, { decided: true }),
        ...records('log:', 201),
      },
    })
    await start($)
    expect(keys(w, 'session:')).toHaveLength(200)
    expect(w.db.has('session:other-000')).toBe(false)
    expect(w.db.has('session:other-001')).toBe(true)
    expect(keys(w, 'log:')).toHaveLength(200)
    expect(w.db.has('log:000')).toBe(false)
    await turn($, 'ok', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps[0]?.model).toBe('claude-opus-5-5')
  })

  test('saving a session makes it the most recent', AUTO, async ($, on) => {
    const w = world(on, {
      reply: STRONG,
      store: { 'session:session-1': {}, ...records('session:other-', 199) },
    })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    w.session = 'session-new'
    w.db.set('session:extra', {})
    await start($)
    expect(w.db.has('session:session-1')).toBe(true)
    expect(w.db.has('session:other-000')).toBe(false)
    expect(w.db.has('session:other-001')).toBe(false)
    expect(w.db.has('session:other-002')).toBe(true)
  })

  test("a /clear shows the new session's mode and prunes", AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    await command($, 'off')
    w.session = 'session-2'
    for (const [k, v] of Object.entries(records('log:', 201))) w.db.set(k, v)
    await $.classic.SessionStart({ source: 'clear' })
    expect(w.status.at(-1)).toBe('jcmr')
    expect(keys(w, 'log:')).toHaveLength(200)
  })
})

describe('status line', () => {
  test('auto by default shows jcmr at start', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.status).toEqual(['jcmr'])
  })

  test('a session turned off shows nothing at start, whatever the default', async ($, on) => {
    const w = world(on, { store: { 'session:session-1': { mode: 'off' } } })
    await start($)
    expect(w.status).toEqual([undefined])
  })

  test("a session's own auto without a key says so at start, even when the default is off", { options: { default_mode: 'off' } }, async ($, on) => {
    const w = world(on, { noKey: true, store: { 'session:session-1': { mode: 'auto' } } })
    await start($)
    expect(w.status).toEqual(['jcmr: no API key'])
  })

  test('/jcmr off clears the status line', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    await command($, 'off')
    expect(w.status).toEqual(['jcmr', undefined])
  })

  test('/jcmr auto after a shadow turn shows jcmr', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ sonnet-5-5·high · jev opus-5-5·high')
    await command($, 'auto')
    expect(w.status.at(-1)).toBe('jcmr')
  })
})
