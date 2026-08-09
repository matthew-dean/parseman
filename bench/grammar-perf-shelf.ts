/**
 * Classification for the temporary 0.47 grammar-density performance shelf.
 *
 * This is deliberately pure: the executable gate owns measurement and output;
 * this module only decides whether already-measured verdicts are known debt,
 * recovered debt, or a new/worsened failure that must block.
 */
export type CandidateCeiling = {
  scoreMethod: 'aggregate-v1'
  /** Maximum allowed per-pass slowdown against the pinned 0.46 reference. */
  medianPct: number
  minPct: number
  tracking: string
}

export type ShelfPass = {
  dMedian: number
  dMedianAggregateV1: number
  dMin: number
  dMinAggregateV1: number
}

export type ShelfRow = {
  id: string
  /** The normal grammar gate's strict-majority verdict. */
  failed: boolean
  passes: readonly ShelfPass[]
}

export type ShelfDisposition =
  | { kind: 'ordinary', row: ShelfRow }
  | { kind: 'shelved', row: ShelfRow, ceiling: CandidateCeiling, overCeiling: number }
  | { kind: 'recovered', row: ShelfRow, ceiling: CandidateCeiling }
  | { kind: 'worsened', row: ShelfRow, ceiling: CandidateCeiling, overCeiling: number }
  | { kind: 'unknown', row: ShelfRow }

export type ShelfClassification = {
  dispositions: readonly ShelfDisposition[]
  blocking: readonly Extract<ShelfDisposition, { kind: 'worsened' | 'unknown' }>[]
}

const isStrictMajority = (count: number, total: number): boolean => count > total / 2

/**
 * Apply a named, bounded shelf to normal gate verdicts.
 *
 * The normal verdict stays authoritative for recovery: an entry is recovered
 * only once it no longer fails the gate's existing strict-majority policy. A
 * still-failing known entry is permitted only while a strict majority of its
 * independent passes remain at or below the candidate-specific median AND min
 * ceilings. An unlisted strict failure is never silently accepted.
 */
export function classifyCandidateShelf(
  rows: readonly ShelfRow[],
  ceilings: ReadonlyMap<string, CandidateCeiling>,
): ShelfClassification {
  const dispositions: ShelfDisposition[] = []
  const blocking: Extract<ShelfDisposition, { kind: 'worsened' | 'unknown' }>[] = []

  for (const row of rows) {
    const ceiling = ceilings.get(row.id)
    if (!row.failed) {
      dispositions.push(ceiling === undefined
        ? { kind: 'ordinary', row }
        : { kind: 'recovered', row, ceiling })
      continue
    }
    if (ceiling === undefined) {
      const disposition: ShelfDisposition = { kind: 'unknown', row }
      dispositions.push(disposition)
      blocking.push(disposition)
      continue
    }
    const overCeiling = row.passes.filter(pass =>
      pass.dMedianAggregateV1 > ceiling.medianPct || pass.dMinAggregateV1 > ceiling.minPct,
    ).length
    if (isStrictMajority(overCeiling, row.passes.length)) {
      const disposition: ShelfDisposition = { kind: 'worsened', row, ceiling, overCeiling }
      dispositions.push(disposition)
      blocking.push(disposition)
    } else {
      dispositions.push({ kind: 'shelved', row, ceiling, overCeiling })
    }
  }
  return { dispositions, blocking }
}
