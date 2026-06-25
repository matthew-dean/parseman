/**
 * parseman benchmark suite
 *
 * Compares:
 *   - parseman interpreter (runtime)
 *   - parseman compiled (via compile())
 *   - Chevrotain
 *   - Parsimmon
 *   - Peggy (code-generating PEG parser)
 *   - Nearley (json.ne upstream; csv.ne + graphql.ne ported from Peggy for parity)
 *   - Jison (JSON + GraphQL grammars with value-building semantic actions)
 *   - JSON.parse() (native baseline for JSON)
 *
 * Run:  node --import tsx bench/run.ts
 *       OR: pnpm bench
 */
import { parseJSON, jsonDoc } from '../examples/json/parser.ts'
import { buildParsermanCSTJSON, buildParsermanCSTJSONNoTriv } from './parseman-cst-json.ts'
import { parseCSV, compiledCSV, csvParser } from '../examples/csv/parser.ts'
import { parseConfig, compiledConfig } from '../examples/toml-ish/parser.ts'
import { parseGraphQL, graphqlDoc } from '../examples/graphql/parser.ts'
import { buildCombinatorInliningCases, benchCase } from './combinator-inlining.ts'
import {
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
} from './fixtures.ts'
import { loadBaseline, printParsemanReport, runParsemanSuite } from './parseman-perf.ts'
import { compile } from '../src/index.ts'
import { buildChevrotainJSON } from './chevrotain-json.ts'
import { buildChevrotainCSV } from './chevrotain-csv.ts'
import { buildChevrotainGraphQL } from './chevrotain-graphql.ts'
import { buildParsimmonJSON } from './parsimmon-json.ts'
import { buildParsimmonCSV } from './parsimmon-csv.ts'
import { buildParsimmonGraphQL } from './parsimmon-graphql.ts'
import { buildPeggyJSON } from './peggy-json.ts'
import { buildPeggyCSV } from './peggy-csv.ts'
import { buildPeggyGraphQL } from './peggy-graphql.ts'
import { buildNearleyJSON, initNearleyJSON } from './nearley-json.ts'
import { buildNearleyCSV, initNearleyCSV } from './nearley-csv.ts'
import { buildNearleyGraphQL, initNearleyGraphQL } from './nearley-graphql.ts'
import { buildJisonJSON, initJisonJSON } from './jison-json.ts'
import { buildJisonGraphQL, initJisonGraphQL } from './jison-graphql.ts'

// ---------------------------------------------------------------------------
// Compiled parsers (built once, reused across bench runs)
// ---------------------------------------------------------------------------
const parsermanCSTJSON       = buildParsermanCSTJSON()
const parsermanCSTJSONNoTriv = buildParsermanCSTJSONNoTriv()
const compiledJSON           = compile(jsonDoc)
const compiledGraphQL   = compile(graphqlDoc)
const chevrotainJSON    = buildChevrotainJSON()
const chevrotainCSV     = buildChevrotainCSV()
const chevrotainGQL     = buildChevrotainGraphQL()
const parsimmonJSON     = buildParsimmonJSON()
const parsimmonCSV      = buildParsimmonCSV()
const parsimmonGQL      = buildParsimmonGraphQL()
const peggyJSON         = buildPeggyJSON()
const peggyCSV          = buildPeggyCSV()
const peggyGQL          = buildPeggyGraphQL()
const nearleyJSON       = buildNearleyJSON()
const nearleyCSV        = buildNearleyCSV()
const nearleyGQL        = buildNearleyGraphQL()
const jisonJSON         = buildJisonJSON()
const jisonGQL          = buildJisonGraphQL()

// ---------------------------------------------------------------------------
// Fixtures (shared with parseman-perf.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Benchmark runners
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

function setupBench(name: string, fn: () => unknown, iterations = 500): number {
  for (let i = 0; i < Math.min(iterations / 10, 20); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const us = (performance.now() - start) / iterations * 1000
  console.log(`  ${name.padEnd(36)} ${us.toFixed(1)}µs`)
  return us
}

// ---------------------------------------------------------------------------
// Initialization benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== Parser initialization (one-time cost) ===')

console.log('\n  [JSON]')
setupBench('Parséman (.compile())', () => compile(jsonDoc),         500)
setupBench('Chevrotain',             () => buildChevrotainJSON(),    50)
setupBench('Parsimmon',              () => buildParsimmonJSON(),     20_000)
setupBench('Peggy',                  () => buildPeggyJSON(),         20_000)
setupBench('Nearley',                () => initNearleyJSON(),       20_000)
setupBench('Jison',                  () => initJisonJSON(),         20_000)

console.log('\n  [CSV]')
setupBench('Parséman (.compile())', () => compile(csvParser),       500)
setupBench('Chevrotain',             () => buildChevrotainCSV(),     50)
setupBench('Parsimmon',              () => buildParsimmonCSV(),      20_000)
setupBench('Peggy',                  () => buildPeggyCSV(),          20_000)
setupBench('Nearley',                () => initNearleyCSV(),        20_000)

console.log('\n  [GraphQL]')
setupBench('Parséman (.compile())', () => compile(graphqlDoc),      200)
setupBench('Chevrotain',             () => buildChevrotainGraphQL(), 30)
setupBench('Parsimmon',              () => buildParsimmonGraphQL(),  20_000)
setupBench('Peggy',                  () => buildPeggyGraphQL(),      20_000)
setupBench('Nearley',                () => initNearleyGraphQL(),     20_000)
setupBench('Jison',                  () => initJisonGraphQL(),      20_000)

// ---------------------------------------------------------------------------
// JSON warm-parse benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== JSON parsing (warm) ===')

function jsonGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parséman (macro build)',  () => compiledJSON.parse(input, 0), iters)
  bench('Parséman (no compile)',   () => parseJSON(input), iters)
  bench('Chevrotain',              () => chevrotainJSON(input), iters)
  bench('Parsimmon',               () => parsimmonJSON(input), iters)
  bench('Peggy',                   () => peggyJSON(input), iters)
  bench('Nearley',                 () => nearleyJSON(input), iters)
  bench('Jison',                   () => jisonJSON(input), iters)
  bench('JSON.parse (native)',     () => JSON.parse(input), iters)
}

jsonGroup('small',  SMALL_JSON,  50_000)
jsonGroup('medium', MEDIUM_JSON, 10_000)
jsonGroup('large',  LARGE_JSON,  2_000)

// ---------------------------------------------------------------------------
// CST JSON benchmarks — measures trivia-capture overhead vs Chevrotain CstParser
// ---------------------------------------------------------------------------
console.log('\n=== CST JSON parsing (warm) — interpreter, tree-building ===')

function cstJsonGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parséman CST (with trivia)',    () => parsermanCSTJSON(input),       iters)
  bench('Parséman CST (no trivia)',      () => parsermanCSTJSONNoTriv(input), iters)
  bench('Chevrotain CST',                () => chevrotainJSON(input),         iters)
}

cstJsonGroup('small',  SMALL_JSON,  50_000)
cstJsonGroup('medium', MEDIUM_JSON, 10_000)
cstJsonGroup('large',  LARGE_JSON,  2_000)

// ---------------------------------------------------------------------------
// CSV warm-parse benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== CSV parsing (warm) ===')

function csvGroup(label: string, input: string, iters: number) {
  const rows = input.split('\n').length - 1
  console.log(`\n  [${label}] ${input.length} bytes, ${rows} rows`)
  bench('Parséman (macro build)',  () => compiledCSV.parse(input), iters)
  bench('Parséman (no compile)',   () => parseCSV(input), iters)
  bench('Chevrotain',              () => chevrotainCSV(input), iters)
  bench('Parsimmon',               () => parsimmonCSV(input), iters)
  bench('Peggy',                   () => peggyCSV(input), iters)
  bench('Nearley',                 () => nearleyCSV(input), iters)
}

csvGroup('small', SMALL_CSV, 50_000)
csvGroup('large', LARGE_CSV, 5_000)

// ---------------------------------------------------------------------------
// GraphQL warm-parse benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== GraphQL parsing (warm) ===')

function gqlGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parséman (macro build)',  () => compiledGraphQL.parse(input), iters)
  bench('Parséman (no compile)',   () => parseGraphQL(input), iters)
  bench('Chevrotain',              () => chevrotainGQL(input), iters)
  bench('Parsimmon',               () => parsimmonGQL(input), iters)
  bench('Peggy',                   () => peggyGQL(input), iters)
  bench('Nearley',                 () => nearleyGQL(input), iters)
  bench('Jison',                   () => jisonGQL(input), iters)
}

gqlGroup('small',  SMALL_GQL,  50_000)
gqlGroup('medium', MEDIUM_GQL, 10_000)
gqlGroup('large',  LARGE_GQL,  2_000)

// ---------------------------------------------------------------------------
// Combinator inlining micro-benchmarks (interpreted vs compile())
// ---------------------------------------------------------------------------
console.log('\n=== Combinator inlining (interpreted vs compiled) ===')
for (const c of buildCombinatorInliningCases()) {
  const { interpretedUs, compiledUs, speedup } = benchCase(c, 20_000)
  console.log(
    `  ${c.name.padEnd(32)} interp ${interpretedUs.toFixed(2)}µs  compiled ${compiledUs.toFixed(2)}µs  ${speedup.toFixed(2)}×`,
  )
}

// ---------------------------------------------------------------------------
// Parseman-only suite — interpreted vs compiled, all example grammars + baseline Δ
// ---------------------------------------------------------------------------
const parsemanRows = runParsemanSuite()
printParsemanReport(parsemanRows, loadBaseline())

console.log()
