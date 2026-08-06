import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any } from './first-set.ts'

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
      // Hot path is an `undefined` check plus one `undefined` compare.
      const gt = meta.grammarTrivia
      if (gt !== undefined && ctx.trivia === undefined) {
        const savedTrivia = ctx.trivia
        const savedLabels = ctx.triviaKindLabels
        ctx.trivia = gt
        ctx.triviaKindLabels = gt._meta.triviaKindLabels
        try { return resolved.parse(input, pos, ctx) }
        finally { ctx.trivia = savedTrivia; ctx.triviaKindLabels = savedLabels }
      }
      return resolved.parse(input, pos, ctx)
    },
    define(p: Combinator<T>): void {
      if (resolved) throw new Error('ref<T>() already defined')
      resolved = p
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
