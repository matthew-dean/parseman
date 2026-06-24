import { describe, it, expect } from 'vitest'
import {
  sequence, many, optional, literal, regex, trivia, parser, node, compile, rules,
  oneOrMore, choice,
} from '../../src/index.ts'
import { expectTriviaLogParity, runTriviaLogParity } from './helpers/trivia-log-parity.ts'

describe('trivia log parity — interpreted vs compiled', () => {
  it('sequence zero-progress rollback does not pollute _triviaLog', () => {
    const rw = trivia(regex(/[ \t]+/))
    const g = rules((r: { item: ReturnType<typeof regex> }) => {
      const item = regex(/a/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(item, many(sequence(optional(literal('>')), item)))),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { item, root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog } = runTriviaLogParity(g.root, compiled, 'a a ')
    expectTriviaLogParity(iLog, cLog)
  })

  it('many() rejects trivia-only advances', () => {
    const rw = trivia(regex(/[ \t]+/))
    const g = rules((r: { a: ReturnType<typeof regex>; b: ReturnType<typeof regex> }) => {
      const a = regex(/a/)
      const b = regex(/b/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(a, many(b))),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { a, b, root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog } = runTriviaLogParity(g.root, compiled, 'a b ')
    expectTriviaLogParity(iLog, cLog)
  })

  it('node() grammar matches on CSS-like complex selector', () => {
    const rw = trivia(regex(/[ \t\n\r\f]+|\/\*(?:[^*]|\*(?!\/))*\*\//))
    const basicSel = regex(/(?:[.#]?-?[_a-zA-Z\u0080-\uffff][-_a-zA-Z0-9\u0080-\uffff]*|\d+(?:\.\d+)?%|\*)/)
    const combinator = choice(literal('>'), literal('+'))
    const g = rules(r => {
      const compound = node(
        'Compound',
        parser({ trivia: rw }, oneOrMore(r.basicSel)),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      const cx = node(
        'Cx',
        parser({ trivia: rw }, sequence(r.compound, many(sequence(optional(r.combinator), r.compound)))),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      return { basicSel, combinator, compound, cx }
    })

    const compiled = compile(g.cx)
    const { iLog, cLog } = runTriviaLogParity(g.cx, compiled, 'a/* { } */ b ')
    expectTriviaLogParity(iLog, cLog)
  })
})
