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

export type Thresholds = {
  medianPct: number
  minPct: number
  winRateCeiling: number
  /**
   * The SIGN TEST: a small effect that is nonetheless unambiguous.
   *
   * Sides are measured in adjacent, order-alternated pairs, so under the null
   * hypothesis "these two builds are the same" each pair is a coin flip and the
   * head side should win about half. Losing 1 of 12 has p ≈ 0.003 — that is not a
   * busy machine, it is a slower build, however small the percentage.
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
   */
  signTest: {
    winRateCeiling: number
    medianPct: number
    minPct: number
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

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

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
      return git(['rev-parse', sha], root).trim() !== git(['rev-parse', 'HEAD'], dir).trim()
    } catch {
      return true // cannot confirm ⇒ treat as stale
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

export type Samples = Map<string, number[]>

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
  refCases: readonly Case[],
  headCases: readonly Case[],
  reps: Map<string, number>,
  m: Measurement,
): Samples {
  const pairs = refCases.map((c, n) => ({ ref: c, head: headCases[n]! }))
  const samples: Samples = new Map(
    pairs.flatMap(p => [[`ref|${p.ref.id}`, []], [`head|${p.head.id}`, []]] as Array<[string, number[]]>),
  )

  const sample = (c: Case): number => {
    const r = reps.get(c.id)!
    const ts: number[] = []
    for (let k = 0; k < m.timed; k++) {
      const t0 = performance.now()
      c.run(r)
      ts.push(performance.now() - t0)
    }
    return median(ts)
  }

  for (const p of pairs) {
    for (let k = 0; k < m.warmup; k++) { p.ref.run(reps.get(p.ref.id)!); p.head.run(reps.get(p.head.id)!) }
  }

  for (let round = 0; round < m.rounds; round++) {
    // Rotate which case leads the round, so no case permanently owns the cold slot.
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[(i + round) % pairs.length]!
      for (let run = 0; run < m.runs; run++) {
        // Alternate which side of the pair is measured first.
        const first = (round + run) % 2 === 0 ? p.ref : p.head
        const second = first === p.ref ? p.head : p.ref
        first.run(reps.get(first.id)!)
        second.run(reps.get(second.id)!)
        const a = sample(first)
        const b = sample(second)
        samples.get(`${first === p.ref ? 'ref' : 'head'}|${p.ref.id}`)!.push(a)
        samples.get(`${second === p.ref ? 'ref' : 'head'}|${p.ref.id}`)!.push(b)
      }
    }
  }
  return samples
}

export type Row = {
  id: string
  detail: string
  refMedian: number
  headMedian: number
  refMin: number
  headMin: number
  dMedian: number
  dMin: number
  wins: number
  pairs: number
  breach: boolean
}

export function score(cases: readonly Case[], samples: Samples, t: Thresholds): Row[] {
  return cases.map(c => {
    const a = samples.get(`ref|${c.id}`)!
    const b = samples.get(`head|${c.id}`)!
    const dMedian = (median(b) / median(a) - 1) * 100
    const dMin = (Math.min(...b) / Math.min(...a) - 1) * 100
    let wins = 0
    for (let n = 0; n < b.length; n++) if (b[n]! < a[n]!) wins++
    const winRate = wins / b.length
    const large = (dMedian > t.medianPct || dMin > t.minPct) && winRate <= t.winRateCeiling
    const small = winRate <= t.signTest.winRateCeiling
      && dMedian > t.signTest.medianPct
      && dMin > t.signTest.minPct
    return {
      id: c.id,
      detail: c.detail,
      refMedian: median(a),
      headMedian: median(b),
      refMin: Math.min(...a),
      headMin: Math.min(...b),
      dMedian,
      dMin,
      wins,
      pairs: b.length,
      breach: large || small,
    }
  })
}

export type Verdict = {
  id: string
  detail: string
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
 */
export function verdicts(passes: readonly Row[][]): Verdict[] {
  const first = passes[0]!
  return first.map((_, n) => {
    const rows = passes.map(p => p[n]!)
    const breachCount = rows.filter(r => r.breach).length
    return {
      id: first[n]!.id,
      detail: first[n]!.detail,
      passes: rows,
      breachCount,
      failed: breachCount * 2 > passes.length,
    }
  })
}

export const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
