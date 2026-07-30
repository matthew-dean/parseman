import { describe, it, expect } from 'vitest'
import { trivia, label, regex, oneOrMore } from '../../src/index.ts'
import { analyzeLabeledTrivia, triviaKindLabels, scanLabeledTriviaChunks, scanLabeledTriviaEnd, visitLabeledTrivia } from '../../src/cst/trivia-kinds.ts'

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
