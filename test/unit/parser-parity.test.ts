/**
 * Cross-mode parity: interpreter vs compile() vs macro plugin.
 *
 * Tests a representative recursive grammar (value → array of values) that
 * exercises the critical paths:
 *   - parser() factory with forward refs (g.*)
 *   - sepBy with transform items (double-traversal in emitSepBy)
 *   - transform with captured closures
 *   - outer-scope combinators referenced inside the factory
 *
 * All three modes must produce byte-for-byte identical results. A bug in
 * mapFnSources alignment (the mfSrcs doubling fix) would cause macro mode
 * to silently call the wrong transform — a parity failure catches that.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { literal, regex, sequence, choice, optional, sepBy, transform, rules, compile, parse } from '../../src/index.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import type { Combinator } from '../../src/types.ts'
import { evalMacroModule } from '../helpers/eval-macro-module.ts'

// ---------------------------------------------------------------------------
// Grammar: a tiny expression language
//   expr    = array | number | string
//   array   = '[' (expr (',' expr)*)? ']'
//   number  = /[0-9]+/ → Number
//   string  = '"' /[^"]*/ '"' → inner text, uppercased
//
// The uppercase transform on strings is non-trivial so we can verify the
// correct _mf[] slot is called, not just that parsing succeeded.
// ---------------------------------------------------------------------------

const num = transform(regex(/[0-9]+/), s => ({ type: 'num', v: Number(s) }) as unknown)
const strInner = regex(/[^"]*/)
const str = transform(
  sequence(literal('"'), strInner, literal('"')),
  ([, inner]) => ({ type: 'str', v: (inner as string).toUpperCase() }) as unknown
)

const { expr: interpExpr } = rules<{ expr: Combinator<unknown> }>(g => {
  const comma = literal(',')
  const arr = transform(
    sequence(literal('['), optional(sepBy(g.expr, comma)), literal(']')),
    ([, items]) => ({ type: 'arr', v: items ?? [] }) as unknown
  )
  return { expr: choice(arr, str, num) }
})

// compile() mode — built once, shared across tests
const compiledExpr = compile(interpExpr)

// ---------------------------------------------------------------------------
// Macro mode — evaluate the macro plugin on an equivalent code string and
// get back a plain parser function (input, pos, ctx) → ParseResult.
// ---------------------------------------------------------------------------

type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

let macroFn: ParseFn

const MACRO_CODE = `
import { literal, regex, sequence, choice, optional, sepBy, transform, rules } from 'parseman' with { type: 'macro' }

const num = transform(regex(/[0-9]+/), s => ({ type: 'num', v: Number(s) }))
const strInner = regex(/[^"]*/)
const str = transform(
  sequence(literal('"'), strInner, literal('"')),
  ([, inner]) => ({ type: 'str', v: inner.toUpperCase() })
)

const { expr } = rules(g => {
  const comma = literal(',')
  const arr = transform(
    sequence(literal('['), optional(sepBy(g.expr, comma)), literal(']')),
    ([, items]) => ({ type: 'arr', v: items ?? [] })
  )
  return { expr: choice(arr, str, num) }
})
`.trim()

beforeAll(() => {
  const result = transformMacro(MACRO_CODE, 'parity-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null — import not detected')
  if (result.code.includes("from 'parseman'"))
    throw new Error('macro transform did not remove the import — compilation failed')

  // Eval: strip `const` → `var` so new Function() can see all names,
  // then return `expr` as the last expression.
  macroFn = evalMacroModule<ParseFn>(result.code, 'expr', { Number, Object })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function interpParse(input: string) {
  return parse(interpExpr, input)
}

function compiledParse(input: string) {
  return compiledExpr.parse(input)
}

function macroParse(input: string) {
  return macroFn(input, 0, {})
}

// ---------------------------------------------------------------------------
// Tests — each case is run across all three modes
// ---------------------------------------------------------------------------

const CASES: [string, unknown][] = [
  ['42',                      { type: 'num', v: 42 }],
  ['"hello"',                 { type: 'str', v: 'HELLO' }],
  ['[]',                      { type: 'arr', v: [] }],
  ['[1]',                     { type: 'arr', v: [{ type: 'num', v: 1 }] }],
  ['[1,2,3]',                 { type: 'arr', v: [{ type: 'num', v: 1 }, { type: 'num', v: 2 }, { type: 'num', v: 3 }] }],
  ['"ab"',                    { type: 'str', v: 'AB' }],
  ['["x",42]',                { type: 'arr', v: [{ type: 'str', v: 'X' }, { type: 'num', v: 42 }] }],
  ['[[1,2],[3]]',             { type: 'arr', v: [
    { type: 'arr', v: [{ type: 'num', v: 1 }, { type: 'num', v: 2 }] },
    { type: 'arr', v: [{ type: 'num', v: 3 }] },
  ]}],
  ['[[],["a","b"],99]',       { type: 'arr', v: [
    { type: 'arr', v: [] },
    { type: 'arr', v: [{ type: 'str', v: 'A' }, { type: 'str', v: 'B' }] },
    { type: 'num', v: 99 },
  ]}],
]

describe('parser parity — interpreter vs compile() vs macro', () => {
  for (const [input, expected] of CASES) {
    describe(input, () => {
      it('interpreter', () => {
        const r = interpParse(input)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value).toEqual(expected)
      })

      it('compile()', () => {
        const r = compiledParse(input)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value).toEqual(expected)
      })

      it('macro', () => {
        const r = macroParse(input)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value).toEqual(expected)
      })
    })
  }

  describe('failure cases', () => {
    const bad = ['', '[', 'x', '[1,]', '[[1]']

    for (const input of bad) {
      it(`all modes fail on ${JSON.stringify(input)}`, () => {
        expect(interpParse(input).ok).toBe(false)
        expect(compiledParse(input).ok).toBe(false)
        expect(macroParse(input).ok).toBe(false)
      })
    }
  })
})
