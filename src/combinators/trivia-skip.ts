import type { Combinator, ParseContext } from '../types.ts'
import { parseClassRanges } from '../regex/classes.ts'
import {
  analyzeLabeledTrivia,
  recordTriviaChunks,
  scanLabeledTriviaChunks,
  tryFastLabeledScan,
} from '../cst/trivia-kinds.ts'
import {
  pushCstTriviaEntry,
  pushTriviaLogEntry,
  rollbackCstCapture,
  saveCstMark,
} from '../cst/capture-buffer.ts'

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }

/** Saved lengths for rolling back speculative trivia commits. */
export type TriviaRollbackMark = { raw: number; tlog: number; leaves: number; fields: number; errors: number; log: number }

const NOOP_COMMIT = () => {}
type FastTriviaScanner = (input: string, cur: number) => number
const fastTriviaCache = new WeakMap<Combinator<unknown>, FastTriviaScanner | null>()

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined
}

export function saveTriviaMark(ctx: ParseContext): TriviaRollbackMark {
  const m = saveCstMark(ctx)
  return { raw: m.raw, tlog: m.tlog, leaves: m.leaves, fields: m.fields, errors: m.errors, log: ctx._triviaLog ? ctx._triviaLog.length : 0 }
}

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  rollbackCstCapture(ctx, { raw: mark.raw, tlog: mark.tlog, leaves: mark.leaves, fields: mark.fields, errors: mark.errors })
  if (ctx._triviaLog) ctx._triviaLog.length = mark.log
}

function scanWithLabels(input: string, cur: number, ctx: ParseContext): TriviaScan {
  const triviaP = ctx.trivia!
  const spec = analyzeLabeledTrivia(triviaP)
  if (!spec) return { end: cur, commit: NOOP_COMMIT }

  const fast = tryFastLabeledScan(input, cur, triviaP)
  const { end, chunks } = fast ?? scanLabeledTriviaChunks(input, cur, spec)
  if (end === cur) return { end: cur, commit: NOOP_COMMIT }

  return {
    end,
    commit: () => recordTriviaChunks(ctx, chunks),
  }
}

/**
 * Skip trivia at `cur` and return the new position. No recording, no wrapper
 * object — use between sequence/repeat terms when CST trivia capture is off.
 */
export function advanceTrivia(input: string, cur: number, ctx: ParseContext): number {
  const triviaP = ctx.trivia
  if (!triviaP) return cur
  const fast = fastTriviaScanner(triviaP)
  if (fast) return fast(input, cur)
  if (ctx.triviaKindLabels) {
    const scan = scanWithLabels(input, cur, ctx)
    return scan.end
  }
  const tr = triviaP.parse(input, cur, { trackLines: ctx.trackLines, state: ctx.state })
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
  const captureTl = ctx.captureTrivia && (ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined)

  const fast = !ctx.triviaKindLabels ? fastTriviaScanner(triviaP) : null
  if (fast && log === undefined && !captureTl) {
    return { end: fast(input, cur), commit: NOOP_COMMIT }
  }

  if (ctx.triviaKindLabels && (log !== undefined || captureTl)) {
    return scanWithLabels(input, cur, ctx)
  }

  if (log !== undefined || captureTl) {
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
    ?? (blockCommentSource(source) ? scanBlockComment : null)
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

/** Scanner for a `C[^\n\r]*` line comment — consumes `C` and the rest of the line. */
function lineCommentScanner(commentCode: number): FastTriviaScanner {
  return (input, cur) => {
    if (input.charCodeAt(cur) !== commentCode) return cur
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
 * comment `C[^\n\r]*` (`C` = one literal marker char, maybe escaped). Anything
 * else is unclassifiable → no fast path, never a wrong one.
 */
type TriviaArm =
  | { kind: 'class'; ranges: Array<[number, number]> }
  | { kind: 'comment'; code: number }

function classifyTriviaArm(arm: string): TriviaArm | null {
  const cls = /^\[([^\]^](?:[^\]]|\\.)*)\][*+]?$/.exec(arm)
  if (cls) {
    const ranges = parseClassRanges(cls[1]!)
    return ranges ? { kind: 'class', ranges } : null
  }
  const lc = /^(\\?.)\[\^\\n\\r\]\*$/.exec(arm)
  if (lc) {
    const marker = lc[1]!
    return { kind: 'comment', code: (marker.length === 2 ? marker[1]! : marker[0]!).charCodeAt(0) }
  }
  return null
}

function armScanner(arm: TriviaArm): FastTriviaScanner {
  if (arm.kind === 'comment') return lineCommentScanner(arm.code)
  const ranges = arm.ranges
  return (input, cur) => {
    let pos = cur
    while (pos < input.length && inRanges(input.charCodeAt(pos), ranges)) pos++
    return pos
  }
}

/**
 * A single tight loop over a merged char-class range list plus (usually one)
 * line-comment marker — the fast form of `(?:[class]|C[^\n\r]*)*`. Requires the
 * caller to have checked marker/class disjointness (so a bare merged scan
 * matches the regex regardless of arm order).
 */
function fusedTriviaScanner(ranges: Array<[number, number]>, commentCodes: number[]): FastTriviaScanner {
  const c0 = commentCodes[0]!
  const single = commentCodes.length === 1
  return (input, cur) => {
    let pos = cur
    const len = input.length
    for (;;) {
      const c = input.charCodeAt(pos)
      if (pos < len && inRanges(c, ranges)) { pos++; continue }
      if (single ? c === c0 : commentCodes.includes(c)) {
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
 * GraphQL's `(?:[ \t\n\r,]|#[^\n\r]*)*`. Arms are classified independently and
 * order-independently: char-class arms merge into one range list and comment
 * markers are collected, so `(?:#…|[class])*` scans the same as `(?:[class]|#…)*`.
 * The common (disjoint) case compiles to one fused loop; a marker that also sits
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
  const commentCodes: number[] = []
  for (const arm of arms) {
    if (arm.kind === 'class') ranges.push(...arm.ranges)
    else commentCodes.push(arm.code)
  }
  if (commentCodes.some(code => inRanges(code, ranges))) {
    return loopScanner(arms.map(armScanner)) // order-significant overlap
  }
  if (commentCodes.length === 0) return armScanner({ kind: 'class', ranges })
  return fusedTriviaScanner(ranges, commentCodes)
}

function blockCommentSource(source: string): boolean {
  return source === '\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\/' || source === '\\/\\*[^]*?\\*\\/'
}

function scanBlockComment(input: string, cur: number): number {
  if (input.charCodeAt(cur) !== 47 || input.charCodeAt(cur + 1) !== 42) return cur
  const close = input.indexOf('*/', cur + 2)
  return close === -1 ? cur : close + 2
}
