import type { Combinator, ParseContext } from '../types.ts'

export type ScalarParser = (input: string, pos: number, ctx: ParseContext) => number

export function scalarOf<T>(combinator: Combinator<T>): ScalarParser {
  return combinator._parseScalar!
}

function scalarTree(parser: Combinator<unknown>, seen: Set<Combinator<unknown>>): boolean {
  if (seen.has(parser)) return true
  if (parser._parseScalar === undefined) return false
  seen.add(parser)
  const def = parser._def
  if ('parsers' in def && !def.parsers.every(child => scalarTree(child, seen))) return false
  if ('parser' in def && !scalarTree(def.parser, seen)) return false
  if ('separator' in def && !scalarTree(def.separator, seen)) return false
  return def.tag !== 'lazy' || scalarTree(def.thunk(), seen)
}

/** Select the strict value-only ABI only when the complete root is in its family. */
export function scalarRootOf<T>(combinator: Combinator<T>): ScalarParser | undefined {
  const scalar = combinator._parseScalar
  const def = combinator._def
  return scalar !== undefined && def.tag === 'grammar' && scalarTree(def.parser, new Set())
    ? scalar
    : undefined
}
