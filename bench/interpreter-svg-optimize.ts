/**
 * Optimization harness for the lightweight combinator interpreter.
 *
 * It reuses the exact one-bar child used by the published SVG charts, runs each
 * engine in a fresh process, and compares only Parséman's interpreter with
 * Chevrotain. A second interpreter leg is an in-run A/A control. The browser
 * bundle measurement uses the existing Chevrotain benchmark interpreter entry,
 * which represents a consumer bundling a grammar from the public root API.
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
import { build } from 'esbuild'
import { CHART_GROUPS, type ChartKey } from './chart-specs.ts'
import {
  assertInterpreterChecks, INTERPRETER_BROWSER_RAW_LIMIT, measureInterpreterBar,
} from './interpreter-optimize-support.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CHILD = resolve(ROOT, 'bench/measure-bar.ts')
const BROWSER_ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
const CHARTS: ChartKey[] = ['json', 'csv', 'graphql', 'cst']
const WIN_FLOOR = 1.05
const require = createRequire(import.meta.url)

function numericArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = Number(process.argv[i + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
  return value
}

const assertedSlowdown = numericArg('assert-interpreter-slowdown', 1)
const assertedExtraBytes = numericArg('assert-extra-browser-bytes', Number.EPSILON) === Number.EPSILON
  ? 0
  : numericArg('assert-extra-browser-bytes', 0)

function measureBar(chart: ChartKey, key: 'parseman-interp' | 'chevrotain'): number[] {
  return measureInterpreterBar(ROOT, CHILD, chart, key)
}

function geomean(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
}

function rotated<T>(values: readonly T[], by: number): T[] {
  return [...values.slice(by), ...values.slice(0, by)]
}

const interpreterSources: Record<ChartKey, string> = {
  json: 'examples/json/parser.ts',
  csv: 'examples/csv/parser.ts',
  graphql: 'examples/graphql/parser.ts',
  cst: 'bench/parseman-cst-json.ts',
}
const chevrotainSources: Record<ChartKey, string> = {
  json: 'bench/chevrotain-json.ts',
  csv: 'bench/chevrotain-csv.ts',
  graphql: 'bench/chevrotain-graphql.ts',
  cst: 'bench/chevrotain-cst-json.ts',
}

type Leg = 'parseman-interp' | 'chevrotain' | 'parseman-interp-control'
const timings = {} as Record<ChartKey, Record<Leg, number[]>>
const orders = {} as Record<ChartKey, Leg[]>

for (const chart of CHARTS) {
  const legs: Leg[] = ['parseman-interp', 'chevrotain', 'parseman-interp-control']
  const order = rotated(legs, randomInt(legs.length))
  orders[chart] = order
  const chartTimings = {} as Record<Leg, number[]>
  for (const leg of order) {
    const key = leg === 'chevrotain' ? 'chevrotain' : 'parseman-interp'
    chartTimings[leg] = measureBar(chart, key)
  }
  timings[chart] = chartTimings
}

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
const heavyDependencyPattern = /(?:^|\/)(?:oxc-parser|oxc-resolver|magic-string|unplugin)(?:\/|$)/

const ratiosByChart = {} as Record<ChartKey, number[]>
const allRatios: number[] = []
let aaWorstSwing = 1
for (const chart of CHARTS) {
  const subject = timings[chart]['parseman-interp']
  const control = timings[chart]['parseman-interp-control']
  const rival = timings[chart].chevrotain
  ratiosByChart[chart] = rival.map((value, i) => value / (subject[i]! * assertedSlowdown))
  allRatios.push(...ratiosByChart[chart])
  for (let i = 0; i < subject.length; i++) {
    aaWorstSwing = Math.max(aaWorstSwing, subject[i]! / control[i]!, control[i]! / subject[i]!)
  }
}

const provenance = {
  harness: realpathSync(import.meta.filename),
  chart_child: realpathSync(CHILD),
  browser_entry: realpathSync(BROWSER_ENTRY),
  engines: CHARTS.flatMap(chart => [
    { chart, engine: 'parseman combinator interpreter', source: realpathSync(resolve(ROOT, interpreterSources[chart])) },
    { chart, engine: 'Chevrotain', source: realpathSync(resolve(ROOT, chevrotainSources[chart])) },
  ]),
  chevrotain_package: realpathSync(require.resolve('chevrotain')),
  order: orders,
  win_floor: WIN_FLOOR,
  assertions: {
    interpreter_slowdown: assertedSlowdown,
    extra_browser_bytes: assertedExtraBytes,
  },
}

const result = {
  provenance,
  measurement_valid: 1,
  browser_heavy_dependency_modules: browserInputs.filter(input => heavyDependencyPattern.test(input)).length,
  browser_node_builtin_modules: browserInputs.filter(input => builtinNames.has(input)).length,
  chevrotain_geomean_ratio: geomean(allRatios),
  chevrotain_rows_won: allRatios.filter(ratio => ratio >= WIN_FLOOR).length,
  interpreter_browser_raw_bytes: browserBytes.length + assertedExtraBytes,
  json_chevrotain_geomean_ratio: geomean(ratiosByChart.json),
  csv_chevrotain_geomean_ratio: geomean(ratiosByChart.csv),
  graphql_chevrotain_geomean_ratio: geomean(ratiosByChart.graphql),
  cst_chevrotain_geomean_ratio: geomean(ratiosByChart.cst),
  interpreter_browser_gzip_bytes: gzipSync(browserBytes).length,
  interpreter_browser_module_count: browserInputs.length,
  aa_worst_swing_ratio: aaWorstSwing,
  rows: Object.fromEntries(CHARTS.map(chart => [chart, CHART_GROUPS[chart].map((group, i) => ({
    group: group.title,
    parseman_interpreter_us: timings[chart]['parseman-interp'][i],
    parseman_interpreter_control_us: timings[chart]['parseman-interp-control'][i],
    chevrotain_us: timings[chart].chevrotain[i],
    ratio: ratiosByChart[chart][i],
  }))])),
  browser_inputs: browserInputs,
}

process.stdout.write(`${JSON.stringify(result)}\n`)
assertInterpreterChecks([
  [aaWorstSwing <= 1.05, `interpreter A/A swing ${aaWorstSwing.toFixed(3)} exceeds 1.05`],
  [result.interpreter_browser_raw_bytes <= INTERPRETER_BROWSER_RAW_LIMIT,
    `browser bundle ${result.interpreter_browser_raw_bytes} exceeds ${INTERPRETER_BROWSER_RAW_LIMIT} raw bytes`],
  [result.browser_heavy_dependency_modules === 0, 'browser bundle includes a heavy dependency'],
  [result.browser_node_builtin_modules === 0, 'browser bundle includes a Node builtin'],
  [result.chevrotain_geomean_ratio >= 1,
    `interpreter aggregate trails Chevrotain at ${result.chevrotain_geomean_ratio.toFixed(3)}x`],
])
