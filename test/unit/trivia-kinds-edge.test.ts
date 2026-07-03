import { describe, it, expect } from 'vitest'
import { trivia, label, regex, oneOrMore } from '../../src/index.ts'
import { analyzeLabeledTrivia, triviaKindLabels, scanFastWsCommentsChunks, scanLabeledTriviaChunks } from '../../src/cst/trivia-kinds.ts'

describe('analyzeLabeledTrivia() — single labeled arm', () => {
  it('accepts oneOrMore of a single labeled regex (non-choice shape)', () => {
    const rw = trivia(oneOrMore(label('whitespace', regex(/[ \t]+/))))
    const spec = analyzeLabeledTrivia(rw)
    expect(spec?.labels).toEqual(['whitespace'])
    expect(triviaKindLabels(rw)).toEqual(['whitespace'])
  })
})

describe('scanFastWsCommentsChunks()', () => {
  it('stops at an unterminated block comment without consuming it', () => {
    const { end, chunks } = scanFastWsCommentsChunks('  /* open', 0, 0, 1)
    expect(end).toBe(2)
    expect(chunks).toEqual([{ start: 0, end: 2, kindIndex: 0 }])
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
})
