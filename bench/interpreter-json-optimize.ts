/**
 * Focused optimization harness for the only substantive interpreter chart loss:
 * JSON versus Chevrotain. It uses the exact fresh-process child and iteration
 * counts that feed the published SVG, plus an adjacent interpreter A/A control.
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
import { CHART_GROUPS } from './chart-specs.ts'
import {
  assertInterpreterChecks, INTERPRETER_AA_NOISE_LIMIT, INTERPRETER_BROWSER_RAW_LIMIT,
  measureInterpreterBar,
} from './interpreter-optimize-support.ts'

const ROOT = resolve(import.meta.dirname, '..')
const CHILD = resolve(ROOT, 'bench/measure-bar.ts')
const BROWSER_ENTRY = resolve(ROOT, 'scripts/chevrotain-bench-interpreter-entry.ts')
const PARITY_NOISE_FLOOR = 0.95
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

function measure(key: 'parseman-interp' | 'chevrotain'): number[] {
  return measureInterpreterBar(ROOT, CHILD, 'json', key)
}

function geomean(values: readonly number[]): number {
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
}

type Leg = 'parseman-interp' | 'chevrotain' | 'parseman-interp-control'
const legs: Leg[] = ['parseman-interp', 'chevrotain', 'parseman-interp-control']
const by = randomInt(legs.length)
const order = [...legs.slice(by), ...legs.slice(0, by)]
const timings = {} as Record<Leg, number[]>
for (const leg of order) timings[leg] = measure(leg === 'chevrotain' ? leg : 'parseman-interp')

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

const subject = timings['parseman-interp']
const control = timings['parseman-interp-control']
const rival = timings.chevrotain
const ratios = rival.map((value, i) => value / (subject[i]! * slowdown))
let aaWorst = 1
for (let i = 0; i < subject.length; i++) {
  aaWorst = Math.max(aaWorst, subject[i]! / control[i]!, control[i]! / subject[i]!)
}

const result = {
  provenance: {
    harness: realpathSync(import.meta.filename),
    chart_child: realpathSync(CHILD),
    browser_entry: realpathSync(BROWSER_ENTRY),
    engines: [
      { engine: 'parseman combinator interpreter', source: realpathSync(resolve(ROOT, 'examples/json/parser.ts')) },
      { engine: 'Chevrotain', source: realpathSync(resolve(ROOT, 'bench/chevrotain-json.ts')) },
    ],
    chevrotain_package: realpathSync(require.resolve('chevrotain')),
    order,
    parity_noise_floor: PARITY_NOISE_FLOOR,
    assertions: { interpreter_slowdown: slowdown, extra_browser_bytes: extraBytes },
  },
  measurement_valid: 1,
  browser_heavy_dependency_modules: browserInputs.filter(input => heavyDependency.test(input)).length,
  browser_node_builtin_modules: browserInputs.filter(input => builtinNames.has(input)).length,
  json_chevrotain_geomean_ratio: geomean(ratios),
  json_chevrotain_rows_at_parity: ratios.filter(ratio => ratio >= PARITY_NOISE_FLOOR).length,
  interpreter_browser_raw_bytes: browserBytes.length + extraBytes,
  interpreter_browser_gzip_bytes: gzipSync(browserBytes).length,
  interpreter_browser_module_count: browserInputs.length,
  aa_worst_swing_ratio: aaWorst,
  rows: CHART_GROUPS.json.map((group, i) => ({
    group: group.title,
    parseman_interpreter_us: subject[i],
    parseman_interpreter_control_us: control[i],
    chevrotain_us: rival[i],
    ratio: ratios[i],
  })),
  browser_inputs: browserInputs,
}

process.stdout.write(`${JSON.stringify(result)}\n`)
assertInterpreterChecks([
  [aaWorst <= INTERPRETER_AA_NOISE_LIMIT,
    `interpreter A/A swing ${aaWorst.toFixed(3)} exceeds ${INTERPRETER_AA_NOISE_LIMIT}`],
  [result.interpreter_browser_raw_bytes <= INTERPRETER_BROWSER_RAW_LIMIT,
    `browser bundle ${result.interpreter_browser_raw_bytes} exceeds ${INTERPRETER_BROWSER_RAW_LIMIT} raw bytes`],
  [result.browser_heavy_dependency_modules === 0, 'browser bundle includes a heavy dependency'],
  [result.browser_node_builtin_modules === 0, 'browser bundle includes a Node builtin'],
  [result.json_chevrotain_rows_at_parity === CHART_GROUPS.json.length,
    `interpreter reaches JSON parity on ${result.json_chevrotain_rows_at_parity}/${CHART_GROUPS.json.length} rows`],
])
