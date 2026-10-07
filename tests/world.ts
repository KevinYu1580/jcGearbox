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
  session: string // what $.session.id() answers; a test may change it
  clock: ReturnType<typeof mock.clock>
}
export type WorldOptions = {
  reply?: unknown | ((body: any) => unknown) // Jev's answer
  httpStatus?: number
  hang?: boolean // Jev never answers (until the mocked clock moves on 60 s)
  gate?: (body: any) => Promise<unknown> | undefined // Jev answers this request once the promise settles
  noKey?: boolean
  version?: string
  answeredAs?: string // the model the API says answered every request
  noResponseFrom?: string // a request naming this model gets no response at all
  noResponseOnce?: string // only the first request naming this model gets no response
  catalog?: unknown // null: no catalog file
  thirdParty?: boolean // $.session.authorize() answers null
  env?: Record<string, string>
  store?: Record<string, unknown> // $.store's contents at the start
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
    session: 'session-1',
    clock: mock.clock(on),
  }
  const env: Record<string, string> = {
    HOME: '/home/u',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    ...(o.noKey ? {} : { TYPESAFE_API_KEY: 'test-key' }),
    ...o.env,
  }
  mock.env(on, env)
  // A Map keeps a key where it was first set, as the engine's store does.
  on('store.get', ($, e) => ({ value: w.db.get(e.key) }))
  on('store.set', ($, e) => {
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    w.asked.push(body)
    w.fetches.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body })
    await o.gate?.(body)
    if (o.hang) await w.clock.sleep(60_000)
    const reply = typeof o.reply === 'function' ? (o.reply as (b: any) => unknown)(body) : o.reply
    const status = o.httpStatus ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(reply ?? {}) } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* ($, e) {
    w.steps.push(e.effort === undefined ? { model: e.model } : { model: e.model, effort: e.effort })
    const silent = o.noResponseFrom === e.model || (o.noResponseOnce === e.model && !once.has(e.model))
    if (o.noResponseOnce === e.model) once.add(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: silent ? '' : 'done',
      toolUses: [],
      stopReason: silent ? null : ('end_turn' as const),
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
  startText?: string // turn.start's text when the engine changed what was submitted
  submit?: boolean // false: the turn starts with no prompt.submit
  answer?: string // the turn's final answer
  reason?: string // why the turn ended (default 'answer'; 'error' when an API error ended it)
}

export async function turn($: any, text: string, turnId: string, o: TurnOptions = {}) {
  if (o.submit !== false) await $.prompt.submit({ text, wait: false, origin: { kind: o.origin ?? 'sdk' } })
  await $.turn.start({ text: o.startText ?? text, turnId })
  const models = o.models ?? ['claude-sonnet-5-5']
  for (const [index, model] of models.entries()) {
    const effort = o.effort === null ? undefined : (o.effort ?? 'high')
    await drain($.turn.step({ turnId, index, model, messageCount: 2 + index, ...(effort ? { effort } : {}) }))
  }
  await $.turn.complete({ answer: o.answer ?? 'done', durationMs: 5, isAborted: false, turnId, reason: o.reason ?? 'answer' })
}

// The text a slash command's turn starts from, as the engine builds it.
export const commandText = (name: string, args: string) =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`

export const command = ($: any, args: string) =>
  $.command.run({ command: 'jcmr', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

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
