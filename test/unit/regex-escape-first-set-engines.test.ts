/**
 * ESCAPES THAT ARE NOT THEIR LETTER, through every engine.
 *
 * A regex's first set gates trivia skips, choice dispatch and optional terms. It
 * was read wrongly for escapes whose meaning is not the escaped character, and
 * for non-ASCII letters under `/i`:
 * - legacy octal `\012`;
 * - control `\cJ`;
 * - property `\p{…}`;
 * - code point `\u{…}`;
 * - `/é/i`, which also matches `É`;
 * - `v`-mode nested classes and set operations (`[[^a]]`, `[[a-c]--b]`);
 * - astral literals and escaped surrogate pairs, which `lead()` reads as one
 *   code point;
 * - `v` regexes, which no code-unit scanner may stand in for.
 *
 * Each engine then refused input the regex matches. Every case here runs through
 * the interpreter, `execRules`, the closure engine and the emitted assembly:
 * - the three table engines must agree on the whole `RunResult`;
 * - the interpreter must agree on the value, the span and where unconsumed input
 *   begins, since its expected sets are narrower by design;
 * - every case parses its input whole.
 */
import { describe, expect, it } from 'vitest'
import { choice, literal, many, node, optional, peek, regex, rules, sequence, trivia } from '../../src/index.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { execRules } from '../../src/table/exec.ts'
import { run, type RunOptions, type RunResult } from '../../src/functional/run.ts'
import { digestValue } from '../../src/oracle/index.ts'
import type { Combinator } from '../../src/types.ts'

type Grammar = Record<string, Combinator<unknown>>
type Case = { readonly name: string; readonly grammar: Grammar; readonly inputs: readonly string[]; readonly opts?: RunOptions }

const words = (t: Combinator<unknown>): Grammar =>
  rules<Grammar>({ trivia: t }, g => ({ Doc: many(g.Word!), Word: regex(/[a-z]+/) }))
// Legacy octal escapes are spelled through `RegExp`, since TypeScript refuses them
// in a regex literal.
const one = (p: Combinator<unknown>): Grammar => rules<Grammar>(() => ({ Doc: p }))

const CASES: Case[] = [
  { name: 'trivia \\p{White_Space} (u)', grammar: words(trivia(regex(/\p{White_Space}+/u))), inputs: ['a b', 'a b'] },
  { name: 'trivia legacy octal \\012', grammar: words(trivia(regex(new RegExp('(?: |\\012)+')))), inputs: ['a\nb', 'a b'] },
  { name: 'trivia control \\cJ', grammar: words(trivia(regex(/(?: |\cJ)+/))), inputs: ['a\nb'] },
  { name: 'trivia code point \\u{20} (u)', grammar: words(trivia(regex(/\u{20}+/u))), inputs: ['a b'] },
  { name: 'trivia class [\\012]', grammar: words(trivia(regex(new RegExp('[ \\012]+')))), inputs: ['a\nb'] },
  { name: 'trivia /é/i', grammar: words(trivia(regex(/(?:[ \n]|é)+/i))), inputs: ['aÉb', 'aéb'] },
  { name: 'trivia /σ/i', grammar: words(trivia(regex(/(?:[ \n]|σ)+/i))), inputs: ['aΣb', 'aςb', 'aσb'] },
  { name: 'trivia /[à-ÿ]/i', grammar: words(trivia(regex(/(?:[ \n]|[à-ÿ])+/i))), inputs: ['aÀb', 'aÿb'] },
  // A set holding every code unit from 128 up keeps its first set under `/i`.
  { name: 'choice arm /[\u0080-\uffff]/i', grammar: one(choice(regex(/[\u0080-\uffff]x/i), regex(/[a-z]+/))), inputs: ['Éx', 'ab'] },
  // ...and, without `u`, its high surrogates admit an astral lead: dispatch reads `😀` as one code point.
  { name: 'choice arm /[\u0080-\uffff]+/i on an astral lead', grammar: one(choice(regex(/[\u0080-\uffff]+/i), regex(/[a-z]+/))), inputs: ['😀', '😀é', 'ab'] },
  { name: 'choice arm \\cJ', grammar: one(choice(regex(/\cJa/), regex(/[a-z]+/))), inputs: ['\na', 'a'] },
  { name: 'choice arm \\012', grammar: one(choice(regex(new RegExp('\\012a')), regex(/[a-z]+/))), inputs: ['\na'] },
  { name: 'choice arm \\p{Lu} (u)', grammar: one(choice(regex(/\p{Lu}x/u), regex(/[a-z]+/))), inputs: ['Ax'] },
  { name: 'choice arm \\u{41} (u)', grammar: one(choice(regex(/\u{41}x/u), regex(/[a-z]+/))), inputs: ['Ax'] },
  { name: 'choice arm /éx/i', grammar: one(choice(regex(/éx/i), regex(/[a-z]+/))), inputs: ['Éx'] },
  { name: 'optional \\cJ', grammar: one(sequence(optional(regex(/\cJ/)), regex(/[a-z]+/))), inputs: ['\na', 'a'] },
  // `v` mode (spelled through `RegExp`: the TypeScript target predates it) nests classes: `[[^a-z]]` is every character but a–z, not `{[, ^, a–z}`.
  { name: 'trivia v-mode [[^a-z]]', grammar: words(trivia(regex(new RegExp('[[^a-z]]+', 'v')))), inputs: ['a b', 'a0b'] },
  { name: 'choice arm v-mode [[^a]]', grammar: one(choice(regex(new RegExp('[[^a]]x', 'v')), regex(/[a-z]+/))), inputs: ['0x', 'a'] },
  { name: 'choice arm v-mode [[a-c]--b]', grammar: one(choice(regex(new RegExp('[[a-c]--b]x', 'v')), regex(/[d-z]+/))), inputs: ['cx', 'd'] },
  { name: 'choice arm v-mode [a[^b]]', grammar: one(choice(regex(new RegExp('[a[^b]]x', 'v')), regex(/[b-z]+/))), inputs: ['0x', 'b'] },
  // An astral literal is one code point under `u`, the code point `lead()` reads.
  { name: 'choice arm astral literal (u)', grammar: one(choice(regex(/😀x/u), regex(/[a-z]+/))), inputs: ['😀x', 'a'] },
  { name: 'choice arm astral class (u)', grammar: one(choice(regex(/[😀]x/u), regex(/[a-z]+/))), inputs: ['😀x'] },
  { name: 'choice arm astral literal (no u)', grammar: one(choice(regex(/😀x/), regex(/[a-z]+/))), inputs: ['😀x'] },
  { name: 'optional astral literal (u)', grammar: one(sequence(optional(regex(/😀/u)), regex(/[a-z]+/))), inputs: ['😀a', 'a'] },
  // Under `u`, an escaped surrogate pair is one code point, as a literal pair is.
  { name: 'choice arm escaped pair \\uD83D\\uDE00 (u)', grammar: one(choice(regex(new RegExp('\\uD83D\\uDE00x', 'u')), regex(/[a-z]+/))), inputs: ['😀x', 'a'] },
  { name: 'choice arm escaped pair in a class (u)', grammar: one(choice(regex(new RegExp('[\\uD83D\\uDE00]x', 'u')), regex(/[a-z]+/))), inputs: ['😀x', 'a'] },
  // Read as two halves, `\\uD83D\\uDE00*` would require the high surrogate, and `.x` would be refused.
  { name: 'choice arm repeated escaped pair (u)', grammar: one(choice(regex(new RegExp('\\uD83D\\uDE00*\\.x', 'u')), regex(/[a-z]+/))), inputs: ['.x', '😀😀.x', 'a'] },
  { name: 'optional escaped pair (u)', grammar: one(sequence(optional(regex(new RegExp('\\uD83D\\uDE00', 'u'))), regex(/[a-z]+/))), inputs: ['😀a', 'a'] },
  // A set holding a high surrogate starts every astral character it begins, so it
  // overlaps an astral `u` arm: the choice must try both.
  { name: 'choice arms high-surrogate set then astral (u)', grammar: one(choice(regex(/[\u0080-\uffff]x/), regex(/😀y/u))), inputs: ['😀y', 'éx'] },
  { name: 'choice arms astral (u) then high-surrogate set', grammar: one(choice(regex(/😀y/u), regex(/[\ud800-\udbff][\udc00-\udfff]x/))), inputs: ['😀x', '😀y'] },
  { name: 'trivia astral literal (no u)', grammar: words(trivia(regex(/(?: |😀)+/))), inputs: ['a😀b', 'a b'] },
  // A collapse opening with optional terms runs its node alone where nothing it
  // holds, trivia included, can start (`gatedPassCollapse`).
  {
    name: 'trivia astral literal (no u) inside a gated collapse',
    grammar: rules<Grammar>({ trivia: trivia(regex(/(?: |😀)+/)) }, g => ({
      Doc: g.Unary!,
      Unary: node('Unary', sequence(optional(literal('!')), g.Word!), c => c, { collapse: true }),
      Word: node('Word', regex(/[a-z]+/), c => c),
    })),
    inputs: ['😀a', '!😀a', 'a'],
  },
  // A `peek()` constraint and the term it guards are intersected as leads: a
  // code-unit set holding a high surrogate meets the astral code point it begins.
  { name: 'peek code units then astral literal', grammar: one(choice(sequence(peek(regex(/😀/)), literal('😀')), regex(/[a-z]+/))), inputs: ['😀', 'a'] },
  { name: 'peek astral literal then code units', grammar: one(choice(sequence(peek(literal('😀')), regex(/😀x/)), literal('a'))), inputs: ['😀x', 'a'] },
  { name: 'peek high surrogates then astral (u)', grammar: one(choice(sequence(peek(regex(/[\uD800-\uDBFF]/)), regex(/😀/u)), literal('a'))), inputs: ['😀', 'a'] },
  { name: 'optional peek then astral literal', grammar: one(sequence(optional(sequence(peek(regex(/😀/)), literal('😀'))), literal('a'))), inputs: ['😀a', 'a'] },
  // A `v` regex reads code points and case-folds as Unicode does, so no code-unit scanner stands in for it.
  { name: 'token v-mode [😀a]x', grammar: one(regex(new RegExp('[😀a]x', 'v'))), inputs: ['😀x', 'ax'] },
  { name: 'token v-mode [^a]x', grammar: one(regex(new RegExp('[^a]x', 'v'))), inputs: ['😀x'] },
  { name: 'token /k/iv on the Kelvin sign', grammar: one(regex(new RegExp('k', 'iv'))), inputs: ['\u212a', 'k'] },
  {
    name: 'tolerant node over an astral class (u)',
    grammar: rules<Grammar>(g => ({ Doc: many(g.Item!), Item: choice(g.Word!), Word: node('Word', regex(/[a-z😀]+/u), c => c) })),
    inputs: ['😀', 'a😀'],
    opts: { tolerant: true },
  },
]

const shape = (r: RunResult): unknown => [r.ok, r.ok ? r.value : null, r.span, r.unconsumedFrom]

describe('escapes and /i letters are read the same by every engine', () => {
  for (const { name, grammar, inputs, opts = {} } of CASES) {
    it(name, () => {
      const prog = encodeTable(grammar)
      const reference = execRules(prog).Doc!
      const closure = tableRules({ ...prog, asm: [] }).Doc!
      const { asm: _none, ...noAsm } = prog
      const emitted = tableRules(noAsm).Doc!
      for (const input of inputs) {
        const want = run(reference, input, opts)
        expect(want.ok && want.unconsumedFrom === null, `${JSON.stringify(input)} parses whole`).toBe(true)
        expect(shape(run(grammar.Doc!, input, opts)), `${JSON.stringify(input)}: interpreter`).toEqual(shape(want))
        expect(digestValue(run(closure, input, opts)), `${JSON.stringify(input)}: closure`).toBe(digestValue(want))
        expect(digestValue(run(emitted, input, opts)), `${JSON.stringify(input)}: emitted`).toBe(digestValue(want))
      }
    })
  }
})

describe('an intersected first set keeps its code-unit form', () => {
  it('a peek() over a high-surrogate class adds no astral range a table would encode wide', () => {
    const fs = sequence(peek(regex(/[\u0080-￿]/)), regex(/[\u0080-￿]+/))._meta.firstSet
    expect(fs).toEqual({ kind: 'ranges', ranges: [{ lo: 0x80, hi: 0xffff }] })
    // An astral code point the high surrogates do not already admit stays explicit.
    const mixed = sequence(peek(choice(regex(/[a-z]/), literal('😀'))), choice(regex(/[a-z]/), literal('😀')))._meta.firstSet
    expect(mixed).toEqual({ kind: 'ranges', ranges: [{ lo: 0x61, hi: 0x7a }, { lo: 0x1f600, hi: 0x1f600 }] })
  })
})
