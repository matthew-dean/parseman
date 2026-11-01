/**
 * The cross-process perf gate: every timed parser is the only parser in its process.
 *
 * ## Why
 *
 * Users run one parser per process under V8's default configuration. The in-process
 * gates put four instances of every case in one heap and interleave them, so V8's
 * per-instance decisions (which allocation sites it pretenures, what a GC moved,
 * which instance it built last) land on one side of a pair and stay there for the
 * pass. They read as ±5–25% per pass on identical code (parseman#175). Turning those
 * V8 behaviours off would hide real regressions that users hit, so this gate changes
 * no V8 setting. It measures them the way they happen in production instead: once per
 * process, and it averages over enough processes.
 *
 * ## Design
 *
 * - **One instance per process.** A worker loads one side, builds one case, warms it
 *   and times it. Nothing else is compiled in that process.
 * - **Rounds, order alternated.** Each round runs one reference process and one head
 *   process per case, back to back. Which goes first alternates by round and by case,
 *   so a machine that is settling cannot favour one side.
 * - **Paired statistics over processes.** Per case, each round gives
 *   `ln(head / ref)` of the process medians. The case FAILS when the median of those
 *   over rounds exceeds `floorPct` AND an exact one-sided sign test over rounds gives
 *   p below `alpha`. The sign test assumes only that, with identical code, head is as
 *   likely to be slower as faster in a round. Alternating order is what makes that
 *   true.
 * - **Same-parse check.** Every worker reports a digest of its parse result, and the
 *   two sides must agree in every round.
 *
 * Usage:
 *   pnpm perf:xproc:gate                      # HEAD vs the previous release
 *   pnpm perf:xproc:gate --ref=<sha>          # another reference
 *   pnpm perf:xproc:gate --head-ref=<sha>     # head from a commit, not the working tree
 *   pnpm perf:xproc:gate --self               # the reference against itself (the A/A null)
 *   pnpm perf:xproc:gate --suite=density      # only the density cases (or --suite=workloads)
 *   pnpm perf:xproc:gate --peak               # the workloads against the committed peak release
 *   pnpm perf:xproc:gate --case=json          # substring filter on case id
 *   pnpm perf:xproc:gate --rounds=20          # override the configured round count
 *   pnpm perf:xproc:gate --report-only        # measure and print; never fail
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialise, previousRelease, git, fail, median, sign, sameSource, summary } from './ab-harness.ts'

const GATE = 'xproc-gate'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SELF_FILE = fileURLToPath(import.meta.url)
const CONFIG_PATH = path.join(HERE, 'xproc-gate.json')

type SuiteConfig = { warmup: number; samples: number; parsesPerSample: number }
type Config = {
  rounds: number
  floorPct: number
  alpha: number
  density: SuiteConfig & { rules: number }
  workloads: SuiteConfig
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null

type Reading = { median: number; min: number; digest: string }

// ── worker: ONE instance of ONE case, in a process of its own ────────────────

const WORKER = argValue('--worker')
if (WORKER !== null) {
  const [dir, suite, id, pad] = JSON.parse(WORKER) as [string, 'density' | 'workloads', string, number]
  // Layout randomisation, the only thing a worker does that is not the parse. A
  // deterministic process puts every object and code page at the same offsets on
  // every run, so the two sides' different paths alone gave fixed offsets on
  // identical code: `graphql/document` −5.7% and `css/stylesheet` +1.8% in 10 of
  // 10 A/A runs. A retained allocation of random size, made before anything is
  // loaded, moves everything after it. The offset becomes per-process noise, which
  // the rounds average, instead of a per-side bias, which they cannot.
  const shift = new Array<number>(pad).fill(0)
  ;(globalThis as { __pmLayoutShift?: number[] }).__pmLayoutShift = shift
  let parse: () => unknown
  if (suite === 'density') {
    const pm = await import(path.join(dir, 'src', 'index.ts')) as {
      compile: (c: unknown) => { parseWithContext: (input: string, ctx: unknown, pos?: number) => unknown }
    }
    const g = await import(path.join(dir, 'bench', 'grammar-density', 'grammar.ts')) as {
      caseGrammar: (c: { kind: string; n: number }) => unknown
      caseInput: (c: { kind: string }, rules: number) => string
      DENSITY_CASES: ReadonlyArray<{ id: string; kind: string; n: number }>
    }
    const c = g.DENSITY_CASES.find(x => x.id === id)
    if (c === undefined) throw new Error(`no density case ${id}`)
    const compiled = pm.compile(g.caseGrammar(c))
    const input = g.caseInput(c, CONFIG.density.rules)
    parse = () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)
  } else {
    const w = (await import(path.join(dir, 'bench', 'workloads', 'index.ts')) as {
      buildWorkloads: () => Array<{ id: string; make: () => { parse: () => unknown } }>
    }).buildWorkloads().find(x => x.id === id)
    if (w === undefined) throw new Error(`no workload ${id}`)
    const built = w.make()
    parse = () => built.parse()
  }
  const s = CONFIG[suite]
  const digest = createHash('sha256').update(JSON.stringify(parse())).digest('hex').slice(0, 16)
  for (let k = 0; k < s.warmup; k++) parse()
  const samples: number[] = []
  for (let k = 0; k < s.samples; k++) {
    const t0 = performance.now()
    for (let n = 0; n < s.parsesPerSample; n++) parse()
    samples.push((performance.now() - t0) / s.parsesPerSample)
  }
  console.log(JSON.stringify({ median: median(samples), min: Math.min(...samples), digest } satisfies Reading))
  process.exit(0)
}

// ── parent ───────────────────────────────────────────────────────────────────

const SELF = process.argv.includes('--self')
const REPORT_ONLY = process.argv.includes('--report-only')
/**
 * The peak clause: the workloads against the fastest release on record, with the
 * committed drawdown allowance as the floor. The bar lives in
 * `bench/workloads/config.json` (`peak`), where `scripts/check-changelog.mjs` guards it.
 */
const PEAK = process.argv.includes('--peak')
const PEAK_CONFIG = (JSON.parse(readFileSync(path.join(HERE, 'workloads', 'config.json'), 'utf8')) as {
  peak: { sha: string; version: string; allowancePct: number }
}).peak
const REF_ARG = argValue('--ref')
if (PEAK && (SELF || REF_ARG !== null)) fail(GATE, '--peak names its own reference and cannot be combined with --ref or --self.')
const SUITE = PEAK ? 'workloads' : argValue('--suite')
const FLOOR = PEAK ? PEAK_CONFIG.allowancePct : CONFIG.floorPct
const REFERENCE = PEAK
  ? { tag: `peak ${PEAK_CONFIG.version}`, sha: PEAK_CONFIG.sha }
  : REF_ARG === null ? previousRelease(ROOT, GATE) : { tag: REF_ARG, sha: REF_ARG }
const REF = REFERENCE.sha
const HEAD_REF = SELF ? REF : argValue('--head-ref')
const FILTER = argValue('--case')
const ROUNDS = Number(argValue('--rounds') ?? CONFIG.rounds)
if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 2) fail(GATE, `--rounds must be an integer >= 2`)

const COPY = ['bench/grammar-density', 'bench/workloads', 'examples'] as const
const refDir = materialise(GATE, ROOT, REF, COPY)
const headDir = HEAD_REF === null ? workingTreeCopy() : materialise(GATE, ROOT, HEAD_REF, COPY)

/**
 * The working tree, copied to a sibling of the reference's directory so neither
 * side runs from a different kind of path. `-worktree` is as long as an 8-digit sha.
 */
function workingTreeCopy(): string {
  const dir = path.join(ROOT, '.cache', `${GATE}-worktree`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const rel of ['src', 'package.json', 'tsconfig.json', ...COPY]) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true })
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
const IDENTICAL = !SELF && sameSource(ROOT, REF, HEAD_REF)

const WORKER_TIMEOUT_MS = 180_000
function measure(dir: string, suite: string, id: string): Reading {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', SELF_FILE, `--worker=${JSON.stringify([dir, suite, id, Math.floor(Math.random() * 65_536)])}`],
    // The environment's size moves the initial stack, so it is randomised too.
    { cwd: ROOT, encoding: 'utf8', timeout: WORKER_TIMEOUT_MS, env: { ...process.env, PM_LAYOUT_PAD: 'x'.repeat(Math.floor(Math.random() * 4096)) } },
  )
  if (r.error !== undefined) fail(GATE, `worker for ${id} in ${dir} did not complete: ${String(r.error)}`)
  if (r.status !== 0) fail(GATE, `worker for ${id} in ${dir} exited ${r.status}:\n${r.stderr.slice(-2000)}`)
  const line = r.stdout.trim().split('\n').at(-1)
  if (line === undefined) fail(GATE, `worker for ${id} in ${dir} printed nothing:\n${r.stderr.slice(-2000)}`)
  return JSON.parse(line) as Reading
}

const density = (await import(path.join(ROOT, 'bench', 'grammar-density', 'grammar.ts')) as {
  DENSITY_CASES: ReadonlyArray<{ id: string }>
}).DENSITY_CASES.map(c => ({ suite: 'density', id: c.id }))
const workloads = (await import(path.join(ROOT, 'bench', 'workloads', 'index.ts')) as {
  buildWorkloads: () => Array<{ id: string }>
}).buildWorkloads().map(w => ({ suite: 'workloads', id: w.id }))
const cases = [...density, ...workloads]
  .filter(c => (SUITE === null || c.suite === SUITE) && (FILTER === null || c.id.includes(FILTER)))
if (cases.length === 0) fail(GATE, `no case matches --case=${FILTER}`)

/** Exact one-sided binomial tail: P(X >= k) for X ~ Bin(n, 1/2). */
function signTestP(k: number, n: number): number {
  let p = 0
  let c = 1
  for (let i = 0; i <= n; i++) {
    if (i >= k) p += c
    c = c * (n - i) / (i + 1)
  }
  return p / 2 ** n
}

const headSha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim()
console.log(
  `${GATE}: ${SELF ? `SELF-CHECK — ${REF} against itself` : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs ${REFERENCE.tag === REF ? REF : `${REFERENCE.tag} (${REF})`}`}`
  + `\n  ${ROUNDS} rounds x ${cases.length} cases, ONE PROCESS PER SIDE PER CASE PER ROUND, order alternated, default V8`
  + `\n  a case FAILS when its median per-round slowdown exceeds ${FLOOR}% AND the sign test over rounds gives p < ${CONFIG.alpha}\n`,
)

const logs = new Map(cases.map(c => [c.id, [] as number[]]))
const minLogs = new Map(cases.map(c => [c.id, [] as number[]]))
const t0 = Date.now()
for (let round = 0; round < ROUNDS; round++) {
  for (let n = 0; n < cases.length; n++) {
    const c = cases[n]!
    const refFirst = (round + n) % 2 === 0
    const first = measure(refFirst ? refDir : headDir, c.suite, c.id)
    const second = measure(refFirst ? headDir : refDir, c.suite, c.id)
    const [ref, head] = refFirst ? [first, second] : [second, first]
    if (ref.digest !== head.digest) {
      fail(GATE, `case ${c.id}: the two sides produced DIFFERENT parse results (ref ${ref.digest}, head ${head.digest}).`)
    }
    logs.get(c.id)!.push(Math.log(head.median / ref.median))
    minLogs.get(c.id)!.push(Math.log(head.min / ref.min))
  }
  console.log(`  round ${round + 1}/${ROUNDS} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}

const pct = (x: number): number => (Math.exp(x) - 1) * 100
const rows = cases.map(c => {
  const d = logs.get(c.id)!
  const slower = d.filter(x => x > 0).length
  const p = signTestP(slower, d.length)
  const center = pct(median(d))
  const failed = center > FLOOR && p < CONFIG.alpha
  return { id: c.id, center, min: pct(median(minLogs.get(c.id)!)), slower, n: d.length, p, failed }
})
for (const r of rows) {
  console.log(
    `  ${r.failed ? 'FAIL' : 'ok  '}  ${r.id.padEnd(17)} center ${sign(r.center).padStart(6)}, min ${sign(r.min).padStart(6)}`
    + `   head slower in ${r.slower}/${r.n} rounds, sign test p ${r.p.toExponential(1)}`,
  )
}
console.log(`ROWS ${JSON.stringify(Object.fromEntries(cases.map(c => [c.id, logs.get(c.id)!.map(x => +pct(x).toFixed(3))])))}`)
const gating = !REPORT_ONLY && !SELF && !IDENTICAL
summary([
  `#### ${GATE}: ${SELF ? 'self-check' : `HEAD vs ${REFERENCE.tag}`} — one process per side per case, ${ROUNDS} rounds`,
  '',
  '| case | center Δ | min Δ | head slower | sign-test p | verdict |',
  '| --- | ---: | ---: | ---: | ---: | --- |',
  ...rows.map(r => `| ${r.id} | ${sign(r.center)} | ${sign(r.min)} | ${r.slower}/${r.n} | ${r.p.toExponential(1)} | ${gating ? (r.failed ? '**FAIL**' : 'ok') : 'report only'} |`),
].join('\n'))

const failures = rows.filter(r => r.failed)
if (IDENTICAL) {
  console.log(`\n${GATE}: HEAD's src/ is the reference's, so this run is an A/A control and gates nothing.`
    + `${failures.length === 0 ? ' No case breached.' : ` It breached on ${failures.map(f => f.id).join(', ')}.`}`)
  process.exit(0)
}
if (!gating) process.exit(0)
if (failures.length > 0) {
  console.error(`\n${GATE}: REGRESSION in ${failures.map(f => f.id).join(', ')} vs ${REF}.`)
  process.exit(1)
}
console.log(`\n${GATE}: ok`)
