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
      // The label is the PUBLIC name. It used to be `'guard'`, justified in a
      // comment here as "parity with the compiled path" — which had not been true
      // since the rename: codegen emitted `'gate'` and this emitted `'guard'`, so
      // the same failing input reported a different expected set depending on
      // which engine ran it. Nothing caught it because no test compared the two
      // engines' expected sets on a state-scoped failure.
      //
      // `guard` was removed as a public name in 0.44.0, so it also pointed users
      // at something they could no longer find. The def TAG stays `'guard'` —
      // that is internal and the encoder switches on it.
      return { ok: false, expected: ['gate'], span: { start: pos, end: pos } }
    },
  }
}
