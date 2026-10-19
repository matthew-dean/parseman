import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

/**
 * Runs `combinator` under a scoped `ctx.state`, restored on exit (lexical scoping).
 *
 * Two forms, told apart by whether the first argument is a function:
 *
 * - **Replace** — `withCtx(extra, c)`: the subtree's state IS `extra`.
 *
 *     const functionBody = withCtx({ inFn: true },
 *       sequence(literal('{'), many(statement), literal('}'))
 *     )
 *
 * - **Derive** — `withCtx(state => next, c)`: the subtree's state is computed
 *   FROM the state in force at entry, once per entry. Use it to add or override
 *   a field while every outer field (options, document-wide sinks) stays visible
 *   to the gates and reducers inside:
 *
 *     const argument = withCtx(s => ({ ...s, stop: 'comparison' }), value)
 *
 * Because a function argument always selects the derive form, a state that is
 * itself a function cannot be installed with the replace form; wrap it
 * (`withCtx(() => fn, c)`).
 *
 * Read back with gate() or from within a transform's span argument.
 */
export function withCtx<S, U, T>(derive: (state: S) => U, combinator: Combinator<T>): Combinator<T>
export function withCtx<U, T>(extra: U, combinator: Combinator<T>): Combinator<T>
export function withCtx<T>(extra: unknown, combinator: Combinator<T>): Combinator<T> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  // The form is decided HERE, once, so neither parse path tests it per entry.
  //
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
  const parse = typeof extra === 'function'
    ? (input: string, pos: number, ctx: ParseContext): ParseResult<T> => {
        const saved = ctx.state
        ctx.state = (extra as (state: unknown) => unknown)(saved)
        try { return combinator.parse(input, pos, ctx) }
        finally { ctx.state = saved }
      }
    : (input: string, pos: number, ctx: ParseContext): ParseResult<T> => {
        const saved = ctx.state
        ctx.state = extra
        try { return combinator.parse(input, pos, ctx) }
        finally { ctx.state = saved }
      }
  return {
    _tag: 'withCtx',
    _meta: meta,
    _def: { tag: 'withCtx', extra, parser: combinator as Combinator<unknown> },
    parse,
  }
}
