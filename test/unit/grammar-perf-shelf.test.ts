import { describe, expect, it } from 'vitest'
import { classifyCandidateShelf, type CandidateCeiling, type ShelfRow } from '../../bench/grammar-perf-shelf.ts'

const known: CandidateCeiling = {
  scoreMethod: 'aggregate-v1',
  medianPct: 10,
  minPct: 12,
  tracking: 'notes/RELEASE-0.48-TARGET.md §8',
}
const ceilings = new Map([['rollback/none', known]])
const row = (id: string, failed: boolean, deltas: readonly [number, number][]): ShelfRow => ({
  id,
  failed,
  passes: deltas.map(([dMedian, dMin]) => ({ dMedian, dMedianAggregateV1: dMedian, dMin, dMinAggregateV1: dMin })),
})
const splitRow = (
  paired: readonly [number, number], aggregate: readonly [number, number], count = 3,
): ShelfRow => ({
  id: 'rollback/none',
  failed: true,
  passes: Array.from({ length: count }, () => ({
    dMedian: paired[0], dMin: paired[1],
    dMedianAggregateV1: aggregate[0], dMinAggregateV1: aggregate[1],
  })),
})

describe('grammar performance candidate shelf', () => {
  it('allows a named candidate while every pass stays within its bound', () => {
    const result = classifyCandidateShelf([
      row('rollback/none', true, [[9, 11], [10, 12], [8, 10], [9, 12], [10, 11]]),
    ], ceilings)

    expect(result.dispositions.map(d => d.kind)).toEqual(['shelved'])
    expect(result.blocking).toEqual([])
  })

  it('does not let one noisy over-ceiling pass defeat the gate majority policy', () => {
    const result = classifyCandidateShelf([
      row('rollback/none', true, [[15, 11], [9, 11], [9, 11], [9, 11], [9, 11]]),
    ], ceilings)

    expect(result.dispositions[0]).toMatchObject({ kind: 'shelved', overCeiling: 1 })
    expect(result.blocking).toEqual([])
  })

  it('blocks a named candidate once a strict majority worsens beyond its bounds', () => {
    const result = classifyCandidateShelf([
      row('rollback/none', true, [[11, 11], [9, 13], [11, 13], [9, 11], [9, 11]]),
    ], ceilings)

    expect(result.dispositions[0]).toMatchObject({ kind: 'worsened', overCeiling: 3 })
    expect(result.blocking.map(d => d.kind)).toEqual(['worsened'])
  })

  it('uses aggregate-v1 fields for the historical ceiling, not paired-v2 fields', () => {
    const aggregateOver = classifyCandidateShelf([splitRow([0, 0], [11, 13])], ceilings)
    expect(aggregateOver.dispositions[0]).toMatchObject({ kind: 'worsened', overCeiling: 3 })

    const pairedOver = classifyCandidateShelf([splitRow([99, 99], [0, 0])], ceilings)
    expect(pairedOver.dispositions[0]).toMatchObject({ kind: 'shelved', overCeiling: 0 })
  })

  it('reports recovered entries loudly instead of silently keeping them shelved', () => {
    const result = classifyCandidateShelf([
      row('rollback/none', false, [[4, 4], [5, 5], [4, 4], [5, 5], [4, 4]]),
    ], ceilings)

    expect(result.dispositions.map(d => d.kind)).toEqual(['recovered'])
    expect(result.blocking).toEqual([])
  })

  it('blocks an unlisted strict regression', () => {
    const result = classifyCandidateShelf([
      row('future/axis', true, [[99, 99], [99, 99], [99, 99], [99, 99], [99, 99]]),
    ], ceilings)

    expect(result.dispositions.map(d => d.kind)).toEqual(['unknown'])
    expect(result.blocking.map(d => d.kind)).toEqual(['unknown'])
  })
})
