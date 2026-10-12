import { describe, expect, test } from 'claude-code/testing'

import { AUTO, EASY, STRONG, command, firstStrongThenContinue, run, start, switchModel, turn, world } from './world.ts'

const HAIKU = 'claude-haiku-4-5-20251001'

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

  // 'auto' is also a plan mode toggled under opusplan or haiku: not the person's.
  test("the engine's own switch is not the person's", AUTO, async ($, on) => {
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
    const lines = (await command($, 'log 2')).text.split('\n').slice(1, -1)
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
    expect((await command($, 'log -3')).text.split('\n').slice(1, -1)).toHaveLength(3)
  })

  test('shows each prompt escaped on one line, in a code block', async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, 'fix this:\n```\nboom\n```', 't1')
    const lines = (await command($, 'log')).text.split('\n')
    expect(lines).toHaveLength(3)
    expect([lines[0], lines[2]]).toEqual(['```', '```'])
    expect(lines[1]?.endsWith('  "fix this:\\n```\\nboom\\n```"')).toBe(true)
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

  test('a model that declines a rewritten request is not switched to again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, refusalFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'refusal' })
    expect(w.status.at(-1)).toBe('jcmr: opus-5-5 was not used (refused); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('a model that has answered is not blamed when a later request of it gets no response', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseAt: [1] })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { reason: 'error' })
    await turn($, 'go on', 't3')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a model that has answered is blamed once it gets no response twice in a row', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseAt: [1, 2] })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { reason: 'error' })
    await turn($, 'try again', 't3', { reason: 'error' })
    await turn($, 'go on', 't4')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('a model is blamed once however its turn went wrong', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noResponseOnce: 'claude-opus-5-5', answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'], reason: 'error' })
    expect((w.db.get('session:session-1') as any).badModels).toEqual(['claude-opus-5-5'])
  })

  test('a model that got no response and then declined is blamed once', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noResponseOnce: 'claude-opus-5-5', refusalFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'], reason: 'error' })
    expect((w.db.get('session:session-1') as any).badModels).toEqual(['claude-opus-5-5'])
  })

  test('an answer from another generation of the model is not taken for it', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, answeredAs: 'claude-opus-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.status.at(-1)).toBe('jcmr: opus-5-5 was not used (opus-5 answered); not switching to it again')
  })

  test("the model under Vertex's dated id is not blamed for answering under its API id", { options: { default_mode: 'auto', strong_model: 'claude-opus-5-5@20261001' } }, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, answeredAs: 'claude-opus-5-5-20261001' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5@20261001', 'claude-opus-5-5@20261001'])
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a model id that names no Claude model, such as a Bedrock profile ARN, is not checked', { options: { default_mode: 'auto', strong_model: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123' } }, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, answeredAs: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toContain('application-inference-profile')
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
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'] })
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test('off turns a tier off', { options: { default_mode: 'auto', low_model: 'off', balanced_model: 'OFF', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked[0].questions.tier).toBeUndefined()
  })
})

describe('the /jcmr-<action> commands', () => {
  test('are registered next to /jcmr', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.registered).toEqual(['jcmr', 'jcmr-status', 'jcmr-auto', 'jcmr-shadow', 'jcmr-off', 'jcmr-on', 'jcmr-pin', 'jcmr-log'])
  })

  test('do what /jcmr <action> does', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await run($, 'jcmr-status')).text).toBe((await command($, '')).text)
    expect((await run($, 'jcmr-pin', 'sonnet')).text).toContain('model pinned to claude-sonnet-5-5')
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await run($, 'jcmr-log', '1')).text.split('\n')).toHaveLength(3)
    expect((await run($, 'jcmr-off')).text).toBe('jcmr: off for this session.')
    await turn($, 'one more', 't3')
    expect(w.asked).toHaveLength(2)
  })

  test('each one is answered', async ($, on) => {
    const w = world(on)
    await start($)
    for (const name of w.registered) expect((await run($, name)).text).toBeDefined()
  })

  test('/jcmr-on keeps a pin', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await run($, 'jcmr-pin', 'sonnet')
    await run($, 'jcmr-off')
    expect((await run($, 'jcmr-on')).text).toBe('jcmr: auto for this session.')
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await command($, '')).text).toContain('jcmr: auto (default)')
  })

  test('/jcmr-on goes back to the default mode', async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await run($, 'jcmr-off')
    expect((await run($, 'jcmr-on')).text).toBe('jcmr: shadow for this session.')
    expect((await command($, 'on')).text).toBe('jcmr: shadow for this session.')
  })

  test('/jcmr-on turns auto on when the default mode is off', { options: { default_mode: 'off' } }, async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    expect((await run($, 'jcmr-on')).text).toBe('jcmr: auto for this session.')
  })
})

