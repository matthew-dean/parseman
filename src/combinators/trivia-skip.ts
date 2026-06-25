import type { ParseContext } from '../types.ts'
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
export type TriviaRollbackMark = { raw: number; tlog: number; leaves: number; log: number }

const NOOP_COMMIT = () => {}

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstBuf !== undefined || ctx._cstTriviaLog !== undefined
}

export function saveTriviaMark(ctx: ParseContext): TriviaRollbackMark {
  const m = saveCstMark(ctx)
  return { raw: m.raw, tlog: m.tlog, leaves: m.leaves, log: ctx._triviaLog ? ctx._triviaLog.length : 0 }
}

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  rollbackCstCapture(ctx, { raw: mark.raw, tlog: mark.tlog, leaves: mark.leaves })
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
