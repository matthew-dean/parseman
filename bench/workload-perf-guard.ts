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
  materialise, calibrate, assertSameParse, measurePasses, verdicts, git, fail, sign, peakThresholds,
  type Case, type Thresholds, type Peak, type Verdict,
} from './ab-harness.ts'
import { parsePeakWaivers, openSection, isBreach, WAIVER_TAG } from '../scripts/peak-waiver.mjs'
import type { Workload } from './workloads/index.ts'

const GATE = 'workload-perf-guard'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(HERE, 'workloads', 'config.json')

/** `passes` is this gate's own: the shared harness measures, the gate decides. */
type GateMeasurement = import('./ab-harness.ts').Measurement & { passes: number }

type Config = {
  referenceSha: string
  peak: Peak
  measurement: GateMeasurement
  thresholds: Thresholds
}

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

const QUICK = process.argv.includes('--quick')
const SELF = process.argv.includes('--self')
/**
 * The PEAK clause: compare against the fastest release on record rather than the
 * previous one, and fail on a drawdown beyond the measured noise floor. This is
 * the half of the release policy a per-step gate structurally cannot enforce —
 * see `Peak` in `ab-harness.ts`.
 */
const PEAK = process.argv.includes('--peak')
const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
if (PEAK && (SELF || argValue('--ref') !== null)) {
  fail(GATE, '--peak names its own reference (the committed peak sha) and cannot be combined with --ref or --self.')
}
const REF = PEAK ? CONFIG.peak.sha : argValue('--ref') ?? CONFIG.referenceSha
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
  `${GATE}: ${SELF
    ? `SELF-CHECK — ${REF} against itself (noise floor, not a gate)`
    : PEAK
      ? `PEAK CLAUSE — ${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs the fastest release on record,`
        + ` ${CONFIG.peak.version} (${REF}), drawdown allowance ${CONFIG.peak.allowancePct}%`
      : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`}`,
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
const detail = new Map(refCases.map(c => [c.id, c.detail]))

// Calibrated on a THROWAWAY instance set. Calibration parses ~14 times before the
// pass loop, and it used to do that on the very instances the reference side then
// raced with — a head start given to exactly one side. The repetition count it
// produces was already applied to both sides; the WARMING was not, and that is a
// side-dependent asymmetry in the one direction a gate must not have one.
const reps = calibrate(toCases(refWorkloads), M)
console.log(
  `  ${refCases.length} workloads`
  + `   ${M.passes} passes x ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples, sides paired and order-alternated`
  + `${QUICK ? '  [--quick: TRIAGE ONLY, not a gate]' : ''}`,
)
console.log(`  parses per sample: ${refCases.map(c => `${c.id} ${reps.get(c.id)}`).join(', ')}`)

const T = PEAK ? peakThresholds(CONFIG.peak.allowancePct) : CONFIG.thresholds
const load0 = os.loadavg()[0] ?? 0
const { passRows, calibration } = measurePasses(
  () => toCases(refWorkloads), () => toCases(headWorkloads), reps, M, T,
)
const load1 = os.loadavg()[0] ?? 0
const rows = verdicts(passRows)

console.log(
  PEAK
    ? `\nper-workload drawdown from ${CONFIG.peak.version} over ${M.passes} independent passes`
      + `\n  a pass BREACHES on median AND min BOTH > ${CONFIG.peak.allowancePct}% slower than the peak,`
      + ` AND at most the workload's CALIBRATED share of interleaved pairs won`
      + `\n  (the measured null shifted by ${(0.5 - T.winRateCeiling).toFixed(2)}; a null of 50% is judged at the configured`
      + ` ${Math.round(T.winRateCeiling * 100)}%)`
      + `\n  a workload FAILS only when a strict majority of passes breach\n`
    : `\nper-workload result over ${M.passes} independent passes, both sides RECOMPILED each pass`
      + `\n  a pass BREACHES on median > ${T.medianPct}% OR min > ${T.minPct}% slower,`
      + ` AND at most the workload's CALIBRATED share of interleaved pairs won`
      + `\n  the calibrated share is the null win rate a CONTROL pair of two reference instances measured in the`
      + `\n  same passes, shifted by ${(0.5 - T.winRateCeiling).toFixed(2)} — so a null of 50% is judged at the configured`
      + ` ${Math.round(T.winRateCeiling * 100)}%`
      + `\n  a workload FAILS only when a strict majority of passes breach — one bad pass is a busy machine, not a regression\n`,
)
for (const v of rows) {
  const worst = v.passes.reduce((a, b) => (b.dMedian > a.dMedian ? b : a))
  const best = v.passes.reduce((a, b) => (b.dMedian < a.dMedian ? b : a))
  console.log(
    `  ${v.failed ? 'FAIL' : 'ok  '}  ${v.id.padEnd(18)} ${(detail.get(v.id) ?? '').padStart(6)}`
    + `   median ${sign(best.dMedian)} … ${sign(worst.dMedian)}`
    + `   min ${sign(Math.min(...v.passes.map(r => r.dMin)))} … ${sign(Math.max(...v.passes.map(r => r.dMin)))}`
    + `   won ${v.passes.map(r => `${r.wins}/${r.pairs}`).join(' ')}`
    + `   breached ${v.breachCount}/${M.passes}`,
  )
}
console.log(
  `\nmeasured NULL — a control pair of two REFERENCE instances, identical code, same passes and positions.`
  + `\nEvery number in this block is instrument, not compiler; the ceiling column is what the win rates above`
  + `\nwere actually judged against.\n`,
)
for (const v of rows) {
  const k = calibration.get(v.id)!
  console.log(
    `        ${v.id.padEnd(18)} ${(detail.get(v.id) ?? '').padStart(6)}`
    + `   null won ${String(k.wins).padStart(3)}/${k.pairs} = ${(k.nullRate * 100).toFixed(1).padStart(5)}%`
    + `   worst null median ${sign(k.worstNullMedian).padStart(7)}`
    + `   ceiling ${(k.ceiling * 100).toFixed(1).padStart(5)}%`,
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
    + `\nworst NULL win rate: ${(Math.min(...[...calibration.values()].map(k => k.nullRate)) * 100).toFixed(1)}%`
    + ` … ${(Math.max(...[...calibration.values()].map(k => k.nullRate)) * 100).toFixed(1)}%`
    + ` — on a self-check the gate pair is null too, so these two columns should agree.`
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

/**
 * The PEAK-CLAUSE WAIVER — see `scripts/peak-waiver.mjs` for why it is shaped the way
 * it is, and `docs/design/perf-gates.md` §D for when it is legitimate.
 *
 * Short version: a drawdown that is deliberate and BOUGHT something used to have one
 * route past this gate — move `peak`, or widen `allowancePct`. Both make the slower
 * build the reference and destroy the record for everyone after. A waiver lands the
 * same change with the peak UNTOUCHED: the breach is stated in the CHANGELOG, this run
 * still prints its full drawdown report, and the next PR is measured against the same
 * bar and must state its own numbers.
 *
 * Four things must hold, and each maps to a way the hatch could otherwise go quiet:
 *
 *   1. the line parses — a waiver that does not is a contributor who thinks they waived
 *   2. its numbers are a real breach of `allowancePct` — you cannot waive nothing
 *   3. its numbers do not UNDERSTATE what was measured here — the point is the number
 *      being visible, so "median -6%" against a measured -265% is refused
 *   4. it is FRESH — absent from the base's CHANGELOG. Without `--base` that cannot be
 *      checked, so without `--base` the waiver is not honoured at all. Otherwise the
 *      PR after the waiving one inherits the text and the clause is silently off for
 *      the rest of the release cycle, which is the exact failure mode this gate exists
 *      to prevent.
 */
const PEAK_BASE = argValue('--base')
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md')
const CONFIG_REL = path.relative(ROOT, CONFIG_PATH).split(path.sep).join('/')

function peakWaiver(failed: readonly Verdict[]): { applied: boolean, message: string } {
  let section: string
  try {
    section = openSection(readFileSync(CHANGELOG_PATH, 'utf8'))
  } catch {
    return { applied: false, message: '' }
  }

  const mine = parsePeakWaivers(section).filter(w => w.config === CONFIG_REL)
  if (mine.length === 0) return { applied: false, message: '' }
  const w = mine[0]!

  const decline = (why: string): { applied: false, message: string } => ({
    applied: false,
    message: `\n${GATE}: a ${WAIVER_TAG} for ${CONFIG_REL} is in the CHANGELOG but is NOT honoured —\n  ${why}`,
  })

  if (w.problems.length > 0) {
    return decline(
      `it does not parse: ${w.problems.join('; ')}.`
      + '\n  Run `pnpm check:changelog --base=<ref>` — it reports the exact form.',
    )
  }
  if (!isBreach(w, CONFIG.peak.allowancePct)) {
    return decline(
      `it quotes median ${w.medianPct}% / min ${w.minPct}%, which is inside the`
      + ` ${CONFIG.peak.allowancePct}% allowance and therefore waives nothing.`,
    )
  }

  // You may not waive a breach by understating it. The bar is the MILDEST breaching
  // pass rather than the worst, so an honest quote of any breaching row is accepted and
  // the check does not turn into a flake about which pass the author copied.
  const breaching = failed.flatMap(f => f.passes.filter(r => r.breach))
  const mildestMedian = Math.min(...breaching.map(r => Math.abs(r.dMedian)))
  const mildestMin = Math.min(...breaching.map(r => Math.abs(r.dMin)))
  if (Math.abs(w.medianPct!) < mildestMedian || Math.abs(w.minPct!) < mildestMin) {
    return decline(
      `it UNDERSTATES the breach. It declares median ${w.medianPct}% / min ${w.minPct}%; the mildest`
      + ` breaching pass measured HERE is median ${sign(mildestMedian)} / min ${sign(mildestMin)}.`
      + '\n  A waiver is the number made visible — quote what the gate printed, not a softer figure.',
    )
  }

  if (PEAK_BASE === null) {
    return decline(
      'freshness cannot be verified without `--base=<ref>`, so it is refused here by default.'
      + '\n  A waiver is PER-PR: it counts only while the line is ABSENT from the base\'s CHANGELOG.'
      + '\n  Unchecked, the PR after the waiving one inherits the text and the peak clause is silently'
      + '\n  off for the rest of the release cycle. CI passes --base; pass it locally to reproduce.',
    )
  }

  let baseChangelog = ''
  try {
    baseChangelog = git(['show', `${PEAK_BASE}:CHANGELOG.md`], ROOT)
  } catch {
    baseChangelog = ''
  }
  if (baseChangelog.includes(w.line)) {
    return decline(
      `this exact line is ALREADY on the base (${PEAK_BASE}), so it is not this PR's waiver.`
      + '\n  A waiver is spent on the diff that declares it. Re-run this gate and state THIS diff\'s'
      + '\n  numbers, or fix the drawdown.',
    )
  }

  const over = (n: number): string => `${(Math.abs(n) / CONFIG.peak.allowancePct).toFixed(1)}x`
  return {
    applied: true,
    message:
      `\n${GATE}: PEAK CLAUSE WAIVED — the drawdown above is REAL and is NOT forgiven, it is DECLARED.`
      + `\n  declared: median ${w.medianPct}% / min ${w.minPct}%`
      + ` (${over(w.medianPct!)} and ${over(w.minPct!)} the ${CONFIG.peak.allowancePct}% allowance)`
      + `\n  reason:   ${w.reason}`
      + `\n\n  The peak record is UNCHANGED: ${CONFIG.peak.version} (${CONFIG.peak.sha}) is still the bar, and`
      + '\n  this waiver did NOT raise it. The next PR is measured against the same peak, will go red in'
      + '\n  exactly the same way, and must state its own measurement — this line will not carry.'
      + '\n  A waived breach is still a breach on the record.',
  }
}

const failures = rows.filter(v => v.failed)
if (PEAK) {
  if (failures.length === 0) {
    console.log(`\n${GATE}: ok — no workload sits more than ${CONFIG.peak.allowancePct}% below ${CONFIG.peak.version}.`)
    process.exit(0)
  }
  console.error(`\n${GATE}: DRAWDOWN — ${failures.length} workload(s) sit below the ${CONFIG.peak.version} peak:`)
  for (const f of failures) {
    console.error(
      `  ${f.id}: median ${f.passes.map(r => sign(r.dMedian)).join(' ')}`
      + `, breached ${f.breachCount}/${M.passes} passes`,
    )
  }
  console.error(
    '\nThis is the SLOW-BLEED clause, and it fires on a number no per-release comparison produces.'
    + '\nEvery release since the peak may have passed its own gate and this can still be red: five'
    + '\nconsecutive 1% losses are each inside the noise floor and together are a real 5% regression.'
    + '\nThat is not hypothetical — the version sweep measured -5.1% over 0.28.0→0.34.0 with almost'
    + '\nevery step individually insignificant.'
    + '\n\nThree honest responses, in order of preference:'
    + '\n  1. Find and fix the drawdown. It is real time, on realistic input.'
    + '\n  2. If the cost bought something — a correctness fix, a feature — and the drawdown is the NEW'
    + '\n     NORMAL, document it in the CHANGELOG and move `peak` in bench/workloads/config.json, in'
    + '\n     this PR, with these numbers quoted. This RE-BASELINES: the bar moves to the slower build.'
    + `\n  3. If the cost bought something and the bar should NOT move, declare a per-PR ${WAIVER_TAG}`
    + '\n     in the CHANGELOG\'s open section, quoting the numbers above:'
    + `\n\n       ${WAIVER_TAG} bench/workloads/config.json median <n>% min <n>% — <why this cost buys something>`
    + '\n\n     The peak stays where it is, this breach stays on the record, and the NEXT PR is measured'
    + '\n     against the same bar and must state its own numbers. scripts/check-changelog.mjs §D\''
    + '\n     enforces the form and refuses a stale one. See docs/design/perf-gates.md §D.'
    + '\n  4. Nothing else. Widening `allowancePct` to fit the drawdown is laundering a regression into'
    + '\n     the baseline, and check-changelog will make you say so in the CHANGELOG anyway.',
  )
  const waiver = peakWaiver(failures)
  console.error(waiver.message)
  process.exit(waiver.applied ? 0 : 1)
}
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
