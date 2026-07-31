/**
 * `adjacent()` / `notAdjacent()` — zero-width ADJACENCY assertions.
 *
 * The question these answer is "was there anything between the previous term and
 * this position", never "what does a separator look like" — see
 * `docs/design/derived-tokenization.md` §4 and `src/combinators/adjacency.ts`.
 */
import { describe, it, expect } from 'vitest'
import {
  adjacent, notAdjacent, sequence, literal, regex, choice, node, optional, oneOrMore,
  classifiedTrivia, trivia, parser, parse, rules, run,
} from '../../src/index.ts'

const ws = trivia(regex(/[ \t\n\r\f]+/))

function classified() {
  return classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })
}

/** `a <op> b` where the operator must be SEPARATED from both operands. */
function separatedOp(sep: () => ReturnType<typeof notAdjacent>, tr = classified()) {
  return parser({ trivia: tr }, sequence(
    regex(/[a-z0-9]+/),
    sep(), literal('+'), sep(),
    regex(/[a-z0-9]+/),
  ))
}

describe('notAdjacent()', () => {
  it('requires separation, and fails when the terms are glued', () => {
    const g = parser({ trivia: ws }, sequence(literal('a'), notAdjacent(), literal('b')))
    expect(parse(g, 'a b').ok).toBe(true)
    expect(parse(g, 'a   b').ok).toBe(true)
    expect(parse(g, 'ab').ok).toBe(false)
  })

  it('names itself in the failure label', () => {
    const g = parser({ trivia: ws }, sequence(literal('a'), notAdjacent(), literal('b')))
    const r = parse(g, 'ab')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['notAdjacent'])
  })

  it('is rejected at CONSTRUCTION as the first term of a sequence', () => {
    expect(() => sequence(notAdjacent(), literal('a'))).toThrow(TypeError)
    expect(() => sequence(adjacent(), literal('a'))).toThrow(/cannot be the FIRST term/)
  })

  it('throws when used outside a sequence boundary, rather than silently answering', () => {
    expect(() => parse(parser({ trivia: ws }, notAdjacent()), '')).toThrow(TypeError)
  })

  it('can never hold where the scope has no ambient trivia', () => {
    const g = sequence(literal('a'), notAdjacent(), literal('b'))
    expect(parse(g, 'ab').ok).toBe(false)
    expect(parse(g, 'a b').ok).toBe(false)
  })
})

describe('adjacent()', () => {
  it('requires the terms to be glued', () => {
    const g = parser({ trivia: ws }, sequence(regex(/[0-9]+/), adjacent(), regex(/[a-z]+/)))
    expect(parse(g, '10px').ok).toBe(true)
    const spaced = parse(g, '10 px')
    expect(spaced.ok).toBe(false)
    if (!spaced.ok) expect(spaced.expected).toEqual(['adjacent'])
  })

  it('expresses on ambient trivia what a noTrivia() site expresses by clearing it', () => {
    // The `noTrivia` idiom: disable trivia around the glued run.
    const viaNoTrivia = parser({ trivia: ws }, parser({ trivia: null }, sequence(regex(/[0-9]+/), regex(/[a-z]+/))))
    const viaAdjacent = parser({ trivia: ws }, sequence(regex(/[0-9]+/), adjacent(), regex(/[a-z]+/)))
    for (const input of ['10px', '10 px']) {
      expect(parse(viaAdjacent, input).ok).toBe(parse(viaNoTrivia, input).ok)
    }
  })
})

describe('adjacency inside node()', () => {
  it('asserts at the boundary and contributes ZERO children', () => {
    const g = rules({ trivia: ws }, () => ({
      root: node('Pair', sequence(literal('a'), notAdjacent(), literal('b')),
        (children, _f, span) => ({ type: 'Pair', children: [...children], span })),
    }))
    const ok = run(g.root, 'a b')
    expect(ok.ok).toBe(true)
    // Two leaves, not three: the assertion is not a child.
    expect((ok.value as { children: unknown[] }).children).toHaveLength(2)
    expect(run(g.root, 'ab').ok).toBe(false)
  })

  it('leaves the node span identical to the same sequence without the assertion', () => {
    const build = (withAssertion: boolean) => rules({ trivia: ws }, () => ({
      root: node('Pair',
        withAssertion
          ? sequence(literal('a'), notAdjacent(), literal('b'))
          : sequence(literal('a'), literal('b')),
        (_c, _f, span) => span),
    }))
    expect(run(build(true).root, 'a  b').value).toEqual(run(build(false).root, 'a  b').value)
  })

  it('occupies a positional slot in the sequence tuple, carrying null', () => {
    const g = parser({ trivia: ws }, sequence(literal('a'), notAdjacent(), literal('b')))
    const r = parse(g, 'a b')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(['a', null, 'b'])
  })
})

describe('kind-filtered adjacency', () => {
  it('unfiltered, a comment IS a separator', () => {
    const g = separatedOp(() => notAdjacent())
    expect(parse(g, 'a + b').ok).toBe(true)
    expect(parse(g, 'a/*x*/+/*y*/b').ok).toBe(true)
    expect(parse(g, 'a+b').ok).toBe(false)
  })

  it('{ kinds: [whitespace] } rejects a comment-only gap — css-values-4 10.1', () => {
    const g = separatedOp(() => notAdjacent({ kinds: ['whitespace'] }))
    expect(parse(g, 'a + b').ok).toBe(true)
    expect(parse(g, 'a/*x*/+/*y*/b').ok).toBe(false)
    expect(parse(g, 'a+b').ok).toBe(false)
  })

  it('accepts a MIXED gap containing at least one whitespace chunk', () => {
    const g = separatedOp(() => notAdjacent({ kinds: ['whitespace'] }))
    expect(parse(g, 'a /*x*/+ /*y*/b').ok).toBe(true)
    expect(parse(g, 'a/*x*/ +/*y*/ b').ok).toBe(true)
  })

  it('names the kinds in the failure label', () => {
    const g = separatedOp(() => notAdjacent({ kinds: ['whitespace'] }))
    const r = parse(g, 'a/*x*/+/*y*/b')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.expected).toEqual(['notAdjacent(whitespace)'])
  })
})

describe('kind filtering is never a silent no-op', () => {
  it('rejects an empty or malformed kinds list at construction', () => {
    expect(() => notAdjacent({ kinds: [] })).toThrow(TypeError)
  })

  it('throws on UNLABELED trivia rather than degrading to a bare assertion', () => {
    const g = parser({ trivia: ws }, sequence(literal('a'), notAdjacent({ kinds: ['whitespace'] }), literal('b')))
    expect(() => parse(g, 'a b')).toThrow(/requires classified trivia/)
  })

  it('throws on an unknown kind NAME rather than matching nothing', () => {
    const g = separatedOp(() => notAdjacent({ kinds: ['whitspace'] }))
    expect(() => parse(g, 'a + b')).toThrow(/unknown trivia kind "whitspace"/)
  })
})

/**
 * The signed-number case. `1 -2` is a two-element space-separated list; `1 - 2` is
 * a subtraction. Only the GAP distinguishes them, which is the whole motivation.
 */
describe('sum vs signed number', () => {
  const number = regex(/[0-9]+/)
  const sep = () => notAdjacent()

  function sumGrammar(kinds?: readonly string[]) {
    const gap = () => (kinds === undefined ? sep() : notAdjacent({ kinds }))
    const subtraction = sequence(number, gap(), literal('-'), gap(), number)
    const signed = sequence(number, notAdjacent(), literal('-'), adjacent(), number)
    const glued = sequence(number, adjacent(), literal('-'), adjacent(), number)
    return parser({ trivia: classified() }, choice(subtraction, signed, glued))
  }

  const classify = (g: ReturnType<typeof sumGrammar>, input: string): string => {
    const r = parse(g, input)
    if (!r.ok) return 'fail'
    const [, sepBefore, , sepAfter] = r.value as [unknown, unknown, unknown, unknown, unknown]
    void sepBefore; void sepAfter
    return r.span.end === input.length ? 'ok' : 'partial'
  }

  it('distinguishes all four spacings', () => {
    const g = sumGrammar()
    // `1 - 2` → subtraction (arm 1); `1 -2` → signed (arm 2); `1-2` → glued (arm 3).
    expect(classify(g, '1 - 2')).toBe('ok')
    expect(classify(g, '1 -2')).toBe('ok')
    expect(classify(g, '1-2')).toBe('ok')
    expect(classify(g, '1/*c*/-/*c*/2')).toBe('ok')
    // Each lands on the arm its spacing selects, not merely "some arm".
    expect(parse(parser({ trivia: classified() }, sequence(number, notAdjacent(), literal('-'), notAdjacent(), number)), '1 -2').ok).toBe(false)
    expect(parse(parser({ trivia: classified() }, sequence(number, notAdjacent(), literal('-'), adjacent(), number)), '1 -2').ok).toBe(true)
    expect(parse(parser({ trivia: classified() }, sequence(number, adjacent(), literal('-'), adjacent(), number)), '1-2').ok).toBe(true)
  })

  it('with { kinds: [whitespace] }, a comment-separated form is NOT a subtraction', () => {
    const strict = parser({ trivia: classified() }, sequence(
      number, notAdjacent({ kinds: ['whitespace'] }), literal('-'), notAdjacent({ kinds: ['whitespace'] }), number,
    ))
    expect(parse(strict, '1 - 2').ok).toBe(true)
    expect(parse(strict, '1 -2').ok).toBe(false)
    expect(parse(strict, '1-2').ok).toBe(false)
    expect(parse(strict, '1/*c*/-/*c*/2').ok).toBe(false)
  })
})

describe('first-set', () => {
  it('does not poison the enclosing sequence dispatch', () => {
    // A leading `optional()` makes the assertion reachable during the first-set
    // walk; it must contribute nothing rather than `any`.
    const g = sequence(literal('a'), optional(literal('b')), notAdjacent(), literal('c'))
    expect(g._meta.firstSet).toEqual(literal('a')._meta.firstSet)
  })

  it('composes with a repeat around it', () => {
    const g = parser({ trivia: ws }, oneOrMore(sequence(literal('a'), notAdjacent(), literal('b'))))
    const all = parse(g, 'a b a b')
    expect(all.ok && all.span.end).toBe(7)
    // The second item is glued, so the repeat stops rather than accepting it.
    const partial = parse(g, 'a bab')
    expect(partial.ok && partial.span.end).toBe(3)
  })
})
