import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { rollbackCstCapture, saveCstMark } from '../cst/capture-buffer.ts'

/**
 * Transactional ordered-choice arm. On failure it restores Parseman's
 * structural capture/trivia/error sinks and reports failure at its entry point;
 * user-owned `ctx.state` is intentionally not cloned or mutated by Parseman.
 */
export function attempt<T>(parser: Combinator<T>): Combinator<T> {
  return {
    _tag: 'attempt', _meta: parser._meta, _def: { tag: 'attempt', parser },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const mark = saveCstMark(ctx)
      const log = ctx._triviaLog?.length
      const result = parser.parse(input, pos, ctx)
      if (result.ok) return result
      rollbackCstCapture(ctx, mark)
      if (log !== undefined && ctx._triviaLog) ctx._triviaLog.length = log
      return { ok: false, expected: result.expected, span: { start: pos, end: pos } }
    },
  }
}
