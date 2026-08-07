/**
 * Branch coverage for `src/plugin/evaluator.ts` — the REJECTION paths.
 *
 * Almost every uncovered branch in this module is a guard that returns `null`, and
 * `null` is not a nicety: it is the macro saying "I cannot statically compile this",
 * which routes the rule to the interpreter. A guard that silently stopped rejecting
 * would MISCOMPILE — drop an option, drop a gate predicate, or bake a wrong arity.
 *
 * So each case here is written as a PAIR wherever the near-miss is meaningful: the
 * accepted spelling with its observable result, and the neighbouring spelling that
 * must be refused. Asserting only `toBeNull()` on an unpaired case is still a real
 * assertion — it pins that the macro declines rather than compiling something wrong.
 */
import { describe, it, expect } from 'vitest'
import { parseSync } from 'oxc-parser'
import type { Expression, Node } from '@oxc-project/types'
import {
  evaluateExpr,
  evaluateStaticValue,
  evaluateWordFactory,
  evaluateWhenFactory,
  evaluateParserFactory,
  evaluateCombinatorArray,
  applyDefineStatement,
  evaluateRefDeclaration,
  referencesAny,
  type Scope,
} from '../../src/plugin/evaluator.ts'
import { literal, parse } from '../../src/index.ts'

/** Parse `code` as a single expression. Offsets index `code` itself, so any
 *  source slice the evaluator takes (buildSrc, fnSrc, …) is byte-correct. */
function expr(code: string): Expression {
  const ast = parseSync('plugincov-eval.ts', code)
  expect(ast.errors).toHaveLength(0)
  const stmt = ast.program.body[0]
  if (!stmt || stmt.type !== 'ExpressionStatement') throw new Error(`not an expression: ${code}`)
  return stmt.expression as Expression
}

/** A scope holding arbitrary evaluator-internal entries (word/when factories,
 *  raw combinators, plain static values) without restating their private types. */
function scopeOf(entries: Record<string, unknown>): Scope {
  return new Map(Object.entries(entries)) as unknown as Scope
}

const ev = (code: string, scope: Scope = new Map(), mfs?: string[]) =>
  evaluateExpr(expr(code), scope, code, mfs)

const val = (code: string, scope: Scope = new Map()) =>
  evaluateStaticValue(expr(code), scope, code)

/** Evaluate a `rules(g => …)` factory written as its own source (offsets aligned). */
function factory(code: string, scope: Scope = new Map(), mfs: string[] = []) {
  const call = expr(code)
  if (call.type !== 'CallExpression') throw new Error('expected rules(...) call')
  const arg = call.arguments[0]
  if (!arg || arg.type === 'SpreadElement') throw new Error('expected a factory argument')
  return evaluateParserFactory(arg as Expression, scope, code, mfs)
}

// ---------------------------------------------------------------------------
// makeWord factory arguments
// ---------------------------------------------------------------------------

describe('makeWord() argument validation', () => {
  it('accepts a boundary string and refuses a non-string, non-object boundary', () => {
    expect(evaluateWordFactory(expr("makeWord('A-Za-z')"), new Map())).toEqual({
      tag: 'wordFactory', boundary: 'A-Za-z', caseInsensitive: false,
    })
    expect(evaluateWordFactory(expr('makeWord(5)'), new Map())).toBeNull()
  })

  it('refuses a spread argument list', () => {
    expect(evaluateWordFactory(expr('makeWord(...args)'), new Map())).toBeNull()
    expect(evaluateWordFactory(expr("makeWord('A-Za-z', ...rest)"), new Map())).toBeNull()
  })

  it('refuses an options argument that is not a plain object', () => {
    expect(evaluateWordFactory(expr("makeWord('A-Za-z', 5)"), new Map())).toBeNull()
    expect(evaluateWordFactory(expr("makeWord('A-Za-z', ['x'])"), new Map())).toBeNull()
  })

  it('refuses a non-boolean caseInsensitive in either argument position', () => {
    expect(evaluateWordFactory(expr("makeWord('A-Za-z', { caseInsensitive: 'yes' })"), new Map())).toBeNull()
    expect(evaluateWordFactory(expr("makeWord({ caseInsensitive: 'yes' })"), new Map())).toBeNull()
  })

  it('refuses an options-shaped boundary combined with a second argument', () => {
    expect(evaluateWordFactory(expr('makeWord({ caseInsensitive: true }, {})'), new Map())).toBeNull()
  })

  it('defaults caseInsensitive to false for an options object that omits it', () => {
    expect(evaluateWordFactory(expr('makeWord({})'), new Map())).toEqual({
      tag: 'wordFactory', boundary: '_0-9A-Za-z', caseInsensitive: false,
    })
  })

  it('refuses a non-makeWord call', () => {
    expect(evaluateWordFactory(expr("literal('a')"), new Map())).toBeNull()
    expect(evaluateWordFactory(expr("ns.makeWord('a')"), new Map())).toBeNull()
  })
})

describe('a word factory taken from scope', () => {
  const scope = () => scopeOf({ kw: { tag: 'wordFactory', boundary: 'A-Za-z', caseInsensitive: false } })

  it('builds a word parser from a scoped factory', () => {
    const combi = ev("kw('if')", scope())
    expect(combi?._def.tag).toBe('keywords')
    expect(parse(combi!, 'if').ok).toBe(true)
    expect(parse(combi!, 'iffy').ok).toBe(false)
  })

  it('refuses a scoped factory call with no argument, a spread, or a non-string', () => {
    expect(ev('kw()', scope())).toBeNull()
    expect(ev('kw(...names)', scope())).toBeNull()
    expect(ev('kw(1)', scope())).toBeNull()
  })

  it('refuses an inline makeWord() chain with no argument or an unresolvable one', () => {
    expect(ev("makeWord('A-Za-z')()")).toBeNull()
    expect(ev("makeWord('A-Za-z')(externalName)")).toBeNull()
    expect(ev("makeWord(5)('if')")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeWhen / dispatch arms
// ---------------------------------------------------------------------------

describe('makeWhen() argument validation', () => {
  it('defaults caseInsensitive to false with no options at all', () => {
    expect(evaluateWhenFactory(expr('makeWhen()'), new Map())).toEqual({
      tag: 'whenFactory', caseInsensitive: false,
    })
    expect(evaluateWhenFactory(expr('makeWhen({})'), new Map())).toEqual({
      tag: 'whenFactory', caseInsensitive: false,
    })
  })

  it('refuses a spread, an extra argument, a non-object, an unknown key, or a non-boolean', () => {
    expect(evaluateWhenFactory(expr('makeWhen(...o)'), new Map())).toBeNull()
    expect(evaluateWhenFactory(expr('makeWhen({}, 1)'), new Map())).toBeNull()
    expect(evaluateWhenFactory(expr('makeWhen(5)'), new Map())).toBeNull()
    expect(evaluateWhenFactory(expr('makeWhen({ boundary: 1 })'), new Map())).toBeNull()
    expect(evaluateWhenFactory(expr("makeWhen({ caseInsensitive: 'yes' })"), new Map())).toBeNull()
  })

  it('refuses a non-makeWhen call', () => {
    expect(evaluateWhenFactory(expr('makeWord()'), new Map())).toBeNull()
    expect(evaluateWhenFactory(expr('ns.makeWhen()'), new Map())).toBeNull()
  })
})

describe('dispatch arm values', () => {
  const whenScope = () => scopeOf({ w: { tag: 'whenFactory', caseInsensitive: true } })

  it('builds a when() arm from a scoped makeWhen factory, carrying its caseInsensitive', () => {
    expect(val("w('a', literal('x'))", whenScope())).toMatchObject({
      kind: 'when', keys: ['a'], caseInsensitive: true,
    })
    expect(val("w(['a', 'b'], literal('x'))", whenScope())).toMatchObject({
      kind: 'when', keys: ['a', 'b'], caseInsensitive: true,
    })
  })

  it('refuses a scoped-factory arm with wrong arity, a spread, a bad key, or a non-parser', () => {
    expect(val("w('a')", whenScope())).toBeNull()
    expect(val("w('a', literal('x'), 1)", whenScope())).toBeNull()
    expect(val('w(...args)', whenScope())).toBeNull()
    expect(val("w('a', 5)", whenScope())).toBeNull()
    expect(val("w(['a', 1], literal('x'))", whenScope())).toBeNull()
  })

  it('builds bare when()/otherwise() arms and their matcher form', () => {
    expect(val("when('a', literal('x'))")).toMatchObject({ kind: 'when', keys: ['a'], caseInsensitive: false })
    expect(val("when(['a', 'b'], literal('x'), { caseInsensitive: true })")).toMatchObject({
      kind: 'when', keys: ['a', 'b'], caseInsensitive: true,
    })
    expect(val("when(startsWith('-'), literal('x'))")).toMatchObject({ kind: 'whenMatcher' })
    expect(val("otherwise(literal('x'))")).toMatchObject({ kind: 'otherwise' })
  })

  it('refuses bare arms with spreads, bad options, non-parsers, or non-string keys', () => {
    expect(val("when(...ks, literal('x'))")).toBeNull()
    expect(val("when('a', ...rest)")).toBeNull()
    expect(val("when('a', literal('x'), { bogus: 1 })")).toBeNull()
    expect(val("when('a', 5)")).toBeNull()
    expect(val("when(['a', 1], literal('x'))")).toBeNull()
    expect(val('when(42, literal("x"))')).toBeNull()
    expect(val('otherwise()')).toBeNull()
    expect(val('otherwise(...p)')).toBeNull()
    expect(val('otherwise(5)')).toBeNull()
  })

  it('builds a matcher only from the exact matcher spellings', () => {
    expect(val("startsWith('-')")).toEqual({ kind: 'startsWith', value: '-' })
    expect(val("endsWith('-')")).toEqual({ kind: 'endsWith', value: '-' })
    expect(val('matches(/a/i)')).toMatchObject({ kind: 'matches', value: 'a', flags: 'i' })
    expect(val('startsWith()')).toBeNull()
    expect(val("startsWith('-', '+')")).toBeNull()
    expect(val('startsWith(...a)')).toBeNull()
    expect(val('startsWith(5)')).toBeNull()
    expect(val('matches()')).toBeNull()
    expect(val('matches(...a)')).toBeNull()
    expect(val("matches('a')")).toBeNull()
  })
})

describe('dispatch()', () => {
  it('compiles a dispatch over when()/otherwise() arms', () => {
    const combi = ev("dispatch(regex(/[a-z]+/), when('if', literal('if')), otherwise(literal('x')))")
    expect(combi?._def.tag).toBe('dispatch')
  })

  it('refuses a dispatch whose selector or arms cannot be resolved', () => {
    expect(ev('dispatch()')).toBeNull()
    expect(ev('dispatch(...a)')).toBeNull()
    expect(ev("dispatch(5, otherwise(literal('x')))")).toBeNull()
    expect(ev("dispatch(regex(/[a-z]/), ...arms)")).toBeNull()
    // An arm that is not a call at all, a member call, or a non-arm identifier.
    expect(ev('dispatch(regex(/[a-z]/), 5)')).toBeNull()
    expect(ev("dispatch(regex(/[a-z]/), ns.when('a', literal('x')))")).toBeNull()
    expect(ev('dispatch(regex(/[a-z]/), notAnArm)', scopeOf({ notAnArm: { value: 5, mfSrcs: [] } }))).toBeNull()
  })

  it('accepts an arm bound to a name in scope', () => {
    const arm = val("otherwise(literal('x'))")
    const combi = ev('dispatch(regex(/[a-z]/), namedArm)', scopeOf({ namedArm: { value: arm, mfSrcs: [] } }))
    expect(combi?._def.tag).toBe('dispatch')
  })
})

// ---------------------------------------------------------------------------
// Scope lookup
// ---------------------------------------------------------------------------

describe('identifier resolution against scope', () => {
  it('resolves a bare combinator stored in scope without a ScopeEntry wrapper', () => {
    const raw = literal('a')
    expect(ev('p', scopeOf({ p: raw }))).toBe(raw)
  })

  it('declines an unknown name and a non-combinator scope value', () => {
    expect(ev('unknownName')).toBeNull()
    expect(ev('n', scopeOf({ n: 5 }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// node() options
// ---------------------------------------------------------------------------

describe('node() option objects written inline', () => {
  it('reads options under a quoted key', () => {
    const combi = ev(`node('X', literal('a'), { 'unwrap': true })`)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') expect(combi._def.unwrap).toBe(true)
  })

  it('rejects a non-boolean flag, an out-of-range project, and an out-of-range buildArity', () => {
    expect(ev(`node('X', literal('a'), { unwrap: 'yes' })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { project: 1.5 })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { buildArity: 9 })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { buildArity: 'two' })`)).toBeNull()
  })

  it('accepts a declared buildArity and keeps it on the def', () => {
    const combi = ev(`node('X', literal('a'), () => null, { buildArity: 2 })`)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') expect(combi._def.buildArity).toBe(2)
  })

  it('treats an object with no recognised option key as empty options, not a builder', () => {
    const combi = ev(`node('X', literal('a'), { debugName: 'ignored' })`)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.build).toBeUndefined()
      expect(combi._def.buildSrc).toBeUndefined()
    }
  })

  it('rejects an unusable fourth options argument rather than dropping it', () => {
    expect(ev(`node('X', literal('a'), () => null, ...opts)`)).toBeNull()
    expect(ev(`node('X', literal('a'), () => null, 5)`)).toBeNull()
    expect(ev(`node('X', literal('a'), () => null, { unwrap: 'yes' })`)).toBeNull()
  })
})

describe('node() options resolved through a scoped value', () => {
  it('reads flags, project, tags and buildArity from a scoped plain object', () => {
    const combi = ev(`node('X', literal('a'), o)`, scopeOf({
      o: { collapse: true, tags: ['A'], buildArity: 3 },
    }))
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.collapse).toBe(true)
      expect(combi._def.tags).toEqual(['A'])
      expect(combi._def.buildArity).toBe(3)
      expect(combi._def.build).toBeUndefined()
    }
  })

  it('reads a scoped options object wrapped as a static value entry', () => {
    const combi = ev(`node('X', literal('a'), o)`, scopeOf({
      o: { value: { unwrap: true }, mfSrcs: [] },
    }))
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') expect(combi._def.unwrap).toBe(true)
  })

  it('treats a scoped object with no recognised key as absent options', () => {
    const combi = ev(`node('X', literal('a'), o)`, scopeOf({ o: {} }))
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.build).toBeUndefined()
      expect(combi._def.unwrap).toBeUndefined()
    }
  })

  it('rejects every bad value in a scoped options object', () => {
    for (const o of [
      { unwrap: 'yes' },
      { project: -1 },
      { project: 1.5 },
      { tags: 'A' },
      { tags: [1] },
      { buildArity: 9 },
      { buildArity: -1 },
    ]) {
      expect(ev(`node('X', literal('a'), o)`, scopeOf({ o }))).toBeNull()
    }
  })
})

describe('node() tags arrays', () => {
  it('reads a tags array from a scoped static-value entry', () => {
    const combi = ev(`node('X', literal('a'), { tags: t })`, scopeOf({
      t: { value: ['AtRule'], mfSrcs: [] },
    }))
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') expect(combi._def.tags).toEqual(['AtRule'])
  })

  it('rejects a tags value that is not a statically readable string array', () => {
    expect(ev(`node('X', literal('a'), { tags: 'AtRule' })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { tags: [...more] })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { tags: [, 'A'] })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { tags: [1] })`)).toBeNull()
    expect(ev(`node('X', literal('a'), { tags: t })`, scopeOf({ t: 'AtRule' }))).toBeNull()
  })
})

describe('node() shape rejections', () => {
  it('rejects missing, spread, or non-combinator arguments', () => {
    expect(ev('node()')).toBeNull()
    expect(ev('node(...a)')).toBeNull()
    expect(ev(`node('X')`)).toBeNull()
    expect(ev(`node('X', 5)`)).toBeNull()
  })

  it('records the type identifier when the node type is named by a binding', () => {
    const combi = ev(`node(typeName, literal('a'), () => null)`, scopeOf({ typeName: 'Fold' }))
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.type).toBe('Fold')
      expect(combi._def.typeSrc).toBe('typeName')
      expect(combi._def.buildSrc).toBe('() => null')
    }
  })

  it('supports the untyped node(parser, build) spelling', () => {
    const code = `node(literal('a'), (children) => children)`
    const combi = ev(code)
    expect(combi?._def.tag).toBe('node')
    if (combi?._def.tag === 'node') {
      expect(combi._def.type).toBeUndefined()
      expect(combi._def.buildSrc).toBe('(children) => children')
    }
  })
})

// ---------------------------------------------------------------------------
// Repeat / separator / lookahead / scanning combinators
// ---------------------------------------------------------------------------

describe('sepBy and oneOrMoreSep argument validation', () => {
  it('compiles oneOrMoreSep and honours a min option on sepBy', () => {
    expect(ev(`oneOrMoreSep(literal('a'), literal(','))`)?._def.tag).toBe('sepBy')
    const min1 = ev(`sepBy(literal('a'), literal(','), { min: 1 })`)
    expect(min1?._def.tag).toBe('sepBy')
    expect(parse(min1!, '').ok).toBe(false)
    expect(parse(min1!, 'a').ok).toBe(true)
  })

  it('rejects missing, spread, non-combinator, or unusable-options forms', () => {
    expect(ev(`sepBy(literal('a'))`)).toBeNull()
    expect(ev(`sepBy(...a)`)).toBeNull()
    expect(ev(`sepBy(literal('a'), ...s)`)).toBeNull()
    expect(ev(`sepBy(5, literal(','))`)).toBeNull()
    expect(ev(`sepBy(literal('a'), 5)`)).toBeNull()
    expect(ev(`sepBy(literal('a'), literal(','), ...o)`)).toBeNull()
    expect(ev(`sepBy(literal('a'), literal(','), 5)`)).toBeNull()
  })
})

describe('many and oneOrMore argument validation', () => {
  it('honours a min option instead of silently compiling a nullable repeat', () => {
    const min2 = ev(`many(literal('a'), { min: 2 })`)
    expect(min2?._def.tag).toBe('oneOrMore')
    expect(parse(min2!, 'a').ok).toBe(false)
    expect(parse(min2!, 'aa').ok).toBe(true)
  })

  it('works without a mapFn accumulator', () => {
    const code = `many(literal('a'))`
    expect(evaluateExpr(expr(code), new Map(), code)?._def.tag).toBe('many')
  })

  it('rejects missing, spread, non-combinator, or unusable-options forms', () => {
    expect(ev('many()')).toBeNull()
    expect(ev('many(...a)')).toBeNull()
    expect(ev('many(5)')).toBeNull()
    expect(ev(`many(literal('a'), ...o)`)).toBeNull()
    expect(ev(`many(literal('a'), 5)`)).toBeNull()
    expect(ev('oneOrMore()')).toBeNull()
    expect(ev('oneOrMore(5)')).toBeNull()
  })
})

describe('lookahead and scanning argument validation', () => {
  it('rejects not()/peek() without a resolvable inner parser', () => {
    expect(ev('not()')).toBeNull()
    expect(ev('not(...a)')).toBeNull()
    expect(ev('not(5)')).toBeNull()
    expect(ev('peek()')).toBeNull()
    expect(ev('peek(...a)')).toBeNull()
    expect(ev('peek(5)')).toBeNull()
  })

  it('rejects balanced() without two literal delimiter strings', () => {
    expect(ev(`balanced('(')`)).toBeNull()
    expect(ev('balanced(...a)')).toBeNull()
    expect(ev(`balanced('(', ...c)`)).toBeNull()
    expect(ev('balanced(1, 2)')).toBeNull()
  })

  it('rejects scanTo() without a resolvable sentinel parser', () => {
    expect(ev('scanTo()')).toBeNull()
    expect(ev('scanTo(...a)')).toBeNull()
    expect(ev(`scanTo('x')`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Source-capturing combinators
// ---------------------------------------------------------------------------

describe('transform() and leaf() source capture', () => {
  it('rejects missing or spread arguments rather than dropping the callback', () => {
    for (const name of ['transform', 'leaf']) {
      expect(ev(`${name}(literal('a'))`, new Map(), [])).toBeNull()
      expect(ev(`${name}(...a)`, new Map(), [])).toBeNull()
      expect(ev(`${name}(literal('a'), ...f)`, new Map(), [])).toBeNull()
      expect(ev(`${name}(5, x => x)`, new Map(), [])).toBeNull()
    }
  })

  it('captures a leaf() callback source on the def', () => {
    const mfs: string[] = []
    const combi = ev(`leaf(literal('a'), (v) => v)`, new Map(), mfs)
    expect(combi?._def.tag).toBe('leaf')
    expect(mfs).toEqual(['(v) => v'])
    if (combi?._def.tag === 'leaf') expect(combi._def.fnSrc).toBe('(v) => v')
  })
})

describe('gate() and withCtx() source capture', () => {
  it('declines a gate with no source-capture context, so the predicate is never dropped', () => {
    expect(evaluateExpr(expr('gate(s => true)'), new Map())).toBeNull()
    expect(evaluateExpr(expr('guard(s => true)'), new Map())).toBeNull()
  })

  it('captures a gate predicate source under both spellings', () => {
    for (const name of ['gate', 'guard']) {
      const mfs: string[] = []
      const combi = ev(`${name}(s => s.ok)`, new Map(), mfs)
      expect(combi?._def.tag).toBe('guard')
      expect(mfs).toEqual(['s => s.ok'])
      if (combi?._def.tag === 'guard') expect(combi._def.predSrc).toBe('s => s.ok')
    }
  })

  it('rejects a gate with no predicate argument', () => {
    expect(ev('gate()', new Map(), [])).toBeNull()
    expect(ev('gate(...p)', new Map(), [])).toBeNull()
  })

  it('declines withCtx with no source-capture context', () => {
    expect(evaluateExpr(expr(`withCtx({ a: 1 }, literal('x'))`), new Map())).toBeNull()
  })

  it('captures the withCtx extra source before the inner parser mapFns', () => {
    const mfs: string[] = []
    const combi = ev(`withCtx({ depth: 1 }, transform(literal('x'), v => v))`, new Map(), mfs)
    expect(combi?._def.tag).toBe('withCtx')
    expect(mfs).toEqual(['{ depth: 1 }', 'v => v'])
    if (combi?._def.tag === 'withCtx') expect(combi._def.extraSrc).toBe('{ depth: 1 }')
  })

  it('rejects withCtx with missing, spread, or non-combinator arguments', () => {
    expect(ev('withCtx({})', new Map(), [])).toBeNull()
    expect(ev('withCtx(...a)', new Map(), [])).toBeNull()
    expect(ev(`withCtx({}, ...i)`, new Map(), [])).toBeNull()
    expect(ev('withCtx({}, 5)', new Map(), [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Gated choice
// ---------------------------------------------------------------------------

describe('choice() with gated arms', () => {
  const GATED = `choice({ gate: s => s.ok, combinator: literal('a') }, literal('b'))`

  it('captures one gate source per arm, aligned with the built gates', () => {
    const mfs: string[] = []
    const combi = ev(GATED, new Map(), mfs)
    expect(combi?._def.tag).toBe('choice')
    expect(mfs).toEqual(['s => s.ok'])
    if (combi?._def.tag === 'choice') {
      expect(combi._def.gateSrcs).toEqual(['s => s.ok', null])
      expect(combi._def.gates.map(g => g === null)).toEqual([false, true])
    }
  })

  it('reads quoted gate/combinator keys the same as bare ones', () => {
    const mfs: string[] = []
    const combi = ev(`choice({ 'gate': s => s.ok, 'combinator': literal('a') }, literal('b'))`, new Map(), mfs)
    expect(combi?._def.tag).toBe('choice')
    if (combi?._def.tag === 'choice') expect(combi._def.gateSrcs).toEqual(['s => s.ok', null])
  })

  it('declines the whole choice with no source-capture context', () => {
    expect(evaluateExpr(expr(GATED), new Map())).toBeNull()
  })

  it('declines a gated choice whose arm object carries an extra, computed, or spread key', () => {
    expect(ev(`choice({ gate: s => s.ok, combinator: literal('a'), extra: 1 }, literal('b'))`, new Map(), [])).toBeNull()
    expect(ev(`choice({ [k]: 1, gate: s => s.ok, combinator: literal('a') }, literal('b'))`, new Map(), [])).toBeNull()
    expect(ev(`choice({ ...base, gate: s => s.ok, combinator: literal('a') }, literal('b'))`, new Map(), [])).toBeNull()
  })

  it('declines a gated choice with a spread argument or an unresolvable arm', () => {
    expect(ev(`choice({ gate: s => s.ok, combinator: literal('a') }, ...rest)`, new Map(), [])).toBeNull()
    expect(ev(`choice({ gate: s => s.ok, combinator: 5 }, literal('b'))`, new Map(), [])).toBeNull()
    expect(ev(`choice({ gate: s => s.ok, combinator: literal('a') }, 5)`, new Map(), [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// anyValue static value forms
// ---------------------------------------------------------------------------

describe('static value evaluation', () => {
  it('reads array holes as null and refuses array spreads', () => {
    expect(val('[, 1]')).toEqual([null, 1])
    expect(val('[...rest]')).toBeNull()
  })

  it('refuses object spreads and computed keys, and reads quoted keys', () => {
    expect(val('({ ...base })')).toBeNull()
    expect(val('({ [k]: 1 })')).toBeNull()
    expect(val("({ 'a': 1, b: 2 })")).toEqual({ a: 1, b: 2 })
  })

  it('reads computed member access with string and numeric keys, and refuses others', () => {
    const scope = scopeOf({ table: { a: 'A', 0: 'zero' } })
    expect(val("table['a']", scope)).toBe('A')
    expect(val('table[0]', scope)).toBe('zero')
    expect(val('table[true]', scope)).toBeNull()
    expect(val("table['missing']", scope)).toBeNull()
    expect(val('table.missing', scope)).toBeNull()
    expect(val('missingObject.a')).toBeNull()
  })

  it('returns undefined for the `undefined` identifier', () => {
    expect(val('undefined')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// rules() factory shapes
// ---------------------------------------------------------------------------

describe('evaluateParserFactory — factory signature', () => {
  it('rejects a factory that does not take exactly one plain identifier parameter', () => {
    expect(factory(`rules(() => ({ A: literal('a') }))`)).toBeNull()
    expect(factory(`rules((g, h) => ({ A: literal('a') }))`)).toBeNull()
    expect(factory(`rules(({ g }) => ({ A: literal('a') }))`)).toBeNull()
  })

  it('rejects a non-function first argument', () => {
    expect(factory(`rules(someFactory)`)).toBeNull()
  })

  it('rejects a body whose return statement has no argument', () => {
    expect(factory(`rules(g => { return })`)).toBeNull()
  })

  it('rejects a body with no return statement at all', () => {
    expect(factory(`rules(g => { const A = literal('a') })`)).toBeNull()
  })
})

describe('evaluateParserFactory — body statements', () => {
  it('rejects a declaration with no initializer', () => {
    expect(factory(`rules(g => { let A; return { A: literal('a') } })`)).toBeNull()
  })

  it('rejects a destructuring declaration', () => {
    expect(factory(`rules(g => { const { a } = opts; return { A: literal('a') } })`)).toBeNull()
  })

  it('rejects a declaration whose initializer is not statically evaluable', () => {
    expect(factory(`rules(g => { const A = externalThing(); return { A } })`)).toBeNull()
  })

  it('binds a dispatch arm declared in the body and reuses it in a rule', () => {
    const map = factory(`rules(g => {
  const fallback = otherwise(literal('x'))
  return { D: dispatch(regex(/[a-z]/), fallback) }
})`)
    // The rule itself, not a `lazy` wrapping it: `evaluateParserFactory` calls the real
    // `rules()`, which keeps a placeholder only for a key something referenced through
    // `g`. See `plugin-coverage.test.ts`'s note on the `A` rule for what that removed.
    expect(map?.get('D')?._def.tag).toBe('dispatch')
    // The selector consumes the leading letter; the `otherwise` arm parses the tail.
    expect(parse(map!.get('D')!, 'ax').ok).toBe(true)
    expect(parse(map!.get('D')!, 'ay').ok).toBe(false)
  })
})

describe('evaluateParserFactory — return object', () => {
  it('reads quoted rule keys and rejects computed ones', () => {
    const quoted = factory(`rules(g => ({ 'A': literal('a') }))`)
    expect(quoted?.has('A')).toBe(true)
    expect(factory(`rules(g => ({ [name]: literal('a') }))`)).toBeNull()
  })

  it('lets a later duplicate key win without double-defining the ref', () => {
    const map = factory(`rules(g => ({ A: literal('a'), A: literal('b') }))`)
    expect([...map!.keys()]).toEqual(['A'])
    expect(parse(map!.get('A')!, 'b').ok).toBe(true)
    expect(parse(map!.get('A')!, 'a').ok).toBe(false)
  })

  it('rejects a rule whose value is not a combinator', () => {
    expect(factory(`rules(g => ({ A: 5 }))`)).toBeNull()
  })

  it('rejects a rule defined as nothing but its own reference', () => {
    expect(factory(`rules(g => ({ A: g.A }))`)).toBeNull()
  })

  it('keeps the original rule name when one rule is an alias of another', () => {
    const map = factory(`rules(g => ({ A: literal('a'), B: g.A }))`)
    expect(map?.has('B')).toBe(true)
    expect(parse(map!.get('B')!, 'a').ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ref() / define()
// ---------------------------------------------------------------------------

describe('applyDefineStatement rejections', () => {
  const refScope = () => {
    const scope: Scope = new Map()
    evaluateRefDeclaration(expr('ref()'), 'item', scope)
    return scope
  }

  it('rejects anything that is not a `<name>.define(<expr>)` call', () => {
    expect(applyDefineStatement(expr('item'), refScope(), 'item')).toBe(false)
    expect(applyDefineStatement(expr(`item.other(literal('x'))`), refScope(), `item.other(literal('x'))`)).toBe(false)
    expect(applyDefineStatement(expr(`make().define(literal('x'))`), refScope(), `make().define(literal('x'))`)).toBe(false)
  })

  it('rejects a target that is not a ref slot', () => {
    const code = `p.define(literal('x'))`
    expect(applyDefineStatement(expr(code), scopeOf({ p: literal('a') }), code)).toBe(false)
    expect(applyDefineStatement(expr(code), new Map(), code)).toBe(false)
  })

  it('rejects a wrong argument count, a spread, or a non-combinator argument', () => {
    for (const code of [
      'item.define()',
      `item.define(literal('x'), 1)`,
      'item.define(...a)',
      'item.define(5)',
    ]) {
      expect(applyDefineStatement(expr(code), refScope(), code)).toBe(false)
    }
  })

  it('rejects a second define on an already-defined ref instead of throwing', () => {
    const scope = refScope()
    const code = `item.define(literal('x'))`
    expect(applyDefineStatement(expr(code), scope, code)).toBe(true)
    expect(applyDefineStatement(expr(code), scope, code)).toBe(false)
  })

  it('accepts a ref stored in scope as a bare combinator', () => {
    const scope = refScope()
    const entry = scope.get('item')!
    const bare = scopeOf({ item: entry.combi })
    const code = `item.define(literal('x'))`
    expect(applyDefineStatement(expr(code), bare, code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('evaluateCombinatorArray', () => {
  it('rejects a non-array expression outright', () => {
    expect(evaluateCombinatorArray(expr(`literal('a')`), new Map())).toBeNull()
  })
})

describe('referencesAny', () => {
  it('walks past object children that are not AST nodes', () => {
    // A regex Literal carries a plain `{ pattern, flags }` object with no `type`.
    expect(referencesAny(expr('/abc/g') as Node, new Set(['abc']), new Map())).toBe(false)
    expect(referencesAny(expr('sequence(/abc/g, wanted)') as Node, new Set(['wanted']), new Map())).toBe(true)
  })
})

describe('unsupported callee shapes', () => {
  it('declines a namespaced combinator call', () => {
    expect(ev(`ns.literal('a')`)).toBeNull()
  })

  it('declines rules() reached through evaluateExpr', () => {
    expect(ev(`rules(g => ({ A: literal('a') }))`)).toBeNull()
  })

  it('declines an unknown factory name', () => {
    expect(ev(`notACombinator('a')`)).toBeNull()
  })
})
