/**
 * Parser-to-parser benchmark suite.
 *
 * Keep this runner focused on external parser comparison. Parseman-only perf,
 * codegen A/Bs, incremental parsing, and other micro-benchmarks have their own
 * scripts so perf-tweak loops can run the smallest relevant measurement.
 *
 * Run: pnpm bench
 */
import { jsonDoc } from '../examples/json/parser.ts'
import { csvParser } from '../examples/csv/parser.ts'
import { graphqlDoc } from '../examples/graphql/parser.ts'
import {
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
} from './fixtures.ts'
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
import { warmUs, setupUs } from './measure.ts'
import * as P from './parsers.ts'

function bench(name: string, fn: () => unknown, iterations = 10_000): void {
  const us = warmUs(fn, iterations)
  const ops = Math.round(iterations / (us / 1000))
  console.log(`  ${name.padEnd(36)} ${String(ops).padStart(9)} ops/s  (${us.toFixed(2)}µs/op)`)
}

function setupBench(name: string, fn: () => unknown, iterations = 500): void {
  const us = setupUs(fn, iterations)
  console.log(`  ${name.padEnd(36)} ${us.toFixed(1)}µs`)
}

console.log('\n=== Parser initialization (one-time cost) ===')

console.log('\n  [JSON]')
setupBench('Parséman (.compile())', () => compile(jsonDoc),         500)
setupBench('Chevrotain',             () => buildChevrotainJSON(),    50)
setupBench('Parsimmon',              () => buildParsimmonJSON(),     20_000)
setupBench('Peggy',                  () => buildPeggyJSON(),         20_000)
setupBench('Nearley',                () => initNearleyJSON(),        20_000)
setupBench('Jison',                  () => initJisonJSON(),          20_000)

console.log('\n  [CSV]')
setupBench('Parséman (.compile())', () => compile(csvParser),       500)
setupBench('Chevrotain',             () => buildChevrotainCSV(),     50)
setupBench('Parsimmon',              () => buildParsimmonCSV(),      20_000)
setupBench('Peggy',                  () => buildPeggyCSV(),          20_000)
setupBench('Nearley',                () => initNearleyCSV(),         20_000)

console.log('\n  [GraphQL]')
setupBench('Parséman (.compile())', () => compile(graphqlDoc),      200)
setupBench('Chevrotain',             () => buildChevrotainGraphQL(), 30)
setupBench('Parsimmon',              () => buildParsimmonGraphQL(),  20_000)
setupBench('Peggy',                  () => buildPeggyGraphQL(),      20_000)
setupBench('Nearley',                () => initNearleyGraphQL(),     20_000)
setupBench('Jison',                  () => initJisonGraphQL(),       20_000)

console.log('\n=== JSON parsing (warm) ===')

function jsonGroup(label: string, input: string, iters: number): void {
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

console.log('\n=== CSV parsing (warm) ===')

function csvGroup(label: string, input: string, iters: number): void {
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

console.log('\n=== GraphQL parsing (warm) ===')

function gqlGroup(label: string, input: string, iters: number): void {
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
