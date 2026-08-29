import type { Combinator, ParseContext, ParseResult } from '../types.ts'

export type ScalarParser = (input: string, pos: number, ctx: ParseContext) => number

export function scalarOf<T>(combinator: Combinator<T>): ScalarParser {
  return combinator._parseScalar ?? ((input, pos, ctx) => {
    const result = combinator.parse(input, pos, ctx)
    if (result.ok) {
      ctx._sv = result.value
      return result.span.end
    }
    ctx._fx = result.expected
    return ~result.span.start
  })
}

export function scalarResult<T>(end: number, start: number, ctx: ParseContext): ParseResult<T> {
  if (end < 0) {
    const at = ~end
    return { ok: false, expected: ctx._fx ?? [], span: { start: at, end: at } }
  }
  return { ok: true, value: ctx._sv as T, span: { start, end } }
}
