import { describe, expect, it } from 'vitest'
import type { Measurement } from '../../bench/ab-harness.ts'
import { pairedRoundDispersion, resolveMeasurement } from '../../bench/jess/ab-options.ts'

const BASE: Measurement = { targetSampleMs: 0, warmup: 3, timed: 5, rounds: 8, runs: 2 }

describe('Jess A/B measurement controls', () => {
  it('keeps routine defaults and resolves CLI over environment', () => {
    expect(resolveMeasurement(BASE, [], {}).measurement).toEqual(BASE)
    const r = resolveMeasurement(
      BASE,
      ['--warmup=0', '--rounds=40'],
      { PM_JESS_AB_ROUNDS: '30', PM_JESS_AB_RUNS: '6', PM_JESS_AB_TIMED: '9' },
    )
    expect(r.measurement).toEqual({ targetSampleMs: 0, warmup: 0, timed: 9, rounds: 40, runs: 6 })
    expect(r.overrides).toEqual([
      'warmup=0 (CLI)',
      'timed=9 (PM_JESS_AB_TIMED)',
      'rounds=40 (CLI)',
      'runs=6 (PM_JESS_AB_RUNS)',
    ])
  })

  it('rejects invalid values instead of silently changing the experiment', () => {
    expect(() => resolveMeasurement(BASE, ['--timed=0'], {})).toThrow('--timed must be an integer >= 1')
    expect(() => resolveMeasurement(BASE, [], { PM_JESS_AB_WARMUP: '-1' })).toThrow('PM_JESS_AB_WARMUP')
  })
})

describe('Jess A/B paired round dispersion', () => {
  it('takes the median of aligned pairs in each round', () => {
    const d = pairedRoundDispersion(
      [10, 20, 10, 20, 10, 20],
      [9, 22, 10, 20, 12, 24],
      2,
    )
    expect(d.ratios).toEqual([1, 1, 1.2])
    expect(d.median).toBe(1)
    expect(d.min).toBe(1)
    expect(d.max).toBe(1.2)
    expect(d.headWins).toBe(0)
  })

  it('refuses unpaired sample arrays', () => {
    expect(() => pairedRoundDispersion([1, 2, 3], [1, 2], 1)).toThrow('paired sample lengths differ')
    expect(() => pairedRoundDispersion([1, 2, 3], [1, 2, 3], 2)).toThrow('not a non-zero multiple')
  })
})
