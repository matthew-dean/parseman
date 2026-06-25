import { describe, it, expect } from 'vitest'
import {
  sequence, many, literal, regex, trivia, label, parser, node, compile, rules,
  oneOrMore, choice, triviaEntries,
} from '../../src/index.ts'
import {
  expectTriviaLogParity,
  runTriviaLogParity,
  triviaEntriesFromLog,
} from './helpers/trivia-log-parity.ts'

function labeledRw() {
  return trivia(oneOrMore(choice(
    label('whitespace', regex(/[ \t\n\r\f]+/)),
    label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
  )))
}

const KIND_LABELS = ['whitespace', 'blockComment'] as const

describe('labeled trivia kinds — interpreter vs compiled', () => {
  it('records per-chunk kind indices in _triviaLog', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const a = regex(/a/)
      const b = regex(/b/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(a, many(b))),
        (c, raw, s, tl) => ({ span: s, children: [...c], tl: [...tl] }),
      )
      return { a, b, root }
    })

    const input = 'a /*x*/ b '
    const log: number[] = []
    g.root.parse(input, 0, {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
      _triviaLog: log,
    })

    const entries = triviaEntries(log, KIND_LABELS)
    expect(entries.length).toBe(3)
    expect(entries.kind(0)).toBe('whitespace')
    expect(entries.text(0, input)).toBe(' ')
    expect(entries.kind(1)).toBe('blockComment')
    expect(entries.text(1, input)).toBe('/*x*/')
    expect(entries.kind(2)).toBe('whitespace')
    expect(entries.text(2, input)).toBe(' ')
  })

  it('parity on CSS-like labeled ws + block comments', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const basicSel = regex(/[a-z]+/)
      const compound = node(
        'Compound',
        parser({ trivia: rw }, oneOrMore(r.basicSel)),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      const cx = node(
        'Cx',
        parser({ trivia: rw }, sequence(r.compound, many(sequence(literal('>'), r.compound)))),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      return { basicSel, compound, cx }
    })

    const compiled = compile(g.cx)
    const { iLog, cLog } = runTriviaLogParity(g.cx, compiled, 'a/* { } */> b ', {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
    })
    expectTriviaLogParity(iLog, cLog, KIND_LABELS)

    const interpreted = triviaEntriesFromLog(iLog, KIND_LABELS)
    expect(interpreted.map(e => KIND_LABELS[e.kindIndex!])).toEqual([
      'blockComment',
      'whitespace',
    ])
  })

  it('labeled regex arms (no fast path) still parity', () => {
    const rw = trivia(oneOrMore(choice(
      label('ws', regex(/[ \t]+/)),
      label('line', regex(/\/\/.*/)),
    )))
    const labels = ['ws', 'line'] as const
    const g = rules(r => {
      const tok = regex(/[a-z]+/)
      const root = node(
        'Root',
        parser({ trivia: rw }, sequence(tok, tok)),
        (c, raw, s, tl) => ({ span: s, tl: [...tl], children: [...c] }),
      )
      return { tok, root }
    })

    const compiled = compile(g.root)
    const { iLog, cLog } = runTriviaLogParity(g.root, compiled, 'aa //c\n bb', {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: labels,
    })
    expectTriviaLogParity(iLog, cLog, labels)
  })
})

describe('label() vs node() — no conflict', () => {
  it('node type and trivia label occupy separate namespaces', () => {
    const rw = labeledRw()
    const g = rules(r => {
      const item = regex(/x/)
      const root = node(
        'Expr',
        parser({ trivia: rw }, r.item),
        (c, raw, s, tl) => ({ type: 'Expr', span: s, tl: [...tl], children: [...c] }),
      )
      return { item, root }
    })

    const built = g.root.parse('x', 0, {
      trackLines: false,
      trivia: rw,
      triviaKindLabels: KIND_LABELS,
      _triviaLog: [],
    })
    expect(built.ok && built.value).toMatchObject({ type: 'Expr' })
    expect(rw._meta.triviaKindLabels).toEqual([...KIND_LABELS])
  })
})
