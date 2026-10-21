import { describe, expect, test } from 'claude-code/testing'

import { AUTO, CONTINUE, EASY, STRONG, SURE_EASY, command, drain, firstStrongThenContinue, run, start, switchModel, turn, world } from './world.ts'

const FABLE = 'claude-fable-5-1'

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

  test("/model naming the model already in use is the person's choice too", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await run($, 'model', 'sonnet')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await command($, '')).text).toContain('model: your choice (/model)')
  })

  test('/model with no name opens the picker, and only the switch it makes counts', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await run($, 'model')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("/model opusplan is the person's choice too: its model of the moment may be the one in use, which no switch reports", AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? SURE_EASY : CONTINUE) })
    await start($)
    await command($, 'pin haiku')
    await turn($, 'rename foo to bar', 't1')
    await run($, 'model', 'opusplan')
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.model)).toEqual([HAIKU, 'claude-sonnet-5-5'])
    expect((await command($, '')).text).toContain('your choice (/model)')
  })

  test("a switch the engine refused, as its answer says, is no choice; one it made, as it says, is", AUTO, async ($, on) => {
    const answers: Record<string, string> = {
      opusplan: 'Model switch to claude-opus-5-5 was blocked by a PreModelSwitch hook',
      'opusplan[1m]': 'Sonnet with 1M context is not available for your account',
      'sonnet[1m]': 'Sonnet with 1M context is not available for your account',
      sonnet: 'Model "sonnet[1m]" is restricted by your organization\'s settings. Using sonnet instead.\nSet model to sonnet (claude-sonnet-5-5) and saved as your default for new sessions',
    }
    const w = world(on, { reply: (body: any) => (body.questions.tier ? SURE_EASY : CONTINUE), builtin: e => answers[e.args.trim()] })
    await start($)
    await command($, 'pin haiku')
    await turn($, 'rename foo to bar', 't1')
    for (const args of ['opusplan', 'opusplan[1m]', 'sonnet[1m]']) await run($, 'model', args)
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.model)).toEqual([HAIKU, HAIKU])
    await run($, 'model', 'sonnet')
    await turn($, 'go on', 't3')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await command($, '')).text).toContain('your choice (/model)')
  })

  test('/effort naming a level pins the effort, even the level in use', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : { answers: { ...COMPLAINT.answers, escalate: { type: 'noul', noul: 0.05 } } }) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'high')
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'high'])
    expect((await command($, '')).text).toContain('effort: yours')
  })

  test('/model or /effort with a word that only shows something, or no model or level, pins nothing', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await command($, 'pin haiku')
    for (const args of ['current', 'list', 'no-such-model']) await run($, 'model', args)
    for (const args of ['status', 'help', 'auto', 'unset', 'ultracode on', 'extreme']) await run($, 'effort', args)
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test('/effort auto hands the effort back: the level Claude Code drops for it pins nothing', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1', { effort: 'xhigh' })
    await run($, 'effort', 'auto')
    await turn($, 'ok', 't2', { effort: 'medium' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'low'])
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test('/effort unset after a level of your own lets the effort change again', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'high')
    await turn($, 'ok', 't2')
    await run($, 'effort', 'unset')
    await turn($, 'go on', 't3', { effort: 'medium' })
    // The continuation goes on from the level the person ran at, not from the router's idea of it.
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'high', 'high'])
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test("while the person holds the effort, the router's own idea of it is not kept", AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'max')
    await turn($, 'ok', 't2', { effort: 'max' })
    await turn($, 'and the docs', 't3', { effort: 'max' })
    expect(w.asked.at(-1).state.previous.effort).toBe('max')
    expect((await command($, '')).text).toContain('effort: yours (you changed it)')
    await run($, 'effort', 'auto')
    await turn($, 'go on', 't4', { effort: 'medium' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'max', 'max', 'max'])
    expect((await command($, '')).text).toContain('effort: max')
  })

  test('the level the router goes on from is kept within min_effort and max_effort', { options: { default_mode: 'auto', max_effort: 'high' } }, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'max')
    await turn($, 'ok', 't2', { effort: 'max' })
    await run($, 'effort', 'auto')
    // A turn nobody typed asks Jev nothing and sends the level the router holds.
    await turn($, 'a task finished', 't3', { origin: 'task-notification', effort: 'max' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'max', 'high'])
    expect((await command($, '')).text).toContain('effort: high')
  })

  test('after a number of your own, /effort auto goes on from no level in particular', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', '50')
    await turn($, 'ok', 't2', { effort: 50 as any })
    await run($, 'effort', 'auto')
    await turn($, 'go on', 't3', { effort: 'medium' })
    // Nothing of the router's to go on from: the continuation rides the engine's own level.
    expect(w.steps.map(s => s.effort)).toEqual(['low', 50, 'medium'])
  })

  test('a level taken back before any turn ran at it leaves the router where it was', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'max')
    await run($, 'effort', 'auto')
    await turn($, 'ok', 't2', { effort: 'medium' })
    await run($, 'effort', 'max')
    await run($, 'jcGearbox-auto')
    await turn($, 'go on', 't3', { effort: 'medium' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'low', 'low'])
  })

  test('a level changed again after a turn ran at the first: the router goes on from the level that ran', AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'max')
    await turn($, 'ok', 't2', { effort: 'max' })
    await run($, 'effort', 'medium')
    await run($, 'effort', 'auto')
    await turn($, 'go on', 't3', { effort: 'medium' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'max', 'max'])
  })

  test('with no level of the router yet, a level taken back at once goes on from the level the last turn ran at', AUTO, async ($, on) => {
    // Jev down for the first turn (asked twice): the router holds no level, the engine's ran.
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE), failures: { 0: 500, 1: 500 } })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    expect((await command($, '')).text).toContain('effort: not set yet')
    await run($, 'effort', 'max')
    await run($, 'jcGearbox-auto')
    await turn($, 'ok', 't2', { effort: 'max' })
    expect(w.steps.map(s => s.effort)).toEqual(['high', 'high'])
  })

  test('/model or /effort before the first turn is only the starting point', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await run($, 'model', 'sonnet')
    await run($, 'effort', 'high')
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).toBe('opus-5-5·high')
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

describe('plan mode', () => {
  // Jev sure that Haiku will do: low alone clears the downgrade probability.
  const TO_HAIKU = { answers: { ...SURE_EASY.answers, tier: { type: 'choice', choice: 'low', probabilities: { low: 0.85, balanced: 0.1, strong: 0.05 }, confidence: 0.8 } } }
  const toHaiku = (body: any) => (body.questions.tier ? TO_HAIKU : CONTINUE)
  const easy = (body: any) => (body.questions.tier ? SURE_EASY : CONTINUE)
  const strong = (body: any) => (body.questions.tier ? STRONG : CONTINUE)

  test('a session routed to Haiku plans on the balanced tier, as the engine would, and executes on Haiku again', AUTO, async ($, on) => {
    const w = world(on, { reply: toHaiku })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan' })
    // The status line, the record and the log say what was sent, at the router's effort.
    expect(w.status.at(-1)).toBe('sonnet-5-5·low')
    expect((await command($, '')).text).toContain('sent: sonnet-5-5·low · plan mode')
    expect((await command($, 'log 1')).text).toContain('sonnet-5-5·low  jev haiku-4-5-20251001·- · plan mode')
    await turn($, 'ok, do it', 't3')
    expect(w.steps).toEqual([{ model: HAIKU, effort: 'high' }, { model: 'claude-sonnet-5-5', effort: 'low' }, { model: HAIKU, effort: 'high' }])
  })

  test('a model the engine raised for planning is not pulled back down', AUTO, async ($, on) => {
    const w = world(on, { reply: toHaiku })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5', 'auto')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('opus-5-5·low')
    await switchModel($, 'claude-opus-5-5', 'claude-sonnet-5-5', 'auto')
    await turn($, 'ok, do it', 't3')
    expect(w.steps).toEqual([{ model: HAIKU, effort: 'high' }, { model: 'claude-opus-5-5', effort: 'low' }, { model: HAIKU, effort: 'high' }])
  })

  test('a session the router moved down from Opus plans on its routed model: the engine raised nothing', AUTO, async ($, on) => {
    const TO_SONNET = { answers: { ...SURE_EASY.answers, tier: { type: 'choice', choice: 'balanced', probabilities: { low: 0.05, balanced: 0.85, strong: 0.05, long: 0.05 }, confidence: 0.8 } } }
    const w = world(on, { reply: (body: any) => (body.questions.tier ? TO_SONNET : CONTINUE), model: 'claude-opus-5-5' })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
    await turn($, 'ok, do it', 't3', { models: ['claude-opus-5-5'] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect((await command($, 'log 2')).text).not.toContain('plan mode')
  })

  test('a model pinned below the session of its own is kept in plan mode', AUTO, async ($, on) => {
    const w = world(on, { reply: toHaiku, model: FABLE })
    await start($)
    await command($, 'pin opus')
    await turn($, 'rename foo to bar', 't1', { models: [FABLE] })
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan', models: [FABLE] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('/model naming the model it shows is the person\'s choice in plan mode too, though the engine plans on a stronger one', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, model: HAIKU })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [HAIKU] })
    await switchModel($, HAIKU, 'claude-sonnet-5-5', 'auto')
    await turn($, 'plan the next step', 't2', { permissionMode: 'plan', models: ['claude-sonnet-5-5'] })
    await run($, 'model', 'haiku')
    await turn($, 'plan it again', 't3', { permissionMode: 'plan', models: ['claude-sonnet-5-5'] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
    expect((await command($, '')).text).toContain('model: your choice (/model)')
  })

  test('/model naming the model the engine plans on is the person\'s choice too', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, model: HAIKU })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [HAIKU] })
    await switchModel($, HAIKU, 'claude-sonnet-5-5', 'auto')
    await turn($, 'plan the next step', 't2', { permissionMode: 'plan', models: ['claude-sonnet-5-5'] })
    await run($, 'model', 'sonnet')
    await turn($, 'plan it again', 't3', { permissionMode: 'plan', models: ['claude-sonnet-5-5'] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  })

  test('in shadow nothing is floored, so the log says nothing of plan mode', {}, async ($, on) => {
    const w = world(on, { reply: toHaiku })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan' })
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(w.status.at(-1)).toBe('shadow ▸ haiku-4-5-20251001·-')
    expect((await command($, 'log 1')).text).not.toContain('plan mode')
  })

  test('an engine model that names no tier is raised to the balanced tier too', AUTO, async ($, on) => {
    const w = world(on, { reply: toHaiku, model: 'my-gateway-model' })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['my-gateway-model'] })
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan', models: ['my-gateway-model'] })
    expect(w.steps.map(s => s.model)).toEqual([HAIKU, 'claude-sonnet-5-5'])
  })

  test('a pinned model that names no tier is kept: it is below nothing', { options: { default_mode: 'auto' } }, async ($, on) => {
    const w = world(on, { reply: toHaiku, thirdParty: true })
    await start($)
    await command($, 'pin my-gateway-model')
    await turn($, 'rename foo to bar', 't1')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan' })
    expect(w.steps.map(s => s.model)).toEqual(['my-gateway-model', 'my-gateway-model'])
  })

  test('a balanced model the API did not answer as is not asked for again in plan mode', { options: { default_mode: 'auto', balanced_model: 'claude-sonnet-5-5-bad' } }, async ($, on) => {
    const BAD = 'claude-sonnet-5-5-bad'
    const w = world(on, { reply: toHaiku, noResponseFrom: BAD })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan', reason: 'error', failure: 'model_not_found' })
    await turn($, 'plan it again', 't3', { permissionMode: 'plan' })
    await turn($, 'and again', 't4', { permissionMode: 'plan' })
    expect(w.steps.map(s => s.model)).toEqual([HAIKU, BAD, 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect((w.db.get(`session:${w.session}`) as any).badModels).toEqual([BAD])
  })

  test('a session on Haiku whose first prompt is sent in plan mode is measured from Haiku, not from the Sonnet the engine plans on', AUTO, async ($, on) => {
    // Balanced and strong add up to the upgrade probability; low alone does not clear the downgrade one.
    const UP = { answers: { ...SURE_EASY.answers, tier: { type: 'choice', choice: 'low', probabilities: { low: 0.5, balanced: 0.4, strong: 0.1 }, confidence: 0.5 } } }
    const w = world(on, { reply: (body: any) => (body.questions.tier ? UP : CONTINUE), model: HAIKU })
    await start($)
    await turn($, 'plan the rename', 't1', { permissionMode: 'plan', models: ['claude-sonnet-5-5'] })
    await turn($, 'ok, do it', 't2', { models: [HAIKU] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect((await command($, '')).text).toContain('model: claude-sonnet-5-5 (chosen on the first turn)')
  })

  describe('under opusplan', () => {
    // The main loop's model, as the engine reports it ($.session.model()), is Sonnet in either phase; Opus is the request's while planning.
    const OPUSPLAN = { model: 'claude-sonnet-5-5' }

    test('the first prompt is measured from Sonnet, the main loop\'s model, while planning on Opus', AUTO, async ($, on) => {
      // Against a strong anchor, low and balanced would add up to the downgrade probability.
      const w = world(on, { reply: easy, ...OPUSPLAN })
      await start($)
      await turn($, 'rename foo to bar', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
      await switchModel($, 'claude-opus-5-5', 'claude-sonnet-5-5', 'auto')
      await turn($, 'ok, do it', 't2')
      expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
      // The steps alone would look the same against a strong anchor (Sonnet is the engine's executing model): the pick tells.
      expect((await command($, '')).text).toContain("model: the session's own (no clear pick)")
    })

    test('so a hard task planned on Opus is executed on Opus too', AUTO, async ($, on) => {
      const w = world(on, { reply: strong, ...OPUSPLAN })
      await start($)
      await turn($, 'redesign the sync engine', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
      await switchModel($, 'claude-opus-5-5', 'claude-sonnet-5-5', 'auto')
      await turn($, 'ok, do it', 't2')
      expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    })

    test('and from Sonnet[1m] under opusplan[1m]', AUTO, async ($, on) => {
      world(on, { reply: easy, model: 'claude-sonnet-5-5[1m]' })
      await start($)
      await turn($, 'rename foo to bar', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5[1m]'] })
      expect((await command($, '')).text).toContain("model: the session's own (no clear pick)")
    })

    test('a first prompt in the executing phase is measured from Sonnet as on any session', AUTO, async ($, on) => {
      const w = world(on, { reply: strong, ...OPUSPLAN })
      await start($)
      await turn($, 'redesign the sync engine', 't1')
      expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5'])
    })

    test('an Opus session of its own, started over the setting, is measured from Opus', AUTO, async ($, on) => {
      const w = world(on, { reply: easy, model: 'claude-opus-5-5' })
      await start($)
      await turn($, 'rename foo to bar', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
      await turn($, 'ok, do it', 't2', { models: ['claude-opus-5-5'] })
      // Plan mode raised nothing here: the planning turn goes on the routed model too.
      expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
      expect((await command($, '')).text).toContain('model: claude-sonnet-5-5 (chosen on the first turn)')
    })

    test('a session on Fable over the setting is measured from Fable: it is not pulled down to Opus', AUTO, async ($, on) => {
      // Strong and long add up to the upgrade probability from balanced; from long, nothing moves.
      const LONGISH = { answers: { ...STRONG.answers, tier: { type: 'choice', choice: 'strong', probabilities: { low: 0.05, balanced: 0.05, strong: 0.6, long: 0.3 }, confidence: 0.6 } } }
      const w = world(on, { reply: (body: any) => (body.questions.tier ? LONGISH : CONTINUE), model: FABLE })
      await start($)
      await turn($, 'redesign the sync engine', 't1', { permissionMode: 'plan', models: [FABLE] })
      await turn($, 'ok, do it', 't2', { models: [FABLE] })
      expect(w.steps.map(s => s.model)).toEqual([FABLE, FABLE])
      expect((await command($, '')).text).toContain("model: the session's own (no clear pick)")
    })

    test('a session on Haiku over the setting is measured from Haiku: it still moves up', AUTO, async ($, on) => {
      const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE), model: HAIKU })
      await start($)
      await turn($, 'rename foo to bar', 't1', { models: [HAIKU] })
      expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5'])
    })

    test('where the engine cannot tell its model, the first prompt is measured from the model of the moment', AUTO, async ($, on) => {
      const w = world(on, { reply: easy, ...OPUSPLAN, noModel: true })
      await start($)
      await turn($, 'rename foo to bar', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
      await switchModel($, 'claude-opus-5-5', 'claude-sonnet-5-5', 'auto')
      await turn($, 'ok, do it', 't2')
      expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
      expect((await command($, '')).text).toContain('model: claude-sonnet-5-5 (chosen on the first turn)')
    })
  })
})

describe('/jcGearbox auto', () => {
  test('clears a model switch and an effort pin', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: 'low' })
    await switchModel($, 'claude-sonnet-5-5', HAIKU)
    await command($, 'auto')
    await turn($, 'go on', 't3', { models: [HAIKU], effort: 'medium' })
    // The effort goes on from the level the person last ran at, as after /effort auto.
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
    expect(w.asked.at(-1).state.previous.effort).toBe('low')
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test("goes on from the level the person last ran at, as /effort auto does, though Claude Code keeps its own level", AUTO, async ($, on) => {
    const w = world(on, { reply: (body: any) => (body.questions.tier ? EASY : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await run($, 'effort', 'max')
    await turn($, 'ok', 't2', { effort: 'max' })
    await turn($, 'and the docs', 't3', { effort: 'max' })
    await run($, 'jcGearbox-auto')
    await turn($, 'go on', 't4', { effort: 'max' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'max', 'max', 'max'])
    expect(w.asked.at(-1).state.previous.effort).toBe('max')
  })

  test('an effort set before it does not pin again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: 'low' })
    await command($, 'auto')
    await turn($, 'go on', 't3', { effort: 'medium' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
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
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test('restarts on a new engine model with no switch event', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { models: ['claude-opus-4-7'], effort: 'xhigh' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect((await command($, '')).text).not.toContain('effort: yours')
  })

  test('a switch between a scheduled turn and the first user turn pins neither model nor effort', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'nightly check', 't0', { origin: 'scheduled-trigger' })
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5')
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'], effort: 'xhigh' })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).toBe('opus-5-5·high')
  })
})

describe('/jcGearbox pin', () => {
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
    expect((await command($, 'pin opus')).text).toBe('jcGearbox: cannot resolve "opus" here; give a full model id.')
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

describe('a complaint', () => {
  test('raises the effort a level, up to max', AUTO, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(EASY) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2')
    await turn($, 'still failing again', 't3')
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'max', 'max'])
  })

  test('stops at a lower max_effort', { options: { default_mode: 'auto', max_effort: 'xhigh' } }, async ($, on) => {
    const w = world(on, { reply: xhighThenComplaints(EASY) })
    await start($)
    await turn($, 'fix the flaky test', 't1')
    await turn($, 'still failing', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
  })
})

describe('/jcGearbox log', () => {
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
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (no response); not switching to it again')
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
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (refused); not switching to it again')
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

  test("a failure reported after the next turn's first request still blames the model once", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noResponseOnce: 'claude-opus-5-5', refusalFrom: 'claude-opus-5-5' })
    await start($)
    // The first turn's rewritten request gets no response and the turn dies of it ...
    await $.classic.UserPromptSubmit({ prompt: 'redesign the sync engine', permission_mode: 'default' })
    await $.prompt.submit({ text: 'redesign the sync engine', wait: false, origin: { kind: 'sdk' } })
    await $.turn.start({ text: 'redesign the sync engine', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, effort: 'high' }))
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'error' })
    // ... the next turn's first request, declined, blames the model before StopFailure says why the first died.
    await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 4, effort: 'high' }))
    await $.classic.StopFailure({ error: 'model_not_found' })
    expect((w.db.get('session:session-1') as any).badModels).toEqual(['claude-opus-5-5'])
  })

  test('an answer from another generation of the model is not taken for it', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, answeredAs: 'claude-opus-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (opus-5 answered); not switching to it again')
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

  test('an overload or a server error, which Claude Code takes for transient, blames no model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseAt: [0, 1] })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'overloaded' })
    await turn($, 'try again', 't2', { reason: 'error', failure: 'server_error', failureAfter: true })
    await turn($, 'ok', 't3')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a model that is not found is blamed, whichever report of the failure comes first', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'model_not_found', failureAfter: true })
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (model not found); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('an account problem, which any model would meet, blames no model', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseAt: [0, 1] })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'billing_error' })
    await turn($, 'try again', 't2', { reason: 'error', failure: 'cloud_credential_error', failureAfter: true })
    await turn($, 'ok', 't3')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a model that answers is written down for the session once', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    expect((w.db.get('session:session-1') as any).answered).toEqual(['claude-opus-5-5'])
  })

  test('a failed sign-in, a verification or a rate limit blames no model that has answered in the session, across a restart', AUTO, async ($, on) => {
    const w = world(on, {
      reply: firstStrongThenContinue,
      noResponseAt: [0, 1, 2],
      store: { 'session:session-1': { decided: true, model: 'claude-opus-5-5', answered: ['claude-opus-5-5'] } },
    })
    await start($)
    await turn($, 'go on', 't1', { reason: 'error', failure: 'authentication_failed' })
    await turn($, 'try again', 't2', { reason: 'error', failure: 'rate_limit' })
    await turn($, 'and again', 't3', { reason: 'error', failure: 'verification_required', failureAfter: true })
    await turn($, 'ok', 't4')
    expect(w.steps.map(s => s.model)).toEqual(Array(4).fill('claude-opus-5-5'))
    expect(w.status.join('\n')).not.toContain('was not used')
  })

  test('a model that has not answered in the session is blamed for a failed sign-in, as one not enabled on Bedrock fails', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'authentication_failed' })
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (authentication failed); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('a model that has not answered in the session is blamed for a rate limit, as one billed to usage credits fails', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseFrom: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'rate_limit', failureAfter: true })
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (rate limit); not switching to it again')
    expect((w.db.get('session:session-1') as any).badModels).toEqual(['claude-opus-5-5'])
  })

  test('/jcGearbox auto asks again for a model it stopped asking for', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, noResponseOnce: 'claude-opus-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { reason: 'error', failure: 'rate_limit' })
    await turn($, 'ok', 't2')
    expect((await command($, 'auto')).text).toContain('unused models asked for again')
    await turn($, 'go on', 't3')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
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

describe('the /jcGearbox-<action> commands', () => {
  test('are registered next to /jcGearbox', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.registered).toEqual(['jcGearbox', 'jcGearbox-status', 'jcGearbox-auto', 'jcGearbox-shadow', 'jcGearbox-off', 'jcGearbox-on', 'jcGearbox-log', 'jcGearbox-stats'])
  })

  test('do what /jcGearbox <action> does', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await run($, 'jcGearbox-status')).text).toBe((await command($, '')).text)
    expect((await run($, 'jcGearbox-pin', 'sonnet')).text).toContain('model pinned to claude-sonnet-5-5')
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await run($, 'jcGearbox-log', '1')).text.split('\n')).toHaveLength(3)
    expect((await run($, 'jcGearbox-off')).text).toBe('jcGearbox: off for this session.')
    await turn($, 'one more', 't3')
    expect(w.asked).toHaveLength(2)
  })

  test("/jcGearbox-pin is answered under the plugin's name too, as a skill is run", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await run($, 'jc-gearbox:jcGearbox-pin', 'sonnet')).text).toContain('model pinned to claude-sonnet-5-5')
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('each one is answered', async ($, on) => {
    const w = world(on)
    await start($)
    for (const name of w.registered) expect((await run($, name)).text).toBeDefined()
  })

  test('/jcGearbox-on keeps a pin', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await run($, 'jcGearbox-pin', 'sonnet')
    await run($, 'jcGearbox-off')
    expect((await run($, 'jcGearbox-on')).text).toBe('jcGearbox: auto for this session.')
    await turn($, 'go on', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect((await command($, '')).text).toContain('jcGearbox: auto (default)')
  })

  test('/jcGearbox-on goes back to the default mode', async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await run($, 'jcGearbox-off')
    expect((await run($, 'jcGearbox-on')).text).toBe('jcGearbox: shadow for this session.')
    expect((await command($, 'on')).text).toBe('jcGearbox: shadow for this session.')
  })

  test('/jcGearbox-on turns auto on when the default mode is off', { options: { default_mode: 'off' } }, async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    expect((await run($, 'jcGearbox-on')).text).toBe('jcGearbox: auto for this session.')
  })
})

