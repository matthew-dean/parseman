/**
 * Focused optimization harness for interpreted GraphQL chart parity.
 *
 * Each parser runs through the exact fresh-process child used by the published
 * SVG. The faster of Chevrotain and Peggy is the competitor for each row, so
 * the target follows the next external parser rather than naming one library.
 * A second Parseman leg is the in-run A/A control.
 *
 * Deliberate-red checks:
 *   --assert-interpreter-slowdown 100
 *   --assert-extra-browser-bytes 100000
 */
import { randomInt } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { build, type Metafile } from 'esbuild'
import { CHART_GROUPS } from './chart-specs.ts'
import {
  assertInterpreterChecks, INTERPRETER_AA_NOISE_LIMIT, INTERPRETER_BROWSER_RAW_LIMIT,
  measureInterpreterBar,
} from './interpreter-optimize-support.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CHILD = resolve(ROOT, 'bench/measure-bar.ts')
const BROWSER_ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
const require = createRequire(import.meta.url)

function numericArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = Number(process.argv[i + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`)
  return value
}

const slowdown = numericArg('assert-interpreter-slowdown', 1)
const extraBytes = numericArg('assert-extra-browser-bytes', Number.EPSILON) === Number.EPSILON
  ? 0
  : numericArg('assert-extra-browser-bytes', 0)

type ParserKey = 'parseman-interp' | 'chevrotain' | 'peggy'

function measure(key: ParserKey): number[] {
  return measureInterpreterBar(ROOT, CHILD, 'graphql', key)
}

function geomean(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
}

function emittedBytes(metafile: Metafile, input: string): number {
  return Object.values(metafile.outputs)
    .reduce((total, output) => total + (output.inputs[input]?.bytesInOutput ?? 0), 0)
}

type Leg = ParserKey | 'parseman-interp-control'
const legs: Leg[] = ['parseman-interp', 'chevrotain', 'peggy', 'parseman-interp-control']
const by = randomInt(legs.length)
const order = [...legs.slice(by), ...legs.slice(0, by)]
const timings = {} as Record<Leg, number[]>
for (const leg of order) timings[leg] = measure(leg === 'parseman-interp-control' ? 'parseman-interp' : leg)

const browser = await build({
  entryPoints: [BROWSER_ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  metafile: true,
  logLevel: 'silent',
})
const browserBytes = browser.outputFiles[0]!.contents
const browserInputs = Object.keys(browser.metafile.inputs).sort()
const builtinNames = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
const heavyDependency = /(?:^|\/)(?:oxc-parser|oxc-resolver|magic-string|unplugin)(?:\/|$)/
const allowedSharedCompilerModules = new Set([
  'src/compiler/build-arity.ts',
  'src/compiler/direct-projection.ts',
  'src/compiler/token-alphabet.ts',
  'src/compiler/token-capability.ts',
  'src/compiler/value-usage.ts',
])

const subject = timings['parseman-interp']
const control = timings['parseman-interp-control']
const chevrotain = timings.chevrotain
const peggy = timings.peggy
const competitor = chevrotain.map((value, i) => Math.min(value, peggy[i]!))
const competitorNames = chevrotain.map((value, i) => value <= peggy[i]! ? 'chevrotain' : 'peggy')
const ratios = competitor.map((value, i) => value / (subject[i]! * slowdown))
let aaWorst = 1
for (let i = 0; i < subject.length; i++) {
  aaWorst = Math.max(aaWorst, subject[i]! / control[i]!, control[i]! / subject[i]!)
}

const rawBytes = browserBytes.length + extraBytes
const tableExecutionModules = browserInputs.filter(input => {
  const bytes = emittedBytes(browser.metafile, input)
  if (bytes === 0) return false
  if (/src\/table\//.test(input)) return true
  return /src\/compiler\//.test(input) && !allowedSharedCompilerModules.has(input)
})

const result = {
  provenance: {
    harness: realpathSync(import.meta.filename),
    chart_child: realpathSync(CHILD),
    browser_entry: realpathSync(BROWSER_ENTRY),
    engines: [
      { engine: 'parseman combinator interpreter', source: realpathSync(resolve(ROOT, 'examples/graphql/parser.ts')) },
      { engine: 'Chevrotain', source: realpathSync(resolve(ROOT, 'bench/chevrotain-graphql.ts')) },
      { engine: 'Peggy', source: realpathSync(resolve(ROOT, 'bench/peggy-graphql.ts')) },
    ],
    packages: {
      chevrotain: realpathSync(require.resolve('chevrotain')),
      peggy: realpathSync(require.resolve('peggy')),
    },
    order,
    assertions: { interpreter_slowdown: slowdown, extra_browser_bytes: extraBytes },
  },
  measurement_valid: 1,
  graphql_rows_valid: ratios.length,
  aa_within_limit: aaWorst <= INTERPRETER_AA_NOISE_LIMIT ? 1 : 0,
  browser_within_limit: rawBytes <= INTERPRETER_BROWSER_RAW_LIMIT ? 1 : 0,
  browser_heavy_dependency_modules: browserInputs.filter(input => heavyDependency.test(input)).length,
  browser_node_builtin_modules: browserInputs.filter(input => builtinNames.has(input)).length,
  browser_table_execution_modules: tableExecutionModules.length,
  graphql_min_competitor_ratio: Math.min(...ratios),
  interpreter_browser_raw_bytes: rawBytes,
  graphql_small_competitor_ratio: ratios[0],
  graphql_medium_competitor_ratio: ratios[1],
  graphql_large_competitor_ratio: ratios[2],
  graphql_competitor_geomean_ratio: geomean(ratios),
  graphql_small_interpreter_us: subject[0],
  graphql_medium_interpreter_us: subject[1],
  graphql_large_interpreter_us: subject[2],
  graphql_small_competitor_us: competitor[0],
  graphql_medium_competitor_us: competitor[1],
  graphql_large_competitor_us: competitor[2],
  aa_worst_swing_ratio: aaWorst,
  interpreter_browser_gzip_bytes: gzipSync(browserBytes).length,
  interpreter_browser_module_count: browserInputs.length,
  rows: CHART_GROUPS.graphql.map((group, i) => ({
    group: group.title,
    parseman_interpreter_us: subject[i],
    parseman_interpreter_control_us: control[i],
    competitor: competitorNames[i],
    competitor_us: competitor[i],
    chevrotain_us: chevrotain[i],
    peggy_us: peggy[i],
    ratio: ratios[i],
  })),
  browser_inputs: browserInputs,
  browser_table_execution_inputs: tableExecutionModules,
}

process.stdout.write(`${JSON.stringify(result)}\n`)
assertInterpreterChecks([
  [result.graphql_rows_valid === CHART_GROUPS.graphql.length, 'not every GraphQL row produced a valid measurement'],
  [result.aa_within_limit === 1,
    `interpreter A/A swing ${aaWorst.toFixed(3)} exceeds ${INTERPRETER_AA_NOISE_LIMIT}`],
  [result.browser_within_limit === 1, `browser bundle ${rawBytes} exceeds ${INTERPRETER_BROWSER_RAW_LIMIT} raw bytes`],
  [result.browser_heavy_dependency_modules === 0, 'browser bundle includes a heavy dependency'],
  [result.browser_node_builtin_modules === 0, 'browser bundle includes a Node builtin'],
  [result.browser_table_execution_modules === 0, 'browser bundle includes table execution machinery'],
  [result.graphql_min_competitor_ratio >= 1, `interpreter loses a GraphQL row at ${result.graphql_min_competitor_ratio.toFixed(3)}x`],
])
