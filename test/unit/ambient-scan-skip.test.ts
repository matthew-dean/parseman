/**
 * Ambient scan-skip — grammar-level `rules({ trivia, scanSkip })` makes a
 * `scanTo` skip comments/whitespace (via ambient trivia) and opaque units like
 * strings (via ambient scanSkip) BY DEFAULT, with no per-call `skip` list. This
 * closes the raw-`scanTo` footgun class: a sentinel hidden inside a string or a
 * comment is never matched.
 *
 * Every headline case is proven across all three execution modes — interpreter
 * (`parse`), `compile()`, and the build-time macro — so the ambient default is
 * baked identically everywhere.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  rules, sequence, literal, regex, parse, compile,
} from '../../src/index.ts'
import { scanTo, balanced } from '../../src/index.ts'

// A double-quoted string and a whitespace-or-block-comment trivia run.
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const triviaWsComment = regex(/(?:[ \t\n\r]+|\/\*[^]*?\*\/)+/)

// One grammar declaring BOTH ambient defaults. `toSemi` / `toOp` carry NO per-call
// skip — they lean entirely on the grammar-level `trivia` + `scanSkip`.
const g = rules({ trivia: triviaWsComment, scanSkip: [dq] }, gg => ({
  // scan to ';' with the full ambient default
  entry: sequence(gg.toSemi, literal(';')),
  toSemi: scanTo(literal(';')),
  // scan to a word-boundaried `or` (the #2021 bootstrap shape: an operator scan)
  entryOp: sequence(gg.toOp, regex(/or/)),
  toOp: scanTo(regex(/\bor\b/)),
  // explicit per-call skip EXTENDS the ambient default (paren group + ambient str)
  entryExt: sequence(gg.toSemiExt, literal(';')),
  toSemiExt: scanTo(literal(';'), { skip: [balanced('(', ')')] }),
  // hard opt-out: raw byte walk, ambient ignored
  entryRaw: sequence(gg.toSemiRaw, literal(';')),
  toSemiRaw: scanTo(literal(';'), { raw: true }),
}))

const compiledEntry = compile(g.entry)
const compiledOp = compile(g.entryOp)

// ---------------------------------------------------------------------------
// Macro mode — the ambient options must survive the build-time compile too.
// ---------------------------------------------------------------------------
type MacroFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroEntry: MacroFn
let macroOp: MacroFn

const MACRO_CODE = `
import { rules, sequence, literal, regex, scanTo } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const triviaWsComment = regex(/(?:[ \\t\\n\\r]+|\\/\\*[^]*?\\*\\/)+/)
export const grammar = rules({ trivia: triviaWsComment, scanSkip: [dq] }, gg => ({
  entry: sequence(gg.toSemi, literal(';')),
  toSemi: scanTo(literal(';')),
  entryOp: sequence(gg.toOp, regex(/or/)),
  toOp: scanTo(regex(/\\bor\\b/)),
}))
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'ambient-scan-skip-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import — compilation failed')
  const fnBody = result.code
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + '\nreturn grammar'
  const grammar = new Function(fnBody)() as Record<string, MacroFn>
  macroEntry = grammar.entry!
  macroOp = grammar.entryOp!
})

// ---------------------------------------------------------------------------
// Headline: sentinel hidden in a string — all three modes agree it is NOT matched
// ---------------------------------------------------------------------------
describe('ambient scanSkip — a sentinel hidden in a string is not matched', () => {
  const INPUT = 'a "x;y" b;'   // the `;` inside "x;y" must be ignored
  const EXPECT = 'a "x;y" b'   // scan lands at the REAL `;` after the string

  it('interpreter', () => {
    const r = parse(g.entry, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })

  it('compile()', () => {
    const r = compiledEntry.parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })

  it('macro', () => {
    const r = macroEntry(INPUT, 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })

  it('all three modes produce the identical scanned span', () => {
    const vals = [
      (parse(g.entry, INPUT) as { value: string[] }).value[0],
      (compiledEntry.parse(INPUT) as { value: string[] }).value[0],
      (macroEntry(INPUT, 0, {}) as { value: string[] }).value[0],
    ]
    expect(new Set(vals).size).toBe(1)
    expect(vals[0]).toBe(EXPECT)
  })
})

// ---------------------------------------------------------------------------
// The exact #2021 bootstrap shape: an operator scan tripped by `or` in a string
// ---------------------------------------------------------------------------
describe('ambient scanSkip — operator scan ignores an operator inside a string (#2021)', () => {
  const INPUT = '"a or b" or c'   // first `or` is inside the string; only the 2nd counts
  const EXPECT = '"a or b" '

  it('interpreter', () => {
    const r = parse(g.entryOp, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
  it('compile()', () => {
    const r = compiledOp.parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
  it('macro', () => {
    const r = macroOp(INPUT, 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
})

// ---------------------------------------------------------------------------
// Ambient trivia — a sentinel hidden in a block comment is not matched
// ---------------------------------------------------------------------------
describe('ambient trivia — a sentinel hidden in a comment is not matched', () => {
  const INPUT = 'a /* ; */ b;'
  const EXPECT = 'a /* ; */ b'

  it('interpreter', () => {
    const r = parse(g.entry, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
  it('compile()', () => {
    const r = compiledEntry.parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
})

// ---------------------------------------------------------------------------
// Explicit per-call skip EXTENDS the ambient default (both apply)
// ---------------------------------------------------------------------------
describe('explicit skip extends the ambient default', () => {
  // a `;` inside a paren group (explicit skip) AND inside a string (ambient) — both ignored
  const INPUT = 'a (;) "y;z" b;'
  const EXPECT = 'a (;) "y;z" b'

  it('interpreter — paren group AND ambient string both protect the sentinel', () => {
    const r = parse(g.entryExt, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
  it('compile() — same', () => {
    const r = compile(g.entryExt).parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe(EXPECT)
  })
})

// ---------------------------------------------------------------------------
// `raw` opt-out — the pre-ambient byte walk still exists for the rare site
// ---------------------------------------------------------------------------
describe('raw opt-out — ambient trivia/scanSkip are ignored', () => {
  const INPUT = 'a "x;y";'   // raw scan STOPS at the first `;`, inside the string

  it('interpreter — raw scan stops inside the string', () => {
    const r = parse(g.entryRaw, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe('a "x')   // stopped mid-string
  })
  it('compile() — same raw behavior', () => {
    const r = compile(g.entryRaw).parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe('a "x')
  })
})

// ---------------------------------------------------------------------------
// No ambient declared → unchanged raw behavior (backward compatibility)
// ---------------------------------------------------------------------------
describe('no grammar-level trivia/scanSkip → scanTo is the raw byte walk', () => {
  const bare = rules(gg => ({
    entry: sequence(gg.toSemi, literal(';')),
    toSemi: scanTo(literal(';')),
  }))

  it('a sentinel inside a string IS matched (no ambient to protect it)', () => {
    const r = parse(bare.entry, 'a "x;y";')
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe('a "x')
  })
})
