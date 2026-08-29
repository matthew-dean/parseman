import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { sequenceFirstSet, firstSetOf, matchesEmpty, union } from './first-set.ts'
import {
  advanceTrivia, commitTriviaScan, needsDeferredTriviaCommit, rollbackScannedTriviaAt,
  scanTriviaCompact,
} from './trivia-skip.ts'
import { cstTlLen } from '../cst/capture-buffer.ts'
import { firstSetSentinel } from '../recovery/scan.ts'
import { adjacencyFail, adjacencyOf, holdsAdjacency, type AdjacencyDef } from './adjacency.ts'

type UnwrapParsers<T extends Combinator<unknown>[]> = {
  [K in keyof T]: T[K] extends Combinator<infer U> ? U : never
}

export function sequence<T extends [Combinator<unknown>, ...Combinator<unknown>[]]>(
  ...parsers: T
): Combinator<UnwrapParsers<T>> {
  // Adjacency markers (`adjacent()` / `notAdjacent()`) are BOUNDARY tests, lowered
  // here rather than parsed as terms. At index 0 there is no preceding term in this
  // sequence, and the gap before `pos` belongs to whoever called us — locally
  // undecidable, so reject it at construction instead of answering it wrongly.
  // Stays `null` for the overwhelming majority of sequences, which is the point:
  // every grammar builds thousands of these, and a per-sequence array to say "no
  // assertions here" would be a permanent retained allocation for a fact that is
  // almost always no.
  let adjacency: (AdjacencyDef | null)[] | null = null
  for (let i = 0; i < parsers.length; i++) {
    const a = adjacencyOf(parsers[i]!)
    if (a === null) continue
    if (i === 0) {
      throw new TypeError(
        `sequence(): ${a.polarity}() cannot be the FIRST term — an adjacency assertion tests the `
        + 'gap after the PRECEDING term. Put a concrete term first.',
      )
    }
    ;(adjacency ??= Array.from({ length: parsers.length }, () => null))[i] = a
  }
  const hasAdjacency = adjacency !== null
  const strictArity = !hasAdjacency
    && ((parsers.length === 2 && !matchesEmpty(parsers[1]!))
      || (parsers.length === 3 && parsers.every(p => !matchesEmpty(p))))
    ? parsers.length
    : 0

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
        const adj = adjacency === null ? null : adjacency[i]
        if (adj) {
          if (!holdsAdjacency(input, cur, ctx, adj)) return adjacencyFail(cur, adj)
          if (values !== undefined) values.push(null)
          continue
        }
        if (ctx.trivia && i > 0) {
          const mTlog = cstTlLen(ctx)
          const mLog = ctx._triviaLog?.length ?? 0
          const mRootLog = ctx._rootTriviaLog?.length ?? 0
          let scanEnd: number
          if (needsDeferredTriviaCommit(ctx)) {
            scanEnd = commitTriviaScan(scanTriviaCompact(input, cur, ctx))
          } else {
            scanEnd = advanceTrivia(input, cur, ctx)
          }
          const scanTlog = cstTlLen(ctx)
          const scanLog = ctx._triviaLog?.length ?? 0
          const scanRootLog = ctx._rootTriviaLog?.length ?? 0
          const result = parsers[i]!.parse(input, scanEnd, ctx)
          if (!result.ok) return result as ParseFail
          if (result.span.end > scanEnd) cur = result.span.end
          else rollbackScannedTriviaAt(
            ctx, mTlog, scanTlog, mLog, scanLog, mRootLog, scanRootLog,
          )
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

  // Strict twin of the loop below, for the (rare) sequence that carries an adjacency
  // assertion. FORKED rather than branched inline so the ordinary strict loop — the
  // hot path of every grammar — keeps exactly the instructions it had before.
  function parseAdjacent(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
    const values: unknown[] | undefined = def.valueUnused ? undefined : []
    let cur = pos

    for (let i = 0; i < parsers.length; i++) {
      const adj = adjacency![i]
      if (adj) {
        // Assert over the gap at `cur` and move nothing. The NEXT term re-scans the
        // same gap and owns the commit/rewind decision, so the tree, the spans and
        // the trivia log are byte-identical to the same sequence without the marker.
        if (!holdsAdjacency(input, cur, ctx, adj)) return adjacencyFail(cur, adj)
        if (values !== undefined) values.push(null)
        continue
      }
      if (ctx.trivia && i > 0) {
        let scanEnd: number
        const mTlog = cstTlLen(ctx)
        const mLog = ctx._triviaLog?.length ?? 0
        const mRootLog = ctx._rootTriviaLog?.length ?? 0
        if (needsDeferredTriviaCommit(ctx)) {
          scanEnd = commitTriviaScan(scanTriviaCompact(input, cur, ctx))
        } else {
          scanEnd = advanceTrivia(input, cur, ctx)
        }
        const scanTlog = cstTlLen(ctx)
        const scanLog = ctx._triviaLog?.length ?? 0
        const scanRootLog = ctx._rootTriviaLog?.length ?? 0
        const result = parsers[i]!.parse(input, scanEnd, ctx)
        if (!result.ok) return result as ParseFail
        if (result.span.end > scanEnd) cur = result.span.end
        else rollbackScannedTriviaAt(
          ctx, mTlog, scanTlog, mLog, scanLog, mRootLog, scanRootLog,
        )
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
      if (hasAdjacency) return parseAdjacent(input, pos, ctx)

      const deferredTrivia = needsDeferredTriviaCommit(ctx)
      let cur = pos

      if (strictArity !== 0) {
        const first = parsers[0]!.parse(input, cur, ctx)
        if (!first.ok) return first as ParseFail
        cur = first.span.end
        if (ctx.trivia) {
          cur = deferredTrivia
            ? commitTriviaScan(scanTriviaCompact(input, cur, ctx))
            : advanceTrivia(input, cur, ctx)
        }
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
        if (ctx.trivia) {
          cur = deferredTrivia
            ? commitTriviaScan(scanTriviaCompact(input, cur, ctx))
            : advanceTrivia(input, cur, ctx)
        }
        const third = parsers[2]!.parse(input, cur, ctx)
        if (!third.ok) return third as ParseFail
        return {
          ok: true,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          value: (def.valueUnused ? undefined : [first.value, second.value, third.value]) as UnwrapParsers<T>,
          span: { start: pos, end: third.span.end },
        }
      }

      // Skip the tuple when it's never observed (markUnusedValues): terms still
      // parse (and self-capture) — only the array of their values is elided.
      const values: unknown[] | undefined = def.valueUnused ? undefined : []
      for (let i = 0; i < parsers.length; i++) {
        if (ctx.trivia && i > 0) {
          // Skip trivia between terms, but only *consume* it for span purposes if
          // this term actually matches content past the trivia. A term that matches
          // empty (optional/many/lookahead) leaves the trivia for the enclosing rule.
          let scanEnd: number
          const mTlog = deferredTrivia ? cstTlLen(ctx) : 0
          const mLog = deferredTrivia ? (ctx._triviaLog?.length ?? 0) : 0
          const mRootLog = deferredTrivia ? (ctx._rootTriviaLog?.length ?? 0) : 0

          if (deferredTrivia) {
            scanEnd = commitTriviaScan(scanTriviaCompact(input, cur, ctx))
          } else {
            scanEnd = advanceTrivia(input, cur, ctx)
          }
          const scanTlog = deferredTrivia ? cstTlLen(ctx) : 0
          const scanLog = deferredTrivia ? (ctx._triviaLog?.length ?? 0) : 0
          const scanRootLog = deferredTrivia ? (ctx._rootTriviaLog?.length ?? 0) : 0

          const result = parsers[i]!.parse(input, scanEnd, ctx)
          if (!result.ok) return result as ParseFail
          if (result.span.end > scanEnd) {
            cur = result.span.end
          } else if (deferredTrivia) {
            rollbackScannedTriviaAt(
              ctx, mTlog, scanTlog, mLog, scanLog, mRootLog, scanRootLog,
            )
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
