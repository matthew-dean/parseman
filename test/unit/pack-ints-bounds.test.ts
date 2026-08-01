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
