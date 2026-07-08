import { describe, it, expect } from 'vitest'
import { rules, node, sequence, regex, parser, buildTriviaIndex, type Span } from '../../src/index.ts'
import type { CSTLeaf, CSTError, CSTRawChild } from '../../src/index.ts'

type RichNode = {
  _tag: 'node'
  type: string
  span: Span
  state: unknown
  children: unknown[]
  rawChildren: { span: Span }[]
  triviaLog: readonly number[]
}

function mkRich(
  type: string,
  children: ReadonlyArray<RichNode | CSTLeaf | CSTError>,
  rawChildren: ReadonlyArray<CSTRawChild>,
  span: Span,
  triviaLog: readonly number[],
  state: unknown,
): RichNode {
  return {
    _tag: 'node',
    type,
    span,
    state,
    children: [...children],
    rawChildren: [...rawChildren],
    triviaLog,
  }
}

const ident = regex(/[a-z]{3}/)
const triviaPat = regex(/[ \t\n]+|\/\*[^]*?\*\//)

const { Ident, Pair } = rules(g => {
  const Ident = node('Ident', ident, (ch, _fields, span, raw, tl, state) =>
    mkRich('Ident', ch as RichNode[], raw as CSTRawChild[], span, tl, state))
  const Pair = node('Pair', sequence(g.Ident, g.Ident), (ch, _fields, span, raw, tl, state) =>
    mkRich('Pair', ch as RichNode[], raw as CSTRawChild[], span, tl, state))
  return { Ident, Pair }
})

const pairParser = parser({ trivia: triviaPat, captureTrivia: true }, Pair)

describe('buildTriviaIndex', () => {
  it('indexes trivia between two items by surrounding offsets', () => {
    const input = 'foo   bar'
    const r = pairParser.parse(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const index = buildTriviaIndex(r.value, input)
    const before = index.before.get(6)
    expect(before?.map(t => t.value)).toEqual(['   '])
    const after = index.after.get(3)
    expect(after?.map(t => t.value)).toEqual(['   '])
  })

  it('returns empty maps for an adjacent (no-trivia) parse', () => {
    const input = 'foobar'
    const r = pairParser.parse(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const index = buildTriviaIndex(r.value, input)
    expect(index.before.size).toBe(0)
    expect(index.after.size).toBe(0)
  })

  it('captures document-boundary (leading + trailing/pre-EOF) trivia via opts', () => {
    const root = { _tag: 'node', type: 'Root', span: { start: 3, end: 6 }, state: null, children: [], rawChildren: [], triviaLog: [] }
    const input = '   foo /*x*/'
    const trivia = /[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//
    const index = buildTriviaIndex(root, input, { trivia })
    expect(index.before.get(3)?.map(t => t.value)).toEqual(['   '])
    expect(index.after.get(6)?.map(t => t.value)).toEqual([' ', '/*x*/'])
  })
})
