/**
 * Failure-diagnostics parity: on a FAILED parse, the compiled build and the macro
 * build must report the SAME `span` and `expected` as the interpreter — not a
 * coarse structural placeholder at the construct's start.
 *
 * The interpreter is the reference. Its failure semantics (see combinators):
 *   - node/transform/label/trivia/lazy/withCtx : propagate the inner failure
 *     verbatim (deepest failing leaf's span + expected).
 *   - sequence / oneOrMore : propagate the failing term's failure.
 *   - not : synthesize `[not(<innerTag>)]` at the not's own position.
 *   - choice : expected = concat of tried arms' (deep) expected, span at choice pos.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  literal, regex, sequence, choice, node, parser, trivia,
  not, ref, withCtx, optional, parse,
} from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { compile } from '../../src/compiler/codegen.ts'
import { transformMacro } from '../../src/plugin/index.ts'

function makeMacroParser(code: string, exportName: string) {
  const result = transformMacro(code, 'failure-diagnostics-test.ts', new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  const fnBody = result.code
    .replace(/\bexport const\b/g, 'var')
    .replace(/\bconst\b/g, 'var') + `\nreturn ${exportName}`
  return new Function(fnBody)() as (
    input: string, pos: number, ctx: Record<string, unknown>,
  ) => { ok: boolean; value?: unknown; span: { start: number; end: number }; expected?: string[] }
}

type Fail = { ok: false; expected: string[]; span: { start: number; end: number } }
function asFail(r: { ok: boolean; expected?: string[]; span: { start: number; end: number } }): Fail {
  expect(r.ok).toBe(false)
  return r as Fail
}

/** Interpreter-vs-compiled failure parity (span + sorted expected). */
function failParity<T>(combinator: Combinator<T>, input: string) {
  const compiled = compile(combinator)
  const i = asFail(parse(combinator, input, { trackLines: false }))
  const c = asFail(compiled.parse(input, 0))
  expect(c.span.start).toBe(i.span.start)
  expect(c.span.end).toBe(i.span.end)
  expect([...c.expected].sort()).toEqual([...i.expected].sort())
  return i
}

describe('node() failure diagnostics parity', () => {
  const NodeSeq = node('N', sequence(literal('a'), literal('b')), (_c, _r, s) => ({ s }))
  it('propagates inner failure position + expected (missing second term)', () => {
    const i = failParity(NodeSeq, 'ax')
    expect(i.span.start).toBe(1)
    expect(i.expected).toEqual(['"b"'])
  })
  it('propagates inner failure at EOF', () => {
    failParity(NodeSeq, 'a')
  })
  it('propagates first-term failure', () => {
    const i = failParity(NodeSeq, '')
    expect(i.expected).toEqual(['"a"'])
  })

  const Nested = node('Outer',
    sequence(literal('('), node('Inner', literal('x'), (_c, _r, s) => ({ i: s })), literal(')')),
    (_c, _r, s) => ({ o: s }))
  it('nested node — inner leaf failure bubbles through both nodes', () => {
    const i = failParity(Nested, '(y)')
    expect(i.span.start).toBe(1)
    expect(i.expected).toEqual(['"x"'])
  })
  it('nested node — missing close paren', () => {
    const i = failParity(Nested, '(x')
    expect(i.span.start).toBe(2)
    expect(i.expected).toEqual(['")"'])
  })

  it('node inside a sequence keeps deepest failure', () => {
    const p = sequence(literal('#'), node('N', sequence(literal('a'), literal('b')), (_c, _r, s) => ({ s })))
    const i = failParity(p, '#ax')
    expect(i.span.start).toBe(2)
    expect(i.expected).toEqual(['"b"'])
  })

  it('node with trivia — failure after trivia skip', () => {
    const p = node('R', parser({ trivia: trivia(regex(/[ \t]+/)) }, sequence(literal('a'), literal('b'))), (_c, _r, s) => ({ s }))
    const i = failParity(p, 'a x')
    expect(i.span.start).toBe(2)
    expect(i.expected).toEqual(['"b"'])
  })
})

describe('not() failure diagnostics parity', () => {
  it('reports not(<innerTag>) at its own position', () => {
    const p = sequence(not(literal('x')), regex(/[a-z]/))
    const i = failParity(p, 'x')
    expect(i.expected).toEqual(['not(literal)'])
    expect(i.span.start).toBe(0)
  })
})

describe('ref failure diagnostics parity', () => {
  it('recursive ref propagates deepest failure (no choice involved)', () => {
    const item = ref<unknown>()
    item.define(sequence(literal('['), optional(item), literal(']')))
    // '[[]' — innermost ']' consumed by inner item; outer close is missing at EOF.
    const i = failParity(item, '[[]')
    expect(i.span.start).toBe(3)
    expect(i.expected).toEqual(['"]"'])
  })
})

describe('withCtx failure diagnostics parity', () => {
  it('propagates inner failure', () => {
    const p = withCtx({ depth: 0 }, sequence(literal('a'), literal('b')))
    const i = failParity(p, 'ax')
    expect(i.span.start).toBe(1)
    expect(i.expected).toEqual(['"b"'])
  })
})

describe('choice() failure diagnostics parity', () => {
  it('composite arms report deep expected (not a structural label)', () => {
    const p = choice(sequence(literal('a'), literal('b')), sequence(literal('a'), literal('c')))
    const i = failParity(p, 'ax')
    // interpreter concatenates each tried arm's deep expected
    expect([...i.expected].sort()).toEqual(['"b"', '"c"'])
  })
  it('no-arm-first-set-match reports arms first-token expected', () => {
    const p = choice(sequence(literal('a'), literal('b')), sequence(literal('c'), literal('d')))
    failParity(p, 'z')
  })
})

// Macro parity for the headline cases (macro shares codegen with compile()).
describe('macro failure diagnostics parity (headline)', () => {
  const cases: Array<{ name: string; macro: string; exp: string; comb: Combinator<unknown>; input: string }> = [
    {
      name: 'node',
      comb: node('N', sequence(literal('a'), literal('b')), (_c, _r, s) => ({ s })),
      macro: `import { node, sequence, literal } from 'parseman' with { type: 'macro' }\nexport const g = node('N', sequence(literal('a'), literal('b')), (_c, _r, s) => ({ s }))`,
      exp: 'g', input: 'ax',
    },
    {
      name: 'not',
      comb: sequence(not(literal('x')), regex(/[a-z]/)),
      macro: `import { sequence, not, regex, literal } from 'parseman' with { type: 'macro' }\nexport const g = sequence(not(literal('x')), regex(/[a-z]/))`,
      exp: 'g', input: 'x',
    },
  ]
  for (const c of cases) {
    let macroFn: ReturnType<typeof makeMacroParser>
    beforeAll(() => { macroFn = makeMacroParser(c.macro, c.exp) })
    it(`${c.name}: macro matches interpreter`, () => {
      const i = asFail(parse(c.comb, c.input, { trackLines: false }))
      const m = asFail(macroFn(c.input, 0, {}))
      expect(m.span.start).toBe(i.span.start)
      expect(m.span.end).toBe(i.span.end)
      expect([...m.expected].sort()).toEqual([...i.expected].sort())
    })
  }
})
