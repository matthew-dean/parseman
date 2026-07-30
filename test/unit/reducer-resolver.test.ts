/**
 * Direct unit coverage for the reducer resolver's scope analysis and arity reading.
 *
 * The cross-module behaviour is pinned in `reducer-resolver-cross-module.test.ts` against
 * real files and real emitted artifacts. This file drives the resolver itself so each
 * scoping rule and each decline REASON is exercised individually — a decline that reports
 * the wrong reason sends the author to the wrong fix.
 */
import { describe, it, expect } from 'vitest'
import { parseSync } from 'oxc-parser'
import { createReducerResolver, functionArity } from '../../src/plugin/reducer-resolver.ts'

/** Resolve the reducer named at the `/*HERE*\/` marker in `src`. */
function resolveAt(src: string, expr: string): ReturnType<ReturnType<typeof createReducerResolver>['resolve']> {
  const code = src.trim()
  const offset = code.indexOf('/*HERE*/')
  if (offset < 0) throw new Error('test source needs a /*HERE*/ marker')
  const parsed = parseSync('/virtual/g.ts', code)
  expect(parsed.errors).toHaveLength(0)
  const r = createReducerResolver('/virtual/g.ts', parsed.program.body as unknown[], code)
  return r.resolve(expr, offset)
}

const arityOf = (src: string, expr: string): number | null => resolveAt(src, expr)?.arity ?? null
const reasonOf = (src: string, expr: string): string | undefined => resolveAt(src, expr)?.reason

describe('arity from the AST, not a regex', () => {
  const fn = (params: string) => {
    const parsed = parseSync('/v.ts', `const f = (${params}) => 0`)
    const decl = (parsed.program.body as unknown as Array<Record<string, unknown>>)[0]!
    const declarations = (decl.declarations as unknown as Array<Record<string, unknown>>)
    return functionArity(declarations[0]!.init as never)
  }

  it('counts plain, defaulted and destructured parameters positionally', () => {
    expect(fn('').arity).toBe(0)
    expect(fn('c').arity).toBe(1)
    expect(fn('c, f, s').arity).toBe(3)
    // A default does not remove a positional slot — the old regex rejected the list.
    expect(fn('c, f = undefined, s, r').arity).toBe(4)
    // Nor does destructuring: `{a}` still occupies position 1.
    expect(fn('{ a }, f, s').arity).toBe(3)
    expect(fn('[a, b], f').arity).toBe(2)
    expect(fn('c: A, f?: B, s: readonly unknown[]').arity).toBe(3)
    // A comma inside a generic type used to split the list into unparseable fragments.
    expect(fn('c: Map<string, number>, f').arity).toBe(2)
  })

  it('declines a rest parameter — the declared arity is unbounded', () => {
    expect(fn('...args')).toEqual({ arity: null, reason: 'rest-parameter' })
    expect(fn('c, f, ...rest')).toEqual({ arity: null, reason: 'rest-parameter' })
  })

  it('declines a non-arrow body that reads `arguments`', () => {
    const parsed = parseSync('/v.ts', 'const f = function (c) { return arguments.length }')
    const d = (parsed.program.body as unknown as Array<Record<string, unknown>>)[0]!
    const init = (d.declarations as unknown as Array<Record<string, unknown>>)[0]!.init
    expect(functionArity(init as never)).toEqual({ arity: null, reason: 'arguments' })
  })

  it('a nested function\'s `arguments` is not ours', () => {
    const parsed = parseSync('/v.ts', 'const f = function (c) { return function () { return arguments } }')
    const d = (parsed.program.body as unknown as Array<Record<string, unknown>>)[0]!
    const init = (d.declarations as unknown as Array<Record<string, unknown>>)[0]!.init
    expect(functionArity(init as never).arity).toBe(1)
  })

  it('ignores a TypeScript `this` parameter', () => {
    expect(fn('this: Ctx, c, f').arity).toBe(2)
  })
})

describe('scope analysis', () => {
  it('resolves a module-scope const arrow and function declaration', () => {
    expect(arityOf(`
const a = (c, f) => 0
function b(c, f, s) { return 0 }
const g = /*HERE*/a
`, 'a')).toBe(2)
    expect(arityOf(`
const a = (c, f) => 0
function b(c, f, s) { return 0 }
const g = /*HERE*/b
`, 'b')).toBe(3)
  })

  it('resolves a `let`/`var` that is never reassigned', () => {
    expect(arityOf('let a = (c, f) => 0\nconst g = /*HERE*/a', 'a')).toBe(2)
    expect(arityOf('var a = (c) => 0\nconst g = /*HERE*/a', 'a')).toBe(1)
  })

  it('declines a reassigned binding, by any spelling', () => {
    expect(reasonOf('let a = (c) => 0\na = (c, f, s, r, t, u) => 0\nconst g = /*HERE*/a', 'a')).toBe('reassigned')
    expect(reasonOf('let a = (c) => 0\na ||= (c, f) => 0\nconst g = /*HERE*/a', 'a')).toBe('reassigned')
  })

  it('picks the INNER binding when a name is genuinely shadowed', () => {
    // The outer `a` is arity 2; at the marker the binding in scope is the parameter.
    expect(reasonOf(`
const a = (c, f) => 0
const outer = (a) => {
  const g = /*HERE*/a
  return g
}
`, 'a')).toBe('not-a-function')
  })

  it('is unaffected by a same-name binding in a SIBLING scope', () => {
    expect(arityOf(`
const a = (c, f) => 0
const other = (a) => a
const another = function (a) { return a }
const g = /*HERE*/a
`, 'a')).toBe(2)
  })

  it('honours block scope and `var` hoisting to the function scope', () => {
    expect(arityOf(`
function outer() {
  { var v = (c, f, s) => 0 }
  const g = /*HERE*/v
  return g
}
`, 'v')).toBe(3)
    expect(reasonOf(`
const g0 = () => { const b = (c) => 0; return b }
const g = /*HERE*/b
`, 'b')).toBe('not-found')
  })

  it('resolves a named function EXPRESSION from inside its own body', () => {
    expect(arityOf(`
const outer = function self(c, f) {
  const g = /*HERE*/self
  return g
}
`, 'self')).toBe(2)
  })

  it('declines a catch parameter and a class binding', () => {
    expect(reasonOf(`
try { } catch (e) { const g = /*HERE*/e }
`, 'e')).toBe('not-a-function')
    expect(reasonOf('class K {}\nconst g = /*HERE*/K', 'K')).toBe('not-a-function')
  })

  it('follows an alias chain and reports a broken one', () => {
    expect(arityOf(`
function base(c, f, s) { return 0 }
const mid = base
const top = mid
const g = /*HERE*/top
`, 'top')).toBe(3)
    expect(reasonOf('const top = missing\nconst g = /*HERE*/top', 'top')).toBe('not-found')
  })

  it('resolves a member expression through a same-module object alias', () => {
    // `helpers` is not a namespace import here, so this is genuinely unresolvable —
    // and it says `not-a-function`, not a misleading "not found".
    expect(reasonOf(`
const helpers = { fold: (c) => 0 }
const g = /*HERE*/helpers.fold
`, 'helpers.fold')).toBe('not-a-function')
  })

  it('declines a computed initializer', () => {
    expect(reasonOf(`
const factory = () => (c) => 0
const a = factory()
const g = /*HERE*/a
`, 'a')).toBe('not-a-function')
    expect(reasonOf(`
const a = table[key]
const g = /*HERE*/a
`, 'a')).toBe('computed')
  })

  it('returns null for an INLINE function — the caller already has its source', () => {
    expect(resolveAt('const g = /*HERE*/x', '(c, f) => 0')).toBeNull()
    expect(resolveAt('const g = /*HERE*/x', 'function (c) { return c }')).toBeNull()
  })

  it('reports an unresolvable import specifier as such', () => {
    expect(reasonOf(`
import { fold } from './nope-does-not-exist.ts'
const g = /*HERE*/fold
`, 'fold')).toBe('unresolved-import')
    expect(reasonOf(`
import * as ns from './nope-does-not-exist.ts'
const g = /*HERE*/ns.fold
`, 'ns.fold')).toBe('unresolved-import')
  })

  it('declines a namespace import used WITHOUT a member', () => {
    expect(reasonOf(`
import * as ns from './x.ts'
const g = /*HERE*/ns
`, 'ns')).toBe('not-a-function')
  })
})
