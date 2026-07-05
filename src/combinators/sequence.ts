import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { sequenceFirstSet } from './first-set.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from './trivia-skip.ts'

type UnwrapParsers<T extends Combinator<unknown>[]> = {
  [K in keyof T]: T[K] extends Combinator<infer U> ? U : never
}

export function sequence<T extends [Combinator<unknown>, ...Combinator<unknown>[]]>(
  ...parsers: T
): Combinator<UnwrapParsers<T>> {
  const meta: ParserMeta = {
    // Union through the nullable prefix — a leading optional()/many() lets a later
    // term's first char start the sequence. Just `parsers[0]` under-approximates.
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
      // Skip the tuple when it's never observed (markUnusedValues): terms still
      // parse (and self-capture) — only the array of their values is elided.
      const values: unknown[] | undefined = def.valueUnused ? undefined : []
      let cur = pos

      for (let i = 0; i < parsers.length; i++) {
        if (ctx.trivia && i > 0) {
          // Skip trivia between terms, but only *consume* it for span purposes if
          // this term actually matches content past the trivia. A term that matches
          // empty (optional/many/lookahead) leaves the trivia for the enclosing rule.
          let scanEnd: number
          let mark = saveTriviaMark(ctx)

          if (needsDeferredTriviaCommit(ctx)) {
            const scan = scanTrivia(input, cur, ctx)
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
            rollbackTrivia(ctx, mark)
          }
          if (values !== undefined) values.push(result.value)
          continue
        }

        const result = parsers[i]!.parse(input, cur, ctx)
        if (!result.ok) return result as ParseFail
        if (values !== undefined) values.push(result.value)
        cur = result.span.end
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
