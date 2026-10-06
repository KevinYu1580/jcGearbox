// Pure decision rules: no `$`, so the tests drive them directly.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

// Strongest first, so a tie between models goes to the stronger one.
export const TIERS = ['long', 'strong', 'balanced', 'low'] as const
export type Tier = (typeof TIERS)[number]

export type Signals = {
  effortScore?: number
  continuation?: number
  escalate?: number
  highStakes?: number
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

export function effortFromScore(score: number): Effort {
  const index = Math.min(EFFORTS.length - 1, Math.max(0, Math.round(score)))
  return EFFORTS[index] ?? 'low'
}

function atLeast(effort: Effort, floor: Effort): Effort {
  return EFFORTS.indexOf(effort) >= EFFORTS.indexOf(floor) ? effort : floor
}

function atMost(effort: Effort, ceiling: Effort): Effort {
  return EFFORTS.indexOf(effort) <= EFFORTS.indexOf(ceiling) ? effort : ceiling
}

function oneUp(effort: Effort): Effort {
  return EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + 1)] ?? effort
}

// Start from the previous effort on a continuation, else from Jev's score;
// then a complaint raises it a level and a high-stakes task lifts it to xhigh.
// The floor applies next and the ceiling last, so the ceiling wins.
export function decideEffort(input: {
  signals: Signals | undefined
  previous: Effort | undefined
  isFirstTurn: boolean
  threshold: number
  minEffort: Effort
  maxEffort: Effort
}): { effort: Effort | undefined; escalated: boolean } {
  const { signals, previous, isFirstTurn, threshold, minEffort, maxEffort } = input
  if (!signals) return { effort: isFirstTurn || !previous ? undefined : atMost(previous, maxEffort), escalated: false }

  const holds = (p: number | undefined) => p !== undefined && p > threshold
  const isContinuation = !isFirstTurn && holds(signals.continuation)
  const escalated = !isFirstTurn && holds(signals.escalate)

  let effort =
    isContinuation && previous
      ? previous
      : signals.effortScore !== undefined
        ? effortFromScore(signals.effortScore)
        : previous
  if (!effort) return { effort: undefined, escalated: false }

  if (escalated) effort = oneUp(effort)
  if (holds(signals.highStakes)) effort = atLeast(effort, 'xhigh')
  return { effort: atMost(atLeast(effort, minEffort), maxEffort), escalated }
}

// Tiers that resolve to the same model pool their probability; the model
// changes only when the pooled pick reaches the minimum.
export function pickModel(input: {
  probabilities: Partial<Record<Tier, number>> | undefined
  models: Partial<Record<Tier, string>>
  minProbability: number
}): string | undefined {
  const { probabilities, models, minProbability } = input
  if (!probabilities) return undefined

  const pooled = new Map<string, number>()
  for (const tier of TIERS) {
    const model = models[tier]
    const p = probabilities[tier]
    if (model && p !== undefined) pooled.set(model, (pooled.get(model) ?? 0) + p)
  }

  let best: string | undefined
  let bestP = -1
  for (const [model, p] of pooled) {
    if (p > bestP) {
      best = model
      bestP = p
    }
  }
  return best !== undefined && bestP >= minProbability ? best : undefined
}
