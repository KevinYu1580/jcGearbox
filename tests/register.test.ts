import { describe, expect, test } from 'claude-code/testing'

import { AUTO, EASY, STRONG, command, drain, firstStrongThenContinue, start, switchModel, turn, world } from './world.ts'

describe('auto mode', () => {
  test('a hard first prompt moves every step of the session to the strong model', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'], effort: 'medium' })
    expect(w.steps).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.asked).toHaveLength(1)
    expect(Object.keys(w.asked[0].questions)).toEqual(['tier', 'effort', 'high_stakes'])
    expect(w.asked[0].state).toEqual({ prompt: 'redesign the sync engine' })
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·high')
  })

  test('tiers on one model pool their probability: an easy prompt goes to sonnet', { options: { default_mode: 'auto', low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'low' }])
  })

  test('an easy prompt picked for Haiku moves the session there and leaves the effort alone', AUTO, async ($, on) => {
    const LOW = { answers: { ...EASY.answers, tier: { type: 'choice', choice: 'low', probabilities: { low: 0.8, balanced: 0.1, strong: 0.1 }, confidence: 0.7 } } }
    const w = world(on, { reply: LOW })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'], effort: null })
    expect(w.steps).toEqual([{ model: 'claude-haiku-4-5-20251001' }])
  })

  test('later turns keep the model, a continuation keeps the effort, a notification asks nothing', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, '好', 't2')
    await turn($, 'Background task finished', 't3', { origin: 'task-notification' })
    expect(w.steps.map(s => `${s.model}·${String(s.effort)}`)).toEqual([
      'claude-opus-5-5·high',
      'claude-opus-5-5·high',
      'claude-opus-5-5·high',
    ])
    expect(w.asked).toHaveLength(2)
    expect(Object.keys(w.asked[1].questions)).toEqual(['effort', 'continuation', 'escalate', 'high_stakes'])
    expect(w.asked[1].state).toEqual({
      prompt: '好',
      previous_prompt: 'redesign the sync engine',
      previous: { model: 'claude-opus-5-5', effort: 'high' },
    })
  })

  test("a subagent's steps pass untouched", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await drain($.turn.step({ turnId: 'a1', index: 0, model: 'claude-haiku-4-5-20251001', messageCount: 1, agentId: 'agent-1' }))
    expect(w.steps.at(-1)).toEqual({ model: 'claude-haiku-4-5-20251001' })
  })

  test("the engine's fallback mid-turn is left alone", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-opus-4-8'], effort: 'medium' })
    expect(w.steps).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-4-8', effort: 'medium' },
    ])
  })

  test('a model the API did not answer as is not asked for again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(w.status.at(-1)).toBe('jcmr: opus-5-5 was not used (sonnet-5-5 answered); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(w.asked[1].questions.tier).toBeUndefined()
  })

  test('the built-in table stands in when the catalog cannot be read, and says so', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, catalog: null })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toContain('built-in model table')
  })
})

describe('shadow mode', () => {
  test('judges and shows, rewrites nothing', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·high')
  })

  test('/jcmr and its log show what was sent, not what Jev picked', async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, '')).text).toContain('sent: sonnet-5-5·high')
    expect((await command($, 'log')).text).toContain('opus-5-5·high  sent sonnet-5-5·high')
  })

  test('leaves a lower effort judgement unapplied too', { options: { low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5', 'claude-opus-5-5'] })
    expect(w.steps).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ sonnet-5-5·low')
  })
})

describe('failing open', () => {
  test('without a key nothing is asked or rewritten', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noKey: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('jcmr: no API key')
  })

  test('a Jev error leaves the first turn alone and says why', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, httpStatus: 401 })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toContain('Jev HTTP 401')
  })

  test('a Jev that does not answer in 3 seconds, the default, is not waited for', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, hang: true })
    await start($)
    const done = turn($, 'redesign the sync engine', 't1')
    await w.clock.settle()
    await w.clock.advance(2999)
    expect(w.steps).toHaveLength(0)
    await w.clock.advance(1)
    await done
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toContain('Jev timeout')
  })

  test('jev_timeout_seconds sets how long Jev is waited for', { options: { default_mode: 'auto', jev_timeout_seconds: 5 } }, async ($, on) => {
    const w = world(on, { reply: STRONG, hang: true })
    await start($)
    const done = turn($, 'redesign the sync engine', 't1')
    await w.clock.settle()
    await w.clock.advance(4999)
    expect(w.steps).toHaveLength(0)
    await w.clock.advance(1)
    await done
    expect(w.status.at(-1)).toContain('Jev timeout')
  })

  test('an engine older than 2.1.286 turns the router off', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, version: '2.1.284' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toContain('needs Claude Code 2.1.286')
  })
})

describe('overrides', () => {
  test('/jcmr pin forces a model; /jcmr auto hands the session back to its first-turn choice', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    const pinned = await command($, 'pin sonnet')
    expect(pinned.text).toContain('claude-sonnet-5-5')
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'] })
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    await command($, 'auto')
    await turn($, '繼續', 't2', { models: ['claude-sonnet-5-5'] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('the person switching model after the first turn stops model rewriting', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001')
    await turn($, 'ok', 't2', { models: ['claude-haiku-4-5-20251001'], effort: null })
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
  })

  test('a switch before the first turn is the starting point, not a pin', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await switchModel($, 'claude-opus-5-5', 'claude-sonnet-5-5', 'sdk')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('the person changing the effort pins it', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'high' })
    await turn($, 'ok', 't2', { effort: 'low' })
    expect(w.steps.map(s => s.effort)).toEqual(['high', 'low'])
    expect(w.status.at(-1)).toContain('effort pinned')
  })
})

describe('/jcmr', () => {
  test('reports the session and lists the log', AUTO, async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const report = await command($, '')
    expect(report.text).toContain('jcmr: auto (default)')
    expect(report.text).toContain('claude-opus-5-5 (chosen on the first turn)')
    expect(report.text).toContain('effort: high')
    expect(report.text).toContain('tier strong 0.80')
    expect(report.text).toContain('effort 2.20')
    expect(report.text).toContain('high stakes 0.10')
    expect(report.text).toContain('sent: opus-5-5·high')
    const log = await command($, 'log')
    expect(log.text).toContain('opus-5-5·high  sent opus-5-5·high')
    expect(log.text).toContain('redesign the sync engine')
  })

  test('/jcmr off turns this session off', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    expect((await command($, 'off')).text).toBe('jcmr: off for this session.')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
  })

  test('/jcmr shadow judges without rewriting, for this session only', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    expect((await command($, 'shadow')).text).toBe('jcmr: shadow for this session.')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·high')
    w.session = 'session-2'
    await turn($, 'redesign the sync engine', 't2')
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})
