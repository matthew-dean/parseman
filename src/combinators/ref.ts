import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'
import { hasOwnTriviaBoundary } from './trivia-boundary.ts'

/**
 * Create a forward-declared parser slot for mutually recursive grammars.
 *
 * Because JS evaluates arguments eagerly, you can't reference a variable
 * before it's declared. ref() creates a placeholder you fill in later:
 *
 *   const value = ref<JSONValue>()
 *   const array  = transform(sequence(literal('['), sepBy(value, literal(',')), literal(']')), ...)
 *   const object = transform(sequence(literal('{'), sepBy(pair, literal(',')), literal('}')), ...)
 *   value.define(choice(object, array, string, number, bool, nullVal))
 *
 * Unlike lazy(() => x), you use the ref directly — no wrapping at each call site.
 */
export function ref<T>(): Combinator<T> & { define(p: Combinator<T>): void } {
  let resolved: Combinator<T> | null = null
  /** `hasOwnTriviaBoundary(resolved)`, resolved at `define()`. See `parse`. */
  let ownBoundary = false

  const meta: ParserMeta = {
    firstSet: any(),
    canMatchNewline: true,
    isTrivia: false,
  }

  const slot = {
    _tag: 'lazy' as const,
    _meta: meta,
    _def: {
      tag: 'lazy' as const,
      thunk: () => {
        if (!resolved) throw new Error('ref<T>() used before .define() was called')
        return resolved as Combinator<unknown>
      },
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<T> {
      if (!resolved) throw new Error('ref<T>() used before .define() was called')
      // A RULE CARRIES ITS OWN AMBIENT TRIVIA — see `rules()` in parser.ts, which
      // stamps `grammarTrivia` on EVERY rule precisely so that entering any one of
      // them installs it. Reading it only at the parse ENTRY (grammar.ts) made the
      // interpreter scope trivia DYNAMICALLY: a rule referenced from underneath a
      // `noTrivia(...)` ran without trivia, so its meaning depended on its caller.
      // Codegen never had that behaviour — it binds each rule's trivia scanner at
      // COMPILE time (the emitted `_tf0(input, cur, ctx, 1)` before every sequence
      // boundary), so a `g.Foo` reference always runs under Foo's own scope.
      //
      // The two engines therefore parsed DIFFERENT LANGUAGES, and jess's Less
      // grammar sits exactly on the seam: `StandardDeclaration` wraps its value in
      // `noTrivia(...)` and the `!important` tail lives in the referenced rule
      // `ValueListWithPriority`, so the interpreter and both table drivers could not
      // cross the space in `color: red !important`. That one construct truncated a
      // 107 KB stylesheet at 68.5% while reporting `ok: true` with no errors.
      // Codegen shipped through 0.44-0.46 and was right; 0.47 made the table the
      // shipping engine and the divergence became the product.
      //
      // ONLY WHERE THE SCOPE WAS CLEARED, not wherever it merely differs. The
      // broader form (`ctx.trivia !== gt`) also OVERRIDES a caller that set a
      // different live trivia, and that measurably broke recognition: over jess's
      // four corpora it regressed `@less/test-data`'s `selectors.less` from 3791
      // bytes to 1784. A caller running under its own live trivia is making a
      // deliberate choice; a caller that CLEARED it is the `noTrivia(...)` case this
      // fixes. Restricting to the cleared case keeps every repair and drops that
      // regression.
      //
      // ONLY WHERE THE RULE HAS A BOUNDARY TO REPAIR. `ownBoundary` is resolved
      // once in `define()` (see `hasOwnTriviaBoundary`): a rule whose body is a
      // bare ALTERNATION, a dispatch, or a single terminal has no position of its
      // own at which ambient trivia is consulted, so re-establishing the scope
      // there cannot repair anything — it can only leak past the arms into
      // whatever they delegate to.
      //
      // That leak is what jess's SCSS value grammar hit. `ValueTerm` clears, and
      // `MathUnary` — `choice(noTrivia(…), noTrivia(…), g.ValueAtom)` — restored
      // for a body that never uses it, handing its third arm a live scope.
      // `ValueAtom` → `KeywordOrInterpolatedValue`, whose `many()` concatenates
      // identifier chunks, then skipped the space between its terms:
      // `gen-workload.scss` stopped at byte 218 of 287543, and `a{b: c d}` silently
      // produced the ONE keyword `bc` with `ok: true` and no errors.
      //
      // Hot path is one boolean check.
      const gt = meta.grammarTrivia
      if (gt !== undefined && ownBoundary && ctx.trivia === undefined) {
        const savedLabels = ctx.triviaKindLabels
        ctx.trivia = gt
        ctx.triviaKindLabels = gt._meta.triviaKindLabels
        try { return resolved.parse(input, pos, ctx) }
        finally { ctx.trivia = undefined; ctx.triviaKindLabels = savedLabels }
      }
      return resolved.parse(input, pos, ctx)
    },
    define(p: Combinator<T>): void {
      if (resolved) throw new Error('ref<T>() already defined')
      resolved = p
      ownBoundary = hasOwnTriviaBoundary(p as Combinator<unknown>)
      meta.firstSet = p._meta.firstSet
      meta.canMatchNewline = p._meta.canMatchNewline
      meta.isTrivia = p._meta.isTrivia
      if (p._meta.triviaKindLabels !== undefined) meta.triviaKindLabels = p._meta.triviaKindLabels
      else delete meta.triviaKindLabels
      if (p._meta.disjoint !== undefined) meta.disjoint = p._meta.disjoint
      else delete meta.disjoint
    },
  }

  return slot
}
