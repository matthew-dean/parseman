/**
 * REPRO (Stage-C blocker): does a downstream `compose([base, delta])` reroute an
 * inherited parent's RECOGNIZER — not just its reducer — to a delta-overridden leaf?
 *
 * `compose-direct-builder-ir.test.ts` builds the same base (`Leaf`/`Pair`/`Doc`) and
 * a delta that widens `Leaf` to also accept `%ph`, and asserts:
 *   - `Doc('foo bar')` — but both leaves are lowercase, the UN-widened arm, so the
 *     widening is never exercised through the inherited parent, and
 *   - `Leaf('%ph')` — the overridden leaf DIRECTLY, not through a parent.
 * It never parses a WIDENED token THROUGH the inherited parent. This test does.
 *
 * The claim under test (parser owns structure / Stage C's premise): widen the leaf,
 * and every inherited structural parent that references it accepts the widened input.
 */
import { describe, expect, it } from 'vitest'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalMacroExports, evalMacroModule } from '../helpers/eval-macro-module.ts'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

type Fused = Record<string, (input: string, pos: number, ctx: object) => { ok: boolean; value: unknown }>

describe('compose open-recursion: inherited parent recognizes the widened leaf', () => {
  it('routes a delta-widened leaf through the INHERITED parent (not just the leaf directly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-openrec-recognizer-'))
    try {
      // Base: Leaf accepts only /[a-z]+/; Pair = two Leaves; Doc = Pair.
      const baseT = transformMacro(
        `import { rules, node, regex, sequence, compose } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/[a-z]+/), children => ({ type: 'Leaf', text: children[0]?.value })),
  Pair: node('Pair', sequence(g.Leaf, g.Leaf), children => ({ type: 'Pair', kids: [...children] })),
  Doc: node('Doc', g.Pair, children => children[0]),
}))])`,
        path.join(dir, 'base.ts'), new Set(['parseman']),
      )!
      expect(baseT.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)

      // Delta: widen ONLY Leaf to also accept a `%name` placeholder; inherit Pair + Doc.
      const downT = transformMacro(
        `import { rules, node, regex, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const ws = regex(/[ \\t\\n]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', choice(regex(/[a-z]+/), regex(/%[a-z]+/)), children => ({ type: 'WideLeaf', text: children[0]?.value })),
}))])`,
        path.join(dir, 'down.ts'), new Set(['parseman']),
      )!
      expect(downT.warnings).toEqual([])
      // Fully macro-fused (no runtime compose(), no interpreter fallback).
      expect(/\bcompose\s*\(/.test(downT.code)).toBe(false)
      expect(/_rp\[\d+\]\.parse\(/.test(downT.code)).toBe(false)

      const base = evalMacroExports(baseT.code, {}).base
      const parser = evalMacroModule<Fused>(downT.code, 'parser', { base })

      // CONTROL — the leaf directly admits the widened token (this already passes today).
      expect(parser.Leaf!('%ph', 0, {}).value).toEqual({ type: 'WideLeaf', text: '%ph' })

      // THE ACTUAL CLAIM — the widened token routes THROUGH the inherited Pair/Doc.
      const pair = parser.Pair!('%ph %ph', 0, {})
      expect(pair.ok, 'inherited Pair must accept the widened leaf').toBe(true)
      expect(pair.value).toEqual({
        type: 'Pair',
        kids: [{ type: 'WideLeaf', text: '%ph' }, { type: 'WideLeaf', text: '%ph' }],
      })

      const doc = parser.Doc!('%ph %ph', 0, {})
      expect(doc.ok, 'inherited Doc must accept the widened leaf through Pair').toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compose open-recursion: RAW rules() base (agent minimal-repro variant)', () => {
  it('reroutes a widened leaf through an inherited parent when base is a raw rules() map', () => {
    // The agent's minimal repro: base is `rules(...)`, NOT `compose([rules(...)])`.
    const src = `import { rules, node, regex, choice, sequence, compose } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]*/)
const base = rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/a/), () => ({ type: 'Leaf' })),
  Parent: node('Parent', g.Leaf, c => ({ type: 'Parent', child: c[0] })),
}))
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', choice(regex(/a/), regex(/b/)), () => ({ type: 'WideLeaf' })),
}))], { hostMode: 'ast' })`
    const t = transformMacro(src, '/pkg/raw.ts', new Set(['parseman']))!
    expect(t.warnings).toEqual([])
    expect(/\bcompose\s*\(/.test(t.code)).toBe(false)
    expect(/_rp\[\d+\]\.parse\(/.test(t.code)).toBe(false)
    const parser = evalMacroModule<Fused>(t.code, 'parser', {})
    // leaf directly:
    expect(parser.Leaf!('b', 0, {}).value).toEqual({ type: 'WideLeaf' })
    // THROUGH the inherited Parent — the agent claims THIS fails:
    const r = parser.Parent!('b', 0, {})
    expect(r.ok, 'inherited Parent must accept widened leaf b').toBe(true)
    expect(r.value).toEqual({ type: 'Parent', child: { type: 'WideLeaf' } })
  })
})

describe('compose open-recursion: BARE combinator intermediate (css simpleSelectorAtom shape)', () => {
  it('reroutes a widened leaf when the inherited intermediate is a bare choice const, not a node', () => {
    // css: CompoundSelector -> g.simpleSelectorAtom (a bare `choice`, NOT a node) -> g.BasicSelector.
    // Real temp files: the macro build reads the base's carried IR off base.js on disk
    // (as the cross-package jess build does) — a virtual '/pkg/' path has no module to
    // resolve, which falls back to runtime and never exercises the fused reroute.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parseman-openrec-bare-'))
    try {
      const baseT = transformMacro(
        `import { rules, node, regex, choice, oneOrMore, compose } from 'parseman' with { type: 'macro' }
const ws = regex(/[ \\t\\n]*/)
export const base = compose([rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', regex(/[a-z]+/), c => ({ type: 'Leaf', text: c[0]?.value })),
  Atom: choice(g.Leaf),
  Compound: node('Compound', oneOrMore(g.Atom), c => ({ type: 'Compound', kids: [...c] })),
}))])`,
        path.join(dir, 'base.ts'), new Set(['parseman']),
      )!
      expect(baseT.warnings).toEqual([])
      fs.writeFileSync(path.join(dir, 'base.js'), baseT.code)
      const downT = transformMacro(
        `import { rules, node, regex, choice, compose } from 'parseman' with { type: 'macro' }
import { base } from './base.js'
const ws = regex(/[ \\t\\n]*/)
export const parser = compose([base, rules({ trivia: ws }, g => ({
  Leaf: node('Leaf', choice(regex(/[a-z]+/), regex(/%[a-z]+/)), c => ({ type: 'WideLeaf', text: c[0]?.value })),
}))])`,
        path.join(dir, 'down.ts'), new Set(['parseman']),
      )!
      expect(downT.warnings).toEqual([])
      // Fully macro-fused (no runtime compose(), no interpreter fallback).
      expect(/\bcompose\s*\(/.test(downT.code)).toBe(false)
      expect(/_rp\[\d+\]\.parse\(/.test(downT.code)).toBe(false)
      const base = evalMacroExports(baseT.code, {}).base
      const parser = evalMacroModule<Fused>(downT.code, 'parser', { base })
      // The widened leaf must route through the inherited Compound VIA the bare-choice Atom.
      const r = parser.Compound!('%ph foo', 0, {})
      expect(r.ok, 'inherited Compound (via bare-choice Atom) must accept the widened leaf').toBe(true)
      // Control: the un-widened arm still routes through the same inherited parent.
      expect(parser.Compound!('foo bar', 0, {}).ok).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
