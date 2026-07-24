import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any, matchesEmpty } from './first-set.ts'
import { saveCstMark, rollbackCstCapture } from '../cst/capture-buffer.ts'

/**
 * Positive lookahead. Succeeds (consuming nothing) when `combinator` matches at
 * this position; fails when it doesn't. The mirror of `not()`.
 *
 *   // "a mixin reference, not a class selector": require the punctuation ahead,
 *   // then let the real production consume it.
 *   const mixinRef = sequence(ahead(regex(/[.#]/)), mixinCall)
 *
 * WHY THIS EXISTS AS A PRIMITIVE (not `not(not(X))`):
 *
 * `not(not(X))` is behaviourally a positive lookahead, but `not()` reports
 * `firstSet: any()` — it cannot know what it forbids — so `not(not(X))` reports
 * `any()` too. An arm leading with it therefore POISONS its choice's first-char
 * dispatch (`analyzeGating` flags it as the `double-not` anti-pattern), and among
 * sibling arms that share a first char the hand-rolled gate miscompiles.
 *
 * `ahead(X)` carries X's first-set instead, so a leading `ahead()` GATES its arm:
 * `choice(sequence(ahead(regex(/[.#]/)), …), …)` still emits O(1) dispatch.
 *
 * The first-set is exact only when X is NON-NULLABLE. A nullable `ahead(X)`
 * succeeds on the empty string, so it constrains no first character at all — it
 * reports `any()`, the sound over-approximation. (Same rule the sequence
 * first-set uses; see `isPositiveLookahead` in `first-set.ts`.)
 */
export function ahead(combinator: Combinator<unknown>): Combinator<null> {
  const meta: ParserMeta = {
    // A nullable body imposes no first-char constraint — `any()`, not its set.
    firstSet: matchesEmpty(combinator) ? any() : combinator._meta.firstSet,
    canMatchNewline: false,
    isTrivia: false,
  }

  return {
    _tag: 'ahead',
    _meta: meta,
    _def: { tag: 'ahead', parser: combinator },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<null> {
      // Zero-width on BOTH outcomes: whatever the inner attempt captured (CST
      // leaves/trivia/fields) or recovered must be rolled back, or a speculative
      // capture would ghost past the lookahead. Mirrors not().
      const mark = saveCstMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      rollbackCstCapture(ctx, mark)
      if (result.ok) return { ok: true, value: null, span: { start: pos, end: pos } }
      return { ok: false, expected: [`ahead(${combinator._tag})`], span: { start: pos, end: pos } }
    },
  }
}
