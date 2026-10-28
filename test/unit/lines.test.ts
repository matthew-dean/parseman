/**
 * `lines(prefix, body, { first, lazy })` parses `body` over a run of lines with a
 * prefix removed from each, and `columns(n)` matches indentation by tab stops.
 * Every grammar here gives the same result through the interpreter, `compile()`,
 * `run()` and the macro build.
 */
import { describe, expect, it } from 'vitest'
import { choice, columns, compile, lines, literal, many, not, optional, peek, regex, rules, run, sequence, sourceOffset, transform } from '../../src/index.ts'
import type { Combinator, LineView, ParseContext } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import { assertMacroCompiled, evalMacroModule } from '../helpers/eval-macro-module.ts'

const ctx = (): ParseContext => ({ trackLines: false })
const blank = regex(/[ \t]*(?:\n|$)/)
// A quote marker after up to three spaces, then one space or one column of a tab.
const quotePrefix = sequence(regex(/ {0,3}>/), optional(choice(literal(' '), columns(1))))
// A lazy line is not blank and opens no quote.
const lazyLine = sequence(not(blank), not(regex(/ {0,3}>/)))

const markdown = rules(g => ({
  Blocks: many(g.Block as Combinator<unknown>),
  Block: choice(
    transform(regex(/[ \t]*\n/), () => null),
    g.Quote as Combinator<unknown>,
    transform(regex(/#[^\n]*\n?/), text => ({ heading: text.trimEnd() })),
    transform(regex(/[^\n>#][^\n]*\n?/), text => text.trimEnd()),
  ),
  Quote: transform(lines(quotePrefix, g.Blocks as Combinator<unknown[]>, { lazy: lazyLine }), blocks => ({ quote: blocks })),
}))
// A paragraph-only body, which leaves a heading line to the grammar outside the run.
const paragraphs = many(transform(regex(/[^\n#][^\n]*\n?/), text => text.trimEnd()))
const shallowQuote = sequence(lines(quotePrefix, paragraphs, { lazy: lazyLine }), optional(regex(/#[^\n]*/)))
// A list item: the marker opens it, and later lines belong while indented two columns.
const item = lines(peek(choice(columns(2), blank)), many(regex(/[^\n]*\n|[^\n]+/)), { first: literal('- ') })

const cases: [string, Combinator<unknown>, string, unknown, number][] = [
  ['a quote with a lazy line, then a paragraph', markdown.Blocks as Combinator<unknown>, '> a\n> b\nc\n\nd', [{ quote: ['a', 'b', 'c'] }, null, 'd'], 12],
  ['a nested quote whose lazy line continues the inner one', markdown.Blocks as Combinator<unknown>, '> > x\n> y\n', [{ quote: [{ quote: ['x', 'y'] }] }], 10],
  ['a blank prefixed line inside a quote', markdown.Blocks as Combinator<unknown>, '> a\n>\n> b', [{ quote: ['a', null, 'b'] }], 9],
  ['a heading inside a quote', markdown.Blocks as Combinator<unknown>, '> # h\n> t', [{ quote: [{ heading: '# h' }, 't'] }], 9],
  ['a body that leaves a lazy line to the outside', shallowQuote, '> a\n# h', [['a'], '# h'], 7],
  ['a list item with an indented line', item, '- a\n  b\nc', ['a\n', '  b\n'], 8],
]

describe('lines()', () => {
  for (const [name, grammar, input, value, end] of cases) {
    it(`${name}: interpreter, compile() and run() agree`, () => {
      const interpreted = grammar.parse(input, 0, ctx())
      expect(interpreted).toMatchObject({ ok: true, value, span: { start: 0, end } })
      expect(compile(grammar).parse(input, 0, ctx())).toEqual(interpreted)
      expect(run(grammar, input)).toMatchObject({ ok: true, value, span: { start: 0, end } })
    })
  }

  it('describes its lines to the body, and maps body offsets back', () => {
    let seen: LineView | undefined
    const capture: Combinator<string> = {
      _tag: 'capture', _meta: { firstSet: { kind: 'any' }, canMatchNewline: true, isTrivia: false }, _def: { tag: 'unknown' },
      parse(input: string, _pos: number, c: ParseContext) { seen = c.lineView; return { ok: true, value: input, span: { start: 0, end: input.length } } },
    }
    const result = lines(quotePrefix, capture, { lazy: lazyLine }).parse('x\n>\t\tfoo\n  > bar\nbaz', 2, ctx())
    expect(result).toMatchObject({ ok: true, value: '\t\tfoo\nbar\nbaz', span: { start: 2, end: 20 } })
    expect(seen!.lines).toEqual([
      // `>` at column 0; the space after it is one column of the tab at column 1.
      { offset: 0, source: 3, end: 8, column: 2, split: 1, lazy: false },
      { offset: 6, source: 13, end: 16, column: 4, split: 0, lazy: false },
      { offset: 10, source: 17, end: 20, column: 0, split: 0, lazy: true },
    ])
    expect(seen!.parent).toBeUndefined()
    expect([0, 2, 6, 11].map(offset => sourceOffset(seen!, offset))).toEqual([3, 5, 13, 18])
  })

  it('counts tab stops from a split tab inside its body', () => {
    // After `>` and one column of the first tab, four columns end inside the second tab.
    const code = lines(quotePrefix, sequence(columns(4), regex(/[^\n]*/)))
    expect(code.parse('>\t\tfoo', 0, ctx())).toMatchObject({ ok: true, value: ['\t', '\tfoo'] })
    expect(compile(code).parse('>\t\tfoo', 0, ctx())).toMatchObject({ ok: true, value: ['\t', '\tfoo'] })
  })

  it('fails where the first line has no prefix, naming the prefix', () => {
    const result = lines(quotePrefix, paragraphs).parse('a\n> b', 0, ctx())
    expect(result).toMatchObject({ ok: false, span: { start: 0, end: 0 } })
    expect(compile(lines(quotePrefix, paragraphs)).parse('a\n> b', 0, ctx()).ok).toBe(false)
  })

  it('keeps each prefix on its own line', () => {
    // `\n>` must not join the first line's prefix: the prefix is matched per line.
    const greedy = lines(regex(/[ \n]*>/), paragraphs)
    expect(greedy.parse('>a\n\n>b', 0, ctx())).toMatchObject({ ok: true, value: ['a'], span: { end: 3 } })
  })
})

describe('columns()', () => {
  it.each([
    ['    x', 4, true, '    '],
    ['\tx', 4, true, '\t'],
    ['  \tx', 4, true, '  \t'],
    ['  x', 4, false, undefined],
    ['\tx', 2, true, ''],
  ])('%j for %d columns', (input, n, ok, value) => {
    const result = columns(n).parse(input, 0, ctx())
    expect(result.ok).toBe(ok)
    if (ok) expect(result.ok && result.value).toBe(value)
    expect(compile(columns(n)).parse(input, 0, ctx()).ok).toBe(ok)
  })
})

describe('the macro build', () => {
  it('compiles lines() and columns() to the same results', () => {
    const source = `
import { rules, sequence, choice, literal, regex, optional, many, not, transform, lines, columns } from 'parseman' with { type: 'macro' }
const blank = regex(/[ \\t]*(?:\\n|$)/)
const quotePrefix = sequence(regex(/ {0,3}>/), optional(choice(literal(' '), columns(1))))
const lazyLine = sequence(not(blank), not(regex(/ {0,3}>/)))
export const grammar = rules(g => ({
  Blocks: many(g.Block),
  Block: choice(transform(regex(/[ \\t]*\\n/), () => null), g.Quote, transform(regex(/[^\\n>][^\\n]*\\n?/), text => text.trimEnd())),
  Quote: transform(lines(quotePrefix, g.Blocks, { lazy: lazyLine }), blocks => ({ quote: blocks })),
}))
`.trim()
    const result = transformMacro(source, 'lines-macro-test.ts', new Set(['parseman']))
    if (!result) throw new Error('macro transform returned null')
    assertMacroCompiled(result.code)
    const grammar = evalMacroModule<Record<string, (input: string, pos: number, c: ParseContext) => unknown>>(result.code, 'grammar')
    expect(grammar.Blocks!('> a\n> > b\nc\n\nd', 0, ctx())).toMatchObject({ ok: true, value: [{ quote: ['a', { quote: ['b', 'c'] }] }, null, 'd'] })
  })
})
