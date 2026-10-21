import { describe, expect, test } from 'claude-code/testing'

import { AUTO, CONTINUE, EASY, STRONG, SURE_EASY, command, commandText, drain, firstStrongThenContinue, run, spawnAgent, start, switchModel, turn, world } from './world.ts'

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
    expect(w.status.at(-1)).toBe('opus-5-5·high')
  })

  test('tiers on one model pool their probability: a sure easy prompt goes down to sonnet', { options: { default_mode: 'auto', low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: SURE_EASY })
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
    expect(w.status.at(-1)).toBe('opus-5-5 was not used (sonnet-5-5 answered); not switching to it again')
    await turn($, 'ok', 't2')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(w.asked[1].questions.tier).toBeUndefined()
  })

  test('the built-in table stands in when the catalog cannot be read, and says so', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, catalog: null })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect((await command($, '')).text).toContain('opus-5-5 (built-in)')
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
    expect(w.status.at(-1)).toBe('opus-5-5·high')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·high · ultracode')
    await turn($, 'now fix the first one', 't3')
    expect((await command($, 'log 1')).text).not.toContain('ultracode')
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
    for (const [i, text] of prompts.entries()) await turn($, text, `t${i}`)
    const logged = [...w.db].filter(([k]) => k.startsWith('log:')).map(([, d]) => d as any)
    expect(logged).toHaveLength(prompts.length)
    expect(logged.filter(d => d.why?.includes('ultracode'))).toEqual([])
  })

  test('a keyword that ends a sentence counts', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'audit every module with ultracode.', 't1')
    expect((await command($, 'log 1')).text).toContain('· ultracode')
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
    expect(w.status.at(-1)).toBe('haiku-4-5-20251001·-')
    const log = (await command($, 'log 1')).text
    expect(log).toContain('haiku-4-5-20251001·-')
    expect(log).not.toContain('jev')
  })

  test('a model rewritten with no effort of the router\'s or the engine\'s shows its effort as unknown', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module'), effort: null })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5' }])
    expect(w.status.at(-1)).toBe('opus-5-5·high')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·?  jev opus-5-5·high')
  })

  test("a command's own model on the session's first prompt becomes the session's model", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module'), models: ['claude-haiku-4-5-20251001'] })
    await turn($, 'now the tests', 't2')
    expect(w.steps.map(s => s.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'])
    expect((await command($, '')).text).toContain('model: claude-haiku-4-5-20251001 (chosen on the first turn)')
  })

  test("a command's own model on a later turn does not change the session's model", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, '/review the auth module', 't2', { origin: 'composer', startText: commandText('review', 'the auth module'), models: ['claude-haiku-4-5-20251001'] })
    await turn($, 'now the tests', 't3')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'])
  })

  test("in shadow a command's own model on the first prompt does not replace Jev's pick", async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module'), models: ['claude-haiku-4-5-20251001'] })
    expect((await command($, 'log 1')).text).toContain('jev opus-5-5')
    expect((await command($, '')).text).toContain('model: claude-opus-5-5 (chosen on the first turn)')
  })

  test('a model rewritten with no effort from Jev shows a dash in the status line, not a question mark', AUTO, async ($, on) => {
    const { effort: _, ...answers } = STRONG.answers
    const NO_EFFORT = { answers }
    const w = world(on, { reply: NO_EFFORT })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module'), effort: null })
    expect(w.status.at(-1)).toBe('opus-5-5·-')
  })

  test("a level equal to the engine's own, which Claude Code drops, is unknown on a model whose default differs", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-4-6'], effort: 'high' })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('opus-5-5·high')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·?  jev opus-5-5·high')
  })

  test("a level equal to the engine's own shows when it was set rather than its model's default", AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'high' })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('opus-5-5·high')
  })

  test("a request without effort shows the model's default", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: null })
    expect(w.steps.at(-1)?.effort).toBeUndefined()
    expect(w.status.at(-1)).toBe('opus-5-5·medium')
  })
})

describe('shadow mode', () => {
  test('sends the request without waiting for Jev, and writes the decision down after', async ($, on) => {
    const w = world(on, { reply: STRONG, hang: true })
    await start($)
    const done = turn($, 'redesign the sync engine', 't1')
    await w.clock.settle()
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    await w.clock.advance(3000)
    await done
    expect(w.status.at(-1)).toContain('Jev timeout')
  })

  test('judges and shows, rewrites nothing', async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('shadow ▸ opus-5-5·high')
  })

  test("while the person holds the effort, the pick still shows Jev's latest effort, on every turn", { options: { low_model: 'sonnet' } }, async ($, on) => {
    const HARDER = { answers: { effort: { type: 'score', score: 2.2 }, continuation: { type: 'noul', noul: 0.1 }, escalate: { type: 'noul', noul: 0.05 }, high_stakes: { type: 'noul', noul: 0.05 } } }
    const w = world(on, { reply: (body: any) => (body.questions.tier ? SURE_EASY : HARDER), model: 'claude-opus-5-5' })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·low')
    await run($, 'effort', 'high')
    await turn($, 'now make it thread-safe', 't2', { models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·high')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·high  jev sonnet-5-5·high · shadow · effort pinned')
    // A turn nobody typed asks nothing and shows the same.
    await turn($, 'a task finished', 't3', { origin: 'task-notification', models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·high')
  })

  test('/jcGearbox and its log show what was sent, not what Jev picked', async ($, on) => {
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

  test('a model the API did not answer as is named in the log and /jcGearbox', AUTO, async ($, on) => {
    world(on, { reply: STRONG, answeredAs: 'claude-sonnet-5-5' })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, 'log')).text).toContain('opus-5-5·high · served sonnet-5-5')
    expect((await command($, '')).text).toContain('sent: opus-5-5·high · served sonnet-5-5')
  })

  test("in shadow the status line shows Jev's own pick, as the log does, whatever the person set", { options: { low_model: 'sonnet' } }, async ($, on) => {
    const w = world(on, { reply: SURE_EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    await command($, 'pin opus')
    await turn($, 'rename bar to baz', 't2', { models: ['claude-opus-5-5'] })
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·low')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·high  jev sonnet-5-5·low')
    await turn($, 'rename baz to qux', 't3', { models: ['claude-opus-5-5'], effort: 'max' })
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·low')
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
    const w = world(on, { reply: SURE_EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5', 'claude-opus-5-5'] })
    expect(w.steps).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.status.at(-1)).toBe('shadow ▸ sonnet-5-5·low')
  })
})

describe('failing open', () => {
  test('without a key nothing is asked or rewritten', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, noKey: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('no API key')
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
    expect(w.fetches).toHaveLength(3) // the first turn asks twice
    expect(w.asked[2].questions.tier).toBeUndefined()
    expect(w.steps).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'high' },
      { model: 'claude-sonnet-5-5', effort: 'high' },
    ])
    expect(w.status.at(-1)).toContain('Jev network error')
  })

  test('a first turn asks Jev once more after a quick network error or 5xx', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, failures: { 0: 503 } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.fetches).toHaveLength(2)
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('only once, and not for a key error, nor with under a second left', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, failures: { 0: 503, 1: 'offline', 2: 401, 3: 502 }, gate: () => (w.fetches.length === 4 ? w.clock.sleep(2500) : undefined) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.fetches).toHaveLength(2)
    expect(w.status.at(-1)).toContain('Jev network error')
    w.session = 'session-2'
    await turn($, 'redesign the sync engine', 't2')
    expect(w.fetches).toHaveLength(3)
    w.session = 'session-3'
    const t3 = turn($, 'redesign the sync engine', 't3')
    await w.clock.settle()
    await w.clock.advance(2500)
    await t3
    expect(w.fetches).toHaveLength(4)
  })

  test('a later turn does not ask again', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, failures: { 1: 503 } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2')
    expect(w.fetches).toHaveLength(2)
  })

  test('a claude -p or Agent SDK run is left alone', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
  })

  test('a store that will not take the decision still asks Jev only once a turn', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG, storeFails: key => key.startsWith('log:') })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'] })
    expect(w.asked).toHaveLength(1)
  })

  test('a store that will not write down the model that answered keeps the record and how the turn went', AUTO, async ($, on) => {
    let sets = 0
    const w = world(on, { reply: STRONG, storeFails: key => key.startsWith('session:') && ++sets > 1 })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const log = [...w.db.entries()].find(([k]) => k.startsWith('log:'))?.[1] as any
    expect(log.outcome.reason).toBe('answer')
    expect(w.db.get('session:session-1')).toMatchObject({ decided: true, model: 'claude-opus-5-5' })
    expect((w.db.get('session:session-1') as any).answered).toBeUndefined()
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
  test('/jcGearbox pin forces a model; /jcGearbox auto hands the session back to its first-turn choice', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    const pinned = await command($, 'pin haiku')
    expect(pinned.text).toContain('claude-haiku-4-5-20251001')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
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

  test("auto does not wait for Jev once its answer cannot change the request", AUTO, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const w = world(on, { reply: firstStrongThenContinue, gate: body => (w.asked.length === 3 ? held : undefined) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'ok', 't2', { effort: 'low' })
    const t3 = turn($, 'go on', 't3', { effort: 'low' })
    await w.clock.settle()
    expect(w.steps).toHaveLength(3)
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
    release()
    await t3
    expect((await command($, '')).text).toContain('effort: yours')
  })

  test('auto sends a request once it is decided, before the decision is written down', AUTO, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const w = world(on, { reply: STRONG, storeHolds: key => (key.startsWith('log:') ? held : undefined) })
    await start($)
    const t1 = turn($, 'redesign the sync engine', 't1')
    await w.clock.settle()
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    release()
    await t1
    expect([...w.db.keys()].some(k => k.startsWith('log:'))).toBe(true)
  })

  test('the person changing the effort pins it', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'high' })
    await turn($, 'ok', 't2', { effort: 'low' })
    expect(w.steps.map(s => s.effort)).toEqual(['high', 'low'])
    expect((await command($, '')).text).toContain('effort: yours')
  })
})

describe('/jcGearbox', () => {
  test('reports the session and lists the log', AUTO, async ($, on) => {
    world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect((await command($, '')).text).toBe(
      [
        'jcGearbox: auto (default)',
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

  test('/jcGearbox off turns this session off', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    expect((await command($, 'off')).text).toBe('jcGearbox: off for this session.')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.asked).toHaveLength(0)
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
  })

  test('/jcGearbox shadow judges without rewriting, for this session only', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    expect((await command($, 'shadow')).text).toBe('jcGearbox: shadow for this session.')
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(w.status.at(-1)).toBe('shadow ▸ opus-5-5·high')
    w.session = 'session-2'
    await turn($, 'redesign the sync engine', 't2')
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

describe("the engine's own tier among the choices", () => {
  const FABLE = 'claude-fable-5-1'
  const sure = (long: number, strong: number) => ({
    answers: { ...STRONG.answers, tier: { type: 'choice', choice: 'strong', probabilities: { low: 0.05, balanced: 0.05, strong, long }, confidence: 0.6 } },
  })

  test('with the long tier off, a session on Fable is asked about long too, and stays when Jev gives it its share', { options: { default_mode: 'auto', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { model: FABLE, reply: sure(0.5, 0.4) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [FABLE] })
    expect(Object.keys(w.asked[0].questions.tier.criteria)).toEqual(['strong', 'balanced', 'low', 'long'])
    expect(w.steps.map(s => s.model)).toEqual([FABLE])
    expect((await command($, '')).text).toContain("model: the session's own (no clear pick)")
  })

  test('and still moves down once a weaker tier clears the downgrade probability', { options: { default_mode: 'auto', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { model: FABLE, reply: sure(0.1, 0.8) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [FABLE] })
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5'])
  })

  test('a tier asked about and left out of the answer got no share of it', { options: { default_mode: 'auto', long_model: 'off' } }, async ($, on) => {
    const noLong = { answers: { ...STRONG.answers, tier: { type: 'choice', choice: 'strong', probabilities: { low: 0.05, balanced: 0.05, strong: 0.9 }, confidence: 0.6 } } }
    const w = world(on, { model: FABLE, reply: noLong })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [FABLE] })
    expect(Object.keys(w.asked[0].questions.tier.criteria)).toContain('long')
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5'])
  })

  test('a tier question is still only asked with two models to choose between', { options: { default_mode: 'auto', low_model: 'off', strong_model: 'off', long_model: 'off' } }, async ($, on) => {
    const w = world(on, { model: 'claude-opus-5-5', reply: sure(0, 0) })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-opus-5-5'] })
    expect(w.asked[0].questions.tier).toBeUndefined()
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5'])
  })
})

describe('/jcGearbox-status off a first-party login', () => {
  test('tells a tier set to off from an alias that cannot resolve', { options: { long_model: 'off' } }, async ($, on) => {
    world(on, { thirdParty: true })
    await start($)
    expect((await command($, '')).text).toContain(
      'tiers: low off (alias needs an Anthropic login) · balanced off (alias needs an Anthropic login) · strong off (alias needs an Anthropic login) · long off',
    )
  })
})

describe('an unsure Jev', () => {
  const SURE_XHIGH = { answers: { ...STRONG.answers, effort: { type: 'score', score: 3, confidence: 0.9 } } }
  const UNSURE = { answers: { ...CONTINUE.answers, continuation: { type: 'noul', noul: 0.1 }, effort: { type: 'score', score: 0.2, confidence: 0.4 } } }
  const unsure = (body: any) => (body.questions.tier ? SURE_XHIGH : UNSURE)

  test('keeps the effort the last turn ran at, and says so', AUTO, async ($, on) => {
    const w = world(on, { reply: unsure })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'now the tests', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'xhigh'])
    expect(w.status.at(-1)).toBe('opus-5-5·xhigh')
    expect((await command($, 'log 1')).text).toContain('opus-5-5·xhigh · Jev unsure')
  })

  test('says nothing of it where the effort is the person\'s or the model takes none', AUTO, async ($, on) => {
    const w = world(on, { reply: unsure })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'now the tests', 't2', { effort: 'max' })
    expect(w.status.at(-1)).toBe('opus-5-5·max')
    expect((await command($, 'log 1')).text).not.toContain('Jev unsure')
    await command($, 'pin haiku')
    await turn($, 'and the docs', 't3', { effort: 'max' })
    expect((await command($, 'log 1')).text).not.toContain('Jev unsure')
  })

  test('effort_min_confidence sets how sure Jev must be; 0 always follows it', { options: { default_mode: 'auto', effort_min_confidence: 0 } }, async ($, on) => {
    const w = world(on, { reply: unsure })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, 'now the tests', 't2')
    expect(w.steps.map(s => s.effort)).toEqual(['xhigh', 'low'])
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

  test('tier_upgrade_probability sets when the model moves up', { options: { default_mode: 'auto', tier_upgrade_probability: 0.9 } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('tier_min_probability sets when the model moves down, 0.8 by default', { options: { default_mode: 'auto', tier_min_probability: 0.9 } }, async ($, on) => {
    const w = world(on, { reply: SURE_EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('an engine model no tier names stands for its family: an older Sonnet moves up like Sonnet', AUTO, async ($, on) => {
    const LEANING_STRONG = { answers: { ...STRONG.answers, tier: { type: 'choice', choice: 'strong', probabilities: { balanced: 0.45, strong: 0.55 }, confidence: 0.3 } } }
    const w = world(on, { reply: LEANING_STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-4-6'] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('an unsure easy prompt keeps the stronger model it started on', AUTO, async ($, on) => {
    const w = world(on, { reply: EASY })
    await start($)
    await turn($, 'rename foo to bar', 't1', { models: ['claude-opus-5-5'] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })
})

describe('fork_follows_route', () => {
  const FOLLOW = { options: { default_mode: 'auto', fork_follows_route: true } }
  const forkStep = (agentId: string, model = 'claude-sonnet-5-5') =>
    ({ turnId: 'a1', index: 0, model, messageCount: 40, effort: 'medium' as const, agentId })

  test('a fork of the main conversation runs on the model the session is routed to, its effort left alone', FOLLOW, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const fork = await spawnAgent($)
    await drain($.turn.step(forkStep(fork)))
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test("a fork's step on the engine's fallback model is left alone, as on the main loop", FOLLOW, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const fork = await spawnAgent($)
    await drain($.turn.step(forkStep(fork)))
    await drain($.turn.step({ ...forkStep(fork, 'claude-haiku-4-5-20251001'), index: 1 }))
    expect(w.steps.slice(1).map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001'])
  })

  test("a fork made in a command's turn on the command's own model keeps that model", FOLLOW, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const fork = await spawnAgent($)
    await drain($.turn.step(forkStep(fork, 'claude-haiku-4-5-20251001')))
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
    await drain($.turn.step(forkStep(await spawnAgent($))))
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('without a key a fork is left alone, as the main loop is', FOLLOW, async ($, on) => {
    const w = world(on, { reply: STRONG, noKey: true })
    await start($)
    await command($, 'pin opus')
    await turn($, 'redesign the sync engine', 't1')
    await drain($.turn.step(forkStep(await spawnAgent($))))
    expect(w.steps.map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test("a fork reads the session's record whole, not in the middle of a save", FOLLOW, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let holding = false
    const w = world(on, { reply: STRONG, storeHolds: key => (holding && key.startsWith('session:') ? held : undefined) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const fork = await spawnAgent($)
    holding = true
    const pinning = command($, 'pin opus')
    await w.clock.settle()
    const step = drain($.turn.step(forkStep(fork)))
    await w.clock.settle()
    holding = false
    release()
    await Promise.all([pinning, step])
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test('other subagents, and a fork of a subagent, are left alone', FOLLOW, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    const explorer = await spawnAgent($, { fork: false })
    await drain($.turn.step(forkStep(explorer)))
    const nested = await spawnAgent($, { parentAgentId: explorer })
    await drain($.turn.step(forkStep(nested)))
    expect(w.steps.slice(1)).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5-5', effort: 'medium' },
    ])
  })

  test('a fork made in a plan-mode turn follows the floored model, and keeps it once the next prompt leaves plan mode', FOLLOW, async ($, on) => {
    const TO_HAIKU = { answers: { ...SURE_EASY.answers, tier: { type: 'choice', choice: 'low', probabilities: { low: 0.85, balanced: 0.1, strong: 0.05 }, confidence: 0.8 } } }
    const w = world(on, { reply: (body: any) => (body.questions.tier ? TO_HAIKU : CONTINUE) })
    await start($)
    await turn($, 'rename foo to bar', 't1')
    await turn($, 'plan the rename', 't2', { permissionMode: 'plan' })
    const fork = await spawnAgent($)
    await drain($.turn.step(forkStep(fork)))
    await turn($, 'ok, do it', 't3')
    await drain($.turn.step({ ...forkStep(fork), index: 1 }))
    expect(w.steps.map(s => s.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5'])
  })

  test('under opusplan a fork made while planning stays on Opus, as the main loop does', FOLLOW, async ($, on) => {
    const TO_HAIKU = { answers: { ...SURE_EASY.answers, tier: { type: 'choice', choice: 'low', probabilities: { low: 0.85, balanced: 0.1, strong: 0.05 }, confidence: 0.8 } } }
    // The main loop's model, as the engine reports it, is Sonnet under opusplan; Opus is the request's while planning.
    const w = world(on, { reply: (body: any) => (body.questions.tier ? TO_HAIKU : CONTINUE) })
    await start($)
    await turn($, 'plan the rename', 't1', { permissionMode: 'plan', models: ['claude-opus-5-5'] })
    await drain($.turn.step(forkStep(await spawnAgent($), 'claude-opus-5-5')))
    expect(w.steps.map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('off by default, a fork is left alone', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await drain($.turn.step(forkStep(await spawnAgent($))))
    expect(w.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('in shadow or once the person picked the model, a fork is left alone', FOLLOW, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await command($, 'shadow')
    await drain($.turn.step(forkStep(await spawnAgent($))))
    await command($, 'auto')
    await switchModel($, 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'command')
    await drain($.turn.step(forkStep(await spawnAgent($), 'claude-haiku-4-5-20251001')))
    expect(w.steps.slice(1).map(s => s.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
  })
})

describe('/jcGearbox-stats', () => {
  const at = (day: number) => Date.UTC(2026, 9, day, 12)
  const LOG = {
    'log:1:session-1:0': {
      at: at(8), mode: 'auto', first: true, prompt: 'a', promptLength: 1, session: 'session-1', jevMs: 300,
      jev: { signals: { effortScore: 2 } }, model: 'claude-opus-5-5', effort: 'high',
      engine: { model: 'claude-sonnet-5-5', effort: 'high' }, sent: { model: 'claude-opus-5-5', effort: 'high' },
    },
    'log:2:session-2:1': {
      at: at(8), mode: 'shadow', first: true, prompt: 'b', promptLength: 1, session: 'session-2', jevMs: 500,
      jev: { signals: { effortScore: 1 } }, effort: 'medium', sent: { model: 'claude-opus-5-5', effort: 'xhigh' },
    },
    'log:3:session-1:2': {
      at: at(9), mode: 'auto', first: false, prompt: 'c', promptLength: 1, session: 'session-1', jevMs: 200, why: ['Jev unsure'],
      jev: { signals: { effortScore: 0, escalate: 0.9 } }, effort: 'low',
      engine: { model: 'claude-sonnet-5-5', effort: 'high' }, sent: { model: 'claude-opus-5-5', effort: 'low' },
    },
    'log:4:session-1:3': {
      at: at(9), mode: 'auto', first: false, prompt: 'd', promptLength: 1, session: 'session-1', jev: null, error: 'timeout', jevMs: 3000,
      effort: 'low', engine: { model: 'claude-sonnet-5-5', effort: 'high' }, sent: { model: 'claude-opus-5-5', effort: 'low' },
    },
    'log:5:session-3:4': {
      at: at(9), mode: 'auto', first: true, prompt: 'e', promptLength: 1, session: 'session-3', jev: null, error: 'HTTP 503', jevMs: 100,
      engine: { model: 'claude-sonnet-5-5', effort: 'high' }, sent: { model: 'claude-sonnet-5-5', effort: 'high' },
    },
  }

  test('counts the logged decisions against the engine\'s own model and effort', async ($, on) => {
    world(on, { store: LOG })
    await start($)
    expect((await run($, 'jcGearbox-stats')).text).toBe(
      [
        'jcGearbox stats: the last 5 decisions, 3 sessions, 10-08 to 10-09',
        "first-turn model, Jev's vs the engine's (2): up 1 · same 1 · down 0",
        "effort, the router's vs the engine's (3): higher 0 · same 1 · lower 2",
        'Jev: 2 errors of 5 (40%) · unsure of the effort 1 · answers took p50 300 ms, p95 500 ms',
        'complaints: 1 of 1 later turns Jev answered (100%)',
      ].join('\n'),
    )
    expect((await command($, 'stats')).text).toBe((await run($, 'jcGearbox-stats')).text)
  })

  test('says how the turns went, how much of the prompt the cache served, and how full the rate limits were', async ($, on) => {
    const tally = (reason: string, input: number, cacheRead: number, cacheWrite: number) =>
      ({ reason, steps: 1, stop: 'end_turn', input, output: 10, cacheRead, cacheWrite })
    const entry = (n: number, session: string, sent: object, outcome: object, limits?: object) => ({
      at: at(8) + n, mode: 'auto', first: n === 1, prompt: 'p', promptLength: 1, session, jev: null, error: 'timeout',
      sent, outcome, ...(limits ? { limits } : {}),
    })
    world(on, {
      store: {
        'log:1:session-1:0': entry(1, 'session-1', { model: 'claude-opus-5-5', effort: 'high' }, tally('answer', 100, 0, 900), { five_hour: 20, seven_day: 5 }),
        'log:2:session-1:1': entry(2, 'session-1', { model: 'claude-opus-5-5', effort: 'high' }, tally('answer', 50, 900, 50)),
        'log:3:session-1:2': entry(3, 'session-1', { model: 'claude-opus-5-5', effort: 'low' }, tally('error', 1000, 0, 0), { five_hour: 60, seven_day: 10 }),
        'log:4:session-2:3': entry(4, 'session-2', { model: 'claude-sonnet-5-5', effort: 'high' }, tally('aborted', 10, 90, 0), { five_hour: 40 }),
      },
    })
    await start($)
    expect((await run($, 'jcGearbox-stats')).text.split('\n').slice(5)).toEqual([
      'turns: 2 answered · 1 error · 1 interrupted · 0 refused',
      'cache reads, share of the prompt: all 32% (4) · same model and effort 90% (1) · new effort 0% (1)',
      'rate limits, last (peak): five_hour 40% (60%) · seven_day 10% (10%)',
    ])
  })

  test('says so when nothing is logged yet', async ($, on) => {
    world(on)
    await start($)
    expect((await run($, 'jcGearbox-stats')).text).toBe('jcGearbox: no decisions logged yet.')
  })
})
