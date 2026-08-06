/**
 * Comprehensive regex shape tests.
 *
 * Covers:
 *   - First-set analysis for various regex constructs
 *   - Disjoint choice dispatch via regex first-sets
 *   - Negative lookahead (?!...) for keyword disambiguation
 *   - Optional prefix patterns (a?b → first-set includes both a and b)
 *   - Alternation first-sets
 *   - Compiler parity for all shapes
 *
 * First-set correctness matters for choice() disjoint dispatch: if the first-set
 * of a regex is computed wrongly, choice() either refuses to dispatch disjointly
 * (perf regression) or dispatches to the wrong branch (semantic bug).
 */
import { describe, it, expect } from 'vitest'
import { regex, literal, choice, sequence, transform, not, parse, compile } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { parseValue } from '../helpers/parse-result.ts'
import { parseClassOperand } from '../../src/regex/classes.ts'
import { scanShapeFromRegex } from '../../src/table/scan-shapes.ts'

// ---------------------------------------------------------------------------
// Helper: compiler parity
// ---------------------------------------------------------------------------
function par<T>(parser: Combinator<T>, inputs: string[]) {
  const compiled = compile(parser)
  for (const input of inputs) {
    const interp = parse(parser, input)
    const comp = compiled.parse(input)
    expect(comp.ok).toBe(interp.ok)
    if (interp.ok && comp.ok) {
      expect(comp.value).toEqual(interp.value)
      expect(comp.span.end).toBe(interp.span.end)
    }
  }
}

// ---------------------------------------------------------------------------
// First-set shapes
// ---------------------------------------------------------------------------

describe('regex first-set — character classes', () => {
  it('digit class [0-9] → ranges {48–57}', () => {
    const p = regex(/[0-9]+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      expect(p._meta.firstSet.ranges).toEqual([{ lo: 48, hi: 57 }])
    }
  })

  it('letter range [a-z] → ranges {97–122}', () => {
    const p = regex(/[a-z]+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      expect(p._meta.firstSet.ranges).toContainEqual({ lo: 97, hi: 122 })
    }
  })

  it('multi-range [0-9a-fA-F] → three ranges', () => {
    const p = regex(/[0-9a-fA-F]+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      expect(p._meta.firstSet.ranges.length).toBe(3)
    }
  })

  it('dot . → any (can match any char)', () => {
    const p = regex(/.+/)
    expect(p._meta.firstSet.kind).toBe('any')
  })

  it('\\w resolves to its precise digit/letter/underscore ranges', () => {
    // \w = [0-9A-Za-z_]. The hand-rolled analyzer lowers it precisely (the old
    // regexp-tree path coarsely widened it to `any`); `\w+` requires ≥1 char, so
    // its first-set is exactly those ranges.
    const p = regex(/\w+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      const has = (c: string) => p._meta.firstSet.kind === 'ranges' &&
        p._meta.firstSet.ranges.some(r => c.charCodeAt(0) >= r.lo && c.charCodeAt(0) <= r.hi)
      expect(has('a') && has('Z') && has('0') && has('_')).toBe(true)
      expect(has('-')).toBe(false)
    }
  })

  it('a leading zero-width assertion (\\b, ^) flows the first-set to the next term', () => {
    // Boundary/anchor assertions are nullable zero-width nodes, so the first-set
    // is that of the following term — `foo` starts with `f` (the old regexp-tree
    // path widened to `any` here). Still sound: `f` is the only possible start.
    for (const p of [regex(/\bfoo/), regex(/^foo/)]) {
      expect(p._meta.firstSet.kind).toBe('ranges')
      if (p._meta.firstSet.kind === 'ranges') {
        expect(p._meta.firstSet.ranges).toEqual([{ lo: 'f'.charCodeAt(0), hi: 'f'.charCodeAt(0) }])
      }
    }
  })
})

describe('regex first-set — optional prefix', () => {
  // This is the JSON number case: -?[0-9]+ has BOTH '-' and '0-9' as valid start chars.
  // The bug fixed earlier: only checking the first expression was wrong because '-?' can
  // match empty, meaning '0-9' also belongs in the first-set.
  it('-?[0-9]+ first-set includes both hyphen and digits', () => {
    const p = regex(/-?[0-9]+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      const ranges = p._meta.firstSet.ranges
      // hyphen is 45, digits are 48-57
      const hasHyphen = ranges.some(r => r.lo <= 45 && r.hi >= 45)
      const hasDigits = ranges.some(r => r.lo <= 48 && r.hi >= 57)
      expect(hasHyphen).toBe(true)
      expect(hasDigits).toBe(true)
    }
  })

  it('-?[0-9]+ parses both -42 and 42 correctly', () => {
    const p = regex(/-?[0-9]+/)
    expect(parseValue(p, '-42')).toBe('-42')
    expect(parseValue(p, '42')).toBe('42')
    expect(parse(p, 'abc').ok).toBe(false)
  })

  it('choice with -?[0-9]+ dispatches correctly', () => {
    // If first-set for -?[0-9]+ was wrong (only '-'), then '42' would fail to dispatch
    const num = transform(regex(/-?[0-9]+/), parseFloat)
    const str = transform(sequence(literal('"'), regex(/[^"]*/), literal('"')), ([, s]) => s)
    const p = choice(str, num)
    expect(parseValue(p, '42')).toBe(42)
    expect(parseValue(p, '-1')).toBe(-1)
    expect(parseValue(p, '"hello"')).toBe('hello')
  })
})

describe('regex first-set — alternation', () => {
  it('(?:ab|cd) first-set includes both a and c', () => {
    const p = regex(/(?:ab|cd)+/)
    expect(p._meta.firstSet.kind).toBe('ranges')
    if (p._meta.firstSet.kind === 'ranges') {
      const ranges = p._meta.firstSet.ranges
      const hasA = ranges.some(r => r.lo <= 97 && r.hi >= 97)  // 'a'
      const hasC = ranges.some(r => r.lo <= 99 && r.hi >= 99)  // 'c'
      expect(hasA).toBe(true)
      expect(hasC).toBe(true)
    }
  })

  it('alternation parses both branches', () => {
    const p = regex(/foo|bar/)
    expect(parseValue(p, 'foo')).toBe('foo')
    expect(parseValue(p, 'bar')).toBe('bar')
    expect(parse(p, 'baz').ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Negative lookahead — keyword disambiguation
// ---------------------------------------------------------------------------

describe('regex negative lookahead (?!...)', () => {
  // /keyword(?!\w)/ matches 'keyword' only when NOT followed by a word char.
  // This is an alternative to sequence(literal('keyword'), not(regex(/\w/))).
  // Both approaches should produce identical results.

  it('(?!\\w) prevents matching keyword as prefix of longer word', () => {
    const p = regex(/if(?!\w)/)
    expect(parseValue(p, 'if ')).toBe('if')
    expect(parseValue(p, 'if(')).toBe('if')
    expect(parseValue(p, 'if')).toBe('if')   // end of input
    expect(parse(p, 'ifdef').ok).toBe(false)  // 'd' is a word char
    expect(parse(p, 'iffy').ok).toBe(false)   // 'f' is a word char
  })

  it('lookahead value does not include the lookahead chars', () => {
    // The matched value is just the keyword, lookahead chars are NOT consumed
    const p = regex(/if(?!\w)/)
    const r = parse(p, 'if(x)')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('if')
      expect(r.span.end).toBe(2)   // only 'if' consumed, '(' stays
    }
  })

  it('negative lookahead regex == sequence(literal, not(regex)) semantics', () => {
    // Both should agree on every input
    const withLookahead = regex(/if(?!\w)/)
    const withNot = sequence(literal('if'), not(regex(/\w/)))

    const inputs = ['if', 'if ', 'if(', 'ifdef', 'iffy', 'other', 'i']
    for (const input of inputs) {
      const r1 = parse(withLookahead, input)
      const r2 = parse(withNot, input)
      expect(r1.ok).toBe(r2.ok)
      // Note: withLookahead returns the matched string 'if'; withNot returns ['if', null]
    }
  })

  it('multi-keyword: each keyword uses negative lookahead regex', () => {
    const kwIf     = regex(/if(?!\w)/)
    const kwElse   = regex(/else(?!\w)/)
    const kwReturn = regex(/return(?!\w)/)
    const ident    = regex(/[a-zA-Z_]\w*/)

    const token = choice(kwIf, kwElse, kwReturn, ident)

    expect(parseValue(token, 'if')).toBe('if')
    expect(parseValue(token, 'else')).toBe('else')
    expect(parseValue(token, 'return')).toBe('return')
    // These should fall through to ident:
    expect(parseValue(token, 'ifdef')).toBe('ifdef')
    expect(parseValue(token, 'elsewhere')).toBe('elsewhere')
    expect(parseValue(token, 'returns')).toBe('returns')
    expect(parseValue(token, 'iffy')).toBe('iffy')
  })

  it('negative lookahead regex — compiler parity', () => {
    const p = regex(/if(?!\w)/)
    par(p, ['if', 'if ', 'if(', 'ifdef', 'iffy', 'other'])
  })
})

// ---------------------------------------------------------------------------
// Disjoint dispatch via regex first-sets
// ---------------------------------------------------------------------------

describe('choice disjoint dispatch with regex parsers', () => {
  it('disjoint first chars → dispatched as disjoint', () => {
    // digit, letter, dash — all different first-set ranges
    const num   = regex(/[0-9]+/)
    const word  = regex(/[a-zA-Z]+/)
    const dash  = literal('-')
    const p = choice(num, word, dash)
    expect(p._meta.disjoint).toBe(true)
  })

  it('overlapping first-sets → not disjoint', () => {
    // Both can start with 'a'
    const p = choice(regex(/a+/), regex(/[a-z]+/))
    expect(p._meta.disjoint).toBe(false)
  })

  it('disjoint dispatch produces correct values', () => {
    const num  = transform(regex(/[0-9]+/), s => ({ type: 'num' as const, v: s }))
    const word = transform(regex(/[a-zA-Z]+/), s => ({ type: 'word' as const, v: s }))
    const p = choice(num, word)
    expect(p._meta.disjoint).toBe(true)

    const r1 = parse(p, '123')
    expect(r1.ok && r1.value).toEqual({ type: 'num', v: '123' })

    const r2 = parse(p, 'hello')
    expect(r2.ok && r2.value).toEqual({ type: 'word', v: 'hello' })

    expect(parse(p, '!').ok).toBe(false)
  })

  it('disjoint dispatch — compiler parity', () => {
    const num  = transform(regex(/[0-9]+/), s => parseInt(s))
    const word = regex(/[a-zA-Z]+/)
    const p = choice(num, word)
    expect(p._meta.disjoint).toBe(true)
    par(p, ['123', 'hello', '!', '', '0', 'z'])
  })

  it('-?[0-9]+ participates in disjoint choice with string', () => {
    // Regression: if -?[0-9]+ first-set was only '-', '42' would miss dispatch
    const num = transform(regex(/-?[0-9]+/), parseFloat)
    const str = transform(sequence(literal('"'), regex(/[^"]*/), literal('"')), ([, s]) => s)
    const bool = choice(
      transform(literal('true'), () => true),
      transform(literal('false'), () => false),
    )
    const p = choice(str, num, bool)
    // Disjoint: '"' vs {-,0-9} vs {t,f} — all separate
    expect(p._meta.disjoint).toBe(true)
    par(p, ['"hello"', '42', '-1', 'true', 'false', 'null', ''])
  })
})

// ---------------------------------------------------------------------------
// Quantifiers
// ---------------------------------------------------------------------------

describe('regex quantifiers', () => {
  it('* (zero or more) — matches empty', () => {
    const p = regex(/[0-9]*/)
    expect(parse(p, '').ok).toBe(true)
    expect(parse(p, 'abc').ok).toBe(true)
    expect(parseValue(p, 'abc')).toBe('')
    expect(parseValue(p, '123')).toBe('123')
  })

  it('+ (one or more) — fails on empty', () => {
    const p = regex(/[0-9]+/)
    expect(parse(p, '').ok).toBe(false)
    expect(parseValue(p, '123')).toBe('123')
  })

  it('? (zero or one)', () => {
    const p = regex(/-?[0-9]/)
    expect(parseValue(p, '5')).toBe('5')
    expect(parseValue(p, '-5')).toBe('-5')
  })

  it('{n,m} range', () => {
    const p = regex(/[0-9]{2,4}/)
    expect(parse(p, '1').ok).toBe(false)
    expect(parseValue(p, '12')).toBe('12')
    expect(parseValue(p, '12345')).toBe('1234')  // max 4
  })

  it('quantifier parity', () => {
    par(regex(/[a-z]*/), ['', 'abc', '123', 'abc123'])
    par(regex(/[a-z]+/), ['', 'abc', '123'])
    par(regex(/[a-z]?/), ['', 'a', 'abc', '1'])
    par(regex(/[a-z]{2,3}/), ['a', 'ab', 'abc', 'abcd'])
  })
})

// ---------------------------------------------------------------------------
// Groups and non-capturing groups
// ---------------------------------------------------------------------------

describe('regex groups', () => {
  it('capturing group — value includes group', () => {
    // regex() returns the full match, not a captured group
    const p = regex(/([a-z]+)([0-9]+)/)
    const r = parse(p, 'abc123')
    expect(r.ok && r.value).toBe('abc123')
  })

  it('non-capturing group (?:...)', () => {
    const p = regex(/(?:foo|bar)baz/)
    expect(parseValue(p, 'foobaz')).toBe('foobaz')
    expect(parseValue(p, 'barbaz')).toBe('barbaz')
    expect(parse(p, 'quxbaz').ok).toBe(false)
  })

  it('optional group (?:...)?', () => {
    // The optional group makes the whole thing matchable from multiple first chars
    const p = regex(/(?:https?:\/\/)?[a-z]+/)
    expect(parseValue(p, 'example')).toBe('example')
    expect(parseValue(p, 'http://example')).toBe('http://example')
    expect(parseValue(p, 'https://example')).toBe('https://example')
  })

  it('group parity', () => {
    par(regex(/(?:foo|bar)/), ['foo', 'bar', 'baz', ''])
    par(regex(/([0-9]+)/),    ['123', 'abc', ''])
  })
})

/**
 * `parseClassOperand` answers "is this fragment ONE single-char matcher", and
 * every caller — `scan-shapes`' trailing-lookahead strip and delimited-body
 * proof, `trivia-skip`'s prefix-run scanner — depends on the matcher being the
 * WHOLE fragment. It used to test only that a bracketed body OPENS with `[` and
 * ENDS with `]`, which a sequence of two classes also satisfies.
 */
describe('parseClassOperand — one class token, or nothing', () => {
  const members = (body: string): number[] | null => {
    const op = parseClassOperand(body)
    if (!op || op.negated) return null
    return op.ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, k) => lo + k))
  }

  it('refuses a two-class SEQUENCE instead of unioning across the gap', () => {
    // The live case: scss's descendant combinator is `\+(?=[ \t\n\r\f]*[\$(])`.
    // Read as one class, its members became everything between the OUTER
    // brackets — SPACE (32), `]` (93), `*` (42), `[` (91) — so the lookahead
    // admitted a `+` followed by a space, at 203 positions of the scss corpus.
    expect(parseClassOperand('[ \\t\\n\\r\\f]*[\\$(]')).toBeNull()
    expect(parseClassOperand('[a][b]')).toBeNull()
    expect(parseClassOperand('[a]*[b]')).toBeNull()
  })

  it('refuses a class followed by a quantifier — that is two tokens', () => {
    expect(parseClassOperand('[abc]*')).toBeNull()
    expect(parseClassOperand('[abc]?')).toBeNull()
  })

  it('refuses `[]]`, which JS reads as the EMPTY class then a literal `]`', () => {
    // Not a single matcher, and emphatically not the class {]} that the
    // trailing-`]` test used to make it.
    expect(parseClassOperand('[]]')).toBeNull()
    expect(parseClassOperand('[^]]')).toBeNull()
  })

  it('still accepts every genuine single-char matcher', () => {
    expect(members('[abc]')).toEqual([97, 98, 99])
    expect(members('[0-9]')).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56, 57])
    expect(members('[\\]]')).toEqual([93]) // an ESCAPED `]` is a member, not the close
    expect(members('a')).toEqual([97])
    expect(members('\\t')).toEqual([9])
    expect(parseClassOperand('[^\\n]')).toEqual({ ranges: [[10, 10]], negated: true })
    expect(parseClassOperand('\\d')).toEqual({ ranges: [[48, 57]], negated: false })
  })

  it('the refusal reaches the shape lowering it protects', () => {
    // Declining costs a fast path; accepting produced a scan that matched where
    // the RegExp it replaces does not.
    expect(scanShapeFromRegex('\\+(?=[ \\t\\n\\r\\f]*[\\$(])', '')).toBeNull()
    expect(/\+(?=[ \t\n\r\f]*[\$(])/y.exec('+ x')).toBeNull()
    // The genuine single-class spelling still lowers.
    expect(scanShapeFromRegex('\\+(?=[\\$(])', '')?.kind).toBe('lookahead')
  })
})
