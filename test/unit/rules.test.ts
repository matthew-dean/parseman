/**
 * Tests for parser() — the transparent recursion combinator.
 *
 * parser() takes a factory that receives all rule names as parser references
 * and returns a record of parser definitions. It handles forward declarations
 * (via ref() internally) so the user never has to think about recursion order.
 */
import { describe, it, expect } from 'vitest'
import {
  parser, literal, regex, choice, sequence, transform, optional, sepBy, many,
  trivia, parse,
  type Combinator,
} from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Basic: single recursive rule
// ---------------------------------------------------------------------------

describe('parser() — single recursive rule', () => {
  // Nested parentheses: '()', '(())', '((()))' ...
  type Nested = { type: 'empty' } | { type: 'nested'; inner: Nested }

  const { nested } = parser<{ nested: Combinator<Nested> }>(g => ({
    nested: choice(
      transform(
        sequence(literal('('), g.nested as Combinator<Nested>, literal(')')),
        ([, inner]) => ({ type: 'nested' as const, inner })
      ),
      transform(literal('()'), () => ({ type: 'empty' as const })),
    ),
  }))

  it('matches empty parens', () => {
    const r = parse(nested, '()')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ type: 'empty' })
  })

  it('matches one level of nesting', () => {
    const r = parse(nested, '(())')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ type: 'nested', inner: { type: 'empty' } })
  })

  it('matches two levels of nesting', () => {
    const r = parse(nested, '((()))')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        type: 'nested',
        inner: { type: 'nested', inner: { type: 'empty' } },
      })
    }
  })

  it('fails on mismatched parens', () => {
    expect(parse(nested, '(').ok).toBe(false)
    expect(parse(nested, ')').ok).toBe(false)
    expect(parse(nested, '(()').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutual recursion: two parser that reference each other
// ---------------------------------------------------------------------------

describe('parser() — mutual recursion', () => {
  // Simple arithmetic: expr = term ('+' term)*
  //                   term = num | '(' expr ')'
  type Expr = number | { op: '+'; left: Expr; right: Expr }

  const ws = trivia(regex(/\s*/))
  const num = transform(regex(/[0-9]+/), s => parseInt(s, 10))

  const { expr } = parser<{ expr: Combinator<Expr>; term: Combinator<Expr> }>(g => ({
    expr: transform(
      sequence(g.term as Combinator<Expr>, many(sequence(literal('+'), g.term as Combinator<Expr>))),
      ([first, rest]) =>
        rest.reduce((acc: Expr, [, right]: [string, Expr]) => ({ op: '+' as const, left: acc, right }), first)
    ),
    term: choice(
      transform(
        sequence(literal('('), g.expr as Combinator<Expr>, literal(')')),
        ([, e]) => e
      ),
      num,
    ),
  }))

  it('parses a single number', () => {
    const r = parse(expr, '42')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('parses addition', () => {
    const r = parse(expr, '1+2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ op: '+', left: 1, right: 2 })
  })

  it('parses nested parens', () => {
    const r = parse(expr, '(1+2)+3')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({
        op: '+',
        left: { op: '+', left: 1, right: 2 },
        right: 3,
      })
    }
  })

  it('parses with whitespace (trivia)', () => {
    const r = parse(expr, '1 + 2 + 3', { trivia: ws })
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Local helpers inside factory — not in returned record
// ---------------------------------------------------------------------------

describe('parser() — local helpers inside factory', () => {
  // JSON-like array: [1, 2, [3, 4]]
  type JsonArr = number | JsonArr[]

  const ws = trivia(regex(/\s*/))
  const num = transform(regex(/[0-9]+/), s => parseInt(s, 10))

  const { value } = parser<{ value: Combinator<JsonArr> }>(g => {
    // comma and array are helpers — they don't need to be in the returned record
    // because nothing references them via g.*
    const comma = sequence(ws, literal(','), ws)
    const array = transform(
      sequence(literal('['), optional(sepBy(g.value as Combinator<JsonArr>, comma)), literal(']')),
      ([, items]) => (items ?? []) as JsonArr[]
    )
    return {
      value: choice(array, num) as Combinator<JsonArr>,
    }
  })

  it('parses a number', () => {
    const r = parse(value, '42', { trivia: ws })
    expect(r.ok && r.value).toBe(42)
  })

  it('parses a flat array', () => {
    const r = parse(value, '[1, 2, 3]', { trivia: ws })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([1, 2, 3])
  })

  it('parses nested arrays', () => {
    const r = parse(value, '[[1, 2], [3, [4]]]', { trivia: ws })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([[1, 2], [3, [4]]])
  })

  it('parses empty array', () => {
    const r = parse(value, '[]', { trivia: ws })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Non-recursive parser still work — no spurious ref() wrapping
// ---------------------------------------------------------------------------

describe('parser() — non-recursive parser stored directly', () => {
  // If a rule is in the returned record but never accessed via g.*,
  // it should be stored as-is (not wrapped in a ref).
  const { word, words } = parser(g => {
    const w = regex(/[a-z]+/)
    return {
      word:  w,
      words: transform(
        sequence(g.word, many(sequence(literal(' '), g.word))),
        ([first, rest]: [string, [string, string][]]) => [first, ...rest.map(([, w]) => w)]
      ),
    }
  })

  it('parses a single word', () => {
    const r = parse(word, 'hello')
    expect(r.ok && r.value).toBe('hello')
  })

  it('parses multiple words', () => {
    const r = parse(words, 'foo bar baz')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['foo', 'bar', 'baz'])
  })
})
