/**
 * Differential matrix for the repeat family's OPTIONS.
 *
 * Every option combination is exercised through both engines on the same inputs,
 * strict AND tolerant, with whole-object comparison (see `engine-parity.ts`).
 * The point is coverage by construction rather than by inspiration: a new option
 * is added to the matrix, not to a hand-written pair of cases, so the shapes a
 * reviewer would not have thought to write are still compared.
 *
 * `trailing: 'forbid'` is the default every existing grammar uses, which is why
 * a green suite said nothing about `'allow'`/`'require'`.
 */
import { describe, it } from 'vitest'
import { regex, literal, sequence, sepBy, many, oneOrMore } from '../../src/index.ts'
import { assertEnginesAgreeAll } from './helpers/engine-parity.ts'
import type { Combinator } from '../../src/index.ts'

const item = regex(/[a-z]+/)
const comma = literal(',')

/** Bare list, and the same list inside delimiters — the latter publishes a sync
 * sentinel, which is what arms the tolerant recovery branch. A bare list does
 * not, so a matrix without the wrapped form never reaches that code at all. */
const shapes = {
  bare: (list: Combinator<unknown>) => list,
  wrapped: (list: Combinator<unknown>) => sequence(literal('{'), list, literal('}')),
}

const INPUTS = {
  bare: ['a', 'a,b', 'a,b,', 'a,', '', 'a,,b', 'a,$$,b', 'a,$$', ',a', 'a,b,c,'],
  wrapped: ['{a}', '{a,b}', '{a,b,}', '{a,}', '{}', '{a,,b}', '{a,$$,b}', '{a,$$}', '{,a}', '{a,b,c,}'],
}

const TRAILING = ['forbid', 'allow', 'require'] as const

describe('repeat options — interpreter ⇔ compiled, whole-result parity', () => {
  for (const trailing of TRAILING) {
    for (const [shapeName, wrap] of Object.entries(shapes)) {
      it(`sepBy { trailing: '${trailing}' } — ${shapeName}`, () => {
        const entry = wrap(sepBy(item, comma, { trailing }))
        assertEnginesAgreeAll(entry, INPUTS[shapeName as keyof typeof INPUTS])
      })

      it(`sepBy { trailing: '${trailing}' } — ${shapeName}, tolerant/recovery`, () => {
        const entry = wrap(sepBy(item, comma, { trailing }))
        assertEnginesAgreeAll(entry, INPUTS[shapeName as keyof typeof INPUTS], {
          tolerant: true,
          recovery: true,
        })
      })
    }
  }

  for (const min of [0, 1, 2, 3]) {
    it(`sepBy { min: ${min} } — bounds parity`, () => {
      assertEnginesAgreeAll(sepBy(item, comma, { min }), INPUTS.bare)
    })
  }

  for (const max of [1, 2, 3]) {
    it(`sepBy { max: ${max} } — bounds parity`, () => {
      assertEnginesAgreeAll(sepBy(item, comma, { max }), INPUTS.bare)
    })
  }

  // `many`/`oneOrMore` carry the same bounds, and the same anchoring rule. The
  // first version of this matrix covered only sepBy and so missed that `many`'s
  // min-not-met path anchored at the repeat's START while its compiled form
  // anchored at the furthest position — the identical defect, one combinator
  // over. Bounds parity belongs to the repeat FAMILY, not to sepBy.
  const REPEAT_INPUTS = ['', 'x', 'xx', 'xxx', 'xxxx', 'y', 'xxy']
  for (const min of [0, 1, 2, 3]) {
    it(`many { min: ${min} } — bounds parity`, () => {
      assertEnginesAgreeAll(many(regex(/x/), { min }), REPEAT_INPUTS)
    })
  }
  for (const max of [1, 2, 3]) {
    it(`many { max: ${max} } — bounds parity`, () => {
      assertEnginesAgreeAll(many(regex(/x/), { max }), REPEAT_INPUTS)
    })
  }
  for (const min of [1, 2, 3]) {
    it(`oneOrMore { min: ${min} } — bounds parity`, () => {
      assertEnginesAgreeAll(oneOrMore(regex(/x/), { min }), REPEAT_INPUTS)
    })
  }
})
