/**
 * parseman's GRAMMAR performance gate.
 *
 * ## Why this exists
 *
 * `perf:guard` measures parseman's own microbenchmarks: a 47-byte `css/decls`
 * and a 34-byte `css/selector`, in µs, against a committed baseline. It passed
 * on every PR of the 0.34.0 cycle. It passed at 0.34.0. And 0.34.0 made a real
 * downstream Less grammar parse 25% slower.
 *
 * The mechanism was `not()`'s probe-leak fix — correct, and kept — emitting six
 * UNCONDITIONAL capture-buffer `length` stores per probe. Assigning `array.length`
 * runs V8's length setter whether or not the value changes, and a rollback
 * overwhelmingly restores a length that never moved. The microbenchmarks execute
 * `not()` about 20 times per KB and did not move; the Less grammar executes it
 * about 600 times per KB and moved 25%.
 *
 * So the gate's trigger ("did parseman's microbenchmarks move?") was not its goal
 * ("did emitted parsers get slower?"). This gate closes that gap, and it does so
 * WITHOUT reaching into any other repository: the workload lives in
 * `bench/grammar-density/`, is a few hundred lines, and is parameterised on the
 * one axis the regression rides — speculative-rollback executions per byte.
 *
 * ## What it measures
 *
 * A/B against a PINNED REFERENCE COMMIT of this repo, both sides loaded and
 * INTERLEAVED IN ONE PROCESS, rotating order per round.
 *
 * Self-calibrating by construction: no machine-specific timings are stored, so
 * the gate reads the same on a laptop and on a CI runner. That matters more than
 * it sounds — comparing separate processes on this hardware produced 9.4 ms and
 * 26 ms for the same case in consecutive launches. A stored-timings baseline
 * would be measuring the runner, not the change.
 *
 * The reference side is a `git worktree` at the pinned sha with this repo's
 * `node_modules` linked in, and the grammar source is COPIED there from the
 * working tree — so both sides compile byte-identical grammar input and the only
 * difference is parseman itself.
 *
 * ## Per-case, never aggregated — and on TWO axes
 *
 * `rollback/*`: four cases differing only in how many negative lookaheads guard
 * each value term — 0 / 1 / 4 / 16, which INSTRUMENTING THE EMITTED ARTIFACT
 * measures at 0 / 94 / 377 / 1508 probes per KB (css 20, jess 121 and less 599
 * all land inside that). The SPREAD is the signal. Replaying 0.34.0 the unguarded
 * case moves +1.2% while the dense one moves +113%, an ordering that says the
 * cost is per-EXECUTION. Any aggregate would show something mild and pass.
 *
 * `expected/*`: three cases differing in how WIDE the derived `expected` set is
 * at a choice that loses every arm. This axis exists because the first version of
 * this gate had only the rollback one, and 0.35.0 then shipped a 32% Less
 * regression straight through it: `fix(expect)` widened the derived sets, which
 * the rollback cases cannot see. `none` is the disjoint-arm baseline; `narrow`
 * and `wide` share a dispatch shape and differ only in width, so the width
 * reading does not rest on the baseline.
 *
 * A gate parameterised on one axis only ever catches that axis. When the next
 * regression rides a third, add the third rather than widening a threshold.
 *
 * ## Median AND min AND win rate — and a MAJORITY OF PASSES
 *
 * A single median is not a measurement. The first attempt at measuring the real
 * regression produced a wrong number that way. The gate reports all three and
 * requires two independent signals to fire.
 *
 * That was still not enough, and the evidence is unambiguous. This gate used to
 * carry its OWN copy of the measurement loop, predating `ab-harness.ts`, and that
 * copy sampled the two sides as CONTIGUOUS BLOCKS with a per-round rotation over
 * the concatenated case list — so `ref|expected/narrow` and `head|expected/narrow`
 * sat SEVEN positions apart in the sequence. Run against a BYTE-IDENTICAL `src/`
 * (both sides at 80d0e62, load average 8.1) it reported:
 *
 *   rollback/sparse   median −9.2%   min −6.5%   won 12/12
 *   expected/narrow   median +23.3%  min +10.6%  won  0/12   FAIL
 *
 * A 32-point spread and a hard FAIL between a build and itself. `won 0/12` was
 * therefore proving nothing: it did not discriminate a regression from noise,
 * because the two sides were never measured under the same conditions. The same
 * signature — `expected/none` +12.7% won 0/12, `rollback/none` +64.3% — is what
 * failed CI on 40ce56b and 1c6f6a8, two commits that touch ZERO files under
 * `src/`.
 *
 * `ab-harness.ts` had already diagnosed and fixed exactly this for the workload
 * gate: it pairs the two sides ADJACENTLY and alternates which goes first, so
 * they share GC state, cache state and position in the run. On top of that it
 * runs N independent PASSES and fails only on a strict majority — a burst lands
 * in one pass, a regression lands in all of them. This gate now uses it, rather
 * than a second copy that got one of these properties wrong.
 *
 * Usage:
 *   pnpm perf:guard:grammars                  # the gate
 *   pnpm perf:guard:grammars --quick          # 2 rounds x 1 run — TRIAGE ONLY, does not gate
 *   pnpm perf:guard:grammars --ref=<sha>      # move the A side
 *   pnpm perf:guard:grammars --head-ref=<sha> # build the B side from a commit, not the working tree
 *   pnpm perf:guard:grammars --self           # measure the noise floor: reference against ITSELF
 *
 * The last three exist to REPLAY a known regression and watch the gate go red,
 * and to re-derive the thresholds from measured noise on the machine in front of
 * you. A gate nobody has watched fail is not known to work, and a gate nobody has
 * watched PASS against identical source is not known to be honest.
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  materialise, calibrate, assertSameParse, measurePasses, verdicts, git, fail, sign,
  type Case, type Thresholds,
} from './ab-harness.ts'

const GATE = 'grammar-perf-guard'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(HERE, 'grammar-density', 'config.json')

/** `passes` is this gate's own: the shared harness measures, the gate decides. */
type GateMeasurement = import('./ab-harness.ts').Measurement & { passes: number }

type Config = {
  referenceSha: string
  input: { rules: number }
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

const M: GateMeasurement = QUICK
  ? { ...CONFIG.measurement, rounds: 2, runs: 1, passes: 1 }
  : CONFIG.measurement

/**
 * The path copied from the working tree onto BOTH sides. The density grammar must
 * be byte-identical across sides or the gate measures the benchmark's history
 * instead of the compiler's. `config.json` rides along in the same directory and
 * is harmless: both sides read the gate's config from the WORKING TREE, never
 * from the materialised checkout.
 */
const COPY = ['bench/grammar-density'] as const

type DensityCase = { id: string; kind: string; n: number }
type Side = {
  compile: (c: unknown) => { parseWithContext: (input: string, ctx: unknown, pos?: number) => unknown }
  grammar: (c: DensityCase) => unknown
  cases: ReadonlyArray<DensityCase>
  input: (c: DensityCase, rules: number) => string
}

async function loadSide(dir: string): Promise<Side> {
  const pm = await import(path.join(dir, 'src', 'index.ts')) as { compile: Side['compile'] }
  const g = await import(path.join(dir, 'bench', 'grammar-density', 'grammar.ts')) as {
    caseGrammar: Side['grammar']
    caseInput: Side['input']
    DENSITY_CASES: Side['cases']
  }
  return { compile: pm.compile, grammar: g.caseGrammar, cases: g.DENSITY_CASES, input: g.caseInput }
}

function toCases(side: Side): Case[] {
  return side.cases.map(c => {
    const compiled = side.compile(side.grammar(c))
    const input = side.input(c, CONFIG.input.rules)
    const parse = (): unknown => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)
    return {
      id: c.id,
      detail: `${c.n} ${c.kind === 'expected' ? 'opt/arm' : 'probes/val'}`,
      parse,
      run: (reps: number) => { for (let n = 0; n < reps; n++) parse() },
    }
  })
}

const headSha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim()
const refDir = materialise(GATE, ROOT, REF, COPY)
const headDir = materialise(GATE, ROOT, HEAD_REF, COPY)

console.log(
  `${GATE}: ${SELF ? `SELF-CHECK — ${REF} against itself (noise floor, not a gate)` : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`}`,
)

const ref = await loadSide(refDir)
const head = await loadSide(headDir)

// Every case's input must be byte-identical across the sides, per AXIS — the copy
// is what makes the comparison about parseman rather than about the bench.
if (ref.cases.length !== head.cases.length) fail(GATE, 'the two sides declare different cases — the grammar copy did not take.')
for (const c of ref.cases) {
  if (ref.input(c, CONFIG.input.rules) !== head.input(c, CONFIG.input.rules)) {
    fail(GATE, `the two sides generated different input for ${c.id} — the grammar copy did not take.`)
  }
}

const refCases = toCases(ref)
const headCases = toCases(head)
assertSameParse(GATE, refCases, headCases)
const detail = new Map(refCases.map(c => [c.id, c.detail]))

// Calibrated on a THROWAWAY instance set. Calibration parses ~14 times before the
// pass loop, and it used to do that on the very instances the reference side then
// raced with — a head start given to exactly one side. The repetition count it
// produces was already applied to both sides; the WARMING was not, and that is a
// side-dependent asymmetry in the one direction a gate must not have one.
const reps = calibrate(toCases(ref), M)
console.log(
  `  ${(ref.input(ref.cases[0]!, CONFIG.input.rules).length / 1024).toFixed(1)} KB input`
  + `   ${M.passes} passes x ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples,`
  + ` sides paired and order-alternated`
  + `${QUICK ? '  [--quick: TRIAGE ONLY, not a gate]' : ''}`,
)
console.log(`  repetitions per sample: ${refCases.map(c => `${c.id.split('/')[1]} ${reps.get(c.id)}`).join(', ')}`)

const T = CONFIG.thresholds
const load0 = os.loadavg()[0] ?? 0
const { passRows, calibration } = measurePasses(() => toCases(ref), () => toCases(head), reps, M, T)
const load1 = os.loadavg()[0] ?? 0
const rows = verdicts(passRows)

console.log(
  `\nper-case result over ${M.passes} independent passes, both sides RECOMPILED each pass`
  + `\n  a pass BREACHES on median > ${T.medianPct}% OR min > ${T.minPct}% slower,`
  + ` AND at most the case's CALIBRATED share of interleaved pairs won`
  + `\n  or on the sign test: same win-rate rule AND > ${T.signTest.medianPct}% on BOTH median and min`
  + `\n  the calibrated share is the null win rate a CONTROL pair of two reference instances measured in`
  + `\n  the same passes, shifted by ${(0.5 - T.winRateCeiling).toFixed(2)} — so a null of 50% is judged at the configured`
  + ` ${Math.round(T.winRateCeiling * 100)}%`
  + `\n  a case FAILS only when a strict majority of passes breach — one bad pass is a busy machine, not a regression\n`,
)
for (const v of rows) {
  const worst = v.passes.reduce((a, b) => (b.dMedian > a.dMedian ? b : a))
  const best = v.passes.reduce((a, b) => (b.dMedian < a.dMedian ? b : a))
  console.log(
    `  ${v.failed ? 'FAIL' : 'ok  '}  ${v.id.padEnd(17)} ${(detail.get(v.id) ?? '').padStart(12)}`
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
    `        ${v.id.padEnd(17)} ${(detail.get(v.id) ?? '').padStart(12)}`
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
    + `\nmajority-of-${M.passes} verdict: ${falseFails.length === 0 ? 'no case false-failed' : `FALSE FAIL on ${falseFails.join(', ')}`}`
    + `\nworst NULL win rate: ${(Math.min(...[...calibration.values()].map(k => k.nullRate)) * 100).toFixed(1)}%`
    + ` … ${(Math.max(...[...calibration.values()].map(k => k.nullRate)) * 100).toFixed(1)}%`
    + ` — on a self-check the gate pair is null too, so these two columns should agree.`
    + `\nConfigured thresholds ${T.medianPct}% / ${T.minPct}%, sign test ${T.signTest.medianPct}%. The single-pass`
    + `\nfloor is what the threshold has to clear; the majority rule is what absorbs the pass that does not.`
    + `\nIf a self-check ever false-fails, the gate is reading the machine — spend more passes, or say the`
    + `\nnumber is wrong. Do not widen.`,
  )
  process.exit(falseFails.length === 0 ? 0 : 1)
}
if (QUICK) {
  console.log('\n--quick is triage only — it does not gate. Run without it before landing.')
  process.exit(0)
}

const failures = rows.filter(v => v.failed)
if (failures.length > 0) {
  console.error(`\n${GATE}: REGRESSION in ${failures.length} case(s) vs ${REF}:`)
  for (const f of failures) {
    console.error(
      `  ${f.id}: median ${f.passes.map(r => sign(r.dMedian)).join(' ')}`
      + `, breached ${f.breachCount}/${M.passes} passes`,
    )
  }
  console.error(
    '\nRead the SPREAD, per axis. Within `rollback/*` only the probes per byte move, so a delta that'
    + '\ngrows with the probe count is a per-EXECUTION cost on a rollback path. Within `expected/*` only'
    + '\nthe derived expected-set width moves, so a delta that appears at `wide` and not at `narrow` is a'
    + '\ncost that scales with how many tokens a losing choice names. Either shape reaches real grammars'
    + '\namplified by their own density — and a regression on ONE axis reads flat on the other, which is'
    + '\nhow 0.35.0 shipped a 32% Less regression past a sweep that watched rollbacks only.'
    + '\n\nThese cases AMPLIFY: a reading here is roughly a quarter of itself on a real grammar.'
    + '\n\nDo not widen the threshold to make this pass. Either fix it, or land the number visibly.',
  )
  process.exit(1)
}
console.log(`\n${GATE}: ok`)
