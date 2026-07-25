/**
 * CROSS-PROCESS A/B for the grammar-density cases — the confirmation step for a
 * `perf:guard:grammars` reading.
 *
 * ## Why this exists
 *
 * `perf:guard:grammars` loads both sides of the A/B into ONE process and
 * interleaves them. That is what makes it self-calibrating and fast, and it is
 * the right default. But it also means both sides' compiled parsers share a
 * heap, a module registry and a JIT profile — so a case sitting near an
 * optimization cliff can be pushed across that cliff by the mere PRESENCE of the
 * other side's code, including by code it never executes. V8's inlining
 * decisions are bytecode-size based, so a dead branch is not free to a
 * measurement even though it is free to a run.
 *
 * That is not hypothetical. `expected/narrow` read +21.9%…+26.2% median, winning
 * 0 of 12 pairs across several runs, on a change whose only emitted difference
 * for that case was inside a host branch the case never enters. Measured across
 * processes the same two commits read neutral (0.4874 ms vs 0.4873 ms, 5 of 9
 * rounds to the branch). See `docs/design/perf-harness-interleaving.md`.
 *
 * ## What this does instead
 *
 * One fresh `node` process per side per round, order alternated between rounds.
 * Neither side ever sees the other's code, so the interference this is testing
 * for cannot occur. The price is that a cross-process comparison DOES carry a
 * between-launch term — which is why this is a confirmation tool and not a gate.
 * Read the win rate across rounds, not any single round.
 *
 * Usage:
 *   pnpm perf:xproc                              # config reference vs the working tree
 *   pnpm perf:xproc --ref=<sha>                  # move the A side
 *   pnpm perf:xproc --head-ref=<sha>             # build the B side from a commit
 *   pnpm perf:xproc --case=expected/narrow       # substring filter on case id
 *   pnpm perf:xproc --rounds=9 --reps=40         # rounds, and timed samples per process
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SELF = path.join(HERE, 'xproc-ab.ts')
const CONFIG_PATH = path.join(HERE, 'grammar-density', 'config.json')

const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null

const median = (a: readonly number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// ── worker: ONE side, ONE process ───────────────────────────────────────────
//
// Re-entering this same file keeps the two halves of the measurement in one
// reviewable place; the worker never imports the parent's state because it is a
// separate process by construction.

const WORKER_DIR = argValue('--worker-dir')
if (WORKER_DIR !== null) {
  const caseId = argValue('--worker-case')!
  const reps = Number(argValue('--worker-reps') ?? 40)

  const pm = await import(path.join(WORKER_DIR, 'src', 'index.ts')) as {
    compile: (c: unknown) => { parseWithContext: (input: string, ctx: unknown, pos?: number) => unknown }
  }
  const g = await import(path.join(WORKER_DIR, 'bench', 'grammar-density', 'grammar.ts')) as {
    caseGrammar: (c: { kind: string; n: number }) => unknown
    caseInput: (c: { kind: string }, rules: number) => string
    DENSITY_CASES: ReadonlyArray<{ id: string; kind: string; n: number }>
  }

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { input: { rules: number } }
  const c = g.DENSITY_CASES.find(x => x.id === caseId)
  if (!c) throw new Error(`xproc-ab: no case ${caseId}`)

  const compiled = pm.compile(g.caseGrammar(c))
  const input = g.caseInput(c, config.input.rules)
  const parse = (): unknown => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)

  for (let k = 0; k < 200; k++) parse()

  const samples: number[] = []
  for (let s = 0; s < reps; s++) {
    const t0 = performance.now()
    for (let n = 0; n < 5; n++) parse()
    samples.push((performance.now() - t0) / 5)
  }
  console.log(JSON.stringify({ median: median(samples), min: Math.min(...samples) }))
  process.exit(0)
}

// ── parent ──────────────────────────────────────────────────────────────────

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
  referenceSha: string
  input: { rules: number }
}

const REF = argValue('--ref') ?? CONFIG.referenceSha
const HEAD_REF = argValue('--head-ref')
const CASE_FILTER = argValue('--case')
const ROUNDS = Number(argValue('--rounds') ?? 9)
const REPS = Number(argValue('--reps') ?? 40)

function fail(message: string): never {
  console.error(`\nxproc-ab: ${message}`)
  process.exit(1)
}

function sh(args: string[], cwd = ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Same materialisation as `bench/grammar-perf-guard.ts`: a `git worktree` at the
 * pinned sha, this repo's `node_modules` symlinked in, and the WORKING TREE's
 * grammar copied over the top so both sides compile byte-identical grammar
 * input. Deliberately identical so a cross-process reading and a gate reading
 * are comparing the same two things.
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
        `could not create a worktree at ${sha}. This compares against a pinned commit of THIS repo, `
        + `so the commit must be present — a shallow clone cannot see it.\n${String(error).slice(0, 500)}`,
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

type Reading = { median: number; min: number }

function measure(dir: string, caseId: string): Reading {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', SELF, `--worker-dir=${dir}`, `--worker-case=${caseId}`, `--worker-reps=${REPS}`],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (r.status !== 0) fail(`worker for ${caseId} in ${dir} exited ${r.status}:\n${r.stderr}`)
  const line = r.stdout.trim().split('\n').at(-1)
  if (line === undefined) fail(`worker for ${caseId} in ${dir} printed nothing:\n${r.stderr}`)
  return JSON.parse(line) as Reading
}

const refDir = materialise(REF)
const headDir = materialise(HEAD_REF)
const headSha = sh(['rev-parse', '--short', 'HEAD']).trim()

const { DENSITY_CASES } = await import(path.join(ROOT, 'bench', 'grammar-density', 'grammar.ts')) as {
  DENSITY_CASES: ReadonlyArray<{ id: string }>
}
const cases = DENSITY_CASES.filter(c => CASE_FILTER === null || c.id.includes(CASE_FILTER))
if (cases.length === 0) fail(`no case matches --case=${CASE_FILTER}`)

console.log(
  `xproc-ab: ${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs reference ${REF}`
  + `\n  ${ROUNDS} rounds x ${REPS} samples, ONE FRESH PROCESS PER SIDE PER ROUND, order alternated`
  + `\n  confirmation tool — it does not gate\n`,
)

const sign = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

let anyBreach = false
for (const c of cases) {
  console.log(`${c.id}`)
  const refMed: number[] = []
  const headMed: number[] = []
  const refMin: number[] = []
  const headMin: number[] = []
  let wins = 0

  for (let round = 1; round <= ROUNDS; round++) {
    // Alternate which side launches first, so a warm page cache or a settling
    // machine cannot land on the same side every round.
    const refFirst = round % 2 === 1
    const a = refFirst ? measure(refDir, c.id) : null
    const b = measure(headDir, c.id)
    const a2 = a ?? measure(refDir, c.id)

    refMed.push(a2.median)
    headMed.push(b.median)
    refMin.push(a2.min)
    headMin.push(b.min)
    if (b.median < a2.median) wins++

    console.log(
      `  round ${String(round).padStart(2)}  ${refFirst ? 'ref first ' : 'head first'}`
      + `   ref median ${a2.median.toFixed(4)} min ${a2.min.toFixed(4)}`
      + `   head median ${b.median.toFixed(4)} min ${b.min.toFixed(4)} ms`,
    )
  }

  const refMean = refMed.reduce((s, n) => s + n, 0) / refMed.length
  const headMean = headMed.reduce((s, n) => s + n, 0) / headMed.length
  const dMed = (median(headMed) / median(refMed) - 1) * 100
  const dMin = (Math.min(...headMin) / Math.min(...refMin) - 1) * 100
  const dMean = (headMean / refMean - 1) * 100
  // Not a gate: a cross-process reading carries a between-launch term the
  // interleaved gate does not have. Flagged, so the caller has something to
  // read, but the win rate is the part that means anything.
  const suspect = wins <= ROUNDS / 4 && dMed > 6
  if (suspect) anyBreach = true

  console.log(
    `  ${suspect ? 'SUSPECT' : 'neutral'}`
    + `   median-of-rounds ${median(refMed).toFixed(4)} → ${median(headMed).toFixed(4)} ms (${sign(dMed)})`
    + `   mean ${refMean.toFixed(4)} → ${headMean.toFixed(4)} ms (${sign(dMean)})`
    + `   best min ${Math.min(...refMin).toFixed(4)} → ${Math.min(...headMin).toFixed(4)} ms (${sign(dMin)})`
    + `   head won ${wins}/${ROUNDS} rounds\n`,
  )
}

console.log(
  anyBreach
    ? 'xproc-ab: at least one case looks slower ACROSS processes too — the interleaved reading is corroborated.'
    : 'xproc-ab: no case is consistently slower across processes.',
)
