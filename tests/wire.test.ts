import { describe, expect, test } from 'claude-code/testing'

import { STRONG, firstStrongThenContinue, start, turn, world } from './world.ts'

const TAIL = { options: { send_assistant_tail: true } }
const NO_TAIL = { options: { send_assistant_tail: false } }

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

  test("a Bedrock ARN's account and region are not sent", { options: { default_mode: 'auto' } }, async ($, on) => {
    const ARN = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123'
    const w = world(on, { reply: firstStrongThenContinue, thirdParty: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { models: [ARN] })
    await turn($, 'ok', 't2', { models: [ARN] })
    expect(w.asked[1].state.previous.model).toBe('abc123')
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

  test('assistant_tail_chars sets how much of the reply is kept and sent', { options: { send_assistant_tail: true, assistant_tail_chars: 300 } }, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue, store: { 'session:session-1': { replyTail: 'x'.repeat(1000) } } })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: `${'a'.repeat(1000)}${'b'.repeat(300)}` })
    expect(w.asked[0].state.previous_reply_tail).toHaveLength(300)
    expect((w.db.get('session:session-1') as any).replyTail).toBe('b'.repeat(300))
    await turn($, 'yes', 't2')
    expect(w.asked[1].state.previous_reply_tail).toBe('b'.repeat(300))
  })

  test("a subagent's report is not taken for Claude's reply", TAIL, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply the plan?' })
    await $.turn.complete({ answer: 'Report: 12 files', durationMs: 5, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' })
    await turn($, 'yes', 't2')
    expect(w.asked[1].state.previous_reply_tail).toBe('Shall I apply the plan?')
  })

  test('a turn with no reply to show leaves no older reply beside its prompt', TAIL, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply the plan?' })
    await turn($, 'yes', 't2', { answer: '', reason: 'aborted' })
    await turn($, 'that is not what I asked', 't3')
    expect(w.asked[2].state.previous_prompt).toBe('yes')
    expect(w.asked[2].state.previous_reply_tail).toBeUndefined()
  })

  test("off by default: Claude's reply does not reach the next request", async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply?' })
    await turn($, 'yes', 't2')
    expect(w.asked[1].state).not.toHaveProperty('previous_reply_tail')
  })

  test("off: the reply's end is not kept", NO_TAIL, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { answer: 'Shall I apply?' })
    await turn($, 'yes', 't2')
    expect(w.asked[1].state).not.toHaveProperty('previous_reply_tail')
    expect(w.db.get('session:session-1')).not.toHaveProperty('replyTail')
  })

  test('off: a tail kept earlier is not sent', NO_TAIL, async ($, on) => {
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

  test('a pasted key is kept as [redacted], in the session and the log alike', { options: { send_assistant_tail: true } }, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    const key = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    await turn($, `push with ${key}`, 't1', { answer: `Pushed with ${key}` })
    const stored = JSON.stringify([...w.db.values()])
    expect(stored).not.toContain('ghp_')
    expect((w.db.get('session:session-1') as any).prompt).toBe('push with [redacted]')
  })

  test("the log keeps the engine's own model and effort, Jev's time and version, the rate limits and how the turn went", async ($, on) => {
    const w = world(on, {
      reply: { ...STRONG, model: 'jev-1.13.0' },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      gate: () => w.clock.sleep(300),
    })
    await start($)
    const done = turn($, 'redesign the sync engine', 't1', { models: ['claude-sonnet-5-5', 'claude-sonnet-5-5'], effort: 'medium' })
    await w.clock.settle()
    await w.clock.advance(300)
    await done
    const entry = [...w.db].find(([k]) => k.startsWith('log:'))?.[1] as any
    expect(entry.engine).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(entry.jevMs).toBe(300)
    expect(entry.jev.version).toBe('jev-1.13.0')
    expect(entry.limits).toEqual({ five_hour: 23.5 })
    expect(entry.outcome).toEqual({ reason: 'answer', steps: 2, stop: 'end_turn', input: 2, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  for (const mode of ['shadow', 'auto']) {
    test(`a turn interrupted in its first request still gets its outcome (${mode})`, { options: { default_mode: mode } }, async ($, on) => {
      let release = () => {}
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const w = world(on, { reply: STRONG, stepHold: () => held })
      await start($)
      await $.prompt.submit({ text: 'redesign the sync engine', wait: false, origin: { kind: 'sdk' } })
      await $.turn.start({ text: 'redesign the sync engine', turnId: 't1' })
      const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 2, effort: 'high' })
      await stream.next()
      await w.clock.settle()
      await stream.return(undefined as any) // the person interrupts mid-reply
      await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't1', reason: 'aborted' })
      release()
      await w.clock.settle()
      const entry = [...w.db].find(([k]) => k.startsWith('log:'))?.[1] as any
      expect(entry.outcome).toEqual({ reason: 'aborted', steps: 0, stop: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    })
  }

  test('a Claude Code that cannot report its rate limits still gets the decision', { options: { default_mode: 'auto' } }, async ($, on) => {
    const w = world(on, { reply: STRONG, noUsage: true })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    const entry = [...w.db].find(([k]) => k.startsWith('log:'))?.[1] as any
    expect(entry.limits).toBeUndefined()
  })

  test("the log keeps Jev's probability for each effort level and its confidence, deciding as before", { options: { default_mode: 'auto' } }, async ($, on) => {
    const effort = { type: 'score', score: 2.2, probabilities: { '0': 0.05, '1': 0.15, '2': 0.5, '3': 0.2, '4': 0.1 }, confidence: 0.9 }
    const w = world(on, { reply: { answers: { ...STRONG.answers, effort } } })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    const entry = [...w.db].find(([k]) => k.startsWith('log:'))?.[1] as any
    expect(entry.jev.signals.effortProbabilities).toEqual([0.05, 0.15, 0.5, 0.2, 0.1])
    expect(entry.jev.signals.effortConfidence).toBe(0.9)
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
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

  test('without HOME, as on Windows, the catalog is read from USERPROFILE', async ($, on) => {
    const w = world(on, { reply: STRONG, env: { HOME: undefined, USERPROFILE: '/users/u' } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.listed).toEqual(['/users/u/.claude/cache/model-catalog'])
  })

  test('with no home directory at all, no catalog is read', async ($, on) => {
    const w = world(on, { reply: STRONG, env: { HOME: undefined } })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    expect(w.listed).toEqual([])
  })
})
