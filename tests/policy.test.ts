import { describe, expect, test } from 'claude-code/testing'

import { decideEffort, effortFromScore, pickModel } from '../hooks/policy.ts'

const base = { threshold: 0.7, minEffort: 'low' as const }

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

  test('high stakes lifts the effort to at least xhigh', () => {
    const r = decideEffort({
      ...base,
      isFirstTurn: false,
      previous: 'low',
      signals: { effortScore: 0.4, highStakes: 0.8 },
    })
    expect(r.effort).toBe('xhigh')
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
