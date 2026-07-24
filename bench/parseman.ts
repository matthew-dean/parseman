/**
 * Parseman-only interpreter/compiled measurements.
 *
 * Use this for parser-runtime tweaks:
 *   pnpm bench:parseman
 *   pnpm bench:parseman -- --only=json
 *   pnpm bench:parseman -- --only=css --scale=0.5 --samples=7
 */
import { loadBaseline, printParsemanReport, runParsemanSuite } from './parseman-perf.ts'

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length)
}

const onlyRaw = argValue('only')
const only = onlyRaw ? onlyRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined
const scale = Number(argValue('scale') ?? 1)
const samples = Number(argValue('samples') ?? 15)

console.log('\n=== Parseman perf — interpreted vs compiled ===')
if (only || scale !== 1) {
  // The Δ columns compare against the `full` context baseline. A filtered or
  // rescaled run is a DIFFERENT measurement context, and interpreted medians move
  // ~15% between contexts (see PERF_CONTEXTS) — so read Δ as a hint, not a gate.
  console.log('  note: filtered/rescaled run — Δ vs the full-context baseline is indicative only;')
  console.log('        the gate is `pnpm perf:guard`, which compares within its own context.')
}
const rows = runParsemanSuite({
  only,
  scale,
  measure: { samples },
  onProgress: (id, mode) => process.stdout.write(`  measuring ${id} (${mode})...\r`),
})
process.stdout.write(' '.repeat(60) + '\r')
printParsemanReport(rows, loadBaseline(), { skipTitle: true })
