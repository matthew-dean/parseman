import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'

export function transform<T, U>(
  combinator: Combinator<T>,
  fn: (value: T, span: { start: number; end: number }) => U
): Combinator<U> {
  return {
    _tag: 'transform',
    _meta: combinator._meta,
    _def: { tag: 'transform', parser: combinator as Combinator<unknown>, fn: fn as (v: unknown, span: { start: number; end: number }) => unknown },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<U> {
      const result = combinator.parse(input, pos, ctx)
      if (!result.ok) return result
      return { ok: true, value: fn(result.value, result.span), span: result.span }
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
      return { ok: true, value: result.value, span: { start: result.span.start, end: s.span.end } }
    },
  }
}

export function trivia<T>(combinator: Combinator<T>): Combinator<T> {
  const kindLabels = analyzeLabeledTrivia(combinator as Combinator<unknown>)?.labels
  return {
    _tag: combinator._tag,
    _meta: {
      ...combinator._meta,
      isTrivia: true,
      ...(kindLabels ? { triviaKindLabels: kindLabels } : {}),
    },
    _def: { tag: 'trivia', parser: combinator as Combinator<unknown> },
    parse: combinator.parse.bind(combinator),
  }
}

/**
 * Attach a string label to a parser arm (e.g. trivia `choice` branches).
 * Parse behavior is unchanged; the label is metadata for tooling and future
 * trivia-kind capture (`'whitespace'`, `'blockComment'`, …).
 */
export function label<T>(name: string, combinator: Combinator<T>): Combinator<T> {
  return {
    _tag: combinator._tag,
    _meta: combinator._meta,
    _def: { tag: 'label', label: name, parser: combinator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const result = combinator.parse(input, pos, ctx)
      if (!result.ok) return { ok: false, expected: [name], span: result.span }
      return result
    },
  }
}
