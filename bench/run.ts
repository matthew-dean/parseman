/**
 * parseman benchmark suite
 *
 * Compares:
 *   - parseman interpreter (runtime)
 *   - parseman compiled (via compile())
 *   - Chevrotain
 *   - Parsimmon
 *   - Peggy (code-generating PEG parser)
 *   - JSON.parse() (native baseline for JSON)
 *
 * Run:  node --import tsx bench/run.ts
 *       OR: pnpm bench
 */
import { parseJSON, jsonValue } from '../examples/json/parser.ts'
import { parseCSV, compiledCSV } from '../examples/csv/parser.ts'
import { parseConfig, compiledConfig } from '../examples/toml-ish/parser.ts'
import { compile } from '../src/index.ts'
import { buildChevrotainJSON } from './chevrotain-json.ts'
import { buildParsimmonJSON } from './parsimmon-json.ts'
import { buildParsimmonCSV } from './parsimmon-csv.ts'
import { buildPeggyJSON } from './peggy-json.ts'
import { buildPeggyCSV } from './peggy-csv.ts'

// ---------------------------------------------------------------------------
// Compiled parsers (built once, reused across bench runs)
// ---------------------------------------------------------------------------
const compiledJSON   = compile(jsonValue)
const chevrotainJSON = buildChevrotainJSON()
const parsimmonJSON  = buildParsimmonJSON()
const parsimmonCSV   = buildParsimmonCSV()
const peggyJSON      = buildPeggyJSON()
const peggyCSV       = buildPeggyCSV()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SMALL_JSON = JSON.stringify({ name: 'Alice', age: 30, active: true, score: 98.6 })
const MEDIUM_JSON = JSON.stringify({
  users: Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, name: `User ${i}`, email: `user${i}@example.com`,
    scores: [42.1, 88.7],
    active: i % 2 === 0,
  }))
})
const LARGE_JSON = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({
    id: i, value: `item-${i}`, nested: { a: i * 2, b: `str-${i}` }
  }))
})

const SMALL_CSV = `name,age,city\nAlice,30,NYC\nBob,25,LA\nCarol,35,Chicago\n`
const LARGE_CSV = Array.from({ length: 500 }, (_, i) =>
  `user${i},${20 + (i % 50)},city${i % 20},${(i * 1.5).toFixed(2)},${i % 2 === 0 ? 'true' : 'false'}`
).join('\n') + '\n'

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------
function bench(name: string, fn: () => unknown, iterations = 10_000): number {
  for (let i = 0; i < Math.min(iterations / 10, 1000); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start
  const ops = Math.round(iterations / (elapsed / 1000))
  const us = ((elapsed / iterations) * 1000).toFixed(2)
  console.log(`  ${name.padEnd(36)} ${String(ops).padStart(9)} ops/s  (${us}µs/op)`)
  return ops
}

// ---------------------------------------------------------------------------
// JSON benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== JSON parsing ===')

function jsonGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parmésan (interpreter)',     () => parseJSON(input), iters)
  bench('Parmésan (compiled)',   () => compiledJSON.parse(input, 0), iters)
  bench('Chevrotain',            () => chevrotainJSON(input), iters)
  bench('Parsimmon',             () => parsimmonJSON(input), iters)
  bench('Peggy',                 () => peggyJSON(input), iters)
  bench('JSON.parse (native)',   () => JSON.parse(input), iters)
}

jsonGroup('small',  SMALL_JSON,  50_000)
jsonGroup('medium', MEDIUM_JSON, 10_000)
jsonGroup('large',  LARGE_JSON,  2_000)

// ---------------------------------------------------------------------------
// CSV benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== CSV parsing ===')

function csvGroup(label: string, input: string, iters: number) {
  const rows = input.split('\n').length - 1
  console.log(`\n  [${label}] ${input.length} bytes, ${rows} rows`)
  bench('Parmésan (interpreter)',     () => parseCSV(input), iters)
  bench('Parmésan (compiled)',   () => compiledCSV.parse(input), iters)
  bench('Parsimmon',             () => parsimmonCSV(input), iters)
  bench('Peggy',                 () => peggyCSV(input), iters)
}

csvGroup('small', SMALL_CSV, 50_000)
csvGroup('large', LARGE_CSV, 5_000)

console.log()
