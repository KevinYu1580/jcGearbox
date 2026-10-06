import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { JEV_URL, buildRequest, clip, parseAnswers } from './jev.ts'
import type { JevRequest, JevResult } from './jev.ts'
import { newestCatalogFile, resolveModel, surfaceOf, versionAtLeast } from './models.ts'
import type { Resolved } from './models.ts'
import { EFFORTS, TIERS, decideEffort, isEffort, pickModel } from './policy.ts'
import type { Effort, Tier } from './policy.ts'

const MIN_VERSION = '2.1.286'
const KEEP = 200
const CONTEXT_CHARS = 1000
// Prompts the person sent: typed, through the desktop app or an SDK host,
// Remote Control, or Slack. Anything else (a task notification, a schedule,
// another session) continues the session as it is and never reaches Jev.
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge', 'slack-ping'])
const USAGE = 'Usage: /jcmr [auto | shadow | off | pin <model> | log [n]]'
// The engine puts this before a Slack message's text by the time its turn starts.
const NON_USER_FRAME = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n'

type Mode = 'auto' | 'shadow' | 'off'

type Decision = {
  at: number
  mode: Mode
  first: boolean
  prompt: string
  promptLength: number
  jev: JevResult | null
  error?: string
  model?: string
  effort?: Effort
}

// One per session id, in $.store, so a resumed session keeps its choice.
type SessionRecord = {
  decided?: boolean // the first user turn has chosen the session's model
  model?: string // that choice; absent keeps the session's own model
  effort?: Effort // the latest effort decided
  rawEffort?: string | number | null // the engine's own effort at the last turn
  rawModel?: string // the engine's model at that turn
  prompt?: string // the last user prompt, for the next turn's context
  replyTail?: string // the end of Claude's last reply (send_assistant_tail)
  mode?: Mode // set by /jcmr for this session
  pin?: string // set by /jcmr pin
  userModel?: boolean // the person switched model (/model or the picker)
  effortPinned?: boolean // the person changed the effort
  badModels?: string[] // models the API did not answer as
  last?: Decision
}

type Plan = { apply: boolean; model?: string; effort?: Effort }
type Turn = {
  isUser: boolean
  text: string
  command?: boolean // a slash command's turn
  baseModel?: string
  plan?: Plan
  unanswered?: string // the model the last rewritten request named, when it got no response
}
type Tiers = Partial<Record<Tier, Resolved>>

const label = (model: string | undefined) => (model ?? '?').replace(/^claude-/, '').replace(/\[\w+\]$/, '')
const sameModel = (a: string, b: string) => a.includes(b) || b.includes(a)

// What one load of the module keeps in memory; $.store keeps the rest.
type Ctx = {
  opt: Options
  disabled?: string
  resolved?: { session: string; firstParty: boolean; catalog: unknown; version: string; tiers: Tiers }
  submitted: { text: string; isUser: boolean }[]
  turns: Map<string, Turn>
  logged: number
}

export const register: Register = (on, options) => {
  const ctx: Ctx = { opt: readOptions(options), submitted: [], turns: new Map(), logged: 0 }
  const { opt, submitted, turns } = ctx

  on('session.start', async ($, e, next) => {
    const { version, base } = await $.session.version()
    ctx.disabled = versionAtLeast(base ?? version, MIN_VERSION) ? undefined : `jcmr: needs Claude Code ${MIN_VERSION}+`
    await $.command.register({
      name: 'jcmr',
      description: 'Jev model router: status, mode, pin, log',
      argumentHint: '[auto | shadow | off | pin <model> | log [n]]',
    })
    await prune($)
    await showMode($, ctx)
    return next(e)
  })

  // A /clear, a /resume or a fork goes on under another session id with no
  // session.start.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      await prune($)
      await showMode($, ctx)
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    submitted.push({ text: e.text, isUser: USER_ORIGINS.has(e.origin.kind) })
    if (submitted.length > 20) submitted.shift()
    return next(e)
  })

  // A turn is the person's when it starts from the text they submitted; a
  // slash command's turn starts from tags naming the command they typed.
  on('turn.start', ($, e, next) => {
    const text = e.text.startsWith(NON_USER_FRAME) ? e.text.slice(NON_USER_FRAME.length) : e.text
    const command = /<command-name>(\/[^<]*)<\/command-name>/.exec(text)?.[1]
    const i = submitted.findLastIndex(s => s.text === text || (command !== undefined && typedCommand(s.text, command)))
    const hit = i >= 0 ? submitted.splice(i, 1)[0] : undefined
    turns.set(e.turnId, { isUser: hit?.isUser ?? false, text: hit?.text ?? text, command: command !== undefined })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId || ctx.disabled) return yield* next(e)
    let turn = turns.get(e.turnId)
    if (!turn) {
      turn = { isUser: false, text: '' }
      turns.set(e.turnId, turn)
    }
    if (!turn.plan) {
      turn.baseModel = e.model
      turn.plan = await plan($, ctx, e.model, e.effort, turn, next.signal)
    } else if (e.model !== turn.baseModel) {
      return yield* next(e) // the engine fell back to another model: leave it
    }

    const { apply, model, effort } = turn.plan
    const rewritesModel = apply && model !== undefined && model !== e.model
    if (!rewritesModel && !(apply && effort)) return yield* next(e)

    const result = yield* next({
      ...e,
      ...(rewritesModel ? { model } : {}),
      ...(apply && effort ? { effort } : {}),
    })
    if (rewritesModel && result.usage && !sameModel(result.usage.model, model)) {
      turn.plan = { ...turn.plan, model: undefined }
      await drop($, model, `${label(result.usage.model)} answered`)
    } else if (rewritesModel) {
      const noResponse = !result.usage && result.stopReason === null && !next.signal.aborted
      turn.unanswered = noResponse ? model : undefined
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const turn = turns.get(e.turnId)
      turns.delete(e.turnId)
      // A request with no response is the model's doing (an unknown id, no
      // access) only when the turn died of it: the engine retries others
      // itself, a context overflow after compacting, say.
      if (turn?.unanswered && e.reason === 'error') await drop($, turn.unanswered, 'no response')
      if (opt.sendAssistantTail && e.answer && !ctx.disabled) {
        const [id, r] = await record($)
        if ((r.mode ?? opt.defaultMode) !== 'off' && (await apiKey($, opt))) {
          r.replyTail = e.answer.slice(-CONTEXT_CHARS)
          await save($, id, r)
        }
      }
    }
    return next(e)
  })

  // A switch after the session's model was chosen is the person overriding
  // it; one before (an app applying its picker at start) is the starting point.
  // PostModelSwitch: only a switch that took effect, and only the person's
  // (not a fallback, not a resume restoring the model).
  on('classic.PostModelSwitch', async ($, e, next) => {
    const byPerson = e.source === 'command' || e.source === 'picker' || e.source === 'sdk'
    const [id, r] = await record($)
    if (byPerson && r.decided && e.from_model !== e.to_model) {
      r.userModel = true
      delete r.pin
      await save($, id, r)
    }
    return next(e)
  })

  on('command.run', { command: 'jcmr' }, async ($, e) => {
    const [sub = '', arg] = e.args.trim().split(/\s+/)
    const [id, r] = await record($)
    if (sub === '') return { text: report(r, opt.defaultMode) }
    if (sub === 'auto' || sub === 'shadow' || sub === 'off') {
      r.mode = sub
      if (sub === 'auto') {
        delete r.pin
        delete r.userModel
        delete r.effortPinned
        delete r.rawEffort
      }
      await save($, id, r)
      await showMode($, ctx)
      return { text: sub === 'auto' ? 'jcmr: auto for this session; pins cleared.' : `jcmr: ${sub} for this session.` }
    }
    if (sub === 'pin' && arg) {
      const pinned = resolveModel(arg, await resolution($, ctx, id))
      if (!pinned) return { text: `jcmr: cannot resolve "${arg}" here; give a full model id.` }
      if (r.badModels?.includes(pinned.id)) {
        return { text: `jcmr: ${pinned.id} was not used when asked for earlier in this session; not pinning it.` }
      }
      r.pin = pinned.id
      delete r.userModel
      await save($, id, r)
      return { text: `jcmr: model pinned to ${pinned.id} for this session (/jcmr auto clears it).` }
    }
    if (sub === 'log') {
      const n = Number.parseInt(arg ?? '', 10)
      return { text: await logText($, n > 0 ? n : 20) }
    }
    return { text: USAGE }
  })
}

async function record($: EngineInterface): Promise<[string, SessionRecord]> {
  const id = await $.session.id()
  return [id, ((await $.store.get(`session:${id}`)) as SessionRecord | undefined) ?? {}]
}

// keys() lists keys in the order they were first set: deleting first puts
// this session last, so pruning drops the sessions used longest ago.
async function save($: EngineInterface, id: string, r: SessionRecord) {
  await $.store.delete(`session:${id}`)
  await $.store.set(`session:${id}`, r)
}

async function apiKey($: EngineInterface, opt: Options) {
  return opt.apiKey || (await $.env.get('TYPESAFE_API_KEY'))
}

// Aliases resolve once per session: the catalog is Claude Code's own model
// picker, which only a first-party login has.
async function resolution($: EngineInterface, ctx: Ctx, session: string) {
  if (ctx.resolved?.session === session) return ctx.resolved
  const firstParty = (await $.session.authorize()) !== null
  const { version, base } = await $.session.version()
  const catalog = firstParty ? await readCatalog($) : undefined
  const resolveCtx = { firstParty, catalog, version: base ?? version }
  const tiers: Tiers = {}
  for (const tier of TIERS) {
    const r = resolveModel(ctx.opt.tierModels[tier], resolveCtx)
    if (r) tiers[tier] = r
  }
  ctx.resolved = { session, ...resolveCtx, tiers }
  return ctx.resolved
}

async function plan($: EngineInterface, ctx: Ctx, model: string, rawEffort: Effort | number | undefined, turn: Turn, signal: AbortSignal) {
  const { opt } = ctx
  let [id, r] = await record($)
  const mode = r.mode ?? opt.defaultMode
  if (mode === 'off') {
    $.ui.status(undefined)
    return { apply: false }
  }
  const key = await apiKey($, opt)
  if (!key) {
    $.ui.status('jcmr: no API key')
    return { apply: false }
  }

  const { tiers } = await resolution($, ctx, id)
  const first = !r.decided
  const offered = TIERS.filter(t => tiers[t])
  let asked: { result?: JevResult; error?: string } | undefined
  if (turn.isUser) {
    const distinct = new Set(offered.map(t => tiers[t]?.id)).size
    const body = buildRequest({
      jevModel: opt.jevModel,
      prompt: turn.text,
      isFirstTurn: first,
      tiers: distinct >= 2 ? offered : undefined,
      previousPrompt: r.prompt,
      replyTail: opt.sendAssistantTail ? r.replyTail : undefined,
      previous: first ? undefined : { model: current(r) ?? model, effort: lastEffort(r) },
    })
    asked = await askJev($, key, body, signal, opt.jevTimeoutMs)
    if (signal.aborted) return { apply: false } // interrupted: nothing decided, the next prompt asks again
    r = (await record($))[1] // keep what /model or /jcmr changed while Jev answered
  }

  // The engine's effort is the session's setting or the model's default each
  // turn; ours only ever rides one request. A change between two turns on the
  // same model is the person's doing. A command's own effort rides its turn
  // alone: it is left as it is and pins nothing (and with no baseline to
  // tell, a command's turn is left as it is too).
  const raw = rawEffort ?? null
  const baseline = r.rawEffort !== undefined && r.rawModel === model
  const changed = baseline && r.rawEffort !== raw
  if (!turn.command) {
    if (changed) r.effortPinned = true
    r.rawEffort = raw
    r.rawModel = model
  }
  const before = r.effortPinned ? raw : r.effort // what the last attempt ran at

  let escalated = false
  if (asked) {
    const error = asked.error
    const decided = decideEffort({
      signals: asked.result?.signals,
      previous: r.effort,
      isFirstTurn: first,
      threshold: opt.signalThreshold,
      minEffort: opt.minEffort,
      maxEffort: opt.maxEffort,
    })
    escalated = decided.escalated
    if (first) {
      r.decided = true
      const ids: Partial<Record<Tier, string>> = {}
      for (const t of offered) ids[t] = tiers[t]?.id
      r.model = pickModel({
        probabilities: asked.result?.tierProbabilities,
        models: ids,
        minProbability: opt.tierMinProbability,
      })
    }
    if (decided.effort) r.effort = decided.effort
    r.prompt = clip(turn.text, CONTEXT_CHARS)
    r.last = {
      at: await $.clock.now(),
      mode,
      first,
      prompt: turn.text.slice(0, 200),
      promptLength: turn.text.length,
      jev: asked.result ?? null,
      ...(error ? { error } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(decided.effort ? { effort: decided.effort } : {}),
    }
    await $.store.set(`log:${r.last.at}:${id.slice(0, 8)}:${ctx.logged++}`, { ...r.last, session: id })
    await trim($, 'log:', KEEP)
  }

  const chosen = current(r)
  const effort = r.effortPinned || (turn.command && (changed || !baseline)) ? undefined : r.effort
  await save($, id, r)

  const shown = chosen ?? model
  const notes: string[] = []
  if (r.pin || r.userModel) notes.push('model pinned')
  if (r.effortPinned) notes.push('effort pinned')
  const atCeiling = isEffort(before) && EFFORTS.indexOf(before) >= EFFORTS.indexOf(opt.maxEffort)
  if (escalated && atCeiling && !/opus|fable/.test(shown)) notes.push('try /jcmr pin opus')
  if (Object.values(tiers).some(t => t?.source === 'builtin')) notes.push('built-in model table')
  if (asked?.error) notes.push(`Jev ${asked.error}`)
  const head = mode === 'auto' ? 'jcmr' : `jcmr(${mode})`
  $.ui.status(`${head} ▸ ${label(shown)}·${effort ?? rawEffort ?? '-'}${notes.map(n => ` · ${n}`).join('')}`)

  return { apply: mode === 'auto', model: chosen, effort }
}

// The model the session runs on: a pin, else the first turn's choice unless
// the person switched since; never one the API did not answer as.
function current(r: SessionRecord): string | undefined {
  const model = r.pin ?? (r.userModel ? undefined : r.model)
  return model && !r.badModels?.includes(model) ? model : undefined
}

// The effort the last turn ran at: the person's own once they pinned it.
function lastEffort(r: SessionRecord): string | undefined {
  return r.effortPinned && typeof r.rawEffort === 'string' ? r.rawEffort : r.effort
}

async function drop($: EngineInterface, model: string, answered: string) {
  const [id, r] = await record($)
  r.badModels = [...(r.badModels ?? []), model]
  await save($, id, r)
  $.ui.status(`jcmr: ${label(model)} was not used (${answered}); not switching to it again`)
}

// "/review x" as typed starts a turn naming "/review", or "/plugin:review"
// once the engine resolves a short name.
function typedCommand(typed: string, name: string): boolean {
  const word = typed.trimStart().split(/\s/, 1)[0] ?? ''
  return word.startsWith('/') && (word === name || name.endsWith(`:${word.slice(1)}`))
}

// The status line before the session's next decision: its mode, or why the
// router stands aside.
async function showMode($: EngineInterface, ctx: Ctx) {
  const [, r] = await record($)
  const mode = r.mode ?? ctx.opt.defaultMode
  const key = await apiKey($, ctx.opt)
  $.ui.status(ctx.disabled ?? (mode === 'off' ? undefined : !key ? 'jcmr: no API key' : mode === 'auto' ? 'jcmr' : `jcmr(${mode})`))
}

const pct = (p: number) => p.toFixed(2)

function report(r: SessionRecord, defaultMode: Mode): string {
  const dropped = (m: string) => (r.badModels?.includes(m) ? '; not served, no longer asked for' : '')
  const model = r.pin
    ? `pinned to ${r.pin}${dropped(r.pin)}`
    : r.userModel
      ? 'your choice (/model)'
      : !r.decided
        ? 'not chosen yet'
        : r.model
          ? `${r.model} (chosen on the first turn${dropped(r.model)})`
          : "the session's own (no clear pick)"
  const lines = [
    `jcmr: ${r.mode ?? defaultMode} (${r.mode ? 'this session' : 'default'})`,
    `model: ${model}`,
    `effort: ${r.effortPinned ? 'yours (you changed it)' : (r.effort ?? 'not set yet')}`,
  ]
  const last = r.last
  if (last) {
    const s = last.jev?.signals
    const parts: string[] = []
    const tiers = last.jev?.tierProbabilities
    if (tiers) parts.push(`tier ${Object.entries(tiers).map(([t, p]) => `${t} ${pct(p)}`).join(' / ')}`)
    if (s?.effortScore !== undefined) parts.push(`effort ${pct(s.effortScore)}`)
    if (s?.continuation !== undefined) parts.push(`continuation ${pct(s.continuation)}`)
    if (s?.escalate !== undefined) parts.push(`complaint ${pct(s.escalate)}`)
    if (s?.highStakes !== undefined) parts.push(`high stakes ${pct(s.highStakes)}`)
    lines.push(`last turn: ${parts.join(' · ') || 'no answer'}${last.error ? ` (Jev ${last.error})` : ''}`)
  }
  return lines.join('\n')
}

async function logText($: EngineInterface, n: number): Promise<string> {
  const pad = (v: number) => String(v).padStart(2, '0')
  const lines: string[] = []
  for (const key of (await $.store.keys()).filter(k => k.startsWith('log:')).slice(-n)) {
    const d = (await $.store.get(key)) as Decision | undefined
    if (!d) continue
    const t = new Date(d.at)
    const when = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
    const flags = `${d.first ? '  first' : ''}${d.error ? `  Jev ${d.error}` : ''}`
    lines.push(`${when}  ${d.mode.padEnd(6)} ${d.model ? label(d.model) : 'unchanged'}·${d.effort ?? '-'}${flags}  "${d.prompt.slice(0, 60)}"`)
  }
  return lines.length > 0 ? lines.join('\n') : 'jcmr: no decisions logged yet.'
}

type Options = ReturnType<typeof readOptions>

function readOptions(options: PluginOptions) {
  const text = (key: string) => (typeof options[key] === 'string' ? (options[key] as string) : undefined)
  const num = (key: string) => options[key] as number
  return {
    apiKey: text('api_key'),
    defaultMode: (text('default_mode') ?? 'shadow') as Mode,
    tierModels: {
      low: text('low_model'),
      balanced: text('balanced_model'),
      strong: text('strong_model'),
      long: text('long_model'),
    } as Record<Tier, string | undefined>,
    tierMinProbability: num('tier_min_probability'),
    signalThreshold: num('signal_threshold'),
    minEffort: (text('min_effort') ?? 'low') as Effort,
    maxEffort: (text('max_effort') ?? 'max') as Effort,
    jevModel: text('jev_model') || 'jev-latest',
    jevTimeoutMs: Math.round(num('jev_timeout_seconds') * 1000),
    sendAssistantTail: options.send_assistant_tail === true,
  }
}

// One Jev call that never rejects and never waits past timeoutMs.
async function askJev(
  $: EngineInterface,
  key: string,
  body: JevRequest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ result?: JevResult; error?: string }> {
  const stop = new AbortController()
  const relay = () => stop.abort()
  signal.addEventListener('abort', relay)
  if (signal.aborted) stop.abort()
  try {
    const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
      () => 'timeout' as const,
      () => 'timeout' as const,
    )
    const call = $.http
      .fetch(JEV_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      .catch(() => 'network error' as const)
    const res = await Promise.race([call, timeout])
    if (typeof res === 'string') return { error: res }
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const result = parseAnswers(res.text)
    return result ? { result } : { error: 'unreadable answer' }
  } finally {
    stop.abort()
    signal.removeEventListener('abort', relay)
  }
}

async function readCatalog($: EngineInterface): Promise<unknown> {
  try {
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const dir = `${configDir}/cache/model-catalog`
    const surface = surfaceOf(await $.env.get('CLAUDE_CODE_ENTRYPOINT'), await $.env.get('CLAUDE_CODE_REMOTE'))
    const name = newestCatalogFile(await $.fs.list(dir), surface)
    if (!name) return undefined
    const text = await $.fs.read(`${dir}/${name}`)
    return typeof text === 'string' ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

// The current session counts as the most recent, however old its record.
async function prune($: EngineInterface) {
  await trim($, 'log:', KEEP)
  await trim($, 'session:', KEEP - 1, `session:${await $.session.id()}`)
}

// Deletes the oldest keys under `prefix` beyond the newest `keep`, never `except`.
async function trim($: EngineInterface, prefix: string, keep: number, except?: string) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(prefix) && k !== except)
  for (const k of keys.slice(0, Math.max(0, keys.length - keep))) await $.store.delete(k)
}
