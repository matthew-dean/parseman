/**
 * The 0.29.0 first-set fail-fast guards (emitMany / emitNode / emitAttempt in the
 * codegen path) reject a doomed sub-parse on a single code-point check BEFORE
 * allocating collectors / taking rollback marks / swapping the CST context. These
 * tests assert the INTERPRETER now shares those early-exits: on a first-set miss the
 * composite body is never entered — matching the compiled path — while staying
 * byte-identical (the parity suites elsewhere prove interpreter ≡ compiled output).
 */
import { many, oneOrMore, node, attempt, sequence, literal, optional, not, choice, ref, field, withCtx, skip, expect as required, parse, compile, type Combinator, type ParseContext } from '../../src/index.ts'
import { deriveExpected } from '../../src/combinators/expect.ts'
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

/**
 * A first-set-miss fast-fail must report the SAME `expected` a normal start-failure
 * would — including through delegating wrappers (`field`/`withCtx`/`skip`/`expect`)
 * that `deriveExpected` previously omitted (returning the wrapper tag instead of the
 * real leading token). The guard's synthetic `expected` is read identically by the
 * interpreter and by codegen (emitAttempt/emitNode via armStaticExpected → the same
 * `deriveExpected`), so this asserts BOTH modes match the normal failure.
 */
describe('first-set-miss failure is wrapper-complete (guard == normal start-failure)', () => {
  const bodies: [string, Combinator<unknown>][] = [
    ['field',   field('x', sequence(literal('@'), literal('b')))],
    ['withCtx', withCtx({}, sequence(literal('@'), literal('b')))],
    ['skip',    skip(sequence(literal('@'), literal('b')), literal('!'))],
  ]

  for (const [name, body] of bodies) {
    it(`${name}: attempt & node first-char miss report '@' in interpreter AND compiled`, () => {
      // Baseline: the body parsed on its own fails at the first char with the token.
      const normal = parse(body, 'z', { trackLines: false } as ParseContext)
      expect(normal.ok).toBe(false)
      const want = (normal as { expected: string[] }).expected
      expect(want).toEqual(['"@"'])

      for (const guarded of [attempt(body), node('N', body, (c: unknown) => c)]) {
        const ri = parse(guarded, 'z', { trackLines: false } as ParseContext)
        expect(ri.ok).toBe(false)
        expect((ri as { expected: string[] }).expected).toEqual(want)

        const rc = compile(guarded).parse('z', 0) as { ok: boolean; expected?: string[] }
        expect(rc.ok).toBe(false)
        expect(rc.expected).toEqual(want)
      }
    })
  }

  it('deriveExpected sees through field/withCtx/skip/expect (previously the wrapper tag)', () => {
    expect(deriveExpected(field('x', literal('@')))).toEqual(['"@"'])
    expect(deriveExpected(withCtx({}, literal('@')))).toEqual(['"@"'])
    expect(deriveExpected(skip(literal('@'), literal('!')))).toEqual(['"@"'])
    expect(deriveExpected(required(literal('@')))).toEqual(['"@"'])
  })
})

/**
 * A NULLABLE leading term means term 0 is not the only one that can fail first.
 * `deriveExpected` used to stop at term 0 regardless, so `sequence(optional('@'), 'x')`
 * guarded behind `attempt`/`node` reported `"@"` on input 'z' — a token the parse never
 * requires — while the same body parsed directly reports `"x"`. Both engines read the
 * one `deriveExpected`, so both were identically wrong; these assert both, so a fix
 * reaching only one of them fails here.
 */
describe('first-set-miss failure derives through a nullable prefix', () => {
  const body = sequence(optional(literal('@')), literal('x'))

  it('deriveExpected unions the nullable prefix, then stops at the required term', () => {
    // '@' is reachable (the optional may match) and so is 'x' (it may not) — but the
    // union STOPS at the required 'x'; a term after it can never fail first.
    expect(deriveExpected(body)).toEqual(['"@"', '"x"'])
    expect(deriveExpected(sequence(optional(literal('@')), literal('x'), literal('y')))).toEqual(['"@"', '"x"'])
    // Non-nullable term 0 is unchanged — term 1 is not reachable as a first failure.
    expect(deriveExpected(sequence(literal('@'), literal('x')))).toEqual(['"@"'])
    // A leading `not(…)` is zero-width: nullable, but contributes no expected token.
    expect(deriveExpected(sequence(not(literal('!')), literal('x')))).toEqual(['"x"'])
  })

  it('a recursive rule behind the nullable prefix terminates, and derives minimally', () => {
    // Deriving through the nullable prefix newly REACHES the self-reference that
    // term-0-only derivation stopped short of. Without a cycle guard this recursed to
    // the stack limit — and did not even crash: the `lazy` arm's own try/catch swallowed
    // the RangeError, returning ~1000 duplicated entries as the "expected" set.
    const list = ref<unknown>()
    list.define(choice(literal('end'), sequence(optional(literal('i')), list)))
    expect(deriveExpected(list)).toEqual(['"end"', '"i"'])

    // Mutual recursion, each hop behind its own nullable prefix.
    const a = ref<unknown>(), b = ref<unknown>()
    a.define(choice(literal('a'), sequence(optional(literal('x')), b)))
    b.define(choice(literal('b'), sequence(optional(literal('y')), a)))
    expect(deriveExpected(a)).toEqual(['"a"', '"x"', '"b"', '"y"'])

    // The guard is an in-progress stack, not a visited set: a rule referenced twice
    // NON-cyclically must still contribute both times.
    const leaf = ref<unknown>()
    leaf.define(literal('L'))
    expect(deriveExpected(choice(leaf, leaf))).toEqual(['"L"', '"L"'])
  })

  it('attempt & node no longer name a token the parse does not require — both engines', () => {
    // Baseline: parsed directly the sequence skips the optional and fails wanting 'x'.
    const normal = parse(body, 'z', { trackLines: false } as ParseContext)
    expect(normal.ok).toBe(false)
    expect((normal as { expected: string[] }).expected).toEqual(['"x"'])

    for (const guarded of [attempt(body), node('N', body, (c: unknown) => c)]) {
      const ri = parse(guarded, 'z', { trackLines: false } as ParseContext)
      expect(ri.ok).toBe(false)
      const gi = (ri as { expected: string[] }).expected
      // The static guard cannot know the optional would be skipped, so it names the
      // whole candidate set — but it must CONTAIN the token the run actually wanted,
      // which is exactly what stopping at term 0 got wrong.
      expect(gi).toEqual(['"@"', '"x"'])
      expect(gi).toContain('"x"')

      const rc = compile(guarded).parse('z', 0) as { ok: boolean; expected?: string[] }
      expect(rc.ok).toBe(false)
      expect(rc.expected).toEqual(gi)
    }
  })
})
