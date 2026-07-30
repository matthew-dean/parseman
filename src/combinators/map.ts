import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'
import { choice } from './choice.ts'
import { intersects, matchesEmpty } from './first-set.ts'
import { oneOrMore } from './repeat.ts'

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
 * Build trivia whose category labels are part of its recognition structure.
 *
 * Use this for a grammar that exposes selected root trivia. In contrast to
 * `trivia(label('categoryA', broadRegex))`, every category here owns one arm,
 * so one selected category cannot be silently consumed under another category's
 * broad matcher.
 * `rootTrivia: { select }` rejects ordinary scoped trivia
 * unless that scope explicitly declares itself opaque.
 */
export function classifiedTrivia(
  arms: Readonly<Record<string, Combinator<unknown>>>,
): Combinator<unknown> {
  const entries = Object.entries(arms)
  if (entries.length === 0) {
    throw new TypeError('classifiedTrivia() requires at least one named trivia arm.')
  }
  for (let i = 0; i < entries.length; i++) {
    const [name, arm] = entries[i]!
    const first = arm._meta.firstSet
    if (matchesEmpty(arm) || first.kind !== 'ranges' || first.ranges.length === 0) {
      throw new TypeError(
        `classifiedTrivia(): ${JSON.stringify(name)} must be non-nullable with a concrete finite first set.`,
      )
    }
    for (let j = 0; j < i; j++) {
      const [previousName, previous] = entries[j]!
      if (intersects(first, previous._meta.firstSet)) {
        throw new TypeError(
          `classifiedTrivia(): ${JSON.stringify(name)} overlaps ${JSON.stringify(previousName)}; categories must have disjoint leading terminals.`,
        )
      }
    }
  }
  const labeledArms = entries.map(([name, arm]) => label(name, arm)) as [
    Combinator<unknown>,
    ...Combinator<unknown>[],
  ]
  const result = trivia(oneOrMore(choice(...labeledArms)))
  result._meta.rootTriviaClassified = true
  return result
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

/**
 * Capture a named parse result for the nearest enclosing node() builder.
 * Parse behavior and the normal returned value are unchanged.
 */
export function field<T>(name: string, combinator: Combinator<T>): Combinator<T> {
  return {
    _tag: combinator._tag,
    _meta: combinator._meta,
    _def: { tag: 'field', name, parser: combinator as Combinator<unknown> },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      const result = combinator.parse(input, pos, ctx)
      if (!result.ok) return result
      ctx._fields?.push({ name, value: result.value, span: result.span })
      return result
    },
  }
}
