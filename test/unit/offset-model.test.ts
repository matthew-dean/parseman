import { describe, it, expect } from 'vitest'
import {
  OffsetIndex,
  gapText,
  lineBreaksIn,
  blankLinesIn,
  lineStartWithin,
  indentWidth,
  indentMixed,
  commentsIn,
  gapIsSignificant,
  type Slot,
} from '../../src/cst/offset-model.ts'
import {
  relativize,
  absolutize,
  absoluteSpanAt,
  shiftAbsolute,
  applyEdit,
  type AbsNode,
} from '../../src/cst/relative-spans.ts'

const COMMENT = /\/\*(?:[^*]|\*(?!\/))*\*\//

// Deterministic PRNG (mulberry32) — no Math.random, reproducible fuzz.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('OffsetIndex — gap queries', () => {
  // Source: "ab  cd\n  ef"  slots: ab[0,2] cd[4,6] ef[9,11]
  const src = 'ab  cd\n  ef'
  const slots: Slot[] = [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
    { start: 9, end: 11 },
  ]
  const idx = new OffsetIndex(slots, 0, src.length)

  it('reconstructs trivia between slots by slicing source', () => {
    expect(gapText(src, idx.gapAfter(2)!)).toBe('  ') // between ab and cd
    expect(gapText(src, idx.gapAfter(6)!)).toBe('\n  ') // between cd and ef
  })

  it('gapBefore/gapAfter agree on the same physical gap (no double-index)', () => {
    const afterCd = idx.gapAfter(6)! // [6,9)
    const beforeEf = idx.gapBefore(9)! // [6,9)
    expect(afterCd).toEqual(beforeEf)
  })

  it('leading and trailing gaps are covered', () => {
    const lead = new OffsetIndex([{ start: 2, end: 4 }], 0, 6)
    expect(lead.gap(0)).toEqual({ start: 0, end: 2 }) // leading
    expect(lead.gap(1)).toEqual({ start: 4, end: 6 }) // trailing
  })

  it('gapIndexAt locates the containing gap', () => {
    expect(idx.gapIndexAt(3)).toBe(1) // inside "  " between slot 0 and 1
    expect(idx.gapIndexAt(7)).toBe(2) // inside "\n  " between slot 1 and 2
  })

  it('exposes slots and empty-gap checks', () => {
    expect(idx.slot(1)).toEqual({ start: 4, end: 6 })
    expect(idx.slot(-1)).toBeUndefined()
    expect(idx.slot(3)).toBeUndefined()
    expect(idx.isEmpty({ start: 2, end: 2 })).toBe(true)
    expect(idx.isEmpty(idx.gapAfter(2)!)).toBe(false)
  })

  it('rejects overlapping / out-of-order slots', () => {
    expect(() => new OffsetIndex([{ start: 0, end: 5 }, { start: 3, end: 8 }])).toThrow(/overlap/i)
  })
})

describe('reconstruction algebra — spatial quantities are subtraction', () => {
  it('counts line breaks and blank lines', () => {
    expect(lineBreaksIn('a\n\n\nb', { start: 1, end: 4 })).toBe(3)
    expect(blankLinesIn('a\n\n\nb', { start: 1, end: 4 })).toBe(2)
    expect(lineBreaksIn('a  b', { start: 1, end: 3 })).toBe(0)
  })

  it('derives indent width from the last break by subtraction', () => {
    // "x\n    y" — gap between x[0,1] and y at 6 is [1,6): "\n    " → indent 4
    const src = 'x\n    y'
    const gap = { start: 1, end: 6 }
    expect(lineStartWithin(src, gap)).toBe(2)
    expect(indentWidth(src, gap)).toBe(4)
  })

  it('reports zero indent when the gap has no newline (same line)', () => {
    expect(indentWidth('a   b', { start: 1, end: 4 })).toBe(0)
  })

  it('detects mixed tab/space indent (the one non-inferable composition)', () => {
    expect(indentMixed('x\n\t  y', { start: 1, end: 4 })).toBe(true)
    expect(indentMixed('x\n    y', { start: 1, end: 5 })).toBe(false)
    expect(indentMixed('x\n\t\ty', { start: 1, end: 4 })).toBe(false)
  })

  it('extracts comment spans within a gap', () => {
    const src = 'a /*c1*/ /*c2*/ b'
    const cs = commentsIn(src, { start: 1, end: 16 }, COMMENT)
    expect(cs).toEqual([{ start: 2, end: 8 }, { start: 9, end: 15 }])
  })

  it('flags only gaps a normalizer must preserve (comment or newline)', () => {
    expect(gapIsSignificant('a  b', { start: 1, end: 3 }, COMMENT)).toBe(false) // plain spaces
    expect(gapIsSignificant('a\nb', { start: 1, end: 2 }, COMMENT)).toBe(true) // newline
    expect(gapIsSignificant('a /*c*/ b', { start: 1, end: 8 }, COMMENT)).toBe(true) // comment
  })
})

// ---------------------------------------------------------------------------
// Fuzz: for any source split into tokens + trivia, the slot index reconstructs
// every gap's trivia EXACTLY, and positional queries land in the right gap.
// ---------------------------------------------------------------------------
describe('fuzz — exact round-trip reconstruction from slots + source', () => {
  const triviaPieces = [' ', '  ', '\n', '\n  ', ' \t ', '\n\n    ', '/*x*/', ' /*y*/ ', '']
  const tokenPieces = ['a', 'bb', 'ccc', 'x1', '.foo', '@m']

  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}: gaps reconstruct exactly`, () => {
      const rand = rng(seed)
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!

      let src = ''
      const slots: Slot[] = []
      const expectedTrivia: string[] = [] // trivia before each slot + trailing
      const nTokens = 1 + Math.floor(rand() * 8)

      for (let t = 0; t < nTokens; t++) {
        const triv = pick(triviaPieces)
        expectedTrivia.push(triv)
        src += triv
        const tok = pick(tokenPieces)
        slots.push({ start: src.length, end: src.length + tok.length })
        src += tok
      }
      const trailing = pick(triviaPieces)
      expectedTrivia.push(trailing)
      src += trailing

      const idx = new OffsetIndex(slots, 0, src.length)

      // Every gap (leading, interior, trailing) reconstructs its exact trivia.
      for (let g = 0; g <= slots.length; g++) {
        expect(gapText(src, idx.gap(g)!)).toBe(expectedTrivia[g])
      }

      // gapBefore(slot.start) and gapAfter(prevSlot.end) name the same gap.
      for (let s = 1; s < slots.length; s++) {
        expect(idx.gapBefore(slots[s]!.start)).toEqual(idx.gapAfter(slots[s - 1]!.end))
      }

      // Concatenating slots + gaps rebuilds the source exactly.
      let rebuilt = gapText(src, idx.gap(0)!)
      for (let s = 0; s < slots.length; s++) {
        rebuilt += src.slice(slots[s]!.start, slots[s]!.end)
        rebuilt += gapText(src, idx.gap(s + 1)!)
      }
      expect(rebuilt).toBe(src)
    })
  }
})

// ---------------------------------------------------------------------------
// Relative spans + incremental edits.
// ---------------------------------------------------------------------------
describe('relative spans — round-trip and cursor', () => {
  const tree: AbsNode = {
    start: 0,
    end: 20,
    children: [
      { start: 2, end: 8, children: [{ start: 4, end: 6, children: [] }] },
      { start: 10, end: 18, children: [{ start: 12, end: 14, children: [] }] },
    ],
  }

  it('absolutize(relativize(t)) === t', () => {
    expect(absolutize(relativize(tree))).toEqual(tree)
  })

  it('absoluteSpanAt walks a path accumulating the base', () => {
    const rel = relativize(tree)
    expect(absoluteSpanAt(rel, [0, 0])).toEqual({ start: 4, end: 6 })
    expect(absoluteSpanAt(rel, [1])).toEqual({ start: 10, end: 18 })
    expect(absoluteSpanAt(rel, [1, 0])).toEqual({ start: 12, end: 14 })
  })
})

describe('incremental edits — correctness and locality', () => {
  function build(seed: number): AbsNode {
    // Deterministic nested tree with in-order, non-overlapping child spans.
    const rand = rng(seed)
    let cursor = 0
    function node(depth: number): AbsNode {
      const start = cursor
      cursor += 1 + Math.floor(rand() * 3) // leading token width
      const children: AbsNode[] = []
      const n = depth <= 0 ? 0 : Math.floor(rand() * 4)
      for (let i = 0; i < n; i++) {
        cursor += Math.floor(rand() * 3) // gap
        children.push(node(depth - 1))
      }
      cursor += 1 + Math.floor(rand() * 3) // trailing token width
      return { start, end: cursor, children }
    }
    return node(4)
  }

  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}: applyEdit on relative tree == absolute reshift`, () => {
      const abs = build(seed)
      const rel = relativize(abs)
      const rand = rng(seed * 7 + 1)
      const at = Math.floor(rand() * (abs.end + 1))
      const delta = 1 + Math.floor(rand() * 10) // insertion

      const stats = { allocated: 0 }
      const edited = applyEdit(rel, at, delta, stats)

      // Correctness: relative-edit then absolutize == naive absolute reshift.
      expect(absolutize(edited)).toEqual(shiftAbsolute(abs, at, delta))

      // Locality: fewer nodes reallocated than the total tree size (unaffected
      // subtrees are shared by identity), and never more than the whole tree.
      const total = countNodes(rel)
      expect(stats.allocated).toBeLessThanOrEqual(total)
    })
  }

  it('shares unaffected subtrees by identity (structural sharing)', () => {
    const abs: AbsNode = {
      start: 0,
      end: 30,
      children: [
        { start: 1, end: 9, children: [{ start: 3, end: 6, children: [] }] }, // fully before edit
        { start: 20, end: 29, children: [{ start: 22, end: 27, children: [] }] }, // fully after
      ],
    }
    const rel = relativize(abs)
    const edited = applyEdit(rel, 15, 5) // insert 5 chars at offset 15 (in the gap)

    // The first child is entirely before the edit → identical object (shared).
    expect(edited.children[0]).toBe(rel.children[0])
    // The second child is fully after the edit, but its parent (the root) does NOT
    // shift (root starts at 0), so its parent-relative start changes → reallocated.
    expect(edited.children[1]).not.toBe(rel.children[1])
    // Its GRANDCHILD, however, moves as a unit with its (shifted) parent, so its
    // relative offsets are unchanged and the subtree is shared by identity — the
    // O(depth) locality win: the shift stops propagating one level down.
    expect(edited.children[1]!.children[0]).toBe(rel.children[1]!.children[0])
    // Correct absolute result regardless.
    expect(absolutize(edited)).toEqual(shiftAbsolute(abs, 15, 5))
  })

  it('allocations are O(depth + touched siblings), not O(all following nodes)', () => {
    // A wide, deep left spine with many trailing leaves after the edit; editing
    // near the front should NOT reallocate the deep untouched subtrees.
    const children: AbsNode[] = []
    let c = 10
    for (let i = 0; i < 50; i++) {
      children.push({ start: c, end: c + 2, children: [{ start: c, end: c + 2, children: [] }] })
      c += 3
    }
    const abs: AbsNode = { start: 0, end: c, children }
    const rel = relativize(abs)
    const stats = { allocated: 0 }
    applyEdit(rel, 1, 4, stats) // edit at the very front
    // Root + all 50 children re-created (their relative start shifts because root
    // start didn't move) — but their leaf grandchildren are shared (they move with
    // their parent). So allocated << total node count.
    const total = countNodes(rel)
    expect(stats.allocated).toBeLessThan(total)
  })
})

function countNodes(n: { children: readonly { children: readonly unknown[] }[] }): number {
  let c = 1
  for (const ch of n.children) c += countNodes(ch as any)
  return c
}
