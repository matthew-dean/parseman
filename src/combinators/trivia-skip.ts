import type { ParseContext } from '../types.ts'

type TriviaSink = { _tag: string; value: string; span: { start: number; end: number } }

/**
 * Result of scanning trivia: the position after it, plus a `commit()` that
 * records the matched trivia tokens into the active rawChildren collector.
 * Recording is deferred so callers that may reject the following item (e.g.
 * many()/oneOrMore() retries) can advance speculatively without recording
 * trivia that doesn't actually sit between two accepted items.
 */
export type TriviaScan = { end: number; commit: () => void }

const NOOP_COMMIT = () => {}

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

  // ── Capture mode: record trivia tokens into rawChildren ───────────────────
  if (ctx.captureTrivia && ctx._cstRawChildren) {
    const sink: TriviaSink[] = []
    const tr = triviaP.parse(input, cur, {
      trackLines: ctx.trackLines,
      state: ctx.state,
      _cstLeaves: sink as unknown[],
    })
    if (tr.ok && tr.span.end > cur) {
      const out = ctx._cstRawChildren as unknown[]
      return {
        end: tr.span.end,
        commit: () => {
          for (const tok of sink) {
            if (tok._tag === 'leaf' && tok.span.end > tok.span.start) {
              out.push({ _tag: 'trivia', value: tok.value, span: tok.span })
            }
          }
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
  const scan = scanTrivia(input, cur, ctx)
  scan.commit()
  return scan.end
}
