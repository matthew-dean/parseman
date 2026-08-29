import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { matchesEmpty, sequenceFirstSet } from './first-set.ts'
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

  return {
    _tag: 'sequence',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
      let cur = pos
      if (strictArity !== 0) {
        const first = parsers[0]!.parse(input, cur, ctx)
        if (!first.ok) return first as ParseFail
        cur = first.span.end
        if (ctx.trivia) cur = advanceTrivia(input, cur, ctx)
        const second = parsers[1]!.parse(input, cur, ctx)
        if (!second.ok) return second as ParseFail
        if (strictArity === 2) {
          return {
            ok: true,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            value: (def.valueUnused ? undefined : [first.value, second.value]) as UnwrapParsers<T>,
            span: { start: pos, end: second.span.end },
          }
        }
        cur = second.span.end
        if (ctx.trivia) cur = advanceTrivia(input, cur, ctx)
        const third = parsers[2]!.parse(input, cur, ctx)
        if (!third.ok) return third as ParseFail
        return {
          ok: true,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          value: (def.valueUnused ? undefined : [first.value, second.value, third.value]) as UnwrapParsers<T>,
          span: { start: pos, end: third.span.end },
        }
      }

      const values: unknown[] | undefined = def.valueUnused ? undefined : []
      for (let i = 0; i < parsers.length; i++) {
        let termPos = cur
        if (i > 0 && ctx.trivia) termPos = advanceTrivia(input, cur, ctx)
        const result = parsers[i]!.parse(input, termPos, ctx)
        if (!result.ok) return result as ParseFail
        if (values !== undefined) values.push(result.value)
        if (result.span.end > termPos || termPos === cur) cur = result.span.end
      }
      return {
        ok: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        value: (values ?? undefined) as UnwrapParsers<T>,
        span: { start: pos, end: cur },
      }
    },
  }
}
