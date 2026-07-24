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
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { fuseRules } from '../../src/compiler/linker.ts'

describe('artifact version stamp', () => {
  it('matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    expect(PARSEMAN_VERSION).toBe(pkg.version)
  })

  it('stamps compiled pieces with the current version', () => {
    const p = compileLinkable(Object.entries(rules(() => ({ N: regex(/[0-9]+/) }))), '_v_')!
    expect(p.v).toBe(PARSEMAN_VERSION)
  })

  it('fusedBody REFUSES to link an artifact stamped with a different version', () => {
    const p = compileLinkable(Object.entries(rules(() => ({ N: regex(/[0-9]+/) }))), '_v_')!
    const stale = { ...p, v: '0.0.0-stale' }
    expect(() => fuseRules([stale])).toThrow(/version-locked|does not fuse across versions/)
    // a same-version artifact still fuses fine
    expect(() => fuseRules([p])).not.toThrow()
  })
})
