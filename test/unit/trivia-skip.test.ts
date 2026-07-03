import { describe, it, expect } from 'vitest'
import { advanceTrivia, consumeTrivia, scanTrivia } from '../../src/combinators/trivia-skip.ts'
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

  it('returns the position unchanged when ctx has no trivia parser', () => {
    expect(advanceTrivia('  x', 0, { trackLines: false })).toBe(0)
  })

  it('skips via a plain (unlabeled) trivia parser', () => {
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/) }
    expect(advanceTrivia('   y', 0, ctx)).toBe(3)
    // No trivia at the cursor → position unchanged.
    expect(advanceTrivia('y', 0, ctx)).toBe(0)
  })
})

describe('scanTrivia()', () => {
  it('returns a no-op scan when ctx has no trivia parser', () => {
    const scan = scanTrivia('  x', 0, { trackLines: false })
    expect(scan.end).toBe(0)
    expect(() => scan.commit()).not.toThrow()
  })
})

describe('consumeTrivia() — non-deferred', () => {
  it('advances directly when no trivia recording is active', () => {
    const ctx = { trackLines: false, trivia: regex(/[ \t]+/) }
    expect(consumeTrivia('   z', 0, ctx)).toBe(3)
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
