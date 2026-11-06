import type { ParseContext, ParseFail } from '../types.ts'

/**
 * Creates a ParseFail and, if a completions probe is active, records it.
 *
 * Rules:
 * - Only failures at or before the probe's target offset are eligible.
 * - A deeper failure (higher pos) replaces the current best.
 * - A tie (same pos) merges expected arrays — this is what makes choice arms
 *   aggregate their alternatives rather than each overwriting the last.
 * - Shallower failures are ignored.
 */
export function failAt(ctx: ParseContext, expected: string[], pos: number): ParseFail {
  const r: ParseFail = { ok: false, expected, span: { start: pos, end: pos } }
  const probe = ctx._probe
  if (probe !== undefined && pos <= probe.offset) {
    const best = probe.best
    if (best === null || pos > best.span.start) {
      probe.best = r
    } else if (pos === best.span.start && probe.offset !== Infinity) {
      probe.best = { ...best, expected: [...best.expected, ...expected] }
    }
  }
  return r
}
