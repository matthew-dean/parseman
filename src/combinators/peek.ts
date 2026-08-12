import type { Combinator, ParseContext, ParseResult, ParserMeta } from '../types.ts'
import { any, matchesEmpty } from './first-set.ts'
import { saveLookaheadMark, rollbackLookahead } from './trivia-skip.ts'
import { assertionFailureExpected } from './expected.ts'

/**
 * Positive lookahead. Succeeds (consuming nothing) when `combinator` matches at
 * this position; fails when it doesn't. The mirror of `not()`.
 *
 *   // "a mixin reference, not a class selector": require the punctuation ahead,
 *   // then let the real production consume it.
 *   const mixinRef = sequence(peek(regex(/[.#]/)), mixinCall)
 *
 * WHY THIS EXISTS AS A PRIMITIVE (not `not(not(X))`):
 *
 * `not(not(X))` is behaviourally a positive lookahead, but `not()` reports
 * `firstSet: any()` — it cannot know what it forbids — so `not(not(X))` reports
 * `any()` too. An arm leading with it therefore POISONS its choice's first-char
 * dispatch (`analyzeGating` flags it as the `double-not` anti-pattern), and among
 * sibling arms that share a first char the hand-rolled gate miscompiles.
 *
 * `peek(X)` carries X's first-set instead, so a leading `peek()` GATES its arm:
 * `choice(sequence(peek(regex(/[.#]/)), …), …)` still emits O(1) dispatch.
 *
 * The first-set is exact only when X is NON-NULLABLE. A nullable `peek(X)`
 * succeeds on the empty string, so it constrains no first character at all — it
 * reports `any()`, the sound over-approximation. (Same rule the sequence
 * first-set uses; see `isPositiveLookahead` in `first-set.ts`.)
 */
export function peek(combinator: Combinator<unknown>): Combinator<null> {
  const meta: ParserMeta = {
    // A nullable body imposes no first-char constraint — `any()`, not its set.
    firstSet: matchesEmpty(combinator) ? any() : combinator._meta.firstSet,
    canMatchNewline: false,
    isTrivia: false,
  }

  return {
    _tag: 'peek',
    _meta: meta,
    _def: { tag: 'peek', parser: combinator },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<null> {
      // Zero-width on BOTH outcomes, so the probe must leave NO observable trace:
      // whatever the inner attempt captured (CST leaves/rawChildren/per-node
      // trivia/fields), recovered (`_errors`), or committed to the GLOBAL
      // `_triviaLog` is rolled back either way.
      //
      // `rollbackTrivia`, not `rollbackCstCapture`: the latter's mark omits
      // `_triviaLog`, which is a SEPARATE sink `scanTrivia().commit()` writes when
      // the body skips ambient trivia between terms. Missing it duplicates every
      // probed trivia span once the region is parsed for real — `_triviaLog` has no
      // dedup anywhere (`triviaEntries()` is a positional view over the flat array),
      // so the duplicate reaches output. Same failure mode as the one recorded in
      // `test/parity/trivia-log-regression.test.ts`. The compiled `peek` emits its
      // body under a non-capturing ctx and so never writes these sinks at all; this
      // is what keeps the two engines at parity.
      const mark = saveLookaheadMark(ctx)
      const result = combinator.parse(input, pos, ctx)
      rollbackLookahead(ctx, mark)
      if (result.ok) return { ok: true, value: null, span: { start: pos, end: pos } }
      return {
        ok: false, expected: assertionFailureExpected(true, combinator._tag),
        span: { start: pos, end: pos },
      }
    },
  }
}
