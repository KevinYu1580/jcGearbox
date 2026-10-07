import { describe, expect, test } from 'claude-code/testing'

import { AUTO, EASY, STRONG, command, firstStrongThenContinue, start, switchModel, turn, world } from './world.ts'

const HAIKU = 'claude-haiku-4-5-20251001'

// Jev answers only the questions it was asked.
const answering = (reply: any) => (body: any) => ({
  answers: Object.fromEntries(Object.entries(reply.answers).filter(([q]) => q in body.questions)),
})

const COMPLAINT = {
  answers: {
    effort: { type: 'score', score: 0.2 },
    continuation: { type: 'noul', noul: 0.9 },
    escalate: { type: 'noul', noul: 0.9 },
    high_stakes: { type: 'noul', noul: 0.05 },
  },
}
// The first turn picks `first`'s tier at xhigh; every later turn complains.
const xhighThenComplaints = (first: any) => (body: any) =>
  body.questions.tier ? { answers: { ...first.answers, effort: { type: 'score', score: 3 } } } : COMPLAINT

describe('model switches', () => {
  test('a switch clears a pin', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await command($, 'pin sonnet')
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', HAIKU)
    await turn($, 'ok', 't2', { models: [HAIKU], effort: null })
    expect(w.steps.at(-1)?.model).toBe(HAIKU)
    expect((await command($, '')).text).toContain('model: your choice (/model)')
  })

  test('a switch to the model already in use is ignored', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', 'claude-sonnet-5-5')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("the engine's fallback switch is not the person's", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', HAIKU, 'auto')
    await turn($, 'ok', 't2', { models: [HAIKU] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("a resume restoring the model is not the person's switch", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', HAIKU, 'resume')
    await turn($, 'ok', 't2', { models: [HAIKU] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })
})

describe('/jcmr auto', () => {
  test('clears a model switch and an effort pin', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: 'low' })
    await switchModel($, 'claude-sonnet-5-5', HAIKU)
    await command($, 'auto')
    await turn($, 'go on', 't3', { models: [HAIKU], effort: 'low' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('an effort set before it does not pin again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: 'low' })
    await command($, 'auto')
    await turn($, 'go on', 't3', { effort: 'medium' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

describe('the effort baseline', () => {
  test('restarts when the person switches model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5')
    await turn($, 'ok', 't2', { models: ['claude-opus-5-5'], effort: 'xhigh' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).not.toContain('effort pinned')
  })

  test('restarts on a new engine model with no switch event', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { models: ['claude-opus-4-7'], effort: 'xhigh' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).not.toContain('effort pinned')
  })

  test('a switch between a scheduled turn and the first user turn pins neither model nor effort', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'nightly check', 't0', { origin: 'scheduled-trigger' })
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5')
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'], effort: 'xhigh' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·high')
  })
})

describe('/jcmr pin', () => {
  test('refuses a model the API did not answer as', AUTO, async ($, on) => {
    world(on, { reply: STRONG, answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, 'pin opus')).text).toContain('not pinning')
    expect((await command($, '')).text).toContain('model: claude-opus-5-5 (chosen on the first turn; not served')
  })
})

describe('third-party login', () => {
  test('an alias cannot be pinned', AUTO, async ($, on) => {
    world(on, { thirdParty: true })
    await start($)
    expect((await command($, 'pin opus')).text).toBe('jcmr: cannot resolve "opus" here; give a full model id.')
  })

  test('a full model id pins', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, thirdParty: true })
    await start($)
    await command($, 'pin claude-opus-5-5')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('the alias tiers are off, so no tier question is asked', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, thirdParty: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
  })
})

describe("Jev's previous model", () => {
  test('is the pinned model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await command($, 'pin sonnet')
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'] })
    await turn($, 'ok', 't2', { models: ['claude-opus-5-5'] })
    expect(w.asked[1].state.previous.model).toBe('claude-sonnet-5-5')
  })

  test("is the engine's model after the person switches", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', HAIKU)
    await turn($, 'ok', 't2', { models: [HAIKU], effort: null })
    expect(w.asked[1].state.previous.model).toBe(HAIKU)
  })

  test("and effort are what the last turn ran at once the person pinned the effort", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    await turn($, 'ok', 't2', { effort: 'max' })
    await turn($, 'go on', 't3', { effort: 'max' })
    expect(w.asked[2].state.previous).toEqual({ model: 'claude-opus-5-5', effort: 'max' })
  })
})

describe('the try /jcmr pin opus note', () => {
  test('shows on sonnet only once a complaint finds the effort already at max', AUTO, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(EASY) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2')
    expect(w.status.at(-1)).toBe('jcmr ▸ sonnet-5-5·max')
    await turn($, 'still failing again', 't3')
    expect(w.status.at(-1)).toBe('jcmr ▸ sonnet-5-5·max · try /jcmr pin opus')
  })

  test('never shows on opus', AUTO, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(STRONG) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2')
    await turn($, 'still failing again', 't3')
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·max')
  })

  test('with a lower max_effort, shows once a complaint finds the effort at that ceiling', { options: { default_mode: 'auto', max_effort: 'xhigh' } }, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(EASY) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    expect(w.status.at(-1)).toBe('jcmr ▸ sonnet-5-5·xhigh · try /jcmr pin opus')
  })

  test("shows when the person's own effort is max", AUTO, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(EASY) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2', { effort: 'max' })
    expect(w.status.at(-1)).toBe('jcmr ▸ sonnet-5-5·max · effort pinned · try /jcmr pin opus')
  })
})

describe('/jcmr log', () => {
  test('n lists the latest n decisions', async ($, on) => {
    world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'one', 't1')
    await turn($, 'two', 't2')
    await turn($, 'three', 't3')
    const lines = (await command($, 'log 2')).text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"two"')
    expect(lines[1]).toContain('"three"')
  })

  test('a count that is not positive falls back to the default', async ($, on) => {
    world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'one', 't1')
    await turn($, 'two', 't2')
    await turn($, 'three', 't3')
    expect((await command($, 'log -3')).text.split('\n')).toHaveLength(3)
  })
})

describe('a model that is not served', () => {
  test('a rewritten request with no response at all is not switched to again', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noResponseFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error' })
    expect(w.status.at(-1)).toBe('jcmr: opus-5-5 was not used (no response); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('a request with no response that the engine retries and the turn survives keeps the model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseOnce: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'] })
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a turn that ended otherwise than in an error blames no model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'aborted' })
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('an error after a retried request got through blames no model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseOnce: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'], reason: 'error' })
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })
})

describe('tiers that all resolve to one model', () => {
  test('ask no tier question and keep the engine model', { options: { default_mode: 'auto', low_model: 'sonnet', strong_model: 'sonnet', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { reply: answering(STRONG) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'] })
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test('off turns a tier off', { options: { default_mode: 'auto', low_model: 'off', balanced_model: 'OFF', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { reply: answering(STRONG) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
  })
})
