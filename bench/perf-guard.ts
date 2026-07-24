/**
 * Fast perf regression guard — intended for a git pre-commit hook.
 *
 * Compares measured median µs against the committed baseline for each mode.
 * Ratios are reported for context only; they are not a regression signal because
 * interpreter wins lower the compiled/interpreted ratio.
 *
 * Usage:
 *   node --import tsx/esm bench/perf-guard.ts            # css cases only (fast, ~a few s)
 *   node --import tsx/esm bench/perf-guard.ts --all      # every grammar
 *
 * Re-baseline after an intentional perf change:  pnpm bench:baseline
 *
 * Exit code 0 = no regression, 1 = regression (blocks the commit).
 */
import {
  runParsemanSuiteRobust,
  loadBaseline,
  findRegressions,
  PERF_SAMPLES,
  GUARD_PASSES,
  PERF_TOLERANCE,
} from './parseman-perf.ts'

const all = process.argv.includes('--all')
const tolerance = Number(process.env.PARSEMAN_PERF_TOLERANCE ?? PERF_TOLERANCE) // % slower than baseline

const baseline = loadBaseline()
if (!baseline) {
  console.error('perf-guard: no baseline (run `pnpm bench:baseline`) — skipping')
  process.exit(0)
}

// Measure IDENTICALLY to how the baseline was captured (same samples, robust
// median across interleaved passes) so the comparison is apples-to-apples and an
// 8% tolerance reflects real codegen drift, not measurement methodology.
// CSS cases are the most codegen-sensitive (trivia + node capture); they catch a
// 2× compiled regression without running the full suite.
const rows = runParsemanSuiteRobust({
  scale: baseline.measurement?.scale ?? 1,
  skipOptional: true,
  only: all ? undefined : ['css'],
  measure: { samples: PERF_SAMPLES },
}, GUARD_PASSES)

const regressions = findRegressions(rows, baseline, {
  checkSpeedup: false,
  checkAbsolute: true,
  tolerance: { compiled: tolerance, interpreted: tolerance },
})

// Report speed deltas and ratios so the dev sees both signal and headroom.
const byId = new Map<string, { i?: number; c?: number }>()
for (const r of rows) {
  const g = byId.get(r.id) ?? {}
  if (r.mode === 'interpreted') g.i = r.medianUs
  else g.c = r.medianUs
  byId.set(r.id, g)
}
console.log(`perf-guard: median speed vs baseline @ ${baseline.gitRev} (tolerance ${tolerance}% slower)`)
for (const [id, { i, c }] of [...byId.entries()].sort()) {
  if (i === undefined || c === undefined) continue
  const bi = baseline.cases[`${id}/interpreted`]?.medianUs
  const bc = baseline.cases[`${id}/compiled`]?.medianUs
  const speedup = i / c
  const base = bi !== undefined && bc !== undefined ? bi / bc : NaN
  const interp = bi === undefined ? '' : `  interp ${i.toFixed(2)}µs (${(((i - bi) / bi) * 100).toFixed(1)}%)`
  const comp = bc === undefined ? '' : `  compiled ${c.toFixed(2)}µs (${(((c - bc) / bc) * 100).toFixed(1)}%)`
  const ratio = Number.isNaN(base) ? '' : `  ratio ${speedup.toFixed(2)}× (baseline ${base.toFixed(2)}×)`
  console.log(`  ${id.padEnd(16)}${interp}${comp}${ratio}`)
}

// ── Cross-artifact composed-dispatch guard (DETERMINISTIC, noise-free) ──────────
// The example-grammar suite above is all MONOLITHIC — it never exercises the
// cross-artifact `composeLeaf` first-set dispatch jess's parsers depend on (the
// 0.32.0 fix). This check fuses a representative multi-artifact at-rule-cluster
// grammar and asserts the at-rule arms still first-char-gate on `@` (a gating
// regression flips it) — timing-independent, so it never false-positives on runner
// noise. The median is reported for the nightly major-regression watch.
let composeRegressed = false
try {
  const c = await import('./composeleaf-firstset.ts')
  const trials: number[] = []
  for (let i = 0; i < 200; i++) c.parse()
  for (let t = 0; t < GUARD_PASSES * 3; t++) {
    const start = performance.now()
    for (let i = 0; i < 400; i++) c.parse()
    trials.push(((performance.now() - start) / 400) * 1000)
  }
  trials.sort((a, b) => a - b)
  console.log(`  compose/atcluster  dispatch=${c.dispatchEmitted}  median ${trials[Math.floor(trials.length / 2)]!.toFixed(1)}µs (cross-artifact fuse)`)
  if (!c.dispatchEmitted) {
    console.error('\nperf-guard: REGRESSION — cross-artifact at-rule arms LOST first-char dispatch (composeLeaf first-set resolution broke).')
    composeRegressed = true
  }
} catch (e) {
  console.error(`  compose/atcluster  check failed to run: ${(e as Error).message}`)
  composeRegressed = true
}

if (regressions.length > 0 || composeRegressed) {
  if (regressions.length > 0) {
    console.error('\nperf-guard: REGRESSION — commit blocked:')
    for (const m of regressions) console.error(`  ${m}`)
    console.error('\nIf this is an intentional perf change, re-baseline with `pnpm bench:baseline` and commit bench/parseman-baseline.json.')
  }
  process.exit(1)
}
console.log('perf-guard: ok')
process.exit(0)
