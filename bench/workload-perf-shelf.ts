/**
 * The bounded, release-specific performance shelf for 0.47.
 *
 * A shelf is not a second tolerance. Each entry names one already-measured
 * workload and the worst candidate pass accepted by the release owner. A later
 * run may remain slower than 0.46, but it may not be slower than that bounded
 * result; new regressions stay ordinary gate failures.
 */
import type { Verdict } from './ab-harness.ts'

export type WorkloadShelf = {
  /** Largest accepted positive delta in any measured pass. */
  medianPct: number
  /** Largest accepted positive delta in any measured pass. */
  minPct: number
  /** The work that must remove this release-only shelf. */
  tracking: string
}

export const SHELVED_WORKLOADS: Readonly<Record<string, WorkloadShelf>> = {
  'less/stylesheet': { medianPct: 332.3, minPct: 348.5, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
  'less/mixins': { medianPct: 329.8, minPct: 344.3, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
  'css/stylesheet': { medianPct: 309.6, minPct: 333.2, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
  'graphql/document': { medianPct: 124.7, minPct: 129.6, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
  'json/document': { medianPct: 145.8, minPct: 146.9, tracking: 'notes/RELEASE-0.48-TARGET.md §8' },
}

export type ShelfRow = {
  id: string
  shelf: WorkloadShelf
  worstMedian: number
  worstMin: number
  /** Passes over either candidate-derived ceiling. */
  overCeilingPasses: number
  totalPasses: number
}

export type ShelfClassification = {
  /** Known rows still regressed, but no worse than the accepted candidate. */
  shelved: ShelfRow[]
  /** Known rows over a ceiling in a strict majority of passes. */
  worsened: ShelfRow[]
  /** Non-majority ceiling excursions: visible, but deliberately not gate failures. */
  excursions: ShelfRow[]
  /** A known row now passes the ordinary gate and should be removed from the shelf. */
  recovered: ShelfRow[]
  /** A configured row not present in this measurement (normally an --only run). */
  unmeasured: Array<{ id: string, shelf: WorkloadShelf }>
  /** A newly failing workload, never covered by this shelf. */
  unknown: Verdict[]
}

/**
 * Classify measured workload verdicts without performing timing itself.
 *
 * The candidate-derived ceiling is recorded for every pass. It uses the same
 * strict-majority rule as the ordinary gate before blocking, so an isolated
 * noisy excursion remains visible without defeating the gate's noise protection.
 */
export function classifyWorkloadShelves(
  rows: readonly Verdict[],
  shelves: Readonly<Record<string, WorkloadShelf>> = SHELVED_WORKLOADS,
): ShelfClassification {
  const byId = new Map(rows.map(row => [row.id, row]))
  const shelved: ShelfRow[] = []
  const worsened: ShelfRow[] = []
  const excursions: ShelfRow[] = []
  const recovered: ShelfRow[] = []
  const unmeasured: Array<{ id: string, shelf: WorkloadShelf }> = []

  for (const [id, shelf] of Object.entries(shelves)) {
    const row = byId.get(id)
    if (row === undefined) {
      unmeasured.push({ id, shelf })
      continue
    }
    const worstMedian = Math.max(...row.passes.map(pass => pass.dMedian))
    const worstMin = Math.max(...row.passes.map(pass => pass.dMin))
    const overCeilingPasses = row.passes.filter(
      pass => pass.dMedian > shelf.medianPct || pass.dMin > shelf.minPct,
    ).length
    const checked = { id, shelf, worstMedian, worstMin, overCeilingPasses, totalPasses: row.passes.length }
    if (overCeilingPasses * 2 > row.passes.length) worsened.push(checked)
    else {
      if (row.failed) shelved.push(checked)
      else if (overCeilingPasses === 0) recovered.push(checked)
      // Keep this independent of the ordinary verdict: the accepted 0.47 rows
      // are normally failed already, and an isolated over-ceiling pass must
      // still be visible in their shelf report.
      if (overCeilingPasses > 0) excursions.push(checked)
    }
  }

  return {
    shelved,
    worsened,
    excursions,
    recovered,
    unmeasured,
    unknown: rows.filter(row => row.failed && shelves[row.id] === undefined),
  }
}

/** A shelf never travels to a self-check, peak test, or arbitrary replay. */
export function usesPinned047WorkloadShelf(options: {
  self: boolean
  peak: boolean
  hasReferenceOverride: boolean
  hasHeadReference: boolean
}): boolean {
  return !options.self && !options.peak && !options.hasReferenceOverride && !options.hasHeadReference
}
