import type { ParseContext } from '../types.ts'

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }

/** Saved lengths for rolling back speculative trivia commits. */
export type TriviaRollbackMark = { raw: number; tlog: number; log: number }

const NOOP_COMMIT = () => {}

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstTriviaLog !== undefined
}

export function saveTriviaMark(ctx: ParseContext): TriviaRollbackMark {
  const raw = ctx._cstRawChildren as unknown[] | undefined
  return {
    raw: raw ? raw.length : 0,
    tlog: ctx._cstTriviaLog ? ctx._cstTriviaLog.length : 0,
    log: ctx._triviaLog ? ctx._triviaLog.length : 0,
  }
}

export function rollbackTrivia(ctx: ParseContext, mark: TriviaRollbackMark): void {
  const raw = ctx._cstRawChildren as unknown[] | undefined
  if (raw) raw.length = mark.raw
  if (ctx._cstTriviaLog) ctx._cstTriviaLog.length = mark.tlog
  if (ctx._triviaLog) ctx._triviaLog.length = mark.log
}

/**
 * Skip trivia at `cur` and return the new position. No recording, no wrapper
 * object — use between sequence/repeat terms when CST trivia capture is off.
 */
export function advanceTrivia(input: string, cur: number, ctx: ParseContext): number {
  const triviaP = ctx.trivia
  if (!triviaP) return cur
  const tr = triviaP.parse(input, cur, { trackLines: ctx.trackLines, state: ctx.state })
  return tr.ok && tr.span.end > cur ? tr.span.end : cur
}

/**
 * Scan trivia at `cur` using `ctx.trivia`, WITHOUT recording it. Returns the
 * position after the trivia (or `cur` if none) and a `commit()` to record it.
 *
 * Recording is gated on `ctx.captureTrivia`:
 *   - capture off (default): commit() is a no-op; trivia is skipped silently.
 *   - capture on (and a rawChildren collector is active): commit() records each
 *     maximal trivia sub-match (a whitespace run or a comment) as a separate
 *     CSTTrivia token. Relies on the trivia parser being structured so each
 *     token is a distinct leaf match.
 *
 * The trivia parser always runs with `trivia` unset in its sub-context so it
 * cannot recurse into itself.
 */
export function scanTrivia(input: string, cur: number, ctx: ParseContext): TriviaScan {
  const triviaP = ctx.trivia
  if (!triviaP) return { end: cur, commit: NOOP_COMMIT }

  const log = ctx._triviaLog
  const tlog = ctx.captureTrivia && ctx._cstTriviaLog !== undefined ? ctx._cstTriviaLog : undefined
  const raw = ctx._cstRawChildren as unknown[] | undefined

  // ── Log and/or capture mode: defer recording until commit() ─────────────
  if (log !== undefined || tlog !== undefined) {
    const tr = triviaP.parse(input, cur, {
      trackLines: log !== undefined ? false : ctx.trackLines,
      state: ctx.state,
    })
    if (!tr.ok || tr.span.end === cur) return { end: cur, commit: NOOP_COMMIT }
    const end = tr.span.end
    return {
      end,
      commit: () => {
        if (log !== undefined) log.push(cur, end)
        if (tlog !== undefined) tlog.push(cur, end, raw ? raw.length : 0)
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
