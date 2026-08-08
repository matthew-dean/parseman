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
}

export type ShelfClassification = {
  /** Known rows still regressed, but no worse than the accepted candidate. */
  shelved: ShelfRow[]
  /** Known rows which exceeded either hard per-pass ceiling. */
  worsened: ShelfRow[]
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
 * The hard ceilings deliberately inspect every pass, not only the majority
 * verdict. A new pass above the accepted candidate is a worsening even if the
 * ordinary noise rule keeps the row from becoming a majority failure.
 */
export function classifyWorkloadShelves(
  rows: readonly Verdict[],
  shelves: Readonly<Record<string, WorkloadShelf>> = SHELVED_WORKLOADS,
): ShelfClassification {
  const byId = new Map(rows.map(row => [row.id, row]))
  const shelved: ShelfRow[] = []
  const worsened: ShelfRow[] = []
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
    const checked = { id, shelf, worstMedian, worstMin }
    if (worstMedian > shelf.medianPct || worstMin > shelf.minPct) worsened.push(checked)
    else if (row.failed) shelved.push(checked)
    else recovered.push(checked)
  }

  return {
    shelved,
    worsened,
    recovered,
    unmeasured,
    unknown: rows.filter(row => row.failed && shelves[row.id] === undefined),
  }
}
