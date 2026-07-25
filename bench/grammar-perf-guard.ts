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
 * ## Median AND min AND win rate
 *
 * A single median is not a measurement. The first attempt at measuring the real
 * regression produced a wrong number that way. The gate reports all three and
 * requires two independent signals to fire.
 *
 * Usage:
 *   pnpm perf:guard:grammars                  # the gate
 *   pnpm perf:guard:grammars --quick          # 2 rounds x 1 run — TRIAGE ONLY, does not gate
 *   pnpm perf:guard:grammars --ref=<sha>      # move the A side
 *   pnpm perf:guard:grammars --head-ref=<sha> # build the B side from a commit, not the working tree
 *
 * The last two exist to REPLAY a known regression and watch the gate go red. A
 * gate nobody has watched fail is not known to work.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(HERE, 'grammar-density', 'config.json')

type Config = {
  referenceSha: string
  input: { rules: number }
  measurement: { targetSampleMs: number; warmup: number; timed: number; rounds: number; runs: number }
  thresholds: { medianPct: number; minPct: number; winRateCeiling: number }
}

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

const QUICK = process.argv.includes('--quick')
const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
const REF = argValue('--ref') ?? CONFIG.referenceSha
const HEAD_REF = argValue('--head-ref')

const M = QUICK ? { ...CONFIG.measurement, rounds: 2, runs: 1 } : CONFIG.measurement

function fail(message: string): never {
  console.error(`\ngrammar-perf-guard: ${message}`)
  process.exit(1)
}

function sh(args: string[], cwd = ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// ── sides ───────────────────────────────────────────────────────────────────

/**
 * Materialise a side of the A/B as a directory whose `src/` is parseman at `sha`
 * and whose `bench/grammar-density/grammar.ts` is the WORKING TREE's copy. The
 * grammar must be identical on both sides or the comparison measures the grammar
 * instead of the compiler.
 *
 * `node_modules` is symlinked rather than installed: nothing here needs a
 * per-sha dependency tree — `src/index.ts` is loaded through tsx, and tsx only
 * transpiles. That keeps the whole gate at seconds rather than minutes, which is
 * a correctness property: a gate too slow to run gets skipped.
 */
function materialise(sha: string | null): string {
  if (sha === null) return ROOT
  const dir = path.join(ROOT, '.cache', `grammar-gate-${sha}`)
  if (!existsSync(path.join(dir, 'src', 'index.ts'))) {
    rmSync(dir, { recursive: true, force: true })
    try { sh(['worktree', 'prune']) } catch { /* nothing to prune */ }
    try {
      sh(['worktree', 'add', '--detach', '--force', dir, sha])
    } catch (error) {
      fail(
        `could not create a worktree at ${sha}. The gate compares against a pinned commit of THIS repo, `
        + `so the commit must be present — a shallow clone cannot see it (CI needs actions/checkout with fetch-depth: 0).\n`
        + `A missing reference is a FAILURE, not a skip.\n${String(error).slice(0, 500)}`,
      )
    }
  }
  const nm = path.join(dir, 'node_modules')
  if (!existsSync(nm)) symlinkSync(path.join(ROOT, 'node_modules'), nm, 'dir')
  mkdirSync(path.join(dir, 'bench', 'grammar-density'), { recursive: true })
  copyFileSync(
    path.join(HERE, 'grammar-density', 'grammar.ts'),
    path.join(dir, 'bench', 'grammar-density', 'grammar.ts'),
  )
  return dir
}

type Side = {
  label: string
  compile: (c: unknown) => { parseWithContext: (input: string, ctx: unknown, pos?: number) => unknown }
  grammar: (c: { kind: string; n: number }) => unknown
  cases: ReadonlyArray<{ id: string; kind: string; n: number }>
  input: (c: { kind: string }, rules: number) => string
}

async function loadSide(label: string, dir: string): Promise<Side> {
  const pm = await import(path.join(dir, 'src', 'index.ts')) as {
    compile: Side['compile']
  }
  const g = await import(path.join(dir, 'bench', 'grammar-density', 'grammar.ts')) as {
    caseGrammar: Side['grammar']
    caseInput: Side['input']
    DENSITY_CASES: Side['cases']
  }
  return { label, compile: pm.compile, grammar: g.caseGrammar, cases: g.DENSITY_CASES, input: g.caseInput }
}

// ── measurement ─────────────────────────────────────────────────────────────

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

type Impl = { label: string; id: string; run: (reps: number) => void; parse: () => unknown }

function buildImpls(side: Side): Impl[] {
  return side.cases.map(c => {
    const compiled = side.compile(side.grammar(c))
    const input = side.input(c, CONFIG.input.rules)
    const parse = (): unknown => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)
    return {
      label: side.label,
      id: c.id,
      parse,
      run: (reps: number) => { for (let n = 0; n < reps; n++) parse() },
    }
  })
}

/**
 * Repetitions per timed sample, chosen so each sample lands near
 * `targetSampleMs`. Calibrated on the REFERENCE side and applied to BOTH, so the
 * choice can never favour one — and reported, so a reader can see the sample size
 * behind every number.
 */
function calibrate(impls: Impl[]): Map<string, number> {
  const reps = new Map<string, number>()
  for (const i of impls) {
    for (let k = 0; k < 20; k++) i.parse()
    const ts: number[] = []
    for (let k = 0; k < 9; k++) {
      const t0 = performance.now()
      i.parse()
      ts.push(performance.now() - t0)
    }
    const one = median(ts)
    reps.set(i.id, Math.max(1, Math.round(CONFIG.measurement.targetSampleMs / Math.max(one, 0.01))))
  }
  return reps
}

/**
 * Both sides must produce the SAME parse. A gate that times two different parses
 * is not a gate — and the cheapest way for a reference side to look fast is to
 * stop doing work. Compared structurally rather than by identity because the two
 * sides build their nodes from two separate module graphs.
 */
function assertSameParse(a: Impl[], b: Impl[]): void {
  for (let n = 0; n < a.length; n++) {
    const ra = JSON.stringify(a[n]!.parse())
    const rb = JSON.stringify(b[n]!.parse())
    if (ra !== rb) {
      fail(`case ${a[n]!.id}: the two sides produced DIFFERENT parse results, so their timings are not comparable.`)
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const headSha = sh(['rev-parse', '--short', 'HEAD']).trim()
const refDir = materialise(REF)
const headDir = materialise(HEAD_REF)

console.log(`grammar-perf-guard: ${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`)

const ref = await loadSide('ref', refDir)
const head = await loadSide('head', headDir)

// Every case's input must be byte-identical across the sides, per AXIS — the
// copy is what makes the comparison about parseman rather than about the bench.
for (const c of ref.cases) {
  if (ref.input(c, CONFIG.input.rules) !== head.input(c, CONFIG.input.rules)) {
    fail(`the two sides generated different input for ${c.id} — the grammar copy did not take.`)
  }
}
if (ref.cases.length !== head.cases.length) fail('the two sides declare different cases — the grammar copy did not take.')

const refImpls = buildImpls(ref)
const headImpls = buildImpls(head)
assertSameParse(refImpls, headImpls)

const reps = calibrate(refImpls)
console.log(
  `  ${(ref.input(ref.cases[0]!, CONFIG.input.rules).length / 1024).toFixed(1)} KB input`
  + `   ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples, interleaved in one process`
  + `${QUICK ? '  [--quick: TRIAGE ONLY, not a gate]' : ''}`,
)
console.log(`  repetitions per sample: ${ref.cases.map(c => `${c.id.split('/')[1]} ${reps.get(c.id)}`).join(', ')}`)

const impls = [...refImpls, ...headImpls]
const samples = new Map<string, number[]>(impls.map(i => [`${i.label}|${i.id}`, []]))
for (const i of impls) for (let k = 0; k < M.warmup; k++) i.run(reps.get(i.id)!)

for (let round = 0; round < M.rounds; round++) {
  // Rotate order each round so a fixed position never favours one side.
  const order = impls.map((_, n) => impls[(n + round) % impls.length]!)
  for (let run = 0; run < M.runs; run++) {
    for (const i of order) {
      const r = reps.get(i.id)!
      for (let k = 0; k < 2; k++) i.run(r)
      const ts: number[] = []
      for (let k = 0; k < M.timed; k++) {
        const t0 = performance.now()
        i.run(r)
        ts.push(performance.now() - t0)
      }
      samples.get(`${i.label}|${i.id}`)!.push(median(ts))
    }
  }
}

const T = CONFIG.thresholds
console.log(`\nper-case result (fails on median > ${T.medianPct}% OR min > ${T.minPct}% slower, AND <= ${Math.round(T.winRateCeiling * 100)}% of pairs won)\n`)

const failures: string[] = []
for (const c of ref.cases) {
  const a = samples.get(`ref|${c.id}`)!
  const b = samples.get(`head|${c.id}`)!
  const dMed = (median(b) / median(a) - 1) * 100
  const dMin = (Math.min(...b) / Math.min(...a) - 1) * 100
  let wins = 0
  for (let n = 0; n < b.length; n++) if (b[n]! < a[n]!) wins++
  const winRate = wins / b.length
  const breach = (dMed > T.medianPct || dMin > T.minPct) && winRate <= T.winRateCeiling
  const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
  console.log(
    `  ${breach ? 'FAIL' : 'ok  '}  ${c.id.padEnd(17)}`
    + ` ${String(c.n).padStart(2)} ${c.kind === 'expected' ? 'opt/arm    ' : 'probes/value'}`
    + `   median ${median(a).toFixed(2)} → ${median(b).toFixed(2)} ms (${sign(dMed)})`
    + `   min ${Math.min(...a).toFixed(2)} → ${Math.min(...b).toFixed(2)} ms (${sign(dMin)})`
    + `   won ${wins}/${b.length}`,
  )
  if (breach) failures.push(`${c.id}: median ${sign(dMed)}, min ${sign(dMin)}, won ${wins}/${b.length}`)
}

if (QUICK) {
  console.log('\n--quick is triage only — it does not gate. Run without it before landing.')
  process.exit(0)
}
if (failures.length > 0) {
  console.error(`\ngrammar-perf-guard: REGRESSION in ${failures.length} case(s) vs ${REF}:`)
  for (const f of failures) console.error(`  ${f}`)
  console.error(
    '\nRead the SPREAD, per axis. Within `rollback/*` only the probes per byte move, so a delta that'
    + '\ngrows with the probe count is a per-EXECUTION cost on a rollback path. Within `expected/*` only'
    + '\nthe derived expected-set width moves, so a delta that appears at `wide` and not at `narrow` is a'
    + '\ncost that scales with how many tokens a losing choice names. Either shape reaches real grammars'
    + '\namplified by their own density — and a regression on ONE axis reads flat on the other, which is'
    + '\nhow 0.35.0 shipped a 32% Less regression past a sweep that watched rollbacks only.'
    + '\n\nDo not widen the threshold to make this pass. Either fix it, or land the number visibly.',
  )
  process.exit(1)
}
console.log('\ngrammar-perf-guard: ok')
