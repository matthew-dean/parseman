import { describe, it, expect } from 'vitest'
import {
  sequence, many, optional, literal, regex, trivia, parser, node, compile, rules, peek,
  oneOrMore, choice,
} from '../../src/index.ts'
import { expectTriviaLogGolden, expectTriviaLogParity, runTriviaLogParity } from './helpers/trivia-log-parity.ts'

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

  it('peek() probe does not pollute _triviaLog — a probed region logs its trivia ONCE', () => {
    const rw = trivia(oneOrMore(choice(regex(/[ \t\n\r\f]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))))
    // The probed body is a MULTI-TERM sequence, so the probe itself skips — and
    // COMMITS — the trivia between its terms. `peek` is zero-width, so the enclosing
    // sequence then parses that exact region for real. A probe that rolls back CST
    // capture but not the global `_triviaLog` logs the span twice.
    const body = () => sequence(literal('a'), literal('b'))
    const g = rules(() => {
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(peek(body()), body())),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog, interpreted } = runTriviaLogParity(g.root, compiled, 'a /* c */ b')

    expect(interpreted.ok).toBe(true)
    // ONE entry: [1, 10) is ` /* c */ ` — consecutive trivia coalesces into a single
    // span. The pre-fix interpreter logged it twice, as [1, 10, 1, 10].
    expectTriviaLogGolden(iLog, [1, 10])
    // Compiled emits the peek body under a non-capturing ctx, so it never logged the
    // probe at all — parity is what the interpreter's missing rollback broke.
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
