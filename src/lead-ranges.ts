/**
 * How a first set's ranges answer for an input's leading code point (`lead()`).
 * A leaf module: the minimal run entry reaches it through recovery sentinels.
 */
import type { CharRange } from './types.ts'

/**
 * Whether `ranges` admit an input led by the code point `code`: in a range, or,
 * for an astral lead, through its high surrogate. Outside Unicode mode a regex
 * reads code units, so a set holding a high surrogate starts every astral code
 * point that surrogate begins. Exact for such a set; for a `u` set holding a
 * lone high surrogate it only over-approximates.
 *
 * The interpreter's two hot lead tests (`startsFirstSet`, choice `inFirstSet`)
 * repeat this body inline: called, it costs them about 6% of the instructions per
 * parse, measured on the CSS example.
 */
export function rangesHaveLead(ranges: readonly CharRange[], code: number): boolean {
  for (const r of ranges) if (code >= r.lo && code <= r.hi) return true
  if (code <= 0xffff) return false
  const high = 0xd800 + ((code - 0x10000) >> 10)
  for (const r of ranges) if (high >= r.lo && high <= r.hi) return true
  return false
}

/** `ranges` with the astral code points `rangesHaveLead` admits through their
 * high surrogates, for a test that reads a lead by range alone. */
export function leadRanges(ranges: readonly CharRange[]): readonly CharRange[] {
  let out: CharRange[] | undefined
  for (const r of ranges) {
    const lo = Math.max(r.lo, 0xd800), hi = Math.min(r.hi, 0xdbff)
    if (lo <= hi) (out ??= [...ranges]).push({ lo: 0x10000 + ((lo - 0xd800) << 10), hi: 0x10000 + ((hi - 0xd800) << 10) + 0x3ff })
  }
  return out ?? ranges
}

/** The inverse of `leadRanges`: drop the astral code points that `ranges`' own high
 * surrogates already admit, so a set read through `leadRanges` (an intersection)
 * keeps the code-unit form a table encodes narrowly. `leadRanges` of the result
 * equals `leadRanges` of the input. */
export function implicitLeadsDropped(ranges: readonly CharRange[]): CharRange[] {
  const implied = leadRanges(ranges.filter(r => r.lo <= 0xffff)).filter(r => r.lo > 0xffff)
  const out: CharRange[] = []
  for (const r of ranges) {
    let pieces: CharRange[] = [{ lo: r.lo, hi: r.hi }]
    if (r.hi > 0xffff) for (const c of implied) {
      pieces = pieces.flatMap(q => q.hi < c.lo || q.lo > c.hi ? [q]
        : [...(q.lo < c.lo ? [{ lo: q.lo, hi: c.lo - 1 }] : []), ...(q.hi > c.hi ? [{ lo: c.hi + 1, hi: q.hi }] : [])])
    }
    out.push(...pieces)
  }
  return out
}
