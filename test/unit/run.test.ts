/**
 * `run()` — the generic "invoke a grammar entry and collect the raw outcome"
 * driver, so a consumer doesn't hand-build ctx, branch fn-vs-combinator, or scan
 * for leftover input. Works on BOTH the interpreter (combinators) and the
 * compiled map (bare functions), and reports leftover after skipping the
 * grammar's own trivia.
 */
import { describe, it, expect } from 'vitest'
import { rules, regex, many, choice, parser, trivia, classifiedTrivia, node, sequence, literal, compile, run, label, oneOrMore } from '../../src/index.ts'

const blockTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//))))
const lineTrivia = trivia(many(choice(regex(/[ \t\n]+/), regex(/\/\*[^]*?\*\//), regex(/\/\/[^\n]*/))))

describe('run() — generic grammar-entry driver', () => {
  const g = rules(gg => ({ Doc: parser({ trivia: blockTrivia }, many(gg.W)), W: node('W', regex(/[a-z]+/)) }))

  it('invokes an interpreter combinator and reports full consumption', () => {
    const r = run(g.Doc as never, 'a b c')
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
  })

  it('invokes a compiled function entry the same way', () => {
    const c = compile(g.Doc)
    const r = run(c.parse as never, 'a b c')
    expect(r.ok).toBe(true)
    expect(r.unconsumedFrom).toBe(null)
  })

  it('retains no root trivia for compiled non-node parser() roots unless requested', () => {
    const rw = trivia(regex(/[ \t]+/))
    const root = parser({ trivia: rw }, sequence(literal('a'), literal('b')))
    const compiled = compile(root)
    const entry = (input: string, pos: number, ctx: import('../../src/index.ts').ParseContext) =>
      compiled.parseWithContext(input, ctx, pos)

    const interpreted = run(root as never, 'a b ', { trivia: rw as never })
    const compiledResult = run(entry, 'a b ', { trivia: rw as never })

    expect(interpreted.ok).toBe(true)
    expect(compiledResult.ok).toBe(true)
    expect(interpreted.rootTrivia).toBeUndefined()
    expect(compiledResult.rootTrivia).toBeUndefined()
    expect(compiledResult.unconsumedFrom).toBe(null)
  })

  it('decodes labeled root trivia gaps for compiled non-node parser() roots', () => {
    const rw = classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    const root = parser({ trivia: rw }, sequence(literal('a'), literal('b')))
    const compiled = compile(root)
    const entry = (input: string, pos: number, ctx: import('../../src/index.ts').ParseContext) =>
      compiled.parseWithContext(input, ctx, pos)
    const input = 'a /*x*/ b'

    const result = run(entry, input, { trivia: rw as never, rootTrivia: { select: ['blockComment'] } })

    expect(result.ok).toBe(true)
    expect(result.rootTrivia?.rows).toEqual([1, 8, 2, 7, 0])
    expect(result.rootTrivia?.select).toEqual(['blockComment'])
    expect(result.rootTrivia?.index.entries.kind(0)).toBe('blockComment')
    expect(result.rootTrivia?.index.gapAfter(1)?.entryIndices).toEqual([0])
    expect(result.rootTrivia?.index.gapAfter(1)?.text(input)).toBe(' /*x*/ ')
    expect(result.rootTrivia?.index.gapBefore(8)?.hasKind('blockComment')).toBe(true)
    expect(result.rootTrivia?.index.gapBefore(8)?.text(input)).toBe(' /*x*/ ')
  })

  it('does not fill CST trivia buffers for non-node root trivia logging', () => {
    const rw = trivia(regex(/[ \t]+/))
    const root = parser({ trivia: rw }, sequence(literal('a'), literal('b')))
    const compiled = compile(root)
    const triviaLog: number[] = []
    const cstTriviaLog: number[] = []
    const rawChildren: unknown[] = []

    const result = compiled.parseWithContext('a b', {
      trackLines: false,
      _triviaLog: triviaLog,
      _cstTriviaLog: cstTriviaLog,
      _cstRawChildren: rawChildren,
      captureTrivia: true,
    }, 0)

    expect(result.ok).toBe(true)
    expect(triviaLog).toEqual([1, 2])
    expect(cstTriviaLog).toEqual([])
    expect(rawChildren).toEqual([])
  })

  it('reports leftover at the first non-trivia offset', () => {
    // `!` is not a word and not trivia → leftover after "a b ".
    const r = run(g.Doc as never, 'a b !', { trivia: blockTrivia as never })
    expect(r.unconsumedFrom).toBe(4)
  })

  it('trailing trivia is NOT leftover (dialect encoded by which trivia is passed)', () => {
    const src = 'a b // tail\n'
    // CSS-style trivia: `//` is not trivia → leftover at the `//`.
    expect(run(g.Doc as never, src, { trivia: blockTrivia as never }).unconsumedFrom).toBe(4)
    // Less-style trivia: `//` line comment IS trivia → fully consumed.
    expect(run(g.Doc as never, src, { trivia: lineTrivia as never }).unconsumedFrom).toBe(null)
  })

  it('surfaces an unterminated comment as leftover at its start', () => {
    const r = run(g.Doc as never, 'a /* oops', { trivia: blockTrivia as never })
    expect(r.unconsumedFrom).toBe(2)   // the unterminated comment never matches trivia
  })

  it('threads the ctx.build host to structural node() rules', () => {
    const built: string[] = []
    const r = run(g.Doc as never, 'a', { build: (type: string) => { built.push(type); return { type } } })
    expect(r.ok).toBe(true)
    expect(built).toContain('W')
  })

  it('throws a clear TypeError when the start production is not a rule', () => {
    // e.g. a missing grammar rule: `grammar[name]` came back undefined.
    expect(() => run(undefined as never, 'a b c')).toThrow(TypeError)
    expect(() => run(undefined as never, 'a b c')).toThrow(/not a rule|does not exist/)
    // A valid entry still parses — no regression.
    expect(run(g.Doc as never, 'a b c').ok).toBe(true)
  })

  /* The `run({ profile: true })` pin is gone with the option. It asserted that the
   * three-pass profiling boundary threw rather than reporting an all-zero profile;
   * the option itself is now removed from `RunOptions`, so there is nothing left to
   * call. See docs/future/bench-typecheck-followups.md for what restoring it takes. */

  it('exposes a lazy selected-root trivia index only on demand', () => {
    const rw = classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    const doc = parser({ trivia: rw }, sequence(regex(/a/), regex(/b/)))
    const input = 'a /*x*/ b'

    const result = run(doc as never, input, { rootTrivia: { select: ['blockComment'] } })

    expect(result.ok).toBe(true)
    expect(result.rootTrivia?.index.entryIndicesAfter(1)).toEqual([0])
    expect(result.rootTrivia?.index.entryIndicesBefore(8)).toEqual([0])
    expect(result.rootTrivia?.index.entries.kind(0)).toBe('blockComment')
    expect(result.rootTrivia?.index.entries.text(0, input)).toBe('/*x*/')
  })

  it('can label a compiled parseWithContext root trivia map from opts.trivia', () => {
    const rw = classifiedTrivia({
      whitespace: regex(/[ \t\n\r\f]+/),
      blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
    })
    const doc = node('Doc', parser({ trivia: rw }, sequence(regex(/a/), regex(/b/))))
    const compiled = compile(doc)
    const entry = (input: string, pos: number, ctx: import('../../src/index.ts').ParseContext) =>
      compiled.parseWithContext(input, ctx, pos)

    const result = run(entry, 'a /*x*/ b', { trivia: rw as never, rootTrivia: { select: ['blockComment'] } })

    expect(result.ok).toBe(true)
    expect(result.rootTrivia?.index.entryIndicesBefore(8)).toEqual([0])
  })
})
