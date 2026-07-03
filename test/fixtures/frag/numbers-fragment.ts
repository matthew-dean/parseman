/**
 * A self-contained shared fragment for tier-2 (imported) macro inlining tests.
 * It references only parseman combinators (resolved by name) and the `g` proxy —
 * no module-level consts — so the macro can inline it from this source file.
 */
import { regex, oneOrMore, transform } from 'parseman'

export const numbers = (g: any) => ({
  digit: regex(/[0-9]/),
  // A transform callback whose SOURCE must be sliced from THIS file (not the
  // consumer's) — guards the cross-file source-offset bug. Left untyped so the
  // compose test's `new Function` harness (which doesn't strip TS) can run it.
  number: transform(oneOrMore(g.digit), ds => ds.join('')),
})
