/**
 * THE VALUE OF THE `_rootTriviaLog` ROLLBACK MARK, not merely its existence.
 *
 * Every pre-existing test that rejects a speculative branch carrying selected
 * root trivia takes its mark from an EMPTY `_rootTriviaLog`, so the correct mark
 * is `0` and an engine that hard-codes `0` is indistinguishable from one that
 * saves the length. Replacing both `rt` marks in `emit-assembly.ts` with the
 * literal `0` passed all 3318 tests; the same edit to `_triviaLog`'s `lg` marks
 * failed eight, which is what makes this gap specific rather than general.
 *
 * The gap is one-sided in a second way. `expectUniqueTriviaEntries`
 * (helpers/trivia-log-parity.ts) fails on DUPLICATE spans, so it catches a mark
 * that under-truncates and is blind to one that over-truncates and silently
 * deletes committed history.
 *
 * Each case here commits root trivia BEFORE the speculative region opens, so the
 * three outcomes are three different row sets:
 *
 *   correct           the committed prefix survives, the speculative tail does not
 *   mark hard-zeroed  the committed prefix is DELETED along with the tail
 *   never truncated   the speculative tail SURVIVES and is recorded twice
 *
 * Driven through the table engine as well as the interpreter, because the table's
 * emitted assembly re-derives these marks per site and is the one engine the
 * existing suite never held to their value.
 */
import { describe, it, expect } from 'vitest'
import {
  sequence, literal, regex, classifiedTrivia, rules, choice, many, run,
} from '../../src/index.ts'
import type { Runnable } from '../../src/functional/run.ts'
import type { Combinator } from '../../src/types.ts'
import { compileRuleMap } from '../../src/table/compile-rule-map.ts'
import { tableRules } from '../../src/table/index.ts'

function labeledRw() {
  return classifiedTrivia({
    whitespace: regex(/[ \t\n\r\f]+/),
    blockComment: regex(/\/\*(?:[^*]|\*(?!\/))*\*\//),
  })
}

/** The same rule map, as the interpreter's combinators and as a table runnable. */
function bothEngines(build: () => Record<string, Combinator<unknown>>) {
  const rw = labeledRw()
  const grammar: Record<string, Runnable> = rules({ trivia: rw }, build)
  const compiled = compileRuleMap(Object.entries(grammar) as Array<[string, Combinator<unknown>]>, { trivia: rw })!
  const table = new Function('tableRules', `return ${compiled.replacement}`)(tableRules) as Record<string, Runnable>
  return [['interpreter', grammar.Root!], ['table', table.Root!]] as const
}

const SELECTED = { rootTrivia: { select: ['blockComment'] as const } }

describe('the _rootTriviaLog rollback mark carries a SAVED length, not a hard zero', () => {
  /**
   * `a /*1*\/ b /*2*\/ z` against `a (b c | b) z`.
   *
   * The choice opens with `/*1*\/` already committed, so its mark is 5 — one
   * five-number row — and not 0. Arm 1 commits `/*2*\/` and then fails on `c`;
   * arm 2 succeeds; the final term re-scans the same gap and re-commits it.
   */
  it('a rejected choice arm keeps the prefix committed before it', () => {
    const input = 'a /*1*/ b /*2*/ z'
    //  gap [1,8) holding /*1*/ at [2,7), then gap [9,16) holding /*2*/ at [10,15)
    const rows = [1, 8, 2, 7, 0, 9, 16, 10, 15, 0]
    for (const [engine, root] of bothEngines(() => ({
      Root: sequence(
        literal('a'),
        choice(sequence(literal('b'), literal('c')), literal('b')),
        literal('z'),
      ),
    }))) {
      expect(run(root, input, SELECTED).rootTrivia?.rows, engine).toEqual(rows)
    }
  })

  /**
   * The repetition mark, which the emitted assembly takes per ITEM rather than
   * once per site. The loop's second iteration commits `/*3*\/` as lead trivia and
   * then fails the item, so the mark it rewinds to must be 10 — after `/*1*\/` and
   * `/*2*\/`, both committed by earlier, ACCEPTED work.
   */
  it('a rejected repetition item keeps the items accepted before it', () => {
    const input = 'a /*1*/ b /*2*/ c /*3*/ z'
    const rows = [1, 8, 2, 7, 0, 9, 16, 10, 15, 0, 17, 24, 18, 23, 0]
    for (const [engine, root] of bothEngines(() => ({
      Root: sequence(
        literal('a'),
        many(sequence(literal('b'), literal('c'))),
        literal('z'),
      ),
    }))) {
      expect(run(root, input, SELECTED).rootTrivia?.rows, engine).toEqual(rows)
    }
  })
})
