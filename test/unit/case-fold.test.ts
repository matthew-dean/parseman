/**
 * `caseFoldVariants` is the first-set widening for case-INSENSITIVE matchers, so
 * it carries a soundness obligation: for every input char the matcher would
 * accept as a first char, that char must be in the set. Under-approximate it and
 * `choice` dispatches valid input away from the arm that would have matched.
 *
 * These tests check the model against the REGEX ENGINE ITSELF rather than against
 * a restatement of the model: a `/gi` scan over a string of every BMP code point
 * yields the engine's true fold class for a probe char in one pass, with no
 * appeal to `toUpperCase` — the very function the model is built from.
 */
import { describe, it, expect } from 'vitest'
import { caseFoldVariants } from '../../src/combinators/case-fold.ts'

/** Every BMP code point except the surrogate range, and the same as one string. */
const CPS: number[] = []
for (let i = 0; i < 0x10000; i++) {
  if (i >= 0xd800 && i <= 0xdfff) continue
  CPS.push(i)
}
const ALL = CPS.map(c => String.fromCharCode(c)).join('')

/** The engine's OWN fold class for `cp`: every BMP char that `/cp/i` matches. */
function engineClass(cp: number): number[] {
  const re = new RegExp('\\u' + cp.toString(16).padStart(4, '0'), 'gi')
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(ALL)) !== null) out.push(CPS[m.index]!)
  return out.sort((a, b) => a - b)
}

const sorted = (cp: number): number[] => [...caseFoldVariants(cp)].sort((a, b) => a - b)

/** `engineClass` memoized — the exhaustive sweep asks for the same class twice. */
const engineClassCache = new Map<number, number[]>()
function classOf(cp: number): number[] {
  let c = engineClassCache.get(cp)
  if (!c) { c = engineClass(cp); engineClassCache.set(cp, c) }
  return c
}

describe('caseFoldVariants — non-Unicode /i fold classes', () => {
  it('ASCII letters fold to exactly their twin, and non-letters to themselves', () => {
    expect(sorted(0x61)).toEqual([0x41, 0x61])     // a ↔ A
    expect(sorted(0x5a)).toEqual([0x5a, 0x7a])     // Z ↔ z
    expect(sorted(0x40)).toEqual([0x40])           // @ has no case
    expect(sorted(0x39)).toEqual([0x39])           // 9
  })

  it('REFUSES cross-boundary folds in both directions', () => {
    // `/s/i` does not match `ſ` (U+017F) and `/k/i` does not match `K` (U+212A):
    // a fold that would move a non-ASCII char into Basic Latin is refused. This is
    // what keeps an all-ASCII keyword set's first-set tight.
    expect(sorted(0x73)).toEqual([0x53, 0x73])     // s ↔ S only — no ſ
    expect(sorted(0x6b)).toEqual([0x4b, 0x6b])     // k ↔ K only — no U+212A
    expect(sorted(0x17f)).toEqual([0x17f])         // ſ stands alone
    expect(sorted(0x212a)).toEqual([0x212a])       // KELVIN SIGN stands alone
    expect(/s/i.test('ſ')).toBe(false)
    expect(/ſ/i.test('s')).toBe(false)
  })

  it('folds non-ASCII pairs that stay on one side of the boundary', () => {
    expect(sorted(0xe4)).toEqual([0xc4, 0xe4])     // ä ↔ Ä
    expect(/ärger/i.test('Ärger')).toBe(true) // the matcher really does fold it
  })

  it('covers fold classes WIDER than {c, toUpperCase(c), toLowerCase(c)}', () => {
    // The classes that make upper/lower widening unsound. Final sigma is in σ's
    // class but is neither its upper- nor its lowercase.
    expect(sorted(0x3c3)).toEqual([0x3a3, 0x3c2, 0x3c3])   // σ Σ ς
    expect('σ'.toUpperCase()).toBe('Σ')
    expect('σ'.toLowerCase()).toBe('σ')          // ς unreachable from either
    expect(sorted(0xb5)).toEqual([0xb5, 0x39c, 0x3bc])     // µ MICRO ↔ Μ ↔ μ
    expect(sorted(0x1c5)).toEqual([0x1c4, 0x1c5, 0x1c6])   // Ǆ ǅ ǆ titlecase digraph
    expect(sorted(0x345)).toEqual([0x345, 0x399, 0x3b9, 0x1fbe])  // iota subscript ↔ Ι ↔ ι
  })

  it('does not fold a char whose uppercase EXPANDS (ß → SS)', () => {
    // A multi-char fold is not a single-char canonicalization, so ß is its own
    // class. Taking codePointAt(0) of 'SS' would have wrongly pulled in 'S'.
    expect(sorted(0xdf)).toEqual([0xdf])
    expect('ß'.toUpperCase()).toBe('SS')
    expect(/ß/i.test('S')).toBe(false)
  })

  it('leaves astral code points alone (non-Unicode mode never folds them)', () => {
    expect(sorted(0x10400)).toEqual([0x10400])     // DESERET CAPITAL LONG I
  })

  it('EXHAUSTIVE: the multi-member classes are EXACTLY the engine\'s own', () => {
    // Which code points fold at all is UNICODE-VERSION dependent — Node 22 counts
    // 2313 of them, Node 24 counts 2307 — so a hardcoded total pins the test to one
    // ICU build and fails on the other (it did: green locally, red on CI's Node 22).
    // Derive the engine's own set in the SAME process instead, and assert exact set
    // equality rather than a count. That also closes the direction a count never
    // covered: a class the ENGINE folds but the model left singleton — the UNSOUND
    // direction, which until now was only sampled (strided) by the test below.

    // Candidate superset. A char the engine folds has a case mapping of its own...
    const candidates = CPS.filter(cp => {
      const ch = String.fromCharCode(cp)
      return ch.toUpperCase() !== ch || ch.toLowerCase() !== ch || sorted(cp).length > 1
    })
    // ...but it can also be only the TARGET of a fold (canonicalize maps the other
    // char onto it while its own maps are identity), so take the UNION of the
    // candidates' engine classes, not the candidates themselves.
    const engineMulti = new Set<number>()
    for (const cp of candidates) {
      const cls = classOf(cp)
      if (cls.length > 1) for (const member of cls) engineMulti.add(member)
    }

    const modelMulti = new Set<number>()
    for (const cp of CPS) {
      const mine = sorted(cp)
      if (mine.length < 2) continue
      expect(mine, `class of U+${cp.toString(16)}`).toEqual(classOf(cp))
      modelMulti.add(cp)
    }

    const asc = (s: Set<number>): number[] => [...s].sort((a, b) => a - b)
    expect(asc(modelMulti)).toEqual(asc(engineMulti))
  })

  it('EXHAUSTIVE (strided): never UNDER-approximates a singleton class', () => {
    // The unsound direction: a char the engine folds in that we left out. Strided
    // rather than full-sweep to keep the suite fast — the full 63,488-code-point
    // sweep also reports zero under-approximations.
    for (let i = 0; i < CPS.length; i += 31) {
      const cp = CPS[i]!
      const mine = new Set(caseFoldVariants(cp))
      for (const e of engineClass(cp)) {
        expect(mine.has(e), `U+${cp.toString(16)} is missing U+${e.toString(16)}`).toBe(true)
      }
    }
  })
})
