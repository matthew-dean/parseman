/**
 * One timed parser in a process of its own, for `bench/xproc-gate.ts`.
 *
 * The gate bundles this file once with esbuild. Every import of parseman's
 * `src/index.ts` becomes the side's own `./dist/index.js`, built by that side's
 * `scripts/build.mjs`: the same bundle a user installs. The gate then runs it with plain
 * `node`, with no flags, no loader, and no `NODE_*` variable in its environment. This file refuses to measure
 * if any of those got in anyway.
 */
import { createHash } from 'node:crypto'
import { buildWorkloads } from './workloads/index.ts'
import { DENSITY_CASES, caseGrammar, caseInput } from './grammar-density/grammar.ts'
import { compile, run } from '../src/index.ts'
import { allTriviaParse, parsedTree, plainParse } from './all-trivia.ts'

type Args = {
  suite: 'density' | 'workloads'
  id: string
  /** Time the parse that records every trivia gap (`allTriviaParse`), not the plain one. */
  capture: boolean
  heapPad: number
  rules: number
  warmup: number
  /** Warm for at least this long as well as `warmup` parses: tiering finishes on a clock, not a count. */
  warmupMs: number
  samples: number
  parsesPerSample: number
}

const runtimeChanged = [
  process.execArgv.length > 0 ? `execArgv ${JSON.stringify(process.execArgv)}` : null,
  ...Object.keys(process.env).filter(k => k.startsWith('NODE_')).map(k => `${k}=${process.env[k]}`),
  process.sourceMapsEnabled ? 'source maps enabled' : null,
].filter(x => x !== null)
if (runtimeChanged.length > 0) {
  console.error(`xproc-worker: refusing to measure under a changed runtime: ${runtimeChanged.join('; ')}`)
  process.exit(2)
}

const a = JSON.parse(process.argv[2]!) as Args

// Layout randomisation, and the only thing here that is not the parse. A process is
// deterministic, so without it a side's paths and environment fix where every object and
// code page lands, and that offset reads as a speed difference. A retained allocation of
// random size, made before anything is built, moves everything after it.
;(globalThis as { __pmLayoutShift?: number[] }).__pmLayoutShift = Array.from({ length: a.heapPad }, () => 0)

let parse: () => unknown
if (a.suite === 'density') {
  const c = DENSITY_CASES.find(x => x.id === a.id)
  if (c === undefined) throw new Error(`no density case ${a.id}`)
  const compiled = compile(caseGrammar(c))
  const input = caseInput(c, a.rules)
  parse = a.capture ? allTriviaParse(run, compiled, input) : plainParse(compiled, input)
} else {
  const w = buildWorkloads().find(x => x.id === a.id)
  if (w === undefined) throw new Error(`no workload ${a.id}`)
  const make = a.capture ? w.capture : w.make
  if (make === undefined) throw new Error(`workload ${a.id} records no trivia`)
  const built = make()
  parse = () => built.parse()
}

const digest = createHash('sha256').update(JSON.stringify(parsedTree(parse()))).digest('hex').slice(0, 16)
const warmStart = performance.now()
for (let k = 0; k < a.warmup || performance.now() - warmStart < a.warmupMs; k++) parse()
const samples: number[] = []
for (let k = 0; k < a.samples; k++) {
  const t0 = performance.now()
  for (let n = 0; n < a.parsesPerSample; n++) parse()
  samples.push((performance.now() - t0) / a.parsesPerSample)
}
const sorted = [...samples].sort((x, y) => x - y)
const m = sorted.length >> 1
const median = sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2
console.log(JSON.stringify({ median, min: sorted[0]!, digest }))
