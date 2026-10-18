import { describe, expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { AUTO, CONTINUE, EASY, STRONG, command, firstStrongThenContinue, run, start, switchModel, turn, world } from './world.ts'
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

  test("a resumed session's first turn takes the engine's effort as it finds it, not as the person's change", AUTO, async ($, on) => {
    const w = world(on, {
      reply: CONTINUE,
      store: {
        'session:session-1': {
          decided: true,
          model: 'claude-opus-5-5',
          effort: 'xhigh',
          rawEffort: 'medium',
          rawModel: 'claude-sonnet-5-5',
        },
      },
    })
    await start($)
    await turn($, 'ok', 't1', { effort: 'high' })
    await turn($, 'go on', 't2', { effort: 'high' })
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    expect((await command($, '')).text).not.toContain('effort: yours')
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

  test('a model switch while the decision is being written down is kept', AUTO, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let holding = false
    const w = world(on, { reply: firstStrongThenContinue, storeHolds: key => (holding && key.startsWith('log:') ? held : undefined) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    holding = true
    const t2 = turn($, 'ok', 't2')
    await w.clock.settle()
    const switched = switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'command')
    await w.clock.settle()
    holding = false
    release()
    await Promise.all([t2, switched])
    await turn($, 'go on', 't3', { models: ['claude-haiku-4-5-20251001'] })
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
  })

  // A hook above that settles first abandons the ones below, as the person interrupting does.
  const interrupter: Plugin = {
    name: 'interrupter',
    tier: 'prepend',
    register(on) {
      on('turn.step', async function* ($, e, next) {
        if (e.turnId !== 't1') return yield* next(e)
        void next(e).next()
        await $.clock.sleep(10)
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      })
    },
  }

  test('an interruption while Jev is answering decides nothing', { plugins: [interrupter], options: { default_mode: 'auto' } }, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const w = world(on, { reply: STRONG, gate: body => (w.asked.length === 1 ? held : undefined) })
    await start($)
    const t1 = turn($, 'redesign the sync engine', 't1')
    await w.clock.settle()
    await w.clock.advance(10)
    await t1
    release()
    await w.clock.settle()
    expect(w.db.get('session:session-1')).toBeUndefined()
    expect(w.status.join('\n')).not.toContain('Jev timeout')
    await turn($, 'redesign the sync engine', 't2')
    expect(w.asked[1].questions.tier).toBeDefined()
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
  test("its own model, as SessionStart names it, tells /model naming it for the person's choice", AUTO, async ($, on) => {
    const w = world(on, { model: 'claude-opus-5-5', reply: CONTINUE, store: { 'session:session-2': { decided: true, model: 'claude-opus-5-5' } } })
    await start($)
    await $.classic.SessionStart({ source: 'resume', session_id: 'session-2', model: 'claude-sonnet-5-5' })
    w.session = 'session-2'
    await run($, 'model', 'sonnet')
    await turn($, 'continue', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await command($, '')).text).toContain('model: your choice (/model)')
  })

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

  test("the person's /effort before a fork's first prompt is theirs", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await run($, 'effort', 'max')
    await turn($, 'now the tests', 't2', { effort: 'max' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
    expect((await command($, '')).text).toContain('effort: yours (you changed it)')
  })

  test("/effort auto before a fork's first prompt keeps the router's level: the parent's last level is not the fork's", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    const REPLY2 = 'The tests for the sync engine now cover every peer path. '.repeat(6)
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await run($, 'effort', 'max')
    await turn($, 'go on', 't2', { effort: 'max', answer: REPLY2 })
    await goOn($, w, 'fork', forked(said('user', 'go on'), said('assistant', REPLY2), said('user', 'now the tests')))
    await run($, 'effort', 'auto')
    await turn($, 'now the tests', 't3', { effort: 'medium' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test("the person's switch in the picker before a fork's first prompt is theirs", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'picker')
    await turn($, 'now the tests', 't2', { models: ['claude-haiku-4-5-20251001'] })
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
    expect((await command($, '')).text).toContain('model: your choice (/model)')
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

  test("a fork's /jcGearbox-auto before its first prompt clears the pin it carries over", AUTO, async ($, on) => {
    const w = world(on, { reply: answers(STRONG, CONTINUE) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: REPLY })
    await command($, 'pin sonnet')
    await goOn($, w, 'fork', forked(said('user', 'now the tests')))
    await command($, 'auto')
    await turn($, 'now the tests', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("a fork's own /jcGearbox-off before its first prompt wins over the mode it carries over", async ($, on) => {
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
    expect((await command($, '')).text).not.toContain('effort: yours')
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
    expect(w.status.at(-1)).toBe('auto')
    expect(keys(w, 'log:')).toHaveLength(200)
  })
})

describe('status line', () => {
  test('auto by default shows jcGearbox at start', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.status).toEqual(['auto'])
  })

  test('a session turned off shows nothing at start, whatever the default', async ($, on) => {
    const w = world(on, { store: { 'session:session-1': { mode: 'off' } } })
    await start($)
    expect(w.status).toEqual([undefined])
  })

  test("a session's own auto without a key says so at start, even when the default is off", { options: { default_mode: 'off' } }, async ($, on) => {
    const w = world(on, { noKey: true, store: { 'session:session-1': { mode: 'auto' } } })
    await start($)
    expect(w.status).toEqual(['no API key'])
  })

  test('/jcGearbox off clears the status line', AUTO, async ($, on) => {
    const w = world(on)
    await start($)
    await command($, 'off')
    expect(w.status).toEqual(['auto', undefined])
  })

  test('/jcGearbox auto after a shadow turn shows jcGearbox', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.status.at(-1)).toBe('shadow ▸ opus-5-5·high')
    await command($, 'auto')
    expect(w.status.at(-1)).toBe('auto')
  })
})
