import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'

/**
 * Negative lookahead. Succeeds (consuming nothing) when `parser` fails;
 * fails when `parser` succeeds.
 *
 * The standard way to match a keyword without also matching the prefix
 * of a longer identifier:
 *
 *   const kwTrue = sequence(literal('true'), not(regex(/\w/)))
 *   // matches "true" in "true && x" but NOT in "trueish" or "trueness"
 */
export function not(parser: Combinator<unknown>): Combinator<null> {
  const meta: ParserMeta = {
    firstSet: any(),     // we don't know what NOT matches
    canMatchNewline: false,
    isTrivia: false,
  }

  return {
    _tag: 'unknown',
    _meta: meta,
    _def: { tag: 'unknown' },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<null> {
      const result = parser.parse(input, pos, ctx)
      if (result.ok) {
        return { ok: false, expected: [`not(${parser._tag})`], span: { start: pos, end: pos } }
      }
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}
