import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copySamples,
  interleave,
  pairedMedianDelta,
  pairedMedianRatio,
  score,
  type Calibration,
  type Samples,
  type Thresholds,
} from '../../bench/ab-harness.ts'

afterEach(() => { vi.restoreAllMocks() })

const T: Thresholds = {
  medianPct: 5,
  minPct: 5,
  winRateCeiling: 0.5,
  signTest: { winRateCeiling: 0.5, medianPct: 5, minPct: 5 },
}

const K: Calibration = {
  wins: 0,
  pairs: 5,
  nullRate: 0.5,
  ceiling: 0.5,
  signCeiling: 0.5,
  worstNullMedian: 0,
}

function samples(ref: number[], head: number[], refMin = ref, headMin = head): Samples {
  const out = new Map<string, number[]>([['ref|drift', ref], ['head|drift', head]]) as Samples
  out.mins = new Map([['ref|drift', refMin], ['head|drift', headMin]])
  return out
}

describe('paired A/B scoring', () => {
  it('reduces aligned ratios instead of a ratio of drifted aggregates', () => {
    const ref = [20, 70, 21, 65, 25]
    const head = [25, 65, 21, 50, 40]

    // The retired formula says +60%; the aligned experiment's median is flat.
    expect(40 / 25).toBe(1.6)
    expect(pairedMedianRatio(ref, head)).toBe(1)
    expect(pairedMedianDelta(ref, head)).toBe(0)
    const row = score(['drift'], samples(ref, head), T, new Map([['drift', K]]))[0]!
    expect(row).toMatchObject({ dMedian: 0, breach: false })
    expect(row.dMedianAggregateV1).toBeCloseTo(60)
  })

  it('pairs within-sample minima rather than unrelated global minima', () => {
    const ref = [10, 100, 100]
    const head = [20, 100, 100]
    const refMin = [1, 10, 10]
    const headMin = [2, 10, 10]
    const row = score(
      ['drift'],
      samples(ref, head, refMin, headMin),
      T,
      new Map([['drift', { ...K, pairs: 3 }]]),
    )[0]!
    expect(row.dMedian).toBe(0)
    expect(row.dMedianAggregateV1).toBe(0)
    expect(row.dMin).toBe(0)
    expect(row.dMinAggregateV1).toBe(100)
    expect(Math.min(...head) / Math.min(...ref)).toBe(2)
    expect(Math.min(...headMin) / Math.min(...refMin)).toBe(2)
    expect(row.scorer).toBe('paired-ratio-v2')
  })

  it('preserves side and minimum alignment through interleave', () => {
    // Two rounds. Round 0 measures REF then HEAD; round 1 reverses them.
    // Each side has two timed repetitions, and these absolute clock readings
    // encode durations ref=[1,4]/head=[2,8], then head=[10,10]/ref=[5,5].
    const readings = [0, 1, 2, 6, 7, 9, 10, 18, 19, 29, 30, 40, 41, 46, 47, 52]
    vi.spyOn(performance, 'now').mockImplementation(() => readings.shift()!)
    const one = (id: string) => [{ id, detail: '', parse: () => null, run: () => {} }]
    const out = interleave(
      [{ label: 'pair', a: one('x'), b: one('x') }],
      new Map([['x', 1]]),
      { targetSampleMs: 0, warmup: 0, timed: 2, rounds: 2, runs: 1 },
    ).get('pair')!

    expect(out.get('ref|x')).toEqual([2.5, 5])
    expect(out.get('head|x')).toEqual([5, 10])
    expect(out.mins.get('ref|x')).toEqual([1, 5])
    expect(out.mins.get('head|x')).toEqual([2, 10])
    expect(pairedMedianRatio(out.get('ref|x')!, out.get('head|x')!)).toBe(2)
    expect(readings).toEqual([])
  })

  it('clones the median and minimum series together', () => {
    const original = samples([1, 2], [3, 4], [0.5, 1], [1.5, 2])
    const cloned = copySamples(original)
    cloned.get('ref|drift')!.push(9)
    cloned.mins.get('ref|drift')!.push(9)
    expect(original.get('ref|drift')).toEqual([1, 2])
    expect(original.mins.get('ref|drift')).toEqual([0.5, 1])
  })

  it('rejects unpaired and invalid series', () => {
    expect(() => pairedMedianRatio([1], [1, 2])).toThrow('paired sample lengths differ')
    expect(() => pairedMedianRatio([], [])).toThrow('must not be empty')
    expect(() => pairedMedianRatio([0], [1])).toThrow('invalid paired sample')
  })
})
