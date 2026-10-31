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
 * It does not apply with `trackLines` (a scan records line ranges) or under CST
 * capture (a scan records into the open buffer).
 */
export function skipDeferredTrivia(input: string, cur: number, ctx: ParseContext): number {
  const rootKinds = ctx._rootTriviaKindIndex
  const triviaP = ctx.trivia
  const spec = triviaP?._meta.labeledTriviaSpec
  if (triviaP !== undefined && spec != null && rootKinds !== undefined && ctx._triviaLog === undefined
    && ctx.trackLines !== true && ctx.captureTrivia !== true) {
    if (spec.rootKinds !== rootKinds) prime(spec, triviaP, rootKinds)
    const fast = spec.rootScan
    if (fast !== null) {
      const end = fast(input, cur)
      if (ctx._rootTriviaCapture === false || clearOf(spec.rootLeaders, input, cur, end)) return end
    }
  }
  return commitTriviaScan(scanTriviaCompact(input, cur, ctx))
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
