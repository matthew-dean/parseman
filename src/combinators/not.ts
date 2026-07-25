import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'
import { saveLookaheadMark, rollbackLookahead } from './trivia-skip.ts'

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
      // captured (CST leaves/rawChildren/per-node trivia/fields), recovered (a
      // ParseError pushed to ctx._errors + embedded via captureError), or committed
      // to the GLOBAL `_triviaLog` must be rolled back on BOTH outcomes — not()
      // consumes nothing and so may leave no side effect.
      //
      // `rollbackLookahead`, not `rollbackCstCapture`: the latter's mark omits two
      // further sinks a probe can write.
      //   - `_triviaLog`, which `scanTrivia().commit()` writes when the probed body
      //     skips ambient trivia between terms. Missing it duplicates every probed
      //     span once the region is parsed for real — `_triviaLog` has no dedup
      //     anywhere (`triviaEntries()` is a positional view over the flat array),
      //     so the duplicate reaches output.
      //   - `_probe.best`, the completions tracker, for the same reason `peek()`
      //     restores it: expectations raised INSIDE a zero-width probe are not
      //     reachable from the enclosing grammar at the cursor, so leaving them
      //     offers unreachable tokens as completions.
      // Using the shared lookahead helper means neither can silently regress the
      // next time a sink is added.
      const mark = saveLookaheadMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      rollbackLookahead(ctx, mark)
      if (result.ok) {
        return { ok: false, expected: [`not(${combinator._tag})`], span: { start: pos, end: pos } }
      }
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}
