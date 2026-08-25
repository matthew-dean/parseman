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
import { node, sequence, regex, literal, parser, parse, triviaEntries, cstBuildHost } from '../../src/index.ts'
import type { ParserDef } from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import {
  confirmedBuildArity,
  confirmedBuildParamUnused,
  buildReadsChildren,
  buildReadsRaw,
  buildReadsTrivia,
  buildReadsState,
} from '../../src/compiler/build-arity.ts'
import { transformMacro } from '../../src/plugin/index.ts'
import {
  assertMacroCompiled,
  evalMacroModule,
  tableKeepsTailCapture,
  tableOmitsRawCapture,
} from '../helpers/eval-macro-module.ts'

type ParseFn = (input: string, pos: number, ctx: object) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

function macroParser(code: string, name: string): { fn: ParseFn; source: string } {
  const result = transformMacro(code.trim(), `${name}.ts`, new Set(['parseman']))
  if (!result) throw new Error('macro transform returned null')
  assertMacroCompiled(result.code)
  return { fn: evalMacroModule<ParseFn>(result.code, name), source: result.code }
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
    // Nested parens / commas inside TYPE ANNOTATIONS. `PARAM_LIST_RE`'s `[^)]*` used to
    // stop at the `)` inside an arrow type and a plain `,`-split tore type arguments
    // apart, so these ordinary typed reducers were reported 1 (WRONG, silently
    // under-capturing) and null (merely imprecise) respectively.
    ['(children: (n: N) => N, fields) => children', 2],
    ['(c: Map<string, number>, r: any) => c', 2],
    ['(a: Map<K, V>, b: Array<[string, number]>, c) => a', 3],
    ['(a: { x: number, y: number }, b) => a', 2],
    ['(cb: (a: A, b: B) => C, x: Set<D>, y) => x', 3],
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
    'function () { return arguments[0] }', // empty formal list + `arguments` → unknown, NOT 0
    'function () { [native code] }', // bound/native/Proxy: empty list says nothing → unknown
    '(a: number = 1, b) => b', // default with a type annotation
    '(a: (x: number) => number = f, b) => b', // function-typed param carrying a default
  ]
  for (const src of nulls) {
    it(`${JSON.stringify(src)} → null`, () => expect(confirmedBuildArity(src)).toBeNull())
  }
})

describe('confirmedBuildParamUnused — conservative reducer liveness', () => {
  it('proves an ignored rawChildren formal dead while later trivia/state remain live', () => {
    expect(confirmedBuildParamUnused(
      '(children, fields, span, _rawChildren, triviaLog, state) => reduce(children, fields, triviaLog, state)',
      3,
    )).toBe(true)
  })

  it.each([
    ['direct read', '(children, fields, span, rawChildren, triviaLog, state) => rawChildren.length'],
    ['nested closure', '(children, fields, span, rawChildren, triviaLog, state) => () => rawChildren'],
    ['object shorthand', '(children, fields, span, rawChildren, triviaLog, state) => ({ rawChildren })'],
    ['arguments', 'function (children, fields, span, rawChildren, triviaLog, state) { return arguments[3] }'],
    ['eval', '(children, fields, span, rawChildren, triviaLog, state) => eval(source)'],
    ['Function constructor', '(children, fields, span, rawChildren, triviaLog, state) => Function(source)()'],
    ['destructuring', '(children, fields, span, { length }, triviaLog, state) => length'],
    ['default', '(children, fields, span, rawChildren = [], triviaLog, state) => state'],
  ])('declines %s', (_label, src) => {
    expect(confirmedBuildParamUnused(src, 3)).toBe(false)
  })
})

describe('build capture arity gates off buildSrc (typed)', () => {
  const def = (buildSrc: string): Extract<ParserDef, { tag: 'node' }> =>
    ({ tag: 'node', type: 'T', parser: regex(/a/), build: () => null, buildSrc })
  it('typed arity-3 → keeps children/fields but elides raw/trivia/state', () => {
    const d = def('(c: any, f: any, s: any) => x')
    expect(buildReadsChildren(d)).toBe(true)
    expect(buildReadsRaw(d)).toBe(false)
    expect(buildReadsTrivia(d)).toBe(false)
    expect(buildReadsState(d)).toBe(false)
  })
  it('arity-0 → elides children/raw and keeps the fixed build call slots', () => {
    const d = def('() => x')
    expect(buildReadsChildren(d)).toBe(false)
    expect(buildReadsRaw(d)).toBe(false)
  })
  it('typed arity-5 → reads trivia only', () => {
    const d = def('(c: any, f: any, s: any, r: any, tl: number[]) => x')
    expect(buildReadsTrivia(d)).toBe(true)
    expect(buildReadsState(d)).toBe(false)
  })
  it('generic-with-comma type → read as arity 1, not given up on', () => {
    // Previously `null` (keep every tier) because the `,` inside `Map<…>` split the one
    // param into two unreadable fragments. A comma in a type argument belongs to the
    // annotation, so this is arity 1 and the raw/trivia/state tiers are correctly elided.
    const d = def('(c: Map<string, number>) => c')
    expect(confirmedBuildArity('(c: Map<string, number>) => c')).toBe(1)
    expect(buildReadsChildren(d)).toBe(true)
    expect(buildReadsRaw(d)).toBe(false)
    expect(buildReadsTrivia(d)).toBe(false)
    expect(buildReadsState(d)).toBe(false)
  })
})

/**
 * The GENERAL property, stated as a property rather than a list of inputs: for a reducer
 * whose arity cannot be read from source text, `confirmedBuildArity` must answer `null`
 * (unknown → fail open to full capture → degradation recorded), never a NUMBER.
 *
 * A wrong number is the bug this file exists to prevent. `build-arity.ts:62` used to
 * return a confident `0` for `function () { [native code] }` — the stringification of a
 * bound function, a Proxy, and every host builtin — and because `0` is a CONFIDENT answer
 * it never reached `recordDegradation`. Measured before the fix: the same reducer, once
 * direct and once `.bind(null)`, produced DIFFERENT ASTs (fields present vs absent) from
 * the same grammar, with ZERO diagnostics.
 */
describe('unreadable reducer source is never a confident number', () => {
  const unreadable = [
    'function () { [native code] }', // Function.prototype.bind result
    'function freeze() { [native code] }', // host builtin
    'function () { return arguments.length }',
    'function (a) { return arguments[1] }',
    'async (a, b) => a', // not a shape this parser reads
    'foldOperation', // bare identifier the resolver could not expand
    '',
  ]
  for (const src of unreadable) {
    it(`${JSON.stringify(src)} → null, not a number`, () => {
      const arity = confirmedBuildArity(src)
      expect(arity).toBeNull()
      expect(typeof arity).not.toBe('number')
    })
  }
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
  })
  it('typed arity-3 → raw CST collector is AST-only lazy, not eagerly allocated', () => {
    const src = compile(typed3).source
    // Host mode is a COMPILE-TIME constant, so an 'ast' artifact carries no
    // `_ctx.build?._parsemanCstOutput` probe at all. The profiling capture pass used
    // to be the last remaining consumer of the raw collector here; profiling is no
    // longer compiled in, so the `_dcst` gate folds away and the collector is simply
    // never allocated for this shape.
    expect(src).not.toContain('_dcst')
    expect(src).not.toContain('_parsemanCstOutput')
  })
  it('typed arity-5 → allocates a per-node _tl array', () => {
    const src = compile(typed5).source
    // Existing direct five-argument builders own a fresh trivia collector.
  })
  it('elision is output-preserving (typed arity-3 parses identically to a kept-capture run)', () => {
    // both should produce { n: 2 } regardless of capture
    expect(compile(typed3).parse('ab')).toEqual(parse(typed3, 'ab'))
    expect((compile(typed3).parse('ab') as { ok: boolean; value: unknown }).value).toEqual({ n: 2 })
  })
  it('direct AST elision still restores the complete public CST host contract', () => {
    // The CST contract now comes from a SECOND compilation of the same grammar rather
    // than from a per-node runtime branch in the first one.
    const compiled = compile(typed3, undefined, { hostMode: 'cst' })
    const cst = compiled.parseWithContext('ab', { trackLines: false, build: cstBuildHost() })
    expect(cst.ok).toBe(true)
    expect(cst.ok && cst.value).toMatchObject({
      _tag: 'node',
      type: 'Typed3',
      children: [
        { _tag: 'leaf', value: 'a' },
        { _tag: 'leaf', value: 'b' },
      ],
    })
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

    // Arity 3 is below trivia (5) and state (6), so the macro artifact must shed both.
    // This used to read codegen's spellings for that — `_EMPTY_TL`, a literal
    // `undefined` in the `_build[0](…)` call, the absent `_dcst` probe. Those describe
    // the SOURCE lowering, and the macro emits a table, so every one of them silently
    // stopped answering. The table states the same decision as bits on the node row.
    expect(tableKeepsTailCapture(source)).toBe(false)
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

  it('does not reinterpret an author-declared buildArity as a liveness hint', () => {
    const { source } = macroParser(`
import { literal, node } from 'parseman' with { type: 'macro' }
export const P = node('P', literal('a'),
  (children, _fields, _span, _rawChildren, _triviaLog, state) => ({ children, state }),
  { buildArity: 6 })
`, 'P')

    expect(tableOmitsRawCapture(source)).toBe(false)
  })

  it('macro preserves node-local trivia capture without enabling it for the whole parser', () => {
    const { fn, source } = macroParser(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
export const P = node('P', parser({ trivia: regex(/ +/) }, sequence(literal('a'), literal('b'))),
  (_children, _fields, _span, _rawChildren, triviaLog) => ({ triviaLog: [...triviaLog] }),
  { captureTrivia: true })
`, 'P')

    expect(tableOmitsRawCapture(source)).toBe(true)
    const value = fn('a b', 0, {}).value as { triviaLog: readonly number[] }
    expect(value).toEqual({ triviaLog: [1, 2, 1] })
    expect(triviaEntries(value.triviaLog, undefined, { nodeLog: true }).insertIndex(0)).toBe(1)
  })

  it('macro preserves grammar-owned structural trivia when the host explicitly opts out', () => {
    const { fn } = macroParser(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
export const P = node('P', parser({ trivia: regex(/ +/) }, sequence(literal('a'), literal('b'))), undefined,
  { captureTrivia: true })
`, 'P')
    let log: readonly number[] | undefined
    const host = Object.assign(
      (
        _type: string,
        _children: readonly unknown[],
        _fields: unknown,
        _span: unknown,
        _rawChildren: readonly unknown[],
        triviaLog: readonly number[],
      ) => {
        log = triviaLog
        return { type: 'P' }
      },
      { _parsemanCaptureTrivia: () => false },
    )
    const result = fn('a b', 0, { build: host })
    expect(result.ok).toBe(true)
    expect(log).toEqual([1, 2, 1])
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

  it('preserves direct builder trivia capture and matches compiled output', () => {
    const without = parse(local(false), 'a b')
    expect(without.ok && without.value).toEqual({ triviaLog: [1, 2, 1] })

    const grammar = local(true)
    const interpreted = parse(grammar, 'a b')
    const compiled = compile(grammar).parse('a b')
    expect(interpreted.ok && interpreted.value).toEqual({ triviaLog: [1, 2, 1] })
    expect(compiled).toEqual(interpreted)
  })

  it('keeps legacy direct-builder capture around a nested parser scope', () => {
    const ws = regex(/ +/)
    const inner = parser({ trivia: ws, captureTrivia: true }, sequence(literal('b'), literal('c')))
    const grammar = parser({ trivia: ws }, node(
      'Outer',
      sequence(literal('a'), inner, literal('d')),
      (_children, _fields, _span, _rawChildren, triviaLog) => ({ triviaLog: [...triviaLog] }),
    ))

    const interpreted = parse(grammar, 'a b c d')
    const compiled = compile(grammar).parse('a b c d')
    expect(interpreted.ok && interpreted.value).toEqual({ triviaLog: [1, 2, 1, 3, 4, 2, 5, 6, 3] })
    expect(compiled).toEqual(interpreted)
  })

  it('preserves legacy direct-builder capture in macro output', () => {
    const { fn } = macroParser(`
import { literal, node, parser, regex, sequence } from 'parseman' with { type: 'macro' }
const ws = regex(/ +/)
const inner = parser({ trivia: ws, captureTrivia: true }, sequence(literal('b'), literal('c')))
export const P = parser({ trivia: ws }, node('Outer', sequence(literal('a'), inner, literal('d')),
  (_children, _fields, _span, _rawChildren, triviaLog) => ({ triviaLog: [...triviaLog] })))
`, 'P')

    expect(fn('a b c d', 0, {}).value).toEqual({ triviaLog: [1, 2, 1, 3, 4, 2, 5, 6, 3] })
  })
})
