import { describe, expect, it } from 'vitest'
import {
  pairedMedianRatio,
  score,
  type Calibration,
  type Samples,
  type Thresholds,
} from '../../bench/ab-harness.ts'

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
    expect(score(['drift'], samples(ref, head), T, new Map([['drift', K]]))[0]).toMatchObject({
      dMedian: 0,
      breach: false,
    })
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
    expect(row.dMin).toBe(0)
    expect(Math.min(...head) / Math.min(...ref)).toBe(2)
    expect(Math.min(...headMin) / Math.min(...refMin)).toBe(2)
    expect(row.refMin).toBe(1)
    expect(row.headMin).toBe(2)
  })

  it('rejects unpaired and invalid series', () => {
    expect(() => pairedMedianRatio([1], [1, 2])).toThrow('paired sample lengths differ')
    expect(() => pairedMedianRatio([], [])).toThrow('must not be empty')
    expect(() => pairedMedianRatio([0], [1])).toThrow('invalid paired sample')
  })
})
