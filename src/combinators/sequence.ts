import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { sequenceFirstSet, firstSetOf, union } from './first-set.ts'
import { advanceTrivia, needsDeferredTriviaCommit, rollbackTrivia, saveTriviaMark, scanTrivia } from './trivia-skip.ts'
import { firstSetSentinel } from '../recovery/scan.ts'

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

  // Automatic recovery-sync inference, built lazily on the first tolerant parse and
  // never touched on the strict path: followSentinels[i] matches (zero-width) when
  // the input could start any term AFTER i, so a list nested in term i can resync
  // to this sequence's enclosing delimiter with NO grammar annotation. This is the
  // whole of "recovery config" — derived from structure, not authored.
  let followSentinels: (Combinator<null> | null)[] | undefined

  // Tolerant twin of the strict loop: identical term-parsing, but around each term
  // it publishes the inferred follow sentinel into ctx._sync so a nested list can
  // resync to this sequence's enclosing delimiter. Cold path (tolerant only).
  function parseTolerant(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
    followSentinels ??= parsers.map((_, i) => {
      // A nested list can resync to the start of ANY term that follows it here, so
      // union every following term's first set (not just up to the first
      // non-nullable one — a mandatory middle term must not hide a later close).
      const fs = parsers.slice(i + 1).reduce<ReturnType<typeof firstSetOf>>(
        (acc, p) => union(acc, firstSetOf(p)),
        { kind: 'empty' },
      )
      return firstSetSentinel(fs)
    })
    const values: unknown[] | undefined = def.valueUnused ? undefined : []
    let cur = pos
    const inheritedSync = ctx._sync
    try {
      for (let i = 0; i < parsers.length; i++) {
        // Publish this term's follow set (or keep the inherited sync when the local
        // follow isn't usable, e.g. the last term or an `any` first set).
        ctx._sync = followSentinels[i] ?? inheritedSync
        if (ctx.trivia && i > 0) {
          const mark = saveTriviaMark(ctx)
          let scanEnd: number
          if (needsDeferredTriviaCommit(ctx)) {
            const scan = scanTrivia(input, cur, ctx)
            scan.commit()
            scanEnd = scan.end
          } else {
            scanEnd = advanceTrivia(input, cur, ctx)
          }
          const result = parsers[i]!.parse(input, scanEnd, ctx)
          if (!result.ok) return result as ParseFail
          if (result.span.end > scanEnd) cur = result.span.end
          else rollbackTrivia(ctx, mark)
          if (values !== undefined) values.push(result.value)
          continue
        }
        const result = parsers[i]!.parse(input, cur, ctx)
        if (!result.ok) return result as ParseFail
        if (values !== undefined) values.push(result.value)
        cur = result.span.end
      }
    } finally {
      ctx._sync = inheritedSync
    }
    return {
      ok: true,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      value: (values ?? undefined) as UnwrapParsers<T>,
      span: { start: pos, end: cur },
    }
  }

  return {
    _tag: 'sequence',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
      // One cold branch: in tolerant mode publish each term's follow-set as ctx._sync
      // so a nested list resyncs to the enclosing delimiter (dynamic scoping through
      // refs carries this across rule boundaries automatically). The strict loop
      // below is byte-identical to a parser with no recovery.
      if (ctx._tolerant) return parseTolerant(input, pos, ctx)

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
