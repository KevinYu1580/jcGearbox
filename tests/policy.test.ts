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
    expect(r).toEqual({ effort: 'high', escalated: false })
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
    expect(r).toEqual({ effort: 'xhigh', escalated: true })
  })

  test('a complaint at max stays at max', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'max',
      signals: { effortScore: 1, continuation: 0.9, escalate: 0.9 },
    })
    expect(r).toEqual({ effort: 'max', escalated: true })
  })

  test('high stakes lifts the effort to at least high', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'low',
      signals: { effortScore: 0.4, highStakes: 0.8 },
    })
    expect(r.effort).toBe('high')
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
    expect(r).toEqual({ effort: 'medium', escalated: false })
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
    expect(at(0.65)).toEqual({ effort: 'high', escalated: false })
    expect(at(0.6).effort).toBe('low')
  })

  test('a complaint or high stakes at the threshold does not count either', () => {
    const at = (signals: object) => decideEffort({ ...base, isFirstTurn: false, previous: 'low', signals: { effortScore: 0, ...signals } })
    expect(at({ escalate: 0.7 })).toEqual({ effort: 'low', escalated: false })
    expect(at({ highStakes: 0.7 }).effort).toBe('low')
  })

  test('without an answer the first turn changes nothing and later turns keep the previous effort', () => {
    expect(decideEffort({ ...base, isFirstTurn: true, previous: undefined, signals: undefined }).effort).toBeUndefined()
    expect(decideEffort({ ...base, isFirstTurn: false, previous: 'high', signals: undefined }).effort).toBe('high')
  })
})

describe('pickModel', () => {
  const models = { low: 'claude-sonnet-5-5', balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' }

  test('tiers that resolve to the same model add up', () => {
    const picked = pickModel({ models, minProbability: 0.6, probabilities: { low: 0.35, balanced: 0.3, strong: 0.35 } })
    expect(picked).toBe('claude-sonnet-5-5')
  })

  test('below the minimum probability nothing is picked', () => {
    const picked = pickModel({
      models: { balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' },
      minProbability: 0.6,
      probabilities: { balanced: 0.45, strong: 0.55 },
    })
    expect(picked).toBeUndefined()
  })

  test('the stronger model wins a tie', () => {
    const picked = pickModel({
      models: { balanced: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' },
      minProbability: 0.5,
      probabilities: { balanced: 0.5, strong: 0.5 },
    })
    expect(picked).toBe('claude-opus-5-5')
  })

  test('tiers without a model and missing answers are ignored', () => {
    expect(pickModel({ models, minProbability: 0.6, probabilities: { long: 0.9, strong: 0.1 } })).toBeUndefined()
    expect(pickModel({ models, minProbability: 0.6, probabilities: undefined })).toBeUndefined()
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
  })

  test('current models and unknown ids take every level', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'my-gateway-model']) {
      expect(effortFor(model, 'xhigh')).toBe('xhigh')
    }
    expect(effortFor('claude-opus-5-5', undefined)).toBeUndefined()
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
  test('medium on Opus 5.5, high on the rest, none where effort is not taken', () => {
    expect(defaultEffort('claude-opus-5-5')).toBe('medium')
    expect(defaultEffort('claude-opus-5-5[1m]')).toBe('medium')
    expect(defaultEffort('claude-sonnet-5-5')).toBe('high')
    expect(defaultEffort('claude-fable-5-1')).toBe('high')
    expect(defaultEffort('claude-opus-5')).toBe('high')
    expect(defaultEffort('claude-haiku-4-5-20251001')).toBeUndefined()
  })
})
