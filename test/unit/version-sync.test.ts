/**
 * The artifact-version stamp (`PARSEMAN_VERSION`) MUST equal the published
 * package version — it is stamped into generated-artifact banners and enforced by
 * the fuse-time version lock, so a drift would either mis-stamp artifacts or make
 * the version assertion reject valid same-version links.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rules, regex } from '../../src/index.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { compileLinkableTable as compileLinkable } from '../../src/compiler/compile-linkable-table.ts'
import { compose } from '../../src/compiler/linker.ts'

describe('artifact version stamp', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    expect(PARSEMAN_VERSION).toBe(pkg.version)
  })

  it('stamps compiled pieces with the current version', () => {
    const p = compileLinkable(Object.entries(rules(() => ({ N: regex(/[0-9]+/) }))), '_v_')!
    expect(p.v).toBe(PARSEMAN_VERSION)
  })

  it('runtime compose() links no table artifact at all — current, stale or unstamped', () => {
    // Tables are fused at BUILD time only; at runtime compose() links live rules()
    // maps, so an artifact's version is never the thing that decides.
    const p = compileLinkable(Object.entries(rules(() => ({ N: regex(/[0-9]+/) }))), '_v_')!
    for (const artifact of [p, { ...p, v: '0.0.0-stale' }, { ...p, v: undefined } as unknown as typeof p]) {
      expect(() => compose([artifact])).toThrow('the table artifact "_v_" has no live rules to link')
    }
  })
})
