/**
 * How a first set's ranges answer for an input's leading code point (`lead()`).
 * A leaf module: the minimal run entry reaches it through recovery sentinels.
 */
import type { CharRange } from './types.ts'

/**
 * Whether `ranges` admit the astral lead `code` (above U+FFFF) through its high
 * surrogate. Outside Unicode mode a regex reads code units, so a set holding a
 * high surrogate starts every astral code point that surrogate begins: a lead
 * test reads an astral lead through it once the code point itself misses. Exact
 * for such a set; for a `u` set holding a lone high surrogate it only
 * over-approximates.
 */
export function astralLeadViaSurrogate(ranges: readonly CharRange[], code: number): boolean {
  const high = 0xd800 + ((code - 0x10000) >> 10)
  for (const r of ranges) if (high >= r.lo && high <= r.hi) return true
  return false
}

/** `ranges` with the astral code points `astralLeadViaSurrogate` admits through their
 * high surrogates, for a test that reads a lead by range alone. */
export function leadRanges(ranges: readonly CharRange[]): readonly CharRange[] {
  let out: CharRange[] | undefined
  for (const r of ranges) {
    const lo = Math.max(r.lo, 0xd800), hi = Math.min(r.hi, 0xdbff)
    if (lo <= hi) (out ??= [...ranges]).push({ lo: 0x10000 + ((lo - 0xd800) << 10), hi: 0x10000 + ((hi - 0xd800) << 10) + 0x3ff })
  }
  return out ?? ranges
}
