import { describe, expect, test } from 'claude-code/testing'

import { decideEffort, defaultEffort, effortFor, effortFromScore, pickModel } from '../hooks/policy.ts'

const base = { threshold: 0.7, continuationThreshold: 0.7, minEffort: 'low' as const, maxEffort: 'max' as const }

describe('effortFromScore', () => {
  test('rounds the expected level and clamps it to the scale', () => {
    expect(effortFromScore(0)).toBe('low')
    expect(effortFromScore(1.4)).toBe('medium')
    expect(effortFromScore(1.5)).toBe('high')
    expect(effortFromScore(3.6)).toBe('max')
    expect(effortFromScore(-1)).toBe('low')
    expect(effortFromScore(9)).toBe('max')
  })
})

describe('decideEffort', () => {
  test('first turn takes the score', () => {
    const r = decideEffort({ ...base, isFirstTurn: true, previous: undefined, signals: { effortScore: 2.2 } })
    expect(r).toEqual({ effort: 'high' })
  })

  test('a continuation keeps the previous effort instead of the short prompt score', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'xhigh',
      signals: { effortScore: 0.1, continuation: 0.9 },
    })
    expect(r.effort).toBe('xhigh')
  })

  test('a complaint on a continuation still raises the effort one level', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'high',
      signals: { effortScore: 0.3, continuation: 0.95, escalate: 0.9 },
    })
    expect(r).toEqual({ effort: 'xhigh' })
  })

  test('a complaint taken for a new task still goes up from the previous effort', () => {
    const complaint = { effortScore: 0.2, continuation: 0.1, escalate: 0.9 }
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'high', signals: complaint })).toEqual({ effort: 'xhigh' })
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'max', signals: complaint }).effort).toBe('max')
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'low', signals: { ...complaint, effortScore: 2.2 } }).effort).toBe(
      'xhigh',
    )
  })

  test('a complaint at max stays at max', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'max',
      signals: { effortScore: 1, continuation: 0.9, escalate: 0.9 },
    })
    expect(r).toEqual({ effort: 'max' })
  })

  test('high stakes lifts the effort to at least high', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'low',
      signals: { effortScore: 0.4, highStakes: 0.8 },
    })
    expect(r.effort).toBe('high')
    expect(decideEffort({ ...base, isFirstTurn: true, previous: undefined, signals: { effortScore: 0, highStakes: 0.8 } }).effort).toBe('high')
  })

  test('without a score, a new task keeps the previous effort, and with none there is nothing to decide', () => {
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'high', signals: { continuation: 0.1 } }).effort).toBe('high')
    expect(decideEffort({ ...base, isFirstTurn: false, previous: undefined, signals: { continuation: 0.1 } }).effort).toBeUndefined()
  })

  test('the floor applies last', () => {
    const r = decideEffort({
      ...base,
      minEffort: 'medium',
      isFirstTurn: true,
      previous: undefined,
      signals: { effortScore: 0 },
    })
    expect(r.effort).toBe('medium')
  })

  test('continuation and escalate are ignored on the first turn', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: true,
      previous: undefined,
      signals: { effortScore: 1, continuation: 0.99, escalate: 0.99 },
    })
    expect(r).toEqual({ effort: 'medium' })
  })

  test('signals at the threshold do not count', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'max',
      signals: { effortScore: 0, continuation: 0.7 },
    })
    expect(r.effort).toBe('low')
  })

  test('the ceiling caps the score, a complaint and high stakes, and wins over the floor', () => {
    const capped = (signals: object, extra: object = {}) =>
      decideEffort({ ...base, maxEffort: 'high', isFirstTurn: false, previous: 'high', signals: { effortScore: 0, ...signals }, ...extra }).effort
    expect(capped({ effortScore: 4 })).toBe('high')
    expect(capped({ continuation: 0.9, escalate: 0.9 })).toBe('high')
    expect(capped({ highStakes: 0.9 })).toBe('high')
    expect(capped({}, { minEffort: 'max' })).toBe('high')
    expect(decideEffort({ ...base, maxEffort: 'medium', isFirstTurn: false, previous: 'xhigh', signals: undefined }).effort).toBe('medium')
  })

  test('a continuation has its own threshold', () => {
    const at = (continuation: number) =>
      decideEffort({ ...base, continuationThreshold: 0.6, isFirstTurn: false, previous: 'high', signals: { effortScore: 0, continuation, escalate: 0.65 } })
    expect(at(0.65)).toEqual({ effort: 'high' })
    expect(at(0.6).effort).toBe('low')
  })

  test('a complaint or high stakes at the threshold does not count either', () => {
    const at = (signals: object) => decideEffort({ ...base, isFirstTurn: false, previous: 'low', signals: { effortScore: 0, ...signals } })
    expect(at({ escalate: 0.7 })).toEqual({ effort: 'low' })
    expect(at({ highStakes: 0.7 }).effort).toBe('low')
  })

  test('when Jev is unsure of the effort, the last effort holds, and a first turn changes nothing', () => {
    const unsure = { effortScore: 0, effortConfidence: 0.5 }
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: 'xhigh', signals: unsure })).toEqual({
      effort: 'xhigh',
      unsure: true,
    })
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: true, previous: undefined, signals: unsure }).effort).toBeUndefined()
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: 'xhigh', signals: { ...unsure, effortConfidence: 0.7 } }).effort).toBe('low')
    expect(decideEffort({ ...base, minConfidence: 0, isFirstTurn: false, previous: 'xhigh', signals: unsure }).effort).toBe('low')
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'xhigh', signals: { effortScore: 0 } }).effort).toBe('low')
  })

  test('with no effort to hold, an unsure turn sets none, unless the task is risky', () => {
    const unsure = { effortScore: 0, effortConfidence: 0.3 }
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: undefined, signals: { ...unsure, escalate: 0.9 } })).toEqual({
      effort: undefined,
      unsure: true,
    })
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: true, previous: undefined, signals: { ...unsure, highStakes: 0.95 } }).effort).toBe('high')
    expect(decideEffort({ ...base, minConfidence: 0.7, maxEffort: 'medium', isFirstTurn: true, previous: undefined, signals: { ...unsure, highStakes: 0.95 } }).effort).toBe('medium')
  })

  test('a continuation with no effort to keep takes the score only when Jev is sure of it', () => {
    const go = (effortConfidence: number) =>
      decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: undefined, signals: { effortScore: 4, effortConfidence, continuation: 0.9 } })
    expect(go(0.2)).toEqual({ effort: undefined, unsure: true })
    expect(go(0.9)).toEqual({ effort: 'max' })
  })

  test('an unsure effort still goes up on a complaint and to high on a risk, and a continuation still keeps it', () => {
    const unsure = { effortScore: 0, effortConfidence: 0.3 }
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: 'medium', signals: { ...unsure, escalate: 0.9 } }).effort).toBe('high')
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: 'low', signals: { ...unsure, highStakes: 0.9 } }).effort).toBe('high')
    expect(decideEffort({ ...base, minConfidence: 0.7, isFirstTurn: false, previous: 'max', signals: { ...unsure, continuation: 0.95 } })).toEqual({ effort: 'max' })
  })

  test('without an answer the first turn changes nothing and later turns keep the previous effort', () => {
    expect(decideEffort({ ...base, isFirstTurn: true, previous: undefined, signals: undefined }).effort).toBeUndefined()
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'high', signals: undefined }).effort).toBe('high')
  })
})

describe('pickModel', () => {
  const all = { low: 'claude-haiku-5-5', balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5', long: 'claude-fable-5-1' }
  const pick = (probabilities: object | undefined, engine: string[], models: object = all) =>
    pickModel({ probabilities, models, engine, upgrade: 0.5, downgrade: 0.8 } as any)

  test('moves up once the tiers at and above one add up to the upgrade probability', () => {
    expect(pick({ balanced: 0.45, strong: 0.3, long: 0.25 }, ['balanced'])).toBe('claude-opus-5-5')
    expect(pick({ balanced: 0.55, strong: 0.3, long: 0.15 }, ['balanced'])).toBeUndefined()
  })

  test('moves up to the strongest tier that clears it', () => {
    expect(pick({ strong: 0.2, long: 0.6, balanced: 0.2 }, ['balanced'])).toBe('claude-fable-5-1')
  })

  test('moves down only once the tiers at and below one add up to the downgrade probability', () => {
    expect(pick({ low: 0.3, balanced: 0.45, strong: 0.25 }, ['strong'])).toBeUndefined()
    expect(pick({ low: 0.3, balanced: 0.55, strong: 0.15 }, ['strong'])).toBe('claude-sonnet-5-5')
    expect(pick({ low: 0.85, balanced: 0.1, strong: 0.05 }, ['strong'])).toBe('claude-haiku-5-5')
  })

  test('tiers on one model pool, and the engine model counts as every tier it is', () => {
    const models = { low: 'claude-sonnet-5-5', balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' }
    expect(pick({ low: 0.45, balanced: 0.4, strong: 0.15 }, ['strong'], models)).toBe('claude-sonnet-5-5')
    expect(pick({ low: 0.3, balanced: 0.2, strong: 0.5 }, ['low', 'balanced'], models)).toBe('claude-opus-5-5')
    expect(pick({ low: 0.9, balanced: 0.1 }, ['low', 'balanced'], models)).toBeUndefined()
  })

  test("with no tier for the engine's model, the likeliest model needs the downgrade probability", () => {
    expect(pick({ balanced: 0.15, strong: 0.85 }, [])).toBe('claude-opus-5-5')
    expect(pick({ balanced: 0.3, strong: 0.7 }, [])).toBeUndefined()
  })

  test('a tier with no model passes its share up, and no answer picks nothing', () => {
    const models = { low: 'claude-haiku-5-5', balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' }
    expect(pick({ balanced: 0.1, long: 0.9 }, ['balanced'], models)).toBe('claude-opus-5-5')
    expect(pick(undefined, ['balanced'])).toBeUndefined()
  })

  test("asked about no tier of the engine's, the answer moves the session nowhere", () => {
    // Two tiers on Bedrock, the session on Opus: the answer adds up to one below it.
    const two = { low: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-haiku-5-5-v1:0', balanced: 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-5-5-v1:0' }
    expect(pick({ low: 0.05, balanced: 0.95 }, ['strong'], two)).toBeUndefined()
    expect(pick({ low: 0.9, balanced: 0.1 }, ['strong'], two)).toBeUndefined()
    // The long tier off, the session on Fable.
    const three = { low: 'claude-haiku-5-5', balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' }
    expect(pick({ low: 0.05, balanced: 0.05, strong: 0.9 }, ['long'], three)).toBeUndefined()
    // And the same above the engine: the answer adds up to one above it.
    expect(pick({ balanced: 0.3, strong: 0.7 }, ['low'], { balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' })).toBeUndefined()
    // Given its share, the engine's tier is compared against like any other.
    expect(pick({ low: 0.05, balanced: 0.05, strong: 0.4, long: 0.5 }, ['long'], three)).toBeUndefined()
    expect(pick({ low: 0.05, balanced: 0.05, strong: 0.8, long: 0.1 }, ['long'], three)).toBe('claude-opus-5-5')
  })
})

describe('effortFor', () => {
  test('Haiku takes no effort', () => {
    expect(effortFor('claude-haiku-4-5-20251001', 'low')).toBeUndefined()
  })

  test('Opus 4.5 stops at high; Opus 4.6 and Sonnet 4.6 have no xhigh', () => {
    expect(effortFor('claude-opus-4-5-20251101', 'max')).toBe('high')
    expect(effortFor('claude-opus-4-5-20251101', 'medium')).toBe('medium')
    expect(effortFor('claude-opus-4-6', 'xhigh')).toBe('high')
    expect(effortFor('claude-sonnet-4-6', 'max')).toBe('max')
    expect(effortFor('claude-sonnet-4-6', 'xhigh')).toBe('high')
  })

  test('current models and unknown ids take every level', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'my-gateway-model']) {
      expect(effortFor(model, 'xhigh')).toBe('xhigh')
    }
    expect(effortFor('claude-opus-5-5', undefined)).toBeUndefined()
  })

  test('Haiku 5.5 takes every level; Haiku 4.5 and older take none', () => {
    for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5[1m]', 'us.anthropic.claude-haiku-5-5']) {
      expect(effortFor(model, 'low')).toBe('low')
      expect(effortFor(model, 'max')).toBe('max')
    }
    for (const model of ['claude-haiku-4-5-20251001', 'anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-3-5-haiku-20241022']) {
      expect(effortFor(model, 'high')).toBeUndefined()
    }
  })

  test('models older than Opus 4.5 and Sonnet 4.6 take no effort, on every platform', () => {
    for (const model of [
      'claude-sonnet-4-5-20250929',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4@20250514',
      'anthropic.claude-opus-4-20250514-v1:0',
      'claude-opus-4-1-20250805',
      'claude-3-7-sonnet-20250219',
    ]) {
      expect(effortFor(model, 'high')).toBeUndefined()
    }
  })

  test('Mythos Preview takes max but not xhigh; Opus 4.7, 4.8 and 5 take both', () => {
    expect(effortFor('claude-mythos-preview', 'xhigh')).toBe('high')
    expect(effortFor('claude-mythos-preview', 'max')).toBe('max')
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-mythos-5-1']) {
      expect(effortFor(model, 'xhigh')).toBe('xhigh')
      expect(effortFor(model, 'max')).toBe('max')
    }
  })
})

describe('defaultEffort', () => {
  test('medium on the 5.5 models, xhigh on Opus 4.7, high on the rest, none where effort is not taken', () => {
    expect(defaultEffort('claude-opus-5-5')).toBe('medium')
    expect(defaultEffort('claude-opus-5-5[1m]')).toBe('medium')
    expect(defaultEffort('claude-haiku-5-5')).toBe('medium')
    expect(defaultEffort('claude-sonnet-5-5')).toBe('medium')
    expect(defaultEffort('claude-opus-4-7')).toBe('xhigh')
    expect(defaultEffort('us.anthropic.claude-opus-4-7-v1:0')).toBe('xhigh')
    expect(defaultEffort('claude-fable-5-1')).toBe('high')
    expect(defaultEffort('claude-opus-5')).toBe('high')
    expect(defaultEffort('claude-haiku-4-5-20251001')).toBeUndefined()
  })
})
