import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'
import { scalarOf, scalarResult, type ScalarParser } from './scalar.ts'

/**
 * Create a forward-declared parser slot for mutually recursive grammars.
 *
 * Because JS evaluates arguments eagerly, you can't reference a variable
 * before it's declared. ref() creates a placeholder you fill in later:
 *
 *   const value = ref<JSONValue>()
 *   const array  = transform(sequence(literal('['), sepBy(value, literal(',')), literal(']')), ...)
 *   const object = transform(sequence(literal('{'), sepBy(pair, literal(',')), literal('}')), ...)
 *   value.define(choice(object, array, string, number, bool, nullVal))
 *
 * Unlike lazy(() => x), you use the ref directly — no wrapping at each call site.
 */
export function ref<T>(): Combinator<T> & { define(p: Combinator<T>): void } {
  let resolved: Combinator<T> | null = null
  let resolvedScalar: ScalarParser | null = null

  const meta: ParserMeta = {
    firstSet: any(),
    canMatchNewline: true,
    isTrivia: false,
  }

  const slot = {
    _tag: 'lazy' as const,
    _meta: meta,
    _def: {
      tag: 'lazy' as const,
      thunk: () => {
        if (!resolved) throw new Error('ref<T>() used before .define() was called')
        return resolved as Combinator<unknown>
      },
    },
    _parseScalar(input: string, pos: number, ctx: ParseContext): number {
      if (!resolved) throw new Error('ref<T>() used before .define() was called')
      return resolvedScalar!(input, pos, ctx)
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      if (!resolvedScalar) throw new Error('ref<T>() used before .define() was called')
      return scalarResult(resolvedScalar(input, pos, ctx), pos, ctx)
    },
    define(p: Combinator<T>): void {
      if (resolved) throw new Error('ref<T>() already defined')
      resolved = p
      resolvedScalar = scalarOf(p)
      meta.firstSet = p._meta.firstSet
      meta.canMatchNewline = p._meta.canMatchNewline
      meta.isTrivia = p._meta.isTrivia
      if (p._meta.triviaKindLabels !== undefined) meta.triviaKindLabels = p._meta.triviaKindLabels
      else delete meta.triviaKindLabels
      if (p._meta.disjoint !== undefined) meta.disjoint = p._meta.disjoint
      else delete meta.disjoint
    },
  }

  return slot
}
