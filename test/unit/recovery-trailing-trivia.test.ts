/**
 * Regression (PR #24 review, P1): in tolerant mode, ambient trivia sitting between
 * the last good element and the list's inferred sync token must NOT be swallowed
 * into a spurious ParseError. The recovery guard has to check the sync at the
 * POST-trivia position where the element actually failed, not the pre-trivia cursor.
 */
import { describe, it, expect } from 'vitest'
import { run, sequence, literal, many, oneOrMore, regex, trivia, rules } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n]+/))
const num = regex(/[0-9]+/)

describe('tolerant recovery — trailing trivia before the sync token (PR #24 P1)', () => {
  it('many: valid input with trailing space before the closer yields no error', () => {
    const g = rules({ trivia: ws }, (self: { block: Combinator<unknown> }) => ({
      block: sequence(literal('{'), many(num), literal('}')),
    }))
    const r = run(g.block, '{ 1 2 }', { tolerant: true })
    expect(r.ok).toBe(true)
    expect(r.errors).toHaveLength(0) // was: spurious ParseError over the trailing space
  })

  it('oneOrMore: same, no spurious error on trailing trivia', () => {
    const g = rules({ trivia: ws }, (self: { block: Combinator<unknown> }) => ({
      block: sequence(literal('{'), oneOrMore(num), literal('}')),
    }))
    expect(run(g.block, '{ 1 2 }', { tolerant: true }).errors).toHaveLength(0)
  })

  it('genuine junk still recovers, and the error span excludes the leading trivia', () => {
    const g = rules({ trivia: ws }, (self: { block: Combinator<unknown> }) => ({
      block: sequence(literal('{'), many(num), literal('}')),
    }))
    const r = run(g.block, '{ 1 @@ 2 }', { tolerant: true })
    expect(r.errors).toHaveLength(1)
    // The recovered error STARTS at the junk (offset 4), NOT the leading space at 3
    // — that's the P1 fix. (A plain `many` has no separator to resync on, so it
    // scans to the enclosing `}` sync; the end covering the rest is expected.)
    expect(r.errors[0]!.span.start).toBe(4)
  })
})
