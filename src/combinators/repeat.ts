import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { advanceTrivia } from './trivia-skip.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'

export type RepeatOptions = {
  min?: number
  max?: number
}

function resolveBounds(what: string, opts: RepeatOptions): { min: number; max: number } {
  const min = opts.min ?? 0
  const max = opts.max ?? Infinity
  const bad = (msg: string): never => { throw new RangeError(`parseman: ${what} ${msg}`) }
  if (!Number.isInteger(min) || min < 0) bad(`min must be a non-negative integer (got ${String(opts.min)})`)
  if (max !== Infinity && (!Number.isInteger(max) || max < 1)) bad(`max must be a positive integer (got ${String(opts.max)})`)
  if (max < min) bad(`max (${max}) is less than min (${min}) — the combinator could never succeed`)
  return { min, max }
}

function repeatTail<T>(
  combinator: Combinator<T>,
  input: string,
  start: number,
  cur: number,
  ctx: ParseContext,
  guardable: boolean,
  values: T[] | undefined,
  remaining: number,
): ParseResult<T[]> {
  while (cur < input.length && remaining > 0) {
    let itemPos = cur
    if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
    if (itemPos >= input.length) break
    if (guardable && !startsFirstSet(combinator, input, itemPos)) break
    const item = combinator.parse(input, itemPos, ctx)
    if (!item.ok) {
      if (item.committed) return item
      break
    }
    if (item.span.end === itemPos) break
    if (values !== undefined) values.push(item.value)
    cur = item.span.end
    remaining--
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { ok: true, value: (values ?? undefined) as T[], span: { start, end: cur } }
}

export function many<T>(combinator: Combinator<T>, opts: RepeatOptions = {}): Combinator<T[]> {
  const { min, max } = resolveBounds('many()', opts)
  if (min >= 1) return atLeast(combinator, min, max)
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'many'; parser: Combinator<unknown>; min: 0; max?: number; valueUnused?: boolean } =
    { tag: 'many', parser: combinator as Combinator<unknown>, min: 0, ...(max === Infinity ? {} : { max }) }
  const guardable = combinator._meta.firstSet.kind !== 'any' && !matchesEmpty(combinator)

  return {
    _tag: 'many',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      return repeatTail(
        combinator, input, pos, pos, ctx, guardable,
        def.valueUnused ? undefined : [], max,
      )
    },
  }
}

export function oneOrMore<T>(combinator: Combinator<T>, opts: RepeatOptions = {}): Combinator<T[]> {
  return many(combinator, { ...opts, min: opts.min ?? 1 })
}

function atLeast<T>(combinator: Combinator<T>, min: number, max: number): Combinator<T[]> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const def: { tag: 'oneOrMore'; parser: Combinator<unknown>; min: number; max?: number; valueUnused?: boolean } =
    { tag: 'oneOrMore', parser: combinator as Combinator<unknown>, min, ...(max === Infinity ? {} : { max }) }
  const guardable = combinator._meta.firstSet.kind !== 'any' && !matchesEmpty(combinator)

  return {
    _tag: 'oneOrMore',
    _meta: meta,
    _def: def,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = combinator.parse(input, pos, ctx)
      if (!first.ok) return first
      const values: T[] | undefined = def.valueUnused ? undefined : [first.value]
      let cur = first.span.end
      for (let count = 1; count < min; count++) {
        let itemPos = cur
        if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
        const item = combinator.parse(input, itemPos, ctx)
        if (!item.ok) return item
        if (values !== undefined) values.push(item.value)
        cur = item.span.end
      }
      return repeatTail(combinator, input, pos, cur, ctx, guardable, values, max - min)
    },
  }
}

export function optional<T>(combinator: Combinator<T>): Combinator<T | null> {
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline,
    isTrivia: false,
  }
  const firstSetSkippable = !matchesEmpty(combinator)

  return {
    _tag: 'optional',
    _meta: meta,
    _def: { tag: 'optional', parser: combinator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | null> {
      if (firstSetSkippable && !startsFirstSet(combinator, input, pos)) {
        return { ok: true, value: null, span: { start: pos, end: pos } }
      }
      const result = combinator.parse(input, pos, ctx)
      if (result.ok || result.committed) return result
      return { ok: true, value: null, span: { start: pos, end: pos } }
    },
  }
}

export function oneOrMoreSep<T, S>(
  combinator: Combinator<T>,
  separator: Combinator<S> | KeptSeparator<S>,
  opts: SepByOptions = {},
): Combinator<T[]> {
  return sepBy(combinator, separator, { ...opts, min: opts.min ?? 1 })
}

export type TrailingSeparator = 'forbid' | 'allow'

export type SepByOptions = RepeatOptions & {
  trailing?: TrailingSeparator
}

export type KeptSeparator<S> = { readonly _keepSeparator: Combinator<S> }

export function keepSeparator<S>(separator: Combinator<S>): KeptSeparator<S> {
  return { _keepSeparator: separator }
}

function unwrapSeparator<S>(separator: Combinator<S> | KeptSeparator<S>): { sep: Combinator<S>; keep: boolean } {
  return '_keepSeparator' in separator
    ? { sep: separator._keepSeparator, keep: true }
    : { sep: separator, keep: false }
}

export function sepBy<T, S>(
  combinator: Combinator<T>,
  separatorArg: Combinator<S> | KeptSeparator<S>,
  opts: SepByOptions = {},
): Combinator<T[]> {
  const { sep: separator, keep: keepSeparators } = unwrapSeparator(separatorArg)
  const { min, max } = resolveBounds('sepBy()', opts)
  const trailing = opts.trailing ?? 'forbid'
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }
  let expected: string[] | undefined
  const failAt = (at: number): ParseResult<T[]> => {
    expected ??= deriveExpected(combinator)
    return { ok: false, expected: expected.length > 0 ? expected : [combinator._tag], span: { start: at, end: at } }
  }

  return {
    _tag: 'sepBy',
    _meta: meta,
    _def: {
      tag: 'sepBy', parser: combinator as Combinator<unknown>, separator: separator as Combinator<unknown>, min,
      ...(max === Infinity ? {} : { max }),
      ...(trailing === 'forbid' ? {} : { trailing }),
      ...(keepSeparators ? { keepSeparators: true } : {}),
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      const first = combinator.parse(input, pos, ctx)
      if (!first.ok) {
        if (first.committed) return first
        return min >= 1 ? failAt(pos) : { ok: true, value: [], span: { start: pos, end: pos } }
      }
      const values = [first.value]
      let cur = first.span.end
      while (values.length < max && (cur < input.length || values.length < min)) {
        const beforeSeparator = cur
        let separatorPos = cur
        if (ctx.trivia) separatorPos = advanceTrivia(input, cur, ctx)
        const sep = separator.parse(input, separatorPos, ctx)
        if (!sep.ok) {
          if (sep.committed) return sep
          break
        }
        let itemPos = sep.span.end
        if (ctx.trivia) itemPos = advanceTrivia(input, itemPos, ctx)
        const next = combinator.parse(input, itemPos, ctx)
        if (!next.ok) {
          if (next.committed) return next
          if (trailing === 'allow') cur = sep.span.end
          else cur = beforeSeparator
          break
        }
        values.push(next.value)
        cur = next.span.end
      }
      if (values.length < min) return failAt(cur)
      return { ok: true, value: values, span: { start: pos, end: cur } }
    },
  }
}
