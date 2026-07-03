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
import { jsonDoc } from '../examples/json/parser.ts'
import { csvParser } from '../examples/csv/parser.ts'
import { graphqlDoc } from '../examples/graphql/parser.ts'
import { buildCombinatorInliningCases, benchCase } from './combinator-inlining.ts'
import { printCodegenAb } from './codegen-ab.ts'
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
import { initNearleyJSON } from './nearley-json.ts'
import { initNearleyCSV } from './nearley-csv.ts'
import { initNearleyGraphQL } from './nearley-graphql.ts'
import { initJisonJSON } from './jison-json.ts'
import { initJisonGraphQL } from './jison-graphql.ts'
import { SCENARIOS as INC_SCENARIOS, makeParsemanIncremental, makeLezerIncremental } from './incremental.ts'
import { warmUs, setupUs } from './measure.ts'
import * as P from './parsers.ts'

// ---------------------------------------------------------------------------
// Fixtures (shared with parseman-perf.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Benchmark runners
// ---------------------------------------------------------------------------
function bench(name: string, fn: () => unknown, iterations = 10_000): number {
  const us = warmUs(fn, iterations)
  const ops = Math.round(iterations / (us / 1000))
  console.log(`  ${name.padEnd(36)} ${String(ops).padStart(9)} ops/s  (${us.toFixed(2)}µs/op)`)
  return ops
}

function setupBench(name: string, fn: () => unknown, iterations = 500): number {
  const us = setupUs(fn, iterations)
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
  bench('Parséman (macro build)',  () => P.compiledJSON.parse(input, 0), iters)
  bench('Parséman (no compile)',   () => P.parseJSON(input), iters)
  bench('Chevrotain',              () => P.chevrotainJSON(input), iters)
  bench('Parsimmon',               () => P.parsimmonJSON(input), iters)
  bench('Peggy',                   () => P.peggyJSON(input), iters)
  bench('Nearley',                 () => P.nearleyJSON(input), iters)
  bench('Jison',                   () => P.jisonJSON(input), iters)
  bench('JSON.parse (native)',     () => JSON.parse(input), iters)
}

jsonGroup('small',  SMALL_JSON,  50_000)
jsonGroup('medium', MEDIUM_JSON, 10_000)
jsonGroup('large',  LARGE_JSON,  2_000)

// ---------------------------------------------------------------------------
// CST JSON benchmarks — measures trivia-capture overhead vs Chevrotain CstParser
// ---------------------------------------------------------------------------
console.log('\n=== CST JSON parsing (warm) — syntax tree building ===')
console.log('  (Parséman/Chevrotain: object CST + spans; Lezer: compact buffer tree)')

function cstJsonGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parséman CST (macro build)', () => P.parsermanCSTCompiled(input),    iters)
  bench('Parséman CST (interpreter)', () => P.parsermanCSTJSONNoTriv(input), iters)
  bench('Chevrotain CST',             () => P.chevrotainJSON(input),        iters)
  bench('Lezer (parse only)',         () => P.lezerJSONParse(input),         iters)
  bench('Lezer (parse + walk)',       () => P.lezerJSON(input),             iters)
}

cstJsonGroup('small',  SMALL_JSON,  50_000)
cstJsonGroup('medium', MEDIUM_JSON, 10_000)
cstJsonGroup('large',  LARGE_JSON,  2_000)

// ---------------------------------------------------------------------------
// Incremental re-parse — Parséman parseDoc vs Lezer fragment reuse
// ---------------------------------------------------------------------------
console.log('\n=== Incremental re-parse (12 kB nested JSON) — edit + re-parse ===')
console.log('  (both produce a span-correct tree; full reparse shown as the baseline)')

for (const s of INC_SCENARIOS) {
  console.log(`\n  [${s.name}]`)
  const pm = makeParsemanIncremental(s)
  const lz = makeLezerIncremental(s)
  bench('Parséman incremental',  pm.incremental,  20_000)
  bench('Lezer incremental',     lz.incremental,  20_000)
  bench('Parséman full reparse', pm.fullReparse,  2_000)
  bench('Lezer full reparse',    lz.fullReparse,  2_000)
}

// ---------------------------------------------------------------------------
// CSV warm-parse benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== CSV parsing (warm) ===')

function csvGroup(label: string, input: string, iters: number) {
  const rows = input.split('\n').length - 1
  console.log(`\n  [${label}] ${input.length} bytes, ${rows} rows`)
  bench('Parséman (macro build)',  () => P.compiledCSV.parse(input), iters)
  bench('Parséman (no compile)',   () => P.parseCSV(input), iters)
  bench('Chevrotain',              () => P.chevrotainCSV(input), iters)
  bench('Parsimmon',               () => P.parsimmonCSV(input), iters)
  bench('Peggy',                   () => P.peggyCSV(input), iters)
  bench('Nearley',                 () => P.nearleyCSV(input), iters)
}

csvGroup('small', SMALL_CSV, 50_000)
csvGroup('large', LARGE_CSV, 5_000)

// ---------------------------------------------------------------------------
// GraphQL warm-parse benchmarks
// ---------------------------------------------------------------------------
console.log('\n=== GraphQL parsing (warm) ===')

function gqlGroup(label: string, input: string, iters: number) {
  console.log(`\n  [${label}] ${input.length} bytes`)
  bench('Parséman (macro build)',  () => P.compiledGraphQL.parse(input), iters)
  bench('Parséman (no compile)',   () => P.parseGraphQL(input), iters)
  bench('Chevrotain',              () => P.chevrotainGQL(input), iters)
  bench('Parsimmon',               () => P.parsimmonGQL(input), iters)
  bench('Peggy',                   () => P.peggyGQL(input), iters)
  bench('Nearley',                 () => P.nearleyGQL(input), iters)
  bench('Jison',                   () => P.jisonGQL(input), iters)
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
// Codegen A/B — isolate regex scan lowering + switch dispatch (same process)
// ---------------------------------------------------------------------------
printCodegenAb()

// ---------------------------------------------------------------------------
// Parseman-only suite — interpreted vs compiled, all example grammars + baseline Δ
// ---------------------------------------------------------------------------
console.log('\n=== Parseman perf — interpreted vs compiled (all example grammars) ===')
const parsemanRows = runParsemanSuite({
  onProgress: (id, mode) => process.stdout.write(`  measuring ${id} (${mode})…\r`),
})
printParsemanReport(parsemanRows, loadBaseline(), { skipTitle: true })

console.log()
