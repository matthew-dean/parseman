/**
 * sepByRecover() / manyRecover() — automatic list recovery.
 *
 * A malformed element is skipped to the next separator / terminator and recorded
 * as a ParseError, instead of truncating the list. Verified in both the
 * interpreter and the compiled build (they must agree) — compile() runs the exact
 * codegen the macro build emits, so this is the real cross-mode parity check.
 */
import { describe, it, expect } from 'vitest'
import {
  literal, regex, sequence, transform, parse, compile,
  node, rules, many,
  sepByRecover, manyRecover, isParseError,
} from '../../src/index.ts'
import type { Combinator, ParseError, CSTNode, Span } from '../../src/index.ts'

const num = transform(regex(/[0-9]+/), (s) => Number(s))
const elements = sepByRecover(num, literal(','), literal(']'))
const array = transform(
  sequence(literal('['), elements, literal(']')),
  ([, els]) => els,
)

/** Run a combinator interpreted and compiled; assert values + error spans match. */
function bothWays<T>(p: Combinator<T>, input: string): { value: T; errors: ParseError[] } {
  const interp = parse(p, input, { recover: true })
  const compiled = compile(p).parseWithErrors(input)
  expect(interp.ok).toBe(compiled.ok)
  if (interp.ok && compiled.ok) {
    expect(compiled.value).toEqual(interp.value)
    expect(compiled.errors).toEqual(interp.errors ?? [])
  }
  if (!interp.ok) throw new Error('interpreter parse failed')
  return { value: interp.value, errors: (interp.errors ?? []) as ParseError[] }
}

const errsIn = <T>(value: (T | ParseError)[]): ParseError[] =>
  value.filter((v): v is ParseError => isParseError(v))

describe('sepByRecover()', () => {
  it('parses an all-valid list with no errors', () => {
    const { value, errors } = bothWays(array, '[1,2,3]')
    expect(value).toEqual([1, 2, 3])
    expect(errors).toHaveLength(0)
  })

  it('parses a single element', () => {
    const { value, errors } = bothWays(array, '[42]')
    expect(value).toEqual([42])
    expect(errors).toHaveLength(0)
  })

  it('recovers a missing middle element as a ParseError', () => {
    const { value, errors } = bothWays(array, '[1,,3]')
    expect(value).toHaveLength(3)
    expect(value[0]).toBe(1)
    expect(isParseError(value[1])).toBe(true)
    expect(value[2]).toBe(3)
    expect(errors).toHaveLength(1)
  })

  it('recovers junk between separators and points the span at the junk', () => {
    const { value, errors } = bothWays(array, '[1,xx,3]')
    expect(value).toHaveLength(3)
    expect(isParseError(value[1])).toBe(true)
    expect(errors).toHaveLength(1)
    // "[1,xx,3]" — the junk "xx" occupies offsets 3..5.
    expect(errors[0]!.span).toEqual({ start: 3, end: 5 } satisfies Span)
  })

  it('recovers a malformed first element', () => {
    const { value, errors } = bothWays(array, '[x,2]')
    expect(value).toHaveLength(2)
    expect(isParseError(value[0])).toBe(true)
    expect(value[1]).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.span).toEqual({ start: 1, end: 2 } satisfies Span)
  })

  it('recovers multiple bad elements', () => {
    const { value, errors } = bothWays(array, '[1,,,4]')
    expect(errsIn(value)).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })

  it('recovers a list that is all junk', () => {
    const { value, errors } = bothWays(array, '[a,b,c]')
    expect(value).toHaveLength(3)
    expect(errsIn(value)).toHaveLength(3)
    expect(errors).toHaveLength(3)
  })

  it('treats an empty list as [] with no spurious error', () => {
    const { value, errors } = bothWays(array, '[]')
    expect(value).toEqual([])
    expect(errors).toHaveLength(0)
  })

  it('carries the statically-derived expected set into the error', () => {
    const { errors } = bothWays(array, '[1,,3]')
    expect(errors[0]!.expected).toEqual(['/[0-9]+/'])
  })
})

describe('manyRecover()', () => {
  const letters = manyRecover(regex(/[a-z]/), literal('}'))
  const block = transform(
    sequence(literal('{'), letters, literal('}')),
    ([, ls]) => ls,
  )

  it('parses an all-valid run with no errors', () => {
    const { value, errors } = bothWays(block, '{abc}')
    expect(value).toEqual(['a', 'b', 'c'])
    expect(errors).toHaveLength(0)
  })

  it('parses a single element', () => {
    const { value, errors } = bothWays(block, '{a}')
    expect(value).toEqual(['a'])
    expect(errors).toHaveLength(0)
  })

  it('recovers a junk run up to the terminator', () => {
    const { value, errors } = bothWays(block, '{ab3c}')
    expect(value[0]).toBe('a')
    expect(value[1]).toBe('b')
    expect(isParseError(value[2])).toBe(true)
    expect(errors).toHaveLength(1)
    // No separator to resync on: "3c" is captured as one error up to "}".
    expect(errors[0]!.span).toEqual({ start: 3, end: 5 } satisfies Span)
  })

  it('recovers a block that is entirely junk', () => {
    const { value, errors } = bothWays(block, '{123}')
    expect(value).toHaveLength(1)
    expect(isParseError(value[0])).toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.span).toEqual({ start: 1, end: 4 } satisfies Span)
  })

  it('treats an empty block as [] with no spurious error', () => {
    const { value, errors } = bothWays(block, '{}')
    expect(value).toEqual([])
    expect(errors).toHaveLength(0)
  })
})

describe('recovery inside rules() / node()', () => {
  const mk = (type: string, ch: CSTNode['children'], span: Span): CSTNode =>
    ({ _tag: 'node', type, span, state: null, children: [...ch] })

  // An array node whose elements tolerate malformed entries.
  const { Arr } = rules(g => {
    void g
    const Arr = node(
      'Arr',
      sequence(literal('['), sepByRecover(num, literal(','), literal(']')), literal(']')),
      (ch, _r, span) => mk('Arr', ch as CSTNode['children'], span),
    )
    return { Arr }
  })

  it('recovers inside a node() rule and still builds a CST', () => {
    const interp = parse(Arr, '[1,,3]', { recover: true })
    const compiled = compile(Arr).parseWithErrors('[1,,3]')
    expect(interp.ok).toBe(true)
    expect(compiled.ok).toBe(true)
    if (!interp.ok || !compiled.ok) return
    expect((interp.value as CSTNode).type).toBe('Arr')
    expect(compiled.value).toEqual(interp.value)
    expect((interp.errors ?? []).length).toBe(1)
    expect(compiled.errors).toEqual(interp.errors ?? [])
  })

  it('composes with a plain many() around recovered arrays', () => {
    const list = many(array)
    const { value, errors } = bothWays(list, '[1,,3][4]')
    expect(value).toHaveLength(2)
    expect(errsIn(value[0]!)).toHaveLength(1)
    expect(value[1]).toEqual([4])
    expect(errors).toHaveLength(1)
  })
})
