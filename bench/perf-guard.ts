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
const interpreterGuardSlowdown = Number(process.env.PARSEMAN_INTERPRETER_GUARD_SLOWDOWN ?? 1)
if (!Number.isFinite(interpreterGuardSlowdown) || interpreterGuardSlowdown < 1) {
  throw new Error('PARSEMAN_INTERPRETER_GUARD_SLOWDOWN must be a finite number >= 1')
}
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
const shelvedRegressionKeys = new Map<string, string>()

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

const measuredRows = runParsemanSuiteRobust({
  ...PERF_CONTEXTS[context],
  scale: baseline.measurement?.scale ?? 1,
  measure: { samples: PERF_SAMPLES },
}, GUARD_PASSES)
// Permanent sensitivity control for the interpreter ratchet. It changes only the
// reported timing after measurement; production code and the compiled leg stay
// untouched. A 100x plant must make this process exit non-zero.
const rows = measuredRows.map(row => row.mode === 'interpreted'
  ? { ...row, medianUs: row.medianUs * interpreterGuardSlowdown }
  : row)

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
// The cross-artifact first-char dispatch check is GONE with the source lowering that
// made it necessary. It asserted that `fusedBody`'s `@FS:` placeholder substitution
// still resolved a composed at-rule arm's first-set through the fuse — a property of
// TEXTUAL fusion. Table composition merges rule maps and encodes once, so a composed
// arm's first-set is computed by the same encoder that computes a monolithic one;
// there is no separate fuse-time resolution left to regress.
const composeRegressed = false

// ── WHAT ACTUALLY BLOCKS, AND WHY IT IS NOT THIS FILE'S HEADLINE NUMBER ─────────
//
// The compiled-parser owner's bar is stated by the published SVG charts. Sliding
// compiled output against our own previous baseline remains a warning, with a
// hard ceiling so it cannot go unbounded while the compiler is being optimized.
//
// The interpreter has a different contract: 0.50.2 deliberately banked its
// setup-free gains, so an interpreted row outside the measured tolerance is a
// regression. Block those rows at `tolerance`; do not make them spend the 2x
// compiled-path escape hatch below.
//
// This file measures the SECOND thing. It compares us against our own baseline on
// fixtures, several of which (`css/*`) appear in NO chart at all. A bar can regress
// 4× here and cost the product nothing, and a bar can stay flat here while a
// competitor overtakes us on a chart — which is the failure that actually matters
// and which this file structurally cannot see.
//
// So: interpreter BLOCKS at `tolerance`; compiled WARNs there and BLOCKS only
// past HARD_SLIDE_PCT. The compiled competitor gate lives with the charts, in
// `bench/svg-margin.ts`, because that is where those competitor bars are.
const HARD_SLIDE_PCT = 100 // a 2× slide against our own baseline is a stop, shelf or not

const pctOf = (message: string): number => {
  const m = message.match(/\+([\d.]+)% regression/)
  return m ? Number(m[1]) : 0
}
const interpreterRegressions = regressions.filter(m => keyOf(m).endsWith('/interpreted'))
const hardCompiledRegressions = regressions.filter(
  m => keyOf(m).endsWith('/compiled') && pctOf(m) >= HARD_SLIDE_PCT,
)

if (regressions.length > 0) {
  console.error('\nperf-guard: SLID vs baseline (warning — not blocking):')
  for (const m of regressions) console.error(`  ${m}`)
  console.error('\nIf this is an intentional perf change, re-baseline with `pnpm bench:baseline` and commit bench/parseman-baseline.json.')
}

if (interpreterRegressions.length > 0 || hardCompiledRegressions.length > 0 || composeRegressed) {
  if (interpreterRegressions.length > 0) {
    console.error(`\nperf-guard: BLOCKED — interpreter slid past the ${tolerance}% noise-aware tolerance:`)
    for (const m of interpreterRegressions) console.error(`  ${m}`)
    console.error('  The interpreter baseline is a retained product gain. Fix the regression; do not\n  move the baseline or shelf the row merely to make this gate green.')
  }
  if (hardCompiledRegressions.length > 0) {
    console.error(`\nperf-guard: BLOCKED — compiled path slid past the ${HARD_SLIDE_PCT}% hard ceiling:`)
    for (const m of hardCompiledRegressions) console.error(`  ${m}`)
    console.error('  Shelve it explicitly in shelvedRegressionKeys with a reason and a tracking\n  pointer, or fix it. Do not reach for SKIP_PERF_GUARD=1.')
  }
  process.exit(1)
}
console.log('perf-guard: ok')
process.exit(0)
