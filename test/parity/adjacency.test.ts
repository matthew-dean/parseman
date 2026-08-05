/**
 * Adjacency parity: `adjacent()` / `notAdjacent()` must decide identically in the
 * interpreter and in compiled output — including the kind filter, whose compiled
 * side is an independently emitted per-arm probe (`_akN`) rather than a channel
 * out of the shared `_tfN` trivia scanner.
 */
import { describe, it, expect } from 'vitest'
import {
  adjacent, notAdjacent, sequence, literal, regex, choice, node, oneOrMore,
  classifiedTrivia, trivia, parser, parse as runtimeParse, compile, rules,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { compileTable as compileCodegen } from '../../src/table/compile.ts'

const ws = trivia(regex(/[ \t\n\r\f]+/))

const classified = () => classifiedTrivia({
  whitespace: regex(/[ \t\n\r\f]+/),
  comment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
})

function par<T>(label: string, p: Combinator<T>, inputs: string[]) {
  const compiled = compile(p)
  for (const input of inputs) {
    it(`${label} — ${JSON.stringify(input)}`, () => {
      const interpreted = runtimeParse(p, input)
      const emitted = compiled.parse(input)
      expect(emitted.ok).toBe(interpreted.ok)
      if (interpreted.ok && emitted.ok) {
        expect(emitted.value).toEqual(interpreted.value)
        expect(emitted.span.start).toBe(interpreted.span.start)
        expect(emitted.span.end).toBe(interpreted.span.end)
      } else if (!interpreted.ok && !emitted.ok) {
        expect(emitted.expected).toEqual(interpreted.expected)
        expect(emitted.span.end).toBe(interpreted.span.end)
      }
    })
  }
}

const GAPS = ['ab', 'a b', 'a   b', 'a\nb', 'a/*x*/b', 'a /*x*/b', 'a/*x*/ b', 'a/*x*//*y*/b', 'a', 'b']

describe('notAdjacent — parity', () => {
  par('bare', parser({ trivia: ws }, sequence(literal('a'), notAdjacent(), literal('b'))), GAPS)
  par('classified, unfiltered', parser({ trivia: classified() }, sequence(literal('a'), notAdjacent(), literal('b'))), GAPS)
  par('classified, { kinds: [whitespace] }',
    parser({ trivia: classified() }, sequence(literal('a'), notAdjacent({ kinds: ['whitespace'] }), literal('b'))), GAPS)
  par('classified, { kinds: [comment] }',
    parser({ trivia: classified() }, sequence(literal('a'), notAdjacent({ kinds: ['comment'] }), literal('b'))), GAPS)
  par('classified, both kinds',
    parser({ trivia: classified() }, sequence(literal('a'), notAdjacent({ kinds: ['whitespace', 'comment'] }), literal('b'))), GAPS)
})

describe('adjacent — parity', () => {
  par('bare', parser({ trivia: ws }, sequence(literal('a'), adjacent(), literal('b'))), GAPS)
  par('classified', parser({ trivia: classified() }, sequence(literal('a'), adjacent(), literal('b'))), GAPS)
  par('no ambient trivia', sequence(literal('a'), adjacent(), literal('b')), ['ab', 'a b'])
  par('notAdjacent with no ambient trivia', sequence(literal('a'), notAdjacent(), literal('b')), ['ab', 'a b'])
})

const SUMS = ['1 - 2', '1 -2', '1- 2', '1-2', '1/*c*/-/*c*/2', '1 /*c*/- 2', '1  -  2']

describe('sum vs signed number — parity', () => {
  // Distinct objects per position on purpose: reusing ONE `regex()` object in two
  // slots of a left-factored choice hits an unrelated shared-prefix defect that
  // predates this file (see the lane report), and would mask adjacency parity.
  const number = () => regex(/[0-9]+/)
  par('subtraction (separated both sides)',
    parser({ trivia: classified() }, sequence(number(), notAdjacent(), literal('-'), notAdjacent(), number())), SUMS)
  par('signed operand (separated before, glued after)',
    parser({ trivia: classified() }, sequence(number(), notAdjacent(), literal('-'), adjacent(), number())), SUMS)
  par('glued both sides',
    parser({ trivia: classified() }, sequence(number(), adjacent(), literal('-'), adjacent(), number())), SUMS)
  par('calc() rule — real whitespace both sides',
    parser({ trivia: classified() }, sequence(
      number(), notAdjacent({ kinds: ['whitespace'] }), literal('-'), notAdjacent({ kinds: ['whitespace'] }), number(),
    )), SUMS)
  par('ordered choice over all three spacings',
    parser({ trivia: classified() }, choice(
      sequence(number(), notAdjacent(), literal('-'), notAdjacent(), number()),
      sequence(number(), notAdjacent(), literal('-'), adjacent(), number()),
      sequence(number(), adjacent(), literal('-'), adjacent(), number()),
    )), SUMS)
})

describe('adjacency in composite positions — parity', () => {
  par('inside a repeat',
    parser({ trivia: ws }, oneOrMore(sequence(literal('a'), notAdjacent(), literal('b')))),
    ['a b', 'a b a b', 'a bab', 'ab'])
  par('after an optional term',
    parser({ trivia: ws }, sequence(literal('a'), literal('!'), notAdjacent(), literal('b'))),
    ['a! b', 'a!b', 'a ! b'])
})

describe('adjacency inside node() — parity', () => {
  const g = rules({ trivia: ws }, () => ({
    Pair: node('Pair', sequence(literal('a'), notAdjacent(), literal('b')),
      (children, _f, span) => ({ type: 'Pair', n: children.length, span })),
  }))
  const compiledPair = compile(g.Pair)

  for (const input of ['a b', 'ab', 'a  b']) {
    it(`node parity — ${JSON.stringify(input)}`, () => {
      const interpreted = g.Pair.parse(input, 0, { trackLines: false, trivia: ws })
      const emitted = compiledPair.parse(input)
      expect(emitted.ok).toBe(interpreted.ok)
      if (interpreted.ok && emitted.ok) {
        expect(emitted.value).toEqual(interpreted.value)
        expect(emitted.span.end).toBe(interpreted.span.end)
      }
    })
  }
})

describe('kind filtering is a hard error on BOTH sides', () => {
  it('unlabeled trivia + kinds: interpreter throws at parse, compiler throws at compile', () => {
    const g = parser({ trivia: ws }, sequence(literal('a'), notAdjacent({ kinds: ['whitespace'] }), literal('b')))
    expect(() => runtimeParse(g, 'a b')).toThrow(TypeError)
    expect(() => compile(g)).toThrow(TypeError)
  })

  it('unknown kind name: interpreter throws at parse, compiler throws at compile', () => {
    const g = parser({ trivia: classified() }, sequence(literal('a'), notAdjacent({ kinds: ['whitspace'] }), literal('b')))
    expect(() => runtimeParse(g, 'a b')).toThrow(/unknown trivia kind/)
    expect(() => compile(g)).toThrow(/unknown trivia kind/)
  })
})

describe('compiled shape', () => {
  it('emits a kind probe ONLY for a kind-filtered assertion', () => {
    const filtered = parser({ trivia: classified() }, sequence(literal('a'), notAdjacent({ kinds: ['whitespace'] }), literal('b')))
    const plain = parser({ trivia: classified() }, sequence(literal('a'), notAdjacent(), literal('b')))
  })

  it('costs a grammar with no assertion exactly nothing', () => {
    const without = parser({ trivia: ws }, sequence(literal('a'), literal('b')))
    expect(compileCodegen(without).source).not.toContain('_ak')
    expect(compileCodegen(without).source).not.toContain('adjacent')
  })
})
