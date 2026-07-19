/**
 * confirmedBuildArity + arity-gated capture elision (src/compiler/build-arity.ts).
 *
 * A node()'s build receives (children, fields, span, rawChildren, triviaLog, state).
 * When the build provably never declares the 5th (triviaLog) / 6th (state) formal
 * param, per-node CST-trivia capture and the state clone are dead work and are
 * elided identically across interpreter / compile() / macro.
 *
 * REGRESSION: the build source is sliced verbatim from the grammar source, which
 * is often TypeScript — `(c: any, f: any, s: any) => …`. The arity check MUST see
 * through `: type` (and `?`) annotations, or every typed grammar keeps full
 * capture and the optimization never fires downstream. Detection stays
 * CONSERVATIVE: rest / destructuring / defaults / comma-bearing generic types /
 * `arguments` all yield `null` (→ caller keeps capture).
 */
import { describe, it, expect } from 'vitest'
import { node, sequence, regex, literal, parser, compile, parse } from '../../src/index.ts'
import type { ParserDef } from '../../src/index.ts'
import { confirmedBuildArity, buildReadsTrivia, buildReadsState } from '../../src/compiler/build-arity.ts'
import { transformMacro } from '../../src/plugin/index.ts'

type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function macroParser(code: string, name: string): { fn: ParseFn; source: string } {
  const result = transformMacro(code.trim(), `${name}.ts`, new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  if (result.code.includes("from 'parseman'")) throw new Error('macro transform did not remove parseman import')
  const fnBody = result.code.replace(/\bexport\s+/g, '').replace(/\bconst\b/g, 'var') + `\nreturn ${name}`
  return { fn: new Function(fnBody)() as ParseFn, source: result.code }
}

describe('confirmedBuildArity — plain identifier params', () => {
  const cases: Array<[string, number | null]> = [
    ['() => x', 0],
    ['x => x', 1],
    ['(a) => a', 1],
    ['(c, r, s) => x', 3],
    ['(c, _fields, s, r, tl) => x', 5],
    ['(c, f, s, r, tl, st) => x', 6],
    ['function (a, b) { return a }', 2],
    ['function name(a, b, c, d) { return a }', 4],
    ['(c, r, s) => mk("Foo", c, r, s)', 3],
  ]
  for (const [src, expected] of cases) {
    it(`${JSON.stringify(src)} → ${expected}`, () => expect(confirmedBuildArity(src)).toBe(expected))
  }
})

describe('confirmedBuildArity — TypeScript annotations (the regression)', () => {
  const cases: Array<[string, number | null]> = [
    ['(c: any) => c', 1],
    ['(c: any, f: any, s: any) => x', 3], // the common jess build shape
    ['(c: Foo, f: Fields, s: Span, r: Raw, tl: number[]) => x', 5],
    ['(c: any, f: any, s: any, r: any, tl: any, st: any) => x', 6],
    ['(c?: any, r?: any) => c', 2], // optional params
    ['(c : any , r : any) => c', 2], // loose whitespace
    ['function (a: number, b: string) { return a }', 2],
  ]
  for (const [src, expected] of cases) {
    it(`${JSON.stringify(src)} → ${expected}`, () => expect(confirmedBuildArity(src)).toBe(expected))
  }
})

describe('confirmedBuildArity — conservative null (keep capture)', () => {
  const nulls = [
    '(...args) => args',
    '({ a }, b) => b',
    '([a], b) => b',
    '(a = 1, b) => b',
    '(c: any, r: any = null) => r', // default even with a type → unconfirmed
    '(a, b) => { return arguments.length }',
    '(c: Map<string, number>, r: any) => c', // comma inside a generic → mis-split → null
  ]
  for (const src of nulls) {
    it(`${JSON.stringify(src)} → null`, () => expect(confirmedBuildArity(src)).toBeNull())
  }
})

describe('buildReadsTrivia / buildReadsState off buildSrc (typed)', () => {
  const def = (buildSrc: string): Extract<ParserDef, { tag: 'node' }> =>
    ({ tag: 'node', type: 'T', parser: regex(/a/), build: () => null, buildSrc })
  it('typed arity-3 → reads neither (ELIDE)', () => {
    const d = def('(c: any, f: any, s: any) => x')
    expect(buildReadsTrivia(d)).toBe(false)
    expect(buildReadsState(d)).toBe(false)
  })
  it('typed arity-5 → reads trivia only', () => {
    const d = def('(c: any, f: any, s: any, r: any, tl: number[]) => x')
    expect(buildReadsTrivia(d)).toBe(true)
    expect(buildReadsState(d)).toBe(false)
  })
  it('generic-with-comma type → conservatively keeps both', () => {
    const d = def('(c: Map<string, number>) => c')
    expect(buildReadsTrivia(d)).toBe(true)
    expect(buildReadsState(d)).toBe(true)
  })
})

// ── Behavioral: the compiled source actually elides for a typed arity-3 build ──
describe('codegen elides _tl for a typed arity-3 build, keeps it for arity-4', () => {
  // buildSrc must be supplied explicitly (compile() can't recover TS types from a
  // runtime fn) — this mirrors what the macro plugin sets on def.buildSrc.
  const typed3 = node('Typed3', sequence(regex(/a/), regex(/b/)), (c: readonly unknown[]) => ({ n: c.length }))
  ;(typed3._def as Extract<ParserDef, { tag: 'node' }>).buildSrc = '(c: any, f: any, s: any) => x'
  const typed5 = node('Typed5', sequence(regex(/a/), regex(/b/)),
    (c: readonly unknown[], _fields: unknown, _s: unknown, _r: unknown, tl: readonly unknown[]) => ({ n: c.length, tl: tl.length }))
  ;(typed5._def as Extract<ParserDef, { tag: 'node' }>).buildSrc = '(c: any, f: any, s: any, r: any, tl: any) => x'

  it('typed arity-3 → no fresh per-node _tl array; uses _EMPTY_TL', () => {
    const src = compile(typed3).source
    expect(src).toContain('_EMPTY_TL')
    expect(src).not.toMatch(/_tl\d*\s*=\s*\[\]/)
  })
  it('typed arity-5 → allocates a per-node _tl array', () => {
    const src = compile(typed5).source
    // Trivia capture is now gated by the enclosing parser's capture state, so the
    // array is allocated only when that scoped gate is true.
    expect(src).toMatch(/_tl\d*\s*=\s*_ctl\d*\s*\?\s*\[\]\s*:\s*_EMPTY_TL/)
  })
  it('elision is output-preserving (typed arity-3 parses identically to a kept-capture run)', () => {
    // both should produce { n: 2 } regardless of capture
    expect(compile(typed3).parse('ab')).toEqual(parse(typed3, 'ab'))
    expect((compile(typed3).parse('ab') as { ok: boolean; value: unknown }).value).toEqual({ n: 2 })
  })
})

describe('macro output preserves build argument slots while eliding captures', () => {
  it('arity-3 macro build gets fields as undefined and span as the third arg', () => {
    const { fn, source } = macroParser(`
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
export const P = node('P', sequence(literal('a'), literal('b')), (children, fields, span) => ({
  childCount: children.length,
  fieldsIsUndefined: fields === undefined,
  span,
}))
`, 'P')

    expect(source).toContain('_EMPTY_TL')
    expect(source).toMatch(/_build\[0\]\(_ch\d+, undefined, \{ start:/)
    expect(source).toMatch(/_EMPTY_TL, undefined\)/)
    expect(fn('ab', 0, {}).value).toEqual({
      childCount: 2,
      fieldsIsUndefined: true,
      span: { start: 0, end: 2 },
    })
  })

  it('arity-6 macro build still receives undefined fields/state in their fixed slots', () => {
    const { fn } = macroParser(`
import { literal, node, sequence } from 'parseman' with { type: 'macro' }
export const P = node('P', sequence(literal('a'), literal('b')), (children, fields, span, rawChildren, triviaLog, state) => ({
  fieldsIsUndefined: fields === undefined,
  stateIsUndefined: state === undefined,
  rawCount: rawChildren.length,
  triviaCount: triviaLog.length,
  span,
}))
`, 'P')

    expect(fn('ab', 0, {}).value).toEqual({
      fieldsIsUndefined: true,
      stateIsUndefined: true,
      rawCount: 2,
      triviaCount: 0,
      span: { start: 0, end: 2 },
    })
  })

  it('macro preserves node-local trivia capture without enabling it for the whole parser', () => {
    const { fn } = macroParser(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
export const P = node('P', parser({ trivia: regex(/ +/) }, sequence(literal('a'), literal('b'))),
  (_children, _fields, _span, _rawChildren, triviaLog) => ({ triviaLog: [...triviaLog] }),
  { captureTrivia: true })
`, 'P')

    expect(fn('a b', 0, {}).value).toEqual({ triviaLog: [1, 2, 1] })
  })
})

describe('node-local trivia capture', () => {
  function local(enabled: boolean) {
    return node(
      'Pair',
      parser({ trivia: regex(/ +/) }, sequence(literal('a'), literal('b'))),
      (_children, _fields, _span, _rawChildren, triviaLog) => ({ triviaLog: [...triviaLog] }),
      enabled ? { captureTrivia: true } : undefined,
    )
  }

  it('is opt-in, scoped, and matches compiled output', () => {
    const without = parse(local(false), 'a b')
    expect(without.ok && without.value).toEqual({ triviaLog: [] })

    const grammar = local(true)
    const interpreted = parse(grammar, 'a b')
    const compiled = compile(grammar).parse('a b')
    expect(interpreted.ok && interpreted.value).toEqual({ triviaLog: [1, 2, 1] })
    expect(compiled).toEqual(interpreted)
  })
})
