import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { pushCstLeaf, cstCaptureActive } from '../cst/capture-buffer.ts'

/**
 * Treat a parser as one source token.
 *
 * The wrapped parser runs with trivia cleared, so its parts must be contiguous.
 * On success the token returns the matched source text and captures one CST leaf
 * for the full span, suppressing any internal terminal leaves.
 */
export function token(root: Combinator<unknown>): Combinator<string> {
  const meta: ParserMeta = {
    firstSet: root._meta.firstSet,
    canMatchNewline: root._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'token',
    _meta: meta,
    _def: { tag: 'token', parser: root },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<string> {
      const savedTrivia = ctx.trivia
      const savedKinds = ctx.triviaKindLabels
      const savedBuf = ctx._cstBuf
      const savedChildren = ctx._cstChildren
      const savedLeaves = ctx._cstLeaves
      const savedRaw = ctx._cstRawChildren
      const savedTriviaLog = ctx._cstTriviaLog
      const savedOuterTriviaLog = ctx._triviaLog
      const wasCapturing = cstCaptureActive(ctx)

      ctx.trivia = undefined
      ctx.triviaKindLabels = undefined
      ctx._cstBuf = undefined
      ctx._cstChildren = undefined
      ctx._cstLeaves = undefined
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      delete ctx._triviaLog

      let result: ParseResult<unknown>
      try {
        result = root.parse(input, pos, ctx)
      } finally {
        ctx.trivia = savedTrivia
        ctx.triviaKindLabels = savedKinds
        ctx._cstBuf = savedBuf
        ctx._cstChildren = savedChildren
        ctx._cstLeaves = savedLeaves
        ctx._cstRawChildren = savedRaw
        ctx._cstTriviaLog = savedTriviaLog
        if (savedOuterTriviaLog === undefined) delete ctx._triviaLog
        else ctx._triviaLog = savedOuterTriviaLog
      }

      if (!result.ok) return result

      const span = result.span
      const value = input.slice(pos, span.end)
      if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value, span })
      return { ok: true, value, span }
    },
  }
}
