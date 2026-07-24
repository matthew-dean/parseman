import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

/**
 * Zero-width state ASSERTION: succeeds (consuming nothing) only when `predicate`
 * returns true for `ctx.state`. Fails otherwise.
 *
 * Intended for use inside sequence() to gate subsequent parsing on runtime
 * context set with withCtx():
 *
 *   const returnStmt = sequence(
 *     gate(ctx => (ctx as { inFn: boolean }).inFn),
 *     literal('return'), optional(expr)
 *   )
 *
 * Naming: this matches the `gate:` field on a gated CHOICE arm
 * (`choice({ gate, combinator }, other)`). Use the arm FIELD to SELECT a branch by
 * a cheap state predicate; use this COMBINATOR to ASSERT a state predicate
 * mid-sequence. Formerly named `guard()` — see the deprecated alias in `guard.ts`.
 *
 * Note: like all state predicates its first-set is `any`, so a `gate(...)` as the
 * LEADING term of a choice arm poisons that choice's first-char dispatch. Keep it
 * after a concrete leading terminal.
 */
export function gate(predicate: (state: unknown) => boolean): Combinator<null> {
  const meta: ParserMeta = {
    firstSet: { kind: 'any' },
    canMatchNewline: false,
    isTrivia: false,
  }
  return {
    _tag: 'guard',
    _meta: meta,
    _def: { tag: 'guard', predicate },
    parse(_input: string, pos: number, ctx: ParseContext): ParseResult<null> {
      if (predicate(ctx.state))
        return { ok: true, value: null, span: { start: pos, end: pos } }
      // Keep the 'guard' failure label for byte-identical output parity with the
      // compiled path and the pre-rename API (the rename is API-surface only).
      return { ok: false, expected: ['guard'], span: { start: pos, end: pos } }
    },
  }
}
