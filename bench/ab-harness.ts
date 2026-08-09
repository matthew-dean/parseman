/**
 * The A/B measurement machinery both perf gates in this repo are built on.
 *
 * Extracted rather than invented: every property below was already established
 * by `bench/grammar-perf-guard.ts`, and the reason to have it in one file is that
 * these properties are the difference between a measurement and a number, and a
 * second gate that re-derived them would get one of them subtly wrong.
 *
 * The properties, and why each one is load-bearing:
 *
 * - **Both sides in ONE process, interleaved, rotated per round.** Comparing
 *   separate process launches on this hardware produced 9.4 ms and 26 ms for the
 *   same case in consecutive runs. Nothing survives that except interleaving.
 * - **No stored timings.** The baseline is a pinned COMMIT, not a millisecond
 *   count, so the gate reads the same on a laptop and on a CI runner. A stored
 *   baseline measures the runner.
 * - **Calibrated repetitions, computed on the reference side and applied to
 *   both.** Cheap cases otherwise run inside timer granularity. Calibrating on
 *   one side and using the number on both means the choice cannot favour either.
 * - **Median AND min AND win rate.** A single median is not a measurement; the
 *   first attempt at measuring the real regression produced a wrong number that
 *   way. Two independent signals must agree before anything fails.
 * - **Both sides RECOMPILED per pass, and the null win rate MEASURED.** Two
 *   independently compiled instances of identical code do not run at identical
 *   speed, and the winner is fixed for the life of a pass — measured at 12/12 and
 *   at 0/12 with ±8% medians on byte-identical sides. Compiling once and reusing
 *   made every pass one draw of that lottery; the win rate then reads as
 *   certainty in whichever direction the draw fell. See `measurePasses`.
 * - **Same-parse assertion.** The cheapest way for a side to look fast is to stop
 *   doing work. Both sides must produce identical results, compared structurally
 *   because they come from two separate module graphs.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'

export type Measurement = {
  targetSampleMs: number
  warmup: number
  timed: number
  rounds: number
  runs: number
}

/**
 * The reducer contract for every percentage emitted by this harness. Historical
 * aggregate-v1 shelf values are not interchangeable with this method.
 */
export const SCORE_METHOD = 'paired-ratio-v2' as const

export type Thresholds = {
  medianPct: number
  minPct: number
  winRateCeiling: number
  /**
   * The SIGN TEST: a small effect that is nonetheless unambiguous.
   *
   * Sides are measured in adjacent, order-alternated pairs, so the head side
   * should win about half of them. Losing 1 of 12 is not a busy machine, it is a
   * slower build, however small the percentage.
   *
   * This exists because the percentage thresholds alone could not see the
   * regression they most needed to. Replaying `fix(expect)` on the realistic Less
   * workloads produced +2%…+9% medians — real, consistent, and under a 5%
   * threshold — while the win rate sat at 1-4 of 12 pass after pass and the
   * unaffected workloads sat at 5-9. The magnitude was ambiguous; the direction
   * never was.
   *
   * Both a percentage floor and the win rate are required, so a workload that is
   * merely CONSISTENTLY a hair slower does not fail — it has to be consistently
   * slower AND measurably slower on the min, which is the sample least disturbed
   * by a burst.
   *
   * ## The ceiling is CALIBRATED, never taken at face value
   *
   * `winRateCeiling` used to be read as a probability: "1 of 12 has p ≈ 0.003".
   * That reading assumed the 12 pairs are 12 independent coin flips. They are
   * NOT, and the assumption cost this gate both of its failure modes.
   *
   * The 12 pairs of a pass share ONE pair of compiled parser instances, and two
   * independently compiled instances of IDENTICAL code do not run at identical
   * speed — V8 tiers and inlines them separately, and the winner is fixed for the
   * life of the pass. So a pass resolves ONE draw of a compilation lottery, not
   * twelve flips, and the sign test's effective sample size is 1.
   *
   * Measured, on this repo's density cases, with every side byte-identical: three
   * independently compiled pairs measured in the SAME loop at the SAME run
   * positions read `rollback/none` at 12/12 (−7.8%), 5/12 (+1.0%) and 6/12
   * (+1.0%); another run read `expected/none` at 0/12 (+7.8%), 8/12 and 8/12.
   * A single draw produces a perfect 0/12 or 12/12 on code that cannot differ.
   *
   * Two consequences, and the gate had both: a draw against the head side is a
   * FALSE FAIL at any percentage, and a draw for it makes the case BLIND — a win
   * rate whose null sits near 0.9 can never come down to a flat 0.25 ceiling, so
   * a real regression there reads green.
   *
   * `measurePasses` fixes the cause by RESAMPLING: every pass compiles a fresh
   * pair, so `passes` independent passes are finally independent in the thing
   * that dominates, and it measures the null directly with a control pair of two
   * reference instances. The ceiling each case is judged against is that measured
   * null shifted by `0.5 - winRateCeiling`, so an unbiased case is judged at
   * exactly this number and a biased one is judged at what "biased" is worth.
   */
  signTest: {
    winRateCeiling: number
    medianPct: number
    minPct: number
  }
}

/**
 * The committed record of the fastest release this gate has ever measured.
 *
 * ## Why a per-step gate is not enough
 *
 * The release policy is "each release must be faster than the last unless the
 * slowdown is deliberate and documented". A gate that only compares against the
 * PREVIOUS release enforces the letter of that and misses the thing it exists to
 * prevent, because a run of individually-insignificant losses is a significant
 * loss. The standalone version sweep at `~/parseman-perf-probe/` measured exactly
 * that on its own probe grammar: −3.9% over 0.28.1→0.32.0 and −5.1% over
 * 0.28.0→0.34.0, with almost every individual step inside the noise floor. No
 * per-step gate would have flagged one of them, and the sum is real.
 *
 * So the peak clause: a release may not sit below the best release on record by
 * more than `allowancePct`, whatever the per-step deltas said.
 *
 * ## Absolute, not differential
 *
 * `sha` names a COMMIT, so the comparison is re-measured on whatever machine runs
 * it and never inherits a stored millisecond count. `allowancePct` is the drawdown
 * the gate tolerates — it is the measured noise floor, not a budget to spend.
 *
 * ## Re-baselining is a deliberate, committed diff
 *
 * Moving `sha` forward is how a genuine improvement becomes the new bar, and it
 * requires editing this file in a PR where a reviewer sees it. Moving it BACKWARD,
 * or widening `allowancePct`, is how a regression gets laundered into the
 * baseline — `scripts/check-changelog.mjs` requires a CHANGELOG entry for either,
 * so it cannot happen quietly.
 *
 * ## The peak is per-WORKLOAD-SET, and cannot be imported
 *
 * Measured, not assumed: the version sweep found 0.28.0 to be the fastest release
 * on ITS probe grammar, and this repo's `css/stylesheet` workload runs ~50%
 * FASTER at HEAD than at 0.28.0. A 10-node monolithic fused grammar and a
 * realistic composed one do not peak in the same place. Whatever peak a different
 * instrument reports is evidence about that instrument's shape, not this one's.
 */
export type Peak = {
  sha: string
  version: string
  allowancePct: number
}

/**
 * Thresholds for the peak comparison.
 *
 * Deliberately stricter in structure than the per-release rule: median AND min
 * must BOTH breach, not either. A per-release gate is watching for a change that
 * just happened and wants to be twitchy; the peak clause is answering "are we
 * below the best we have ever been", a question worth answering only when both
 * statistics agree. The win-rate conjunction is kept — it is what makes a
 * percentage threshold safe on a shared runner.
 */
export function peakThresholds(allowancePct: number): Thresholds {
  return {
    // `medianPct` alone cannot fire: `score()` treats the pair as OR, so setting
    // both to the allowance and requiring the sign test to agree is what produces
    // an AND. The sign test's percentages are the same number for that reason.
    medianPct: Infinity,
    minPct: Infinity,
    winRateCeiling: 0.25,
    signTest: { winRateCeiling: 0.25, medianPct: allowancePct, minPct: allowancePct },
  }
}

export type Case = {
  id: string
  /** Extra text printed after the id — sample size, density, whatever the gate wants shown. */
  detail: string
  run: (reps: number) => void
  parse: () => unknown
}

export function fail(gate: string, message: string): never {
  console.error(`\n${gate}: ${message}`)
  process.exit(1)
}

export const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function git(args: string[], cwd: string, timeout?: number): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(timeout === undefined ? {} : { timeout }) })
}

/** Bound for the cache-verification git calls — they are local metadata reads. */
const VERIFY_TIMEOUT_MS = 10_000

/**
 * Materialise one side of the A/B: a directory whose `src/` is parseman at `sha`
 * and whose benchmark inputs are the WORKING TREE's, copied in.
 *
 * Copying the workload over the checked-out one is not a convenience — it is the
 * whole reason the comparison means anything. If each side used its own vintage
 * of the grammar and the corpus, the gate would be measuring the benchmark's
 * history rather than the compiler's.
 *
 * `node_modules` is symlinked rather than installed: nothing here needs a
 * per-sha dependency tree, since `src/index.ts` is loaded through tsx and tsx
 * only transpiles. That keeps the gate at seconds instead of minutes, which is a
 * correctness property — a gate too slow to run gets skipped.
 *
 * Returns ROOT unchanged for a null sha, i.e. "use the working tree".
 */
export function materialise(
  gate: string,
  root: string,
  sha: string | null,
  copyPaths: readonly string[],
): string {
  if (sha === null) return root
  const dir = path.join(root, '.cache', `${gate}-${sha}`)
  // A cached directory is only reusable if it is still AT the requested sha. Presence of
  // `src/index.ts` proves a worktree exists there, not which commit it holds — the
  // directory name encodes the sha, but nothing verified the contents matched it. A
  // worktree left by an interrupted run, or one checked out elsewhere, would be reused
  // silently and the gate would benchmark the WRONG COMMIT while reporting the requested
  // one. Verify, and rebuild when it does not match: a rebuild is cheap, a confidently
  // wrong number is not.
  const stale = (): boolean => {
    if (!existsSync(path.join(dir, 'src', 'index.ts'))) return true
    try {
      const want = git(['rev-parse', sha], root, VERIFY_TIMEOUT_MS).trim()
      const have = git(['rev-parse', 'HEAD'], dir, VERIFY_TIMEOUT_MS).trim()
      if (want !== have) return true
      // Being AT the sha is not enough — a tracked modification under `src/` means the
      // benchmark imports code that is not what the sha names, and the gate would report
      // the clean sha while measuring the edit. `copyPaths` are overwritten from the
      // working tree BY DESIGN and live outside `src/`, so scoping the check to `src/`
      // catches the real case without rebuilding on every run.
      return git(['status', '--porcelain', '--', 'src'], dir, VERIFY_TIMEOUT_MS).trim() !== ''
    } catch (error) {
      // Treat an unverifiable cache as stale — a rebuild is cheap, a wrong number is not
      // — but do NOT swallow the reason. Silently discarding it is how a hung or broken
      // git turns into an unexplained full rebuild every run, or worse, looks like normal
      // operation. Say what happened and carry on.
      console.warn(
        `${gate}: could not verify the cached reference at ${sha} (${String(error).slice(0, 200)}); rebuilding it.`,
      )
      return true
    }
  }
  if (stale()) {
    rmSync(dir, { recursive: true, force: true })
    try { git(['worktree', 'prune'], root) } catch { /* nothing to prune */ }
    try {
      git(['worktree', 'add', '--detach', '--force', dir, sha], root)
    } catch (error) {
      fail(
        gate,
        `could not create a worktree at ${sha}. This gate compares against a pinned commit of THIS repo, `
        + `so the commit must be present — a shallow clone cannot see it (CI needs actions/checkout with fetch-depth: 0).\n`
        + `A missing reference is a FAILURE, not a skip.\n${String(error).slice(0, 500)}`,
      )
    }
  }
  const nm = path.join(dir, 'node_modules')
  if (!existsSync(nm)) symlinkSync(path.join(root, 'node_modules'), nm, 'dir')
  for (const rel of copyPaths) {
    const dest = path.join(dir, rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    cpSync(path.join(root, rel), dest, { recursive: true })
  }
  return dir
}

/**
 * Repetitions per timed sample, chosen so each sample lands near
 * `targetSampleMs`. Calibrated on the REFERENCE side and applied to BOTH, so the
 * choice can never favour one — and reported by the caller, so a reader can see
 * the sample size behind every number.
 */
export function calibrate(cases: readonly Case[], m: Measurement): Map<string, number> {
  const reps = new Map<string, number>()
  for (const c of cases) {
    for (let k = 0; k < 5; k++) c.parse()
    const ts: number[] = []
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now()
      c.parse()
      ts.push(performance.now() - t0)
    }
    reps.set(c.id, Math.max(1, Math.round(m.targetSampleMs / Math.max(median(ts), 0.01))))
  }
  return reps
}

/**
 * Both sides must produce the SAME parse. A gate that times two different parses
 * is not a gate. Compared by structure rather than identity because the two sides
 * build their results from two separate module graphs.
 */
export function assertSameParse(
  gate: string,
  a: readonly Case[],
  b: readonly Case[],
  /**
   * Downgrade a difference to a loud warning.
   *
   * Only for REPLAYING a commit that deliberately changed parse output. That is
   * not hypothetical: `fix(not)` — the 0.34.0 regression this gate has to catch —
   * was a fix to a trivia-log rollback LEAK, so the pre-fix side genuinely
   * records a different trivia count. Refusing to measure it would mean the one
   * replay that proves the gate works is the one replay it cannot run.
   *
   * Never set on a gating run. A HEAD that changes parse output relative to the
   * reference, with no intent to, is a correctness bug and the gate says so
   * before it says anything about speed.
   */
  allowDiff = false,
): void {
  if (a.length !== b.length) fail(gate, 'the two sides declare different cases — the workload copy did not take.')
  const differing: string[] = []
  for (let n = 0; n < a.length; n++) {
    if (a[n]!.id !== b[n]!.id) fail(gate, `case order differs between sides at index ${n}.`)
    const ra = JSON.stringify(a[n]!.parse())
    const rb = JSON.stringify(b[n]!.parse())
    if (ra === rb) continue
    if (!allowDiff) {
      fail(gate, `case ${a[n]!.id}: the two sides produced DIFFERENT parse results, so their timings are not comparable.`)
    }
    differing.push(`${a[n]!.id} (${ra.length} vs ${rb.length} bytes of result)`)
  }
  if (differing.length > 0) {
    console.warn(
      `\n${gate}: --allow-parse-diff — the two sides parse DIFFERENTLY on: ${differing.join(', ')}.`
      + `\n  Only meaningful when replaying a commit that deliberately changed output. Read the deltas below`
      + `\n  knowing the two sides are not doing identical work.\n`,
    )
  }
}

/**
 * Adjacent paired sample medians, plus the minimum timed repetition from each
 * sample. The Map itself intentionally remains the median series so descriptive
 * benchmark scripts keep their absolute-throughput view; verdicts must reduce
 * ALIGNED ratios, and the `mins` sidecar preserves the corresponding best-case
 * observation without comparing unrelated global minima.
 */
export type Samples = Map<string, number[]> & { mins: Map<string, number[]> }

function emptySamples(cases: readonly Case[]): Samples {
  const entries = cases.flatMap(c => [[`ref|${c.id}`, [] as number[]], [`head|${c.id}`, [] as number[]]] as const)
  const samples = new Map(entries) as Samples
  samples.mins = new Map(entries.map(([key]) => [key, []]))
  return samples
}

/** Preserve the minima sidecar; `new Map(samples)` alone is not a valid clone. */
export function copySamples(source: Samples): Samples {
  const out = new Map([...source].map(([key, values]) => [key, [...values]])) as Samples
  out.mins = new Map([...source.mins].map(([key, values]) => [key, [...values]]))
  return out
}

/** Median of aligned HEAD/REF ratios. Aggregating each side first discards pairing. */
export function pairedMedianRatio(ref: readonly number[], head: readonly number[]): number {
  if (ref.length !== head.length) {
    throw new Error(`paired sample lengths differ: ref=${ref.length}, head=${head.length}`)
  }
  if (ref.length === 0) throw new Error('paired samples must not be empty')
  const ratios: number[] = []
  for (let i = 0; i < ref.length; i++) {
    const a = ref[i]!, b = head[i]!
    if (!(a > 0) || !(b >= 0)) throw new Error(`invalid paired sample at index ${i}: ref=${a}, head=${b}`)
    ratios.push(b / a)
  }
  return median(ratios)
}

/** Median aligned HEAD−REF difference. Difference-of-aggregate medians is unpaired. */
export function pairedMedianDelta(ref: readonly number[], head: readonly number[]): number {
  if (ref.length !== head.length) {
    throw new Error(`paired sample lengths differ: ref=${ref.length}, head=${head.length}`)
  }
  if (ref.length === 0) throw new Error('paired samples must not be empty')
  return median(head.map((value, index) => value - ref[index]!))
}

export function pairedWins(ref: readonly number[], head: readonly number[]): number {
  if (ref.length !== head.length) {
    throw new Error(`paired sample lengths differ: ref=${ref.length}, head=${head.length}`)
  }
  let wins = 0
  for (let i = 0; i < ref.length; i++) if (head[i]! < ref[i]!) wins++
  return wins
}

/** Median ratio of aligned within-sample minima retained by {@link interleave}. */
export function pairedMinRatio(samples: Samples, refKey: string, headKey: string): number {
  const ref = samples.mins.get(refKey)
  const head = samples.mins.get(headKey)
  if (ref === undefined || head === undefined) {
    throw new Error(`missing paired minimum series: ref=${refKey}, head=${headKey}`)
  }
  return pairedMedianRatio(ref, head)
}

/**
 * Interleave both sides in one process.
 *
 * The two sides of the SAME case are measured adjacently, and which of them goes
 * first alternates. That is not a refinement — it is the difference between this
 * harness working and not. Measured with the sides run as two contiguous blocks
 * with a per-round rotation (the shape this started from, which is right for a
 * handful of cheap synthetic cases), the reference side of a 50 KB CST workload
 * read 38% SLOWER than an identical build of itself: the workloads allocate
 * heavily, whichever side runs first in a round eats the previous side's garbage,
 * and a rotation by one over ten entries never moves a case far enough to cancel
 * it. Directional bias of that size does not merely add noise — it MASKS a
 * regression on the head side, which is the one failure mode a gate must not have.
 *
 * Pairing makes the two samples share their GC state, their cache state and their
 * position in the run, so what is left between them is the compiler. Alternating
 * the order removes the residual first-of-pair penalty.
 */
export function interleave(
  contests: readonly Contest[],
  reps: Map<string, number>,
  m: Measurement,
): Map<string, Samples> {
  const out = new Map<string, Samples>(
    contests.map(k => [
      k.label,
      emptySamples(k.a),
    ]),
  )

  const sample = (c: Case): { median: number; min: number } => {
    const r = reps.get(c.id)!
    const ts: number[] = []
    for (let k = 0; k < m.timed; k++) {
      const t0 = performance.now()
      c.run(r)
      ts.push(performance.now() - t0)
    }
    return { median: median(ts), min: Math.min(...ts) }
  }

  for (const k of contests) {
    for (let n = 0; n < k.a.length; n++) {
      for (let w = 0; w < m.warmup; w++) { k.a[n]!.run(reps.get(k.a[n]!.id)!); k.b[n]!.run(reps.get(k.b[n]!.id)!) }
    }
  }

  const cases = contests[0]!.a
  for (let round = 0; round < m.rounds; round++) {
    // Rotate which case leads the round, so no case permanently owns the cold slot.
    for (let i = 0; i < cases.length; i++) {
      const n = (i + round) % cases.length
      const id = cases[n]!.id
      for (let run = 0; run < m.runs; run++) {
        // Rotate which contest goes first too, so the gate pair and the control
        // pair see the SAME distribution of run positions. A control measured
        // always-second is a control of a different experiment.
        for (let q = 0; q < contests.length; q++) {
          const ci = (q + round + run) % contests.length
          const k = contests[ci]!
          // Alternate which side of the pair is measured first.
          const refFirst = (round + run + ci) % 2 === 0
          const first = refFirst ? k.a[n]! : k.b[n]!
          const second = refFirst ? k.b[n]! : k.a[n]!
          first.run(reps.get(first.id)!)
          second.run(reps.get(second.id)!)
          const t1 = sample(first)
          const t2 = sample(second)
          const s = out.get(k.label)!
          const ref = refFirst ? t1 : t2
          const head = refFirst ? t2 : t1
          s.get(`ref|${id}`)!.push(ref.median)
          s.get(`head|${id}`)!.push(head.median)
          s.mins.get(`ref|${id}`)!.push(ref.min)
          s.mins.get(`head|${id}`)!.push(head.min)
        }
      }
    }
  }
  return out
}

/** One A/B contest measured inside a pass: `a` is the reference side, `b` the other. */
export type Contest = { label: string; a: readonly Case[]; b: readonly Case[] }

/**
 * Builds one side's cases. Called ONCE PER PASS, and it must return FRESH
 * instances every time — a factory that memoises defeats the resampling below.
 */
export type SideFactory = () => Case[]

/** What the control pair measured, per case, pooled over every pass. */
export type Calibration = {
  wins: number
  pairs: number
  /** Pooled win rate of the control pair — the measured null for this case, this run. */
  nullRate: number
  /** The null rate shifted onto the configured ceiling. */
  ceiling: number
  signCeiling: number
  /** Worst control median delta seen in a pass — identical code, so pure instrument. */
  worstNullMedian: number
}

const shift = (nullRate: number, configured: number): number =>
  Math.min(1, Math.max(0, nullRate - (0.5 - configured)))

/**
 * Run every pass, and measure the null while doing it.
 *
 * Two things happen here that did not happen when a gate called `interleave`
 * directly on one fixed pair of case arrays, and both make the gate STRICTER.
 *
 * ## 1. Every pass compiles a fresh pair — the passes are finally independent
 *
 * `verdicts()` fails a case only on a strict MAJORITY of passes, and the whole
 * value of that rule is that the passes are independent draws. They were not.
 * Both sides were compiled ONCE, before the pass loop, so all three passes
 * inherited one draw of the compilation lottery documented on `Thresholds.signTest`
 * — and that lottery, not the machine, is what moves a win rate to 0/12 or 12/12
 * on byte-identical code. Three passes over one draw is one measurement reported
 * three times; a majority of it is unanimous by construction.
 *
 * Rebuilding per pass costs one compile per side per pass and buys the property
 * the majority rule was always claimed to have.
 *
 * ## 2. A control pair measures the null win rate, in this process, this run
 *
 * The control is two independently compiled REFERENCE instances — identical code,
 * so every pair it wins or loses is instrument, not compiler. It is measured in
 * the same loop as the gate pair, at the same rotated run positions, and which of
 * the two gets compiled first alternates by pass, because the first-compiled pair
 * is the one that most often draws the skew.
 *
 * Its pooled win rate is the null the gate pair is judged against: the configured
 * `winRateCeiling` is the ceiling for a null of 0.5, and a case whose null lands
 * elsewhere is judged at the same DISTANCE from its own null. So an unbiased case
 * is judged exactly as before — the correction can never loosen it — while a case
 * the instrument favours stops being blind and one it disfavours stops firing on
 * nothing.
 *
 * Reference-side instances are used for the control rather than head-side ones so
 * that the null never depends on the code under test.
 */
export function measurePasses(
  refSide: SideFactory,
  headSide: SideFactory,
  reps: Map<string, number>,
  m: Measurement & { passes: number },
  t: Thresholds,
): { passRows: Row[][]; calibration: Map<string, Calibration> } {
  const gateSamples: Samples[] = []
  const nullSamples: Samples[] = []
  for (let p = 0; p < m.passes; p++) {
    // Alternate which pair is compiled first. The first-compiled pair draws the
    // skew disproportionately, so a control compiled always-second would
    // systematically under-report the bias it exists to measure.
    let gate: Contest
    let ctl: Contest
    if (p % 2 === 0) {
      gate = { label: 'gate', a: refSide(), b: headSide() }
      ctl = { label: 'null', a: refSide(), b: refSide() }
    } else {
      ctl = { label: 'null', a: refSide(), b: refSide() }
      gate = { label: 'gate', a: refSide(), b: headSide() }
    }
    const s = interleave([gate, ctl], reps, m)
    gateSamples.push(s.get('gate')!)
    nullSamples.push(s.get('null')!)
  }

  const ids = [...gateSamples[0]!.keys()].filter(k => k.startsWith('ref|')).map(k => k.slice(4))
  const calibration = new Map<string, Calibration>()
  for (const id of ids) {
    let wins = 0
    let pairs = 0
    let worstNullMedian = -Infinity
    for (const s of nullSamples) {
      const a = s.get(`ref|${id}`)!
      const b = s.get(`head|${id}`)!
      wins += pairedWins(a, b)
      pairs += b.length
      worstNullMedian = Math.max(worstNullMedian, (pairedMedianRatio(a, b) - 1) * 100)
    }
    const nullRate = wins / pairs
    calibration.set(id, {
      wins,
      pairs,
      nullRate,
      ceiling: shift(nullRate, t.winRateCeiling),
      signCeiling: shift(nullRate, t.signTest.winRateCeiling),
      worstNullMedian,
    })
  }
  return { passRows: gateSamples.map(s => score(ids, s, t, calibration)), calibration }
}

export type Row = {
  scorer: typeof SCORE_METHOD
  id: string
  refMedian: number
  headMedian: number
  /** Median of aligned sample-median ratios, as a percentage delta. */
  dMedian: number
  /** Retired ratio-of-medians, retained only for historical shelf comparison. */
  dMedianAggregateV1: number
  /** Median of aligned within-sample-minimum ratios, as a percentage delta. */
  dMin: number
  /** Retired aggregate-v1 floor, retained only for historical shelf comparison. */
  dMinAggregateV1: number
  wins: number
  pairs: number
  breach: boolean
}

export function score(
  ids: readonly string[],
  samples: Samples,
  t: Thresholds,
  calibration: ReadonlyMap<string, Calibration>,
): Row[] {
  return ids.map(id => {
    const a = samples.get(`ref|${id}`)!
    const b = samples.get(`head|${id}`)!
    const k = calibration.get(id)!
    const dMedian = (pairedMedianRatio(a, b) - 1) * 100
    const dMedianAggregateV1 = (median(b) / median(a) - 1) * 100
    const dMin = (pairedMinRatio(samples, `ref|${id}`, `head|${id}`) - 1) * 100
    const dMinAggregateV1 = (Math.min(...b) / Math.min(...a) - 1) * 100
    const wins = pairedWins(a, b)
    const winRate = wins / b.length
    const large = (dMedian > t.medianPct || dMin > t.minPct) && winRate <= k.ceiling
    const small = winRate <= k.signCeiling
      && dMedian > t.signTest.medianPct
      && dMin > t.signTest.minPct
    return {
      scorer: SCORE_METHOD,
      id,
      refMedian: median(a),
      headMedian: median(b),
      dMedian,
      dMedianAggregateV1,
      dMin,
      dMinAggregateV1,
      wins,
      pairs: b.length,
      breach: large || small,
    }
  })
}

export type Verdict = {
  id: string
  passes: Row[]
  /** Breached in a strict majority of passes. */
  failed: boolean
  breachCount: number
}

/**
 * Combine independent passes into one verdict per case.
 *
 * A case FAILS only if it breaches in a strict MAJORITY of passes. This is the
 * gate's answer to the question "regression, or noisy machine?", and it is
 * enforced rather than documented. The density gate's floor was measured at 1.9%
 * median on a quiet machine and 8.3% at load average ~5 — past its own 6%
 * threshold. Interleaving adjacent samples cancels a STEADY load; it does not
 * cancel a BURSTY one, and the burst is what a shared CI runner supplies.
 *
 * A burst lands in one pass. A regression lands in all of them. Widening the
 * threshold to cover the burst would have blinded the gate to exactly the size of
 * regression it exists to catch — 0.34.0's css row moved −1.6% and 0.35.0's
 * repayment was −12.3%, so the interesting band starts well under 10%.
 *
 * The cost is that a regression which only shows up in half the passes is a
 * regression the gate reports as green. That is a real blind spot and it is
 * stated in `docs/design/perf-gates.md` rather than left to be discovered.
 *
 * This rule only means anything because `measurePasses` recompiles both sides per
 * pass. While the sides were compiled once and reused, every pass inherited the
 * same draw of the compilation lottery, a majority was unanimous by construction,
 * and the rule absorbed a burst but not the thing that actually moved the win rate.
 */
export function verdicts(passes: readonly Row[][]): Verdict[] {
  const first = passes[0]!
  return first.map((_, n) => {
    const rows = passes.map(p => p[n]!)
    const breachCount = rows.filter(r => r.breach).length
    return {
      id: first[n]!.id,
      passes: rows,
      breachCount,
      failed: breachCount * 2 > passes.length,
    }
  })
}

export const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
