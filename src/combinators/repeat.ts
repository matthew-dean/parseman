import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'

export function many<T>(parser: Combinator<T>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline,
    isTrivia: false,
  }

  return {
    _tag: 'many',
    _meta: meta,
    _def: { tag: 'many', parser: parser as Combinator<unknown>, min: 0 },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const values: T[] = []
      let cur = pos
      while (cur < input.length) {
        const result = parser.parse(input, cur, ctx)
        if (!result.ok) break
        if (result.span.end === cur) break
        values.push(result.value)
        cur = result.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}

export function oneOrMore<T>(parser: Combinator<T>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline,
    isTrivia: false,
  }

  return {
    _tag: 'oneOrMore',
    _meta: meta,
    _def: { tag: 'oneOrMore', parser: parser as Combinator<unknown>, min: 1 },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = parser.parse(input, pos, ctx)
      if (!first.ok) return first
      const values: T[] = [first.value]
      let cur = first.span.end
      while (cur < input.length) {
        const result = parser.parse(input, cur, ctx)
        if (!result.ok) break
        if (result.span.end === cur) break
        values.push(result.value)
        cur = result.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}

export function optional<T>(parser: Combinator<T>): Combinator<T | null> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline,
    isTrivia: false,
  }

  return {
    _tag: 'optional',
    _meta: meta,
    _def: { tag: 'optional', parser: parser as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | null> {
      const result = parser.parse(input, pos, ctx)
      if (result.ok) return result as ParseResult<T>
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}

export function sepBy<T, S>(parser: Combinator<T>, separator: Combinator<S>): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: parser._meta.firstSet,
    canMatchNewline: parser._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }

  return {
    _tag: 'sepBy',
    _meta: meta,
    _def: { tag: 'sepBy', parser: parser as Combinator<unknown>, separator: separator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = parser.parse(input, pos, ctx)
      if (!first.ok) return { ok: true, value: [], span: { start: pos, end: pos } }
      const values: T[] = [first.value]
      let cur = first.span.end
      while (cur < input.length) {
        let sepPos = cur
        if (ctx.trivia) { const triviaCtx = { trivia: ctx.trivia, trackLines: ctx.trackLines, user: ctx.user }; const tr = ctx.trivia.parse(input, sepPos, triviaCtx); if (tr.ok) { if (ctx._cstRawChildren && tr.span.end > tr.span.start) (ctx._cstRawChildren as unknown[]).push({ _tag: 'trivia', value: input.slice(tr.span.start, tr.span.end), span: tr.span }); sepPos = tr.span.end } }
        const sep = separator.parse(input, sepPos, ctx)
        if (!sep.ok) break
        let nextPos = sep.span.end
        if (ctx.trivia) { const triviaCtx = { trivia: ctx.trivia, trackLines: ctx.trackLines, user: ctx.user }; const tr = ctx.trivia.parse(input, nextPos, triviaCtx); if (tr.ok) { if (ctx._cstRawChildren && tr.span.end > tr.span.start) (ctx._cstRawChildren as unknown[]).push({ _tag: 'trivia', value: input.slice(tr.span.start, tr.span.end), span: tr.span }); nextPos = tr.span.end } }
        const next = parser.parse(input, nextPos, ctx)
        if (!next.ok) break
        values.push(next.value)
        cur = next.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
