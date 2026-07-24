/**
 * Refresh bench/parseman-baseline.json from current timings.
 * Appends to bench/parseman-history.jsonl (time series — commit this to see the needle move).
 * Run: pnpm bench:baseline
 *
 * Captures every measurement context in PERF_CONTEXTS, each in its OWN child
 * process, because a case's median depends on which other cases share its
 * process — CSS interp reads ~15% slower in the full suite than in a css-only
 * run. Capturing all contexts here in one process would reproduce exactly that
 * skew; the guard then compares each reading against the map for its own context.
 */
import {
  writeBaseline,
  printParsemanReport,
  printHistoryIndex,
  loadBaseline,
  loadHistory,
  captureContextRows,
  PERF_CONTEXTS,
  PERF_SAMPLES,
  type ParsemanBenchRow,
  type PerfContext,
} from './parseman-perf.ts'

const priorBaseline = loadBaseline()
const contexts = Object.keys(PERF_CONTEXTS) as PerfContext[]
const rowsByContext: Partial<Record<PerfContext, ParsemanBenchRow[]>> = {}
for (const context of contexts) {
  process.stdout.write(`  capturing context "${context}" (fresh process)...\n`)
  rowsByContext[context] = captureContextRows(context)
}

printParsemanReport(rowsByContext.full ?? [], priorBaseline)
const baseline = writeBaseline(rowsByContext, { scale: 1, samples: PERF_SAMPLES })
printHistoryIndex('css/bootstrap4')
const perContext = contexts
  .map(c => `${c}=${Object.keys(c === 'full' ? baseline.cases : baseline.contexts?.[c]?.cases ?? {}).length}`)
  .join(' · ')
console.log(
  `Wrote baseline (${perContext} cases) · history now ${loadHistory().length} snapshot(s)`,
)
