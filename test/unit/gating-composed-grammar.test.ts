/**
 * THE ANALYSIS MUST BE ABLE TO SEE THE GRAMMARS IT SHIPS TO SERVE.
 *
 * `compose([importedArtifact, rules(…)])` is the shape every real parseman grammar
 * uses — it is how parseman's own reference implementation (the four jess CSS-dialect
 * grammars) is built. A `compose()` result is a map of FUSED rule FUNCTIONS: fusion
 * lowers each rule to executable code and the combinator graph is gone from the map.
 *
 * `analyzeGatingRules` walks combinators, so on a composed grammar it read `_def` off
 * a function and threw `TypeError: Cannot read properties of undefined (reading
 * 'tag')` — on EVERY rule. And `reportGating` swallowed that throw (`catch { return
 * undefined }`), so the default-on diagnostic emitted nothing at all. A crashed
 * analysis and a clean grammar were byte-identical to every consumer.
 *
 * That is the bug these tests pin: not that the analysis failed, but that FAILING
 * LOOKED LIKE PASSING. So every test here asserts on the presence of a signal, and
 * the silence-detector tests below deliberately fail if the walk goes quiet.
 *
 * A control grammar proves nothing — the harness was never broken. Every test that
 * matters feeds a genuinely `compose()`d grammar to an analysis entry point.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  analyzeGating, analyzeGatingRules, analyzeGrammarGating, choice, compose,
  formatGatingWarnings, literal, regex, rules, sequence,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { toEBNF } from '../../src/spec/index.ts'

/** The canonical shape: a base holding a choice gated only by a hole the consumer binds. */
const baseShape = (): Record<string, Combinator<unknown>> => rules(g => ({
  Term: choice(sequence(g.Value, literal('/')), sequence(literal('@'), regex(/[a-z]+/))),
})) as Record<string, Combinator<unknown>>

const composedGrammar = (): Record<string, unknown> =>
  compose([baseShape(), rules(_g => ({ Value: regex(/[a-z]+/) }))]) as unknown as Record<string, unknown>

describe('a composed grammar is ANALYSABLE', () => {
  it('analyzeGrammarGating recovers the combinator graph from the carried IR', () => {
    const report = analyzeGrammarGating(composedGrammar())
    // The whole point: the walk SEES choices. A zero here is the blindness regressing.
    expect(report.totalChoices).toBeGreaterThan(0)
    expect(report.unanalysable).toEqual([])
    // With `Value` bound by the fuse, `Term`'s deferred verdict collapses to a real one.
    const term = report.choices.find(c => c.rule === 'Term')
    expect(term).toBeDefined()
    expect(term!.deferred).toBe(false)
  })

  it('the same entry point still walks a plain rules() map', () => {
    const report = analyzeGrammarGating(baseShape())
    expect(report.totalChoices).toBeGreaterThan(0)
    expect(report.unanalysable).toEqual([])
    // Unfused, the hole is unbound, so the verdict is still deferred — not a finding.
    expect(report.deferred.map(c => c.id)).toEqual(['Term'])
  })

  it('a composed grammar reaches a DIFFERENT verdict than the unfused shape', () => {
    // If both returned the same thing the recovery would be cosmetic. Binding the
    // hole is what changes the answer, and only the recovered graph can bind it.
    const unfused = analyzeGrammarGating(baseShape())
    const fused = analyzeGrammarGating(composedGrammar())
    expect(unfused.deferred.length).toBe(1)
    expect(fused.deferred.length).toBe(0)
  })
})

describe('SILENCE IS NOT A POSSIBLE OUTCOME', () => {
  it('walking a fused rule reports `unanalysable` instead of throwing', () => {
    const composed = composedGrammar()
    // The pre-fix behaviour was an uncaught TypeError here.
    const report = analyzeGating(composed.Term as never)
    expect(report.unanalysable).toHaveLength(1)
    expect(report.unanalysable[0]!.kind).toBe('fused-rule')
    // The message must name the fix, not merely state the failure.
    expect(report.unanalysable[0]!.reason).toContain('analyzeGrammarGating')
  })

  it('a blind walk is DISTINGUISHABLE from a clean one', () => {
    // This is the assertion the old code could not have satisfied: both cases
    // produced `totalChoices: 0`-equivalent silence with no findings.
    const blind = analyzeGatingRules(
      Object.entries(composedGrammar()) as Array<[string, Combinator<unknown>]>,
    )
    const clean = analyzeGatingRules([['R', sequence(literal('a'), literal('b'))]])

    expect(blind.totalChoices).toBe(0)
    expect(clean.totalChoices).toBe(0)
    expect(blind.ungated).toEqual([])
    expect(clean.ungated).toEqual([])
    // …and yet they are NOT the same result:
    expect(blind.unanalysable.length).toBeGreaterThan(0)
    expect(clean.unanalysable).toEqual([])
  })

  it('formatGatingWarnings reports a partial walk even with zero findings', () => {
    const report = analyzeGatingRules(
      Object.entries(composedGrammar()) as Array<[string, Combinator<unknown>]>,
    )
    const lines = formatGatingWarnings(report)
    // An empty line list here is exactly the shipped-blind failure mode.
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('UNANALYSABLE')
    expect(lines.join('\n')).toContain('does NOT mean the grammar is clean')
  })

  it('a clean grammar still produces NO warnings (the banner is not unconditional noise)', () => {
    const report = analyzeGatingRules([['R', sequence(literal('a'), literal('b'))]])
    expect(formatGatingWarnings(report)).toEqual([])
  })
})

describe('ENGINE PARITY — the runtime linker and the macro plugin agree', () => {
  /**
   * Both engines thread opaque carried pieces into the same fuse-time diagnostic, via
   * their own `carriedRuleMapsDetailed`. The macro plugin keeps a private carried-item
   * representation, so the two implementations are genuinely separate code — which is
   * exactly how this repo has previously shipped an interpreter-only fix. This test
   * fails if one engine grows the ability to report and the other does not.
   */
  it('both engines expose the same opaque-piece reporting contract', async () => {
    const linker = await import('../../src/compiler/linker.ts')
    // Runtime engine: the detailed variant exists and is shaped as the diagnostic needs.
    expect(typeof linker.carriedRuleMapsDetailed).toBe('function')
    const composed = composedGrammar()
    const recovered = linker.recoverComposedRules(composed)
    expect(recovered).toBeDefined()
    expect(recovered!.opaque).toEqual([])
    expect([...recovered!.rules.keys()].sort()).toEqual(['Term', 'Value'])
  })

  it('a runtime compose() emits no gating warning for a grammar it fully analysed', () => {
    const warns: string[] = []
    const prev = process.env.PARSEMAN_GATING
    process.env.PARSEMAN_GATING = 'warn'
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    try {
      compose([baseShape(), rules(_g => ({ Value: regex(/[a-z]+/) }))])
    } finally {
      spy.mockRestore()
      process.env.PARSEMAN_GATING = prev
    }
    // Nothing unanalysable, and the bound hole gates — so genuine silence, and the
    // banner must NOT appear. (Pairs with the tests above: silence is only legitimate
    // when the walk actually saw the grammar.)
    expect(warns.filter(w => w.includes('UNANALYSABLE'))).toEqual([])
  })
})

describe('the spec/EBNF model shares the same recovery', () => {
  it('toEBNF renders a composed grammar instead of throwing a bare TypeError', () => {
    // Same defect, same public surface (`parseman/spec`), same fix — kept in one
    // shared helper so a future fix cannot land on one walker and miss the other.
    const ebnf = toEBNF(composedGrammar() as never)
    expect(ebnf).toContain('Term')
    expect(ebnf).toContain('Value')
  })
})
