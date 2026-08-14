import type { Combinator, ParseContext, ParseFail, ParseResult } from '../types.ts'
import { literalCodePoints, parseClassOperand, parseClassRanges } from '../regex/classes.ts'
import {
  analyzeLabeledTrivia,
  recordTriviaChunks,
  scanLabeledTriviaEnd,
  scanLabeledTriviaChunks,
  visitLabeledTrivia,
} from '../cst/trivia-kinds.ts'
import {
  pushCstTriviaEntry,
  pushTriviaLogEntry,
  rollbackCstCapture,
  rollbackCstCaptureAt,
  saveCstMark,
} from '../cst/capture-buffer.ts'
import { recordLineRangeFromContext } from '../line-index.ts'
import { createDetachedParseContext } from '../parse-context.ts'
import { commonCssTriviaScanner } from '../cst/trivia-css-scanner.ts'

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }
export type CompactTriviaScan = number | TriviaScan

/** Saved lengths for rolling back speculative trivia commits. */
export type TriviaRollbackMark = { raw: number; tlog: number; leaves: number; fields: number; errors: number; log: number; rootLog: number }

const NOOP_COMMIT = () => {}

export function triviaScanEnd(scan: CompactTriviaScan): number {
  return typeof scan === 'number' ? scan : scan.end
}

export function commitTriviaScan(scan: CompactTriviaScan): number {
  if (typeof scan === 'number') return scan
  scan.commit()
  return scan.end
}
export type FastTriviaScanner = (input: string, cur: number) => number
/**
 * Bounded structural cache for the handful of trivia grammars a process actively
 * parses.  A module-global WeakMap used to allocate on every table-runtime
 * import, even though emitted artifacts only need this during construction.
 *
 * Four scalar slots keep the common grammar switches hot without a collection,
 * a per-parser property transition, or an unbounded process-retaining cache.
 * Cache misses merely rebuild a construction-time scanner and remain correct.
 */
let fastTrivia0: Combinator<unknown> | undefined
let fastTrivia1: Combinator<unknown> | undefined
let fastTrivia2: Combinator<unknown> | undefined
let fastTrivia3: Combinator<unknown> | undefined
let fastScanner0: FastTriviaScanner | null | undefined
let fastScanner1: FastTriviaScanner | null | undefined
let fastScanner2: FastTriviaScanner | null | undefined
let fastScanner3: FastTriviaScanner | null | undefined

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._rootTriviaLog !== undefined || ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined
}

export function saveTriviaMark(ctx: ParseContext): TriviaRollbackMark {
  const m = saveCstMark(ctx)
  return {
    raw: m.raw,
    tlog: m.tlog,
    leaves: m.leaves,
    fields: m.fields,
    errors: m.errors,
    log: ctx._triviaLog ? ctx._triviaLog.length : 0,
    rootLog: ctx._rootTriviaLog ? ctx._rootTriviaLog.length : 0,
  }
}

/**
 * Trivia rollback from SCALAR marks — the allocation-free twin of
 * `rollbackTrivia`. See `rollbackCstCaptureAt`; `saveTriviaMark` allocates twice
 * (this wrapper plus the CST mark it delegates to) and the table driver took one
 * per sequence term and per repetition item.
 */
export function rollbackTriviaAt(
  ctx: ParseContext,
  raw: number,
  tlog: number,
  leaves: number,
  fields: number,
  errors: number,
  log: number,
  rootLog: number,
): void {
  rollbackCstCaptureAt(ctx, raw, tlog, leaves, fields, errors)
  if (ctx._triviaLog && ctx._triviaLog.length !== log) ctx._triviaLog.length = log
  if (ctx._rootTriviaLog && ctx._rootTriviaLog.length !== rootLog) ctx._rootTriviaLog.length = rootLog
}

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  rollbackCstCapture(ctx, { raw: mark.raw, tlog: mark.tlog, leaves: mark.leaves, fields: mark.fields, errors: mark.errors })
  // Guarded like every other truncation — see rollbackCstCapture.
  if (ctx._triviaLog && ctx._triviaLog.length !== mark.log) ctx._triviaLog.length = mark.log
  if (ctx._rootTriviaLog && ctx._rootTriviaLog.length !== mark.rootLog) ctx._rootTriviaLog.length = mark.rootLog
}

function removeNumberRange(values: number[] | undefined, start: number, end: number): void {
  if (values === undefined || end <= start) return
  if (values.length > end) values.copyWithin(start, end)
  values.length -= end - start
}

/**
 * Remove only the trivia rows appended by an ambient scan, preserving rows a
 * successful zero-width child appended after that scan.
 *
 * A sequence cannot use `rollbackTriviaAt` for this case: its pre-scan mark also
 * precedes the child, so truncating to it erases the child's nodes, fields,
 * recovery errors, and trivia. The scan's contribution is instead the half-open
 * range between the pre-scan and post-scan lengths. Compact that range in place;
 * this is the cold zero-width-success path and allocates no replacement arrays.
 */
export function rollbackScannedTriviaAt(
  ctx: ParseContext,
  tlogStart: number,
  tlogEnd: number,
  logStart: number,
  logEnd: number,
  rootLogStart: number,
  rootLogEnd: number,
): void {
  const b = ctx._cstBuf
  if (b !== undefined) {
    const tlog = b.tl
    removeNumberRange(tlog, tlogStart, tlogEnd)
    if (tlog !== undefined && tlog.length === 0) b.tl = undefined
  } else {
    removeNumberRange(ctx._cstTriviaLog, tlogStart, tlogEnd)
  }
  removeNumberRange(ctx._triviaLog, logStart, logEnd)
  removeNumberRange(ctx._rootTriviaLog, rootLogStart, rootLogEnd)
}

function parseTriviaNoCapture(
  triviaP: Combinator<unknown>,
  input: string,
  cur: number,
  ctx: ParseContext,
): ParseResult<unknown> {
  const probeCtx = createDetachedParseContext(ctx.trackLines, ctx.state)
  probeCtx._lineIndex = ctx._lineIndex
  probeCtx._lineStarts = ctx._lineStarts
  probeCtx._lineScannedTo = ctx._lineScannedTo
  const result = triviaP.parse(input, cur, probeCtx)
  ctx._lineScannedTo = probeCtx._lineScannedTo
  return result
}

/**
 * A ZERO-WIDTH LOOKAHEAD's mark: everything `saveTriviaMark` covers, plus the
 * completions probe's current best failure.
 *
 * `_probe` is a sink like any other — `failAt` (probe.ts) replaces
 * `ctx._probe.best` whenever a failure lands at or before the cursor — but it is
 * deliberately NOT part of `rollbackTrivia`, because most rollbacks must leave it
 * alone. A failed `choice` arm or `sequence` term SHOULD keep its contribution:
 * merging the expectations of alternatives that failed at the cursor is exactly
 * how `completionsAt` builds its set.
 *
 * A lookahead is the exception. `peek`/`not` consume nothing on EITHER outcome
 * and promise to leave no observable trace, so expectations raised INSIDE the
 * probe are not reachable from the enclosing grammar at the cursor:
 * `peek(sequence(literal('a'), literal('zzz')))` over `"ab"` offered `"zzz"` as
 * the ONLY completion, though no input can ever reach it there.
 */
export type LookaheadMark = TriviaRollbackMark & { probeBest: ParseFail | null }

export function saveLookaheadMark(ctx: ParseContext): LookaheadMark {
  return { ...saveTriviaMark(ctx), probeBest: ctx._probe ? ctx._probe.best : null }
}

export function rollbackLookahead(ctx: ParseContext, mark: LookaheadMark): void {
  rollbackTrivia(ctx, mark)
  if (ctx._probe) ctx._probe.best = mark.probeBest
}

function scanWithLabels(input: string, cur: number, ctx: ParseContext): CompactTriviaScan {
  const triviaP = ctx.trivia!
  const spec = analyzeLabeledTrivia(triviaP)
  if (!spec) return cur

  const log = ctx._triviaLog
  const rootLog = ctx._rootTriviaLog
  const rootKinds = ctx._rootTriviaKindIndex
  const captureTl = ctx.captureTrivia && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)
  const mask = ctx._triviaCaptureMask
  let fullRows: number[] | undefined
  let rootRows: number[] | undefined
  let cstRows: number[] | undefined
  const visitedEnd = visitLabeledTrivia(input, cur, spec, ctx.state, (start, matchEnd, kindIndex) => {
    if (log !== undefined) (fullRows ??= []).push(start, matchEnd, kindIndex)
    const selectedKind = rootLog === undefined || rootKinds === undefined || ctx._rootTriviaCapture === false
      ? undefined
      : rootKinds[spec.labels[kindIndex] ?? '']
    if (selectedKind !== undefined) (rootRows ??= []).push(start, matchEnd, selectedKind)
    if (captureTl && (mask === undefined || (mask & (1 << kindIndex)) !== 0)) {
      (cstRows ??= []).push(start, matchEnd, kindIndex)
    }
  })
  if (visitedEnd !== undefined) {
    if (visitedEnd === cur) return cur
    if (fullRows === undefined && rootRows === undefined && cstRows === undefined) return visitedEnd
    return {
      end: visitedEnd,
      commit: () => {
        if (fullRows !== undefined && log !== undefined) log.push(...fullRows)
        if (rootRows !== undefined && rootLog !== undefined) {
          for (let i = 0; i < rootRows.length; i += 3) {
            rootLog.push(cur, visitedEnd, rootRows[i]!, rootRows[i + 1]!, rootRows[i + 2]!)
          }
        }
        if (cstRows !== undefined) {
          for (let i = 0; i < cstRows.length; i += 3) {
            pushCstTriviaEntry(ctx, cstRows[i]!, cstRows[i + 1]!, cstRows[i + 2]!)
          }
        }
      },
    }
  }

  const { end, chunks } = scanLabeledTriviaChunks(input, cur, spec, ctx.state)
  if (end === cur) return cur

  return {
    end,
    commit: () => recordTriviaChunks(ctx, chunks),
  }
}

/** Skip classified trivia without constructing retained chunk records. */
function skipWithLabels(input: string, cur: number, ctx: ParseContext): number {
  const spec = analyzeLabeledTrivia(ctx.trivia!)
  if (spec) return scanLabeledTriviaEnd(input, cur, spec, ctx.state)
  const tr = parseTriviaNoCapture(ctx.trivia!, input, cur, ctx)
  return tr.ok && tr.span.end > cur ? tr.span.end : cur
}

/** End of the trivia run at `cur` via the interpreter — the no-scanner fallback. */
function triviaEndByParse(
  triviaP: Combinator<unknown>,
  input: string,
  cur: number,
  ctx: ParseContext,
  trackLines: boolean,
): number {
  const tr = triviaP.parse(input, cur, createDetachedParseContext(trackLines, ctx.state))
  return tr.ok ? tr.span.end : cur
}

/**
 * Skip trivia at `cur` and return the new position. No recording, no wrapper
 * object — use between sequence/repeat terms when CST trivia capture is off.
 */
export function advanceTrivia(input: string, cur: number, ctx: ParseContext): number {
  const triviaP = ctx.trivia
  if (!triviaP) return cur
  if (!ctx.trackLines) {
    const fast = fastTriviaScanner(triviaP)
    if (fast) return fast(input, cur)
    if (ctx.triviaKindLabels) return skipWithLabels(input, cur, ctx)
    const tr = triviaP.parse(input, cur, createDetachedParseContext(ctx.trackLines, ctx.state))
    return tr.ok && tr.span.end > cur ? tr.span.end : cur
  }
  const trackTriviaLines = ctx.trackLines && triviaP._meta.canMatchNewline
  const fast = fastTriviaScanner(triviaP)
  if (fast) {
    const end = fast(input, cur)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    return end
  }
  if (ctx.triviaKindLabels) {
    const end = skipWithLabels(input, cur, ctx)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    return end
  }
  const tr = parseTriviaNoCapture(triviaP, input, cur, ctx)
  return tr.ok && tr.span.end > cur ? tr.span.end : cur
}

/**
 * Scan trivia at `cur` using `ctx.trivia`, WITHOUT recording it. Returns the
 * position directly when a classified scan retained no rows; otherwise returns
 * that position with a deferred `commit()` that records the retained rows.
 * Use `triviaScanEnd()` / `commitTriviaScan()` rather than inspecting the shape.
 */
export function scanTriviaCompact(input: string, cur: number, ctx: ParseContext): CompactTriviaScan {
  const triviaP = ctx.trivia
  if (!triviaP) return { end: cur, commit: NOOP_COMMIT }

  const log = ctx._triviaLog
  const rootLog = ctx._rootTriviaLog
  const captureTl = ctx.captureTrivia && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)
  if (!ctx.trackLines) {
    const fast = !ctx.triviaKindLabels ? fastTriviaScanner(triviaP) : null
    if (fast && log === undefined && !captureTl) {
      return { end: fast(input, cur), commit: NOOP_COMMIT }
    }

    if (ctx.triviaKindLabels && (log !== undefined || rootLog !== undefined || captureTl)) {
      return scanWithLabels(input, cur, ctx)
    }

    // LABELLED TRIVIA WITH NOTHING TO RECORD. The branch above took every sink,
    // so no log, no root log and no capture sink is live here: the only thing
    // that can escape this call is `end`. `advanceTrivia:205` has always answered
    // that with the fused scanner, labels or not; this is the same answer in the
    // twin that returns a `TriviaScan`, and it is the difference between one
    // regex-shaped run and a per-character classify whose kind is then dropped.
    if (ctx.triviaKindLabels) {
      const labelledFast = fastTriviaScanner(triviaP)
      return { end: labelledFast ? labelledFast(input, cur) : skipWithLabels(input, cur, ctx), commit: NOOP_COMMIT }
    }

    if (log !== undefined || rootLog !== undefined || captureTl) {
      // CAPTURE DOES NOT NEED THE INTERPRETER. What lands in either sink is the
      // one `(cur, end)` row below — the trivia's internal structure is never
      // read — so a scanner that agrees with `triviaP` on `end` produces byte-
      // identical capture. Delegating to `triviaP.parse` cost a detached
      // `ParseContext` plus a full re-entry into the combinator interpreter PER
      // SEQUENCE TERM, and bought nothing that survived the call.
      const end = fast
        ? fast(input, cur)
        : triviaEndByParse(triviaP, input, cur, ctx, log !== undefined ? false : ctx.trackLines)
      if (end === cur) return { end: cur, commit: NOOP_COMMIT }
      return {
        end,
        commit: () => {
          pushTriviaLogEntry(ctx, cur, end)
          if (captureTl) pushCstTriviaEntry(ctx, cur, end)
        },
      }
    }

    const tr = triviaP.parse(input, cur, createDetachedParseContext(ctx.trackLines, ctx.state))
    return { end: tr.ok ? tr.span.end : cur, commit: NOOP_COMMIT }
  }
  const trackTriviaLines = ctx.trackLines && triviaP._meta.canMatchNewline

  const fast = !ctx.triviaKindLabels ? fastTriviaScanner(triviaP) : null
  if (fast && log === undefined && !captureTl) {
    const end = fast(input, cur)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    return { end, commit: NOOP_COMMIT }
  }

  if (ctx.triviaKindLabels && (log !== undefined || rootLog !== undefined || captureTl)) {
    const scan = scanWithLabels(input, cur, ctx)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, triviaScanEnd(scan))
    return scan
  }

  // The `trackLines` twin of the branch above, same reasoning: nothing records,
  // so `end` is the whole result and the fused scanner produces it. The line
  // range is recorded from the SPAN either way, which is why the scanner loses
  // nothing here that `skipWithLabels` was providing.
  if (ctx.triviaKindLabels) {
    const labelledFast = fastTriviaScanner(triviaP)
    const end = labelledFast ? labelledFast(input, cur) : skipWithLabels(input, cur, ctx)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    return { end, commit: NOOP_COMMIT }
  }

  if (log !== undefined || rootLog !== undefined || captureTl) {
    // Same equivalence as the `trackLines`-off twin above; line ranges are
    // recorded from the SPAN either way, so the scanner loses nothing.
    let end: number
    if (fast) {
      end = fast(input, cur)
      if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    } else {
      const tr = parseTriviaNoCapture(triviaP, input, cur, ctx)
      end = tr.ok ? tr.span.end : cur
    }
    if (end === cur) return { end: cur, commit: NOOP_COMMIT }
    return {
      end,
      commit: () => {
        pushTriviaLogEntry(ctx, cur, end)
        if (captureTl) pushCstTriviaEntry(ctx, cur, end)
      },
    }
  }

  const tr = parseTriviaNoCapture(triviaP, input, cur, ctx)
  return { end: tr.ok ? tr.span.end : cur, commit: NOOP_COMMIT }
}

/** Legacy object-shaped contract used by previously emitted assembly factories. */
export function scanTrivia(input: string, cur: number, ctx: ParseContext): TriviaScan {
  const scan = scanTriviaCompact(input, cur, ctx)
  return typeof scan === 'number' ? { end: scan, commit: NOOP_COMMIT } : scan
}

/**
 * Skip trivia at `cur` through an INSTALLED scanner, recording it immediately.
 *
 * The table drivers install a scanner only for UNLABELLED trivia with
 * `trackLines` off, and that is exactly the case where the deferred path's whole
 * commit is the single row `(cur, end)` — so there is nothing to defer, and the
 * `{ end, commit }` pair plus its closure that `scanTrivia(…).commit()` allocated
 * on EVERY sequence term of EVERY capturing grammar buy nothing. This is that
 * branch with the allocations removed, kept here so recording has one home.
 */
export function skipTriviaScanned(
  s: FastTriviaScanner,
  input: string,
  cur: number,
  ctx: ParseContext,
): number {
  const end = s(input, cur)
  if (end !== cur) {
    // `pushTriviaLogEntry`'s kind-index branch is unreachable without labels.
    if (ctx._triviaLog !== undefined) ctx._triviaLog.push(cur, end)
    if (ctx.captureTrivia === true && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)) {
      pushCstTriviaEntry(ctx, cur, end)
    }
  }
  return end
}

/**
 * Consume trivia at `cur`, recording it immediately. For callers that always
 * accept the trivia between two committed terms (e.g. sequence/sepBy).
 */
export function consumeTrivia(input: string, cur: number, ctx: ParseContext): number {
  if (!needsDeferredTriviaCommit(ctx)) return advanceTrivia(input, cur, ctx)
  return commitTriviaScan(scanTriviaCompact(input, cur, ctx))
}

/**
 * End of the trivia run at `cur`, WITHOUT recording any of it.
 *
 * The read-only twin of `consumeTrivia`, for a zero-width ASSERTION that wants the
 * adjacency fact and must leave no trace: the deferred path returns a scan whose
 * `commit()` is simply never called, so nothing lands in any buffer and there is
 * nothing to roll back. The following term re-scans the same gap and owns the
 * commit/rewind decision exactly as if the assertion were not there.
 */
export function probeTriviaEnd(input: string, cur: number, ctx: ParseContext): number {
  if (!ctx.trivia) return cur
  // "WITHOUT recording any of it" has to include LINE ranges, and it did not.
  // Both paths call `recordLineRangeFromContext` whenever
  // `ctx.trackLines && trivia.canMatchNewline`, so a rejected `notAdjacent()`
  // left a line record behind for a gap the parse then re-scanned — the probe was
  // read-only for buffers and read-write for line data. Probing through a context
  // with `trackLines` off makes `trackTriviaLines` false in both scanners, so
  // there is nothing to record and nothing to undo. Everything the scanners
  // actually need to find the end (`trivia`, `state`, the deferred-commit sinks)
  // is carried through unchanged.
  const probeCtx: ParseContext = { ...ctx, trackLines: false }
  if (needsDeferredTriviaCommit(probeCtx)) return triviaScanEnd(scanTriviaCompact(input, cur, probeCtx))
  return advanceTrivia(input, cur, probeCtx)
}

/**
 * The specialised scanner for a trivia combinator, or null when its shape has no
 * lowering. Memoized on the combinator.
 *
 * EXPORTED because G5's leaf swap needs it at TABLE-BUILD time: the table driver
 * resolves the scanner once, per trivia entry, and installs the closure at scope
 * entry — where the generic path called this (a WeakMap lookup) plus a chain of
 * option branches on EVERY sequence term.
 */
export function fastTriviaScanner(trivia: Combinator<unknown>): FastTriviaScanner | null {
  if (trivia === fastTrivia0) return fastScanner0!
  if (trivia === fastTrivia1) return fastScanner1!
  if (trivia === fastTrivia2) return fastScanner2!
  if (trivia === fastTrivia3) return fastScanner3!
  const scanner = buildFastTriviaScanner(trivia)
  fastTrivia3 = fastTrivia2
  fastScanner3 = fastScanner2
  fastTrivia2 = fastTrivia1
  fastScanner2 = fastScanner1
  fastTrivia1 = fastTrivia0
  fastScanner1 = fastScanner0
  fastTrivia0 = trivia
  fastScanner0 = scanner
  return scanner
}

function buildFastTriviaScanner(trivia: Combinator<unknown>): FastTriviaScanner | null {
  const core = trivia._def.tag === 'trivia' ? trivia._def.parser : trivia
  const direct = regexTriviaScanner(core)
  if (direct) return direct

  const repeat = core._def.tag === 'oneOrMore' || (core._def.tag === 'many' && core._def.min >= 1)
    ? core._def.parser
    : null
  if (!repeat) return null

  const one = regexTriviaScanner(repeat)
  if (one) return loopScanner([one])

  if (repeat._def.tag !== 'choice') return null
  const fused = commonCssTriviaScanner(repeat._def.parsers.map(triviaRegexSource))
  if (fused !== null) return fused
  const arms = repeat._def.parsers.map(regexTriviaScanner)
  if (arms.some(s => s === null)) return null
  return loopScanner(arms as FastTriviaScanner[])
}

/** The regex source beneath a classified-trivia `label()`, when it is plain. */
function triviaRegexSource(parser: Combinator<unknown>): string | null {
  const d = parser._def.tag === 'label' ? parser._def.parser._def : parser._def
  return d.tag === 'regex' && d.flags === '' ? d.source : null
}

function loopScanner(arms: FastTriviaScanner[]): FastTriviaScanner {
  return (input, cur) => {
    let pos = cur
    scan: while (pos < input.length) {
      for (const arm of arms) {
        const end = arm(input, pos)
        if (end > pos) {
          pos = end
          continue scan
        }
      }
      break
    }
    return pos
  }
}

function regexTriviaScanner(parser: Combinator<unknown>): FastTriviaScanner | null {
  // A `label()` WRAPPER IS A NAME, NOT A SHAPE. `classifiedTrivia()` builds
  // `trivia(oneOrMore(choice(label(name, regex)…)))` (combinators/map.ts), and
  // this declined the whole thing on the wrapper alone — every arm BODY is a
  // plain regex, and `encode.ts:288` already reads them straight back out as
  // `[label, source, flags]` triples.
  //
  // What a label carries is which KIND matched, and this scanner never answered
  // that question for an unlabelled grammar either: it returns an end offset and
  // nothing else. So unwrapping loses no information the result could hold. The
  // caller decides whether kinds are needed and only reaches here when they are
  // not — see `scanTrivia`, which still routes every recording path through
  // `scanWithLabels`.
  //
  // The cost of declining was not a slower scan, it was NO scan: with
  // `fastTriviaScanner` null for all four of jess's trivia slots, `program.ts:475`
  // filled `triviaScan` with nulls, `advanceTrivia:205` fell past its fast arm,
  // and every trivia gap in every dialect went through the labelled char scanner.
  const d = parser._def.tag === 'label' ? parser._def.parser._def : parser._def
  if (d.tag !== 'regex' || d.flags) return null
  const source = d.source
  return classRunSource(source)
    ?? altStarSource(source)
    ?? prefixRunSource(source)
    ?? delimitedSource(source)
}

/**
 * Literal fragments are compared with `charCodeAt`, which reads CODE UNITS — the
 * same granularity the non-`u` engine matches at (a `u` flag is rejected upstream
 * with every other flag). An astral literal would have been folded to one code
 * POINT by `literalCodePoints`, so it could never compare equal; declining keeps
 * the scanner exact rather than silently under-matching.
 */
function bmpString(cps: number[] | null): string | null {
  if (!cps) return null
  for (let i = 0; i < cps.length; i++) if (cps[i]! > 0xffff) return null
  return String.fromCharCode(...cps)
}

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!
    if (cp >= r[0] && cp <= r[1]) return true
  }
  return false
}

/** Greedy scanner for a positive char-class body (`^`-negated bodies are rejected upstream). */
function classScanner(classBody: string): FastTriviaScanner | null {
  const ranges = parseClassRanges(classBody)
  if (!ranges) return null
  return (input, cur) => {
    let pos = cur
    while (pos < input.length && inRanges(input.charCodeAt(pos), ranges)) pos++
    return pos
  }
}

/** Scanner for a `C[^\n\r]*` arm — consumes its leader through a line break. */
function untilLineBreakScanner(leaderCode: number): FastTriviaScanner {
  return (input, cur) => {
    if (input.charCodeAt(cur) !== leaderCode) return cur
    let pos = cur + 1
    while (pos < input.length) {
      const cc = input.charCodeAt(pos)
      if (cc === 10 || cc === 13) break
      pos++
    }
    return pos
  }
}

/** A bare positive char-class run `[class]*` / `[class]+` (`[ \t\n\r,]*`, …). */
function classRunSource(source: string): FastTriviaScanner | null {
  const m = /^\[([^\]^](?:[^\]]|\\.)*)\][*+]$/.exec(source)
  return m ? classScanner(m[1]!) : null
}

/**
 * `<literal><class-run>` — a literal opener followed by a single char-class run,
 * `//[^\n]*` and `#[^\n\r]*` being the line-comment spellings of it. The class may
 * be negated or positive; `*` admits the bare opener, `+` requires one class char.
 *
 * This is the whole-arm generalisation of `classifyTriviaArm`'s `untilLineBreak`,
 * which only ever saw ONE leader char inside a `(?:…)*` group — a two-char `//`
 * opener had no lowering at all, so every Less trivia scan fell back to the
 * interpreter.
 */
function prefixRunSource(source: string): FastTriviaScanner | null {
  const m = /^((?:\\.|[^\\[\]()*+?|^$.{}])*)(\[(?:\\.|[^\]])+\])([*+])$/.exec(source)
  if (!m) return null
  const prefix = bmpString(literalCodePoints(m[1]!))
  if (prefix === null) return null
  const cls = parseClassOperand(m[2]!)
  if (!cls) return null
  const { ranges, negated } = cls
  const minOne = m[3] === '+'
  return (input, cur) => {
    if (!input.startsWith(prefix, cur)) return cur
    const start = cur + prefix.length
    const len = input.length
    let pos = start
    while (pos < len && inRanges(input.charCodeAt(pos), ranges) !== negated) pos++
    return minOne && pos === start ? cur : pos
  }
}

/**
 * `<open>(?:body)*<close>` scanned as "advance to the first `close`" — the block
 * comment shape (`/*…*\/`), which no other recognizer here can classify, so css
 * and Less trivia had NO fast scanner at all.
 *
 * The lowering ignores the body, so it is only legal when `(?:body)*` provably
 * cannot span the `close` literal; `delimitedBodySound` is the proof, and an
 * unproven body declines rather than scanning wrong. Ported from the archived
 * `scannable-run.ts`, whose coverage is the specification for this shape.
 */
function delimitedSource(source: string): FastTriviaScanner | null {
  // An escaped backslash in the body makes this a STRING shape, where "advance to
  // the first close" would stop at an escaped delimiter. Not modelled; decline.
  if (source.includes('\\\\')) return null
  let i = 0
  while (i < source.length && source[i] !== '(') i += source[i] === '\\' ? 2 : 1
  if (source[i] !== '(' || source[i + 1] !== '?' || source[i + 2] !== ':') return null
  let k = i + 3
  let depth = 1
  while (k < source.length && depth > 0) {
    const ch = source[k]
    if (ch === '\\') { k += 2; continue }
    if (ch === '[') {
      let j = k + 1
      if (source[j] === '^') j++
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1
      if (source[j] !== ']') return null
      k = j + 1
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    k++
  }
  if (depth !== 0 || source[k] !== '*') return null
  const body = source.slice(i + 3, k - 1)
  const openCps = literalCodePoints(source.slice(0, i))
  const closeCps = literalCodePoints(source.slice(k + 1))
  if (!openCps || !closeCps || !delimitedBodySound(body, closeCps)) return null
  const open = bmpString(openCps)
  const close = bmpString(closeCps)
  if (open === null || close === null) return null
  return (input, cur) => {
    if (!input.startsWith(open, cur)) return cur
    const hit = input.indexOf(close, cur + open.length)
    // Unterminated: the regex requires the close literal, so it does not match.
    return hit === -1 ? cur : hit + close.length
  }
}

/** Split a `(?:…)` body on top-level `|`, respecting classes and nested groups. */
function splitDelimArms(body: string): string[] | null {
  const arms: string[] = []
  let depth = 0
  let last = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') {
      let j = i + 1
      if (body[j] === '^') j++
      while (j < body.length && body[j] !== ']') j += body[j] === '\\' ? 2 : 1
      if (body[j] !== ']') return null
      i = j + 1
      continue
    }
    if (ch === '(') { depth++; i++; continue }
    if (ch === ')') { depth--; if (depth < 0) return null; i++; continue }
    if (ch === '|' && depth === 0) { arms.push(body.slice(last, i)); last = i + 1 }
    i++
  }
  if (depth !== 0) return null
  arms.push(body.slice(last))
  return arms
}

/**
 * Prove "scan to the first `close`" EQUIVALENT to `<open>(?:body)*<close>`. That
 * holds iff `(?:body)*` can never match text containing `close`: greedy repetition
 * then stops exactly before the first `close`, which is where the raw scan lands.
 *
 * Proven only for the delimiter-safe idiom — the sole body shape that says "any
 * char that does not form the close":
 *
 *   close is one char `l0`:      body must be exactly `[^l0]`
 *   close is `l0 l1`:            body must be exactly `[^l0] | l0(?!l1)`
 *
 * The bulk arm takes every char but `l0`; the guard arm takes `l0` only when `l1`
 * does not follow. So the body admits `l0`, never `l0 l1`, and rejects nothing
 * else — a body NARROWER than that would stop early while the raw scan ran on to
 * the next close, and the two would diverge. Anything outside the template is
 * declined. Sound by construction: true is only ever returned for a body proven
 * not to contain `close`.
 */
function delimitedBodySound(body: string, close: number[]): boolean {
  if (close.length > 2) return false
  const l0 = close[0]!
  const arms = splitDelimArms(body)
  if (!arms) return false
  let bulkSeen = false
  let guardSeen = false
  for (const arm of arms) {
    const bulk = /^\[\^((?:\\.|[^\]])+)\]$/.exec(arm)
    if (bulk) {
      if (bulkSeen) return false
      const ranges = parseClassRanges(bulk[1]!)
      if (!ranges || ranges.length !== 1 || ranges[0]![0] !== l0 || ranges[0]![1] !== l0) return false
      bulkSeen = true
      continue
    }
    if (close.length === 2 && arm.endsWith(')')) {
      const idx = arm.indexOf('(?!')
      if (idx === -1 || guardSeen) return false
      const prefix = literalCodePoints(arm.slice(0, idx))
      const op = parseClassOperand(arm.slice(idx + 3, -1))
      if (prefix?.length !== 1 || prefix[0] !== l0) return false
      if (!op || op.negated || op.ranges.length !== 1
        || op.ranges[0]![0] !== close[1] || op.ranges[0]![1] !== close[1]) return false
      guardSeen = true
      continue
    }
    return false
  }
  return bulkSeen && guardSeen === (close.length === 2)
}

/**
 * One alternation arm of a `(?:…)*` trivia group: a positive char-class run
 * `[class]` (a trailing `+`/`*` is redundant under the enclosing loop) or a line
 * line-terminated arm `C[^\n\r]*` (`C` = one literal leader char, maybe escaped). Anything
 * else is unclassifiable → no fast path, never a wrong one.
 */
type TriviaArm =
  | { kind: 'class'; ranges: Array<[number, number]> }
  | { kind: 'untilLineBreak'; code: number }

function classifyTriviaArm(arm: string): TriviaArm | null {
  const cls = /^\[([^\]^](?:[^\]]|\\.)*)\][*+]?$/.exec(arm)
  if (cls) {
    const ranges = parseClassRanges(cls[1]!)
    return ranges ? { kind: 'class', ranges } : null
  }
  const lc = /^(\\?.)\[\^\\n\\r\]\*$/.exec(arm)
  if (lc) {
    const marker = lc[1]!
    return { kind: 'untilLineBreak', code: (marker.length === 2 ? marker[1]! : marker[0]!).charCodeAt(0) }
  }
  return null
}

function armScanner(arm: TriviaArm): FastTriviaScanner {
  if (arm.kind === 'untilLineBreak') return untilLineBreakScanner(arm.code)
  const ranges = arm.ranges
  return (input, cur) => {
    let pos = cur
    while (pos < input.length && inRanges(input.charCodeAt(pos), ranges)) pos++
    return pos
  }
}

/**
 * A single tight loop over a merged char-class range list plus (usually one)
 * line-terminated leader — the fast form of `(?:[class]|C[^\n\r]*)*`. Requires the
 * caller to have checked marker/class disjointness (so a bare merged scan
 * matches the regex regardless of arm order).
 */
function fusedTriviaScanner(ranges: Array<[number, number]>, leaders: number[]): FastTriviaScanner {
  const c0 = leaders[0]!
  const single = leaders.length === 1
  return (input, cur) => {
    let pos = cur
    const len = input.length
    for (;;) {
      const c = input.charCodeAt(pos)
      if (pos < len && inRanges(c, ranges)) { pos++; continue }
      if (single ? c === c0 : leaders.includes(c)) {
        pos++
        while (pos < len) {
          const cc = input.charCodeAt(pos)
          if (cc === 10 || cc === 13) break
          pos++
        }
        continue
      }
      break
    }
    return pos
  }
}

/** Split a `(?:…)*` body on top-level `|`, respecting `[…]`; bail on nested groups. */
function splitTopLevelAlts(body: string): string[] | null {
  const arms: string[] = []
  let inClass = false
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '(') return null // nested group — leave it to RegExp.exec
    else if (c === '|') { arms.push(body.slice(start, i)); start = i + 1 }
  }
  arms.push(body.slice(start))
  return arms
}

/**
 * Trivia written as a single regex alternation-star, `(?:arm|arm|…)*` — e.g.
 * `(?:[ \t\n\r,]|#[^\n\r]*)*`. Arms are classified independently and
 * order-independently: char-class arms merge into one range list and line-terminated
 * leaders are collected, so `(?:#…|[class])*` scans the same as `(?:[class]|#…)*`.
 * The common (disjoint) case compiles to one fused loop; a leader that also sits
 * inside a class is the one spot where arm order matters, so that falls back to
 * the ordered `loopScanner`.
 */
function altStarSource(source: string): FastTriviaScanner | null {
  const m = /^\(\?:(.*)\)[*+]$/.exec(source)
  if (!m) return null
  const armSrcs = splitTopLevelAlts(m[1]!)
  if (!armSrcs || armSrcs.length < 2) return null
  const arms: TriviaArm[] = []
  for (const src of armSrcs) {
    const arm = classifyTriviaArm(src)
    if (!arm) return null
    arms.push(arm)
  }
  const ranges: Array<[number, number]> = []
  const leaders: number[] = []
  for (const arm of arms) {
    if (arm.kind === 'class') ranges.push(...arm.ranges)
    else leaders.push(arm.code)
  }
  if (leaders.some(code => inRanges(code, ranges))) {
    return loopScanner(arms.map(armScanner)) // order-significant overlap
  }
  if (leaders.length === 0) return armScanner({ kind: 'class', ranges })
  return fusedTriviaScanner(ranges, leaders)
}
