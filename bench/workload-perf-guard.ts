/**
 * parseman's BROAD performance gate: end-to-end parse time on realistic grammar
 * workloads.
 *
 * ## The failure this exists to fix
 *
 * Three consecutive Less parse regressions shipped without a gate catching one
 * of them:
 *
 *   0.34.0  `fix(not)`     six unconditional rollback stores      +33.9%
 *   0.35.0  the guard      repaid those                           −12.3%
 *   0.35.0  `fix(expect)`  derived expectations through nullables +49.6%
 *
 * `perf:guard` measures a 47-byte and a 34-byte microbenchmark, and read flat on
 * all three. `perf:guard:grammars` sweeps SPECULATIVE-ROLLBACK DENSITY, catches
 * the first two, and reads flat on the third — because `fix(expect)` regressed a
 * different axis, expected-set width, and a sweep parameterised on one axis only
 * ever catches that axis.
 *
 * That is not a bug in the density sweep. It is the structural limit of any
 * targeted gate: it can only see the regression someone already thought of.
 * `fix(expect)` is the proof — it was a CORRECTNESS fix to error-message quality,
 * it cost half of Less parse time because expected sets are built on every failed
 * arm rather than only when an error is reported, and nobody would have predicted
 * that from the diff.
 *
 * So this gate is deliberately NOT parameterised on anything. It parses realistic
 * stylesheets, documents and payloads with realistic grammars and reports the
 * time. A regression on ANY axis — one already known, or the next one — shows up
 * as time.
 *
 * ## Self-contained
 *
 * Everything it needs is in `bench/workloads/`: the grammars, the corpora, the
 * scaling. No sibling checkout, no clone, no network. `pnpm install && pnpm
 * perf:workloads` gives numbers. An earlier attempt at this cloned a downstream
 * repository and was rejected for exactly that reason: a gate a contributor
 * cannot run is a gate that does not run.
 *
 * ## Per-workload, never aggregated
 *
 * Replaying 0.34.0 through this gate, `css/stylesheet` moves −1.6% and
 * `less/stylesheet` moves +25.5% in the same process. Any mean of those passes.
 * Every row is thresholded on its own and the summary line names rows, not an
 * average.
 *
 * Usage:
 *   pnpm perf:workloads                       # the gate
 *   pnpm perf:workloads --quick               # 2 rounds x 1 run — TRIAGE ONLY, does not gate
 *   pnpm perf:workloads --only=less           # substring filter on workload id
 *   pnpm perf:workloads --ref=<sha>           # move the A side
 *   pnpm perf:workloads --head-ref=<sha>      # build the B side from a commit, not the working tree
 *   pnpm perf:workloads --self                # measure the noise floor: reference against ITSELF
 *   pnpm perf:workloads --allow-parse-diff    # replay-only: the pinned commit changed output on purpose
 *
 * The last three exist so a known regression can be REPLAYED and the gate watched
 * going red, and so the thresholds can be re-derived from measured noise on the
 * machine in front of you rather than inherited. A gate nobody has watched fail
 * is not known to work, and a threshold nobody has measured is a guess.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  materialise, calibrate, assertSameParse, interleave, score, verdicts, git, fail, sign,
  type Case, type Row, type Thresholds,
} from './ab-harness.ts'
import type { Workload } from './workloads/index.ts'

const GATE = 'workload-perf-guard'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(HERE, 'workloads', 'config.json')

/** `passes` is this gate's own: the shared harness measures, the gate decides. */
type GateMeasurement = import('./ab-harness.ts').Measurement & { passes: number }

type Config = {
  referenceSha: string
  measurement: GateMeasurement
  thresholds: Thresholds
}

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

const QUICK = process.argv.includes('--quick')
const SELF = process.argv.includes('--self')
const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
const REF = argValue('--ref') ?? CONFIG.referenceSha
const HEAD_REF = SELF ? REF : argValue('--head-ref')
const ONLY = argValue('--only')

const M: GateMeasurement = QUICK
  ? { ...CONFIG.measurement, rounds: 2, runs: 1, passes: 1 }
  : CONFIG.measurement

/**
 * The paths copied from the working tree onto BOTH sides. The workloads and the
 * example grammars they reuse must be byte-identical across sides or the gate
 * measures the benchmark's history instead of the compiler's.
 */
const COPY = ['bench/workloads', 'examples'] as const

async function loadSide(dir: string): Promise<Workload[]> {
  const mod = await import(path.join(dir, 'bench', 'workloads', 'index.ts')) as {
    buildWorkloads: () => Workload[]
  }
  const all = mod.buildWorkloads()
  return ONLY === null ? all : all.filter(w => w.id.includes(ONLY))
}

function toCases(workloads: readonly Workload[]): Case[] {
  return workloads.map(w => {
    const built = w.make()
    return {
      id: w.id,
      detail: `${(w.bytes / 1024).toFixed(0)} KB`,
      parse: () => built.parse(),
      run: (reps: number) => { for (let n = 0; n < reps; n++) built.parse() },
    }
  })
}

const headSha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim()
const refDir = materialise(GATE, ROOT, REF, COPY)
const headDir = materialise(GATE, ROOT, HEAD_REF, COPY)

console.log(
  `${GATE}: ${SELF ? `SELF-CHECK — ${REF} against itself (noise floor, not a gate)` : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`}`,
)

const refWorkloads = await loadSide(refDir)
const headWorkloads = await loadSide(headDir)

if (refWorkloads.length === 0) fail(GATE, `--only=${ONLY} matched no workload.`)
for (let n = 0; n < refWorkloads.length; n++) {
  if (refWorkloads[n]!.input !== headWorkloads[n]?.input) {
    fail(GATE, `workload ${refWorkloads[n]!.id}: the two sides generated different input — the workload copy did not take.`)
  }
}

const refCases = toCases(refWorkloads)
const headCases = toCases(headWorkloads)
const ALLOW_PARSE_DIFF = process.argv.includes('--allow-parse-diff')
if (ALLOW_PARSE_DIFF && HEAD_REF === null) {
  fail(GATE, '--allow-parse-diff is only for replaying a pinned --head-ref, never for gating the working tree.')
}
assertSameParse(GATE, refCases, headCases, ALLOW_PARSE_DIFF)

const reps = calibrate(refCases, M)
console.log(
  `  ${refCases.length} workloads`
  + `   ${M.passes} passes x ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples, sides paired and order-alternated`
  + `${QUICK ? '  [--quick: TRIAGE ONLY, not a gate]' : ''}`,
)
console.log(`  parses per sample: ${refCases.map(c => `${c.id} ${reps.get(c.id)}`).join(', ')}`)

const T = CONFIG.thresholds
const load0 = os.loadavg()[0] ?? 0
const passRows: Row[][] = []
for (let p = 0; p < M.passes; p++) {
  passRows.push(score(refCases, interleave(refCases, headCases, reps, M), T))
}
const load1 = os.loadavg()[0] ?? 0
const rows = verdicts(passRows)

console.log(
  `\nper-workload result over ${M.passes} independent passes`
  + `\n  a pass BREACHES on median > ${T.medianPct}% OR min > ${T.minPct}% slower,`
  + ` AND <= ${Math.round(T.winRateCeiling * 100)}% of interleaved pairs won`
  + `\n  a workload FAILS only when a strict majority of passes breach — one bad pass is a busy machine, not a regression\n`,
)
for (const v of rows) {
  const worst = v.passes.reduce((a, b) => (b.dMedian > a.dMedian ? b : a))
  const best = v.passes.reduce((a, b) => (b.dMedian < a.dMedian ? b : a))
  console.log(
    `  ${v.failed ? 'FAIL' : 'ok  '}  ${v.id.padEnd(18)} ${v.detail.padStart(6)}`
    + `   median ${sign(best.dMedian)} … ${sign(worst.dMedian)}`
    + `   min ${sign(Math.min(...v.passes.map(r => r.dMin)))} … ${sign(Math.max(...v.passes.map(r => r.dMin)))}`
    + `   won ${v.passes.map(r => `${r.wins}/${r.pairs}`).join(' ')}`
    + `   breached ${v.breachCount}/${M.passes}`,
  )
}
console.log(`\n  load average ${load0.toFixed(2)} → ${load1.toFixed(2)}`)

if (SELF) {
  // Reported SIGNED, because only the positive direction gates. A −8% self-check
  // pass is the same machine noise as a +8% one, but only the second can fail a
  // PR, so the number the threshold has to clear is the worst POSITIVE one.
  const all = rows.flatMap(v => v.passes)
  const worstMedian = Math.max(...all.map(r => r.dMedian))
  const worstMin = Math.max(...all.map(r => r.dMin))
  const swing = Math.max(...all.map(r => Math.abs(r.dMedian)))
  const falseFails = rows.filter(v => v.failed).map(v => v.id)
  console.log(
    `\nnoise floor on this machine, worst SINGLE PASS in the gating (slower) direction:`
    + ` median ${sign(worstMedian)}, min ${sign(worstMin)}`
    + `\n  worst absolute swing in either direction: ${swing.toFixed(2)}%`
    + `\n  passes that breached: ${all.filter(r => r.breach).length}/${all.length}`
    + `\nmajority-of-${M.passes} verdict: ${falseFails.length === 0 ? 'no workload false-failed' : `FALSE FAIL on ${falseFails.join(', ')}`}`
    + `\nConfigured thresholds ${T.medianPct}% / ${T.minPct}%. The single-pass floor is what the threshold has to`
    + `\nclear; the majority rule is what absorbs the pass that does not. If a self-check ever false-fails,`
    + `\nthe gate is reading the machine — spend more passes, or say the number is wrong. Do not widen.`,
  )
  process.exit(falseFails.length === 0 ? 0 : 1)
}
if (QUICK) {
  console.log('\n--quick is triage only — it does not gate. Run without it before landing.')
  process.exit(0)
}

const failures = rows.filter(v => v.failed)
if (failures.length > 0) {
  console.error(`\n${GATE}: REGRESSION in ${failures.length} workload(s) vs ${REF}:`)
  for (const f of failures) {
    console.error(
      `  ${f.id}: median ${f.passes.map(r => sign(r.dMedian)).join(' ')}`
      + `, breached ${f.breachCount}/${M.passes} passes`,
    )
  }
  console.error(
    '\nThese are end-to-end parses of realistic input, so the number is the number: a 20% row is a'
    + '\ndownstream parser 20% slower on that dialect. Read WHICH rows moved before reaching for a cause —'
    + '\nless/* alone points at speculation or expected-set width, less/* and css/* together points at'
    + '\nsomething every stylesheet grammar pays, and graphql/json moving too points at codegen or the'
    + '\nruntime with capture switched off.'
    + '\n\nDo not widen the threshold to make this pass. Either fix it, or land the number visibly.',
  )
  process.exit(1)
}
console.log(`\n${GATE}: ok`)
