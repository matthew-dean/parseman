import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'

/**
 * Defers parser construction until first use — necessary for recursive grammars
 * where a parser references itself (e.g. JSON value contains JSON arrays/objects).
 *
 * The thunk is called once and the result cached. First-set metadata is
 * approximated as 'any' since it's unknown at construction time; this means
 * lazy parsers inside choice() won't get O(1) disjoint dispatch, but they
 * will work correctly.
 *
 * The compiler treats lazy as a runtime fallback (can't inline recursive parsers).
 */
export function lazy<T>(thunk: () => Combinator<T>): Combinator<T> {
  let cached: Combinator<T> | null = null
  const resolve = (): Combinator<T> => (cached ??= thunk())

  const meta: ParserMeta = {
    firstSet: any(),
    canMatchNewline: true,
    isTrivia: false,
  }

  return {
    _tag: 'lazy',
    _meta: meta,
    _def: { tag: 'lazy', thunk: thunk as () => Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      return resolve().parse(input, pos, ctx)
    },
  }
}
