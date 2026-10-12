// Model aliases to the full ids a request names. Pure: register.ts reads the
// catalog file and hands its JSON in.

import type { FsEntry } from 'claude-code'

const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Family = (typeof FAMILIES)[number]

// Used when Claude Code's catalog cannot be read. Update on new releases.
const BUILTIN: Record<Family, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
}

export type Surface = 'cc' | 'ccd' | 'ccr'
export type Resolved = { id: string; source: 'catalog' | 'builtin' | 'config' }

const DESKTOP_ENTRYPOINTS = ['claude-desktop', 'claude-desktop-3p', 'local-agent']

// "2.1.286-dev.20260920" compares as 2.1.286.
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
  const a = parts(version)
  const b = parts(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

// Which catalog the engine keeps for this surface, as Claude Code decides it.
export function surfaceOf(entrypoint: string | undefined, remote: string | undefined): Surface {
  if (remote) return 'ccr'
  return entrypoint && DESKTOP_ENTRYPOINTS.includes(entrypoint) ? 'ccd' : 'cc'
}

export function newestCatalogFile(entries: readonly FsEntry[], surface: Surface): string | undefined {
  const served = entries.filter(
    e => e.kind === 'file' && !e.name.startsWith('published-') && e.name.endsWith(`-${surface}.json`),
  )
  return served.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name
}

// The models of a catalog in the shape this mod reads, or none.
function modelsOf(catalog: unknown): unknown[] | undefined {
  const models = (catalog as { catalog?: { config?: { models?: unknown } } } | null)?.catalog?.config?.models
  return Array.isArray(models) ? models : undefined
}

// The family's model in the "main" section of Claude Code's model picker,
// skipping one that needs a newer Claude Code than `version`.
export function catalogModel(catalog: unknown, family: Family, version: string): string | undefined {
  for (const m of modelsOf(catalog) ?? []) {
    if (typeof m !== 'object' || m === null) continue
    const { id, short_name, section, min_claude_code_version, disabled } = m as Record<string, unknown>
    if (typeof id !== 'string' || section !== 'main' || disabled === true) continue
    if (typeof short_name !== 'string' || short_name.toLowerCase() !== family) continue
    if (typeof min_claude_code_version === 'string' && !versionAtLeast(version, min_claude_code_version)) continue
    return id
  }
  return undefined
}

// An alias resolves only on a first-party login, whose ids the catalog and
// the table hold; anything else is a full id, used as written. "off" (or an
// empty value) disables the tier: the config menu cannot store an empty one.
// An alias may end in [1m], as Claude Code's do, and its id keeps it.
export function resolveModel(
  value: string | undefined,
  ctx: { firstParty: boolean; catalog?: unknown; version: string },
): Resolved | undefined {
  const name = value?.trim()
  if (!name || name.toLowerCase() === 'off') return undefined
  const suffix = /\[1m\]$/i.test(name) ? '[1m]' : ''
  const family = FAMILIES.find(f => f === name.slice(0, name.length - suffix.length).toLowerCase())
  if (!family) return { id: name, source: 'config' }
  if (!ctx.firstParty) return undefined
  const fromCatalog = catalogModel(ctx.catalog, family, ctx.version)
  if (fromCatalog) return { id: fromCatalog + suffix, source: 'catalog' }
  // A catalog that offers the family nothing (no access to it, or a Claude
  // Code too old for it) turns the tier off; one that can't be read falls back.
  return modelsOf(ctx.catalog) ? undefined : { id: BUILTIN[family] + suffix, source: 'builtin' }
}
