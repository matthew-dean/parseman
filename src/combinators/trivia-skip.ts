import type { ParseContext } from '../types.ts'

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }

const NOOP_COMMIT = () => {}

/** True when trivia recording must be deferred until the following term commits. */
export function needsDeferredTriviaCommit(ctx: ParseContext): boolean {
  return ctx._triviaLog !== undefined || ctx._cstTriviaLog !== undefined
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

  // ── Log mode: flat numeric accumulation, zero object allocations ──────────
  const log = ctx._triviaLog
  if (log !== undefined) {
    const tr = triviaP.parse(input, cur, { trackLines: false, state: ctx.state })
    if (!tr.ok || tr.span.end === cur) return { end: cur, commit: NOOP_COMMIT }
    const end = tr.span.end
    return {
      end,
      commit: () => { log.push(cur, end) },
    }
  }

  // ── Capture mode: record trivia into flat _cstTriviaLog ──────────────────
  if (ctx.captureTrivia && ctx._cstTriviaLog !== undefined) {
    const tr = triviaP.parse(input, cur, { trackLines: ctx.trackLines, state: ctx.state })
    if (tr.ok && tr.span.end > cur) {
      const tlog = ctx._cstTriviaLog
      const raw = ctx._cstRawChildren as unknown[] | undefined
      return {
        end: tr.span.end,
        commit: () => {
          tlog.push(cur, tr.span.end, raw ? raw.length : 0)
        },
      }
    }
    return { end: cur, commit: NOOP_COMMIT }
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
