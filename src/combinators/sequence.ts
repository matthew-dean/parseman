import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { empty } from './first-set.ts'

type UnwrapParsers<T extends Combinator<unknown>[]> = {
  [K in keyof T]: T[K] extends Combinator<infer U> ? U : never
}

export function sequence<T extends [Combinator<unknown>, ...Combinator<unknown>[]]>(
  ...parsers: T
): Combinator<UnwrapParsers<T>> {
  const meta: ParserMeta = {
    firstSet: parsers[0]?._meta.firstSet ?? empty(),
    canMatchNewline: parsers.some(p => p._meta.canMatchNewline),
    isTrivia: false,
  }

  return {
    _tag: 'sequence',
    _meta: meta,
    _def: { tag: 'sequence', parsers: parsers as Combinator<unknown>[] },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
      const values: unknown[] = []
      let cur = pos

      for (let i = 0; i < parsers.length; i++) {
        // skip trivia between terms (not before the first)
        if (ctx.trivia && i > 0) {
          const tr = ctx.trivia.parse(input, cur, { trivia: ctx.trivia, trackLines: ctx.trackLines, user: ctx.user })
          if (tr.ok) {
            if (ctx._cstRawChildren && tr.span.end > tr.span.start)
              (ctx._cstRawChildren as unknown[]).push({ _tag: 'trivia', value: input.slice(tr.span.start, tr.span.end), span: tr.span })
            cur = tr.span.end
          }
        }

        const result = parsers[i]!.parse(input, cur, ctx)
        if (!result.ok) return result as ParseFail
        values.push(result.value)
        cur = result.span.end
      }

      return {
        ok: true,
        value: values as UnwrapParsers<T>,
        span: { start: pos, end: cur },
      }
    },
  }
}
