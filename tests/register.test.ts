import { describe, expect, test } from 'claude-code/testing'

import { AUTO, EASY, STRONG, command, commandText, drain, firstStrongThenContinue, start, switchModel, turn, world } from './world.ts'

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

  test("an effort the engine changes mid-turn, as a skill's own does, rides the rest of the turn", AUTO, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    const models = ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']
    await turn($, 'rename foo to bar', 't1', { models, efforts: ['high', 'max', 'high'] })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'max', 'high'])
  })

  test('a session already on the chosen model keeps its [1m] suffix', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5[1m]'], effort: 'medium' })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5[1m]', effort: 'high' }])
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

describe("Anthropic's model selection matrix", () => {
  test('long, multi-hour work moves the session to Fable 5.1 by default', AUTO, async ($, on) => {
    const LONG = {
      answers: {
        tier: { type: 'choice', choice: 'long', probabilities: { low: 0.02, balanced: 0.08, strong: 0.2, long: 0.7 }, confidence: 0.6 },
        effort: { type: 'score', score: 3.1 },
        high_stakes: { type: 'noul', noul: 0.1 },
      },
    }
    const w = world(on, { reply: LONG })
    await start($)
    await turn($, 'migrate the whole monorepo to the new build system, end to end', 't1')
    expect(w.asked[0].questions.tier.criteria.long).toBeDefined()
    expect(w.steps).toEqual([{ model: 'claude-fable-5-1', effort: 'xhigh' }])
  })
})

describe('ultracode', () => {
  test('a turn the person typed ultracode in is routed as usual and says so', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ULTRACODE audit every module for races', 't2')
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·high · ultracode')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·high · ultracode')
    await turn($, 'now fix the first one', 't3')
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·high')
  })

  test("the word is the keyword only where Claude Code takes it as one", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    const prompts = [
      'rename ultracoder to coder',
      'fix the `ultracode` note in the README',
      'what is ultracode?',
      'see "ultracode" in the docs',
      'drop the ultracode-mode flag',
      'read docs/ultracode.md',
      '/tmp/build.log ultracode this',
      'retry it (ultracode) later',
      'set {ultracode} in the template',
      'tick [ultracode] in the list',
      'see the <ultracode> tag',
      "say 'ultracode' here",
      'see docs/ultracode now',
      'open C:\\ultracode',
      'pass --ultracode',
      'open ultracode/README',
      'open ultracode\\bin',
    ]
    for (const [i, text] of prompts.entries()) {
      await turn($, text, `t${i}`)
      expect(w.status.at(-1)).not.toContain('ultracode')
    }
  })

  test('a keyword that ends a sentence counts', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'audit every module with ultracode.', 't1')
    expect(w.status.at(-1)).toContain('ultracode')
  })

  test('a turn the person did not type is never an ultracode turn', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ultracode audit everything', 't2', { origin: 'task-notification' })
    expect(w.status.at(-1)).not.toContain('ultracode')
  })
})

describe('the status line shows what was sent', () => {
  test('a model that takes no effort shows none, whatever the engine had set', AUTO, async ($, on) => {
    const LOW = {
      answers: {
        tier: { type: 'choice', choice: 'low', probabilities: { low: 0.8, balanced: 0.15, strong: 0.05 }, confidence: 0.7 },
        effort: { type: 'score', score: 0.2 },
        high_stakes: { type: 'noul', noul: 0.05 },
      },
    }
    const w = world(on, { reply: LOW })
    await start($)
    await turn($, 'what does git stash do', 't1')
    expect(w.status.at(-1)).toBe('jcmr ▸ haiku-4-5-20251001·-')
    const log = (await command($, 'log 1')).text
    expect(log).toContain('haiku-4-5-20251001·-')
    expect(log).not.toContain('jev')
  })

  test('a model rewritten without an effort of the router\'s own shows its effort as unknown', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module'), effort: 'medium' })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'medium' }])
    expect(w.status.at(-1)).toBe('jcmr ▸ opus-5-5·? · jev opus-5-5·high')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·?  jev opus-5-5·high')
  })

  test("a request without effort shows the model's default", async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'], effort: null })
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·medium · jev opus-5-5·high')
  })
})

describe('shadow mode', () => {
  test('judges and shows, rewrites nothing', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ sonnet-5-5·high · jev opus-5-5·high')
  })

  test('/jcmr and its log show what was sent, not what Jev picked', async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, '')).text).toContain('sent: sonnet-5-5·high · shadow')
    expect((await command($, 'log')).text).toContain('sonnet-5-5·high  jev opus-5-5·high · shadow')
  })

  test('a pin shows as the sent model, with Jev\'s pick beside it', { options: { default_mode: 'auto', low_model: 'sonnet' } }, async ($, on) => {
    world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    expect((await command($, 'pin opus')).text).toContain('opus')
    await turn($, 'rename bar to baz', 't2')
    const last = (await command($, 'log 1')).text
    expect(last).toContain('opus-5-5·')
    expect(last).toContain('jev sonnet-5-5·low · pin')
    expect((await command($, '')).text).toContain(' · pin')
  })

  test('a model the API did not answer as is named in the log and /jcmr', AUTO, async ($, on) => {
    world(on, { reply: STRONG, answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, 'log')).text).toContain('opus-5-5·high · served sonnet-5-5')
    expect((await command($, '')).text).toContain('sent: opus-5-5·high · served sonnet-5-5')
  })

  test("the status line's jev is Jev's own pick, as in the log, whatever the person set", { options: { low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    await command($, 'pin opus')
    await turn($, 'rename bar to baz', 't2', { models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·high · jev sonnet-5-5·low · model pinned')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·high  jev sonnet-5-5·low')
    await turn($, 'rename baz to qux', 't3', { models: ['claude-opus-5-5'], effort: 'max' })
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·max · jev sonnet-5-5·low · model pinned · effort pinned')
  })

  test('a pin, a /model switch and a changed effort still send every request unchanged', async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await command($, 'pin haiku')
    await turn($, 'ok', 't2')
    await switchModel($, 'claude-sonnet-5-5', 'claude-fable-5-1', 'command')
    await turn($, 'go on', 't3', { models: ['claude-fable-5-1'] })
    await turn($, 'and the rest', 't4', { models: ['claude-fable-5-1'], effort: 'max' })
    expect(w.steps).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'high' },
      { model: 'claude-sonnet-5-5', effort: 'high' },
      { model: 'claude-fable-5-1', effort: 'high' },
      { model: 'claude-fable-5-1', effort: 'max' },
    ])
  })

  test('leaves a lower effort judgement unapplied too', { options: { low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5', 'claude-opus-5-5'] })
    expect(w.steps).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ opus-5-5·high · jev sonnet-5-5·low')
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

  test('a Jev that cannot be reached leaves the first turn alone and says why', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, offline: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'redesign the sync engine', 't2')
    expect(w.fetches).toHaveLength(2)
    expect(w.asked[1].questions.tier).toBeUndefined()
    expect(w.steps).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'high' },
      { model: 'claude-sonnet-5-5', effort: 'high' },
    ])
    expect(w.status.at(-1)).toContain('Jev network error')
  })

  test('a store that will not take the decision still asks Jev only once a turn', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, storeFails: key => key.startsWith('log:') })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'] })
    expect(w.asked).toHaveLength(1)
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
    await switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'sdk')
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
    expect((await command($, '')).text).toBe(
      [
        'jcmr: auto (default)',
        'model: claude-opus-5-5 (chosen on the first turn)',
        'effort: high',
        'tiers: low haiku-4-5-20251001 · balanced sonnet-5-5 · strong opus-5-5 · long fable-5-1',
        'last turn: tier strong 0.80 / balanced 0.15 / low 0.05 · effort 2.20 · high stakes 0.10',
        'sent: opus-5-5·high',
      ].join('\n'),
    )
    expect((await command($, 'log')).text).toMatch(/^```\n\d\d-\d\d \d\d:\d\d  auto   opus-5-5·high  first  "redesign the sync engine"\n```$/)
  })

  test("names the Jev version that answered, and a tier's built-in, unused or off model", { options: { default_mode: 'auto', long_model: 'off' } }, async ($, on) => {
    world(on, { reply: { ...STRONG, model: 'jev-1.13.0' }, catalog: null, answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const report = (await command($, '')).text.split('\n')
    expect(report[3]).toBe('tiers: low haiku-5-5 (built-in) · balanced sonnet-5-5 (built-in) · strong opus-5-5 (built-in, not served) · long off')
    expect(report[4]).toBe('last turn: tier strong 0.80 / balanced 0.15 / low 0.05 · effort 2.20 · high stakes 0.10 (jev-1.13.0)')
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
    expect(w.status.at(-1)).toBe('jcmr(shadow) ▸ sonnet-5-5·high · jev opus-5-5·high')
    w.session = 'session-2'
    await turn($, 'redesign the sync engine', 't2')
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

describe('/jcmr-status off a first-party login', () => {
  test('tells a tier set to off from an alias that cannot resolve', { options: { long_model: 'off' } }, async ($, on) => {
    world(on, { thirdParty: true })
    await start($)
    expect((await command($, '')).text).toContain(
      'tiers: low off (alias needs an Anthropic login) · balanced off (alias needs an Anthropic login) · strong off (alias needs an Anthropic login) · long off',
    )
  })
})

describe('settings', () => {
  test('min_effort is the lowest effort set', { options: { default_mode: 'auto', min_effort: 'medium' } }, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }])
  })

  test('signal_threshold sets when a high-stakes task counts', { options: { default_mode: 'auto', signal_threshold: 0.4 } }, async ($, on) => {
    const w = world(on, { reply: { answers: { ...EASY.answers, high_stakes: { type: 'noul', noul: 0.5 } } } })
    await start($)
    await turn($, 'drop the users table', 't1', { effort: 'medium' })
    expect(w.steps.at(-1)?.effort).toBe('high')
  })

  test('continuation_threshold sets when a prompt keeps the last effort', { options: { default_mode: 'auto', continuation_threshold: 0.95 } }, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['high', 'low'])
  })

  test('tier_min_probability sets when the model changes', { options: { default_mode: 'auto', tier_min_probability: 0.9 } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })
})
