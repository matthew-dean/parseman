import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, optional, sepBy, choice, guard, scanTo, completionsAt,
} from '../../src/index.ts'

describe('completionsAt()', () => {
  const num = regex(/[0-9]+/)
  const comma = literal(',')
  const items = sepBy(num, comma)
  const bracket = sequence(literal('['), optional(items), literal(']'))

  it('uses top-level failure when probe recorded nothing (guard combinator)', () => {
    expect(completionsAt(guard(() => false), '', 0)).toEqual(['guard'])
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
})
