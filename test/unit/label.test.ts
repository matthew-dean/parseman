import { describe, it, expect } from 'vitest'
import { regex, choice, oneOrMore, trivia, label, parser, sequence, literal, triviaEntries } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { analyzeLabeledTrivia } from '../../src/cst/trivia-kinds.ts'
import { analyzeLabeledScannableRun, analyzeTriviaFastPath } from '../../src/compiler/trivia-fast-path.ts'

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

  it('trivia() collects kind labels from labeled choice arms', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('lineComment', regex(/\/\/.*/)),
    )))
    expect(rw._meta.triviaKindLabels).toEqual(['whitespace', 'lineComment'])
    expect(analyzeLabeledTrivia(rw)?.labels).toEqual(['whitespace', 'lineComment'])
  })

  it('fast path (with per-arm kinds) applies to labeled CSS rw', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t\n\r\f]+/)),
      label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
    )))
    expect(analyzeTriviaFastPath(rw)?.map(s => s.kind)).toEqual(['chars', 'delimited'])
    // Every arm is scannable → the char-scan loop carries per-arm kind indices.
    const labeled = analyzeLabeledScannableRun(rw)
    expect(labeled?.map(a => [a.shape.kind, a.kindIndex])).toEqual([['chars', 0], ['delimited', 1]])
  })

  it('compiles labeled scannable trivia with per-chunk kind capture (char-scan, no regex)', () => {
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('blockComment', regex(/\/\*(?:[^*]|\*(?!\/))*\*\//)),
    )))
    const p = parser({ trivia: rw }, sequence(literal('a'), literal('b')))
    const src = compile(p).source
    // labeled scannable loop captures [start=_e, end, kind] per chunk, via char-scan
    // (end is a minted local, so match its shape rather than an exact name).
    expect(src).toMatch(/_ctx\._triviaLog\.push\(_e, \w+, 0\)/)
    expect(src).toMatch(/_ctx\._triviaLog\.push\(_e, \w+, 1\)/)
    expect(src).not.toMatch(/function _tf0[\s\S]*\.exec\(input\)/) // no regex dispatch
  })

  it('falls back to the regex kind loop for a labeled non-scannable arm', () => {
    // `\/\/.*` is not a recognized scannable shape → labeled-regex loop.
    const rw = trivia(oneOrMore(choice(
      label('whitespace', regex(/[ \t]+/)),
      label('lineComment', regex(/\/\/.*/)),
    )))
    const p = parser({ trivia: rw }, sequence(literal('a'), literal('b')))
    const src = compile(p).source
    expect(src).toContain('_triviaLog.push(_e, _ce, 0)')
    expect(src).toContain('_triviaLog.push(_e, _ce, 1)')
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
