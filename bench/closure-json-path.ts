/**
 * Warm, single-process characterization of the compact table assembly on the
 * public JSON grammar.  Set PM_TABLE_EMIT=0 *before loading this module* to
 * exercise the closure assembly; leave it unset for the runtime-emitted path.
 *
 * This deliberately validates full consumption and value identity outside the
 * timed loop.  A faster prefix parser is not a useful data point.
 */
import { compile } from '../src/index.ts'
import { jsonDoc } from '../examples/json/parser.ts'
import { LARGE_JSON } from './fixtures.ts'

const parser = compile(jsonDoc)
const want = JSON.stringify(JSON.parse(LARGE_JSON))
const first = parser.parse(LARGE_JSON)
if (!first.ok || first.span.end !== LARGE_JSON.length || JSON.stringify(first.value) !== want) {
  throw new Error('closure-json-path: parser did not fully produce the JSON value')
}

const runs = Number(process.env.PM_BENCH_RUNS ?? '9')
const targetMs = Number(process.env.PM_BENCH_TARGET_MS ?? '40')
for (let i = 0; i < 200; i++) parser.parse(LARGE_JSON)

const pilotStart = performance.now()
for (let i = 0; i < 20; i++) parser.parse(LARGE_JSON)
const pilotMs = (performance.now() - pilotStart) / 20
const reps = Math.max(1, Math.round(targetMs / Math.max(pilotMs, 0.01)))
const samples: number[] = []
for (let s = 0; s < runs; s++) {
  const t0 = performance.now()
  for (let i = 0; i < reps; i++) parser.parse(LARGE_JSON)
  samples.push((performance.now() - t0) * 1000 / reps)
}
samples.sort((a, b) => a - b)
console.log(JSON.stringify({
  path: process.env.PM_TABLE_EMIT === '0' ? 'closure' : 'emitted',
  inputBytes: LARGE_JSON.length,
  reps,
  minUs: samples[0],
  medianUs: samples[Math.floor(samples.length / 2)],
  samples,
}))
