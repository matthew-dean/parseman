/**
 * node() type-argument spellings — pins all three ways a caller can supply
 * type arguments to the `type`-first overloads, and pins what `Type` (the
 * NODE_TYPE brand carried for grammar-aware visitors) resolves to in each.
 *
 * The middle spelling, `node<N>('X', …)`, is the one that regressed: `Type`
 * had no default, so one explicit type argument failed the arity check, the
 * call fell through to the combinator-first overloads, and the caller got
 * `TS2345 string is not assignable to Combinator` plus a TS7006 implicit-any
 * reducer. Simply asserting that each spelling COMPILES is not enough — a
 * future removal of the `= string` default would be caught, but a future
 * change that keeps the default while silently widening the OTHER two
 * spellings to `string` would not. So each case asserts the resolved brand.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import { literal, node, parse, sequence } from '../../src/index.ts'
import type { Combinator } from '../../src/index.ts'
import { NODE_TYPE } from '../../src/cst/reflection.ts'

interface Value { kind: 'value'; n: number }

/** The NODE_TYPE brand a `node()` call resolved to. */
type BrandOf<C> = C extends { readonly [NODE_TYPE]?: infer T } ? T : never
/** The value type a `node()` call resolved to. */
type ValueOf<C> = C extends Combinator<infer T> ? T : never

const body = sequence(literal('a'), literal('b'))
const build = (children: ReadonlyArray<unknown>): Value => ({ kind: 'value', n: children.length })

// (1) no explicit type arguments — both N and Type are inferred.
const Inferred = node('X', body, build)
// (2) explicit N only — the spelling that must keep compiling.
const ExplicitValue = node<Value>('X', body, (children) => ({ kind: 'value', n: children.length }))
// (3) explicit N and Type.
const ExplicitBoth = node<Value, 'X'>('X', body, (children) => ({ kind: 'value', n: children.length }))

describe('node() — explicit type-argument spellings', () => {
  it('node("X", …) infers the value type and preserves the "X" literal brand', () => {
    expectTypeOf<BrandOf<typeof Inferred>>().toEqualTypeOf<'X'>()
    expectTypeOf<ValueOf<typeof Inferred>>().toEqualTypeOf<Value>()
  })

  it('node<N>("X", …) resolves the value type to N and the brand to `string`', () => {
    // `Type` is filled from its DEFAULT, never inferred — TypeScript has no
    // partial type-argument inference — so the "X" literal is lost here. This
    // is the documented residual cost of the fix, not an accident; assert it
    // so a future signature change that claims to preserve the literal has to
    // update this line deliberately.
    expectTypeOf<ValueOf<typeof ExplicitValue>>().toEqualTypeOf<Value>()
    expectTypeOf<BrandOf<typeof ExplicitValue>>().toEqualTypeOf<string>()
    expectTypeOf<BrandOf<typeof ExplicitValue>>().not.toEqualTypeOf<'X'>()
  })

  it('node<N, "X">("X", …) resolves both — value type N and the "X" literal brand', () => {
    expectTypeOf<ValueOf<typeof ExplicitBoth>>().toEqualTypeOf<Value>()
    expectTypeOf<BrandOf<typeof ExplicitBoth>>().toEqualTypeOf<'X'>()
  })

  it('the reducer parameters are contextually typed in every spelling', () => {
    // A rejected overload leaves the reducer untyped and `children` implicitly
    // `any` (TS7006). Naming the parameter types here fails to compile if that
    // ever comes back.
    node<Value>('X', body, (children, fields, span) => {
      expectTypeOf(children).toEqualTypeOf<ReadonlyArray<unknown>>()
      expectTypeOf(span).toEqualTypeOf<{ start: number; end: number }>()
      return { kind: 'value', n: children.length + (fields === undefined ? 0 : 1) }
    })
  })

  it('all three spellings parse identically at runtime', () => {
    for (const rule of [Inferred, ExplicitValue, ExplicitBoth]) {
      const result = parse(rule, 'ab')
      expect(result).toEqual({ ok: true, value: { kind: 'value', n: 2 }, span: { start: 0, end: 2 } })
    }
  })
})
