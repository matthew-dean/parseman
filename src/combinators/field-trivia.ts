import type { Combinator } from '../types.ts'

/**
 * Where the trivia before a `field(…, { leadingTrivia: true })` began.
 *
 * A sequence or separated list skips the trivia before a term and calls the
 * term at the first byte after it, so the term cannot see where the gap
 * started. The boundary that calls such a field writes its pre-trivia cursor
 * here immediately before the call, and the field reads it and resets it to −1
 * on entry, before its own child can run another boundary. Nothing else writes
 * it, so a field reached any other way reads −1 and records no leading trivia.
 *
 * ONE per process, like `FAIL`: the write and the read are adjacent in one
 * synchronous call, and every engine (the interpreter included) must agree on
 * the same cell when one calls another.
 */
export const LEAD: { at: number } = { at: -1 }

/** Option bits of a trivia-attributing `field()`, as the table carries them. */
export const FIELD_LEADING_TRIVIA = 1
export const FIELD_TRAILING_TRIVIA = 2

/**
 * The capture a trivia-attributing field pushes. `leadFrom` is the cursor before
 * the trivia its boundary skipped (−1 when it was not called from one), and
 * `trailEnd` the end of the trivia it consumed after its match. One spelling for
 * every engine, so the captures agree byte for byte.
 */
export function triviaFieldCapture(
  name: string, value: unknown, input: string, start: number, end: number, leadFrom: number, trailEnd: number,
): { name: string; value: unknown; span: { start: number; end: number }; leading: string; trailing: string } {
  return {
    name,
    value,
    span: { start, end },
    leading: leadFrom >= 0 && leadFrom < start ? input.slice(leadFrom, start) : '',
    trailing: trailEnd > end ? input.slice(end, trailEnd) : '',
  }
}

/** Is `p` a `field(…, { leadingTrivia: true })` — the term itself, not wrapped? */
export function leadsTrivia(p: Combinator<unknown>): boolean {
  return p._def.tag === 'field' && p._def.leadingTrivia === true
}
