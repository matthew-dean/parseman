import type { Combinator, ParseContext, ParseResult, ParserMeta, ParseFail } from '../types.ts'
import { sequenceFirstSet, firstSetOf, matchesEmpty, union } from './first-set.ts'
import {
  advanceTrivia, commitTriviaScan, needsDeferredTriviaCommit, rollbackScannedTriviaAt,
  scanTriviaCompact,
} from './trivia-skip.ts'
import { cstTlLen } from '../cst/capture-buffer.ts'
import { firstSetSentinel } from '../recovery/scan.ts'
import { adjacencyFail, adjacencyOf, holdsAdjacency, type AdjacencyDef } from './adjacency.ts'
import { scalarOf } from './scalar.ts'

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

  // Recovery follow sets are derived only when the general family runs tolerantly.
  let followSentinels: (Combinator<null> | null)[] | undefined

  return {
    _tag: 'sequence',
    _meta: meta,
    _def: def,
    _parseScalar: hasAdjacency ? undefined : parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnwrapParsers<T>> {
      const tolerant = ctx._tolerant === true
      if (tolerant) {
        followSentinels ??= parsers.map((_, i) => firstSetSentinel(
          parsers.slice(i + 1).reduce<ReturnType<typeof firstSetOf>>(
            (set, parser) => union(set, firstSetOf(parser)), { kind: 'empty' },
          ),
        ))
      }
      const inheritedSync = ctx._sync
      const deferredTrivia = needsDeferredTriviaCommit(ctx)
      const values: unknown[] | undefined = def.valueUnused ? undefined : []
      let cur = pos
      try {
        for (let i = 0; i < parsers.length; i++) {
          if (tolerant) ctx._sync = followSentinels![i] ?? inheritedSync
          const assertion = adjacency?.[i]
          if (assertion) {
            if (!holdsAdjacency(input, cur, ctx, assertion)) return adjacencyFail(cur, assertion)
            if (values !== undefined) values.push(null)
            continue
          }
          let termPos = cur
          const markTlog = deferredTrivia ? cstTlLen(ctx) : 0
          const markLog = deferredTrivia ? (ctx._triviaLog?.length ?? 0) : 0
          const markRootLog = deferredTrivia ? (ctx._rootTriviaLog?.length ?? 0) : 0
          if (ctx.trivia && i > 0) {
            termPos = deferredTrivia
              ? commitTriviaScan(scanTriviaCompact(input, cur, ctx))
              : advanceTrivia(input, cur, ctx)
          }
          const scanTlog = deferredTrivia ? cstTlLen(ctx) : 0
          const scanLog = deferredTrivia ? (ctx._triviaLog?.length ?? 0) : 0
          const scanRootLog = deferredTrivia ? (ctx._rootTriviaLog?.length ?? 0) : 0
          const result = parsers[i]!.parse(input, termPos, ctx)
          if (!result.ok) return result as ParseFail
          if (values !== undefined) values.push(result.value)
          if (result.span.end > termPos || termPos === cur) cur = result.span.end
          else if (deferredTrivia) {
            rollbackScannedTriviaAt(
              ctx, markTlog, scanTlog, markLog, scanLog, markRootLog, scanRootLog,
            )
          }
        }
      } finally {
        if (tolerant) ctx._sync = inheritedSync
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
