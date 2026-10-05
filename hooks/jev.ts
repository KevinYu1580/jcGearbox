// The Jev request and its answers (https://docs.typesafe.ai/api.md). Pure.

import { TIERS } from './policy.ts'
import type { Signals, Tier } from './policy.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

const PROMPT_CHARS = 6000
const CONTEXT_CHARS = 1000

const TIER_CRITERIA: Record<Tier, string> = {
  low: 'Lookup, explanation, rename, formatting, running a command, a one-line edit',
  balanced: 'A typical feature or bug fix within one module, writing tests, a single-file refactor',
  strong:
    'Cross-module design, hard debugging (concurrency, performance, memory), architecture decisions, security, ambiguous requirements',
  long: 'Multi-hour autonomous work, a repo-wide migration or audit',
}

const QUESTIONS = {
  effort: {
    type: 'score',
    instructions:
      'How much deliberate step-by-step reasoning does `prompt` need? When `prompt` is short, judge it as part of the task in `previous_prompt` and `previous_reply_tail`.',
    criteria: [
      'Mechanical, no reasoning',
      'A little reasoning',
      'Moderate reasoning',
      'Deep reasoning',
      'Maximal: subtle, high-stakes reasoning',
    ],
  },
  continuation: {
    type: 'noul',
    instructions:
      'Is `prompt` only approving, answering or continuing the task from `previous_prompt`, rather than starting a new task?',
    criteria: {
      true: 'ok / continue / go ahead / yes / a short answer or minor follow-up on the same task',
      false: 'A new or substantially different task',
    },
  },
  escalate: {
    type: 'noul',
    instructions: 'Does `prompt` say the previous attempt was wrong or failed?',
    criteria: {
      true: "Still broken, wrong, didn't work, try again",
      false: 'No complaint about the previous attempt',
    },
  },
  high_stakes: {
    type: 'noul',
    instructions: 'Could a mistake while doing `prompt` cause hard-to-reverse damage?',
    criteria: {
      true: 'Production systems, data deletion, database migrations, auth or security, money, force-push or history rewrite',
      false: 'Local and reversible',
    },
  },
} as const

type Question = { type: string; instructions: string; criteria: unknown }

export type JevState = {
  prompt: string
  previous_prompt?: string
  previous_reply_tail?: string
  previous?: { model?: string; effort?: string }
}

export type JevRequest = {
  model: string
  state: JevState
  questions: { tier?: Question & { criteria: Partial<Record<Tier, string>> } } & Record<string, Question>
}

export type JevResult = {
  tierProbabilities?: Partial<Record<Tier, number>>
  signals: Signals
}

// Keeps the head and the tail: a pasted log often ends with the actual ask.
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(text.length - half)}`
}

// The first turn asks for a tier among `tiers` (two at least, or there is
// nothing to choose); later turns ask whether the prompt continues the task
// or complains about the last attempt.
export function buildRequest(input: {
  jevModel: string
  prompt: string
  isFirstTurn: boolean
  tiers?: readonly Tier[]
  previousPrompt?: string
  replyTail?: string
  previous?: { model?: string; effort?: string }
}): JevRequest {
  const { jevModel, prompt, isFirstTurn, tiers, previousPrompt, replyTail, previous } = input
  const state: JevState = { prompt: clip(prompt, PROMPT_CHARS) }
  if (previousPrompt) state.previous_prompt = clip(previousPrompt, CONTEXT_CHARS)
  if (replyTail) state.previous_reply_tail = replyTail.slice(-CONTEXT_CHARS)
  if (previous) state.previous = previous

  const questions: JevRequest['questions'] = {}
  if (isFirstTurn && tiers && tiers.length >= 2) {
    // Weakest first: Jev leans toward the option listed first, and the
    // everyday model is the safer side to lean to.
    const criteria: Partial<Record<Tier, string>> = {}
    for (const tier of [...TIERS].reverse()) if (tiers.includes(tier)) criteria[tier] = TIER_CRITERIA[tier]
    questions.tier = {
      type: 'choice',
      instructions: 'Which model tier is needed to reliably complete the coding task that starts with `prompt`?',
      criteria,
    }
  }
  questions.effort = QUESTIONS.effort
  if (!isFirstTurn) {
    questions.continuation = QUESTIONS.continuation
    questions.escalate = QUESTIONS.escalate
  }
  questions.high_stakes = QUESTIONS.high_stakes
  return { model: jevModel, state, questions }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function field(answer: unknown, key: string): unknown {
  return typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>)[key] : undefined
}

// Undefined when the body is not an answer at all; otherwise every answer
// that has the expected shape, the rest left out.
export function parseAnswers(text: string): JevResult | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  const answers = field(body, 'answers')
  if (typeof answers !== 'object' || answers === null) return undefined

  const signals: Signals = {}
  const score = field(field(answers, 'effort'), 'score')
  if (isNumber(score)) signals.effortScore = score
  const nouls = { continuation: 'continuation', escalate: 'escalate', highStakes: 'high_stakes' } as const
  for (const [key, id] of Object.entries(nouls)) {
    const p = field(field(answers, id), 'noul')
    if (isNumber(p)) signals[key as keyof typeof nouls] = p
  }

  const result: JevResult = { signals }
  const probabilities = field(field(answers, 'tier'), 'probabilities')
  const tierProbabilities: Partial<Record<Tier, number>> = {}
  for (const tier of TIERS) {
    const p = field(probabilities, tier)
    if (isNumber(p)) tierProbabilities[tier] = p
  }
  if (Object.keys(tierProbabilities).length > 0) result.tierProbabilities = tierProbabilities
  return result
}
