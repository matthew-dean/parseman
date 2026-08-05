import type { Combinator, DispatchCase, DispatchMatcherCase, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { cstCaptureActive, pushCstLeaf } from '../cst/capture-buffer.ts'
import { rollbackTrivia, saveTriviaMark } from './trivia-skip.ts'

export type DispatchWhen<T> = {
  readonly kind: 'when'
  readonly keys: readonly string[]
  readonly parser: Combinator<T>
  readonly caseInsensitive: boolean
  readonly usesRouted?: boolean
}

export type DispatchWhenMatcher<T> = {
  readonly kind: 'whenMatcher'
  readonly matcher: DispatchStringMatcher
  readonly parser: Combinator<T>
  readonly caseInsensitive: boolean
  readonly usesRouted?: boolean
}

export type DispatchStringMatcher =
  | { readonly kind: 'startsWith'; readonly value: string }
  | { readonly kind: 'endsWith'; readonly value: string }
  | { readonly kind: 'matches'; readonly value: string; readonly flags: string }

export type DispatchOtherwise<T> = {
  readonly kind: 'otherwise'
  readonly parser: Combinator<T>
  readonly usesRouted?: boolean
}

export type DispatchArm<T = unknown> = DispatchWhen<T> | DispatchWhenMatcher<T> | DispatchOtherwise<T>
export type DispatchWhenOptions = {
  caseInsensitive?: boolean
}
export type DispatchWhenFactory = <T>(
  key: string | readonly string[],
  parser: Combinator<T>,
) => DispatchWhen<T>
export type DispatchWhenKey = string | readonly string[]
export type DispatchWhenSelector = DispatchWhenKey | DispatchStringMatcher

type ArmValue<T> = T extends DispatchWhen<infer U>
  ? U
  : T extends DispatchWhenMatcher<infer U>
  ? U
  : T extends DispatchOtherwise<infer U>
  ? U
  : never
type UnionArms<T extends readonly DispatchArm<unknown>[]> = {
  [K in keyof T]: ArmValue<T[K]>
}[number]

export function parserUsesRouted(parser: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(parser)) return false
  seen.add(parser)
  const def = parser._def
  switch (def.tag) {
    case 'routed':
      return true
    case 'sequence':
    case 'choice':
      return def.parsers.some(entry => parserUsesRouted(entry, seen))
    case 'dispatch':
      return false
    case 'sepBy':
      return parserUsesRouted(def.parser, seen) || parserUsesRouted(def.separator, seen)
    case 'grammar':
      return parserUsesRouted(def.parser, seen) || (def.triviaParser ? parserUsesRouted(def.triviaParser, seen) : false)
    case 'scanTo':
      return parserUsesRouted(def.sentinel, seen) || def.skip.some(entry => parserUsesRouted(entry, seen))
    case 'recover':
      return parserUsesRouted(def.parser, seen) || parserUsesRouted(def.sentinel, seen)
    case 'lazy':
      try { return parserUsesRouted(def.thunk(), seen) } catch { return false }
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'not':
    case 'peek':
    case 'node':
    case 'withCtx':
    case 'expect':
      return parserUsesRouted(def.parser, seen)
    default:
      return false
  }
}

export function branchUsesRouted(branch: { parser: Combinator<unknown>; usesRouted?: boolean | undefined }): boolean {
  return branch.usesRouted === true || parserUsesRouted(branch.parser)
}

export function asciiFoldKey(key: string): string {
  let out = ''
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    out += String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c)
  }
  return out
}

export function matchesDispatchMatcher(value: string, matcher: DispatchMatcherCase): boolean {
  const candidate = matcher.caseInsensitive ? asciiFoldKey(value) : value
  const expected = matcher.caseInsensitive ? asciiFoldKey(matcher.value) : matcher.value
  switch (matcher.kind) {
    case 'startsWith':
      return candidate.startsWith(expected)
    case 'endsWith':
      return candidate.endsWith(expected)
    case 'matches': {
      const flags = matcher.caseInsensitive && !matcher.flags?.includes('i')
        ? `${matcher.flags ?? ''}i`
        : matcher.flags ?? ''
      return new RegExp(matcher.value, flags).test(value)
    }
  }
}

function isStringMatcher(value: unknown): value is DispatchStringMatcher {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'startsWith' || kind === 'endsWith' || kind === 'matches'
}

function fixedMatcher(kind: 'startsWith' | 'endsWith', value: string): DispatchStringMatcher {
  if (typeof value !== 'string') throw new TypeError(`parseman: ${kind}() value must be a string`)
  if (value.length === 0) throw new RangeError(`parseman: ${kind}() requires a non-empty value`)
  return { kind, value }
}

export function startsWith(prefix: string): DispatchStringMatcher {
  return fixedMatcher('startsWith', prefix)
}

export function endsWith(suffix: string): DispatchStringMatcher {
  return fixedMatcher('endsWith', suffix)
}

export function matches(pattern: RegExp): DispatchStringMatcher {
  if (!(pattern instanceof RegExp)) throw new TypeError('parseman: matches() requires a RegExp')
  if (pattern.flags.includes('g') || pattern.flags.includes('y')) {
    throw new TypeError('parseman: matches() does not accept global or sticky regex flags')
  }
  return { kind: 'matches', value: pattern.source, flags: pattern.flags }
}

export function when<T>(
  key: DispatchWhenKey,
  parser: Combinator<T>,
  opts?: DispatchWhenOptions,
): DispatchWhen<T>
export function when<T>(
  matcher: DispatchStringMatcher,
  parser: Combinator<T>,
  opts?: DispatchWhenOptions,
): DispatchWhenMatcher<T>
export function when<T>(
  key: DispatchWhenSelector,
  parser: Combinator<T>,
  opts: DispatchWhenOptions = {},
): DispatchWhen<T> | DispatchWhenMatcher<T> {
  const usesRouted = parserUsesRouted(parser as Combinator<unknown>)
  if (isStringMatcher(key)) {
    return { kind: 'whenMatcher', matcher: key, parser, caseInsensitive: opts.caseInsensitive ?? false, usesRouted }
  }
  const keys = Array.isArray(key) ? [...key] : [key]
  if (keys.length === 0) throw new RangeError('parseman: when() requires at least one key')
  for (const item of keys) {
    if (typeof item !== 'string') throw new TypeError('parseman: when() keys must be strings')
  }
  return { kind: 'when', keys, parser, caseInsensitive: opts.caseInsensitive ?? false, usesRouted }
}

export function makeWhen(opts: DispatchWhenOptions = {}): DispatchWhenFactory {
  return (key, parser) => when(key, parser, opts)
}

export function otherwise<T>(parser: Combinator<T>): DispatchOtherwise<T> {
  return { kind: 'otherwise', parser, usesRouted: parserUsesRouted(parser as Combinator<unknown>) }
}

/**
 * Reuse the token the enclosing `dispatch()` already consumed to select this branch,
 * instead of re-recognizing it.
 *
 * With no argument this is dispatch-only: outside a dispatch branch (or at a position
 * other than the selector's) it fails with `expected: ['routed()']`.
 *
 * `routed(fallback)` makes the SAME production usable in both contexts: inside a
 * dispatch branch it reuses the routed token; anywhere else it parses `fallback` in
 * place. That is what collapses a `Routed<X>` twin production into its original —
 * `sequence(routed(Name), Prelude, ';')` replaces the pair
 * `sequence(Name, Prelude, ';')` / `sequence(routed(), Prelude, ';')`, which
 * otherwise differ by exactly one element and duplicate a whole production (and a
 * whole compiled emission) for a one-token difference.
 *
 * A `routed()` in a dispatch SELECTOR is still an error with or without a fallback:
 * the selector is what produces the routed token, so reading it there is misuse.
 */
export function routed<T = string>(fallback?: Combinator<T>): Combinator<T> {
  return {
    _tag: 'routed',
    _meta: {
      // The routed token is whatever the selector matched, so the first set stays
      // `any` even with a fallback — `any` already subsumes the fallback's.
      firstSet: { kind: 'any' },
      canMatchNewline: fallback?._meta.canMatchNewline ?? false,
      isTrivia: false,
    },
    _def: fallback === undefined
      ? { tag: 'routed' }
      : { tag: 'routed', fallback: fallback as Combinator<unknown> },
    parse(_input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const item = ctx._routed
      if (item === undefined || pos !== item.span.start) {
        if (fallback !== undefined) return fallback.parse(_input, pos, ctx)
        return { ok: false, expected: ['routed()'], span: { start: pos, end: pos } }
      }
      if (cstCaptureActive(ctx)) {
        pushCstLeaf(ctx, { _tag: 'leaf', value: item.value, span: item.span })
      }
      return { ok: true, value: item.value as T, span: item.span }
    },
  }
}

export function dispatch<S extends string, T extends readonly DispatchArm<unknown>[]>(
  selector: Combinator<S>,
  ...arms: T
): Combinator<[S, UnionArms<T>]> {
  if (parserUsesRouted(selector as Combinator<unknown>)) {
    throw new Error('parseman: routed() can only appear inside a dispatch() branch')
  }
  let fallback: Combinator<unknown> | undefined
  let fallbackUsesRouted = false
  const matchers: DispatchMatcherCase[] = []
  const cases: DispatchCase[] = []
  const seen: Array<{ raw: string; folded: string; caseInsensitive: boolean }> = []

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!
    if (arm.kind === 'otherwise') {
      if (fallback !== undefined) throw new Error('parseman: dispatch() accepts at most one otherwise() arm')
      if (i !== arms.length - 1) throw new Error('parseman: otherwise() must be the last dispatch() arm')
      fallback = arm.parser
      fallbackUsesRouted = arm.usesRouted === true
      continue
    }
    if (arm.kind === 'whenMatcher') {
      const matcher = arm.matcher
      matchers.push({
        kind: matcher.kind,
        value: matcher.value,
        ...(matcher.kind === 'matches' ? { flags: matcher.flags } : {}),
        parser: arm.parser as Combinator<unknown>,
        caseInsensitive: arm.caseInsensitive,
        ...(arm.usesRouted === true ? { usesRouted: true } : {}),
      })
      continue
    }
    for (const key of arm.keys) {
      const folded = asciiFoldKey(key)
      for (const prior of seen) {
        const overlaps = arm.caseInsensitive || prior.caseInsensitive
          ? folded === prior.folded
          : key === prior.raw
        if (overlaps) throw new Error(`parseman: duplicate dispatch key ${JSON.stringify(key)}`)
      }
      seen.push({ raw: key, folded, caseInsensitive: arm.caseInsensitive })
    }
    cases.push({
      keys: arm.keys,
      parser: arm.parser as Combinator<unknown>,
      caseInsensitive: arm.caseInsensitive,
      ...(arm.usesRouted === true ? { usesRouted: true } : {}),
    })
  }

  const meta: ParserMeta = {
    firstSet: selector._meta.firstSet,
    canMatchNewline: selector._meta.canMatchNewline ||
      cases.some(entry => entry.parser._meta.canMatchNewline) ||
      matchers.some(entry => entry.parser._meta.canMatchNewline) ||
      (fallback?._meta.canMatchNewline ?? false),
    isTrivia: false,
  }

  const byKey = new Map<string, DispatchCase>()
  const byFoldedKey = new Map<string, DispatchCase>()
  for (const entry of cases) {
    for (const key of entry.keys) {
      if (entry.caseInsensitive) byFoldedKey.set(asciiFoldKey(key), entry)
      else byKey.set(key, entry)
    }
  }

  return {
    _tag: 'dispatch',
    _meta: meta,
    _def: {
      tag: 'dispatch',
      selector: selector as Combinator<string>,
      cases,
      ...(matchers.length === 0 ? {} : { matchers }),
      ...(fallback === undefined ? {} : { otherwise: fallback, ...(fallbackUsesRouted ? { otherwiseUsesRouted: true } : {}) }),
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<[S, UnionArms<T>]> {
      if (parserUsesRouted(selector as Combinator<unknown>)) {
        throw new Error('parseman: routed() can only appear inside a dispatch() branch')
      }
      const selectorMark = saveTriviaMark(ctx)
      const selected = selector.parse(input, pos, ctx)
      if (!selected.ok) return selected

      const branch = byKey.get(selected.value) ??
        (byFoldedKey.size === 0 ? undefined : byFoldedKey.get(asciiFoldKey(selected.value))) ??
        matchers.find(matcher => matchesDispatchMatcher(selected.value, matcher)) ??
        (fallback === undefined ? undefined : { keys: [], parser: fallback, caseInsensitive: false, usesRouted: fallbackUsesRouted })
      if (branch === undefined) {
        const expected = cases.flatMap(entry => entry.keys.map(key => JSON.stringify(key)))
        return { ok: false, expected, span: { start: selected.span.end, end: selected.span.end } }
      }

      const savedRouted = ctx._routed
      const usesRouted = branchUsesRouted(branch)
      let mark = saveTriviaMark(ctx)
      if (usesRouted) {
        rollbackTrivia(ctx, selectorMark)
        mark = saveTriviaMark(ctx)
        ctx._routed = { value: selected.value, span: selected.span }
      }
      let result: ParseResult<unknown>
      try {
        result = branch.parser.parse(input, usesRouted ? pos : selected.span.end, ctx)
      } finally {
        if (usesRouted) ctx._routed = savedRouted
      }
      if (!result.ok) {
        rollbackTrivia(ctx, mark)
        return { ...result, committed: true }
      }

      return {
        ok: true,
        value: [selected.value, result.value as UnionArms<T>],
        span: { start: pos, end: result.span.end },
      }
    },
  }
}
