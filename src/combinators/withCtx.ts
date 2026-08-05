import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

/**
 * Runs `combinator` with `ctx.state` set to `extra` for the duration of the parse.
 * The outer user context is restored on exit (lexical scoping).
 *
 *   const functionBody = withCtx({ inFn: true },
 *     sequence(literal('{'), many(statement), literal('}'))
 *   )
 *
 * Read back with guard() or from within a transform's span argument.
 */
export function withCtx<U, T>(extra: U, combinator: Combinator<T>): Combinator<T> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'withCtx',
    _meta: meta,
    _def: { tag: 'withCtx', extra, parser: combinator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      // SAVE / RESTORE, not a clone. This used to run the child against
      // `{ ...ctx, state: extra }`, which scopes far more than the state: every
      // scalar the child writes on `ctx` lands on the clone and dies with it —
      // including `_fe` / `_fx`, the furthest-failure position and its expected
      // set. A failing `withCtx` subtree therefore contributed NOTHING to the
      // parent's expected set, silently. Nobody asked for that isolation; the
      // combinator's contract is "set `state` for the duration", and the clone
      // was an implementation detail with a semantic reach nobody consented to.
      //
      // (Array MUTATIONS were never affected either way — `_triviaLog` and the
      // CST buffers are the same objects through a spread — so this changes the
      // scalars only, which is exactly the part that was being dropped.)
      //
      // It also allocated a full context per entry, on the object every
      // combinator reads on every step.
      const saved = ctx.state
      ctx.state = extra
      try { return combinator.parse(input, pos, ctx) }
      finally { ctx.state = saved }
    },
  }
}
