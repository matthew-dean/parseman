import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'
import { saveCstMark, rollbackCstCapture } from '../cst/capture-buffer.ts'

/**
 * Negative lookahead. Succeeds (consuming nothing) when `combinator` fails;
 * fails when `combinator` succeeds.
 *
 * The standard way to match a keyword without also matching the prefix
 * of a longer identifier:
 *
 *   const kwTrue = sequence(literal('true'), not(regex(/\w/)))
 *   // matches "true" in "true && x" but NOT in "trueish" or "trueness"
 */
export function not(combinator: Combinator<unknown>): Combinator<null> {
  const meta: ParserMeta = {
    firstSet: any(),     // we don't know what NOT matches
    canMatchNewline: false,
    isTrivia: false,
  }

  return {
    _tag: 'not',
    _meta: meta,
    _def: { tag: 'not', parser: combinator },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<null> {
      // Negative lookahead is a pure predicate: whatever the inner attempt
      // captured (CST leaves/trivia/fields) or recovered (a ParseError pushed to
      // ctx._errors + embedded via captureError) must be rolled back on BOTH
      // outcomes — not() consumes nothing and so may leave no side effect, or a
      // speculatively-recovered error would ghost past the lookahead.
      const mark = saveCstMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      rollbackCstCapture(ctx, mark)
      if (result.ok) {
        return { ok: false, expected: [`not(${combinator._tag})`], span: { start: pos, end: pos } }
      }
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}
