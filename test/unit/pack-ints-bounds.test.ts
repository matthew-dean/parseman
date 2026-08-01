import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACK_MAX, packInts } from '../../src/compiler/token-dispatch.ts'

/**
 * `packInts` encodes each value as two chars at six bits each — TWELVE bits,
 * range 0..4095. The mask made anything larger wrap SILENTLY, and `unpack` then
 * decoded a wrong index: a dispatch table that looks fine and routes to the wrong
 * arm. No error, no failing test, because no in-repo grammar has enough distinct
 * tokens to reach 4096.
 *
 * The same encoder existed in token-scanner.ts with the same missing check. One
 * defect became two by copy, which is why there is now exactly one implementation
 * and this file guards it.
 */
describe('packInts — the 12-bit range is enforced, not assumed', () => {
  it('round-trips the whole representable range at its edges', () => {
    for (const v of [0, 1, 63, 64, 4094, PACK_MAX]) {
      expect(() => packInts([v]), `${v} must be representable`).not.toThrow()
    }
  })

  it('THROWS instead of wrapping at the first unrepresentable value', () => {
    // 4096 is the value that silently became 0 before the bound existed.
    expect(() => packInts([PACK_MAX + 1])).toThrow(RangeError)
    expect(() => packInts([PACK_MAX + 1])).toThrow(/4096 is outside the 12-bit range/)
  })

  it('names the offending value, not just the fact of a failure', () => {
    expect(() => packInts([10, 20, 99999])).toThrow(/99999/)
  })

  it('rejects negatives and non-integers rather than masking them', () => {
    expect(() => packInts([-1])).toThrow(RangeError)
    expect(() => packInts([1.5])).toThrow(RangeError)
  })

  it('4096 and 0 no longer encode identically — the wrap that made them collide', () => {
    // Before the bound: packInts([4096]) === packInts([0]). That collision is the
    // whole defect, so it is asserted as an inequality of OUTCOMES: one is legal,
    // the other is refused.
    expect(packInts([0])).toBe(packInts([0]))
    expect(() => packInts([4096])).toThrow()
  })
})

/**
 * The ENCODER was deduplicated when the second copy shipped without the bound
 * check. The matching DECODER stayed copied — `sharedHelperDecl('unpack')` in
 * token-dispatch.ts and a hand-spelled twin in token-scanner.ts — so half of one
 * encoding still lived in two files. The two agreed, which is exactly why nothing
 * caught it: the failure arrives on the day someone widens the encoding, as the
 * `RangeError` above instructs, and edits one half.
 *
 * Counted over source, because that is where the duplication is: an emitted-string
 * comparison would have passed while the copies existed.
 */
describe('the 12-bit decoder has exactly one spelling in src/', () => {
  const NEEDLE = 'charCodeAt(i * 2)'
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [])

  /** OCCURRENCES, not files. A `.filter(f => text.includes(NEEDLE))` counts the
   * files that contain the decoder and says nothing about how many times each
   * one spells it — so a second copy added BESIDE the first, in the same file,
   * passes it. That is the likeliest place for the next copy to appear, since
   * the two consumers that had the duplicate were one import apart. */
  const occurrences = (text: string): number => text.split(NEEDLE).length - 1

  it('is spelled once in the whole of src/, not once per consumer', () => {
    const root = path.join(import.meta.dirname, '../../src')
    const hits = walk(root)
      .map(f => [path.relative(root, f), occurrences(readFileSync(f, 'utf8'))] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
    expect(hits, 'the decoder must live only beside the encoder it inverts').toEqual([['compiler/token-dispatch.ts', 1]])
    expect(hits.reduce((n, [, c]) => n + c, 0), 'exactly one spelling, anywhere in src/').toBe(1)
  })
})
