import { describe, expect, it } from 'vitest'
import {
  classifyWorkloadShelves, SHELVED_WORKLOADS, usesPinned047WorkloadShelf, type WorkloadShelf,
} from '../../bench/workload-perf-shelf.ts'
import type { Verdict } from '../../bench/ab-harness.ts'

const SHELF: Readonly<Record<string, WorkloadShelf>> = {
  known: { scoreMethod: 'aggregate-v1', medianPct: 10, minPct: 12, tracking: '0.48 tracking' },
}

function verdict(id: string, failed: boolean, values: ReadonlyArray<readonly [number, number]>): Verdict {
  return {
    id,
    failed,
    breachCount: failed ? values.length : 0,
    passes: values.map(([dMedian, dMin]) => ({
      id, dMedian, dMin, breach: failed,
      scorer: 'paired-ratio-v2', refMedian: 1, headMedian: 1,
      dMedianAggregateV1: dMedian, dMinAggregateV1: dMin, wins: 0, pairs: 1,
    })),
  }
}

function splitVerdict(
  paired: readonly [number, number], aggregate: readonly [number, number], count = 3,
): Verdict {
  return {
    id: 'known', failed: true, breachCount: count,
    passes: Array.from({ length: count }, () => ({
      id: 'known', scorer: 'paired-ratio-v2', refMedian: 1, headMedian: 1,
      dMedian: paired[0], dMin: paired[1],
      dMedianAggregateV1: aggregate[0], dMinAggregateV1: aggregate[1],
      wins: 0, pairs: 1, breach: true,
    })),
  }
}

describe('0.47 workload performance shelf', () => {
  it('names only the five owner-accepted rows at their measured ceilings', () => {
    expect(SHELVED_WORKLOADS).toEqual({
      'less/stylesheet': { scoreMethod: 'aggregate-v1', medianPct: 332.3, minPct: 348.5, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'less/mixins': { scoreMethod: 'aggregate-v1', medianPct: 329.8, minPct: 344.3, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'css/stylesheet': { scoreMethod: 'aggregate-v1', medianPct: 309.6, minPct: 333.2, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'graphql/document': { scoreMethod: 'aggregate-v1', medianPct: 124.7, minPct: 129.6, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
      'json/document': { scoreMethod: 'aggregate-v1', medianPct: 145.8, minPct: 146.9, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
    })
  })

  it('applies the shelf only to the checked-out candidate against its pinned reference', () => {
    expect(usesPinned047WorkloadShelf({
      self: false, peak: false, hasReferenceOverride: false, hasHeadReference: false,
    })).toBe(true)
    expect(usesPinned047WorkloadShelf({
      self: false, peak: false, hasReferenceOverride: false, hasHeadReference: true,
    })).toBe(false)
    expect(usesPinned047WorkloadShelf({
      self: false, peak: false, hasReferenceOverride: true, hasHeadReference: false,
    })).toBe(false)
    expect(usesPinned047WorkloadShelf({
      self: true, peak: false, hasReferenceOverride: false, hasHeadReference: false,
    })).toBe(false)
    expect(usesPinned047WorkloadShelf({
      self: false, peak: true, hasReferenceOverride: false, hasHeadReference: false,
    })).toBe(false)
  })

  it('accepts only the named regression within both measured hard ceilings', () => {
    const d = classifyWorkloadShelves([verdict('known', true, [[9.9, 11.9]])], SHELF)
    expect(d.shelved.map(row => row.id)).toEqual(['known'])
    expect(d.worsened).toEqual([])
    expect(d.unknown).toEqual([])
  })

  it('blocks a known row when a strict majority of passes exceed a candidate-derived bound', () => {
    const d = classifyWorkloadShelves([verdict('known', true, [[10.1, 11], [9, 12.1], [0, 0]])], SHELF)
    expect(d.worsened).toMatchObject([{
      id: 'known', worstMedian: 10.1, worstMin: 12.1, overCeilingPasses: 2, totalPasses: 3,
    }])
    expect(d.shelved).toEqual([])
  })

  it('uses aggregate-v1 fields for the historical ceiling, not paired-v2 fields', () => {
    const aggregateOver = classifyWorkloadShelves([splitVerdict([0, 0], [11, 13])], SHELF)
    expect(aggregateOver.worsened).toMatchObject([{ overCeilingPasses: 3 }])

    const pairedOver = classifyWorkloadShelves([splitVerdict([99, 99], [0, 0])], SHELF)
    expect(pairedOver.shelved).toMatchObject([{ overCeilingPasses: 0 }])
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

  it('reports, but does not fail, an isolated ceiling excursion', () => {
    const d = classifyWorkloadShelves([verdict('known', true, [[10.01, 0], [0, 0], [0, 0]])], SHELF)
    expect(d.worsened).toEqual([])
    expect(d.excursions).toMatchObject([{ id: 'known', overCeilingPasses: 1, totalPasses: 3 }])
    expect(d.shelved.map(row => row.id)).toEqual(['known'])
    expect(d.recovered).toEqual([])
  })
})
