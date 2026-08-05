import { describe, it, expect } from 'vitest'
import { classifiedTrivia, regex } from '../../src/index.ts'
import { analyzeLabeledTrivia, scanLabeledTriviaEnd, visitLabeledTrivia, triviaKindMaskAt } from '../../src/cst/trivia-kinds.ts'
import { charArmsFor } from '../../src/cst/trivia-charscan.ts'
import { createDetachedParseContext } from '../../src/parse-context.ts'
import type { LabeledTriviaSpec } from '../../src/cst/trivia-kinds.ts'

/** The exact arm set jess's four grammars lower to. */
function cssLikeSpec(): LabeledTriviaSpec {
  const t = classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    lineComment: regex(/\/\/[^\n\r]*/),
    blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })
  return analyzeLabeledTrivia(t)!
}

describe('char-level labelled trivia — lowering', () => {
  it('lowers whitespace, line-comment and block-comment arms', () => {
    const arms = charArmsFor(cssLikeSpec())
    expect(arms).not.toBeNull()
    expect(arms!.length).toBe(3)
  })

  it('lowers an arm that is itself a whole alternation-plus', () => {
    const t = classifiedTrivia({ whitespace: regex(/(?:(?:[ \t]+)|(?:\/\/[^\n\r]*)|(?:\/\*(?:[^*]|\*(?!\/))*\*\/))+/) })
    expect(charArmsFor(analyzeLabeledTrivia(t)!)).not.toBeNull()
  })

  it('refuses an arm it cannot classify rather than guessing', () => {
    const t = classifiedTrivia({ weird: regex(/[ \t]+|x{2,4}/) })
    expect(charArmsFor(analyzeLabeledTrivia(t)!)).toBeNull()
  })

  it('refuses a flagged arm', () => {
    const t = classifiedTrivia({ ws: regex(/[ \t]+/i) })
    expect(charArmsFor(analyzeLabeledTrivia(t)!)).toBeNull()
  })

  it('refuses a minimum above one, whose failure it could not report', () => {
    const spec: LabeledTriviaSpec = { ...cssLikeSpec(), minRepeats: 2 }
    expect(charArmsFor(spec)).toBeNull()
  })
})

describe('char-level labelled trivia — agreement with the arms it replaces', () => {
  const cases: Array<[string, string]> = [
    ['nothing', 'a'],
    ['one space', ' a'],
    ['mixed run', ' \t\n  a'],
    ['line comment', '// hi\na'],
    ['line comment at EOF', '// hi'],
    ['block comment', '/* hi */a'],
    ['empty block comment', '/**/a'],
    ['stars inside a block comment', '/***/a'],
    ['star runs', '/* * ** */a'],
    ['unterminated block comment', '/* hi'],
    ['a lone slash', '/a'],
    ['slash then star at EOF', '/*'],
    ['comment then space then comment', '/*x*/ //y\n/*z*/a'],
    ['CRLF', '\r\n\r\na'],
    ['empty input', ''],
  ]

  for (const [name, input] of cases) {
    it(`agrees on ${name}`, () => {
      const spec = cssLikeSpec()
      const arms = charArmsFor(spec)!
      const bare: LabeledTriviaSpec = { labels: spec.labels, arms: spec.arms, minRepeats: spec.minRepeats }
      // `bare` is a fresh spec object, so it takes the combinator path.
      expect(charArmsFor(spec)).not.toBeNull()
      for (let pos = 0; pos <= input.length; pos++) {
        const got: Array<[number, number, number]> = []
        const gotEnd = visitLabeledTrivia(input, pos, spec, undefined, (s, e, k) => { got.push([s, e, k]) })
        const want: Array<[number, number, number]> = []
        const wantEnd = visitLabeledTriviaViaCombinators(input, pos, bare, want)
        expect([name, pos, gotEnd, got]).toEqual([name, pos, wantEnd, want])
        expect(scanLabeledTriviaEnd(input, pos, spec)).toBe(wantEnd)
        expect(triviaKindMaskAt(input, pos, spec)).toBe(want.reduce((m, r) => m | (1 << r[2]), 0))
      }
      expect(arms.length).toBe(3)
    })
  }
})

/**
 * The combinator reference, spelled out here rather than reached through the
 * production path — a test that lets the fast path answer for both sides proves
 * nothing.
 */
function visitLabeledTriviaViaCombinators(
  input: string,
  cur: number,
  spec: LabeledTriviaSpec,
  out: Array<[number, number, number]>,
): number {
  let pos = cur
  scan: while (pos < input.length) {
    for (const arm of spec.arms) {
      const r = arm.parser.parse(input, pos, createDetachedParseContext(false, undefined))
      if (r.ok && r.span.end > pos) {
        out.push([pos, r.span.end, arm.kindIndex])
        pos = r.span.end
        continue scan
      }
    }
    break
  }
  return pos
}
