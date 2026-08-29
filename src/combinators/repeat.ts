import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { advanceTrivia } from './trivia-skip.ts'
import { matchesEmpty, startsFirstSet } from './first-set.ts'
import { deriveExpected } from './expect.ts'
import { scalarOf, scalarResult, type ScalarParser } from './scalar.ts'

export type RepeatOptions = { min?: number; max?: number }

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
  child: ScalarParser,
  input: string,
  cur: number,
  ctx: ParseContext,
  guardable: boolean,
  values: T[] | undefined,
  remaining: number,
): number {
  while (cur < input.length && remaining > 0) {
    let itemPos = cur
    if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
    if (itemPos >= input.length) break
    if (guardable && !startsFirstSet(combinator, input, itemPos)) break
    const end = child(input, itemPos, ctx)
    if (end <= itemPos) break
    if (values !== undefined) values.push(ctx._sv as T)
    cur = end
    remaining--
  }
  ctx._sv = values
  return cur
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
  const child = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number =>
    repeatTail(combinator, child, input, pos, ctx, guardable, def.valueUnused ? undefined : [], max)

  return {
    _tag: 'many', _meta: meta, _def: def, _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
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
  const child = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    let cur = child(input, pos, ctx)
    if (cur < 0) return cur
    const values: T[] | undefined = def.valueUnused ? undefined : [ctx._sv as T]
    for (let count = 1; count < min; count++) {
      let itemPos = cur
      if (ctx.trivia) itemPos = advanceTrivia(input, cur, ctx)
      cur = child(input, itemPos, ctx)
      if (cur < 0) return cur
      if (values !== undefined) values.push(ctx._sv as T)
    }
    return repeatTail(combinator, child, input, cur, ctx, guardable, values, max - min)
  }

  return {
    _tag: 'oneOrMore', _meta: meta, _def: def, _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
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
  const child = scalarOf(combinator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    if (firstSetSkippable && !startsFirstSet(combinator, input, pos)) {
      ctx._sv = null
      return pos
    }
    const end = child(input, pos, ctx)
    if (end >= 0) return end
    ctx._sv = null
    return pos
  }

  return {
    _tag: 'optional', _meta: meta,
    _def: { tag: 'optional', parser: combinator as Combinator<unknown> },
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T | null> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
    },
  }
}

export function oneOrMoreSep<T, S>(
  combinator: Combinator<T>, separator: Combinator<S> | KeptSeparator<S>, opts: SepByOptions = {},
): Combinator<T[]> {
  return sepBy(combinator, separator, { ...opts, min: opts.min ?? 1 })
}

export type TrailingSeparator = 'forbid' | 'allow'
export type SepByOptions = RepeatOptions & { trailing?: TrailingSeparator }
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
  combinator: Combinator<T>, separatorArg: Combinator<S> | KeptSeparator<S>, opts: SepByOptions = {},
): Combinator<T[]> {
  const { sep: separator, keep: keepSeparators } = unwrapSeparator(separatorArg)
  const { min, max } = resolveBounds('sepBy()', opts)
  const trailing = opts.trailing ?? 'forbid'
  const meta: ParserMeta = {
    firstSet: combinator._meta.firstSet,
    canMatchNewline: combinator._meta.canMatchNewline || separator._meta.canMatchNewline,
    isTrivia: false,
  }
  const expected = deriveExpected(combinator)
  const child = scalarOf(combinator)
  const separatorScalar = scalarOf(separator)
  const parseScalar = (input: string, pos: number, ctx: ParseContext): number => {
    let cur = child(input, pos, ctx)
    if (cur < 0) {
      if (min >= 1) {
        ctx._fx = expected.length > 0 ? expected : [combinator._tag]
        return ~pos
      }
      ctx._sv = []
      return pos
    }
    const values = [ctx._sv as T]
    while (values.length < max && (cur < input.length || values.length < min)) {
      const beforeSeparator = cur
      let separatorPos = cur
      if (ctx.trivia) separatorPos = advanceTrivia(input, cur, ctx)
      const separatorEnd = separatorScalar(input, separatorPos, ctx)
      if (separatorEnd < 0) break
      let itemPos = separatorEnd
      if (ctx.trivia) itemPos = advanceTrivia(input, itemPos, ctx)
      const itemEnd = child(input, itemPos, ctx)
      if (itemEnd < 0) {
        if (trailing === 'allow') cur = separatorEnd
        else cur = beforeSeparator
        break
      }
      values.push(ctx._sv as T)
      cur = itemEnd
    }
    if (values.length < min) {
      ctx._fx = expected.length > 0 ? expected : [combinator._tag]
      return ~cur
    }
    ctx._sv = values
    return cur
  }

  return {
    _tag: 'sepBy', _meta: meta,
    _def: {
      tag: 'sepBy', parser: combinator as Combinator<unknown>, separator: separator as Combinator<unknown>, min,
      ...(max === Infinity ? {} : { max }),
      ...(trailing === 'forbid' ? {} : { trailing }),
      ...(keepSeparators ? { keepSeparators: true } : {}),
    },
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T[]> {
      return scalarResult(parseScalar(input, pos, ctx), pos, ctx)
    },
  }
}
