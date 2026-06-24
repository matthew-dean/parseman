import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { advanceTrivia, consumeTrivia, needsDeferredTriviaCommit, scanTrivia } from './trivia-skip.ts'

/**
 * Parse one repetition item at `cur`, first skipping (and, in capture mode,
 * recording) any leading trivia — so a repeating combinator consumes the trivia
 * between items uniformly, the way advancing the index always should. Trivia is
 * committed *before* the item so rawChildren order stays [item, trivia, item];
 * if the item then fails or makes no progress the trivia is rolled back and the
 * loop stops (the trivia is trailing and belongs to the enclosing context).
 *
 * Returns the item value + end position, the underlying failure (so oneOrMore
 * can propagate a first-item failure), or 'stop'.
 */
function repItem<T>(
  parser: Combinator<T>,
  input: string,
  cur: number,
  ctx: ParseContext
): { value: T; end: number } | { fail: ParseResult<T> } | 'stop' {
  const raw = ctx._cstRawChildren as unknown[] | undefined
  const mark = raw ? raw.length : 0
  const tlog = ctx._cstTriviaLog
  const tmark = tlog ? tlog.length : 0
  let pos = cur
  if (ctx.trivia) {
    if (needsDeferredTriviaCommit(ctx)) {
      const scan = scanTrivia(input, cur, ctx)
      scan.commit()
      pos = scan.end
    } else {
      pos = advanceTrivia(input, cur, ctx)
    }
  }
  // Nothing but trivia left: don't speculatively parse an item at EOF (it would
  // fail and could trigger an item's recover()/error side-effects). The trivia
  // is trailing — roll it back for the enclosing context and stop.
  if (pos >= input.length) {
    if (raw) raw.length = mark
    if (tlog) tlog.length = tmark
    return 'stop'
  }
  const result = parser.parse(input, pos, ctx)
  if (!result.ok) {
    if (raw) raw.length = mark
    if (tlog) tlog.length = tmark
    return { fail: result }
  }
  if (result.span.end === pos) {
    if (raw) raw.length = mark
    if (tlog) tlog.length = tmark
    return 'stop'
  }
  return { value: result.value, end: result.span.end }
}

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
        const item = repItem(parser, input, cur, ctx)
        if (item === 'stop' || 'fail' in item) break
        values.push(item.value)
        cur = item.end
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
      // First item is mandatory (parsed at pos directly — leading trivia is the
      // enclosing context's responsibility); subsequent items skip leading trivia.
      const first = parser.parse(input, pos, ctx)
      if (!first.ok) return first
      const values: T[] = [first.value]
      let cur = first.span.end
      while (cur < input.length) {
        const item = repItem(parser, input, cur, ctx)
        if (item === 'stop' || 'fail' in item) break
        values.push(item.value)
        cur = item.end
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
        const sepPos = ctx.trivia ? consumeTrivia(input, cur, ctx) : cur
        const sep = separator.parse(input, sepPos, ctx)
        if (!sep.ok) break
        const nextPos = ctx.trivia ? consumeTrivia(input, sep.span.end, ctx) : sep.span.end
        const next = parser.parse(input, nextPos, ctx)
        if (!next.ok) break
        values.push(next.value)
        cur = next.span.end
      }
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
