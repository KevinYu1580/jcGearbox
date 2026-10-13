import type { EngineInterface, PluginOptions, Register, TurnStepResult } from 'claude-code'

import { JEV_URL, buildRequest, clip, parseAnswers, redact } from './jev.ts'
import type { JevRequest, JevResult } from './jev.ts'
import { newestCatalogFile, resolveModel, surfaceOf, versionAtLeast } from './models.ts'
import type { Resolved } from './models.ts'
import { EFFORTS, TIERS, decideEffort, defaultEffort, effortFor, isEffort, pickModel } from './policy.ts'
import type { Effort, Tier } from './policy.ts'

const MIN_VERSION = '2.1.286'
const KEEP = 200
const CONTEXT_CHARS = 1000
const FORK_REPLY_CHARS = 200 // a reply at least this long names the one session that wrote it
// Prompts the person sent: typed, through the desktop app or an SDK host,
// Remote Control, or Slack. Anything else (a task notification, a schedule,
// another session) continues the session as it is and never reaches Jev.
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge', 'slack-ping'])
// claude -p and the Agent SDKs: scripts, whose prompts are no task to judge.
const SDK_ENTRYPOINTS = ['sdk-cli', 'sdk-ts', 'sdk-py']
const USAGE = 'Usage: /jcGearbox [status | auto | shadow | off | on | pin <model> | log [n] | stats], or /jcGearbox-<that>'
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
  sent?: { model: string; effort: string | number | null } // what the request carried: ours in auto, the engine's own otherwise
  pick?: string // Jev's own pick as model·effort, which the log shows beside `sent` and the status line in shadow
  why?: string[] // why it differs from Jev's pick (shadow, pin, /model, effort pinned), and ultracode
  served?: string // the model the API answered as, when it was not the one sent
  engine?: { model: string; effort: string | number | null } // the engine's own model and effort for the turn
  jevMs?: number // how long Jev took, a retry included
  limits?: Record<string, number> // the account's rate-limit windows: percent used, by kind
  outcome?: Tally & { reason: string } // how the turn went, once it ended
}

type Tally = { steps: number; stop: string | null; input: number; output: number; cacheRead: number; cacheWrite: number }
const NO_REQUESTS: Tally = { steps: 0, stop: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

// One per session id, in $.store, so a resumed session keeps its choice.
type SessionRecord = {
  decided?: boolean // the first user turn has chosen the session's model
  model?: string // that choice; absent keeps the session's own model
  effort?: Effort // the latest effort decided
  rawEffort?: string | number | null // the engine's own effort at the last turn
  rawModel?: string // the engine's model at that turn
  prompt?: string // the last user prompt, for the next turn's context
  replyTail?: string // the end of Claude's last reply (send_assistant_tail)
  mode?: Mode // set by /jcGearbox for this session
  pin?: string // set by /jcGearbox pin
  userModel?: boolean // the person switched model (/model or the picker)
  effortPinned?: boolean // the person changed the effort
  badModels?: string[] // models the API did not answer as
  last?: Decision
}

type Plan = { apply: boolean; model?: string; effort?: Effort; logKey?: string }
type Turn = {
  isUser: boolean
  text: string
  command?: boolean // a slash command's turn
  ultracode?: boolean // the person typed the ultracode keyword: Claude Code may run workflows this turn
  baseModel?: string
  baseEffort?: Effort | number // the engine's effort at the turn's first request
  ownEffort?: boolean // the engine's effort changed mid-turn (a skill's own): it rides the rest of the turn
  plan?: Plan
  unanswered?: string // the model the last rewritten request named, when it got no response
  decided?: Promise<Plan | undefined> // the turn's decision, written down once Jev answers
  tally?: Tally // the turn's requests so far
}
type Tiers = Partial<Record<Tier, Resolved>>

const label = (model: string | undefined) => (model ?? '?').replace(/^claude-/, '').replace(/\[\w+\]$/, '')
// One id names the other's model when it holds it with no further version
// after it: Vertex's claude-opus-5-5@20261001, Bedrock's
// us.anthropic.claude-opus-5-5-v1:0, but not claude-opus-5 for claude-opus-5-5.
// An id that names no Claude model (a Bedrock profile ARN, a gateway's own
// name) cannot be told apart, so it passes.
const covers = (long: string, short: string) => {
  const i = long.indexOf(short)
  return i >= 0 && !/^-\d{1,2}(?!\d)/.test(long.slice(i + short.length))
}
const sameModel = (a: string, b: string) => {
  const [x, y] = [a.replace('@', '-'), b.replace('@', '-')]
  return !x.includes('claude-') || !y.includes('claude-') || covers(x, y) || covers(y, x)
}
// A model other than the one the request already names: claude-opus-5-5[1m]
// already runs claude-opus-5-5, with its 1M context.
const movesTo = (to: string, from: string) => to !== from && to !== from.replace(/\[\w+\]$/, '')

// What one load of the module keeps in memory; $.store keeps the rest.
type Ctx = {
  opt: Options
  disabled?: string
  resolved?: { session: string; firstParty: boolean; catalog: unknown; version: string; tiers: Tiers }
  submitted: { text: string; isUser: boolean }[]
  turns: Map<string, Turn>
  logged: number
  answered: Set<string> // models a rewritten request got an answer from, since their last turn died unanswered
  joined: Set<string> // sessions that resume or fork a conversation already under way
  baselined: Set<string> // sessions whose engine effort this process has seen
  engineModels: Map<string, string> // each session's own model, as its start, its last plain turn or a switch left it
  forks: Map<string, string | null> // each subagent seen: the model a fork of the main conversation started on, else null
  failure?: Failure // the main loop's turn that died of an API error, as far as its two reports are in
  queue: Promise<unknown> // the session record's last change, which the next waits for
}

// A turn that died of an API error: the model its rewritten request named and
// got no response from (turn.complete), and why it died (StopFailure). The two
// come in either order.
type Failure = { model?: string; error?: string }

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    opt: readOptions(options),
    submitted: [],
    turns: new Map(),
    logged: 0,
    answered: new Set(),
    joined: new Set(),
    baselined: new Set(),
    engineModels: new Map(),
    forks: new Map(),
    queue: Promise.resolve(),
  }
  const { opt, submitted, turns } = ctx

  on('session.start', async ($, e, next) => {
    const { version, base } = await $.session.version()
    const entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? ''
    ctx.disabled = !versionAtLeast(base ?? version, MIN_VERSION)
      ? `needs Claude Code ${MIN_VERSION}+`
      : SDK_ENTRYPOINTS.includes(entrypoint)
        ? 'off in claude -p and SDK runs'
        : undefined
    // The session's own model before any turn, so that a command's own model
    // on the first one is told from it.
    if (!ctx.disabled) {
      const id = await $.session.id()
      const own = await sessionModel($, ctx, id)
      if (own) ctx.engineModels.set(id, own)
    }
    await $.command.register({
      name: 'jcGearbox',
      description: 'Jev model router: status, mode, pin, log, stats',
      argumentHint: '[status | auto | shadow | off | on | pin <model> | log [n] | stats]',
    })
    // One command per action, so the typeahead lists them all; /jcGearbox <action> still works.
    const d = 'Jev model router:'
    await $.command.register({ name: 'jcGearbox-status', description: `${d} this session's mode, model, effort and last request` })
    await $.command.register({ name: 'jcGearbox-auto', description: `${d} route model and effort in this session; clears pins` })
    await $.command.register({ name: 'jcGearbox-shadow', description: `${d} judge and show, but send requests unchanged, in this session` })
    await $.command.register({ name: 'jcGearbox-off', description: `${d} turn it off for this session` })
    await $.command.register({ name: 'jcGearbox-on', description: `${d} turn it back on for this session (default mode, or auto)` })
    await $.command.register({ name: 'jcGearbox-pin', description: `${d} use one model for this session`, argumentHint: '<alias or model id>' })
    await $.command.register({ name: 'jcGearbox-log', description: `${d} recent decisions, across sessions`, argumentHint: '[n]' })
    await $.command.register({ name: 'jcGearbox-stats', description: `${d} how the logged decisions compare with the engine's own` })
    await prune($)
    await showMode($, ctx)
    return next(e)
  })

  // A /clear, a /resume or a fork goes on under another session id with no
  // session.start.
  on('classic.SessionStart', async ($, e, next) => {
    // The id the session goes on under: $.session.id() can still be the one it leaves.
    if (e.model) ctx.engineModels.set(e.session_id, e.model)
    if (e.source === 'resume' || e.source === 'fork') ctx.joined.add(e.session_id)
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
    ctx.failure = undefined // half a report of the last turn's failure is not this turn's
    const text = e.text.startsWith(NON_USER_FRAME) ? e.text.slice(NON_USER_FRAME.length) : e.text
    const command = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>(\/[^<]*)<\/command-name>/.exec(text)?.[1]
    const i = submitted.findLastIndex(s => s.text === text || (command !== undefined && typedCommand(s.text, command)))
    const hit = i >= 0 ? submitted.splice(i, 1)[0] : undefined
    const isUser = hit?.isUser ?? false
    const ultracode = isUser && typedUltracode(hit?.text ?? '')
    const fields = { isUser, text: hit?.text ?? text, command: command !== undefined, ultracode }
    // A turn whose first request came before it keeps what that request
    // decides: the step still running holds this very object.
    const turn = turns.get(e.turnId)
    if (turn) Object.assign(turn, fields)
    else turns.set(e.turnId, fields)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      // A fork of the main conversation shares it, so on the session's routed
      // model it reads the conversation's prompt cache (fork_follows_route).
      // Any other subagent, a fork that starts on another model than the
      // session's own (one made in a command's turn, on the command's model),
      // and a fork's step on the engine's fallback, is left alone.
      if (!opt.forkFollowsRoute || ctx.disabled) return yield* next(e)
      if (!ctx.forks.has(e.agentId)) {
        const agent = (await $.agent.list()).find(a => a.id === e.agentId)
        const own = await sessionModel($, ctx, await $.session.id())
        const routed = agent?.type === 'fork' && !agent.parentId && (own === undefined || sameModel(e.model, own))
        ctx.forks.set(e.agentId, routed ? e.model : null)
      }
      if (ctx.forks.get(e.agentId) !== e.model || !(await apiKey($, opt))) return yield* next(e)
      const [, r] = await serial(ctx, () => record($))
      const model = (r.mode ?? opt.defaultMode) === 'auto' ? current(r) : undefined
      return yield* next(model && movesTo(model, e.model) ? { ...e, model } : e)
    }
    if (ctx.disabled) return yield* next(e)
    let turn = turns.get(e.turnId)
    if (!turn) {
      turn = { isUser: false, text: '' }
      turns.set(e.turnId, turn)
    }
    let deciding: Promise<Plan | undefined> | undefined
    if (!turn.plan) {
      turn.baseModel = e.model
      turn.baseEffort = e.effort
      // The request goes as soon as its plan is known, which may be before
      // Jev answers; a plan that fails leaves the turn as it is, asked once.
      let early!: (p: Plan) => void
      const known = new Promise<Plan>(resolve => (early = resolve))
      deciding = plan($, ctx, e.model, e.effort, turn, next.signal, early).catch(() => undefined)
      turn.decided = deciding
      turn.plan = await Promise.race([known, deciding.then(p => p ?? { apply: false })])
    } else if (e.model !== turn.baseModel) {
      return tally(turn, yield* next(e)) // the engine fell back to another model: leave it
    } else if (e.effort !== turn.baseEffort) {
      turn.ownEffort = true
    }

    const { apply, model } = turn.plan
    const effort = turn.ownEffort ? undefined : turn.plan.effort
    const rewritesModel = apply && model !== undefined && movesTo(model, e.model)
    const result =
      !rewritesModel && !(apply && effort)
        ? yield* next(e)
        : yield* next({
            ...e,
            ...(rewritesModel ? { model } : {}),
            ...(apply && effort ? { effort } : {}),
          })
    tally(turn, result)
    if (deciding) {
      // The decision the first request answers for, written down by now.
      const logKey = (await deciding)?.logKey
      if (logKey && result.usage) await servedAs($, ctx, logKey, rewritesModel ? model : e.model, result.usage.model)
    }
    if (rewritesModel && result.usage && !sameModel(result.usage.model, model)) {
      turn.plan = { ...turn.plan, model: undefined }
      turn.unanswered = undefined // blamed here, not again when the turn ends
      await drop($, ctx, model, `${label(result.usage.model)} answered`)
    } else if (rewritesModel && result.stopReason === 'refusal') {
      // A model that declines the conversation would decline it again.
      turn.plan = { ...turn.plan, model: undefined }
      turn.unanswered = undefined
      await drop($, ctx, model, 'refused')
    } else if (rewritesModel) {
      const noResponse = !result.usage && result.stopReason === null && !next.signal.aborted
      turn.unanswered = noResponse ? model : undefined
      if (result.usage) ctx.answered.add(model)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      const turn = turns.get(e.turnId)
      turns.delete(e.turnId)
      // A request with no response is the model's doing (an unknown id, no
      // access) only when the turn died of it: the engine retries others
      // itself, a context overflow after compacting, say. Why it died comes
      // with StopFailure, before or after this.
      if (turn?.unanswered && e.reason === 'error') await failed($, ctx, { model: turn.unanswered })
      // Also for a turn interrupted mid-request, whose step went no further.
      const logKey = (await turn?.decided)?.logKey
      const d = logKey ? ((await $.store.get(logKey)) as Decision | undefined) : undefined
      if (logKey && d) await $.store.set(logKey, { ...d, outcome: { reason: e.reason, ...(turn?.tally ?? NO_REQUESTS) } })
      if (e.answer && !ctx.disabled) {
        const [id, r] = await record($)
        if ((r.mode ?? opt.defaultMode) !== 'off' && (await apiKey($, opt))) {
          // A fork's transcript ends with this reply: it names the session to go on from.
          if (r.decided && e.answer.trim().length >= FORK_REPLY_CHARS) {
            await $.store.set(`fork:${await fingerprint(e.answer)}`, id)
            await trim($, 'fork:', KEEP)
          }
          if (opt.sendAssistantTail) {
            await change($, ctx, latest => {
              latest.replyTail = redact(e.answer).slice(-opt.tailChars)
            })
          }
        }
      }
    }
    return next(e)
  })

  // Why a turn of the main loop died of an API error, in Claude Code's own words.
  on('classic.StopFailure', async ($, e, next) => {
    if (!e.agent_id) await failed($, ctx, { error: e.error })
    return next(e)
  })

  // A switch after the session's model was chosen is the person overriding
  // it; one before (an app applying its picker at start) is the starting point.
  // PostModelSwitch: only a switch that took effect, and only the person's
  // (not a fallback or a plan mode toggled under opusplan, not a resume
  // restoring the model).
  on('classic.PostModelSwitch', async ($, e, next) => {
    ctx.engineModels.set(await $.session.id(), e.to_model)
    const byPerson = e.source === 'command' || e.source === 'picker' || e.source === 'sdk'
    if (byPerson && e.from_model !== e.to_model) {
      await joinedRecord($, ctx) // a resumed or forked conversation was decided before this
      await change($, ctx, r => {
        if (!r.decided) return false
        r.userModel = true
        delete r.pin
      })
    }
    return next(e)
  })

  // /model naming the model in use, or /effort naming a level, is the
  // person's choice, which no switch reports. A switch to another model reports
  // itself; a word that only shows something, the picker or a name that is no
  // model or level is no choice.
  on('command.run', { command: ['model', 'effort'] }, async ($, e, next) => {
    const result = await next(e)
    const arg = e.args.trim()
    if (!arg || ctx.disabled) return result
    const [id] = await joinedRecord($, ctx)
    const bare = (model: string) => model.replace(/\[\w+\]$/, '')
    const engine = e.command === 'model' ? await sessionModel($, ctx, id) : undefined
    const named = e.command === 'model' ? resolveModel(arg, await resolution($, ctx, id)) : undefined
    const chosen =
      e.command === 'effort' ? isEffort(arg.toLowerCase()) || /^\d+$/.test(arg) : !!named && !!engine && bare(named.id) === bare(engine)
    if (chosen) {
      await change($, ctx, r => {
        if (!r.decided) return false
        if (e.command === 'effort') r.effortPinned = true
        else {
          r.userModel = true
          delete r.pin
        }
      })
    }
    return result
  })

  on('command.run', { command: 'jcGearbox' }, ($, e) => {
    const [sub = '', arg] = e.args.trim().split(/\s+/)
    return jcGearbox($, ctx, sub, arg)
  })
  on('command.run', { command: 'jcGearbox-status' }, $ => jcGearbox($, ctx, 'status', undefined))
  on('command.run', { command: 'jcGearbox-auto' }, $ => jcGearbox($, ctx, 'auto', undefined))
  on('command.run', { command: 'jcGearbox-shadow' }, $ => jcGearbox($, ctx, 'shadow', undefined))
  on('command.run', { command: 'jcGearbox-off' }, $ => jcGearbox($, ctx, 'off', undefined))
  on('command.run', { command: 'jcGearbox-on' }, $ => jcGearbox($, ctx, 'on', undefined))
  on('command.run', { command: 'jcGearbox-pin' }, ($, e) => jcGearbox($, ctx, 'pin', e.args.trim().split(/\s+/)[0] || undefined))
  on('command.run', { command: 'jcGearbox-log' }, ($, e) => jcGearbox($, ctx, 'log', e.args.trim().split(/\s+/)[0] || undefined))
  on('command.run', { command: 'jcGearbox-stats' }, $ => jcGearbox($, ctx, 'stats', undefined))
}

async function jcGearbox($: EngineInterface, ctx: Ctx, sub: string, arg: string | undefined) {
  const { opt } = ctx
  if (sub === 'log') {
    const n = Number.parseInt(arg ?? '', 10)
    return { text: await logText($, n > 0 ? n : 20) }
  }
  if (sub === 'stats') return { text: await statsText($, opt) }
  const [id, r] = await joinedRecord($, ctx)
  if (sub === '' || sub === 'status') {
    const tiers = ctx.disabled ? undefined : (await resolution($, ctx, id)).tiers
    return { text: report(r, opt, tiers) }
  }
  // Back on drops the session's own mode (auto when the default is off) and
  // keeps any pin: it undoes /jcGearbox-off, not /model or /jcGearbox-pin.
  if (sub === 'on') {
    const latest = await change($, ctx, r => {
      if (opt.defaultMode === 'off') r.mode = 'auto'
      else delete r.mode
    })
    await showMode($, ctx)
    return { text: `jcGearbox: ${latest.mode ?? opt.defaultMode} for this session.` }
  }
  if (sub === 'auto' || sub === 'shadow' || sub === 'off') {
    await change($, ctx, r => {
      r.mode = sub
      if (sub === 'auto') {
        delete r.pin
        delete r.userModel
        delete r.effortPinned
        delete r.rawEffort
      }
    })
    await showMode($, ctx)
    return { text: sub === 'auto' ? 'jcGearbox: auto for this session; pins cleared.' : `jcGearbox: ${sub} for this session.` }
  }
  if (sub === 'pin' && arg) {
    const pinned = resolveModel(arg, await resolution($, ctx, id))
    if (!pinned) return { text: `jcGearbox: cannot resolve "${arg}" here; give a full model id.` }
    if (r.badModels?.includes(pinned.id)) {
      return { text: `jcGearbox: ${pinned.id} was not used when asked for earlier in this session; not pinning it.` }
    }
    await change($, ctx, r => {
      r.pin = pinned.id
      delete r.userModel
    })
    return { text: `jcGearbox: model pinned to ${pinned.id} for this session (/jcGearbox-auto clears it).` }
  }
  return { text: USAGE }
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

// $.store keeps each read and write whole but has no transactions: one hook
// at a time reads the session's record, changes it and saves it.
function serial<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const run = ctx.queue.then(fn)
  ctx.queue = run.catch(() => undefined)
  return run
}

// Saves the session's record as `edit` changes it, unless it says no change.
function change($: EngineInterface, ctx: Ctx, edit: (r: SessionRecord) => boolean | void): Promise<SessionRecord> {
  return serial(ctx, async () => {
    const [id, r] = await record($)
    if (edit(r) !== false) await save($, id, r)
    return r
  })
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

async function plan(
  $: EngineInterface,
  ctx: Ctx,
  model: string,
  rawEffort: Effort | number | undefined,
  turn: Turn,
  signal: AbortSignal,
  early: (request: Plan) => void,
): Promise<Plan> {
  const { opt } = ctx
  const [id, joined] = await joinedRecord($, ctx)
  const mode = joined.mode ?? opt.defaultMode
  if (mode === 'off') {
    $.ui.status(undefined)
    return { apply: false }
  }
  const key = await apiKey($, opt)
  if (!key) {
    $.ui.status('no API key')
    return { apply: false }
  }

  const { tiers } = await resolution($, ctx, id)
  const first = !joined.decided
  // Shadow sends every request as it is; after the first turn the model is
  // set, so a pinned effort, or a model that takes none, leaves Jev nothing
  // to change. The request goes ahead and the answer is written down after.
  if (mode === 'shadow') early({ apply: false })
  else if (turn.isUser && !first && !turn.command && (joined.effortPinned || !takesEffort(current(joined) ?? model))) {
    early({ apply: true, model: current(joined) })
  }
  const offered = TIERS.filter(t => tiers[t])
  let asked: { result?: JevResult; error?: string } | undefined
  let jevMs: number | undefined
  if (turn.isUser) {
    const distinct = new Set(offered.map(t => tiers[t]?.id)).size
    const body = buildRequest({
      jevModel: opt.jevModel,
      prompt: turn.text,
      isFirstTurn: first,
      tiers: distinct >= 2 ? offered : undefined,
      previousPrompt: joined.prompt,
      replyTail: opt.sendAssistantTail ? joined.replyTail?.slice(-opt.tailChars) : undefined,
      // A Bedrock ARN names the AWS account: what follows it is enough.
      previous: first ? undefined : { model: (current(joined) ?? model).replace(/^arn:[^/]*\//, ''), effort: lastEffort(joined) },
    })
    const started = await $.clock.now()
    asked = await askJev($, key, body, signal, opt.jevTimeoutMs)
    // The first turn picks the session's model: a quick network error or 5xx
    // is asked again while a second is left.
    const left = opt.jevTimeoutMs - ((await $.clock.now()) - started)
    if (first && /^(network error|HTTP 5\d\d)$/.test(asked.error ?? '') && left > 1000 && !signal.aborted) {
      asked = await askJev($, key, body, signal, left)
    }
    jevMs = (await $.clock.now()) - started
    if (signal.aborted) return { apply: false } // interrupted: nothing decided, the next prompt asks again
  }

  // Read again, to keep what /model or /jcGearbox changed while Jev answered.
  return serial(ctx, async (): Promise<Plan> => {
    const [, r] = await record($)

    // The engine's effort is the session's setting or the model's default each
    // turn; ours only ever rides one request. A change between two turns on the
    // same model is the person's doing, once this process has seen the one
    // before (a resumed session's may have changed for other reasons). A
    // command's own effort and model ride its turn alone: they are left as
    // they are and pin nothing (and with no baseline to tell, a command's
    // effort is left as it is too).
    const raw = rawEffort ?? null
    const baseline = ctx.baselined.has(id) && r.rawEffort !== undefined && r.rawModel === model
    const changed = baseline && r.rawEffort !== raw
    const own = turn.command ? await sessionModel($, ctx, id) : undefined
    const ownModel = !!turn.command && own !== undefined && !sameModel(model, own)
    if (!turn.command) {
      ctx.engineModels.set(id, model)
      if (changed) r.effortPinned = true
      r.rawEffort = raw
      r.rawModel = model
      ctx.baselined.add(id)
    }

    let unsure = false
    if (asked) {
      const error = asked.error
      const decided = decideEffort({
        signals: asked.result?.signals,
        // Before the router has decided an effort, the last turn ran at the engine's.
        previous: r.effort ?? (asked.result && isEffort(r.rawEffort) ? r.rawEffort : undefined),
        isFirstTurn: first,
        threshold: opt.signalThreshold,
        continuationThreshold: opt.continuationThreshold,
        minEffort: opt.minEffort,
        maxEffort: opt.maxEffort,
        minConfidence: opt.effortMinConfidence,
      })
      // Said only where it changed what runs: an effort of the router's, on a model that takes one.
      unsure = !!decided.unsure && !r.effortPinned && takesEffort(current(r) ?? model)
      if (first) {
        r.decided = true
        const ids: Partial<Record<Tier, string>> = {}
        for (const t of offered) ids[t] = tiers[t]?.id
        r.model = pickModel({
          probabilities: asked.result?.tierProbabilities,
          models: ids,
          engine: engineTiers(turn.command ? (own ?? model) : model, tiers), // a command's own model is not the session's
          upgrade: opt.tierUpgradeProbability,
          downgrade: opt.tierMinProbability,
        })
      }
      if (decided.effort) r.effort = decided.effort
      r.prompt = clip(redact(turn.text), CONTEXT_CHARS)
      delete r.replyTail // the reply to this prompt, if it shows one, takes its place
      let limits: Record<string, number> = {}
      try {
        limits = Object.fromEntries((await $.session.usage()).rateLimits.map(l => [l.kind, l.percentUsed]))
      } catch {
        // a Claude Code that cannot tell leaves them out
      }
      r.last = {
        at: await $.clock.now(),
        mode,
        first,
        prompt: redact(turn.text).slice(0, 200),
        promptLength: turn.text.length,
        jev: asked.result ?? null,
        ...(error ? { error } : {}),
        ...(r.model ? { model: r.model } : {}),
        ...(decided.effort ? { effort: decided.effort } : {}),
        engine: { model, effort: raw },
        ...(jevMs !== undefined ? { jevMs } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      }
    }

    const chosen = ownModel ? undefined : current(r)
    const effort =
      r.effortPinned || (turn.command && (changed || !baseline)) ? undefined : effortFor(chosen ?? model, r.effort)
    // The ultracode keyword only lets Claude Code run workflows this turn; the
    // model and effort are routed as on any other turn.
    const auto = mode === 'auto'
    const sentModel = auto && chosen ? chosen : model
    // A model rewritten without an effort of ours runs at whatever effort the
    // engine works out for it, which the person's settings decide.
    const unknown = auto && chosen !== undefined && movesTo(chosen, model) && !effort && !r.effortPinned && !(turn.command && changed)
    const sentEffort = auto && effort ? effort : unknown ? '?' : (rawEffort ?? null)
    const sent = { model: sentModel, effort: takesEffort(sentModel) ? sentEffort : null }
    const why = [
      ...(auto ? [] : ['shadow']),
      ...(turn.ultracode ? ['ultracode'] : []),
      ...(r.pin ? ['pin'] : r.userModel ? ['/model'] : []),
      ...(r.effortPinned ? ['effort pinned'] : []),
      ...(ownModel ? ['command model'] : []),
      ...(unsure ? ['Jev unsure'] : []),
    ]
    // Jev's own pick: the first turn's model, at the effort Jev decided (the
    // sent one when it decided none).
    const jevModel = r.model ?? model
    const jevEffort = takesEffort(jevModel) ? (effortFor(jevModel, r.effort) ?? sent.effort ?? defaultEffort(sent.model) ?? '-') : '-'
    const pick = `${label(jevModel)}·${jevEffort}`
    let logKey: string | undefined
    if (asked && r.last) {
      r.last.sent = sent
      r.last.pick = pick
      if (why.length > 0) r.last.why = why
      logKey = `log:${r.last.at}:${id.slice(0, 8)}:${ctx.logged++}`
      await $.store.set(logKey, { ...r.last, session: id })
      await trim($, 'log:', KEEP)
    }
    await save($, id, r)

    // Only the model and effort: in auto what was sent, in shadow Jev's pick
    // (what was sent is the session's own). The why is in /jcGearbox-log; a Jev
    // error is said, or an unjudged prompt would look judged.
    const head = auto ? '' : `${mode} ▸ `
    $.ui.status(`${head}${auto ? sentLabel(sent) : pick}${asked?.error ? ` · Jev ${asked.error}` : ''}`)

    return { apply: auto, model: chosen, effort, logKey }
  })
}

// The tier a model's family stands for in Anthropic's matrix; none for an id
// that names no family.
const FAMILY_TIERS = [['haiku', 'low'], ['sonnet', 'balanced'], ['opus', 'strong'], ['fable', 'long'], ['mythos', 'long']] as const
const familyTier = (model: string | undefined): Tier | undefined => FAMILY_TIERS.find(([name]) => model?.includes(name))?.[1]

// The tiers the engine's model is: those naming it, else its family's.
function engineTiers(model: string, tiers: Tiers): Tier[] {
  const id = model.replace(/\[\w+\]$/, '')
  const named = TIERS.filter(t => tiers[t]?.id.replace(/\[\w+\]$/, '') === id)
  if (named.length > 0) return named
  const tier = familyTier(id)
  return tier ? [tier] : []
}

// The model the session runs on: a pin, else the first turn's choice unless
// the person switched since; never one the API did not answer as.
function current(r: SessionRecord): string | undefined {
  const model = r.pin ?? (r.userModel ? undefined : r.model)
  return model && !r.badModels?.includes(model) ? model : undefined
}

// The session's own model: as its start, its last plain turn or a switch left
// it, else as the engine reports it now.
async function sessionModel($: EngineInterface, ctx: Ctx, id: string): Promise<string | undefined> {
  const known = ctx.engineModels.get(id)
  if (known) return known
  try {
    return await $.session.model()
  } catch {
    return undefined // a Claude Code that cannot tell
  }
}

// The session's record. A resumed or forked conversation it has none of is
// not a new one: a fork goes on as the session it came from; any other keeps
// its model rather than one picked from a prompt in mid-conversation. Done
// once, before a command or the first decision touches the record.
function joinedRecord($: EngineInterface, ctx: Ctx): Promise<[string, SessionRecord]> {
  return serial(ctx, async (): Promise<[string, SessionRecord]> => {
    const [id, r] = await record($)
    if (r.decided || !ctx.joined.delete(id)) return [id, r]
    const joined = { ...(await parentRecord($, id)), ...r, decided: true }
    await save($, id, joined)
    return [id, joined]
  })
}

// The record of the session a fork came from, named by the newest of the
// transcript's long replies that a session wrote down (the last 20 tried); the
// engine's model and effort of its last turn stay behind.
async function parentRecord($: EngineInterface, id: string): Promise<SessionRecord | undefined> {
  const known = new Set((await $.store.keys()).filter(k => k.startsWith('fork:')))
  const replies = (await $.session.messages()).filter(m => m.role === 'assistant' && m.text.trim().length >= FORK_REPLY_CHARS)
  for (const reply of replies.slice(-20).reverse()) {
    const key = `fork:${await fingerprint(reply.text)}`
    if (!known.has(key)) continue
    const parent = await $.store.get(key)
    if (typeof parent !== 'string' || parent === id) return undefined
    const found = (await $.store.get(`session:${parent}`)) as SessionRecord | undefined
    return found?.decided ? { ...found, rawEffort: undefined, rawModel: undefined, last: undefined } : undefined
  }
  return undefined
}

// A short hash of a reply's end, which a fork's transcript repeats as it was.
async function fingerprint(text: string): Promise<string> {
  const end = new TextEncoder().encode(text.trim().slice(-FORK_REPLY_CHARS))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', end))
  return [...hash.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// The effort the last turn ran at: the person's own once they pinned it.
function lastEffort(r: SessionRecord): string | undefined {
  return r.effortPinned && typeof r.rawEffort === 'string' ? r.rawEffort : r.effort
}

async function drop($: EngineInterface, ctx: Ctx, model: string, answered: string) {
  await change($, ctx, r => {
    r.badModels = [...(r.badModels ?? []), model]
  })
  $.ui.status(`${label(model)} was not used (${answered}); not switching to it again`)
}

// The errors Claude Code itself takes for ones that may clear by themselves.
const TRANSIENT = new Set(['overloaded', 'server_error'])

// Blames the model a turn's rewritten request named once both reports of the
// turn's failure are in. An overload or a server error says nothing of the
// model; any other error is its doing, unless it has answered since its last
// such turn, which is given one more.
async function failed($: EngineInterface, ctx: Ctx, report: Failure) {
  const { model, error } = { ...ctx.failure, ...report }
  if (model === undefined || error === undefined) {
    ctx.failure = { model, error }
    return
  }
  ctx.failure = undefined
  if (!TRANSIENT.has(error) && !ctx.answered.delete(model)) await drop($, ctx, model, 'no response')
}

// The API answered as another model than the one the request named: say so
// in that turn's log line and in /jcGearbox.
async function servedAs($: EngineInterface, ctx: Ctx, logKey: string, sent: string, answered: string) {
  if (sameModel(answered, sent)) return
  const d = (await $.store.get(logKey)) as (Decision & { session: string }) | undefined
  if (!d) return
  await $.store.set(logKey, { ...d, served: answered })
  await change($, ctx, r => {
    if (r.last?.at !== d.at) return false
    r.last.served = answered
  })
}

const takesEffort = (model: string) => defaultEffort(model) !== undefined

// Counts a request toward its turn's log entry.
function tally(turn: Turn, result: TurnStepResult): TurnStepResult {
  const t = (turn.tally ??= { ...NO_REQUESTS })
  t.steps++
  t.stop = result.stopReason
  t.input += result.usage?.input_tokens ?? 0
  t.output += result.usage?.output_tokens ?? 0
  t.cacheRead += result.usage?.cache_read_input_tokens ?? 0
  t.cacheWrite += result.usage?.cache_creation_input_tokens ?? 0
  return result
}

// Claude Code's own test for a typed keyword: not in a slash command, not
// inside quotes or brackets, not part of a path, a flag or a question about it.
const CLOSERS: Record<string, string> = { '`': '`', '"': '"', '<': '>', '{': '}', '[': ']', '(': ')', "'": "'" }
function typedUltracode(text: string): boolean {
  if (text.startsWith('/') || !/ultracode/i.test(text)) return false
  const word = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c)
  const spans: [number, number][] = []
  let open: string | null = null
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (open) {
      if (open === '[' && c === '[') from = i
      else if (c === CLOSERS[open] && !(open === "'" && word(text[i + 1]))) {
        spans.push([from, i + 1])
        open = null
      }
    } else if ((c === '<' && /[a-zA-Z/]/.test(text[i + 1] ?? '')) || (c === "'" && !word(text[i - 1])) || (c !== '<' && c !== "'" && c in CLOSERS)) {
      open = c
      from = i
    }
  }
  for (const m of text.matchAll(/\bultracode\b/gi)) {
    const at = m.index
    const end = at + m[0].length
    const before = text[at - 1]
    const after = text[end]
    if (spans.some(([a, b]) => at >= a && at < b)) continue
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    if (after === '.' && word(text[end + 1])) continue
    return true
  }
  return false
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
  $.ui.status(ctx.disabled ?? (mode === 'off' ? undefined : !key ? 'no API key' : mode === 'auto' ? 'auto' : mode))
}

const pct = (p: number) => p.toFixed(2)
// No effort on the request means the model's default, which is what runs.
const sentLabel = (sent: NonNullable<Decision['sent']>) => `${label(sent.model)}·${sent.effort ?? defaultEffort(sent.model) ?? '-'}`
const notesOf = (d: Decision) => [...(d.why ?? []), ...(d.served ? [`served ${label(d.served)}`] : [])].map(n => ` · ${n}`).join('')

function report(r: SessionRecord, opt: Options, tiers: Tiers | undefined): string {
  const { defaultMode } = opt
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
    `jcGearbox: ${r.mode ?? defaultMode} (${r.mode ? 'this session' : 'default'})`,
    `model: ${model}`,
    `effort: ${r.effortPinned ? 'yours (you changed it)' : (r.effort ?? 'not set yet')}`,
  ]
  if (tiers) {
    const named = (t: Tier) => {
      const m = tiers[t]
      // A value that resolves to nothing but is not off is an alias, which needs an Anthropic login.
      if (!m) return /^(off)?$/i.test(opt.tierModels[t]?.trim() ?? '') ? 'off' : 'off (alias needs an Anthropic login)'
      const notes = [...(m.source === 'builtin' ? ['built-in'] : []), ...(r.badModels?.includes(m.id) ? ['not served'] : [])]
      return `${m.id.replace(/^claude-/, '')}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`
    }
    lines.push(`tiers: ${[...TIERS].reverse().map(t => `${t} ${named(t)}`).join(' · ')}`)
  }
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
    const by = last.error ? ` (Jev ${last.error})` : last.jev?.version ? ` (${last.jev.version})` : ''
    lines.push(`last turn: ${parts.join(' · ') || 'no answer'}${by}`)
    if (last.sent) lines.push(`sent: ${sentLabel(last.sent)}${notesOf(last)}`)
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
    const jev = d.pick ?? `${label(d.model ?? d.sent?.model)}·${d.effort ?? '-'}`
    const shown = d.sent ? sentLabel(d.sent) : jev
    const other = shown === jev ? '' : `  jev ${jev}`
    lines.push(`${when}  ${d.mode.padEnd(6)} ${shown}${other}${notesOf(d)}${flags}  ${JSON.stringify(d.prompt.slice(0, 60))}`)
  }
  // The prompts as typed, escaped and fenced, so none of them reads as markdown.
  return lines.length > 0 ? ['```', ...lines, '```'].join('\n') : 'jcGearbox: no decisions logged yet.'
}

// How the logged decisions Jev answered compare with what the engine would
// have run: in shadow the sent request is the engine's own, in auto the log
// keeps it.
async function statsText($: EngineInterface, opt: Options): Promise<string> {
  const ds: (Decision & { session?: string })[] = []
  for (const key of (await $.store.keys()).filter(k => k.startsWith('log:'))) {
    const d = (await $.store.get(key)) as (Decision & { session?: string }) | undefined
    if (d) ds.push(d)
  }
  if (ds.length === 0) return 'jcGearbox: no decisions logged yet.'
  const engine = (d: Decision) => d.engine ?? (d.mode === 'auto' ? undefined : d.sent)
  const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`
  const day = (at: number) => {
    const t = new Date(at)
    return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  }
  const ats = ds.map(d => d.at)

  // A first turn moved up or down the tiers, or kept the engine's model.
  const rank = (model: string | undefined) => {
    const tier = familyTier(model)
    return tier ? ['low', 'balanced', 'strong', 'long'].indexOf(tier) : undefined
  }
  const models = { up: 0, same: 0, down: 0 }
  const answered = ds.filter(d => d.jev)
  for (const d of answered.filter(d => d.first)) {
    const from = rank(engine(d)?.model)
    const to = rank(d.model ?? engine(d)?.model)
    if (from === undefined || to === undefined) continue
    models[to > from ? 'up' : to < from ? 'down' : 'same']++
  }
  const efforts = { higher: 0, same: 0, lower: 0 }
  for (const d of answered) {
    const from = engine(d)?.effort
    if (!isEffort(d.effort) || !isEffort(from)) continue
    const diff = EFFORTS.indexOf(d.effort) - EFFORTS.indexOf(from)
    efforts[diff > 0 ? 'higher' : diff < 0 ? 'lower' : 'same']++
  }

  const errors = ds.filter(d => d.error).length
  const unsure = ds.filter(d => d.why?.includes('Jev unsure')).length
  const times = answered.flatMap(d => (d.jevMs === undefined ? [] : [d.jevMs])).sort((a, b) => a - b)
  const at = (q: number) => times[Math.max(0, Math.ceil(q * times.length) - 1)]
  const timing = times.length > 0 ? ` · answers took p50 ${at(0.5)} ms, p95 ${at(0.95)} ms` : ''
  const later = answered.filter(d => !d.first)
  const complaints = later.filter(d => (d.jev?.signals.escalate ?? 0) > opt.signalThreshold).length
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  return [
    `jcGearbox stats: the last ${ds.length} decisions, ${new Set(ds.map(d => d.session)).size} sessions, ${day(Math.min(...ats))} to ${day(Math.max(...ats))}`,
    `first-turn model, Jev's vs the engine's (${sum(models)}): up ${models.up} · same ${models.same} · down ${models.down}`,
    `effort, the router's vs the engine's (${sum(efforts)}): higher ${efforts.higher} · same ${efforts.same} · lower ${efforts.lower}`,
    `Jev: ${errors} error${errors === 1 ? '' : 's'} of ${ds.length} (${pct(errors, ds.length)})${unsure > 0 ? ` · unsure of the effort ${unsure}` : ''}${timing}`,
    later.length > 0
      ? `complaints: ${complaints} of ${later.length} later turns Jev answered (${pct(complaints, later.length)})`
      : 'complaints: no later turns Jev answered yet',
  ].join('\n')
}

type Options = ReturnType<typeof readOptions>

function readOptions(options: PluginOptions) {
  const text = (key: string) => (typeof options[key] === 'string' ? (options[key] as string) : undefined)
  const num = (key: string) => options[key] as number
  return {
    apiKey: text('api_key'),
    defaultMode: text('default_mode') as Mode,
    tierModels: {
      low: text('low_model'),
      balanced: text('balanced_model'),
      strong: text('strong_model'),
      long: text('long_model'),
    } as Record<Tier, string | undefined>,
    tierMinProbability: num('tier_min_probability'), // to move to a weaker model
    tierUpgradeProbability: num('tier_upgrade_probability'),
    signalThreshold: num('signal_threshold'),
    continuationThreshold: num('continuation_threshold'),
    effortMinConfidence: num('effort_min_confidence'),
    minEffort: text('min_effort') as Effort,
    maxEffort: text('max_effort') as Effort,
    jevModel: text('jev_model') || 'jev-latest',
    jevTimeoutMs: Math.round(num('jev_timeout_seconds') * 1000),
    sendAssistantTail: options.send_assistant_tail === true,
    forkFollowsRoute: options.fork_follows_route === true,
    tailChars: Math.round(num('assistant_tail_chars')),
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
    // Windows often has no HOME, and a relative path would read the project's files.
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home && `${home}/.claude`)
    if (!configDir) return undefined
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
