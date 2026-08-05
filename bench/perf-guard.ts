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
  baselineCases,
  findRegressions,
  PERF_CONTEXTS,
  PERF_SAMPLES,
  GUARD_PASSES,
  PERF_TOLERANCE,
} from './parseman-perf.ts'

const all = process.argv.includes('--all')
const tolerance = Number(process.env.PARSEMAN_PERF_TOLERANCE ?? PERF_TOLERANCE) // % slower than baseline
const ignoredRegressionKeys = new Set([
  // Sub-microsecond fixture: useful to print, too noisy to block commits.
  'json/small/compiled',
])

// SHELVED — known, measured, tracked regressions that must NOT block a commit.
//
// This is deliberately NOT `SKIP_PERF_GUARD=1`. A blanket bypass cannot tell a
// regression we have already accepted from one that landed five minutes ago, so
// the next real regression on ANY bar rides in behind it unseen. A shelf names
// the exact bars, keeps every other bar gated at full tolerance, and — see the
// SHELVED block below — prints the current delta on every run, so a shelved bar
// that slides FURTHER is still visible.
//
// Each entry must carry a reason and a tracking pointer. Nothing goes in here
// because it is inconvenient; it goes in here because someone measured it, wrote
// it down, and decided when it gets fixed.
const shelvedRegressionKeys = new Map<string, string>([
  // Table `compile()` vs the codegen-era baseline @ 2a83f9b. Measured ~4.4× on
  // release/0.47.0 with no lane branches applied; compiled-vs-interpreted on css
  // fell from 8.09× to 1.45×. Real, not noise — the same run's `interp` bars moved
  // -14.7%/-12.8% FASTER in the same process. Absent from every bench:margin
  // fixture (json/csv/graphql/CST), so it does not touch the published chart.
  // Owner ruling: shelved for 0.47, addressed in 0.48.
  // Tracked: notes/RELEASE-0.48-TARGET.md §8.
  ['css/selector/compiled', '0.48 §8 — table compile() vs codegen-era baseline'],
  ['css/decls/compiled', '0.48 §8 — table compile() vs codegen-era baseline'],
])

const baseline = loadBaseline()
if (!baseline) {
  // FAIL CLOSED. This runs from `scripts/git-hooks/pre-commit`, where "skipping"
  // printed a line nobody reads and let the commit through with nothing measured —
  // and `bench/parseman-baseline.json` going missing is exactly the state in which
  // that matters. A missing baseline is a FAILURE, not a skip; the same rule
  // `bench/ab-harness.ts` applies to a missing reference commit.
  console.error(
    'perf-guard: no baseline at bench/parseman-baseline.json, so NOTHING was measured.\n' +
    '  Run `pnpm bench:baseline` and commit the file. A gate that cannot measure must not\n' +
    '  report success.',
  )
  process.exit(1)
}

// Measure IDENTICALLY to how this context's baseline was captured — same samples,
// same robust median across interleaved passes, and crucially the SAME CASE SET in
// the process. The filter comes from PERF_CONTEXTS rather than being spelled out
// here, so the guard cannot drift from what bench:baseline captured for it.
// CSS cases are the most codegen-sensitive (trivia + node capture); they catch a
// 2× compiled regression without running the full suite.
const context = all ? 'all' : 'css'
const cases = baselineCases(baseline, context)
if (!cases) {
  // Also fail closed. A baseline that predates per-context capture leaves this gate
  // with nothing to compare against, which is indistinguishable — from the exit code —
  // from a clean run. Re-baselining is a one-line fix; a silently disabled gate is not.
  console.error(
    `perf-guard: baseline @ ${baseline.gitRev} has no "${context}" context (predates per-context\n` +
    '  capture), so NOTHING was measured. Run `pnpm bench:baseline` and commit\n' +
    '  bench/parseman-baseline.json.',
  )
  process.exit(1)
}

const rows = runParsemanSuiteRobust({
  ...PERF_CONTEXTS[context],
  scale: baseline.measurement?.scale ?? 1,
  measure: { samples: PERF_SAMPLES },
}, GUARD_PASSES)

const regressionsAll = findRegressions(rows, baseline, {
  checkSpeedup: false,
  checkAbsolute: true,
  tolerance: { compiled: tolerance, interpreted: tolerance },
  context,
})

const keyOf = (message: string): string => message.slice(0, message.indexOf(':'))
const shelved = regressionsAll.filter(m => shelvedRegressionKeys.has(keyOf(m)))
const regressions = regressionsAll.filter(
  m => !ignoredRegressionKeys.has(keyOf(m)) && !shelvedRegressionKeys.has(keyOf(m)),
)

// Report speed deltas and ratios so the dev sees both signal and headroom.
const byId = new Map<string, { i?: number; c?: number }>()
for (const r of rows) {
  const g = byId.get(r.id) ?? {}
  if (r.mode === 'interpreted') g.i = r.medianUs
  else g.c = r.medianUs
  byId.set(r.id, g)
}
console.log(`perf-guard: median speed vs baseline @ ${baseline.gitRev} · context "${context}" (tolerance ${tolerance}% slower)`)
if (all) console.log(`  ignored blocking checks: ${[...ignoredRegressionKeys].join(', ')}`)
for (const [id, { i, c }] of [...byId.entries()].sort()) {
  if (i === undefined || c === undefined) continue
  const bi = cases[`${id}/interpreted`]?.medianUs
  const bc = cases[`${id}/compiled`]?.medianUs
  const speedup = i / c
  const base = bi !== undefined && bc !== undefined ? bi / bc : NaN
  const interp = bi === undefined ? '' : `  interp ${i.toFixed(2)}µs (${(((i - bi) / bi) * 100).toFixed(1)}%)`
  const comp = bc === undefined ? '' : `  compiled ${c.toFixed(2)}µs (${(((c - bc) / bc) * 100).toFixed(1)}%)`
  const ratio = Number.isNaN(base) ? '' : `  ratio ${speedup.toFixed(2)}× (baseline ${base.toFixed(2)}×)`
  console.log(`  ${id.padEnd(16)}${interp}${comp}${ratio}`)
}

// ── Shelved regressions: never silent ───────────────────────────────────────────
// A shelf that prints nothing is a disabled gate. These are reported on EVERY run
// with their current delta, so a shelved bar sliding further is still visible, and
// a shelved bar that recovered gets taken off the shelf instead of hiding a fresh
// regression behind an entry nobody revisits.
if (shelvedRegressionKeys.size > 0) {
  console.log('\n  SHELVED (known, tracked, not blocking):')
  for (const m of shelved) {
    console.log(`    ${m}`)
    console.log(`      → ${shelvedRegressionKeys.get(keyOf(m))!}`)
  }
  const recovered = [...shelvedRegressionKeys.keys()].filter(k => !shelved.some(m => keyOf(m) === k))
  for (const k of recovered) {
    console.log(`    ${k}: NO LONGER REGRESSED — remove it from shelvedRegressionKeys`)
    console.log(`      → ${shelvedRegressionKeys.get(k)!}`)
  }
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

// ── WHAT ACTUALLY BLOCKS, AND WHY IT IS NOT THIS FILE'S HEADLINE NUMBER ─────────
//
// The owner's bar, stated plainly: **we cannot be slower than a competitor on any
// bar of the published SVG charts.** That is the blocker. Sliding against our own
// previous baseline is a warning — worth seeing on every commit, not worth
// stopping one over — with a hard ceiling so a slide cannot go unbounded.
//
// This file measures the SECOND thing. It compares us against our own baseline on
// fixtures, several of which (`css/*`) appear in NO chart at all. A bar can regress
// 4× here and cost the product nothing, and a bar can stay flat here while a
// competitor overtakes us on a chart — which is the failure that actually matters
// and which this file structurally cannot see.
//
// So: WARN at `tolerance`, BLOCK only past HARD_SLIDE_PCT. The competitor gate
// lives with the charts, in `bench/svg-margin.ts`, because that is where the
// competitor bars are.
const HARD_SLIDE_PCT = 100 // a 2× slide against our own baseline is a stop, shelf or not

const pctOf = (message: string): number => {
  const m = message.match(/\+([\d.]+)% regression/)
  return m ? Number(m[1]) : 0
}
const hard = regressions.filter(m => pctOf(m) >= HARD_SLIDE_PCT)

if (regressions.length > 0) {
  console.error('\nperf-guard: SLID vs baseline (warning — not blocking):')
  for (const m of regressions) console.error(`  ${m}`)
  console.error('\nIf this is an intentional perf change, re-baseline with `pnpm bench:baseline` and commit bench/parseman-baseline.json.')
}

if (hard.length > 0 || composeRegressed) {
  if (hard.length > 0) {
    console.error(`\nperf-guard: BLOCKED — slid past the ${HARD_SLIDE_PCT}% hard ceiling:`)
    for (const m of hard) console.error(`  ${m}`)
    console.error('  Shelve it explicitly in shelvedRegressionKeys with a reason and a tracking\n  pointer, or fix it. Do not reach for SKIP_PERF_GUARD=1.')
  }
  process.exit(1)
}
console.log('perf-guard: ok')
process.exit(0)
