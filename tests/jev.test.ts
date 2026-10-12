import { describe, expect, test } from 'claude-code/testing'

import { buildRequest, clip, parseAnswers, redact } from '../hooks/jev.ts'

describe('clip', () => {
  test('keeps short text whole', () => {
    expect(clip('abc', 10)).toBe('abc')
  })

  test('keeps the head and the tail of long text', () => {
    const out = clip(`${'a'.repeat(50)}MIDDLE${'b'.repeat(50)}`, 20)
    expect(out).toStartWith('a'.repeat(10))
    expect(out).toEndWith('b'.repeat(10))
    expect(out).not.toContain('MIDDLE')
  })
})

describe('buildRequest', () => {
  test('the first turn asks for a tier among the enabled tiers only', () => {
    const body = buildRequest({
      jevModel: 'jev-latest',
      prompt: 'fix the race',
      isFirstTurn: true,
      tiers: ['balanced', 'strong'],
    })
    expect(body.model).toBe('jev-latest')
    expect(Object.keys(body.questions)).toEqual(['tier', 'effort', 'high_stakes'])
    expect(Object.keys(body.questions.tier?.criteria ?? {})).toEqual(['strong', 'balanced'])
    expect(body.state).toEqual({ prompt: 'fix the race' })
  })

  test('the tier options start at strong, go down, and end at long', () => {
    const body = buildRequest({ jevModel: 'jev-latest', prompt: 'p', isFirstTurn: true, tiers: ['low', 'long', 'balanced', 'strong'] })
    expect(Object.keys(body.questions.tier?.criteria ?? {})).toEqual(['strong', 'balanced', 'low', 'long'])
  })

  test('a first turn with nothing to choose between asks no tier question', () => {
    const body = buildRequest({ jevModel: 'jev-latest', prompt: 'fix it', isFirstTurn: true, tiers: ['strong'] })
    expect(Object.keys(body.questions)).toEqual(['effort', 'high_stakes'])
  })

  test('later turns ask about continuation and complaints, with the context they read', () => {
    const body = buildRequest({
      jevModel: 'jev-latest',
      prompt: '好',
      isFirstTurn: false,
      previousPrompt: 'refactor the parser',
      replyTail: 'Shall I apply it?',
      previous: { model: 'claude-opus-5-5', effort: 'high' },
    })
    expect(Object.keys(body.questions)).toEqual(['effort', 'continuation', 'escalate', 'high_stakes'])
    expect(body.state).toEqual({
      prompt: '好',
      previous_prompt: 'refactor the parser',
      previous_reply_tail: 'Shall I apply it?',
      previous: { model: 'claude-opus-5-5', effort: 'high' },
    })
  })

  test('long prompts are clipped', () => {
    const body = buildRequest({
      jevModel: 'jev-latest',
      prompt: 'x'.repeat(9000),
      isFirstTurn: false,
      previousPrompt: 'y'.repeat(3000),
    })
    expect(body.state.prompt.length).toBe(6003)
    expect(body.state.previous_prompt?.length).toBe(3000) // the caller keeps 1000 chars of it
  })

  test('a cut through an emoji drops its half rather than send a lone surrogate', () => {
    const emoji = '😀'
    const body = buildRequest({
      jevModel: 'jev-latest',
      prompt: `${'a'.repeat(2999)}${emoji}${'b'.repeat(3001)}`,
      isFirstTurn: false,
      previousPrompt: `${emoji}tail`,
      replyTail: `${emoji.slice(1)}${'c'.repeat(10)}`, // a tail cut through the emoji
    })
    const lone = /\p{Cs}/u
    expect(lone.test(body.state.prompt)).toBe(false)
    expect(body.state.prompt.startsWith('a'.repeat(2999))).toBe(true)
    expect(body.state.previous_prompt).toBe(`${emoji}tail`)
    expect(lone.test(body.state.previous_reply_tail ?? '')).toBe(false)
  })

  test('each question has the type Jev expects', () => {
    const first = buildRequest({ jevModel: 'jev-latest', prompt: 'p', isFirstTurn: true, tiers: ['strong', 'balanced'] })
    expect(first.questions.tier?.type).toBe('choice')
    const later = buildRequest({ jevModel: 'jev-latest', prompt: 'p', isFirstTurn: false })
    expect(later.questions.effort?.type).toBe('score')
    expect(later.questions.effort?.criteria).toHaveLength(5)
    for (const id of ['continuation', 'escalate', 'high_stakes']) expect(later.questions[id]?.type).toBe('noul')
  })
})

describe('parseAnswers', () => {
  test('reads every answer it asked for', () => {
    const text = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        tier: { type: 'choice', choice: 'strong', probabilities: { balanced: 0.2, strong: 0.8 }, confidence: 0.6 },
        effort: { type: 'score', score: 2.4, legend: {}, probabilities: {}, confidence: 0.7 },
        continuation: { type: 'noul', noul: 0.1 },
        escalate: { type: 'noul', noul: 0.05 },
        high_stakes: { type: 'noul', noul: 0.9 },
      },
    })
    expect(parseAnswers(text)).toEqual({
      tierProbabilities: { balanced: 0.2, strong: 0.8 },
      signals: { effortScore: 2.4, continuation: 0.1, escalate: 0.05, highStakes: 0.9 },
      version: 'jev-1.13.0',
    })
  })

  test('drops malformed answers and rejects a body that is not an answer', () => {
    expect(parseAnswers('not json')).toBeUndefined()
    expect(parseAnswers(JSON.stringify({ error: 'bad' }))).toBeUndefined()
    expect(parseAnswers(JSON.stringify({ answers: { effort: { score: 'x' }, tier: { probabilities: { mystery: 1 } } } }))).toEqual({
      signals: {},
    })
  })
})

describe('redact', () => {
  test('hides the common key and token shapes, and leaves other text alone', () => {
    const secrets = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'sk-proj-AbCd3fGh1jKlMnOpQrStUvWx',
      'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'github_pat_11AbCdEfGhIjKlMnOpQrSt_UvWxYz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA-AbCdEfGhIjKlMnOpQrStUvWxYz01234',
      'sk_live_AbCdEfGhIjKlMnOpQrStUvWx',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ]
    for (const secret of secrets) expect(redact(`key=${secret} done`)).toBe('key=[redacted] done')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'
    expect(redact(`a ${pem} b`)).toBe('a [redacted] b')
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----'
    expect(redact(`a ${pgp} b`)).toBe('a [redacted] b')
    expect(redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe('aws_secret_access_key = [redacted]')
    expect(redact('AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"')).toBe('AWS_SECRET_ACCESS_KEY="[redacted]"')
    const plain = 'rename skill-tree to tree; ask about AKIA docs; see sk-1 and eyJ.x.y; use sk-button-primary-large-variant or sk-grid-12-column-layout-wide'
    expect(redact(plain)).toBe(plain)
  })

  test('every text sent to Jev is redacted', () => {
    const key = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const body = buildRequest({ jevModel: 'jev-latest', prompt: `use ${key}`, isFirstTurn: false, previousPrompt: key, replyTail: key })
    expect(JSON.stringify(body.state)).not.toContain('ghp_')
  })
})
