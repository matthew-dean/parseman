/**
 * Paired A/B for the `ParseContext` hidden-class change.
 *
 *   node --import tsx/esm bench/ctx-shape-ab.ts --ref=<sha> [--head-ref=<sha>] [--self]
 *
 * ## Why this exists rather than `perf:workloads`
 *
 * The broad gate drives every workload with `compiled.parseWithContext(input,
 * { trackLines: false, _triviaLog: [] }, 0)` — a `ParseContext` the BENCHMARK
 * builds. It therefore never constructs one through the runtime, and a change to
 * how the runtime constructs `ctx` is invisible to it by construction. Reading
 * flat there is the expected result, not evidence of neutrality.
 *
 * These cases enter through `run()`, which is where `ctx` is built, across the
 * three configurations the change is claimed over — including selected root
 * trivia, the configuration a previous lane measured at +52% with `delete` and
 * the one `bench/ctx-shape-probe.ts` found in DICTIONARY MODE at the base.
 *
 * ## Instrument
 *
 * Reuses `bench/ab-harness.ts` unchanged, so the load-bearing properties are the
 * gate's, not this file's: both sides in ONE process, interleaved and
 * order-alternated, both RECOMPILED per pass, alternating which side compiles
 * first, and a NULL control of two reference instances measured in the same
 * passes and positions. Absolutes across separate process launches are not
 * comparable and are not reported.
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  materialise, calibrate, assertSameParse, measurePasses, verdicts, git, fail, sign,
  type Case, type Thresholds,
} from './ab-harness.ts'

const GATE = 'ctx-shape-ab'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name: string): string | null => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(name.length + 3)
}

const SELF = process.argv.includes('--self')
const REF = arg('ref')
const HEAD_REF = SELF ? REF : arg('head-ref')
if (REF === null) fail(GATE, 'pass --ref=<sha>: there is nothing to compare against.')

const QUICK = process.argv.includes('--quick')
const M = {
  targetSampleMs: 40,
  warmup: 6,
  timed: 11,
  rounds: QUICK ? 2 : 4,
  runs: QUICK ? 1 : 3,
  passes: QUICK ? 2 : 5,
}

/**
 * Thresholds are for REPORTING shape only — this file is a measurement, not a
 * gate, and it exits 0 either way. The verdict columns still want them.
 */
const T: Thresholds = {
  medianPct: 5,
  minPct: 5,
  winRateCeiling: 0.25,
  signTest: { winRateCeiling: 0.15, medianPct: 1.5, minPct: 1.5 },
}

/** Copied onto both sides so the cases are byte-identical across them. */
const COPY = ['bench/ctx-shape-cases.ts', 'bench/workloads', 'examples'] as const

type BuiltCase = { id: string; bytes: number; make: () => { parse: () => unknown } }

async function loadSide(dir: string): Promise<BuiltCase[]> {
  const mod = await import(path.join(dir, 'bench', 'ctx-shape-cases.ts')) as {
    buildCases: () => BuiltCase[]
  }
  return mod.buildCases()
}

function toCases(built: readonly BuiltCase[]): Case[] {
  return built.map(c => {
    const made = c.make()
    return {
      id: c.id,
      detail: `${(c.bytes / 1024).toFixed(0)} KB`,
      parse: () => made.parse(),
      run: (reps: number) => { for (let n = 0; n < reps; n++) made.parse() },
    }
  })
}

const headSha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim()
const refDir = materialise(GATE, ROOT, REF, COPY)
const headDir = materialise(GATE, ROOT, HEAD_REF, COPY)

console.log(
  `${GATE}: ${SELF
    ? `SELF-CHECK — ${REF} against itself (noise floor, not a result)`
    : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`}`,
)

const refBuilt = await loadSide(refDir)
const headBuilt = await loadSide(headDir)

const refCases = toCases(refBuilt)
const headCases = toCases(headBuilt)
assertSameParse(GATE, refCases, headCases, false)
const detail = new Map(refCases.map(c => [c.id, c.detail]))

const reps = calibrate(toCases(refBuilt), M)
console.log(
  `  ${refCases.length} cases`
  + `   ${M.passes} passes x ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples,`
  + ` sides paired and order-alternated${QUICK ? '  [--quick: TRIAGE ONLY]' : ''}`,
)
console.log(`  parses per sample: ${refCases.map(c => `${c.id} ${reps.get(c.id)}`).join(', ')}`)

const load0 = os.loadavg()[0] ?? 0
const { passRows, calibration } = measurePasses(
  () => toCases(refBuilt), () => toCases(headBuilt), reps, M, T,
)
const load1 = os.loadavg()[0] ?? 0
const rows = verdicts(passRows)

console.log(`\nper-case result over ${M.passes} independent passes, both sides RECOMPILED each pass`)
console.log('  negative = HEAD faster. Judge every number against the measured null below.\n')
for (const v of rows) {
  const worst = v.passes.reduce((a, b) => (b.dMedian > a.dMedian ? b : a))
  const best = v.passes.reduce((a, b) => (b.dMedian < a.dMedian ? b : a))
  console.log(
    `  ${v.failed ? 'SLOW' : 'ok  '}  ${v.id.padEnd(16)} ${(detail.get(v.id) ?? '').padStart(6)}`
    + `   median ${sign(best.dMedian)} … ${sign(worst.dMedian)}`
    + `   min ${sign(Math.min(...v.passes.map(r => r.dMin)))} … ${sign(Math.max(...v.passes.map(r => r.dMin)))}`
    + `   won ${v.passes.map(r => `${r.wins}/${r.pairs}`).join(' ')}`
    + `   breached ${v.breachCount}/${M.passes}`,
  )
}

console.log('\nmeasured NULL — two REFERENCE instances, identical code, same passes and positions.')
console.log('Every number in this block is instrument, not compiler.\n')
for (const v of rows) {
  const k = calibration.get(v.id)!
  console.log(
    `        ${v.id.padEnd(16)} ${(detail.get(v.id) ?? '').padStart(6)}`
    + `   null won ${String(k.wins).padStart(3)}/${k.pairs} = ${(k.nullRate * 100).toFixed(1).padStart(5)}%`
    + `   worst null median ${sign(k.worstNullMedian).padStart(7)}`
    + `   ceiling ${(k.ceiling * 100).toFixed(1).padStart(5)}%`,
  )
}
console.log(`\n  load average ${load0.toFixed(2)} -> ${load1.toFixed(2)}`)
