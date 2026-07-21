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

/**
 * Reduce a structural parser to one semantic leaf.
 *
 * Unlike `token()`, `leaf()` does not change trivia policy: put `noTrivia()` or
 * a scoped `parser({ trivia })` inside the supplied grammar when that region has
 * a local spacing rule.  Internal CST captures are suppressed and one leaf with
 * the reducer's value and the complete consumed span is exposed to the parent.
 */
export function leaf<T, U>(
  root: Combinator<T>,
  fn: (value: T, span: { start: number; end: number }) => U,
): Combinator<U> {
  const meta: ParserMeta = {
    firstSet: root._meta.firstSet,
    canMatchNewline: root._meta.canMatchNewline,
    isTrivia: false,
  }
  return {
    _tag: 'leaf',
    _meta: meta,
    _def: { tag: 'leaf', parser: root as Combinator<unknown>, fn: fn as (v: unknown, span: { start: number; end: number }) => unknown },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<U> {
      const savedBuf = ctx._cstBuf
      const savedChildren = ctx._cstChildren
      const savedLeaves = ctx._cstLeaves
      const savedRaw = ctx._cstRawChildren
      const savedTriviaLog = ctx._cstTriviaLog
      const savedOuterTriviaLog = ctx._triviaLog
      const wasCapturing = cstCaptureActive(ctx)
      ctx._cstBuf = undefined
      ctx._cstChildren = undefined
      ctx._cstLeaves = undefined
      ctx._cstRawChildren = undefined
      ctx._cstTriviaLog = undefined
      delete ctx._triviaLog
      let result: ParseResult<T>
      try { result = root.parse(input, pos, ctx) }
      finally {
        ctx._cstBuf = savedBuf
        ctx._cstChildren = savedChildren
        ctx._cstLeaves = savedLeaves
        ctx._cstRawChildren = savedRaw
        ctx._cstTriviaLog = savedTriviaLog
        if (savedOuterTriviaLog === undefined) delete ctx._triviaLog
        else ctx._triviaLog = savedOuterTriviaLog
      }
      if (!result.ok) return result
      const value = fn(result.value, result.span)
      if (wasCapturing) pushCstLeaf(ctx, { _tag: 'leaf', value, span: result.span })
      return { ok: true, value, span: result.span }
    },
  }
}
