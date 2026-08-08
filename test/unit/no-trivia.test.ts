/**
 * noTrivia(child) — clears ambient trivia so sequence/repeat terms inside must
 * be adjacent (no whitespace skipped). Models Less-style glued accessors:
 *   `@var[a][b]` chains, but `@var [a]` stops the chain (space breaks adjacency).
 *
 * Note the structure: noTrivia must wrap the WHOLE reference (variable + its
 * accessor chain), because an enclosing sequence skips trivia *before* a term
 * runs — wrapping only the accessors would let the space before `[` be skipped
 * by the outer sequence. Inside the brackets, parser({ trivia }) re-enables
 * spacing (so `@a[b ]` is fine).
 *
 * Verified across all execution modes — interpreter, compile(), and the macro
 * plugin — because the trivia-skip decision lives in different code paths
 * (runtime ctx.trivia vs codegen ctx.activeTrivia) that can drift apart.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'
import {
  literal, regex, sequence, many, transform, trivia, parser, noTrivia, compile, parse,
} from '../../src/index.ts'

const rw = trivia(regex(/[ \t\n]+/))
const lvar = regex(/@[a-z]+/)
const key = regex(/[a-z]+/)

// `@name` glued to zero+ `[key]` accessors; spaces allowed only INSIDE brackets.
const refCombinator = transform(
  noTrivia(sequence(
    lvar,
    many(sequence(literal('['), parser({ trivia: rw }, sequence(key, literal(']'))))),
  )),
  ([name, accs]) => ({ name, n: (accs as unknown[]).length }),
)

const compiled = compile(refCombinator)

// Macro mode — same grammar as source text, compiled by the plugin.
type ParseFn = (input: string, pos: number, ctx: object) =>
  { ok: boolean; value?: unknown; span: { start: number; end: number } }
let macroFn: ParseFn

const MACRO_CODE = `
import { literal, regex, sequence, many, transform, trivia, parser, noTrivia } from 'parseman' with { type: 'macro' }
const rw = trivia(regex(/[ \\t\\n]+/))
const lvar = regex(/@[a-z]+/)
const key = regex(/[a-z]+/)
const ref = transform(
  noTrivia(sequence(
    lvar,
    many(sequence(literal('['), parser({ trivia: rw }, sequence(key, literal(']'))))),
  )),
  ([name, accs]) => ({ name, n: accs.length }),
)
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'no-trivia-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import — compilation failed')
  macroFn = evalMacroModule<ParseFn>(result.code, 'ref')
})

function interpParse(input: string) { return parse(refCombinator, input) }
function compiledParse(input: string) { return compiled.parse(input) }
function macroParse(input: string) { return macroFn(input, 0, {}) }

// [input, expected accessor count, expected end offset]
const CASES: Array<[string, number, number]> = [
  ['@a',          0, 2],  // bare variable
  ['@a[b]',       1, 5],  // one glued accessor
  ['@a[b][c]',    2, 8],  // chained glued accessors
  ['@a[b ]',      1, 6],  // inner parser({ trivia }) re-enables spacing inside brackets
  ['@a [b]',      0, 2],  // space before `[` breaks the chain → 0 accessors, stops at `@a`
  ['@a[b] [c]',   1, 5],  // first glues, space before second breaks → 1 accessor
]

describe('noTrivia — interpreter vs compile() vs macro', () => {
  for (const [input, n, end] of CASES) {
    it(`interpreter: ${JSON.stringify(input)} → n=${n}, end=${end}`, () => {
      const r = interpParse(input)
      expect(r.ok).toBe(true)
      expect((r as { value: { n: number } }).value.n).toBe(n)
      expect(r.span.end).toBe(end)
    })
    it(`compile():    ${JSON.stringify(input)} → n=${n}, end=${end}`, () => {
      const r = compiledParse(input)
      expect(r.ok).toBe(true)
      expect((r as { value: { n: number } }).value.n).toBe(n)
      expect(r.span.end).toBe(end)
    })
    it(`macro:        ${JSON.stringify(input)} → n=${n}, end=${end}`, () => {
      const r = macroParse(input)
      expect(r.ok).toBe(true)
      expect((r.value as { n: number }).n).toBe(n)
      expect(r.span.end).toBe(end)
    })
  }
})
