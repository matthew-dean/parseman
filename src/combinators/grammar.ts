import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { buildLineIndex, annotateSpan } from '../compiler/line-index.ts'

export type ParseOptions = {
  trivia?: Combinator<unknown>
  trackLines?: boolean
}

export function grammar<T>(opts: ParseOptions, root: Combinator<T>): Combinator<T> {
  return {
    _tag: 'grammar',
    _meta: root._meta,
    _def: {
      tag: 'grammar',
      parser: root as Combinator<unknown>,
      triviaParser: opts.trivia,
      trackLines: opts.trackLines ?? false,
    },
    parse(input: string, pos: number, _ctx: ParseContext): ParseResult<T> {
      const trackLines = opts.trackLines ?? false
      const ctx: ParseContext = opts.trivia !== undefined
        ? { trivia: opts.trivia, trackLines }
        : { trackLines }
      const result = root.parse(input, pos, ctx)
      if (trackLines) {
        const idx = buildLineIndex(input)
        return { ...result, span: annotateSpan(result.span, idx) }
      }
      return result
    },
  }
}

export function parse<T>(
  parser: Combinator<T>,
  input: string,
  opts: ParseOptions = {}
): ParseResult<T> {
  const trackLines = opts.trackLines ?? false
  const ctx: ParseContext = opts.trivia !== undefined
    ? { trivia: opts.trivia, trackLines }
    : { trackLines }
  const result = parser.parse(input, 0, ctx)
  if (trackLines) {
    const idx = buildLineIndex(input)
    return { ...result, span: annotateSpan(result.span, idx) }
  }
  return result
}
