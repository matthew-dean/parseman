/**
 * Refresh bench/parseman-baseline.json from current timings.
 * Appends to bench/parseman-history.jsonl (time series — commit this to see the needle move).
 * Run: pnpm bench:baseline
 */
import {
  runParsemanSuiteRobust,
  writeBaseline,
  printParsemanReport,
  printHistoryIndex,
  loadBaseline,
  loadHistory,
  PERF_SAMPLES,
  BASELINE_PASSES,
} from './parseman-perf.ts'

const priorBaseline = loadBaseline()
// Robust capture (median of several interleaved passes) so sub-µs cases don't
// store a fluke value — the guard measures the same way, so a tight tolerance is
// comparing like with like. MUST stay in sync with the guard's measurement.
const rows = runParsemanSuiteRobust({ measure: { samples: PERF_SAMPLES } }, BASELINE_PASSES)
printParsemanReport(rows, priorBaseline)
const baseline = writeBaseline(rows, { scale: 1, samples: PERF_SAMPLES })
printHistoryIndex('css/bootstrap4')
console.log(
  `Wrote baseline (${Object.keys(baseline.cases).length} cases) · history now ${loadHistory().length} snapshot(s)`,
)
