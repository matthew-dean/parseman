import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  CanonicalBudgetError,
  canonicalize,
  digestCorpus,
  digestInto,
  digestValue,
  type CorpusEntry,
  type Surface,
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
 * A projection failure is NOT a parse failure.
 *
 * This is the soundness hole the streaming work closed. `payload` used to digest
 * inside the same `try` that guarded the parse, so a `RangeError` from joining an
 * over-long canonical string — or any other way the projection could give up —
 * was caught, recorded as `ERR:`, and counted in `threw`. The gate then reported
 * its own breakage as a grammar change, which is the single distinction it exists
 * to make.
 */
describe('a digest failure never masquerades as a parse failure', () => {
  const corpus: CorpusEntry[] = [{ id: 'a', source: 'a' }]

  it('propagates a budget refusal instead of counting it in threw', () => {
    let node: unknown = { leaf: 1 }
    for (let level = 0; level < 40; level++) node = { left: node, right: node }
    const surface: Surface = { name: 's', parse: () => node }
    expect(() => digestCorpus([surface], corpus, { maxVisits: 10_000 })).toThrow(CanonicalBudgetError)
  })

  it('still counts a genuine parse throw in threw', () => {
    const surface: Surface = {
      name: 's',
      parse: () => {
        throw new TypeError('genuinely rejected')
      },
    }
    const report = digestCorpus([surface], corpus)
    expect(report.surfaces[0]!.threw).toBe(1)
  })
})
