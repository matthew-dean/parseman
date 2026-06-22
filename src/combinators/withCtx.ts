import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

/**
 * Runs `parser` with `ctx.user` set to `extra` for the duration of the parse.
 * The outer user context is restored on exit (lexical scoping).
 *
 *   const functionBody = withCtx({ inFn: true },
 *     sequence(literal('{'), many(statement), literal('}'))
 *   )
 *
 * Read back with guard() or from within a transform's span argument.
 */
export function withCtx<U, T>(extra: U, parser: Combinator<T>): Combinator<T> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'withCtx',
    _meta: meta,
    _def: { tag: 'withCtx', extra, parser: parser as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      return parser.parse(input, pos, { ...ctx, user: extra })
    },
  }
}
