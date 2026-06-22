import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

/**
 * Zero-width assertion: succeeds (consuming nothing) only when `predicate`
 * returns true for `ctx.user`. Fails otherwise.
 *
 * Intended for use inside sequence() to gate subsequent parsing on runtime
 * context set with withCtx().
 *
 *   const returnStmt = sequence(
 *     guard(ctx => (ctx as { inFn: boolean }).inFn),
 *     literal('return'), optional(expr)
 *   )
 */
export function guard(predicate: (user: unknown) => boolean): Combinator<null> {
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
      if (predicate(ctx.user))
        return { ok: true, value: null, span: { start: pos, end: pos } }
      return { ok: false, expected: ['guard'], span: { start: pos, end: pos } }
    },
  }
}
