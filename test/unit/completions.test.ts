import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, optional, sepBy, choice, gate, scanTo, completionsAt, peek, not,
} from '../../src/index.ts'
import type { ParseContext, ParseFail } from '../../src/index.ts'

describe('completionsAt()', () => {
  const num = regex(/[0-9]+/)
  const comma = literal(',')
  const items = sepBy(num, comma)
  const bracket = sequence(literal('['), optional(items), literal(']'))

  it('uses top-level failure when probe recorded nothing (gate combinator)', () => {
    expect(completionsAt(gate(() => false), '', 0)).toEqual(['gate'])
  })

  it('prefers probe failure deeper than top-level after sepBy backtrack', () => {
    const completions = completionsAt(bracket, '[1,2,', 5)
    expect(completions).toContain('/[0-9]+/')
    expect(completions).not.toContain('"]"')
  })

  it('uses scanTo failure span when sentinel is missing at EOF', () => {
    expect(completionsAt(scanTo(literal(';')), 'abc', 3)).toContain('";"')
  })

  it('prefers top-level failure when it is deeper than probe-recorded failures', () => {
    // scanTo fails with span.end past the start; probe only sees literal-level fails.
    const completions = completionsAt(scanTo(literal(';')), 'ab', 2)
    expect(completions).toContain('";"')
  })

  it('returns keyword options from a choice grammar', () => {
    const keyword = choice(literal('true'), literal('false'), literal('null'))
    expect(completionsAt(keyword, 'tru', 3)).toContain('"true"')
  })

  it('returns an empty list when the prefix already parses', () => {
    expect(completionsAt(literal('abc'), 'abc', 3)).toEqual([])
  })

  // A zero-width lookahead consumes nothing on EITHER outcome and must leave no
  // observable trace. `_probe` is observable — `failAt` records into it — so a
  // failure raised INSIDE the probe would otherwise be offered as a completion
  // even though no input can reach it there. `_probe` is deliberately NOT part of
  // the shared trivia rollback: a failed choice arm or sequence term SHOULD keep
  // its contribution, since merging cursor-level expectations is how the set is
  // built. The lookaheads are the exception.
  it('peek() leaves the completions probe untouched on BOTH outcomes', () => {
    for (const [label, input] of [['inner fails', 'ab'], ['inner matches', 'azzz']] as const) {
      const probe: { offset: number; best: ParseFail | null } = { offset: 10, best: null }
      const ctx = { trackLines: false, _probe: probe } as unknown as ParseContext
      const la = peek(sequence(literal('a'), literal('zzz')))
      const r = la.parse(input, 0, ctx)
      expect(r.span, `${label}: zero-width`).toEqual({ start: 0, end: 0 })
      expect(probe.best, `${label}: probe must be untouched`).toBe(null)
    }
  })

  it('not() leaves the completions probe untouched on BOTH outcomes', () => {
    // Identical contract to peek() above — both are zero-width predicates, so both
    // restore `_probe`. `not` reaches it through the same `rollbackLookahead`.
    for (const [label, input] of [['inner fails', 'ab'], ['inner matches', 'azzz']] as const) {
      const probe: { offset: number; best: ParseFail | null } = { offset: 10, best: null }
      const ctx = { trackLines: false, _probe: probe } as unknown as ParseContext
      const r = not(sequence(literal('a'), literal('zzz'))).parse(input, 0, ctx)
      expect(r.span, `${label}: zero-width`).toEqual({ start: 0, end: 0 })
      expect(probe.best, `${label}: probe must be untouched`).toBe(null)
    }
  })

  it('a failed peek() does not offer its inner expectations as completions', () => {
    // `"zzz"` is reachable ONLY behind the lookahead, which fails here — so the
    // completion set at the cursor must be the real arm's, not the probe's.
    const g = choice(sequence(peek(sequence(literal('a'), literal('zzz'))), literal('a')), literal('ab'))
    expect(completionsAt(g, 'a', 1)).not.toContain('"zzz"')
  })
})
