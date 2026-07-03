import { describe, it, expect } from 'vitest'
import { advanceTrivia, consumeTrivia } from '../../src/combinators/trivia-skip.ts'
import { trivia, label, regex, oneOrMore, choice } from '../../src/index.ts'

const labeledRw = trivia(oneOrMore(choice(
  label('whitespace', regex(/[ \t]+/)),
  label('lineComment', regex(/\/\/.*/)),
)))

describe('advanceTrivia()', () => {
  it('uses labeled scan when ctx.triviaKindLabels is set', () => {
    const ctx = {
      trackLines: false,
      trivia: labeledRw,
      triviaKindLabels: ['whitespace', 'lineComment'],
    }
    expect(advanceTrivia('  x', 0, ctx)).toBe(2)
    expect(advanceTrivia('//cmt\nx', 0, ctx)).toBe(5)
  })
})

describe('consumeTrivia()', () => {
  it('commits deferred trivia into _triviaLog when recording is active', () => {
    const log: number[] = []
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/), _triviaLog: log }
    const end = consumeTrivia('  hi', 0, ctx)
    expect(end).toBe(2)
    expect(log).toEqual([0, 2])
  })
})
