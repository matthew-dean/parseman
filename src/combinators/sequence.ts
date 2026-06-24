import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { empty } from './first-set.ts'
import { advanceTrivia, needsDeferredTriviaCommit, scanTrivia } from './trivia-skip.ts'

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
        if (ctx.trivia && i > 0) {
          // Skip trivia between terms, but only *consume* it for span purposes if
          // this term actually matches content past the trivia. A term that matches
          // empty (optional/many/lookahead) leaves the trivia for the enclosing rule.
          let scanEnd: number
          let raw: unknown[] | undefined
          let mark = 0
          let tlog: number[] | undefined
          let tmark = 0

          if (needsDeferredTriviaCommit(ctx)) {
            const scan = scanTrivia(input, cur, ctx)
            raw = ctx._cstRawChildren as unknown[] | undefined
            mark = raw ? raw.length : 0
            tlog = ctx._cstTriviaLog
            tmark = tlog ? tlog.length : 0
            scan.commit()
            scanEnd = scan.end
          } else {
            scanEnd = advanceTrivia(input, cur, ctx)
          }

          const result = parsers[i]!.parse(input, scanEnd, ctx)
          if (!result.ok) return result as ParseFail
          if (result.span.end > scanEnd) {
            cur = result.span.end
          } else {
            if (raw) raw.length = mark
            if (tlog) tlog.length = tmark
          }
          values.push(result.value)
          continue
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
