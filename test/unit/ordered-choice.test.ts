/**
 * Longest-match (maximal munch) semantics tests.
 *
 * parseman's choice() tries every alternative and returns whichever consumed
 * the most input. Ties go to the first listed alternative.
 *
 * This means:
 *   1. ORDER DOES NOT MATTER for disambiguation — no `not()` required.
 *   2. choice(literal('if'), ident) and choice(ident, literal('if')) behave
 *      identically: 'if ' → 'if' (tie at 2 chars, first listed wins),
 *      'ifdef' → 'ifdef' (ident consumed 5 chars, longer match wins).
 *   3. Ties (same-length match) go to the first listed alternative, giving
 *      the user a simple override: put the more specific parser first.
 */
import { describe, it, expect } from 'vitest'
import { literal, regex, choice, sequence, transform, not, parse, compile } from '../../src/index.ts'

// ---------------------------------------------------------------------------
// Longest match: more input consumed wins
// ---------------------------------------------------------------------------

describe('longest-match — basic', () => {
  const word = regex(/\w+/)

  it('choice(literal, regex): regex wins when it matches more', () => {
    // 'trueish' — literal('true') gets 4, word gets 7. word wins.
    const p = choice(literal('true'), word)
    const r = parse(p, 'trueish')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('trueish')
      expect(r.span.end).toBe(7)
    }
  })

  it('choice(literal, regex): tie → first listed wins', () => {
    // 'true' — both match 4 chars. literal is first, so it wins.
    const p = choice(literal('true'), word)
    const r = parse(p, 'true')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('true')
      expect(r.span.end).toBe(4)
    }
  })

  it('choice(regex, literal): same result — order doesn\'t change who wins on longer input', () => {
    // Reversed order: word is first. On 'trueish' word still wins (longer match).
    const p = choice(word, literal('true'))
    const r = parse(p, 'trueish')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('trueish')
      expect(r.span.end).toBe(7)
    }
  })

  it('choice(regex, literal): tie — now regex wins (it\'s listed first)', () => {
    // On 'true' both match 4 chars. word is first, so word wins.
    // Value is the same string 'true' either way (just different parser).
    const p = choice(word, literal('true'))
    const r = parse(p, 'true')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('true')
      expect(r.span.end).toBe(4)
    }
  })

  it('fails when no alternative matches', () => {
    const p = choice(literal('true'), literal('false'))
    expect(parse(p, 'null').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Shared prefix: longest literal wins automatically
// No manual ordering required.
// ---------------------------------------------------------------------------

describe('longest-match — shared prefix', () => {
  it('choice(short, long): longer match wins regardless of order', () => {
    // 'for' is a prefix of 'forever'. With longest-match, 'forever' wins on 'forever'.
    const p = choice(literal('for'), literal('forever'))
    const r = parse(p, 'forever')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('forever')
      expect(r.span.end).toBe(7)
    }
  })

  it('choice(long, short): same result — still longest match wins', () => {
    const p = choice(literal('forever'), literal('for'))
    const r = parse(p, 'forever')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('forever')
      expect(r.span.end).toBe(7)
    }
  })

  it('shorter literal wins when longer literal fails to match', () => {
    const p = choice(literal('forever'), literal('for'))
    const r = parse(p, 'for!')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('for')
      expect(r.span.end).toBe(3)
    }
  })

  it('three-way prefix: any order works — instanceof / in / if', () => {
    // All start with 'i'. With longest-match, any ordering produces correct results.
    const p = choice(literal('in'), literal('instanceof'), literal('if'))  // "wrong" order
    expect(parse(p, 'instanceof').ok && parse(p, 'instanceof').value).toBe('instanceof')
    expect(parse(p, 'in').ok && parse(p, 'in').value).toBe('in')
    expect(parse(p, 'if').ok && parse(p, 'if').value).toBe('if')
  })
})

// ---------------------------------------------------------------------------
// Keyword disambiguation: not() is NO LONGER REQUIRED
// choice(literal('if'), ident) does the right thing automatically.
// not() still works and is available as an explicit tool when needed.
// ---------------------------------------------------------------------------

describe('keyword disambiguation without not()', () => {
  const ident = regex(/[a-zA-Z_]\w*/)

  it('choice(literal, ident): keyword wins on exact match', () => {
    const p = choice(literal('if'), ident)
    const r = parse(p, 'if')
    expect(r.ok && r.value).toBe('if')
  })

  it('choice(literal, ident): ident wins on "ifdef" (longer)', () => {
    const p = choice(literal('if'), ident)
    const r = parse(p, 'ifdef')
    expect(r.ok && r.value).toBe('ifdef')
  })

  it('choice(ident, literal): same result regardless of order', () => {
    // Putting ident first should not change the outcome
    const p = choice(ident, literal('if'))
    expect(parse(p, 'if').ok && parse(p, 'if').value).toBe('if')
    expect(parse(p, 'ifdef').ok && parse(p, 'ifdef').value).toBe('ifdef')
    expect(parse(p, 'hello').ok && parse(p, 'hello').value).toBe('hello')
  })

  it('multi-keyword: any order, no not() needed', () => {
    const p = choice(literal('if'), literal('else'), literal('return'), ident)
    expect(parse(p, 'if').ok && parse(p, 'if').value).toBe('if')
    expect(parse(p, 'else').ok && parse(p, 'else').value).toBe('else')
    expect(parse(p, 'return').ok && parse(p, 'return').value).toBe('return')
    // Identifiers that START with a keyword should fall through to ident
    expect(parse(p, 'ifdef').ok && parse(p, 'ifdef').value).toBe('ifdef')
    expect(parse(p, 'elsewhere').ok && parse(p, 'elsewhere').value).toBe('elsewhere')
    expect(parse(p, 'returns').ok && parse(p, 'returns').value).toBe('returns')
    expect(parse(p, 'iffy').ok && parse(p, 'iffy').value).toBe('iffy')
  })
})

// ---------------------------------------------------------------------------
// not() still works — explicit negative lookahead is still supported
// ---------------------------------------------------------------------------

describe('not() still works for explicit lookahead', () => {
  const wordChar = regex(/\w/)
  const word = regex(/\w+/)

  const keyword = (s: string) => transform(
    sequence(literal(s), not(wordChar)),
    ([kw]) => kw
  )

  it('keyword helper: matches on exact keyword', () => {
    const p = keyword('true')
    expect(parse(p, 'true').ok).toBe(true)
    expect(parse(p, 'true ').ok).toBe(true)
  })

  it('keyword helper: fails when followed by word char', () => {
    const p = keyword('true')
    expect(parse(p, 'trueish').ok).toBe(false)
  })

  it('choice(keyword, word): equivalent to choice(literal, word) under longest-match', () => {
    // Both should agree on all inputs
    const withKeyword = choice(keyword('true'), word)
    const withLiteral = choice(literal('true'), word)

    const inputs = ['true', 'trueish', 'hello', 'TRUE']
    for (const input of inputs) {
      const r1 = parse(withKeyword, input)
      const r2 = parse(withLiteral, input)
      expect(r1.ok).toBe(r2.ok)
      if (r1.ok && r2.ok) expect(r1.span.end).toBe(r2.span.end)
    }
  })
})

// ---------------------------------------------------------------------------
// Compiler parity: same longest-match semantics in compiled code
// ---------------------------------------------------------------------------

describe('longest-match — compiler parity', () => {
  function parity<T>(p: Parameters<typeof compile>[0], input: string) {
    const compiled = compile(p as import('../../src/index.ts').Combinator<T>)
    const interp = parse(p as import('../../src/index.ts').Combinator<T>, input)
    const comp = compiled.parse(input)
    expect(comp.ok).toBe(interp.ok)
    if (interp.ok && comp.ok) {
      expect(comp.value).toEqual(interp.value)
      expect(comp.span.end).toBe(interp.span.end)
    }
  }

  const word = regex(/\w+/)
  const ident = regex(/[a-zA-Z_]\w*/)

  it('literal before word: longest wins in both modes', () => {
    const p = choice(literal('true'), word)
    parity(p, 'trueish')  // word wins (7 > 4)
    parity(p, 'true')     // tie → literal wins (first listed)
    parity(p, 'hello')
  })

  it('word before literal: same result (order doesn\'t change outcome)', () => {
    const p = choice(word, literal('true'))
    parity(p, 'trueish')  // word wins
    parity(p, 'true')     // tie → word wins (first listed this time)
    parity(p, 'hello')
  })

  it('shared prefix: longer always wins in both modes', () => {
    const p = choice(literal('for'), literal('forever'))
    parity(p, 'forever')  // 'forever' wins (longer)
    parity(p, 'for!')     // 'for' wins ('forever' doesn't match)
    parity(p, 'false')    // neither matches
  })

  it('keyword disambiguation: no not() needed in compiled mode', () => {
    const p = choice(literal('if'), ident)
    parity(p, 'if')
    parity(p, 'ifdef')
    parity(p, 'hello')
  })
})
