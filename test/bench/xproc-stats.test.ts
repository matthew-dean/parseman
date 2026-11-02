import { describe, expect, it } from 'vitest'
import { caseVerdict, meanFlipP, mergeShards, signTestP, type VerdictSettings } from '../../bench/xproc-stats.ts'

/** Deterministic generator for the tests (mulberry32, as the gate uses). */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

const choose = (n: number, k: number): number => {
  let c = 1
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1)
  return c
}

describe('signTestP', () => {
  it('is the exact one-sided binomial tail', () => {
    for (const n of [1, 5, 12, 40]) {
      for (let k = 0; k <= n; k++) {
        let want = 0
        for (let i = k; i <= n; i++) want += choose(n, i)
        expect(signTestP(k, n)).toBeCloseTo(want / 2 ** n, 12)
      }
    }
    expect(signTestP(0, 10)).toBe(1)
    expect(signTestP(10, 10)).toBeCloseTo(1 / 1024, 15)
  })
})

describe('meanFlipP', () => {
  it('matches full enumeration of the sign flips on a small sample', () => {
    const d = [0.03, -0.01, 0.02, 0.05, -0.02, 0.04, 0.01, 0.0]
    const observed = d.reduce((a, x) => a + x, 0)
    let hits = 0
    for (let mask = 0; mask < 2 ** d.length; mask++) {
      const s = d.reduce((a, x, i) => a + ((mask >> i) & 1 ? -x : x), 0)
      if (s >= observed - 1e-12) hits++
    }
    const exact = hits / 2 ** d.length
    expect(meanFlipP(d, 200_000, seeded(1))).toBeCloseTo(exact, 2)
  })

  it('is never below 1 / (1 + flips), so it cannot report more certainty than it drew', () => {
    expect(meanFlipP([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 999, seeded(2))).toBeGreaterThanOrEqual(1 / 1000)
  })

  it('holds its level on symmetric noise', () => {
    const rnd = seeded(3)
    let rejections = 0
    const trials = 400
    for (let t = 0; t < trials; t++) {
      const d = Array.from({ length: 60 }, () => (rnd() - 0.5) * 0.1)
      if (meanFlipP(d, 400, rnd) < 0.05) rejections++
    }
    expect(rejections / trials).toBeLessThan(0.09)
  })
})

describe('caseVerdict', () => {
  const S: VerdictSettings = { floorPct: 1, alphaMedian: 0.0005, alphaMean: 0.0005, flips: 20_000 }

  it('fails a uniform slowdown on the median test', () => {
    const rnd = seeded(4)
    const d = Array.from({ length: 150 }, () => Math.log(1.03) + (rnd() - 0.5) * 0.04)
    const v = caseVerdict(d, S, rnd)
    expect(v.failedMedian).toBe(true)
    expect(v.failed).toBe(true)
  })

  it('fails a slowdown that only some rounds carry on the mean test, which the median misses', () => {
    const rnd = seeded(5)
    // One round in five is 20% slower; the rest are identical apart from small noise.
    const d = Array.from({ length: 150 }, (_, i) => (i % 5 === 0 ? Math.log(1.2) : 0) + (rnd() - 0.5) * 0.004)
    const v = caseVerdict(d, S, rnd)
    expect(v.failedMedian).toBe(false)
    expect(v.failedMean).toBe(true)
    expect(v.failed).toBe(true)
  })

  it('passes identical code', () => {
    const rnd = seeded(6)
    const d = Array.from({ length: 150 }, () => (rnd() - 0.5) * 0.08)
    expect(caseVerdict(d, S, rnd).failed).toBe(false)
  })

  it('does not fail a significant change under the floor', () => {
    const rnd = seeded(7)
    const d = Array.from({ length: 300 }, () => Math.log(1.005) + (rnd() - 0.5) * 0.002)
    expect(caseVerdict(d, S, rnd).failed).toBe(false)
  })

  it('refuses empty or non-finite rounds', () => {
    expect(() => caseVerdict([], S, seeded(8))).toThrow('no rounds')
    expect(() => caseVerdict([0.01, Number.NaN], S, seeded(8))).toThrow('non-finite')
    expect(() => caseVerdict([0.01, Number.POSITIVE_INFINITY], S, seeded(8))).toThrow('non-finite')
  })
})

describe('mergeShards fails closed', () => {
  const cases = ['a/x', 'b/y']
  const roundsFor = (id: string): number => (id === 'a/x' ? 2 : 3)
  const shard = (seed: number, over: Record<string, unknown> = {}): { name: string; text: string } => ({
    name: `s${seed}.json`,
    text: JSON.stringify({
      reference: 'abc12345',
      seed,
      logs: { 'a/x': [0.01, -0.01], 'b/y': [0, 0.02, -0.02] },
      minLogs: { 'a/x': [0.01, -0.01], 'b/y': [0, 0.02, -0.02] },
      ...over,
    }),
  })

  it('merges every round of every shard', () => {
    const m = mergeShards([shard(1), shard(2)], 2, 'abc12345', cases, roundsFor)
    expect(m.logs.get('a/x')).toHaveLength(4)
    expect(m.logs.get('b/y')).toHaveLength(6)
    expect(m.seeds).toEqual([1, 2])
  })

  it('fails on a missing shard', () => {
    expect(() => mergeShards([shard(1)], 2, 'abc12345', cases, roundsFor)).toThrow('expected 2 shard files, found 1')
  })

  it('fails on an extra shard, or with no expected count', () => {
    expect(() => mergeShards([shard(1), shard(2), shard(3)], 2, 'abc12345', cases, roundsFor)).toThrow('found 3')
    expect(() => mergeShards([shard(1)], Number.NaN, 'abc12345', cases, roundsFor)).toThrow('positive integer')
  })

  it('fails on a shard measured against another reference', () => {
    expect(() => mergeShards([shard(1, { reference: 'ffff0000' })], 1, 'abc12345', cases, roundsFor)).toThrow('measured against ffff0000')
  })

  it('fails on the wrong number of rounds for a case', () => {
    const short = shard(1, { logs: { 'a/x': [0.01], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([short], 1, 'abc12345', cases, roundsFor)).toThrow('has 1 rounds for a/x, expected 2')
    const missing = shard(1, { logs: { 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([missing], 1, 'abc12345', cases, roundsFor)).toThrow('has 0 rounds for a/x')
  })

  it('fails on null or non-finite values', () => {
    const nul = shard(1, { logs: { 'a/x': [0.01, null], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([nul], 1, 'abc12345', cases, roundsFor)).toThrow('non-finite rounds value for a/x: null')
    const nan = shard(1, { minLogs: { 'a/x': [0.01, 'x'], 'b/y': [0, 0.02, -0.02] } })
    expect(() => mergeShards([nan], 1, 'abc12345', cases, roundsFor)).toThrow('non-finite minima value for a/x')
  })

  it('fails on corrupt JSON, a missing seed, or a repeated seed', () => {
    expect(() => mergeShards([{ name: 'bad.json', text: '{' }], 1, 'abc12345', cases, roundsFor)).toThrow('bad.json is not JSON')
    expect(() => mergeShards([shard(1, { seed: undefined })], 1, 'abc12345', cases, roundsFor)).toThrow('has no seed')
    expect(() => mergeShards([shard(1), shard(1)], 2, 'abc12345', cases, roundsFor)).toThrow('repeats seed 1')
  })
})
