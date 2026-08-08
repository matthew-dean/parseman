import { describe, expect, it } from 'vitest'
import { classifyWorkloadShelves, SHELVED_WORKLOADS, type WorkloadShelf } from '../../bench/workload-perf-shelf.ts'
import type { Verdict } from '../../bench/ab-harness.ts'

const SHELF: Readonly<Record<string, WorkloadShelf>> = {
  known: { medianPct: 10, minPct: 12, tracking: '0.48 tracking' },
}

function verdict(id: string, failed: boolean, values: ReadonlyArray<readonly [number, number]>): Verdict {
  return {
    id,
    failed,
    breachCount: failed ? values.length : 0,
    passes: values.map(([dMedian, dMin]) => ({
      id, dMedian, dMin, breach: failed,
      refMedian: 1, headMedian: 1, refMin: 1, headMin: 1, wins: 0, pairs: 1,
    })),
  }
}

describe('0.47 workload performance shelf', () => {
  it('names only the five owner-accepted rows at their measured ceilings', () => {
    expect(SHELVED_WORKLOADS).toEqual({
      'less/stylesheet': { medianPct: 332.3, minPct: 348.5, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'less/mixins': { medianPct: 329.8, minPct: 344.3, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'css/stylesheet': { medianPct: 309.6, minPct: 333.2, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'graphql/document': { medianPct: 124.7, minPct: 129.6, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'json/document': { medianPct: 145.8, minPct: 146.9, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
    })
  })

  it('accepts only the named regression within both measured hard ceilings', () => {
    const d = classifyWorkloadShelves([verdict('known', true, [[9.9, 11.9]])], SHELF)
    expect(d.shelved.map(row => row.id)).toEqual(['known'])
    expect(d.worsened).toEqual([])
    expect(d.unknown).toEqual([])
  })

  it('blocks a known row when either metric exceeds its candidate-derived bound', () => {
    const d = classifyWorkloadShelves([verdict('known', true, [[10.1, 11], [9, 12.1]])], SHELF)
    expect(d.worsened).toMatchObject([{ id: 'known', worstMedian: 10.1, worstMin: 12.1 }])
    expect(d.shelved).toEqual([])
  })

  it('blocks a new regression rather than allowing it behind the shelf', () => {
    const d = classifyWorkloadShelves([verdict('new-workload', true, [[999, 999]])], SHELF)
    expect(d.unknown.map(row => row.id)).toEqual(['new-workload'])
    expect(d.unmeasured.map(row => row.id)).toEqual(['known'])
  })

  it('loudly identifies a recovered shelf entry for removal', () => {
    const d = classifyWorkloadShelves([verdict('known', false, [[-5, -4]])], SHELF)
    expect(d.recovered.map(row => row.id)).toEqual(['known'])
    expect(d.shelved).toEqual([])
  })

  it('does not let a non-majority regression exceed the hard ceiling silently', () => {
    const d = classifyWorkloadShelves([verdict('known', false, [[10.01, 0]])], SHELF)
    expect(d.worsened.map(row => row.id)).toEqual(['known'])
  })
})
