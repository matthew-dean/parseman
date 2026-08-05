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
import { assertMacroCompiled, evalMacroModule } from '../helpers/eval-macro-module.ts'
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
  // balanced() must consult the ambient scanSkip in its INTERIOR too — a
  // delimiter hidden inside a string must not close the balance early.
  group: balanced('(', ')'),
}))

const compiledEntry = compile(g.entry)
const compiledOp = compile(g.entryOp)
const compiledGroup = compile(g.group)

// A grammar whose `scanSkip` set CONTAINS a balanced() skipper — the codegen
// crash class (Greptile P1): emitting a balanced rebuilds its interior with
// `activeScanSkip`, which contains that balanced member, which would re-trigger
// the rebuild forever. `bsBracket` is a DIFFERENT balanced whose rebuild pulls in
// the `paren` member; `bsToSemi` is a scanTo that must skip the paren group.
const paren = balanced('(', ')')
const bs = rules({ scanSkip: [paren] }, gg => ({
  bracket: balanced('[', ']'),
  toSemi: sequence(scanTo(literal(';')), literal(';')),
}))

// A NESTED DIFFERENT balanced: `paren` (NOT in scanSkip) is rebuilt with a scanSkip
// containing a DIFFERENT balanced (`nbBracket`) + a string. The nested bracket must
// STILL get its own ambient rebuild so it skips the string — a coarse "suppress all"
// guard would emit it eager and reject a `]` hidden in a string (compiled ≠ interp).
const nbBracket = balanced('[', ']')
const nbDq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const nb = rules({ scanSkip: [nbBracket, nbDq] }, gg => ({
  paren: balanced('(', ')'),
}))

// ---------------------------------------------------------------------------
// Macro mode — the ambient options must survive the build-time compile too.
// ---------------------------------------------------------------------------
type MacroFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroEntry: MacroFn
let macroOp: MacroFn
let macroGroup: MacroFn
let macroBsBracket: MacroFn
let macroBsToSemi: MacroFn
let macroNbParen: MacroFn

// A macro grammar with a NESTED DIFFERENT balanced in scanSkip — the nested
// bracket must keep its ambient string-skipping (precise cycle guard, not coarse).
const MACRO_NB_CODE = `
import { rules, sequence, literal, regex, balanced } from 'parseman' with { type: 'macro' }
const nbBracket = balanced('[', ']')
const nbDq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
export const nb = rules({ scanSkip: [nbBracket, nbDq] }, gg => ({
  paren: balanced('(', ')'),
}))
`.trim()

// A macro grammar with a balanced() MEMBER in its scanSkip — must macro-fuse
// (not stack-overflow) exactly like the interpreter/compile() paths.
const MACRO_BS_CODE = `
import { rules, sequence, literal, scanTo, balanced } from 'parseman' with { type: 'macro' }
const paren = balanced('(', ')')
export const bs = rules({ scanSkip: [paren] }, gg => ({
  bracket: balanced('[', ']'),
  toSemi: sequence(scanTo(literal(';')), literal(';')),
}))
`.trim()

const MACRO_CODE = `
import { rules, sequence, literal, regex, scanTo, balanced } from 'parseman' with { type: 'macro' }
const dq = sequence(literal('"'), regex(/[^"]*/), literal('"'))
const triviaWsComment = regex(/(?:[ \\t\\n\\r]+|\\/\\*[^]*?\\*\\/)+/)
export const grammar = rules({ trivia: triviaWsComment, scanSkip: [dq] }, gg => ({
  entry: sequence(gg.toSemi, literal(';')),
  toSemi: scanTo(literal(';')),
  entryOp: sequence(gg.toOp, regex(/or/)),
  toOp: scanTo(regex(/\\bor\\b/)),
  group: balanced('(', ')'),
}))
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'ambient-scan-skip-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  assertMacroCompiled(result.code)
  const grammar = evalMacroModule<Record<string, MacroFn>>(result.code, 'grammar')
  macroEntry = grammar.entry!
  macroOp = grammar.entryOp!
  macroGroup = grammar.group!

  // Second grammar: balanced() member in scanSkip — the codegen recursion class.
  const bsResult = transformMacro(MACRO_BS_CODE, 'ambient-scan-skip-bs-test.ts', new Set(['parseman']))
  if (!bsResult) throw new Error('bs macro transform returned null')
  assertMacroCompiled(bsResult.code)
  const bsGrammar = evalMacroModule<Record<string, MacroFn>>(bsResult.code, 'bs')
  macroBsBracket = bsGrammar.bracket!
  macroBsToSemi = bsGrammar.toSemi!

  // Third grammar: nested DIFFERENT balanced in scanSkip.
  const nbResult = transformMacro(MACRO_NB_CODE, 'ambient-scan-skip-nb-test.ts', new Set(['parseman']))
  if (!nbResult) throw new Error('nb macro transform returned null')
  assertMacroCompiled(nbResult.code)
  macroNbParen = evalMacroModule<Record<string, MacroFn>>(nbResult.code, 'nb').paren!
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
// balanced() consults ambient scanSkip in its interior (Greptile P1)
// ---------------------------------------------------------------------------
describe('balanced() honors ambient scanSkip in its interior', () => {
  // a close-delimiter `)` hidden inside a string must NOT close the balance
  // (whitespace-free so the value isn't affected by ambient-trivia skipping,
  // which `many` applies between interior elements regardless of scanSkip)
  const INPUT = '("a)b")'
  it('interpreter — the whole region matches, string is opaque', () => {
    const r = parse(g.group, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.value).toBe(INPUT); expect(r.span.end).toBe(INPUT.length) }
  })
  it('compile() — same', () => {
    const r = compiledGroup.parse(INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(INPUT)
  })
  it('macro — same', () => {
    const r = macroGroup(INPUT, 0, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(INPUT)
  })
  it('an OPEN delimiter inside a string is not counted as a nested pair', () => {
    // `("x(y")` — the `(` inside the string would unbalance depth if not skipped
    const nested = '("x(y")'
    expect((parse(g.group, nested) as { value: string }).value).toBe(nested)
    expect((compiledGroup.parse(nested) as { value: string }).value).toBe(nested)
    expect((macroGroup(nested, 0, {}) as { value: string }).value).toBe(nested)
  })
  it('all three modes agree on a nested paren group beside a string', () => {
    const mixed = '((a)"b)c"d)'
    const vals = [
      (parse(g.group, mixed) as { value: string }).value,
      (compiledGroup.parse(mixed) as { value: string }).value,
      (macroGroup(mixed, 0, {}) as { value: string }).value,
    ]
    expect(new Set(vals).size).toBe(1)
    expect(vals[0]).toBe(mixed)
  })
  it('WITHOUT ambient scanSkip a hidden `)` closes early (proves the fix matters)', () => {
    // same balanced, but a grammar that declares NO scanSkip: the raw interior
    // stops at the `)` inside the string.
    const bare = rules(gg => ({ group: balanced('(', ')') }))
    const r = parse(bare.group, '("a)b")')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('("a)')   // closed at the `)` inside the string
  })
})

// ---------------------------------------------------------------------------
// A balanced() MEMBER of scanSkip must not send codegen into unbounded rebuild
// recursion (Greptile P1 codegen crash). compile() + macro must TERMINATE and
// produce a working parser, and the skipping must still be correct.
// ---------------------------------------------------------------------------
describe('balanced() member of scanSkip — codegen terminates and skips correctly', () => {
  it('compile() a balanced whose rebuild pulls in the balanced scanSkip member — no stack overflow', () => {
    let compiledBracket: ReturnType<typeof compile>
    expect(() => { compiledBracket = compile(bs.bracket) }).not.toThrow()
    // …and it actually parses: a `]` hidden inside a paren group is skipped, so
    // the bracket closes at the REAL `]`.
    const r = compiledBracket!.parse('[(a]b)]')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('[(a]b)]')
  })

  it('compile() a scanTo that skips the balanced paren member — a `;` inside `()` is not matched', () => {
    const compiledToSemi = compile(bs.toSemi)
    const r = compiledToSemi.parse('(a;b);')
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as string[])[0]).toBe('(a;b)')   // the inner `;` was skipped
  })

  it('interpreter agrees (no infinite build/parse)', () => {
    expect((parse(bs.bracket, '[(a]b)]') as { value: string }).value).toBe('[(a]b)]')
    expect((parse(bs.toSemi, '(a;b);') as { value: string[] }).value[0]).toBe('(a;b)')
  })

  it('macro path fuses (no stack overflow) and skips correctly', () => {
    const br = macroBsBracket('[(a]b)]', 0, {})
    expect(br.ok).toBe(true)
    if (br.ok) expect(br.value).toBe('[(a]b)]')
    const ts = macroBsToSemi('(a;b);', 0, {})
    expect(ts.ok).toBe(true)
    if (ts.ok) expect((ts.value as string[])[0]).toBe('(a;b)')
  })
})

// ---------------------------------------------------------------------------
// A NESTED DIFFERENT balanced inside a rebuilt interior must KEEP its ambient
// opaque-unit skipping — compiled must match the interpreter (Greptile follow-on:
// a coarse boolean guard over-suppresses and diverges).
// ---------------------------------------------------------------------------
describe('nested different balanced keeps its ambient skipping (compiled === interpreter)', () => {
  // `(["a]b"])` — a `]` hidden inside a string, inside the bracket, inside the paren.
  // The nested bracket (a DIFFERENT balanced, member of scanSkip) must skip the
  // string, so the `]` is not matched and the whole region parses.
  const INPUT = '(["a]b"])'

  it('interpreter — the nested bracket skips the string, whole region matches', () => {
    const r = parse(nb.paren, INPUT)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(INPUT)
  })

  it('compile() MATCHES the interpreter (a coarse guard would reject this)', () => {
    const ci = compile(nb.paren).parse(INPUT)
    const iv = parse(nb.paren, INPUT)
    expect(ci.ok).toBe(true)
    expect(ci.ok && iv.ok && ci.value === iv.value).toBe(true)
    if (ci.ok) expect(ci.value).toBe(INPUT)
  })

  it('macro MATCHES the interpreter too', () => {
    const m = macroNbParen(INPUT, 0, {})
    expect(m.ok).toBe(true)
    if (m.ok) expect(m.value).toBe(INPUT)
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
