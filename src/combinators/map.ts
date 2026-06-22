import type { Combinator, ParseContext, ParseResult } from '../types.ts'

export function transform<T, U>(
  parser: Combinator<T>,
  fn: (value: T, span: { start: number; end: number }) => U
): Combinator<U> {
  return {
    _tag: 'transform',
    _meta: parser._meta,
    _def: { tag: 'transform', parser: parser as Combinator<unknown>, fn: fn as (v: unknown, span: { start: number; end: number }) => unknown },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<U> {
      const result = parser.parse(input, pos, ctx)
      if (!result.ok) return result
      return { ...result, value: fn(result.value, result.span) }
    },
  }
}

export function skip<T, S>(main: Combinator<T>, skipped: Combinator<S>): Combinator<T> {
  return {
    _tag: 'skip',
    _meta: main._meta,
    _def: { tag: 'skip', main: main as Combinator<unknown>, skipped: skipped as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const result = main.parse(input, pos, ctx)
      if (!result.ok) return result
      const s = skipped.parse(input, result.span.end, ctx)
      if (!s.ok) return result
      return { ...result, span: { start: result.span.start, end: s.span.end } }
    },
  }
}

export function trivia<T>(parser: Combinator<T>): Combinator<T> {
  return {
    _tag: parser._tag,
    _meta: { ...parser._meta, isTrivia: true },
    _def: { tag: 'trivia', parser: parser as Combinator<unknown> },
    parse: parser.parse.bind(parser),
  }
}
