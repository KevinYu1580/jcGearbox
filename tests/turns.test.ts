import { describe, expect, test } from 'claude-code/testing'

import { AUTO, CONTINUE, EASY, FRAME, STRONG, command, commandText, drain, firstStrongThenContinue, start, switchModel, turn, world } from './world.ts'

const firstEasyThenContinue = (body: any) => (body.questions.tier ? EASY : CONTINUE)

describe("the person's turns", () => {
  test('prompts typed or sent over Remote Control ask Jev', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { origin: 'composer' })
    await turn($, 'now the tests', 't2', { origin: 'bridge' })
    expect(w.asked.map(b => b.state.prompt)).toEqual(['redesign the sync engine', 'now the tests'])
  })

  test('a Slack ping asks Jev with its text, without the frame the engine puts before it', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { origin: 'slack-ping', startText: FRAME + 'redesign the sync engine' })
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0].state.prompt).toBe('redesign the sync engine')
  })
})

describe('turns nobody typed', () => {
  test('a task notification or a scheduled trigger asks nothing and keeps the model and effort', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    await turn($, 'Background task finished', 't2', { origin: 'task-notification', effort: 'medium' })
    await turn($, 'run the nightly check', 't3', { origin: 'scheduled-trigger', effort: 'medium' })
    expect(w.asked).toHaveLength(1)
    expect(w.steps.map(s => `${s.model}·${String(s.effort)}`)).toEqual([
      'claude-opus-5-5·high',
      'claude-opus-5-5·high',
      'claude-opus-5-5·high',
    ])
  })

  test('a turn with no submission behind it asks nothing and keeps the model and effort', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    await turn($, 'carry on', 't2', { submit: false, effort: 'medium' })
    expect(w.asked).toHaveLength(1)
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('a turn starting from other text than was submitted asks nothing and keeps the model and effort', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'redesign the sync engine', 't1', { effort: 'medium' })
    await turn($, 'fix it', 't2', { startText: 'fix it, said another plugin', effort: 'medium' })
    expect(w.asked).toHaveLength(1)
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

describe('slash commands', () => {
  test('a typed command is a user turn: Jev reads it as typed and the first one decides the model', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/review the auth module', 't1', { origin: 'composer', startText: commandText('review', 'the auth module') })
    expect(w.asked).toHaveLength(1)
    expect(w.asked[0].state.prompt).toBe('/review the auth module')
    expect(Object.keys(w.asked[0].questions)).toContain('tier')
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test('a short name the engine resolved to a plugin command is a user turn', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/foo x', 't1', { origin: 'composer', startText: commandText('plug:foo', 'x') })
    expect(w.asked.map(b => b.state.prompt)).toEqual(['/foo x'])
  })

  test('a prompt that quotes a command tag is not a command', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, 'why does <command-name>/review</command-name> show up in the log?', 't1', { effort: 'medium' })
    expect(w.steps).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test("a command's own model rides its turn alone", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await turn($, '/quick x', 't2', { origin: 'composer', startText: commandText('quick', 'x'), models: ['claude-haiku-4-5-20251001'] })
    expect(w.steps.at(-1)?.model).toBe('claude-haiku-4-5-20251001')
    await turn($, 'ok', 't3')
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
  })

  test("a command on the model the engine switched to itself is routed, as a plan mode under opusplan leaves it", AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5', 'auto')
    await switchModel($, 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'auto')
    await turn($, '/review x', 't2', { origin: 'composer', startText: commandText('review', 'x'), models: ['claude-haiku-4-5-20251001'] })
    expect(w.steps.at(-1)?.model).toBe('claude-opus-5-5')
    expect((await command($, 'log 1')).text).not.toContain('command model')
  })

  test('a command other than the one submitted is not a user turn', AUTO, async ($, on) => {
    const w = world(on, { reply: STRONG })
    await start($)
    await turn($, '/foo x', 't1', { origin: 'composer', startText: commandText('review', 'x') })
    expect(w.asked).toHaveLength(0)
  })

  test("a command's own effort rides its turn alone and pins nothing", AUTO, async ($, on) => {
    const w = world(on, { reply: firstEasyThenContinue })
    await start($)
    await turn($, 'rename foo to bar', 't1', { effort: 'high' })
    expect(w.steps.at(-1)?.effort).toBe('low')
    await turn($, '/review x', 't2', { origin: 'composer', startText: commandText('review', 'x'), effort: 'max' })
    expect(w.steps.at(-1)?.effort).toBe('max')
    expect(w.status.at(-1)).not.toContain('effort pinned')
    await turn($, 'ok', 't3', { effort: 'high' })
    expect(w.steps.at(-1)?.effort).toBe('low')
  })

  test("a command at the previous turn's engine effort gets the router's effort", AUTO, async ($, on) => {
    const w = world(on, { reply: firstEasyThenContinue })
    await start($)
    await turn($, 'rename foo to bar', 't1', { effort: 'high' })
    await turn($, '/review x', 't2', { origin: 'composer', startText: commandText('review', 'x'), effort: 'high' })
    expect(w.steps.map(s => s.effort)).toEqual(['low', 'low'])
  })

  test("with no baseline to compare with, a command's effort is left alone", AUTO, async ($, on) => {
    const w = world(on, { reply: firstEasyThenContinue })
    await start($)
    const review = { origin: 'composer', startText: commandText('code-review', 'max'), effort: 'max' }
    await turn($, '/code-review max', 't1', review)
    expect(w.steps.at(-1)?.effort).toBe('max')
    await turn($, 'rename foo to bar', 't2', { effort: 'high' })
    await switchModel($, 'claude-sonnet-5-5', 'claude-opus-5-5')
    await turn($, '/code-review max', 't3', { ...review, models: ['claude-opus-5-5'] })
    expect(w.steps.at(-1)?.effort).toBe('max')
    await command($, 'auto')
    await turn($, '/code-review max', 't4', review)
    expect(w.steps.at(-1)?.effort).toBe('max')
  })
})

describe('a turn that starts after its first request', () => {
  test('keeps what that request decides when it starts while the request is being decided', AUTO, async ($, on) => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let holding = false
    const w = world(on, { reply: firstStrongThenContinue, storeHolds: key => (holding && key.startsWith('session:') ? held : undefined) })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await $.prompt.submit({ text: 'now the tests', wait: false, origin: { kind: 'sdk' } })
    holding = true
    const first = drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 4, effort: 'high' }))
    await w.clock.settle()
    await $.turn.start({ text: 'now the tests', turnId: 't2' })
    holding = false
    release()
    await first
    for (const index of [1, 2]) await drain($.turn.step({ turnId: 't2', index, model: 'claude-sonnet-5-5', messageCount: 4 + index, effort: 'high' }))
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.steps.slice(1).map(s => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
  })

  test('keeps what that request decided', AUTO, async ($, on) => {
    const w = world(on, { reply: firstStrongThenContinue })
    await start($)
    await turn($, 'redesign the sync engine', 't1')
    await $.prompt.submit({ text: 'now the tests', wait: false, origin: { kind: 'sdk' } })
    await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 4, effort: 'high' }))
    await $.turn.start({ text: 'now the tests', turnId: 't2' })
    await drain($.turn.step({ turnId: 't2', index: 1, model: 'claude-sonnet-5-5', messageCount: 5, effort: 'high' }))
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.asked).toHaveLength(1)
    expect(w.steps.slice(1)).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })
})
