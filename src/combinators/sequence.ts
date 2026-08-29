import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { matchesEmpty, sequenceFirstSet } from './first-set.ts'
import { scalarOf, scalarResult } from './scalar.ts'
import { advanceTrivia } from './trivia-skip.ts'

type UnwrapParsers<T extends Combinator<unknown>[]> = {
  [K in keyof T]: T[K] extends Combinator<infer U> ? U : never
}

export function sequence<T extends [Combinator<unknown>, ...Combinator<unknown>[]]>(
  ...parsers: T
): Combinator<UnwrapParsers<T>> {
  const strictArity = (parsers.length === 2 && !matchesEmpty(parsers[1]!))
    || (parsers.length === 3 && parsers.every(p => !matchesEmpty(p)))
    ? parsers.length
    : 0
  const meta: ParserMeta = {
    firstSet: sequenceFirstSet(parsers),
    canMatchNewline: parsers.some(p => p._meta.canMatchNewline),
    isTrivia: false,
  }
  const def: { tag: 'sequence'; parsers: Combinator<unknown>[]; valueUnused?: boolean } =
    { tag: 'sequence', parsers: parsers as Combinator<unknown>[] }
  const scalarParsers = parsers.map(scalarOf)

  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    let cur = pos
    if (strictArity !== 0) {
      cur = scalarParsers[0]!(input, cur, ctx)
      if (cur < 0) return cur
      const first = ctx._sv
      if (ctx.trivia) cur = advanceTrivia(input, cur, ctx)
      cur = scalarParsers[1]!(input, cur, ctx)
      if (cur < 0) return cur
      const second = ctx._sv
      if (strictArity === 2) {
        ctx._sv = def.valueUnused ? undefined : [first, second]
        return cur
      }
      if (ctx.trivia) cur = advanceTrivia(input, cur, ctx)
      cur = scalarParsers[2]!(input, cur, ctx)
      if (cur < 0) return cur
      ctx._sv = def.valueUnused ? undefined : [first, second, ctx._sv]
      return cur
    }

    const values: unknown[] | undefined = def.valueUnused ? undefined : []
    for (let i = 0; i < scalarParsers.length; i++) {
      let termPos = cur
      if (i > 0 && ctx.trivia) termPos = advanceTrivia(input, cur, ctx)
      const end = scalarParsers[i]!(input, termPos, ctx)
      if (end < 0) return end
      if (values !== undefined) values.push(ctx._sv)
      if (end > termPos || termPos === cur) cur = end
    }
    ctx._sv = values
    return cur
  }

  return {
    _tag: 'sequence',
    _meta: meta,
    _def: def,
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
    },
  }
}
