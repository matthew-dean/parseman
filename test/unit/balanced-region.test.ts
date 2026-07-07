/**
 * Predictive bracket regions report imbalance accurately — and never SWALLOW.
 *
 * This is the model that should replace scanTo's "consume one char anyway" loop
 * for structured free-form regions (at-rule preludes, custom-property values,
 * mixin args). A region is `many(choice(contentRun, group…, string))` where:
 *   - contentRun is a run of non-delimiter chars   (the scannerless `!BlockMarker`)
 *   - each group is `open · region · expect(close)` (recursion via the rules() proxy)
 *
 * Properties proven here, across the interpreter and the macro compile (the two
 * modes the css/less grammars actually run):
 *   - well-formed nesting consumes fully, no errors
 *   - an unmatched OPEN reports `expected <close>` (expect fires)
 *   - a cross-type close `(a]` reports `expected )` (inner region halts, expect mismatches)
 *   - a stray CLOSE `a)b` HALTS the region (span stops before `)`) instead of being
 *     swallowed — so the enclosing grammar sees it as unconsumed input and can error
 *
 * No backtracking: the choice arms are first-set disjoint (content vs `(`/`[`/`{`
 * vs `'`), so each position dispatches on one character.
 */
import { describe, it, expect as vexpect, beforeAll } from 'vitest'
import {
  literal, regex, sequence, choice, many, expect, rules, parse,
} from '../../src/index.ts'
import type { ParseError } from '../../src/index.ts'

// Interpreter region, built with the rules() recursion proxy.
const G = rules((g: any) => {
  const content = regex(/[^()[\]{}'"]+/)
  const str = sequence(literal("'"), regex(/[^']*/), literal("'"))
  const paren = sequence(literal('('), g.region, expect(literal(')')))
  const square = sequence(literal('['), g.region, expect(literal(']')))
  const curly = sequence(literal('{'), g.region, expect(literal('}')))
  const region = many(choice(content, str, paren, square, curly))
  return { region }
})
const region = (G as any).region

type ParseFn = (input: string, pos: number, ctx: { _errors?: ParseError[] }) =>
  { ok: boolean; span: { end: number } }
let macroFn: ParseFn

const MACRO_CODE = `
import { literal, regex, sequence, choice, many, expect, rules } from 'parseman' with { type: 'macro' }
export const { region } = rules((g) => {
  const content = regex(/[^()[\\]{}'"]+/)
  const str = sequence(literal("'"), regex(/[^']*/), literal("'"))
  const paren = sequence(literal('('), g.region, expect(literal(')')))
  const square = sequence(literal('['), g.region, expect(literal(']')))
  const curly = sequence(literal('{'), g.region, expect(literal('}')))
  const region = many(choice(content, str, paren, square, curly))
  return { region }
})
`.trim()

beforeAll(async () => {
  const { transformMacro } = await import('../../src/plugin/index.ts')
  const result = transformMacro(MACRO_CODE, 'region-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import')
  const fnBody = result.code.replace(/\bexport const\b/g, 'var').replace(/\bconst\b/g, 'var') + '\nreturn region'
  macroFn = new Function(fnBody)() as ParseFn
})

function interp(input: string) {
  const r = parse(region, input, { recover: true })
  return { ok: r.ok, end: r.span.end, errors: (r.ok && r.errors) ? r.errors : [] }
}
function macro(input: string) {
  const _errors: ParseError[] = []
  const r = macroFn(input, 0, { _errors })
  return { ok: r.ok, end: r.span.end, errors: _errors }
}

const MODES: Array<[string, (i: string) => { ok: boolean; end: number; errors: ParseError[] }]> = [
  ['interpreter', interp],
  ['macro', macro],
]

describe('predictive bracket region', () => {
  for (const [mode, run] of MODES) {
    it(`${mode}: well-formed nesting → full consume, no errors`, () => {
      const r = run('a(b[c]{d}e)f')
      vexpect(r.ok).toBe(true)
      vexpect(r.end).toBe(12)
      vexpect(r.errors).toHaveLength(0)
    })

    it(`${mode}: unmatched open → "expected )" reported`, () => {
      const r = run('(a[b]')
      vexpect(r.ok).toBe(true)
      vexpect(r.errors.length).toBeGreaterThanOrEqual(1)
      vexpect(r.errors.some(e => e.expected.includes('")"'))).toBe(true)
    })

    it(`${mode}: cross-type close (a] → "expected )" reported`, () => {
      const r = run('(a]')
      vexpect(r.ok).toBe(true)
      vexpect(r.errors.some(e => e.expected.includes('")"'))).toBe(true)
    })

    it(`${mode}: stray close a)b → region HALTS (no swallow)`, () => {
      const r = run('a)b')
      vexpect(r.ok).toBe(true)
      vexpect(r.end).toBe(1)          // consumed 'a', stopped AT ')', did not eat it
      vexpect(r.errors).toHaveLength(0)  // the halt itself isn't an error; the caller's leftover check is
    })

    it(`${mode}: string content is opaque (brackets inside quotes ignored)`, () => {
      const r = run("('a)b'c)")
      vexpect(r.ok).toBe(true)
      vexpect(r.end).toBe(8)
      vexpect(r.errors).toHaveLength(0)
    })
  }
})
