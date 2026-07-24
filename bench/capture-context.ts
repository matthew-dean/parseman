/**
 * Child entry for a measurement context — measures ONE context in a pristine
 * process and prints its rows as JSON on a `__ROWS__` line.
 *
 *   node --import tsx/esm bench/capture-context.ts css [--samples=N] [--passes=N]
 *
 * Contexts must not share a process (see PERF_CONTEXTS in parseman-perf.ts):
 * whichever ran first pollutes the interpreter's inline caches for the next, so a
 * single-process capture would bake the very skew the per-context baseline exists
 * to remove. Spawned by captureContextRows() — from bench:baseline (to write each
 * context's map) and from the vitest perf gates (whose own worker is polluted).
 */
import {
  runParsemanSuiteRobust,
  PERF_CONTEXTS,
  PERF_SAMPLES,
  BASELINE_PASSES,
  ROWS_MARKER,
  type PerfContext,
} from './parseman-perf.ts'

function numArg(name: string, fallback: number): number {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const context = process.argv[2] as PerfContext
if (!context || !(context in PERF_CONTEXTS)) {
  console.error(
    `capture-context: unknown context ${String(context)} (expected: ${Object.keys(PERF_CONTEXTS).join(', ')})`,
  )
  process.exit(2)
}

const rows = runParsemanSuiteRobust(
  { ...PERF_CONTEXTS[context], measure: { samples: numArg('samples', PERF_SAMPLES) } },
  numArg('passes', BASELINE_PASSES),
)
process.stdout.write(`\n${ROWS_MARKER}${JSON.stringify(rows)}\n`)
