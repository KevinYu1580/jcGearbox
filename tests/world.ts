import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath the plugin: Jev, the model, and the nouns it calls.
// Shared by the *.test.ts files; not a test file itself.

export type Step = { model: string; effort?: unknown }
export type Fetch = { url: string; method?: string; headers?: Record<string, string>; body: any }
export type World = {
  status: (string | undefined)[] // every status line set, in order
  asked: any[] // the Jev request bodies, parsed
  fetches: Fetch[] // the Jev requests as sent
  steps: Step[] // the model requests as they reached the engine
  db: Map<string, unknown> // $.store
  listed: string[] // the directories the plugin listed
  registered: string[] // the slash commands the plugin registered
  session: string // what $.session.id() answers; a test may change it
  messages: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] // what $.session.messages() answers
  clock: ReturnType<typeof mock.clock>
}
export type WorldOptions = {
  reply?: unknown | ((body: any) => unknown) // Jev's answer
  httpStatus?: number
  hang?: boolean // Jev never answers (until the mocked clock moves on 60 s)
  gate?: (body: any) => Promise<unknown> | undefined // Jev answers this request once the promise settles
  offline?: boolean // the Jev request fails before any response
  failures?: Record<number, number | 'offline'> // the Jev requests at these positions (from 0) fail: an HTTP status, or no response
  rateLimits?: { kind: string; percentUsed: number }[] // what $.session.usage() reports
  noKey?: boolean
  version?: string
  answeredAs?: string // the model the API says answered every request
  noResponseFrom?: string // a request naming this model gets no response at all
  noResponseOnce?: string // only the first request naming this model gets no response
  noResponseAt?: number[] // the requests at these positions (from 0, across the test) get no response
  refusalFrom?: string // a request naming this model is declined (stop reason 'refusal')
  catalog?: unknown // null: no catalog file
  thirdParty?: boolean // $.session.authorize() answers null
  env?: Record<string, string | undefined> // undefined: the variable is not set
  store?: Record<string, unknown> // $.store's contents at the start
  storeFails?: (key: string) => boolean // a store.set of this key throws
  storeHolds?: (key: string) => Promise<unknown> | undefined // a store.set of this key waits for the promise
  stepHold?: () => Promise<unknown> | undefined // a model request streams a chunk, then waits for the promise
  noUsage?: boolean // $.session.usage() fails, as on a Claude Code without it
}

export const FRAME = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n'

export const CATALOG = {
  catalog: {
    config: {
      models: [
        { id: 'claude-opus-5-5', short_name: 'Opus', section: 'main', min_claude_code_version: '2.1.280' },
        { id: 'claude-fable-5-1', short_name: 'Fable', section: 'main', min_claude_code_version: null },
        { id: 'claude-sonnet-5-5', short_name: 'Sonnet', section: 'main', min_claude_code_version: null },
        { id: 'claude-haiku-4-5-20251001', short_name: 'Haiku', section: 'main', min_claude_code_version: null },
      ],
    },
  },
}

export function world(on: On, o: WorldOptions = {}): World {
  const w: World = {
    status: [],
    asked: [],
    fetches: [],
    steps: [],
    db: new Map(Object.entries(o.store ?? {})),
    listed: [],
    registered: [],
    session: 'session-1',
    messages: [],
    clock: mock.clock(on),
  }
  const env = Object.fromEntries(
    Object.entries({
      HOME: '/home/u',
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
      ...(o.noKey ? {} : { TYPESAFE_API_KEY: 'test-key' }),
      ...o.env,
    }).filter((kv): kv is [string, string] => kv[1] !== undefined),
  )
  mock.env(on, env)
  // A Map keeps a key where it was first set, as the engine's store does.
  on('store.get', ($, e) => ({ value: w.db.get(e.key) }))
  on('store.set', async ($, e) => {
    await o.storeHolds?.(e.key)
    if (o.storeFails?.(e.key)) throw new Error(`store full: ${e.key}`)
    w.db.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.db.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.db.keys()] }))

  const once = new Set<string>()
  const catalog = o.catalog === undefined ? CATALOG : o.catalog
  const dir = `${env.CLAUDE_CONFIG_DIR ?? `${env.HOME}/.claude`}/cache/model-catalog`
  on('session.id', () => ({ value: w.session }))
  on('session.messages', () => ({ value: w.messages }))
  on('session.version', () => ({ value: { version: o.version ?? '2.1.286', base: o.version ?? '2.1.286' } }))
  on('session.authorize', () => ({ value: o.thirdParty ? null : { handle: 'h', kind: 'bearer' as const } }))
  on('fs.list', ($, e) => {
    w.listed.push(e.path)
    const found = catalog && e.path === dir
    return { value: found ? [{ name: 'org-x-ccd.json', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }] : [] }
  })
  on('fs.read', ($, e) => ({ value: e.path === `${dir}/org-x-ccd.json` ? JSON.stringify(catalog) : '' }))
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    w.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    w.asked.push(body)
    w.fetches.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body })
    await o.gate?.(body)
    if (o.hang) await w.clock.sleep(60_000)
    const failure = o.failures?.[w.fetches.length - 1]
    if (o.offline || failure === 'offline') throw new Error('getaddrinfo ENOTFOUND api.typesafe.ai')
    const reply = asked(body, typeof o.reply === 'function' ? (o.reply as (b: any) => unknown)(body) : o.reply)
    const status = failure ?? o.httpStatus ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(reply ?? {}) } }
  })
  on('session.usage', () => {
    if (o.noUsage) throw new Error('session.usage is not available')
    return { value: { startedAt: 0, context: {} as any, rateLimits: o.rateLimits ?? [] } }
  })
  on('command.run', () => ({ text: '' })) // a built-in command, run by the engine
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  // As in the engine, the turn starts before the submit settles.
  on('prompt.submit', async ($, e) => {
    const begin = starting
    starting = undefined
    await begin?.()
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* ($, e) {
    w.steps.push(e.effort === undefined ? { model: e.model } : { model: e.model, effort: e.effort })
    const silent =
      o.noResponseFrom === e.model ||
      (o.noResponseOnce === e.model && !once.has(e.model)) ||
      !!o.noResponseAt?.includes(w.steps.length - 1)
    if (o.noResponseOnce === e.model) once.add(e.model)
    const hold = o.stepHold?.()
    if (hold) {
      yield { kind: 'text', index: 0, text: 'hel' } as any
      await hold
    }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: silent ? '' : 'done',
      toolUses: [],
      stopReason: silent ? null : o.refusalFrom === e.model ? ('refusal' as const) : ('end_turn' as const),
      usage: silent
        ? null
        : {
            model: o.answeredAs ?? e.model,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
    }
  })
  return w
}

// Jev answers only the questions it was asked.
function asked(body: any, reply: any) {
  if (typeof reply !== 'object' || reply === null || typeof reply.answers !== 'object') return reply
  return { ...reply, answers: Object.fromEntries(Object.entries(reply.answers).filter(([q]) => q in body.questions)) }
}

export const start = ($: any) => $.session.start({ cwd: '/work', surface: null, isInteractive: false })

export async function drain(stream: any) {
  for await (const _ of stream) {
    // the model in these tests streams nothing
  }
  return stream.result
}

export type TurnOptions = {
  origin?: string // prompt.submit's origin.kind (default 'sdk')
  models?: string[] // the engine's model for each step (default one sonnet step)
  effort?: string | null // the engine's effort on each step (default 'high'; null: none)
  efforts?: (string | null)[] // the engine's effort step by step, in place of `effort`
  startText?: string // turn.start's text when the engine changed what was submitted
  submit?: boolean // false: the turn starts with no prompt.submit
  answer?: string // the turn's final answer
  reason?: string // why the turn ended (default 'answer'; 'error' when an API error ended it)
}

// The turn.start the next prompt.submit fires on its way down.
let starting: (() => Promise<unknown>) | undefined

export async function turn($: any, text: string, turnId: string, o: TurnOptions = {}) {
  const begin = () => $.turn.start({ text: o.startText ?? text, turnId })
  if (o.submit === false) await begin()
  else {
    starting = begin
    await $.prompt.submit({ text, wait: false, origin: { kind: o.origin ?? 'sdk' } })
  }
  const models = o.models ?? ['claude-sonnet-5-5']
  for (const [index, model] of models.entries()) {
    const set = o.efforts ? o.efforts[index] : o.effort
    const effort = set === null ? undefined : (set ?? 'high')
    await drain($.turn.step({ turnId, index, model, messageCount: 2 + index, ...(effort ? { effort } : {}) }))
  }
  const reason = o.reason ?? 'answer'
  await $.turn.complete({ answer: o.answer ?? 'done', durationMs: 5, isAborted: reason === 'aborted', turnId, reason })
}

// The text a slash command's turn starts from, as the engine builds it.
export const commandText = (name: string, args: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`

export const command = ($: any, args: string) =>
  $.command.run({ command: 'jcmr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

// One of the /jcmr-<action> commands.
export const run = ($: any, name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

export const switchModel = ($: any, from: string, to: string, source = 'picker') =>
  $.classic.PostModelSwitch({
    from_model: from,
    to_model: to,
    requested_model: to,
    source,
    context_tokens: 1000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0,
    pricing: 'catalog',
  })

export const STRONG = {
  answers: {
    tier: { type: 'choice', choice: 'strong', probabilities: { low: 0.05, balanced: 0.15, strong: 0.8 }, confidence: 0.7 },
    effort: { type: 'score', score: 2.2 },
    high_stakes: { type: 'noul', noul: 0.1 },
  },
}
export const EASY = {
  answers: {
    tier: { type: 'choice', choice: 'balanced', probabilities: { low: 0.3, balanced: 0.4, strong: 0.3 }, confidence: 0.2 },
    effort: { type: 'score', score: 0.3 },
    high_stakes: { type: 'noul', noul: 0.05 },
  },
}
// Jev sure that a weaker model will do: low and balanced add up to 0.85.
export const SURE_EASY = {
  answers: {
    tier: { type: 'choice', choice: 'balanced', probabilities: { low: 0.4, balanced: 0.45, strong: 0.15 }, confidence: 0.6 },
    effort: { type: 'score', score: 0.3 },
    high_stakes: { type: 'noul', noul: 0.05 },
  },
}
export const CONTINUE = {
  answers: {
    effort: { type: 'score', score: 0.2 },
    continuation: { type: 'noul', noul: 0.9 },
    escalate: { type: 'noul', noul: 0.05 },
    high_stakes: { type: 'noul', noul: 0.05 },
  },
}
export const firstStrongThenContinue = (body: any) => (body.questions.tier ? STRONG : CONTINUE)
export const AUTO = { options: { default_mode: 'auto' } }
