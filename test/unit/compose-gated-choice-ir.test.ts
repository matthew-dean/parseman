/**
 * Regression: compose OVER a COMPILED base whose grammar contains a GATED choice.
 *
 * A macro-compiled, EXPORTED `rules()` grammar carries a compact, re-lowerable IR
 * form (`{ ns, ir }`) so a downstream package can `compose([base, delta])` and
 * re-lower it under its OWN composing trivia. `serializeRuleMap` produced that IR —
 * but it THREW `Unserializable` for any `choice` containing a gated arm, so the
 * grammar silently fell back to shipping FULL LOWERED PIECES instead.
 *
 * Those baked pieces were lowered at the BASE package's build (its own trivia, its
 * own build/first-set bookkeeping) and are spliced verbatim into the composing
 * grammar's fused closure — which corrupts a SIBLING rule's first-char dispatch
 * (and can reference build helpers that don't exist in the fused scope). Standalone
 * the base parses fine; only compose-of-the-compiled-base breaks.
 *
 * This surfaced in Jess (`compose([cssGrammar, …])`) after 0.26.1 let a gated arm
 * keep O(1) dispatch: gating css's `simpleSelector` `&` arm broke `Declaration`
 * dispatch inside a composed ruleset body. The fix serializes gated arms through
 * their captured `gateSrcs`, so a gated grammar carries IR like any other.
 *
 * Two things the serialized IR must preserve, each its own regression here:
 *   1. The gate PREDICATE (round-trips through `_gch`, which re-attaches gateSrcs),
 *      so the composed grammar dispatches + gates correctly.
 *   2. Static FUSIBILITY. The gate re-lowers from its SOURCE (a static callback),
 *      not a runtime closure — so `emitFusedSource` (the macro's build-time static
 *      fuse) still works. If it doesn't, a downstream `compose()` silently falls
 *      back to a runtime fuse whose combinator consts crash `rules()` (the Jess
 *      `rw`-is-a-function crash). Also exercises a TYPE-ANNOTATED gate (`(s: any)`),
 *      whose TS syntax must be stripped from the IR.
 *
 * RED before the fix (grammar carries PIECES / re-lowers non-static; the composed
 * sibling rule fails to parse) and GREEN after (carries IR, statically fusible;
 * dispatch + gate semantics both intact).
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

// A mini "css": a gated `simpleSelector` (`&` gated on state.inner, exactly the
// css nesting selector) plus a `declarationList` whose block choice must keep
// dispatching `Declaration` for an ident like `color` after composition.
const CSS_SRC = `import { rules, choice, sequence, literal, regex, many, oneOrMore, node } from 'parseman' with { type: 'macro' }
const cst = (type) => (ch, _r, span) => ({ _tag: 'node', type, span, children: [...ch] })
export const cssGrammar = rules(g => ({
  Ruleset: node('Ruleset', sequence(g.SelectorList, literal('{'), g.declarationList, literal('}')), cst('Ruleset')),
  SelectorList: node('SelectorList', oneOrMore(g.simpleSelector), cst('SelectorList')),
  simpleSelector: choice(g.AttributeSelector, { gate: (s: any) => !!(s && s.inner), combinator: literal('&') }, g.BasicSelector),
  AttributeSelector: node('Attr', sequence(literal('['), regex(/[a-z]+/), literal(']')), cst('Attr')),
  BasicSelector: node('Basic', regex(/\\.[a-z]+/), cst('Basic')),
  declarationList: many(choice(g.Declaration, g.Ruleset, literal(';'))),
  Declaration: node('Decl', sequence(regex(/[a-z]+/), literal(':'), regex(/[a-z]+/)), cst('Decl')),
}))`

describe('compose over a compiled base with a gated choice (0.26.2)', () => {
  const mod = buildCompiledGrammar(CSS_SRC)
  const cssGrammar = mod.cssGrammar as Record<string | symbol, unknown>

  it('the compiled gated grammar carries re-lowerable IR, not baked pieces', () => {
    // The load-bearing signal: a gated grammar must round-trip through IR (the
    // path that re-lowers under the composing trivia). RED before the fix — the
    // gated choice made serializeRuleMap() throw, so it shipped full PIECES.
    const carried = cssGrammar[COMPOSED_PIECES] as Array<{ ns: string; ir?: string }>
    expect(Array.isArray(carried)).toBe(true)
    expect(carried.length).toBeGreaterThan(0)
    for (const p of carried) expect(typeof p.ir).toBe('string') // IR, not baked LinkablePieces
  })

  it('the re-lowered gated IR is STATICALLY FUSIBLE (no runtime-only gate closure)', () => {
    // The multi-layer failure mode: re-lowering the gated IR must keep the gate as a
    // static (source-inlined) callback so `emitFusedSource` can fuse it at build. RED
    // before the fix — the gate came back as a runtime closure (`mfFns`), so
    // emitFusedSource threw and the downstream macro compose fell back to a runtime
    // fuse that crashes `rules()`. The `(s: any)` gate also proves TS syntax is
    // stripped: re-lowering runs the IR through `new Function`, where `: any` is a
    // hard parse error.
    const carried = cssGrammar[COMPOSED_PIECES] as Array<{ ns: string; ir: string }>
    const ir = carried.find(p => typeof p.ir === 'string')!.ir
    expect(ir).toContain('_gch') // gated choice serialized through the gate-preserving helper
    const pieces = compileLinkable(evalRuleMapIR(ir), '_relow_')!
    expect(pieces.mfFns.length).toBe(0)   // gate inlined from source, not a runtime closure
    expect(() => emitFusedSource([pieces])).not.toThrow()
  })

  it('standalone: the compiled base parses a ruleset', () => {
    const g = cssGrammar as unknown as Record<string, FusedRule>
    expect(g.Ruleset!('.a{color:red}', 0, {}).ok).toBe(true)
  })

  it('composed: a SIBLING rule (Declaration) still dispatches for an ident', () => {
    // The real jess shape: compose([compiledCss, delta]). RED before the fix —
    // `color` inside the composed ruleset body failed to dispatch to Declaration.
    const delta = parseman.rules(() => ({ Extra: parseman.regex(/z/) }))
    const composed = parseman.compose([
      cssGrammar as never,
      delta as never,
    ]) as unknown as Record<string, FusedRule>
    expect(composed.Ruleset!('.a{color:red}', 0, {}).ok).toBe(true)
  })

  it('composed: the gated `&` arm still gates on state.inner', () => {
    const delta = parseman.rules(() => ({ Extra: parseman.regex(/z/) }))
    const composed = parseman.compose([
      cssGrammar as never,
      delta as never,
    ]) as unknown as Record<string, FusedRule>
    // `&` is rejected without inner state, accepted with it — round-trip preserved
    // the per-arm gate predicate through the IR.
    expect(composed.Ruleset!('&{color:red}', 0, {}).ok).toBe(false)
    expect(composed.Ruleset!('&{color:red}', 0, { state: { inner: true } }).ok).toBe(true)
  })

  it('a gate written with a TS angle-bracket assertion (<T>x) re-lowers to valid JS', () => {
    // The IR string is re-lowered with `new Function`, where a `<any>s` assertion is
    // a hard SyntaxError. stripTsFromSource must remove the PREFIX `<any>` and keep the
    // wrapped expression (unlike an `as`/`satisfies` SUFFIX). Exercises the
    // TSTypeAssertion branch end-to-end.
    const src = `import { rules, choice, sequence, literal, regex, node } from 'parseman' with { type: 'macro' }
const cst = (type) => (ch, _r, span) => ({ _tag: 'node', type, span, children: [...ch] })
export const g2 = rules(g => ({
  Ruleset: node('Ruleset', sequence(g.Sel, literal('{'), literal('}')), cst('Ruleset')),
  Sel: choice({ gate: (s) => !!((<any>s)?.inner), combinator: literal('&') }, regex(/\\.[a-z]+/)),
}))`
    const mod = buildCompiledGrammar(src)
    const g2 = mod.g2 as Record<string | symbol, unknown>
    const carried = g2[COMPOSED_PIECES] as Array<{ ir?: string }>
    const ir = carried.find(p => typeof p.ir === 'string')!.ir!
    expect(ir).not.toContain('<any>') // the TS assertion was stripped from the gate source
    const pieces = compileLinkable(evalRuleMapIR(ir), '_ts_')!
    expect(() => emitFusedSource([pieces])).not.toThrow() // no SyntaxError on re-lower
    // Assert the gate on the RE-LOWERED artifact (compose re-lowers the IR), not the
    // original g2 — a regression that loses/changes the predicate during restoration
    // would only surface here, not on the original grammar.
    const delta = parseman.rules(() => ({ Extra: parseman.regex(/z/) }))
    const composed = parseman.compose([g2 as never, delta as never]) as unknown as Record<string, FusedRule>
    expect(composed.Ruleset!('&{}', 0, {}).ok).toBe(false)                          // gate blocks without inner
    expect(composed.Ruleset!('&{}', 0, { state: { inner: true } }).ok).toBe(true)  // gate passes with inner
  })
})
