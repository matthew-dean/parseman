import type { Combinator, ParseContext, ParseFail, ParseResult } from '../types.ts'
import { parseClassRanges } from '../regex/classes.ts'
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
  saveCstMark,
} from '../cst/capture-buffer.ts'
import { recordLineRangeFromContext } from '../line-index.ts'

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }

/** Saved lengths for rolling back speculative trivia commits. */
export type TriviaRollbackMark = { raw: number; tlog: number; leaves: number; fields: number; errors: number; log: number; rootLog: number }

const NOOP_COMMIT = () => {}
type FastTriviaScanner = (input: string, cur: number) => number
const fastTriviaCache = new WeakMap<Combinator<unknown>, FastTriviaScanner | null>()

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

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  rollbackCstCapture(ctx, { raw: mark.raw, tlog: mark.tlog, leaves: mark.leaves, fields: mark.fields, errors: mark.errors })
  // Guarded like every other truncation — see rollbackCstCapture.
  if (ctx._triviaLog && ctx._triviaLog.length !== mark.log) ctx._triviaLog.length = mark.log
  if (ctx._rootTriviaLog && ctx._rootTriviaLog.length !== mark.rootLog) ctx._rootTriviaLog.length = mark.rootLog
}

function parseTriviaNoCapture(
  triviaP: Combinator<unknown>,
  input: string,
  cur: number,
  ctx: ParseContext,
): ParseResult<unknown> {
  const probeCtx: ParseContext = {
    trackLines: ctx.trackLines,
    state: ctx.state,
    ...(ctx._lineIndex ? { _lineIndex: ctx._lineIndex } : {}),
    ...(ctx._lineStarts ? { _lineStarts: ctx._lineStarts } : {}),
    ...(ctx._lineScannedTo !== undefined ? { _lineScannedTo: ctx._lineScannedTo } : {}),
  }
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

function scanWithLabels(input: string, cur: number, ctx: ParseContext): TriviaScan {
  const triviaP = ctx.trivia!
  const spec = analyzeLabeledTrivia(triviaP)
  if (!spec) return { end: cur, commit: NOOP_COMMIT }

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
    if (visitedEnd === cur) return { end: cur, commit: NOOP_COMMIT }
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
  if (end === cur) return { end: cur, commit: NOOP_COMMIT }

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
    const tr = triviaP.parse(input, cur, { trackLines: ctx.trackLines, state: ctx.state })
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
 * position after the trivia (or `cur` if none) and a `commit()` to record it.
 */
export function scanTrivia(input: string, cur: number, ctx: ParseContext): TriviaScan {
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

    if (ctx.triviaKindLabels) return { end: skipWithLabels(input, cur, ctx), commit: NOOP_COMMIT }

    if (log !== undefined || rootLog !== undefined || captureTl) {
      const tr = triviaP.parse(input, cur, {
        trackLines: log !== undefined ? false : ctx.trackLines,
        state: ctx.state,
      })
      if (!tr.ok || tr.span.end === cur) return { end: cur, commit: NOOP_COMMIT }
      const end = tr.span.end
      return {
        end,
        commit: () => {
          pushTriviaLogEntry(ctx, cur, end)
          if (captureTl) pushCstTriviaEntry(ctx, cur, end)
        },
      }
    }

    const tr = triviaP.parse(input, cur, { trackLines: ctx.trackLines, state: ctx.state })
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
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, scan.end)
    return scan
  }

  if (ctx.triviaKindLabels) {
    const end = skipWithLabels(input, cur, ctx)
    if (trackTriviaLines) recordLineRangeFromContext(ctx, input, cur, end)
    return { end, commit: NOOP_COMMIT }
  }

  if (log !== undefined || rootLog !== undefined || captureTl) {
    const tr = parseTriviaNoCapture(triviaP, input, cur, ctx)
    if (!tr.ok || tr.span.end === cur) return { end: cur, commit: NOOP_COMMIT }
    const end = tr.span.end
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

/**
 * Consume trivia at `cur`, recording it immediately. For callers that always
 * accept the trivia between two committed terms (e.g. sequence/sepBy).
 */
export function consumeTrivia(input: string, cur: number, ctx: ParseContext): number {
  if (!needsDeferredTriviaCommit(ctx)) return advanceTrivia(input, cur, ctx)
  const scan = scanTrivia(input, cur, ctx)
  scan.commit()
  return scan.end
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
  if (needsDeferredTriviaCommit(probeCtx)) return scanTrivia(input, cur, probeCtx).end
  return advanceTrivia(input, cur, probeCtx)
}

function fastTriviaScanner(trivia: Combinator<unknown>): FastTriviaScanner | null {
  const cached = fastTriviaCache.get(trivia)
  if (cached !== undefined) return cached
  const scanner = buildFastTriviaScanner(trivia)
  fastTriviaCache.set(trivia, scanner)
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
  const arms = repeat._def.parsers.map(regexTriviaScanner)
  if (arms.some(s => s === null)) return null
  return loopScanner(arms as FastTriviaScanner[])
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
  if (parser._def.tag !== 'regex' || parser._def.flags) return null
  const source = parser._def.source
  return classRunSource(source)
    ?? altStarSource(source)
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
