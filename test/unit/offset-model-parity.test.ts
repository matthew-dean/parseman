import { describe, it, expect } from 'vitest'
import { rules, node, sequence, many, regex, parser, buildTriviaIndex, buildOffsetIndex, collectLeafSlots, gapText } from '../../src/index.ts'

// A small grammar: a document of space/comment-separated 3-letter idents.
const ident = regex(/[a-z]{3}/)
// A maximal run of whitespace and/or comments = one trivia token, so mixed
// runs like " /* c */ " are consumed as a unit between idents.
const triviaRe = /(?:[ \t\n]+|\/\*[^]*?\*\/)+/
const triviaPat = regex(triviaRe)

// Preserve the CST shape (span + children + rawChildren + triviaLog) so both
// buildTriviaIndex (rawChildren/triviaLog) and buildOffsetIndex (children/span) work.
const mk = (type: string, ch: unknown[], raw: unknown, span: unknown, tl: unknown, state: unknown) =>
  ({ _tag: 'node', type, span, children: ch, rawChildren: raw, triviaLog: tl, state })

const { Ident, Doc } = rules((g) => {
  const Ident = node('Ident', ident, (ch, _fields, span, raw, tl, state) => mk('Ident', ch as unknown[], raw, span, tl, state))
  const Doc = node('Doc', many(g.Ident), (ch, _fields, span, raw, tl, state) => mk('Doc', ch as unknown[], raw, span, tl, state))
  return { Ident, Doc }
})

const docParser = parser({ trivia: triviaPat, captureTrivia: true }, Doc)

describe('OffsetIndex parity with buildTriviaIndex on real parser output', () => {
  const inputs = [
    'abc def',
    'abc  def\nghi',
    'abc /* c */ def',
    '  abc def  ',
    'abc/*x*/def /*y*/ ghi',
    'abc\n\n  def',
  ]

  for (const input of inputs) {
    it(`round-trips exactly: ${JSON.stringify(input)}`, () => {
      const r = docParser.parse(input)
      if (!r.ok) throw new Error('parse failed')
      const root = r.value

      const oi = buildOffsetIndex(root, input)
      const slots = collectLeafSlots(root)

      // Full round-trip: leading gap + (slot + trailing gap)* rebuilds the source.
      let rebuilt = gapText(input, oi.gap(0)!)
      for (let s = 0; s < slots.length; s++) {
        rebuilt += input.slice(slots[s]!.start, slots[s]!.end)
        rebuilt += gapText(input, oi.gap(s + 1)!)
      }
      expect(rebuilt).toBe(input)
    })

    it(`recovers the same before/after trivia text as buildTriviaIndex: ${JSON.stringify(input)}`, () => {
      const r = docParser.parse(input)
      if (!r.ok) throw new Error('parse failed')
      const root = r.value
      const legacy = buildTriviaIndex(root, input, { trivia: triviaRe })
      const oi = buildOffsetIndex(root, input)

      // Every "before" entry in the legacy index: the OffsetIndex gap ending at that
      // offset contains exactly the same concatenated trivia text.
      for (const [offset, runs] of legacy.before) {
        const legacyText = runs.map((t) => t.value).join('')
        const gap = oi.gapBefore(offset)!
        expect(gapText(input, gap)).toBe(legacyText)
      }
      // Every "after" entry: the gap starting at that offset matches.
      for (const [offset, runs] of legacy.after) {
        const legacyText = runs.map((t) => t.value).join('')
        const gap = oi.gapAfter(offset)!
        expect(gapText(input, gap)).toBe(legacyText)
      }
    })
  }
})
