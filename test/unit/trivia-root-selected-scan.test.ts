import { describe, it, expect } from 'vitest'
import { trivia, label, regex, oneOrMore, choice } from '../../src/index.ts'
import { analyzeLabeledTrivia, type LabeledTriviaSpec } from '../../src/cst/trivia-kinds.ts'
import { skipDeferredTrivia } from '../../src/table/trivia-gap.ts'
import type { Combinator, ParseContext } from '../../src/types.ts'

/*
 * The table engines' deferred-commit trivia skip (`table/trivia-gap.ts`).
 *
 * jess parses with `rootTrivia: { select: [comment labels] }`. That keeps the
 * root trivia log live, so every trivia scan takes the labelled path, which
 * visits the run chunk by chunk to find the selected ones. Only a selected
 * chunk is recorded, so a run in which no character can start a selected arm
 * is answered by its end alone.
 */

const base = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t\n\r\f]+/)),
  label('lineComment', regex(/\/\/[^\n\r]*/)),
  label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
)))

/** The same trivia, its spec's visitor counting the scans that reach it. */
function counted(): { triviaP: Combinator<unknown>; visits: () => number } {
  const spec = analyzeLabeledTrivia(base)!
  let n = 0
  const visitor = spec.visitor!
  const sentinel: LabeledTriviaSpec = {
    ...spec,
    rootKinds: undefined,
    rootLeaders: [],
    rootScan: null,
    visitor: (input, cur, visit) => { n++; return visitor(input, cur, visit) },
  }
  const triviaP = { ...base, _meta: { ...base._meta, labeledTriviaSpec: sentinel } } as Combinator<unknown>
  return { triviaP, visits: () => n }
}

function rootCtx(triviaP: Combinator<unknown>, rootLog: number[]): ParseContext {
  return {
    trackLines: false,
    trivia: triviaP,
    triviaKindLabels: ['whitespace', 'lineComment', 'blockComment'],
    _rootTriviaLog: rootLog,
    _rootTriviaKindIndex: { blockComment: 0 },
  }
}

describe('a labelled scan with only root-selected kinds to record', () => {
  it('answers a run with no selected leader by its end, without visiting it', () => {
    const { triviaP, visits } = counted()
    const rootLog: number[] = []
    const ctx = rootCtx(triviaP, rootLog)
    expect(skipDeferredTrivia(' \n\t x', 0, ctx)).toBe(4)
    expect(skipDeferredTrivia('x', 0, ctx)).toBe(0)
    expect(visits()).toBe(0)
    expect(rootLog).toEqual([])
  })

  it('still visits and records a run that holds a selected chunk', () => {
    const { triviaP, visits } = counted()
    const rootLog: number[] = []
    const ctx = rootCtx(triviaP, rootLog)
    expect(skipDeferredTrivia('  /* c */ x', 0, ctx)).toBe(10)
    expect(visits()).toBe(1)
    expect(rootLog).toEqual([0, 10, 2, 9, 0])
  })

  it('visits a run whose leader starts an unselected chunk, and records nothing', () => {
    const { triviaP, visits } = counted()
    const rootLog: number[] = []
    const ctx = rootCtx(triviaP, rootLog)
    expect(skipDeferredTrivia(' // line\nx', 0, ctx)).toBe(9)
    expect(visits()).toBe(1)
    expect(rootLog).toEqual([])
  })
})

