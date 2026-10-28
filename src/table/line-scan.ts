import type { Combinator } from '../types.ts'
import type { ScanSpec, SubtreeRef } from './program.ts'
import { columns, lines } from '../combinators/lines.ts'

/**
 * Rebuild a `lines()` (kind 2) or `columns()` (kind 3) scan spec as the
 * combinator it was constructed as, its subtrees bound to the table's pieces.
 * Both drivers run the result through its own `parse`, as they do `scanTo`.
 */
export function rebuildLineScan(s: ScanSpec, subtree: (r: SubtreeRef) => Combinator<unknown>): Combinator<unknown> | undefined {
  if (s.kind === 2) {
    return lines(subtree(s.prefix!), subtree(s.body!), {
      ...(s.first === undefined ? {} : { first: subtree(s.first) }),
      ...(s.lazy === undefined ? {} : { lazy: subtree(s.lazy) }),
    }) as Combinator<unknown>
  }
  if (s.kind === 3) return columns(s.n!) as Combinator<unknown>
  return undefined
}
