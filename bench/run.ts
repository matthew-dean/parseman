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
import { parseJSON, jsonDoc } from '../examples/json/parser.ts'
import { buildParsermanCSTJSON, buildParsermanCSTJSONNoTriv } from './parseman-cst-json.ts'
import { parseCSV, compiledCSV, csvParser } from '../examples/csv/parser.ts'
import { parseConfig, compiledConfig } from '../examples/toml-ish/parser.ts'
import { parseGraphQL, graphqlDoc } from '../examples/graphql/parser.ts'
import { parseCssCompiled, parseCss } from '../examples/css/parser.ts'
import { readCssFixture } from './css-fixture.ts'
import { buildCombinatorInliningCases, benchCase } from './combinator-inlining.ts'
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

// GraphQL fixtures — valid per the October 2021 spec
const SMALL_GQL = `{ user { name email age } }`
const MEDIUM_GQL = `
query GetData {
  user(id: 42) {
    name
    email
    posts {
      title
      body
      comments(limit: 10) {
        author
        text
        createdAt
      }
    }
    friends {
      name
      age
    }
  }
  account(active: true) {
    id
    role
    email
    permissions {
      read
      write
      admin
    }
  }
}`.trim()
const LARGE_GQL = Array.from({ length: 25 }, (_, i) => `
query Op${i}($id: ID!, $flag: Boolean) {
  node${i}(id: $id, page: ${i % 10}) {
    field1
    field2
    field3
    nested1 {
      sub1
      sub2
      sub3
      sub4
    }
    nested2(param: ${i * 2}, flag: $flag) {
      a
      b
      c
      d
      e
    }
    nested3 {
      deep1 { x y }
      deep2 { p q }
    }
  }
}`.trim()).join('\n')

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

console.log('\n  [CSV]')
setupBench('Parséman (.compile())', () => compile(csvParser),       500)
setupBench('Chevrotain',             () => buildChevrotainCSV(),     50)
setupBench('Parsimmon',              () => buildParsimmonCSV(),      20_000)
setupBench('Peggy',                  () => buildPeggyCSV(),          20_000)

console.log('\n  [GraphQL]')
setupBench('Parséman (.compile())', () => compile(graphqlDoc),      200)
setupBench('Chevrotain',             () => buildChevrotainGraphQL(), 30)
setupBench('Parsimmon',              () => buildParsimmonGraphQL(),  20_000)
setupBench('Peggy',                  () => buildPeggyGraphQL(),      20_000)

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
// CSS grammar (jess port) — node()-heavy CST + trivia capture
// ---------------------------------------------------------------------------
console.log('\n=== CSS parsing (warm) — jess grammar, CST + trivia ===')
try {
  const bootstrap = readCssFixture('bootstrap4.css')
  console.log(`\n  [bootstrap4] ${bootstrap.length} bytes`)
  bench('Parséman CSS (compiled, full)', () => parseCssCompiled(bootstrap), 30)
  bench('Parséman CSS (interpreted, full)', () => parseCss(bootstrap), 30)
} catch (e) {
  console.log(`  (skipped — ${(e as Error).message})`)
}
for (const fixture of ['selector.css', 'decls.css'] as const) {
  try {
    const src = readCssFixture(fixture)
    console.log(`\n  [${fixture}] ${src.length} bytes`)
    bench('Parséman CSS (compiled, full)', () => parseCssCompiled(src), 500)
    bench('Parséman CSS (interpreted, full)', () => parseCss(src), 500)
  } catch {
    // fixture missing
  }
}

console.log()
