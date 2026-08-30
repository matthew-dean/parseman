import type { Combinator, ParseContext, ParseResult } from '../types.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'
import { choice } from './choice.ts'
import { matchesEmpty } from './first-set.ts'
import { oneOrMore } from './repeat.ts'
import { fastTriviaScanner } from './trivia-skip.ts'
import { scalarOf } from './scalar.ts'

const JSON_STRING_BODY = String.raw`(?:[^"\\]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*`

export function transform<T, U>(
  combinator: Combinator<T>,
  fn: (value: T, span: { start: number; end: number }) => U
): Combinator<U> {
  const observesSpan = fn.length > 1
  const sequenceDef = combinator._def.tag === 'sequence' ? combinator._def : undefined
  const terms = sequenceDef?.parsers
  const inner = terms?.[1]
  const fused = terms?.length === 3
    && terms[0]!._def.tag === 'literal' && terms[0]!._def.value === '"' && !terms[0]!._def.caseInsensitive
    && inner!._def.tag === 'regex' && inner!._def.source === JSON_STRING_BODY && inner!._def.flags === ''
    && terms[2]!._def.tag === 'literal' && terms[2]!._def.value === '"' && !terms[2]!._def.caseInsensitive
    && inner!._stickyRegex !== undefined
  const child = scalarOf(combinator)
  const parseScalar = fused
    ? (() => {
        const body = inner!._stickyRegex!
        const tuple = ['"', '', '"']
        const expected = [JSON.stringify('"')]
        return (input: string, pos: number, ctx: ParseContext): number => {
          if (ctx.trivia !== undefined) {
            const end = child(input, pos, ctx)
            if (end < 0) return end
            ctx._sv = observesSpan
              ? fn(ctx._sv as T, { start: pos, end })
              : (fn as (value: T) => U)(ctx._sv as T)
            return end
          }
          if (input.charCodeAt(pos) !== 34) {
            ctx._fx = expected
            return ~pos
          }
          body.lastIndex = pos + 1
          const match = body.exec(input)!
          const close = pos + 1 + match[0]!.length
          if (input.charCodeAt(close) !== 34) {
            ctx._fx = expected
            return ~close
          }
          tuple[1] = match[0]!
          const end = close + 1
          ctx._sv = observesSpan
            ? fn(tuple as T, { start: pos, end })
            : (fn as (value: T) => U)(tuple as T)
          return end
        }
      })()
    : (() => {
        return (input: string, pos: number, ctx: ParseContext): number => {
          const end = child(input, pos, ctx)
          if (end < 0) return end
          ctx._sv = observesSpan
            ? fn(ctx._sv as T, { start: pos, end })
            : (fn as (value: T) => U)(ctx._sv as T)
          return end
        }
      })()
  return {
    _tag: 'transform',
    _meta: combinator._meta,
    _def: { tag: 'transform', parser: combinator as Combinator<unknown>, fn: fn as (v: unknown, span: { start: number; end: number }) => unknown },
    _parseScalar: parseScalar,
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<U> {
      const result = combinator.parse(input, pos, ctx)
      if (!result.ok) return result
      return { ok: true, value: fn(result.value, result.span), span: result.span }
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
      triviaScanner: fastTriviaScanner(combinator as Combinator<unknown>),
      ...(kindLabels ? { triviaKindLabels: kindLabels } : {}),
    },
    _def: { tag: 'trivia', parser: combinator as Combinator<unknown> },
    _parseScalar: scalarOf(combinator),
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
