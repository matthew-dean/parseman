import { describe, expect, it } from 'vitest'
import { choice, label, literal, oneOrMore, regex, sequence, trivia } from '../../src/index.ts'
import { createParseContext } from '../../src/parse-context.ts'
import {
  advanceTrivia,
  fastTriviaScanner,
  rollbackLookahead,
  rollbackTriviaAt,
  saveLookaheadMark,
  scanTrivia,
  skipTriviaScanned,
} from '../../src/combinators/trivia-skip.ts'

const labeled = trivia(oneOrMore(choice(
  label('space', regex(/[ \t]+/)),
  label('comment', regex(/\/\*[^]*?\*\//)),
)))

describe('trivia skip branch matrix', () => {
  it('tracks newline ranges on both fast and labelled advance paths', () => {
    const fast = createParseContext()
    fast.trackLines = true
    fast.trivia = trivia(regex(/[ \n]+/))
    fast._lineIndex = { lineStarts: [0] }
    fast._lineScannedTo = 0
    expect(advanceTrivia(' \n x', 0, fast)).toBe(3)
    expect(fast._lineIndex.lineStarts).toEqual([0, 2])

    const classified = createParseContext()
    classified.trackLines = true
    classified.trivia = labeled
    classified.triviaKindLabels = ['space', 'comment']
    classified._lineIndex = { lineStarts: [0] }
    classified._lineScannedTo = 0
    expect(advanceTrivia('  /*x*/z', 0, classified)).toBe(7)
  })

  it('defers and commits labelled global, root, and CST trivia records', () => {
    const ctx = createParseContext()
    ctx.trivia = labeled
    ctx.triviaKindLabels = ['space', 'comment']
    ctx._triviaLog = []
    ctx._rootTriviaLog = []
    ctx._rootTriviaKindIndex = { comment: 0 }
    ctx.captureTrivia = true
    ctx._triviaCaptureMask = 1 << 1
    ctx._cstTriviaLog = []

    const scan = scanTrivia('  /*x*/ z', 0, ctx)
    expect(scan.end).toBe(8)
    expect(ctx._triviaLog).toEqual([])
    scan.commit()
    expect(ctx._triviaLog).toEqual([0, 2, 0, 2, 7, 1, 7, 8, 0])
    expect(ctx._rootTriviaLog).toEqual([0, 8, 2, 7, 0])
    expect(ctx._cstTriviaLog).toEqual([2, 7, 0, 1])
  })

  it('uses the buffered labelled fallback when the repeat minimum exceeds one', () => {
    const twice = trivia(oneOrMore(label('space', regex(/ /)), { min: 2 }))
    const ctx = createParseContext()
    ctx.trivia = twice
    ctx.triviaKindLabels = ['space']
    ctx._triviaLog = []

    expect(scanTrivia(' x', 0, ctx).end).toBe(0)
    const scan = scanTrivia('  x', 0, ctx)
    expect(scan.end).toBe(2)
    scan.commit()
    expect(ctx._triviaLog).toEqual([0, 1, 0, 1, 2, 0])
  })

  it('covers fast and interpreter recording with and without line tracking', () => {
    const cases = [
      { track: false, parser: trivia(regex(/[ \t]+/)), input: '  x', end: 2 },
      { track: true, parser: trivia(regex(/[ \n]+/)), input: ' \nx', end: 2 },
      { track: false, parser: sequence(literal(' '), literal(' ')), input: '  x', end: 2 },
      { track: true, parser: sequence(literal(' '), regex(/\n/)), input: ' \nx', end: 2 },
    ]
    for (const entry of cases) {
      const ctx = createParseContext()
      ctx.trackLines = entry.track
      ctx.trivia = entry.parser
      ctx._triviaLog = []
      if (entry.track) {
        ctx._lineIndex = { lineStarts: [0] }
        ctx._lineScannedTo = 0
      }
      const scan = scanTrivia(entry.input, 0, ctx)
      expect(scan.end).toBe(entry.end)
      scan.commit()
      expect(ctx._triviaLog).toEqual([0, entry.end])
    }
  })

  it('uses labelled end-only paths when no recording sink is active', () => {
    for (const trackLines of [false, true]) {
      const ctx = createParseContext()
      ctx.trackLines = trackLines
      ctx.trivia = labeled
      ctx.triviaKindLabels = ['space', 'comment']
      if (trackLines) {
        ctx._lineIndex = { lineStarts: [0] }
        ctx._lineScannedTo = 0
      }
      const scan = scanTrivia(' /*x*/z', 0, ctx)
      expect(scan.end).toBe(6)
      scan.commit()
    }
  })

  it('installs direct scanners for prefix runs and safe delimiters', () => {
    const patterns = [
      /\/\/[^\n]*/,
      /x[ab]+/,
      /\/\*(?:[^*]|\*(?!\/))*\*\//,
    ]
    const inputs = ['// hello\nx', 'xabba!', '/* hello */x']
    for (let i = 0; i < patterns.length; i++) {
      const p = regex(patterns[i]!)
      const scanner = fastTriviaScanner(p)
      expect(scanner).not.toBeNull()
      expect(scanner!(inputs[i]!, 0)).toBe((patterns[i]!.exec(inputs[i]!)?.[0].length ?? 0))
      expect(scanner!('no match', 0)).toBe(0)
    }
    expect(fastTriviaScanner(regex(/"(?:[^"\\]|\\.)*"/))).toBeNull()
  })

  it('records through an installed scanner and restores scalar/lookahead marks', () => {
    const ctx = createParseContext()
    ctx._triviaLog = []
    ctx.captureTrivia = true
    ctx._cstTriviaLog = []
    const scanner = fastTriviaScanner(regex(/[ ]+/))!
    expect(skipTriviaScanned(scanner, '  x', 0, ctx)).toBe(2)
    expect(ctx._triviaLog).toEqual([0, 2])
    expect(ctx._cstTriviaLog).toEqual([0, 2, 0])

    const mark = saveLookaheadMark(ctx)
    ctx._triviaLog.push(2, 3)
    ctx._cstTriviaLog.push(2, 3, 0)
    ctx._probe = { offset: 0, best: { ok: false, expected: ['new'], span: { start: 2, end: 2 } } }
    rollbackLookahead(ctx, mark)
    expect(ctx._triviaLog).toEqual([0, 2])
    expect(ctx._cstTriviaLog).toEqual([0, 2, 0])
    expect(ctx._probe!.best).toBeNull()

    ctx._triviaLog.push(2, 3)
    ctx._cstTriviaLog.push(2, 3, 0)
    rollbackTriviaAt(ctx, 0, 3, 0, 0, 0, 2, 0)
    expect(ctx._triviaLog).toEqual([0, 2])
    expect(ctx._cstTriviaLog).toEqual([0, 2, 0])
  })
})
