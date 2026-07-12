/**
 * Regression: compose OVER a COMPILED base whose grammar contains a `withCtx`.
 *
 * A macro-compiled, EXPORTED `rules()` grammar carries a compact, re-lowerable IR
 * form (`{ ns, ir }`) so a downstream package can `compose([base, delta])` and
 * re-lower it under its OWN composing trivia. `serializeRuleMap` produced that IR —
 * but it THREW `Unserializable` for any `withCtx`, so a grammar using withCtx
 * silently fell back to shipping FULL LOWERED PIECES instead.
 *
 * Those baked pieces were lowered at the BASE package's build (its own build/CST
 * helpers, e.g. a `cst()` closure) and are spliced verbatim into the composing
 * grammar's fused closure — which references build helpers that don't exist in the
 * fused scope (`cst is not defined`) and corrupts sibling dispatch. Standalone the
 * base parses fine; only compose-of-the-compiled-base breaks.
 *
 * This is the withCtx analogue of the 0.26.2 gated-choice-IR bug. The fix
 * round-trips `withCtx` through a dedicated `_wc` helper that rebuilds it AND
 * re-attaches `_def.extraSrc` from the captured `extra`/state source — so the
 * re-lowered withCtx stays STATIC (state inlined from source), `mfFns` stays 0,
 * and `emitFusedSource` succeeds (a downstream compose stays statically fused).
 *
 * RED before the fix (grammar carries PIECES / re-lowers non-static; the composed
 * grammar crashes) and GREEN after (carries IR, statically fusible; dispatch +
 * state semantics both intact).
 */
import { describe, it, expect } from 'vitest'
import * as parseman from '../../src/index.ts'
import type { FusedRule } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { evalRuleMapIR } from '../../src/compiler/ir-serialize.ts'
import { compileLinkable } from '../../src/compiler/codegen.ts'
import { emitFusedSource } from '../../src/compiler/linker.ts'

const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

/** Macro-compile a module exporting `cssGrammar`, then eval it to the live value
 * (which carries its re-lowerable pieces under COMPOSED_PIECES) — mirroring a
 * built, shipped grammar package that a downstream package imports. */
function buildCompiledGrammar(src: string): Record<string, unknown> {
  const out = transformMacro(src, '/pkg/base.ts', new Set(['parseman']))
  if (!out) throw new Error('transformMacro returned null')
  expect(out.warnings).toEqual([])
  const mod: Record<string, unknown> = {}
  const body = out.code
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/export const (\w+)/g, 'mod.$1')
  // eslint-disable-next-line no-new-func
  new Function('mod', ...Object.keys(parseman), body)(mod, ...Object.values(parseman))
  return mod
}

// A mini "css": `declarationList` is wrapped in `withCtx({ inner: true }, …)` so
// the block body parses with `state.inner` set. The block choice must still
// dispatch `Declaration` for an ident like `color` after composition. (State
// SEMANTICS are asserted separately via a direct `_wc` round-trip below — a
// `guard` reader would itself be unserializable and mask the withCtx path.)
const CSS_SRC = `import { rules, choice, sequence, literal, regex, many, oneOrMore, node, withCtx } from 'parseman' with { type: 'macro' }
const cst = (type) => (ch, _r, span) => ({ _tag: 'node', type, span, children: [...ch] })
export const cssGrammar = rules(g => ({
  Ruleset: node('Ruleset', sequence(g.SelectorList, literal('{'), g.declarationList, literal('}')), cst('Ruleset')),
  SelectorList: node('SelectorList', oneOrMore(g.BasicSelector), cst('SelectorList')),
  BasicSelector: node('Basic', regex(/\\.[a-z]+/), cst('Basic')),
  declarationList: withCtx({ inner: true }, many(choice(g.Ruleset, g.Declaration, literal(';')))),
  Declaration: node('Decl', sequence(regex(/[a-z]+/), literal(':'), regex(/[a-z]+/)), cst('Decl')),
}))`

describe('compose over a compiled base with a withCtx (0.26.3)', () => {
  const mod = buildCompiledGrammar(CSS_SRC)
  const cssGrammar = mod.cssGrammar as Record<string | symbol, unknown>

  it('the compiled withCtx grammar carries re-lowerable IR, not baked pieces', () => {
    // RED before the fix — withCtx made serializeRuleMap() throw, so it shipped
    // full PIECES (ir undefined).
    const carried = cssGrammar[COMPOSED_PIECES] as Array<{ ns: string; ir?: string }>
    expect(Array.isArray(carried)).toBe(true)
    expect(carried.length).toBeGreaterThan(0)
    for (const p of carried) expect(typeof p.ir).toBe('string')
  })

  it('the re-lowered withCtx IR is STATICALLY FUSIBLE (no runtime-only state closure)', () => {
    // RED before the fix — re-lowering brought the state back as a source-less
    // runtime closure (`mfFns`), so emitFusedSource threw and a downstream macro
    // compose fell back to a runtime fuse.
    const carried = cssGrammar[COMPOSED_PIECES] as Array<{ ns: string; ir: string }>
    const ir = carried.find(p => typeof p.ir === 'string')!.ir
    expect(ir).toContain('_wc') // withCtx serialized through the state-preserving helper
    const pieces = compileLinkable(evalRuleMapIR(ir), '_relow_')!
    expect(pieces.mfFns.length).toBe(0)   // state inlined from source, not a runtime closure
    expect(() => emitFusedSource([pieces])).not.toThrow()
  })

  it('standalone: the compiled base parses a ruleset', () => {
    const g = cssGrammar as unknown as Record<string, FusedRule>
    expect(g.Ruleset!('.a{color:red}', 0, {}).ok).toBe(true)
  })

  it('composed: a SIBLING rule (Declaration) still dispatches for an ident', () => {
    // The real jess shape: compose([compiledCss, delta]). RED before the fix —
    // the baked pieces referenced the base `cst` helper (`cst is not defined`) and
    // corrupted dispatch inside the composed ruleset body.
    const delta = parseman.rules(() => ({ Extra: parseman.withCtx({ z: 1 }, parseman.regex(/z/)) }))
    const composed = parseman.compose([
      cssGrammar as never,
      delta as never,
    ]) as unknown as Record<string, FusedRule>
    expect(composed.Ruleset!('.a{color:red}', 0, {}).ok).toBe(true)
  })

  it('the withCtx STATE round-trips through `_wc` (extra re-evaluated + extraSrc restored)', () => {
    // Re-lower a minimal IR that uses `_wc` and assert the reconstructed withCtx
    // carries BOTH the live `extra` value (eval'd from source, for interpreted mode)
    // AND the captured `extraSrc` (so codegen can re-inline it statically). A
    // regression that drops the source would re-lower to a runtime-only closure.
    const ir = `rules((g) => ({ "R": _wc("{ inner: true, depth: 2 }", regex("x", "")) }))`
    const map = evalRuleMapIR(ir)
    const [, wc] = map.find(([name]) => name === 'R')!
    const def = wc._def as { tag: string; extra?: unknown; extraSrc?: string }
    expect(def.tag).toBe('withCtx')
    expect(def.extra).toEqual({ inner: true, depth: 2 })   // extra re-evaluated from source
    expect(def.extraSrc).toBe('{ inner: true, depth: 2 }') // source restored → statically re-inlinable
  })
})
