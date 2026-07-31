/**
 * `src/cst/relative-spans.ts` — the bare Abs/RelNode reference model.
 *
 * The CST-shaped projection (`relativizeCST` / `absolutizeCST` / `absoluteSpanCST`) is
 * already pinned by `incremental.test.ts`. The reference model underneath it — and
 * `applyEdit`, which is the whole reason the relative form exists — was not.
 *
 * Every assertion here is on CONCRETE offsets. Span arithmetic is where an off-by-one
 * survives a round-trip test: `relativize`/`absolutize` are exact inverses of each other
 * whether or not either is right, so a round-trip alone proves nothing about the numbers.
 */
import { describe, it, expect } from 'vitest'
import {
  relativize, absolutize, absoluteSpanAt, shiftAbsolute, applyEdit,
  type AbsNode, type RelNode,
} from '../../src/index.ts'

const abs = (start: number, end: number, ...children: AbsNode[]): AbsNode => ({ start, end, children })
const rel = (start: number, end: number, ...children: RelNode[]): RelNode => ({ start, end, children })

/**
 *   root  [0,20]
 *     A   [0,5]
 *     B   [5,10]
 *       B1 [6,9]
 *     C   [10,20]
 */
const tree = abs(0, 20, abs(0, 5), abs(5, 10, abs(6, 9)), abs(10, 20))

describe('relativize / absolutize — the exact offsets, not just the round trip', () => {
  it('subtracts the PARENT start, so a grandchild is relative to its own parent', () => {
    const r = relativize(tree)
    // Root base is 0, so the root and its direct children keep their absolute numbers…
    expect({ start: r.start, end: r.end }).toEqual({ start: 0, end: 20 })
    expect(r.children.map(c => [c.start, c.end])).toEqual([[0, 5], [5, 10], [10, 20]])
    // …but B1 is relative to B's ABSOLUTE start (5), not to the root and not to B's
    // relative start. 6-5=1, 9-5=4. If this ever reads [6,9] the base is not being
    // accumulated; if it reads [1,4] against a different base the tree silently shifts.
    expect(r.children[1]!.children.map(c => [c.start, c.end])).toEqual([[1, 4]])
  })

  it('honours an explicit non-zero parentBase', () => {
    const r = relativize(abs(10, 14, abs(11, 13)), 10)
    expect([r.start, r.end]).toEqual([0, 4])
    // The child is relative to the node's absolute start (10), NOT to parentBase.
    expect(r.children.map(c => [c.start, c.end])).toEqual([[1, 3]])
  })

  it('absolutize is the exact inverse and restores every original number', () => {
    expect(absolutize(relativize(tree))).toEqual(tree)
    // …and independently: absolutize of a hand-written relative tree.
    const a = absolutize(rel(3, 9, rel(2, 5, rel(1, 2))))
    expect([a.start, a.end]).toEqual([3, 9])
    expect([a.children[0]!.start, a.children[0]!.end]).toEqual([5, 8])
    // grandchild base is its parent's ABSOLUTE start (5): 5+1=6, 5+2=7.
    expect([a.children[0]!.children[0]!.start, a.children[0]!.children[0]!.end]).toEqual([6, 7])
  })

  it('absolutize honours an explicit parentBase', () => {
    expect(absolutize(rel(1, 4), 100)).toEqual({ start: 101, end: 104, children: [] })
  })
})

describe('absoluteSpanAt — the cursor', () => {
  const r = relativize(tree)

  it('returns the ORIGINAL absolute span for a path, without absolutizing the tree', () => {
    expect(absoluteSpanAt(r, [])).toEqual({ start: 0, end: 20 })
    expect(absoluteSpanAt(r, [1])).toEqual({ start: 5, end: 10 })
    // The grandchild: proves the base accumulates. 5 (B) + 1 = 6, 5 + 4 = 9.
    expect(absoluteSpanAt(r, [1, 0])).toEqual({ start: 6, end: 9 })
    expect(absoluteSpanAt(r, [2])).toEqual({ start: 10, end: 20 })
  })

  it('agrees with absolutize at every path', () => {
    const a = absolutize(r)
    expect(absoluteSpanAt(r, [1, 0])).toEqual({ start: a.children[1]!.children[0]!.start, end: a.children[1]!.children[0]!.end })
  })

  it('throws a RangeError naming the missing child and the path', () => {
    expect(() => absoluteSpanAt(r, [0, 0])).toThrow(RangeError)
    expect(() => absoluteSpanAt(r, [0, 0])).toThrow('absoluteSpanAt: no child 0 on path 0.0')
    expect(() => absoluteSpanAt(r, [9])).toThrow('absoluteSpanAt: no child 9 on path 9')
  })
})

describe('shiftAbsolute — the naive baseline the relative form is measured against', () => {
  it('shifts offsets >= at and leaves offsets < at alone, per node and per endpoint', () => {
    const s = shiftAbsolute(tree, 7, 3)
    expect([s.start, s.end]).toEqual([0, 23])
    expect(s.children.map(c => [c.start, c.end])).toEqual([[0, 5], [5, 13], [13, 23]])
    // B1 straddles the edit: start 6 < 7 stays, end 9 >= 7 moves. Both endpoints are
    // decided independently — a single per-node test would hide that.
    expect(s.children[1]!.children.map(c => [c.start, c.end])).toEqual([[6, 12]])
  })

  it('an offset EXACTLY at `at` shifts', () => {
    expect(shiftAbsolute(abs(5, 6), 5, 4)).toEqual({ start: 9, end: 10, children: [] })
  })

  it('a negative delta (a deletion) shifts the same way', () => {
    const s = shiftAbsolute(tree, 7, -2)
    expect(s.children.map(c => [c.start, c.end])).toEqual([[0, 5], [5, 8], [8, 18]])
  })
})

describe('applyEdit — same answer as the naive shift, at O(depth) cost', () => {
  const r = relativize(tree)

  it('produces exactly the naive result, for an insertion and for a deletion', () => {
    for (const delta of [3, -2]) {
      const stats = { allocated: 0 }
      expect(absolutize(applyEdit(r, 7, delta, stats))).toEqual(shiftAbsolute(tree, 7, delta))
    }
  })

  it('counts the nodes it had to re-create, and shares the rest BY IDENTITY', () => {
    const stats = { allocated: 0 }
    const out = applyEdit(r, 7, 3, stats)
    // root, B, B1, C are rewritten; A ends at 5 < 7 and is returned untouched.
    expect(stats.allocated).toBe(4)
    expect(out.children[0]).toBe(r.children[0])
    expect(out).not.toBe(r)
  })

  it('a subtree that moves AS ONE UNIT with its parent is shared whole — the locality win', () => {
    //   root [0,30]  A [0,10] (A1 [1,9])  B [10,20] (B1 [11,19])  C [20,30] (C1 [21,29])
    const wide = abs(0, 30,
      abs(0, 10, abs(1, 9)),
      abs(10, 20, abs(11, 19)),
      abs(20, 30, abs(21, 29)))
    const rw = relativize(wide)
    const stats = { allocated: 0 }
    const out = applyEdit(rw, 5, 2, stats)

    expect(absolutize(out)).toEqual(shiftAbsolute(wide, 5, 2))
    // B and C move wholesale, so their CHILDREN are never visited-and-rebuilt: the
    // relative offsets are unchanged and the subtree is reused by identity. This is the
    // entire claim of the module; a deep-equal check would pass on a full rebuild.
    expect(out.children[1]!.children[0]).toBe(rw.children[1]!.children[0])
    expect(out.children[2]!.children[0]).toBe(rw.children[2]!.children[0])
    // 7 nodes exist; 5 are re-created (root, A, A1, B, C) and 2 are shared.
    expect(stats.allocated).toBe(5)
  })

  it('a node ending strictly BEFORE the edit is returned untouched; one ending exactly AT it grows', () => {
    const before = relativize(abs(0, 10, abs(0, 4)))
    const outB = applyEdit(before, 5, 1)
    expect(outB.children[0]).toBe(before.children[0])
    expect(absolutize(outB).children[0]).toEqual({ start: 0, end: 4, children: [] })

    const at = relativize(abs(0, 10, abs(0, 5)))
    const outA = applyEdit(at, 5, 1)
    expect(outA.children[0]).not.toBe(at.children[0])
    expect(absolutize(outA).children[0]).toEqual({ start: 0, end: 6, children: [] })
  })

  it('reuses the children ARRAY when the node moved but no child did', () => {
    const t = relativize(abs(0, 10, abs(0, 3)))
    const out = applyEdit(t, 8, 1)
    expect([out.start, out.end]).toEqual([0, 11])
    expect(out.children).toBe(t.children)
  })

  it('works without a stats object', () => {
    expect(absolutize(applyEdit(r, 7, 3))).toEqual(shiftAbsolute(tree, 7, 3))
  })
})
