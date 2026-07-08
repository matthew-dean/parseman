import type { Combinator, ParseContext } from '../types.ts'
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
export type TriviaRollbackMark = { raw: number; tlog: number; leaves: number; fields: number; log: number }

const NOOP_COMMIT = () => {}
type FastTriviaScanner = (input: string, cur: number) => number
const fastTriviaCache = new WeakMap<Combinator<unknown>, FastTriviaScanner | null>()

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined
}

export function saveTriviaMark(ctx: ParseContext): TriviaRollbackMark {
  const m = saveCstMark(ctx)
  return { raw: m.raw, tlog: m.tlog, leaves: m.leaves, fields: m.fields, log: ctx._triviaLog ? ctx._triviaLog.length : 0 }
}

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  rollbackCstCapture(ctx, { raw: mark.raw, tlog: mark.tlog, leaves: mark.leaves, fields: mark.fields })
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
  const ws = whitespaceSource(parser._def.source)
  if (ws) return ws
  return blockCommentSource(parser._def.source) ? scanBlockComment : null
}

function whitespaceSource(source: string): FastTriviaScanner | null {
  const m = /^\[([ \\tnrf]+)\][*+]$/.exec(source)
  if (!m) return null
  const chars = new Set<number>()
  for (let i = 0; i < m[1]!.length; i++) {
    const ch = m[1]![i]!
    if (ch !== '\\') {
      chars.add(ch.charCodeAt(0))
      continue
    }
    const esc = m[1]![++i]
    if (esc === 't') chars.add(9)
    else if (esc === 'n') chars.add(10)
    else if (esc === 'r') chars.add(13)
    else if (esc === 'f') chars.add(12)
    else return null
  }
  return (input, cur) => {
    let pos = cur
    while (pos < input.length && chars.has(input.charCodeAt(pos))) pos++
    return pos
  }
}

function blockCommentSource(source: string): boolean {
  return source === '\\/\\*(?:[^*]|\\*(?!\\/))*\\*\\/' || source === '\\/\\*[^]*?\\*\\/'
}

function scanBlockComment(input: string, cur: number): number {
  if (input.charCodeAt(cur) !== 47 || input.charCodeAt(cur + 1) !== 42) return cur
  const close = input.indexOf('*/', cur + 2)
  return close === -1 ? cur : close + 2
}
