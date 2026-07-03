/**
 * src/combinators/first-set.ts is only ever exercised INDIRECTLY today (via
 * choice.ts's disjoint-dispatch computation and friends) — no test imports it
 * directly, so several of its own branches (the 'empty'/'any' short-circuits
 * in union()/intersects(), and the plain range-merge path) were never hit on
 * their own terms. These tests call the module's functions directly.
 */
import { describe, it, expect } from 'vitest'
import { union, intersects, fromChar, fromRange, any, empty } from '../../src/combinators/first-set.ts'

describe('first-set — union()', () => {
  it('returns the other operand when one side is empty', () => {
    expect(union(empty(), fromRange(1, 5))).toEqual({ kind: 'ranges', ranges: [{ lo: 1, hi: 5 }] })
    expect(union(fromRange(1, 5), empty())).toEqual({ kind: 'ranges', ranges: [{ lo: 1, hi: 5 }] })
  })

  it('degrades to "any" when either side is "any"', () => {
    expect(union(any(), fromRange(1, 5))).toEqual({ kind: 'any' })
    expect(union(fromRange(1, 5), any())).toEqual({ kind: 'any' })
  })

  it('merges two concrete range sets, combining overlapping/adjacent ranges', () => {
    expect(union(fromRange(1, 5), fromRange(3, 8))).toEqual({ kind: 'ranges', ranges: [{ lo: 1, hi: 8 }] })
  })

  it('keeps disjoint concrete ranges separate', () => {
    expect(union(fromRange(1, 2), fromRange(10, 12))).toEqual({
      kind: 'ranges',
      ranges: [{ lo: 1, hi: 2 }, { lo: 10, hi: 12 }],
    })
  })
})

describe('first-set — intersects()', () => {
  it('is true whenever either side is "any"', () => {
    expect(intersects(any(), fromRange(1, 5))).toBe(true)
    expect(intersects(fromRange(1, 5), any())).toBe(true)
  })

  it('is false whenever either side is "empty"', () => {
    expect(intersects(empty(), fromRange(1, 5))).toBe(false)
    expect(intersects(fromRange(1, 5), empty())).toBe(false)
  })

  it('is true for overlapping concrete ranges, false for disjoint ones', () => {
    expect(intersects(fromRange(1, 5), fromRange(4, 8))).toBe(true)
    expect(intersects(fromRange(1, 5), fromRange(6, 8))).toBe(false)
  })
})

describe('first-set — constructors', () => {
  it('fromChar makes a single-code-point range', () => {
    expect(fromChar(65)).toEqual({ kind: 'ranges', ranges: [{ lo: 65, hi: 65 }] })
  })
})
