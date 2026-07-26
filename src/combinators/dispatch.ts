import type { Combinator, DispatchCase, ParseContext, ParseResult, ParserMeta } from '../types.ts'

export type DispatchWhen<T> = {
  readonly kind: 'when'
  readonly keys: readonly string[]
  readonly parser: Combinator<T>
}

export type DispatchOtherwise<T> = {
  readonly kind: 'otherwise'
  readonly parser: Combinator<T>
}

export type DispatchArm<T = unknown> = DispatchWhen<T> | DispatchOtherwise<T>

type ArmValue<T> = T extends DispatchWhen<infer U> ? U : T extends DispatchOtherwise<infer U> ? U : never
type UnionArms<T extends readonly DispatchArm<unknown>[]> = {
  [K in keyof T]: ArmValue<T[K]>
}[number]

export function when<T>(key: string | readonly string[], parser: Combinator<T>): DispatchWhen<T> {
  const keys = Array.isArray(key) ? [...key] : [key]
  if (keys.length === 0) throw new RangeError('parseman: when() requires at least one key')
  for (const item of keys) {
    if (typeof item !== 'string') throw new TypeError('parseman: when() keys must be strings')
  }
  return { kind: 'when', keys, parser }
}

export function otherwise<T>(parser: Combinator<T>): DispatchOtherwise<T> {
  return { kind: 'otherwise', parser }
}

export function dispatch<S extends string, T extends readonly DispatchArm<unknown>[]>(
  selector: Combinator<S>,
  ...arms: T
): Combinator<[S, UnionArms<T>]> {
  let fallback: Combinator<unknown> | undefined
  const cases: DispatchCase[] = []
  const seen = new Set<string>()

  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!
    if (arm.kind === 'otherwise') {
      if (fallback !== undefined) throw new Error('parseman: dispatch() accepts at most one otherwise() arm')
      if (i !== arms.length - 1) throw new Error('parseman: otherwise() must be the last dispatch() arm')
      fallback = arm.parser
      continue
    }
    for (const key of arm.keys) {
      if (seen.has(key)) throw new Error(`parseman: duplicate dispatch key ${JSON.stringify(key)}`)
      seen.add(key)
    }
    cases.push({ keys: arm.keys, parser: arm.parser as Combinator<unknown> })
  }

  const meta: ParserMeta = {
    firstSet: selector._meta.firstSet,
    canMatchNewline: selector._meta.canMatchNewline ||
      cases.some(entry => entry.parser._meta.canMatchNewline) ||
      (fallback?._meta.canMatchNewline ?? false),
    isTrivia: false,
  }

  const byKey = new Map<string, Combinator<unknown>>()
  for (const entry of cases) for (const key of entry.keys) byKey.set(key, entry.parser)

  return {
    _tag: 'dispatch',
    _meta: meta,
    _def: {
      tag: 'dispatch',
      selector: selector as Combinator<string>,
      cases,
      ...(fallback === undefined ? {} : { otherwise: fallback }),
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<[S, UnionArms<T>]> {
      const selected = selector.parse(input, pos, ctx)
      if (!selected.ok) return selected

      const tail = byKey.get(selected.value) ?? fallback
      if (tail === undefined) {
        const expected = cases.flatMap(entry => entry.keys.map(key => JSON.stringify(key)))
        return { ok: false, expected, span: { start: selected.span.end, end: selected.span.end } }
      }

      const result = tail.parse(input, selected.span.end, ctx)
      if (!result.ok) return { ...result, committed: true }

      return {
        ok: true,
        value: [selected.value, result.value as UnionArms<T>],
        span: { start: pos, end: result.span.end },
      }
    },
  }
}
