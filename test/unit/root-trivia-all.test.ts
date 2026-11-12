/**
 * `run(entry, input, { rootTrivia: { select: 'all' } })`: the document's whole trivia
 * log, the one `ParseContext._triviaLog` carried before 0.62.0.
 *
 * Every labelled trivia chunk is a row under its label; every gap of unlabelled trivia
 * is one row under `''`, the last entry of `select`. The label table is the grammar's
 * own, carried on the entry from compile time. Every engine records the same rows: the
 * interpreter, and each table reader (reference, closure, emitted, hybrid).
 */
import { describe, expect, it } from 'vitest'
import {
  choice, classifiedTrivia, compile, lines, literal, many, node, parser, ref, regex, rules, sequence, trivia,
  type Combinator,
} from '../../src/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { hybridReaders, readers } from '../helpers/table-readers.ts'

type G = Record<string, Combinator<unknown>>
const ALL = { rootTrivia: { select: 'all' } } as const

const plain = (): Combinator<unknown> => trivia(regex(/(?:[ \n]+|\/\*[^*]*\*\/)+/))
const classified = (): Combinator<unknown> =>
  classifiedTrivia({ whitespace: regex(/[ \n]+/), comment: regex(/\/\*[^*]*\*\//) })

/** What a run's root trivia says: its rows (as numbers to compare), and the labels they index. */
const capture = (r: ReturnType<typeof run>): object =>
  ({ rows: r.rootTrivia === undefined ? undefined : [...r.rootTrivia.rows], select: r.rootTrivia?.select })

/** `[markerStart, markerEnd, label]` per row, after checking every engine agrees on the rows. */
function allRows(g: G, input: string): Array<[number, number, string]> {
  const want = run(g['R']!, input, ALL)
  expect(want.ok).toBe(true)
  const prog = encodeTable(g)
  for (const [name, table] of [...readers(prog), ...hybridReaders(prog)]) {
    const r = run(table['R']!, input, ALL)
    expect(capture(r), name).toEqual(capture(want))
  }
  const rows = want.rootTrivia?.rows ?? []
  const select = want.rootTrivia?.select ?? []
  const out: Array<[number, number, string]> = []
  for (let i = 0; i < rows.length; i += 5) out.push([rows[i + 2]!, rows[i + 3]!, select[rows[i + 4]!]!])
  return out
}

describe("rootTrivia: { select: 'all' }", () => {
  it('records each gap of unlabelled trivia as one row under the empty label', () => {
    const g = rules({ trivia: plain() }, () => ({ R: node('R', sequence(literal('a'), literal('b'), literal('c'))) })) as G
    const input = 'a /*1*/ b\n\nc'
    expect(run(g['R']!, input, ALL).rootTrivia?.select).toEqual([''])
    expect(allRows(g, input)).toEqual([[1, 8, ''], [9, 11, '']])
    const rows = run(g['R']!, input, ALL).rootTrivia!.rows
    expect(rows.slice(0, 5)).toEqual(Int32Array.of(1, 8, 1, 8, 0))
  })

  it('records every labelled chunk under its label, whitespace included', () => {
    const g = rules({ trivia: classified() }, () => ({ R: node('R', sequence(literal('a'), literal('b'))) })) as G
    const input = 'a /*1*/ b'
    expect(run(g['R']!, input, ALL).rootTrivia?.select).toEqual(['whitespace', 'comment', ''])
    expect(allRows(g, input)).toEqual([[1, 2, 'whitespace'], [2, 7, 'comment'], [7, 8, 'whitespace']])
    // Each row carries the gap that owns it, as a label list's rows do.
    expect(run(g['R']!, input, ALL).rootTrivia!.rows.slice(5, 10)).toEqual(Int32Array.of(1, 8, 2, 7, 1))
    expect(run(g['R']!, input, { rootTrivia: { select: ['comment'] } }).rootTrivia!.rows).toEqual(Int32Array.of(1, 8, 2, 7, 0))
  })

  it('names a chunk by its label in a scope that orders the labels differently', () => {
    const reordered = classifiedTrivia({ comment: regex(/\/\*[^*]*\*\//), whitespace: regex(/[ \n]+/) })
    const g = rules({ trivia: classified() }, () => ({
      R: node('R', sequence(literal('a'), parser({ trivia: reordered }, sequence(literal('b'), literal('c'))))),
    })) as G
    expect(allRows(g, 'a b/*1*/c')).toEqual([[1, 2, 'whitespace'], [3, 8, 'comment']])
  })

  it('takes its labels from the scopes reachable from the entry, in every engine', () => {
    const line = classifiedTrivia({ whitespace: regex(/[ \n]+/), lineComment: regex(/\/\/[^\n]*/) })
    const aside = classifiedTrivia({ whitespace: regex(/[ \n]+/), aComment: regex(/#[^\n]*/) })
    const g = rules({ trivia: classified() }, () => ({
      Used: sequence(literal('a'), parser({ trivia: line }, sequence(literal('b'), literal('c')))),
      Unused: sequence(literal('x'), parser({ trivia: aside }, sequence(literal('y'), literal('z')))),
    })) as G
    const input = 'a b//x\nc'
    const select = ['whitespace', 'comment', 'lineComment', '']
    expect(run(g['Used']!, input, ALL).rootTrivia?.select).toEqual(select)
    expect(run(compile(g['Used']!), input, ALL).rootTrivia?.select).toEqual(select)
    const prog = encodeTable(g)
    for (const [name, table] of [...readers(prog), ...hybridReaders(prog)]) {
      const r = run(table['Used']!, input, ALL)
      expect(r.rootTrivia?.select, name).toEqual(select)
      expect(r.rootTrivia?.rows.slice(5, 10), name).toEqual(Int32Array.of(3, 7, 3, 6, 2))
    }
  })

  it('takes the labels of a scope inside a lines() body, in every engine', () => {
    const inline = classifiedTrivia({ whitespace: regex(/[ \n]+/), note: regex(/\/\*[^*]*\*\//) })
    const g = rules({ trivia: classified() }, () => ({
      R: lines(literal('>'), parser({ trivia: inline }, sequence(literal('a'), literal('b')))),
    })) as G
    const want = { rows: [1, 6, 1, 6, 2], select: ['whitespace', 'comment', 'note', ''] }
    // A `lines()` body parses the line's content, so its rows are in content offsets.
    expect(capture(run(g['R']!, '>a/*c*/b', ALL))).toEqual(want)
    expect(capture(run(compile(g['R']!), '>a/*c*/b', ALL))).toEqual(want)
    const prog = encodeTable(g)
    // `readers()`'s plain emitted leg links no scan subtrees, so it cannot run `lines()`;
    // the hybrid legs do, `Infinity` with every site emitted.
    for (const [name, table] of [...readers(prog).filter(([n]) => n !== 'emitted'), ...hybridReaders(prog)]) {
      expect(capture(run(table['R']!, '>a/*c*/b', ALL)), name).toEqual(want)
    }
  })

  it('joins the root labels of each run, so a second run with other root trivia names its own', () => {
    const nested = classifiedTrivia({ whitespace: regex(/[ \n]+/), note: regex(/#[^\n]*/) })
    const entry = sequence(literal('a'), parser({ trivia: nested }, sequence(literal('b'), literal('c'))))
    const block = classifiedTrivia({ whitespace: regex(/[ \n]+/), comment: regex(/\/\*[^*]*\*\//) })
    const line = classifiedTrivia({ whitespace: regex(/[ \n]+/), lineComment: regex(/\/\/[^\n]*/) })
    for (const e of [entry, compile(entry)]) {
      expect(run(e, 'ab#x\nc', { ...ALL, trivia: block }).rootTrivia?.select).toEqual(['whitespace', 'comment', 'note', ''])
      expect(run(e, 'ab#x\nc', { ...ALL, trivia: line }).rootTrivia?.select).toEqual(['whitespace', 'lineComment', 'note', ''])
    }
  })

  it('walks past a rule reference that does not resolve, in a branch the parse never enters', () => {
    const missing = ref<unknown>()
    const g = rules({ trivia: classified() }, () => ({
      R: choice(sequence(literal('a'), literal('c')), sequence(literal('b'), missing)),
    })) as G
    expect(capture(run(g['R']!, 'a/*1*/c', ALL))).toEqual({ rows: [1, 6, 1, 6, 1], select: ['whitespace', 'comment', ''] })
  })

  it('returns its rows as an Int32Array of exactly the rows kept, past the log\'s first growth', () => {
    const g = rules({ trivia: plain() }, () => ({ R: node('R', many(literal('a'))) })) as G
    const input = Array.from({ length: 200 }, () => 'a').join(' ')
    const want: number[] = []
    for (let i = 1; i < 200; i++) want.push(2 * i - 1, 2 * i, 2 * i - 1, 2 * i, 0)
    expect(allRows(g, input)).toHaveLength(199)
    const rows = run(g['R']!, input, ALL).rootTrivia!.rows
    expect(rows).toBeInstanceOf(Int32Array)
    expect(rows).toEqual(Int32Array.from(want))
  })

  it('keeps no row for trivia a failed alternative scanned', () => {
    const g = rules({ trivia: plain() }, () => ({
      R: choice(sequence(literal('a'), literal('x')), sequence(literal('a'), literal('y'))),
    })) as G
    expect(allRows(g, 'a /*1*/ y')).toEqual([[1, 8, '']])
  })

  it('records inside a region declared opaque to root capture, as a label list does not', () => {
    const g = rules({ trivia: classified() }, () => ({
      R: sequence(parser({ trivia: classified(), rootCapture: 'opaque' }, sequence(literal('a'), literal('b'))), literal('c')),
    })) as G
    const input = 'a /*1*/ b /*2*/ c'
    expect(allRows(g, input)).toEqual([
      [1, 2, 'whitespace'], [2, 7, 'comment'], [7, 8, 'whitespace'],
      [9, 10, 'whitespace'], [10, 15, 'comment'], [15, 16, 'whitespace'],
    ])
    expect(run(g['R']!, input, { rootTrivia: { select: ['comment'] } }).rootTrivia!.rows).toEqual(Int32Array.of(9, 16, 10, 15, 0))
  })

  it('names a label only a nested scope uses', () => {
    const nested = classifiedTrivia({ whitespace: regex(/[ \n]+/), lineComment: regex(/\/\/[^\n]*/) })
    const g = rules({ trivia: classified() }, () => ({
      R: node('R', sequence(literal('a'), parser({ trivia: nested }, sequence(literal('b'), literal('c'))))),
    })) as G
    expect(run(g['R']!, 'a b//x\nc', ALL).rootTrivia?.select).toEqual(['whitespace', 'comment', 'lineComment', ''])
    expect(allRows(g, 'a b//x\nc')).toEqual([[1, 2, 'whitespace'], [3, 6, 'lineComment'], [6, 7, 'whitespace']])
  })

  it('runs a compile() result as its entry rule', () => {
    const g = rules({ trivia: classified() }, () => ({ R: node('R', sequence(literal('a'), literal('b'))) })) as G
    const compiled = compile(g['R']!)
    expect(capture(run(compiled, 'a /*1*/ b', ALL))).toEqual(capture(run(g['R']!, 'a /*1*/ b', ALL)))
  })

  it('leaves a label list as it was: unlabelled trivia has no label to select', () => {
    const g = rules({ trivia: plain() }, () => ({ R: sequence(literal('a'), literal('b')) })) as G
    expect(() => run(g['R']!, 'a b', { rootTrivia: { select: ['comment'] } }))
      .toThrow('run(): rootTrivia.select requires labeled grammar trivia.')
  })
})

describe('a ParseContext that passes the removed _triviaLog', () => {
  it('is refused at the start of a compiled parse, not ignored', () => {
    const compiled = compile(rules({ trivia: plain() }, () => ({ R: sequence(literal('a'), literal('b')) }))['R']!)
    const ctx = { trackLines: false, _triviaLog: [] } as unknown as Parameters<typeof compiled.parseWithContext>[1]
    expect(() => compiled.parseWithContext('a b', ctx, 0)).toThrow(/_triviaLog was removed in 0\.62\.0.*select: 'all'/)
    expect(() => compiled.parse('a b', 0, ctx)).toThrow(/_triviaLog was removed in 0\.62\.0/)
  })
})
