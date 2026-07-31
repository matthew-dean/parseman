#!/usr/bin/env node
/**
 * Coverage regression guard — the coverage analogue of bench/perf-guard.ts.
 *
 * Compares the current run's coverage/coverage-summary.json against the
 * committed scripts/coverage-baseline.json and fails (exit 1) if any metric
 * (lines/statements/functions/branches) drops more than COVERAGE_TOLERANCE
 * percentage points below its baseline value. A small tolerance absorbs
 * report-to-report rounding noise without hiding a real drop.
 *
 * This is a RATCHET, not a fixed threshold: it never blocks on coverage gaps
 * that already existed when the baseline was captured — it only blocks NEW
 * regressions relative to where coverage already was. Raise the bar over
 * time by re-running `pnpm coverage:baseline` after adding tests; the
 * baseline should only ever move up (or sideways), never down, without a
 * deliberate reason written in the commit message.
 *
 * Usage:
 *   pnpm test:coverage && pnpm coverage:guard
 *
 * Exit code 0 = no regression, 1 = regression, a missing input, or a report that
 * measured nothing. This gate FAILS CLOSED: it used to exit 0 when the baseline was
 * absent, which quietly turned the CI ratchet into a no-op and reported it as success.
 *
 * `--summary=<path>` and `--baseline=<path>` override the two inputs. They exist so
 * `test/unit/coverage-guard.test.ts` can drive the real script over fixture reports —
 * including the zero-denominator report, which cannot be produced on demand.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const argPath = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? resolve(hit.slice(name.length + 3)) : resolve(__dir, fallback)
}
const SUMMARY_PATH = argPath('summary', '../coverage/coverage-summary.json')
const BASELINE_PATH = argPath('baseline', 'coverage-baseline.json')

// % points a metric may drop below baseline before this is a real regression.
const TOLERANCE = Number(process.env.COVERAGE_TOLERANCE ?? 0.5)

// FAIL CLOSED. "Skipping" turned the CI ratchet (.github/workflows/ci.yml) into a
// no-op the moment the baseline went missing, and reported it as success. A gate that
// cannot measure must not be green.
if (!existsSync(BASELINE_PATH)) {
  console.error(
    'coverage-guard: no baseline at scripts/coverage-baseline.json, so NOTHING was checked.\n' +
    '  Run `pnpm coverage:baseline` and commit the file.',
  )
  process.exit(1)
}

if (!existsSync(SUMMARY_PATH)) {
  console.error(`coverage-guard: ${SUMMARY_PATH} not found — run \`pnpm test:coverage\` before this script`)
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'))
const total = summary.total
if (!total) {
  console.error('coverage-guard: coverage-summary.json has no "total" row — unexpected shape')
  process.exit(1)
}

const METRICS = ['lines', 'statements', 'functions', 'branches']

// Istanbul reports `pct: 100` when `total === 0`, so a run that instrumented ZERO
// files — a broken include glob, a coverage provider that failed to attach, tests
// that never imported src/ — reads as PERFECT coverage and prints an IMPROVEMENT.
// The baseline stores only percentages, so nothing downstream can catch it either.
// The denominator is the only thing that distinguishes "everything is covered" from
// "nothing was looked at".
const empty = METRICS.filter((m) => !(total[m]?.total > 0))
if (empty.length > 0) {
  console.error(
    `coverage-guard: ${empty.join(', ')} have a ZERO denominator — no code was instrumented, so\n` +
    '  the 100% this would otherwise report means nothing was measured, not that everything is\n' +
    '  covered. Check the coverage include globs and that `pnpm test:coverage` actually ran the\n' +
    '  suite (vitest.coverage.config.ts).',
  )
  process.exit(1)
}

const current = {
  lines: total.lines.pct,
  statements: total.statements.pct,
  functions: total.functions.pct,
  branches: total.branches.pct,
}

console.log(`coverage-guard: vs baseline @ ${baseline.gitRev} (${baseline.updatedAt}), tolerance ${TOLERANCE}pp`)
const regressions = []
for (const metric of METRICS) {
  const base = baseline.metrics[metric]
  const now = current[metric]
  const delta = now - base
  const sign = delta >= 0 ? '+' : ''
  console.log(`  ${metric.padEnd(11)} ${now.toFixed(2)}%  (baseline ${base.toFixed(2)}%, ${sign}${delta.toFixed(2)}pp)`)
  if (delta < -TOLERANCE) {
    regressions.push(`${metric}: ${now.toFixed(2)}% vs baseline ${base.toFixed(2)}% (${delta.toFixed(2)}pp drop, tolerance ${TOLERANCE}pp)`)
  }
}

if (regressions.length > 0) {
  console.error('\ncoverage-guard: REGRESSION — build blocked:')
  for (const m of regressions) console.error(`  ${m}`)
  console.error('\nAdd/restore tests to cover the newly-uncovered code. If this drop is deliberate and justified, re-baseline with `pnpm coverage:baseline` and explain why in the commit message.')
  process.exit(1)
}
console.log('\ncoverage-guard: ok')
process.exit(0)
