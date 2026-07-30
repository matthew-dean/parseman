import { describe, it, expect } from 'vitest'
import { trivia, label, regex, oneOrMore } from '../../src/index.ts'
import { analyzeLabeledTrivia, triviaKindLabels, scanLabeledTriviaChunks, scanLabeledTriviaEnd, visitLabeledTrivia, recordTriviaChunks } from '../../src/cst/trivia-kinds.ts'
import type { ParseContext } from '../../src/types.ts'

describe('analyzeLabeledTrivia() — single labeled arm', () => {
  it('accepts oneOrMore of a single labeled regex (non-choice shape)', () => {
    const rw = trivia(oneOrMore(label('whitespace', regex(/[ \t]+/))))
    const spec = analyzeLabeledTrivia(rw)
    expect(spec?.labels).toEqual(['whitespace'])
    expect(triviaKindLabels(rw)).toEqual(['whitespace'])
  })
})

describe('scanLabeledTriviaChunks()', () => {
  it('returns no chunks when fewer than minRepeats matched', () => {
    const spec = {
      labels: ['ws'],
      arms: [{ label: 'ws', kindIndex: 0, parser: regex(/[ \t]+/) }],
      minRepeats: 2,
    }
    const { end, chunks } = scanLabeledTriviaChunks(' x', 0, spec)
    expect(end).toBe(0)
    expect(chunks).toEqual([])
  })

  it('finds the same end without constructing chunk records when no capture is requested', () => {
    const spec = {
      labels: ['ws', 'annotation'],
      arms: [
        { label: 'ws', kindIndex: 0, parser: regex(/[ \t]+/) },
        { label: 'annotation', kindIndex: 1, parser: regex(/#[^\n]*/) },
      ],
      minRepeats: 1,
    }
    const input = ' \t# note\nx'
    const end = input.indexOf('\n')
    expect(scanLabeledTriviaEnd(input, 0, spec)).toBe(end)
    expect(scanLabeledTriviaChunks(input, 0, spec).end).toBe(end)
  })

  it('visits only retained matches while keeping the recognition scan object-free', () => {
    const spec = {
      labels: ['ws', 'comment'],
      arms: [
        { label: 'ws', kindIndex: 0, parser: regex(/[ \t]+/) },
        { label: 'comment', kindIndex: 1, parser: regex(/\/\*[^]*?\*\//) },
      ],
      minRepeats: 1,
    }
    const retained: number[] = []
    const end = visitLabeledTrivia(' /*x*/ ', 0, spec, undefined, (start, matchEnd, kind) => {
      if (kind === 1) retained.push(start, matchEnd)
    })
    expect(end).toBe(7)
    expect(retained).toEqual([1, 6])
  })
})

describe('recordTriviaChunks()', () => {
  it('records selected markers with their shared complete trivia gap', () => {
    const rootLog: number[] = []
    const fullLog: number[] = []
    const cstLog: number[] = []
    const ctx: ParseContext = {
      trackLines: false,
      triviaKindLabels: ['whitespace', 'annotation'],
      _triviaLog: fullLog,
      _rootTriviaLog: rootLog,
      _rootTriviaKindIndex: { annotation: 0 },
      captureTrivia: true,
      _cstTriviaLog: cstLog,
    }

    recordTriviaChunks(ctx, [
      { start: 4, end: 5, kindIndex: 0 },
      { start: 5, end: 12, kindIndex: 1 },
      { start: 12, end: 13, kindIndex: 0 },
    ])

    expect(fullLog).toEqual([4, 5, 0, 5, 12, 1, 12, 13, 0])
    expect(rootLog).toEqual([4, 13, 5, 12, 0])
    expect(cstLog).toEqual([4, 5, 0, 0, 5, 12, 0, 1, 12, 13, 0, 0])
  })

  it('does not write a root marker when its scope is opaque', () => {
    const rootLog: number[] = []
    const ctx: ParseContext = {
      trackLines: false,
      triviaKindLabels: ['annotation'],
      _rootTriviaLog: rootLog,
      _rootTriviaKindIndex: { annotation: 0 },
      _rootTriviaCapture: false,
    }

    recordTriviaChunks(ctx, [{ start: 0, end: 7, kindIndex: 0 }])

    expect(rootLog).toEqual([])
  })
})
