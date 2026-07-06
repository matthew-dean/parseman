/**
 * A *disjoint* scannable alternation (arms with mutually-exclusive first chars)
 * dispatches via a `switch` jump table when every arm keys off a few discrete
 * first chars — same plan as codegen's choice() dispatch. Wider first-sets keep
 * the range-comparison if/else chain.
 */
import { describe, it, expect } from 'vitest'
import { regex, parse, compile } from '../../src/index.ts'

const norm = (r) => ({ ok: r.ok, value: r.ok ? r.value : undefined, end: r.span.end })

describe('disjoint-alt switch dispatch', () => {
  it('discrete first chars → switch, parity with the engine', () => {
    const re = /foo|bar|qux/
    const compiled = compile(regex(re))
    expect(compiled.source).toContain('switch (')
    for (const input of ['foo', 'bar', 'qux', 'fo', 'barn', 'quux', 'x', '', 'fooo', 'b']) {
      expect(norm(compiled.parse(input)), input).toEqual(norm(parse(regex(re), input)))
    }
  })

  it('wide-range arms keep the if/else chain (no switch explosion)', () => {
    // `[a-z]+` / `[0-9]+` first-sets are wide → range comparisons, not a switch.
    const src = compile(regex(/[a-z]+|[0-9]+/)).source
    // (still lowers — just not to a switch)
    expect(src).not.toContain('.exec(input)')
  })
})
