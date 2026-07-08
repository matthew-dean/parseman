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
const rows = runParsemanSuite({
  only,
  scale,
  measure: { samples },
  onProgress: (id, mode) => process.stdout.write(`  measuring ${id} (${mode})...\r`),
})
process.stdout.write(' '.repeat(60) + '\r')
printParsemanReport(rows, loadBaseline(), { skipTitle: true })
