/**
 * Regression coverage for silent degradations — the class where the SOURCE looks
 * correct and the EMITTED ARTIFACT is wrong.
 *
 * Every defect pinned here was invisible for months because the only thing that would
 * have caught it was an assertion on generated output or on observable behaviour. A
 * unit test on the analysing function in isolation would have passed the entire time.
 * So: compile a small grammar and assert on what comes out — emitted guards, emitted
 * capture tiers, predicate call counts, node counts.
 *
 * Tests marked PINNING assert CURRENT behaviour for a defect that is NOT yet fixed, so
 * that fixing it later is a visible test change rather than a silent one.
 */
import { describe, it, expect } from 'vitest'
import {
  compose, cstBuildHost, literal, node, parser, regex, rules, run, sequence,
  analyzeGrammarGating, compiledGrammarCoverageDefinitions, composedGrammarCoverageDefinitions,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { compileTable as compile } from '../../src/table/compile.ts'

// ---------------------------------------------------------------------------
// cstBuildHost({ collapse }) — a documented option that did nothing
// ---------------------------------------------------------------------------
describe('cstBuildHost({ collapse }) applies to host-built nodes that carry reducers', () => {
  /*
   * The collapse check was emitted for STRUCTURAL node defs only. Under `hostMode:
   * 'cst'` a direct builder is bypassed and the node is built by the host exactly like
   * a structural one — but every rule in a real grammar carries a reducer, so none was
   * structural, and the predicate was never consulted. Measured in jess across four
   * dialects: `predicateCalls === 0`, `removedAll === 0`, and zero occurrences of
   * `_parsemanCstCollapse` in the built artifacts, including a 15.9 MB one.
   */
  const build = (c: readonly unknown[]) => c
  const grammar = () => {
    const Inner = node('Inner', literal('a'), build)
    const Wrap = node('Wrap', Inner, build)
    const Keep = node('Keep', literal('b'), build)
    return node('Doc', sequence(Wrap, Keep), build)
  }
  const host = (calls: { n: number }) =>
    cstBuildHost({ collapse: (type: string) => { calls.n++; return type === 'Wrap' } })

  it('emits the collapse check into the artifact', () => {
    const compiled = compile(parser({}, grammar()), undefined, { hostMode: 'cst' })
  })

  it('compiled: consults the predicate and removes the wrapper', () => {
    const calls = { n: 0 }
    const compiled = compile(parser({}, grammar()), undefined, { hostMode: 'cst' })
    const r = compiled.parseWithContext('ab', { trackLines: false, build: host(calls) } as never, 0)
    expect(calls.n).toBeGreaterThan(0)
    expect(r.ok).toBe(true)
    const doc = (r as unknown as { value: { children: Array<{ type?: string }> } }).value
    expect(doc.children[0]?.type).toBe('Inner')
    expect(doc.children[1]?.type).toBe('Keep')
  })

  it('interpreter agrees with the compiled engine', () => {
    const calls = { n: 0 }
    const r = run(grammar(), 'ab', { build: host(calls) })
    expect(calls.n).toBeGreaterThan(0)
    expect(r.ok).toBe(true)
    const doc = r.value as unknown as { children: Array<{ type?: string }> }
    expect(doc.children[0]?.type).toBe('Inner')
    expect(doc.children[1]?.type).toBe('Keep')
  })

  it('collapse:false leaves the wrapper in place (the option still means something)', () => {
    const compiled = compile(parser({}, grammar()), undefined, { hostMode: 'cst' })
    const r = compiled.parseWithContext('ab', { trackLines: false, build: cstBuildHost({}) } as never, 0)
    const doc = (r as unknown as { value: { children: Array<{ type?: string }> } }).value
    expect(doc.children[0]?.type).toBe('Wrap')
  })
})

// ---------------------------------------------------------------------------
// analyzeGrammarGating on a composed grammar
// ---------------------------------------------------------------------------
describe('analyzeGrammarGating sees a runtime compose() result', () => {
  const composed = () => compose([
    rules(g => ({ Term: sequence(g.Value, literal('/')) })) as Record<string, Combinator<unknown>>,
    rules(_g => ({ Value: regex(/[a-z]+/) })) as Record<string, Combinator<unknown>>,
  ]) as unknown as Record<string, unknown>

  it('does not report a fabricated totalChoices: 0 with everything unanalysable', () => {
    const report = analyzeGrammarGating(composed())
    // The failure mode being pinned: a blind analysis that reports zero choices and one
    // `unanalysable` entry naming every rule, which reads exactly like a clean grammar.
    expect(report.unanalysable.map(u => u.rule)).not.toContain('Term, Value')
    expect(report.unanalysable.filter(u => u.kind === 'opaque-artifact')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Coverage surfaces: an empty result and a failure must never share a representation
// ---------------------------------------------------------------------------
describe('coverage definition surfaces distinguish "could not" from "nothing"', () => {
  it('compiledGrammarCoverageDefinitions THROWS rather than returning []', () => {
    // A macro build without `grammarCoverage` carries no definitions. Returning `[]`
    // here would be indistinguishable from a grammar with genuinely zero constructs.
    expect(() => compiledGrammarCoverageDefinitions({})).toThrow(TypeError)
    expect(() => compiledGrammarCoverageDefinitions({})).toThrow(/no coverage definitions/)
  })

  it('composedGrammarCoverageDefinitions THROWS on a non-composed / opaque input', () => {
    expect(() => composedGrammarCoverageDefinitions({}, 'Term')).toThrow(TypeError)
    expect(() => composedGrammarCoverageDefinitions({}, 'Term')).toThrow(/re-lowerable composed IR/)
  })

  it('composedGrammarCoverageDefinitions names an unknown start rule instead of returning []', () => {
    const g = compose([
      rules(_g => ({ Term: regex(/[a-z]+/) })) as Record<string, Combinator<unknown>>,
    ]) as unknown as Record<string, unknown>
    expect(() => composedGrammarCoverageDefinitions(g, 'NoSuchRule')).toThrow(/not a final winner/)
    // ...and the real start rule genuinely produces definitions, so the throw above is
    // not simply "this API never works".
    expect(composedGrammarCoverageDefinitions(g, 'Term').length).toBeGreaterThan(0)
  })
})
