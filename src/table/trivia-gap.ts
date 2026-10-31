import type { CharRange, Combinator, ParseContext } from '../types.ts'
import type { LabeledTriviaSpec } from '../cst/trivia-kinds.ts'
import { commitTriviaScan, fastTriviaScanner, scanTriviaCompact } from '../combinators/trivia-skip.ts'

/**
 * THE TABLE ENGINES' DEFERRED-COMMIT TRIVIA SKIP: `commitTriviaScan(scanTriviaCompact(…))`,
 * the path every labelled trivia scan takes once a log is live, answered without
 * the scan where the answer is already known. Both engines call it: the closure
 * engine's `skipTrivia` and the emitted assembly's skips.
 *
 * ONLY THE ROOT LOG IS LIVE, so only a root-selected chunk can be recorded,
 * and a run in which no character can start a selected arm holds none: its end
 * is the whole answer, and the unlabelled scanner gives it without the
 * chunk-by-chunk visit. Every chunk starts inside the run, so a run free of
 * selected leaders is free of selected chunks. jess parses with
 * `rootTrivia: { select: [comment labels] }`, which is this case for every run
 * of plain whitespace.
 *
 * A SEQUENCE TERM THAT MATCHES NOTHING hands back the cursor from BEFORE its
 * trivia, so the next term asks for the same gap again: on `benchmark.less`,
 * 21,741 of the closure engine's 53,607 trivia scans per parse started where
 * the previous one did. A scan that recorded nothing records nothing again from
 * the same position, in the same parse, under the same trivia, root selection,
 * root-capture policy, trivia log and state, and with no CST capture, and it
 * ends at the same place, so the last such scan answers the repeat (`ctx._gap`).
 * The state is part of the key because a trivia arm can read it (`gate`), and
 * the log because a `leaf` sets it aside while its child runs. The memo lives
 * on the context so it is released with the parse.
 *
 * Neither applies with `trackLines` (a scan records line ranges) or under CST
 * capture (a scan records into the open buffer).
 */
export function skipDeferredTrivia(input: string, cur: number, ctx: ParseContext): number {
  const triviaP = ctx.trivia
  const plain = ctx.trackLines !== true && ctx.captureTrivia !== true
  const gap = ctx._gap
  if (plain && gap !== undefined && cur === gap.at && input === gap.input && triviaP === gap.of
    && ctx._rootTriviaCapture === gap.root && ctx.state === gap.state
    && ctx._rootTriviaKindIndex === gap.rootKinds && ctx._triviaLog === gap.log) return gap.end
  const end = clearRunEnd(input, cur, ctx, triviaP, plain)
  if (end >= 0) {
    remember(cur, end, ctx, input, triviaP)
    return end
  }
  const scan = scanTriviaCompact(input, cur, ctx)
  if (typeof scan !== 'number') return commitTriviaScan(scan)
  if (plain) remember(cur, scan, ctx, input, triviaP)
  return scan
}

/** The end of the run at `cur` when nothing root-selected lies in it, else −1. */
function clearRunEnd(input: string, cur: number, ctx: ParseContext, triviaP: Combinator<unknown> | undefined, plain: boolean): number {
  const rootKinds = ctx._rootTriviaKindIndex
  const spec = triviaP?._meta.labeledTriviaSpec
  if (!plain || triviaP === undefined || spec == null || rootKinds === undefined || ctx._triviaLog !== undefined) return -1
  if (spec.rootKinds !== rootKinds) prime(spec, triviaP, rootKinds)
  const fast = spec.rootScan
  if (fast === null) return -1
  const end = fast(input, cur)
  return ctx._rootTriviaCapture === false || clearOf(spec.rootLeaders, input, cur, end) ? end : -1
}

function remember(cur: number, end: number, ctx: ParseContext, input: string, triviaP: Combinator<unknown> | undefined): void {
  const gap = ctx._gap
  if (gap === undefined) {
    ctx._gap = { at: cur, end, input, of: triviaP, root: ctx._rootTriviaCapture, rootKinds: ctx._rootTriviaKindIndex, log: ctx._triviaLog, state: ctx.state }
    return
  }
  gap.at = cur
  gap.end = end
  gap.input = input
  gap.of = triviaP
  gap.root = ctx._rootTriviaCapture
  gap.rootKinds = ctx._rootTriviaKindIndex
  gap.log = ctx._triviaLog
  gap.state = ctx.state
}

/**
 * Prime `spec` for the selection `rootKinds`: the first-character ranges of the
 * arms it selects, and the scanner, which is `null` where one of those arms is
 * unbounded or the trivia has no unlabelled scanner. `run()` builds one
 * selection per parse, so this runs once per parse per trivia.
 */
function prime(spec: LabeledTriviaSpec, triviaP: Combinator<unknown>, rootKinds: Readonly<Record<string, number>>): void {
  const ranges: CharRange[] = []
  let bounded = true
  for (const arm of spec.arms) {
    if (rootKinds[arm.label] === undefined) continue
    const fs = arm.parser._meta.firstSet
    if (fs.kind === 'any') bounded = false
    else if (fs.kind === 'ranges') ranges.push(...fs.ranges)
  }
  const classified = triviaP._meta.triviaScanner
  spec.rootKinds = rootKinds
  spec.rootLeaders = ranges
  spec.rootScan = !bounded ? null : classified === undefined ? fastTriviaScanner(triviaP) : classified
}

/** No character in `[from, to)` falls in `ranges`. A surrogate is never clear:
 * the ranges are code points, and a code unit cannot be checked against them. */
function clearOf(ranges: readonly CharRange[], input: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = input.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDFFF) return false
    for (const r of ranges) if (c >= r.lo && c <= r.hi) return false
  }
  return true
}
