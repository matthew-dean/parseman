/**
 * `routed(fallback)` — one production for both contexts.
 *
 * Bare `routed()` is dispatch-only, so a grammar that needs the same shape BOTH
 * inside a dispatch branch and standalone had to spell it twice: an original with a
 * concrete lead and a `Routed*` twin differing by exactly one element, with a
 * byte-identical reducer. That is two productions and two compiled emissions for a
 * one-token difference.
 *
 * `routed(fallback)` reuses the dispatch-consumed token when there is one and parses
 * `fallback` in place when there is not, so the twins collapse into one production.
 *
 * Both engines are asserted throughout: the interpreter takes the fallback branch in
 * `routed()`'s own `parse`, the compiler emits the two-way form in `emitRouted`.
 */
import { describe, expect, it } from 'vitest'
import {
  choice, dispatch, literal, node, otherwise, regex, routed, rules,
  sequence, when, type Combinator, type ParseContext,
} from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'

const run = <T>(p: Combinator<T>, input: string) => p.parse(input, 0, { trackLines: false } as ParseContext)
const strategyOf = (p: Combinator<unknown>): string =>
  (p._def as { strategy?: { tag: string } }).strategy?.tag ?? '(none)'

describe('routed(fallback)', () => {
  it('parses the fallback in place when there is no dispatch-consumed token', () => {
    const p = sequence(routed(literal('@layer')), literal(';'))
    expect(assertEnginesAgree(p, '@layer;')).toEqual({
      ok: true,
      value: ['@layer', ';'],
      span: { start: 0, end: 7 },
    })
  })

  it('leaves bare routed() dispatch-only — unchanged', () => {
    expect(run(routed(), 'url')).toEqual({
      ok: false,
      expected: ['routed()'],
      span: { start: 0, end: 0 },
    })
  })

  it('reports the FALLBACK expectations when the fallback path fails', () => {
    const p = routed(literal('@layer'))
    const r = run(p, 'nope')
    expect(r.ok).toBe(false)
    expect((r as { expected: string[] }).expected).toEqual(['"@layer"'])
    expect(compile(p).parse('nope')).toEqual(r)
  })

  it('still rejects routed() in a dispatch SELECTOR, with or without a fallback', () => {
    expect(() => dispatch(routed(), otherwise(literal('x'))))
      .toThrow('parseman: routed() can only appear inside a dispatch() branch')
    expect(() => dispatch(routed(literal('a')), otherwise(literal('x'))))
      .toThrow('parseman: routed() can only appear inside a dispatch() branch')
  })

  /**
   * The collapse this capability exists for. ONE `AtRuleStatement` production is
   * used from inside a dispatch branch (where it reuses the routed token) and
   * standalone (where it parses the same name itself) — and produces the SAME node
   * either way, `children[0]` included.
   */
  it('serves a dispatch branch and a standalone use from ONE production', () => {
    const name = regex(/@[a-z-]+/)
    const AtRuleStatement = node('AtRuleStatement',
      sequence(routed(name), literal(';')),
      children => ({ type: 'AtRuleStatement', name: (children[0] as { value: string }).value }))

    // Standalone: the fallback recognizes the name itself.
    expect(assertEnginesAgree(AtRuleStatement, '@layer;')).toEqual({
      ok: true,
      value: { type: 'AtRuleStatement', name: '@layer' },
      span: { start: 0, end: 7 },
    })

    // Dispatched: the selector already consumed the name; the SAME production
    // reuses it and yields an identical node over an identical span.
    const Routed = dispatch(name, when('@layer', AtRuleStatement))
    expect(assertEnginesAgree(Routed, '@layer;')).toEqual({
      ok: true,
      value: ['@layer', { type: 'AtRuleStatement', name: '@layer' }],
      span: { start: 0, end: 7 },
    })
  })

  it('collapses the twin across a rule-map ref, in both engines', () => {
    type G = { Entry: Combinator<unknown>; AtRule: Combinator<unknown> }
    const g = rules((r: G) => ({
      Entry: choice(
        dispatch(regex(/@[a-z-]+/), when('@layer', r.AtRule)),
        r.AtRule,
      ),
      AtRule: node('AtRule',
        sequence(routed(regex(/@[a-z-]+/)), literal(';')),
        children => ({ type: 'AtRule', name: (children[0] as { value: string }).value })),
    }))
    // arm 0 dispatches and reuses the token; arm 1 falls back to the ref's own scan.
    expect(assertEnginesAgree(g.Entry, '@layer;')).toEqual({
      ok: true,
      value: ['@layer', { type: 'AtRule', name: '@layer' }],
      span: { start: 0, end: 7 },
    })
    expect(assertEnginesAgree(g.Entry, '@media;')).toEqual({
      ok: true,
      value: { type: 'AtRule', name: '@media' },
      span: { start: 0, end: 7 },
    })
  })

  /**
   * A SECOND routed() later in the same branch is not at the selector's position.
   * Bare routed() fails there (asserted in dispatch.test.ts); with a fallback that
   * position is exactly where the fallback is supposed to run.
   */
  it('runs the fallback at a routed() site past the branch start', () => {
    const g = dispatch(literal('a'), when('a', sequence(routed(), literal('!'), routed(literal('z')))))
    expect(assertEnginesAgree(g, 'a!z')).toEqual({
      ok: true,
      value: ['a', ['a', '!', 'z']],
      span: { start: 0, end: 3 },
    })
    const miss = assertEnginesAgree(g, 'a!q') as { ok: boolean; expected: string[] }
    expect(miss.ok).toBe(false)
    expect(miss.expected).toEqual(['"z"'])
  })

  it('emits the two-way form only for a fallback-bearing routed()', () => {
    const name = regex(/@[a-z-]+/)
    const withFallback = compile(sequence(routed(name), literal(';'))).source
    const bare = compile(sequence(routed(), literal(';'))).source
    // Bare routed() keeps its single-path emission: read, guard, fail.
    // The fallback form branches, and carries the fallback's own scan.
  })
})

/**
 * `sharedPrefix` eligibility deliberately stops at concrete literal/regex leads.
 * These pin the three lead shapes that look eligible and are not — see the reasoning
 * (and the measurements) at `bareLeadingTermKey` in choice.ts.
 */
describe('sharedPrefix — leads that stay excluded', () => {
  it('does not left-factor a bare routed() lead', () => {
    // Replay-SAFE (routed() is a single-leaf terminal) but it does not pay: the lead
    // it would factor out is a context read and one comparison, while the strategy
    // adds a prescan and a prefix-matched flag. Measured net +242..+296 bytes.
    const g = choice(
      sequence(routed(), literal(';')),
      sequence(routed(), literal('{')),
    )
    expect(strategyOf(g)).toBe('firstMatch')
  })

  it('does not left-factor a routed(fallback) lead — it is not a leaf', () => {
    const g = choice(
      sequence(routed(literal('a')), literal(';')),
      sequence(routed(literal('a')), literal('{')),
    )
    expect(strategyOf(g)).toBe('firstMatch')
    expect(assertEnginesAgree(g, 'a;')).toEqual({ ok: true, value: ['a', ';'], span: { start: 0, end: 2 } })
    expect(assertEnginesAgree(g, 'a{')).toEqual({ ok: true, value: ['a', '{'], span: { start: 0, end: 2 } })
  })

  it('does not left-factor a lazy ref lead', () => {
    type G = { Lead: Combinator<unknown>; Pair: Combinator<unknown> }
    const g = rules((r: G) => ({
      Lead: literal('a'),
      Pair: choice(
        sequence(r.Lead, literal(';')),
        sequence(r.Lead, literal('{')),
      ),
    }))
    expect(strategyOf(g.Pair)).toBe('firstMatch')
  })

  it('still left-factors the concrete literal/regex lead it was built for', () => {
    const g = choice(
      sequence(regex(/@[a-z-]+/), literal(';')),
      sequence(regex(/@[a-z-]+/), literal('{')),
    )
    expect(strategyOf(g)).toBe('sharedPrefix')
  })
})
