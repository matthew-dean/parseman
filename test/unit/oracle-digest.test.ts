import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CanonicalBudgetError,
  canonicalize,
  digestInto,
  digestValue,
} from '../../src/oracle/index.ts'

/**
 * The streamed digest and the materialised string are the SAME byte sequence.
 *
 * This is the safety property that lets the digest be streamed at all: every
 * digest anyone has ever recorded was taken over `hash(prefix + canonicalize(v))`,
 * and if streaming produced different bytes for any value, every committed
 * baseline in every consumer would silently become unreproducible. So the
 * equality is asserted directly, over the same value shapes the harness canary
 * covers — scalars, absent-vs-undefined, key order, collections, class tags,
 * SHARING, cycles, awkward text, callables.
 */
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

class Tagged {
  readonly x: number

  constructor(x: number) {
    this.x = x
  }
}

const shared = { shared: true }
const cyclic: Record<string, unknown> = { name: 'root' }
cyclic.self = cyclic
cyclic.child = { up: cyclic }

const SHAPES: Array<[string, unknown]> = [
  ['scalars', [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10n, true, false, null]],
  ['absent', [{ a: undefined }, {}, { a: null }, [undefined], []]],
  ['key-order', [{ a: 1, b: 2 }, { b: 2, a: 1 }]],
  ['collections', [new Map([['k', 1], ['j', 2]]), new Set([1, 2]), new Date(0), /ab+c/giu]],
  ['tagged', [new Tagged(1), { x: 1 }]],
  ['sharing', { left: shared, right: shared }],
  ['cycle', cyclic],
  // Includes an embedded NUL — the token separator — to prove the escaping holds.
  ['text', ['', `a${String.fromCharCode(0)}b`, 'a b', '"quoted"', '\\', 'emoji \u{1F600} tail', 'é中']],
  ['callable', [function named() {}, Symbol('sym')]],
  ['empty-string', ''],
  ['bare-null', null],
  ['bare-undefined', undefined],
]

describe('streamed digest reproduces the materialised one', () => {
  for (const [name, value] of SHAPES) {
    it(`agrees with hash(canonicalize(...)) for ${name}`, () => {
      expect(digestValue(value)).toBe(sha(canonicalize(value)))
    })

    it(`agrees with the OK:/ERR: discriminator applied for ${name}`, () => {
      expect(digestValue(value, 'OK:')).toBe(sha(`OK:${canonicalize(value)}`))
      expect(digestValue(value, 'ERR:')).toBe(sha(`ERR:${canonicalize(value)}`))
    })
  }

  it('keeps the discriminator spaces disjoint', () => {
    expect(digestValue({ a: 1 }, 'OK:')).not.toBe(digestValue({ a: 1 }, 'ERR:'))
  })

  it('never materialises the projection — a value past the max string length still digests', () => {
    /*
     * Ten levels of two-way sharing over a big leaf: the projection writes the
     * leaf 2^10 times, so the canonical STRING is ~614M chars and exceeds V8's
     * maximum string length (2^29-24). The string form cannot answer at all —
     * and, before this change, that `RangeError` was caught and recorded as a
     * parse error. Streamed, the same bytes hash fine.
     */
    let node: unknown = { leaf: 'x'.repeat(600_000) }
    for (let level = 0; level < 10; level++) node = { left: node, right: node }
    expect(() => canonicalize(node)).toThrow(RangeError)
    expect(digestValue(node)).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it('lets the caller own the hash', () => {
    const chunks: string[] = []
    digestInto({ update: chunk => void chunks.push(chunk) }, { a: [1, 2], b: 'x' })
    expect(chunks.join('')).toBe(canonicalize({ a: [1, 2], b: 'x' }))
  })

  it('flushes in blocks without changing the bytes', () => {
    const big = { items: Array.from({ length: 20_000 }, (_, n) => ({ n, label: `item-${n}` })) }
    const chunks: string[] = []
    digestInto({ update: chunk => void chunks.push(chunk) }, big, 'OK:')
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(`OK:${canonicalize(big)}`)
  })

  /*
   * The hazard the block flush exists to avoid, exercised with the characters
   * that can actually trigger it.
   *
   * A `crypto.Hash` encodes each `update(string)` to UTF-8 INDEPENDENTLY. Split a
   * surrogate pair across two calls and each half encodes as its own replacement
   * sequence — three bytes each, six in total, where the joined string would have
   * encoded four. The digest then silently differs from the one taken over the
   * materialised projection, and every recorded baseline containing an emoji or
   * an astral CJK character becomes unreproducible.
   *
   * The ASCII flush test above cannot see any of this: with only single-unit
   * characters there is no pair to split. So these labels are astral, sized so
   * the buffer boundary lands mid-label, and the assertion is at the BYTE level
   * rather than on the string — a lone surrogate compares equal as a JS string to
   * itself while encoding to entirely different bytes.
   */
  it('never splits an astral character across a flush boundary', () => {
    // 2 UTF-16 units each; U+1F600 and U+2A6B2 (CJK extension B).
    const astral = '\u{1F600}\u{2A6B2}'
    // Long enough to cross the 64Ki flush threshold several times, and NOT a
    // whole multiple of it, so a boundary lands inside a label rather than
    // conveniently between two.
    const big = {
      items: Array.from({ length: 4_000 }, (_, n) => ({ n, label: `${astral.repeat(7)}${n}` })),
    }

    const chunks: string[] = []
    digestInto({ update: chunk => void chunks.push(chunk) }, big, 'OK:')
    expect(chunks.length).toBeGreaterThan(1)

    // No chunk may end on a high surrogate or begin on a low one — that is the
    // split, stated directly.
    for (const chunk of chunks) {
      const first = chunk.charCodeAt(0)
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }

    // The bytes a hash actually absorbs, per chunk, are the bytes of the whole.
    const joined = `OK:${canonicalize(big)}`
    expect(Buffer.concat(chunks.map(c => Buffer.from(c, 'utf8'))).equals(Buffer.from(joined, 'utf8'))).toBe(true)

    // And therefore the streamed digest is the non-streamed one.
    expect(digestValue(big, 'OK:')).toBe(sha(joined))
  })
})

/**
 * `digestInto` writes at a target the CALLER owns, and that ownership has two
 * consequences worth a failing test rather than a paragraph nobody reads.
 */
describe('digestInto is a stream, with a stream’s sharp edges', () => {
  it('leaves a partially written target behind when the walk throws', () => {
    const chunks: string[] = []
    const target = { update: (chunk: string) => void chunks.push(chunk) }
    // Keys are walked in sorted order, so the big `a` flushes several blocks at
    // the target before `z` gives up.
    const items = Array.from({ length: 20_000 }, (_, n) => `item-${n}`)
    const poisoned = {
      a: items,
      get z(): never {
        throw new Error('mid-walk')
      },
    }

    expect(() => digestInto(target, poisoned)).toThrow(/mid-walk/)
    // Not "nothing was written" — an arbitrary PREFIX of the projection was, and
    // a hash cannot be rewound. The documented remedy is to discard the target.
    const written = chunks.join('')
    expect(written).not.toBe('')
    expect(canonicalize({ a: items, z: 0 }).startsWith(written)).toBe(true)
  })

  /*
   * Two calls against one target concatenate with NO delimiter, so the byte
   * stream does not record where one value ended and the next began. A
   * differently-split sequence can therefore produce the identical digest.
   *
   * This is asserted as a HAZARD, not as a desirable property: fixing it means
   * putting a separator at the seam, which changes the bytes for every caller who
   * already digests a sequence this way and moves digests they have recorded.
   * That is a DIGEST_FORMAT decision, so the behaviour is documented on
   * `digestInto` and pinned here — if it ever changes, this test says so.
   */
  it('concatenates consecutive calls with no delimiter, so a differently split pair collides', () => {
    const twoCalls = createHash('sha256')
    digestInto(twoCalls, 1)
    digestInto(twoCalls, 2)

    // One call over `2`, with `#1` as the prefix, writes the identical stream.
    expect(twoCalls.digest('hex')).toBe(digestValue(2, '#1'))

    // Stated the other way: the seam carries nothing at all.
    const raw: string[] = []
    const target = { update: (chunk: string) => void raw.push(chunk) }
    digestInto(target, { a: 1 })
    digestInto(target, { b: 2 })
    expect(raw.join('')).toBe(`${canonicalize({ a: 1 })}${canonicalize({ b: 2 })}`)
  })
})

/**
 * A budget that cannot be spent is not a budget.
 *
 * `--visits < 0` is FALSE forever when `visits` is `NaN`, and never reached when
 * it is `Infinity`. So `maxVisits: NaN` did not raise the ceiling, it removed it,
 * and the walk ran unbounded into precisely the OOM the budget was added to
 * prevent — reachable by passing one bad number.
 */
describe('the visit budget rejects a budget it could not enforce', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, 2 ** 60]) {
    it(`refuses maxVisits: ${String(bad)}`, () => {
      expect(() => digestValue({ a: 1 }, '', { maxVisits: bad })).toThrow(RangeError)
      expect(() => digestValue({ a: 1 }, '', { maxVisits: bad })).toThrow(/maxVisits/)
      expect(() => canonicalize({ a: 1 }, { maxVisits: bad })).toThrow(RangeError)
      expect(() => digestInto(createHash('sha256'), { a: 1 }, '', { maxVisits: bad })).toThrow(RangeError)
    })
  }

  it('names the offending value so the caller can see what it passed', () => {
    expect(() => digestValue({ a: 1 }, '', { maxVisits: Number.NaN })).toThrow(/received NaN/)
  })

  it('still ENFORCES a valid finite budget rather than merely accepting it', () => {
    let node: unknown = { leaf: 1 }
    for (let level = 0; level < 40; level++) node = { left: node, right: node }
    expect(() => digestValue(node, '', { maxVisits: 5_000 })).toThrow(CanonicalBudgetError)
  })

  it('accepts 0 and refuses the first object visit with it', () => {
    expect(() => digestValue({ a: 1 }, '', { maxVisits: 0 })).toThrow(CanonicalBudgetError)
    // A scalar visits no objects, so it still digests under a zero budget.
    expect(digestValue(1, '', { maxVisits: 0 })).toBe(digestValue(1))
  })

  it('leaves an omitted budget on the default', () => {
    expect(digestValue({ a: 1 }, '', {})).toBe(digestValue({ a: 1 }))
    expect(digestValue({ a: 1 }, '', { maxVisits: undefined })).toBe(digestValue({ a: 1 }))
  })
})

describe('visit budget', () => {
  it('does not alter the digest of anything that finishes under it', () => {
    const value = { a: [1, 2, 3], b: { c: new Map([['k', 1]]) } }
    expect(digestValue(value, 'OK:', { maxVisits: 1000 })).toBe(digestValue(value, 'OK:'))
  })

  it('refuses an exponential unroll with a NAMED error rather than an OOM', () => {
    let node: unknown = { leaf: 1 }
    for (let level = 0; level < 40; level++) node = { left: node, right: node }
    expect(() => digestValue(node, '', { maxVisits: 100_000 })).toThrow(CanonicalBudgetError)
    expect(() => digestValue(node, '', { maxVisits: 100_000 })).toThrow(/DAG being unrolled/)
  })
})

/**
 * A projection failure RAISES. It never comes back as a digest.
 *
 * A caller's harness classifies a parse that threw as a fact about the grammar,
 * and it is entitled to assume that anything this module RETURNS is a digest of
 * something. If the projection could give up and hand back a value anyway, the
 * tool's own breakage would arrive on the caller's grammar channel — the single
 * distinction such a gate exists to make. So it throws a named error and leaves
 * the classification to nobody.
 */
describe('a digest failure raises rather than returning a value', () => {
  it('refuses a DAG that exceeds the visit budget', () => {
    let node: unknown = { leaf: 1 }
    for (let level = 0; level < 40; level++) node = { left: node, right: node }
    expect(() => digestValue(node, 'OK:', { maxVisits: 10_000 })).toThrow(CanonicalBudgetError)
    expect(() => digestInto(createHash('sha256'), node, 'OK:', { maxVisits: 10_000 }))
      .toThrow(CanonicalBudgetError)
  })

  it('digests a value that fits the budget, prefix and all', () => {
    const budgeted = digestValue({ leaf: 1 }, 'ERR:', { maxVisits: 10_000 })
    expect(budgeted).toBe(digestValue({ leaf: 1 }, 'ERR:'))
    expect(budgeted).not.toBe(digestValue({ leaf: 1 }, 'OK:'))
  })
})
