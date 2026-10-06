import { describe, expect, test } from 'claude-code/testing'

import { catalogModel, newestCatalogFile, resolveModel, surfaceOf, versionAtLeast } from '../hooks/models.ts'

const catalog = {
  version: 2,
  catalog: {
    config: {
      models: [
        { id: 'claude-opus-6', short_name: 'Opus', section: 'main', min_claude_code_version: '2.2.0' },
        { id: 'claude-opus-5-5', short_name: 'Opus', section: 'main', min_claude_code_version: '2.1.280' },
        { id: 'claude-sonnet-5', short_name: 'Sonnet', section: 'overflow', min_claude_code_version: null },
        { id: 'claude-sonnet-5-5', short_name: 'Sonnet', section: 'main', min_claude_code_version: null },
      ],
    },
  },
}

describe('versionAtLeast', () => {
  test('compares release numbers, ignoring a build suffix', () => {
    expect(versionAtLeast('2.1.286', '2.1.280')).toBe(true)
    expect(versionAtLeast('2.1.284', '2.1.286')).toBe(false)
    expect(versionAtLeast('2.2.0', '2.1.286')).toBe(true)
    expect(versionAtLeast('2.1.286-dev.20260920', '2.1.286')).toBe(true)
  })
})

describe('catalogModel', () => {
  test("takes the family's main model this version supports", () => {
    expect(catalogModel(catalog, 'sonnet', '2.1.286')).toBe('claude-sonnet-5-5')
    expect(catalogModel(catalog, 'opus', '2.1.286')).toBe('claude-opus-5-5')
    expect(catalogModel(catalog, 'opus', '2.2.1')).toBe('claude-opus-6')
  })

  test('answers nothing for an unknown family or shape', () => {
    expect(catalogModel(catalog, 'fable', '2.1.286')).toBeUndefined()
    expect(catalogModel({ catalog: {} }, 'sonnet', '2.1.286')).toBeUndefined()
    expect(catalogModel('garbage', 'sonnet', '2.1.286')).toBeUndefined()
  })
})

describe('surfaceOf', () => {
  test('follows the engine: remote, desktop, else the CLI', () => {
    expect(surfaceOf('claude-desktop', undefined)).toBe('ccd')
    expect(surfaceOf('local-agent', undefined)).toBe('ccd')
    expect(surfaceOf('cli', undefined)).toBe('cc')
    expect(surfaceOf(undefined, undefined)).toBe('cc')
    expect(surfaceOf('claude-desktop', '1')).toBe('ccr')
  })
})

describe('newestCatalogFile', () => {
  test("picks the surface's newest served catalog", () => {
    const entries = [
      { name: 'published-abc.json', kind: 'file' as const, size: 1, mtimeMs: 99, isLink: false },
      { name: 'tok-a-ccd.json', kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false },
      { name: 'tok-b-ccd.json', kind: 'file' as const, size: 1, mtimeMs: 5, isLink: false },
      { name: 'org-x-cc.json', kind: 'file' as const, size: 1, mtimeMs: 9, isLink: false },
    ]
    expect(newestCatalogFile(entries, 'ccd')).toBe('tok-b-ccd.json')
    expect(newestCatalogFile(entries, 'cc')).toBe('org-x-cc.json')
    expect(newestCatalogFile(entries, 'ccr')).toBeUndefined()
  })
})

describe('resolveModel', () => {
  const firstParty = { firstParty: true, catalog, version: '2.1.286' }

  test('an alias follows the catalog, then the built-in table', () => {
    expect(resolveModel('sonnet', firstParty)).toEqual({ id: 'claude-sonnet-5-5', source: 'catalog' })
    expect(resolveModel('Opus', firstParty)).toEqual({ id: 'claude-opus-5-5', source: 'catalog' })
    expect(resolveModel('fable', firstParty)).toEqual({ id: 'claude-fable-5-1', source: 'builtin' })
  })

  test('an alias means nothing off a first-party login', () => {
    expect(resolveModel('sonnet', { firstParty: false, catalog, version: '2.1.286' })).toBeUndefined()
  })

  test('a full id is used as written, and off or an empty value disables the tier', () => {
    expect(resolveModel('claude-opus-4-8', { firstParty: false, version: '2.1.286' })).toEqual({
      id: 'claude-opus-4-8',
      source: 'config',
    })
    expect(resolveModel('', firstParty)).toBeUndefined()
    expect(resolveModel(undefined, firstParty)).toBeUndefined()
    expect(resolveModel('off', firstParty)).toBeUndefined()
    expect(resolveModel(' OFF ', firstParty)).toBeUndefined()
  })
})
