import { describe, it } from 'vitest'
import { choice, literal, regex, sequence } from '../../src/index.ts'
import { assertEnginesAgreeAll } from './helpers/engine-parity.ts'

/**
 * Shared-prefix left-factoring replays a once-recognised prefix into each arm's own
 * leading terminal. The replay map is keyed on the combinator OBJECT — and a grammar
 * may legitimately use ONE object at both the leading position and later in the same
 * sequence. `sequence(num, literal('-'), num)` built from a single `num` is the
 * minimal case, and it is a common shape: binary operators, `A op A`, delimited pairs.
 *
 * Before the position gate, the trailing occurrence replayed the leading one's value
 * and end. `1-2` compiled to ['1','-','1'] with span 0-1 against the interpreter's
 * ['1','-','2'] over 0-5 — a parse that SUCCEEDS with a wrong tree and a truncated
 * span, no error and no warning. `7-7` diverged in span only, with identical values,
 * so a harness comparing values alone reported agreement.
 *
 * The 286-test parity suite passed this: `assertEnginesAgree` is sound, there was
 * simply no fixture of this shape. That absence is what this file is.
 */
describe('shared prefix: the same combinator object reused later in the arm', () => {
  const num = regex(/[0-9]+/)

  it('does not replay the prefix at a later occurrence of the same object', () => {
    const expr = choice(
      sequence(num, literal('-'), num),
      sequence(num, literal('+'), num),
    )
    assertEnginesAgreeAll(expr, ['1-2', '1+2', '12-34', '100+200', '7-7'])
  })

  it('still agrees when the trailing term is a DISTINCT but equal object', () => {
    // The control: this shape was never broken, which is what pins the defect to the
    // replay KEY rather than to the factored shape.
    const expr = choice(
      sequence(num, literal('-'), regex(/[0-9]+/)),
      sequence(num, literal('+'), regex(/[0-9]+/)),
    )
    assertEnginesAgreeAll(expr, ['1-2', '1+2', '12-34', '7-7'])
  })

  it('agrees when the shared object appears three times in one arm', () => {
    const expr = choice(
      sequence(num, literal('-'), num, literal('-'), num),
      sequence(num, literal('+'), num, literal('+'), num),
    )
    assertEnginesAgreeAll(expr, ['1-2-3', '1+2+3', '10-20-30'])
  })
})
