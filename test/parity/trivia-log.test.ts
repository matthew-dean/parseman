import { describe, it, expect } from 'vitest'
import {
  sequence, many, optional, literal, regex, trivia, parser, node, compile, rules, peek,
  oneOrMore, choice, not,
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

  it('not() probe does not pollute _triviaLog — a probed region logs its trivia ONCE', () => {
    const rw = trivia(oneOrMore(choice(regex(/[ \t\n\r\f]+/), regex(/\/\*(?:[^*]|\*(?!\/))*\*\//))))
    // Same failure as `peek` above, but `not` leaks it on BOTH engines. The probed
    // body is a MULTI-TERM sequence whose LEADING terms match, so the probe skips —
    // and COMMITS — the trivia between them before its last term fails. `not` is
    // zero-width and succeeds on that failure, so the enclosing sequence then parses
    // the exact same region for real.
    const probed = sequence(literal('a'), literal('b'), literal('z'))
    const body = () => sequence(literal('a'), literal('b'))
    const g = rules(() => {
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(not(probed), body())),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog, interpreted } = runTriviaLogParity(g.root, compiled, 'a /* c */ b')

    expect(interpreted.ok).toBe(true)
    // ONE entry. Pre-fix, BOTH engines logged it twice, as [1, 10, 1, 10]: the
    // interpreter because not()'s rollback mark omitted `_triviaLog`, the compiled
    // `emitNot` because it emitted no rollback of its own at all. Agreeing-but-wrong
    // is why plain interpreted/compiled parity never caught this — hence the GOLDEN
    // assertion alongside the parity one.
    expectTriviaLogGolden(iLog, [1, 10])
    expectTriviaLogParity(iLog, cLog)
  })

  it('not() probe does not leak CST capture when the probed parser SUCCEEDS', () => {
    // The inner-success path: `not` fails, so nothing downstream re-parses — but the
    // probe already pushed a leaf. `optional` swallows the failure without rolling
    // back (codegen classifies `not` as non-capturing, so emitFallible emits no
    // restore), leaving the speculative leaf to ghost into the enclosing node.
    const g = rules(() => {
      const root = node(
        'Root',
        sequence(optional(not(literal('a'))), literal('a')),
        (c, raw, s) => ({ span: s, children: [...c] }),
      )
      return { root }
    })

    const compiled = compile(g.root)
    const leaves: unknown[] = []
    const cLeaves: unknown[] = []
    const interpreted = g.root.parse('a', 0, { trackLines: false, _cstLeaves: leaves })
    const compiledResult = compiled.parseWithContext('a', { trackLines: false, _cstLeaves: cLeaves }, 0)

    expect(interpreted.ok).toBe(true)
    expect(compiledResult.ok).toBe(true)
    if (!interpreted.ok || !compiledResult.ok) return
    // The probe's speculative 'a' must not survive: exactly ONE leaf, the real one.
    const one = [{ _tag: 'leaf', value: 'a', span: { start: 0, end: 1 } }]
    expect(interpreted.value.children).toEqual(one)
    expect(compiledResult.value.children).toEqual(one)
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
