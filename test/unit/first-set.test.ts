/**
 * src/combinators/first-set.ts is only ever exercised INDIRECTLY today (via
 * choice.ts's disjoint-dispatch computation and friends) — no test imports it
 * directly, so several of its own branches (the 'empty'/'any' short-circuits
 * in union()/intersects(), and the plain range-merge path) were never hit on
 * their own terms. These tests call the module's functions directly.
 */
import { describe, it, expect } from 'vitest'
import { union, intersects, fromChar, fromRange, any, empty, sequenceFirstSet, firstSetOf, isZeroWidthAssertion } from '../../src/combinators/first-set.ts'
import { sequence, not, optional, many, oneOrMore, literal, regex, choice } from '../../src/index.ts'
import type { Combinator, FirstSet } from '../../src/types.ts'

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

describe('first-set — leading zero-width assertion (not) does not poison the sequence', () => {
  it('isZeroWidthAssertion is true only for not()', () => {
    expect(isZeroWidthAssertion(not(literal('x')))).toBe(true)
    expect(isZeroWidthAssertion(literal('x'))).toBe(false)
    expect(isZeroWidthAssertion(optional(literal('x')))).toBe(false)
    expect(isZeroWidthAssertion(regex(/@/))).toBe(false)
  })

  it('sequence(not("@-"), @name) has first-set {@}, not any (the jess DirectJessOpaqueAtRuleBlock shape)', () => {
    const atName = regex(/@[a-zA-Z-]+/)
    const seq = sequence(not(literal('@-')), atName)
    // Was `{ kind: 'any' }` before the fix — the `not`'s any() poisoned the union.
    expect(seq._meta.firstSet).toEqual({ kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] })
    expect(sequenceFirstSet([not(literal('@-')), atName])).toEqual({ kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] })
    expect(firstSetOf(seq)).toEqual({ kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] })
  })

  it('a bare not() as the whole sequence stays nullable → first-set stays empty/any (never gated)', () => {
    // `not` alone contributes nothing and is nullable, so the loop runs to the end
    // with an empty accumulator. Harmless: a nullable sequence is never gated.
    expect(sequenceFirstSet([not(literal('x'))])).toEqual({ kind: 'empty' })
  })

  it('several leading assertions then a consumer: first-set is the consumer only', () => {
    const seq = sequence(not(literal('@-')), not(literal('@@')), regex(/@[a-z]+/))
    expect(seq._meta.firstSet).toEqual({ kind: 'ranges', ranges: [{ lo: 64, hi: 64 }] })
  })

  it('a leading OPTIONAL still contributes (it can consume) — assertion skip must not over-fire', () => {
    // optional(a) is nullable but CAN consume, so `a`'s first char is a real start.
    const seq = sequence(optional(literal('a')), literal('b'))
    const fs = seq._meta.firstSet as Extract<FirstSet, { kind: 'ranges' }>
    expect(fs.kind).toBe('ranges')
    const codes = fs.ranges.flatMap(r => Array.from({ length: r.hi - r.lo + 1 }, (_, i) => r.lo + i))
    expect(codes).toContain('a'.charCodeAt(0))
    expect(codes).toContain('b'.charCodeAt(0))
  })
})

// ─── Soundness fuzz: a dispatch-gating first-set must be a SUPERSET of the true set ───
//
// The load-bearing property: for EVERY input the parser matches consuming ≥1 char,
// that input's first code point MUST be in the computed first-set (or the set is
// `any`). If a computed set ever EXCLUDES a real first char, first-char dispatch
// would skip a valid arm = a matching bug. We generate randomized grammars that
// exercise the leading-assertion path (and the pre-existing nullable-prefix path)
// and empirically confirm 0 false-excludes.
describe('first-set — soundness fuzz (superset over randomized grammars)', () => {
  const ALPHABET = ['@', '-', 'a', 'b', 'c', '1', '#', '.', ' ']

  function inFirstSet(fs: FirstSet, code: number): boolean {
    if (fs.kind === 'any') return true
    if (fs.kind === 'empty') return false
    return fs.ranges.some(r => code >= r.lo && code <= r.hi)
  }

  // Deterministic small PRNG so a failure is reproducible from the seed.
  function makeRng(seed: number): () => number {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
  }

  function randLeaf(rng: () => number): Combinator<unknown> {
    const ch = ALPHABET[Math.floor(rng() * ALPHABET.length)]!
    const k = rng()
    if (k < 0.34) return literal(ch)
    if (k < 0.67) return regex(new RegExp(`[${ch === '-' || ch === '#' || ch === '.' ? '\\' + ch : ch}a-c]`))
    return regex(new RegExp(`${ch === '-' || ch === '#' || ch === '.' ? '\\' + ch : ch}`))
  }

  function randTerm(rng: () => number, depth: number): Combinator<unknown> {
    const k = rng()
    if (depth <= 0) return randLeaf(rng)
    if (k < 0.25) return not(randTerm(rng, depth - 1))
    if (k < 0.45) return optional(randTerm(rng, depth - 1))
    if (k < 0.60) return many(randTerm(rng, depth - 1))
    if (k < 0.72) return oneOrMore(randTerm(rng, depth - 1))
    if (k < 0.84) return choice(randLeaf(rng), randLeaf(rng))
    return randLeaf(rng)
  }

  function randSequence(rng: () => number): Combinator<unknown> {
    const n = 1 + Math.floor(rng() * 4)
    const terms: Combinator<unknown>[] = []
    // Bias the FIRST term toward an assertion so we hammer the fixed path.
    terms.push(rng() < 0.6 ? not(randTerm(rng, 2)) : randTerm(rng, 2))
    for (let i = 1; i < n; i++) terms.push(randTerm(rng, 2))
    return sequence(...(terms as [Combinator<unknown>, ...Combinator<unknown>[]]))
  }

  function randInput(rng: () => number): string {
    const n = Math.floor(rng() * 5)
    let s = ''
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)]!
    return s
  }

  it('0 false-excludes over 200 grammars × 400 inputs (meta first-set)', () => {
    let checked = 0
    let matched = 0
    const violations: string[] = []
    for (let g = 0; g < 200; g++) {
      const rng = makeRng(0x9e3779b1 ^ (g * 2654435761))
      const seq = randSequence(rng)
      const metaFs = seq._meta.firstSet
      const deepFs = firstSetOf(seq)
      for (let t = 0; t < 400; t++) {
        const input = randInput(rng)
        // No trivia context — pure structural match, pos 0.
        const res = seq.parse(input, 0, { trivia: undefined } as never)
        if (res.ok && res.span.end > res.span.start) {
          matched++
          const code = input.codePointAt(0)!
          if (!inFirstSet(metaFs, code)) violations.push(`meta: grammar#${g} input=${JSON.stringify(input)} code=${code} fs=${JSON.stringify(metaFs)}`)
          if (!inFirstSet(deepFs, code)) violations.push(`deep: grammar#${g} input=${JSON.stringify(input)} code=${code} fs=${JSON.stringify(deepFs)}`)
        }
        checked++
      }
    }
    // Sanity: the corpus actually exercises real matches (not a vacuous pass).
    expect(matched).toBeGreaterThan(100)
    expect(checked).toBeGreaterThan(50000)
    expect(violations.slice(0, 10)).toEqual([])
  })
})
