import { describe, expect, it } from 'vitest'
import {
  dispatch,
  endsWith,
  endsWithUnescaped,
  literal,
  noTrivia,
  optional,
  otherwise,
  regex,
  sequence,
  token,
  when,
  type Combinator,
  type DispatchMatcherCase,
} from '../../src/index.ts'
import { endsWithUnescapedBoundary, matchesDispatchMatcher, type DispatchStringMatcher } from '../../src/combinators/dispatch.ts'
import { assertEnginesAgree } from '../parity/helpers/engine-parity.ts'

/**
 * `endsWithUnescaped('(')` is the escape-aware suffix matcher: a value ident that
 * ends in an escaped `\(` must NOT be routed to a function-open arm the way
 * `endsWith('(')` would, while a real `foo(` — and `\41(` / `\\(`, whose trailing
 * `(` is unescaped — still is. It lowers to the plain `endsWith` fast path plus a
 * backslash-parity check, never a regex.
 */

describe('endsWithUnescapedBoundary', () => {
  it('is even-parity of the escape run immediately before the suffix', () => {
    const b = (text: string, suffix: string) => endsWithUnescapedBoundary(text, suffix.length, '\\')
    expect(b('foo(', '(')).toBe(true)   // no backslash -> unescaped
    expect(b('\\(', '(')).toBe(false)    // one backslash -> escaped
    expect(b('a\\(', '(')).toBe(false)   // one backslash -> escaped
    expect(b('\\\\(', '(')).toBe(true)   // two backslashes -> escaped backslash, real (
    expect(b('\\\\\\(', '(')).toBe(false) // three -> escaped
    expect(b('\\41(', '(')).toBe(true)   // hex escape then unescaped (
  })
})

describe('matchesDispatchMatcher with endsWithUnescaped', () => {
  const m = endsWithUnescaped('(') as { kind: 'endsWith'; value: string; escape: string }
  const asCase = (extra: Partial<DispatchMatcherCase> = {}): DispatchMatcherCase =>
    ({ kind: m.kind, value: m.value, escape: m.escape, parser: literal(')'), caseInsensitive: false, ...extra })

  it('claims an unescaped trailing paren, rejects an escaped one', () => {
    expect(matchesDispatchMatcher('foo(', asCase())).toBe(true)
    expect(matchesDispatchMatcher('\\41(', asCase())).toBe(true)
    expect(matchesDispatchMatcher('\\\\(', asCase())).toBe(true)
    expect(matchesDispatchMatcher('\\(', asCase())).toBe(false)
    expect(matchesDispatchMatcher('a\\(', asCase())).toBe(false)
  })

  it('a plain endsWith cannot see the escape (proves the difference is real)', () => {
    const plain: DispatchMatcherCase = { kind: 'endsWith', value: '(', parser: literal(')'), caseInsensitive: false }
    expect(matchesDispatchMatcher('\\(', plain)).toBe(true) // wrong route a plain suffix would take
  })
})

describe('endsWithUnescaped in a dispatch, across every engine', () => {
  // Opener: an escape-aware value ident, then an OPTIONAL structural '('. The
  // ident greedily consumes an escaped '\(', so the opener token can end in '('
  // either because a function paren was appended OR because the ident's escape
  // did — exactly the ambiguity endsWithUnescaped resolves.
  const ident = regex(/(?:[a-zA-Z]|\\(?:[0-9a-fA-F]{1,6} ?|[^\n]))+/)
  const opener = token(noTrivia(sequence(ident, optional(literal('(')))))

  const build = (fnMatcher: DispatchStringMatcher): Combinator<unknown> =>
    dispatch(
      opener,
      when(fnMatcher, literal(')')), // function arm consumes the closer
      otherwise(literal(';')),       // ident arm consumes a terminator
    )

  const unescaped = build(endsWithUnescaped('('))

  it('routes an unescaped trailing paren to the function arm', () => {
    expect(assertEnginesAgree(unescaped, 'foo()').ok).toBe(true)
    expect(assertEnginesAgree(unescaped, '\\41()').ok).toBe(true)
    expect(assertEnginesAgree(unescaped, '\\\\()').ok).toBe(true)
  })

  it('routes an escaped trailing paren to the otherwise arm', () => {
    // `\(;` — opener is the ident `\(`, then the `;` is the ident-arm terminator.
    expect(assertEnginesAgree(unescaped, '\\(;').ok).toBe(true)
    expect(assertEnginesAgree(unescaped, 'a\\(;').ok).toBe(true)
  })

  it('endsWith("(") mis-routes the escaped paren (the bug this fixes)', () => {
    const plain = build(endsWith('('))
    // `\(;` sends the opener `\(` to the FUNCTION arm, which then demands ')'
    // and fails on ';'.
    expect(assertEnginesAgree(plain, '\\(;').ok).toBe(false)
  })
})
