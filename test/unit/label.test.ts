import { describe, it, expect } from 'vitest'
import { regex, choice, oneOrMore, trivia, label, parser, sequence, literal, triviaEntries } from '../../src/index.ts'
import { analyzeLabeledTrivia } from '../../src/cst/trivia-kinds.ts'

describe('label()', () => {
  it('is transparent at parse time', () => {
    const p = label('letters', regex(/a+/))
    expect(p.parse('aaa', 0, { trackLines: false })).toEqual({
      ok: true,
      value: 'aaa',
      span: { start: 0, end: 3 },
    })
  })

  it('preserves label metadata on def', () => {
    const p = label('letters', regex(/a+/))
    expect(p._def.tag === 'label' && p._def.label).toBe('letters')
  })

  it('uses the label as the failure expectation', () => {
    const p = label('letters', regex(/a+/))
    expect(p.parse('123', 0, { trackLines: false })).toMatchObject({
      ok: false,
      expected: ['letters'],
    })
  })

  it('trivia() collects kind labels from labeled choice arms', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('lineComment', regex(/\/\/.*/)),
    )))
    expect(rw._meta.triviaKindLabels).toEqual(['whitespace', 'lineComment'])
    expect(analyzeLabeledTrivia(rw)?.labels).toEqual(['whitespace', 'lineComment'])
  })

  it('triviaEntries resolves kind strings from log', () => {
    const labels = ['whitespace', 'blockComment'] as const
    const log = [1, 2, 0, 3, 10, 1]
    const entries = triviaEntries(log, labels)
    expect(entries.length).toBe(2)
    expect(entries.kind(0)).toBe('whitespace')
    expect(entries.kind(1)).toBe('blockComment')
  })
})
