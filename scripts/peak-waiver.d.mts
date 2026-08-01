/**
 * Types for `scripts/peak-waiver.mjs`.
 *
 * The module is `.mjs` and not `.ts` because `scripts/check-changelog.mjs` imports it
 * and runs under bare `node` — no loader, no build step, because a release gate that
 * needs a build to run is a gate that cannot run when the build is broken. `bench/` is
 * outside `tsconfig.json`'s `include`, so this file exists for the ONE consumer tsc
 * sees: `test/unit/peak-waiver.test.ts`.
 *
 * Kept deliberately thin, and structural rather than nominal, so it describes the
 * contract the two callers actually rely on and has little room to drift from the
 * implementation's JSDoc.
 */

export declare const WAIVER_TAG: 'PERF-PEAK-WAIVER'

export interface ParsedWaiver {
  /** The matched line, trimmed — the unit the freshness check compares. */
  line: string
  config: string | null
  medianPct: number | null
  minPct: number | null
  reason: string | null
  /** Empty when the line is well-formed. Non-empty is a FAILURE, never a skip. */
  problems: string[]
}

export declare function parsePeakWaivers(section: string): ParsedWaiver[]

export declare function openSection(changelog: string): string

export declare function isBreach(
  w: { medianPct: number | null, minPct: number | null },
  allowancePct: number,
): boolean

export declare function decideWaiver(o: {
  section: string
  config: string
  peak: { version: string, sha: string, allowancePct: number }
  breaching: ReadonlyArray<{ dMedian: number, dMin: number }>
  base: string | null
  baseChangelog: string
}): { applied: boolean, message: string }
