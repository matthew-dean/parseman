/**
 * The 0.29.0 first-set fail-fast guards (emitMany / emitNode / emitAttempt in the
 * codegen path) reject a doomed sub-parse on a single code-point check BEFORE
 * allocating collectors / taking rollback marks / swapping the CST context. These
 * tests assert the INTERPRETER now shares those early-exits: on a first-set miss the
 * composite body is never entered — matching the compiled path — while staying
 * byte-identical (the parity suites elsewhere prove interpreter ≡ compiled output).
 */
import { many, oneOrMore, node, attempt, sequence, literal, parse, type Combinator, type ParseContext } from '../../src/index.ts'
import { describe, expect, it } from 'vitest'

/** Wrap a combinator so every `.parse` call is counted, without changing `_meta`. */
function spy<T>(inner: Combinator<T>): { c: Combinator<T>; calls: () => number } {
  let n = 0
  const orig = inner.parse.bind(inner)
  const c: Combinator<T> = { ...inner, parse: (input, pos, ctx) => { n++; return orig(input, pos, ctx) } }
  return { c, calls: () => n }
}

describe('interpreter first-set fail-fast (parity with codegen guards)', () => {
  it('many: does NOT enter the body on a first-set miss at the loop boundary', () => {
    // Body starts with '@' (discrete, non-nullable). Two items match, then 'Y' is a
    // first-set miss → the loop must stop WITHOUT a third body attempt.
    const body = node('Item', sequence(literal('@'), literal('x')), c => c)
    const { c, calls } = spy(body)
    const r = parse(many(c), '@x@xY', { trackLines: false } as ParseContext)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.span.end).toBe(4)        // consumed "@x@x", left "Y"
    expect(calls()).toBe(2)                      // exactly the two matches — miss never entered the body
  })

  it('oneOrMore: same early-exit for subsequent items', () => {
    const body = node('Item', sequence(literal('@'), literal('x')), c => c)
    const { c, calls } = spy(body)
    const r = parse(oneOrMore(c), '@x@xZ', { trackLines: false } as ParseContext)
    expect(r.ok).toBe(true)
    // first item parsed directly (1) + one loop match (2); the 'Z' miss adds none.
    expect(calls()).toBe(2)
  })

  it('node: does NOT allocate the capture frame / enter the body on a first-set miss', () => {
    const inner = sequence(literal('@'), literal('y'))
    const { c, calls } = spy(inner)
    const n = node('Thing', c, ch => ch)
    const r = parse(n, 'z', { trackLines: false } as ParseContext)   // 'z' ∉ first set {'@'}
    expect(r.ok).toBe(false)
    expect(calls()).toBe(0)                      // body never entered
  })

  it('attempt: does NOT take rollback marks / enter the inner on a first-set miss', () => {
    const inner = sequence(literal('@'), literal('z'))
    const { c, calls } = spy(inner)
    const r = parse(attempt(c), 'x', { trackLines: false } as ParseContext)   // 'x' ∉ first set {'@'}
    expect(r.ok).toBe(false)
    expect(calls()).toBe(0)
  })

  it('still enters the body on a first-set HIT (guard is not over-eager)', () => {
    const inner = sequence(literal('@'), literal('y'))
    const { c, calls } = spy(inner)
    const n = node('Thing', c, ch => ch)
    // '@' is in the first set → body IS entered (and here fails on the 2nd char).
    expect(parse(n, '@q', { trackLines: false } as ParseContext).ok).toBe(false)
    expect(calls()).toBe(1)
  })
})
