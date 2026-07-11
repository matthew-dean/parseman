/**
 * IDE integration tests — completions.
 *
 * completionsAt() returning expected tokens at a cursor position. (List error
 * recovery lives in recovery.test.ts.)
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, choice, optional, sepBy, completionsAt,
} from '../../src/index.ts'

const ws = regex(/[ \t]*/)

// ---------------------------------------------------------------------------
// completionsAt()
// ---------------------------------------------------------------------------

describe('completionsAt()', () => {
  // Grammar: comma-separated numbers in brackets: [1, 2, 3]
  const num2  = regex(/[0-9]+/)
  const comma = sequence(optional(ws), literal(','), optional(ws))
  const items = sepBy(num2, comma)
  const bracket = sequence(literal('['), optional(items), literal(']'))

  it('returns number pattern after a trailing comma', () => {
    // '[1,' — user just typed comma, next expected is a number
    const completions = completionsAt(bracket, '[1,', 3)
    expect(completions).toContain('/[0-9]+/')
  })

  it('returns comma or close-bracket after a complete item', () => {
    // '[1' — valid number parsed, next expected: ',' or ']'
    const completions = completionsAt(bracket, '[1', 2)
    expect(completions.length).toBeGreaterThan(0)
    // Either ',' or ']' should be expected
    expect(
      completions.some(c => c === '","' || c === '"]"')
    ).toBe(true)
  })

  it('returns empty array when input is fully valid', () => {
    const completions = completionsAt(bracket, '[1,2]', 5)
    expect(completions).toEqual([])
  })

  it('returns open-bracket as first token from offset 0', () => {
    const completions = completionsAt(bracket, '', 0)
    expect(completions).toContain('"["')
  })

  it('works with a keyword choice grammar', () => {
    const keyword = choice(literal('true'), literal('false'), literal('null'))

    // partial match 'tru' — expected is 'true'
    expect(completionsAt(keyword, 'tru', 3)).toContain('"true"')

    // empty input — all three options expected
    const all = completionsAt(keyword, '', 0)
    expect(all).toContain('"true"')
    expect(all).toContain('"false"')
    expect(all).toContain('"null"')
  })

  it('prefers probe failure deeper than top-level after sepBy backtrack', () => {
    // After `[1,2,` the list wants another number (probe @5) but the outer `]`
    // arm fails earlier (@4) once optional(items) ends — completions must use the probe.
    const completions = completionsAt(bracket, '[1,2,', 5)
    expect(completions).toContain('/[0-9]+/')
    expect(completions).not.toContain('"]"')
  })
})
