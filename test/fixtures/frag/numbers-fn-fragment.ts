/**
 * Same as numbers-fragment.ts, but exported via a `function` declaration rather
 * than `export const`. Guards tier-2 inlining of the natural `export function`
 * fragment style (an ExportNamedDeclaration whose declaration is a
 * FunctionDeclaration), not just the arrow/`const` form.
 */
import { regex, oneOrMore, transform } from 'parseman'

export function numbersFn(g: any) {
  return {
    digit: regex(/[0-9]/),
    number: transform(oneOrMore(g.digit), ds => ds.join('')),
  }
}
