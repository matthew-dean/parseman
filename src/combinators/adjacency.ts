import type { Combinator, ParseContext, ParseFail, ParserMeta } from '../types.ts'
import { analyzeLabeledTrivia, resolveAdjacencyKindMask, triviaKindMaskAt } from '../cst/trivia-kinds.ts'
import { probeTriviaEnd } from './trivia-skip.ts'

/**
 * ADJACENCY assertions — `adjacent()` and `notAdjacent()`.
 *
 * These are the authoring surface for `docs/design/derived-tokenization.md` §4,
 * "Adjacency is a bit set at scan time". §4's fact is: *was there nothing between
 * the previous token and this one?* The trivia skip already answers it at every
 * sequence boundary and throws the answer away. `noTrivia` is today's POSITIVE
 * spelling of that fact and has no negative twin, so a production that needs
 * "these two are SEPARATED" has had to disable trivia and re-spell whitespace as a
 * regex — which re-implements the dialect's trivia table inside an expression
 * production, and drifts from it.
 *
 * The question is about the GAP, never about what a separator looks like:
 *
 *   1 - 2   the `-` is not adjacent to the `2`  → subtraction
 *   1 -2    the `-` IS adjacent to the `2`      → signed number in a list
 *
 * and a third case, `1`, a block comment, `-`, a block comment, `2`: not adjacent,
 * but the separation is a comment rather than whitespace. That case is why `kinds`
 * exists. css-values-4 §10.1 requires REAL whitespace
 * around `+`/`-` in `calc()`, because a comment vanishes at tokenisation:
 * `notAdjacent({ kinds: ['whitespace'] })` states that and nothing else.
 *
 * LOWERING. Both are marker tags, recognised by `sequence()` at term `i` and lowered
 * at that boundary into a test of the trivia scan the boundary already performs
 * (`scanEnd > cur`). That is deliberate on two counts: it costs nothing at all where
 * no assertion is written (no ctx field, no extra branch in the ordinary boundary),
 * and it sidesteps `sequence`'s trivia REWIND — a self-contained zero-width
 * combinator sitting at index `i` matches zero-width by construction, so the
 * `result.span.end > scanEnd` test would roll the gap it just asserted back out.
 * When derived tokenization lands, the same tag lowers to a `tight` bit test on the
 * token instead; the assertion an author writes does not change.
 */

export type AdjacencyDef = { tag: 'adjacency'; polarity: 'adjacent' | 'notAdjacent'; kinds?: readonly string[] }

/** The adjacency spec of `p`, or null when `p` is an ordinary combinator. */
export function adjacencyOf(p: Combinator<unknown>): AdjacencyDef | null {
  return p._def.tag === 'adjacency' ? p._def : null
}

/** Failure label, matched byte-for-byte by the compiled path. */
export function adjacencyExpected(def: AdjacencyDef): string {
  if (def.polarity === 'adjacent') return 'adjacent'
  return def.kinds === undefined ? 'notAdjacent' : `notAdjacent(${def.kinds.join('|')})`
}

/**
 * Evaluate one adjacency assertion at a sequence boundary. `cur` is the position
 * BEFORE the ambient trivia scan. No capture, no cursor movement, no ctx writes.
 */
export function holdsAdjacency(input: string, cur: number, ctx: ParseContext, def: AdjacencyDef): boolean {
  return adjacencyHolds(input, cur, ctx, def.polarity === 'notAdjacent', def.kinds)
}

/**
 * The test itself, over the two things a def actually carries.
 *
 * Split from `holdsAdjacency` so the TABLE drivers can reach it: both decode a
 * polarity word and a const-pool slot out of the instruction stream and have no
 * `AdjacencyDef` object to hand — and manufacturing one per assertion, on a
 * boundary test that is otherwise allocation-free, would be an allocation the
 * interpreter does not pay. One implementation, three engines.
 */
export function adjacencyHolds(
  input: string, cur: number, ctx: ParseContext, negated: boolean, kinds: readonly string[] | undefined,
): boolean {
  const end = probeTriviaEnd(input, cur, ctx)
  if (!negated) return end === cur
  if (end === cur) return false
  if (kinds === undefined) return true
  const want = resolveAdjacencyKindMask(ctx.trivia, kinds)
  const spec = analyzeLabeledTrivia(ctx.trivia!)!
  return (triviaKindMaskAt(input, cur, spec, ctx.state) & want) !== 0
}

export function adjacencyFail(pos: number, def: AdjacencyDef): ParseFail {
  return { ok: false, expected: [adjacencyExpected(def)], span: { start: pos, end: pos } }
}

const NO_STANDALONE_PARSE = 'adjacency assertions are boundary tests: use adjacent()/notAdjacent() as a '
  + 'NON-FIRST term of a sequence(), where the preceding term defines the gap being asserted.'

/**
 * The error a marker in a position with no boundary raises — the same sentence
 * from every engine.
 *
 * The table drivers need it for the same reason the combinator does: an
 * assertion reached anywhere but a sequence term has no gap to test, and
 * silently answering "no trivia here" would make `notAdjacent()` a guaranteed
 * failure and `adjacent()` a no-op, both invisible.
 */
export function adjacencyMisuse(polarity: 'adjacent' | 'notAdjacent'): TypeError {
  return new TypeError(`${polarity}(): ${NO_STANDALONE_PARSE}`)
}

function adjacencyCombinator(def: AdjacencyDef): Combinator<null> {
  const meta: ParserMeta = {
    // Zero-width and never leading (sequence() rejects index 0), so it contributes
    // no first char. `isZeroWidthAssertion` drops it from a sequence's first-set
    // rather than letting `any` poison the enclosing choice's dispatch.
    firstSet: { kind: 'any' },
    canMatchNewline: false,
    isTrivia: false,
  }
  return {
    _tag: 'adjacency',
    _meta: meta,
    _def: def,
    parse(): never {
      // Reached only when the marker sits somewhere that has no boundary to test
      // (a bare choice arm, a node()'s whole body, a repeat item). Silently
      // answering "no trivia here" would make `notAdjacent()` a guaranteed failure
      // and `adjacent()` a no-op — both invisible. Say so instead.
      throw adjacencyMisuse(def.polarity)
    },
  }
}

/**
 * Zero-width assertion: the previous term and this position are ADJACENT — no
 * ambient trivia sat between them.
 *
 * The first-class spelling of what `noTrivia(...)` expresses today by clearing the
 * trivia table around a glued run. Use it when only the JOIN is significant and the
 * terms themselves are ordinary:
 *
 *   sequence(number, adjacent(), unit)     // `10px`, never `10 px`
 */
export function adjacent(): Combinator<null> {
  return adjacencyCombinator({ tag: 'adjacency', polarity: 'adjacent' })
}

/**
 * Zero-width assertion: the previous term and this position are NOT adjacent —
 * ambient trivia sat between them.
 *
 * `kinds` narrows it to trivia CATEGORIES declared by `classifiedTrivia({...})`, so
 * the assertion can demand a category that survives tokenisation:
 *
 *   // css-values-4 10.1: `a + b` yes; a comment in place of the space, no.
 *   sequence(operand, notAdjacent({ kinds: ['whitespace'] }), plusOrMinus,
 *            notAdjacent({ kinds: ['whitespace'] }), operand)
 *
 * A `kinds` list is checked against the ACTIVE trivia table the first time the
 * assertion is reached (and at compile time for the compiled path). Unlabeled
 * trivia, or a kind name the table does not declare, is a hard `TypeError` — never
 * a silently-empty filter.
 */
export function notAdjacent(options?: { kinds?: readonly string[] }): Combinator<null> {
  const kinds = options?.kinds
  if (kinds !== undefined) {
    if (!Array.isArray(kinds) || kinds.length === 0) {
      throw new TypeError('notAdjacent({ kinds }): kinds must be a non-empty array of trivia category names.')
    }
    for (const k of kinds) {
      if (typeof k !== 'string' || k.length === 0) {
        throw new TypeError(`notAdjacent({ kinds }): every kind must be a non-empty string, got ${JSON.stringify(k)}.`)
      }
    }
  }
  return adjacencyCombinator(
    kinds === undefined
      ? { tag: 'adjacency', polarity: 'notAdjacent' }
      : { tag: 'adjacency', polarity: 'notAdjacent', kinds: [...kinds] },
  )
}
