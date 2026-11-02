/**
 * The cross-process perf gate: every timed parser is the only parser in its process,
 * under the runtime a user gets.
 *
 * ## Why
 *
 * The in-process A/B tools put four instances of every case in one heap, so V8's
 * per-instance decisions (which allocation sites it pretenures, what a GC moved, which
 * instance it built last) land on one side of a pair and stay there for the pass. They
 * read as ±5–25% per pass on identical code (parseman#175). Those decisions are part of
 * how users' parsers run, so this gate changes no V8 or Node setting. It measures them
 * as they happen in production, once per process, and it averages over enough
 * processes. See docs/design/perf-harness-interleaving.md.
 *
 * ## Design
 *
 * - **The user's build, plain `node`.** Each side is built with its own
 *   `scripts/build.mjs`, the `dist/` bundle a user installs. `bench/xproc-worker.ts` is
 *   bundled once, with parseman left external as `./dist/index.js`. Workers run as
 *   `node worker.mjs` with no flags, no `NODE_OPTIONS` and no loader. The worker refuses
 *   to measure otherwise.
 * - **One instance per process, one path for both sides.** Before each worker, its
 *   side's `dist/` is copied into `.cache/xproc-gate-run`, so every process loads the
 *   same paths and only the code differs.
 * - **Rounds, random order.** Each round runs one reference process and one head process
 *   per case, back to back, in random order. Every random choice comes from one seeded
 *   generator; the seed is printed and stored, and `--seed=<n>` replays a run.
 * - **Layout randomisation.** Each worker gets a retained allocation of random size and
 *   an environment variable of random length that nothing reads, so a side's fixed
 *   memory layout becomes noise the rounds average out.
 * - **Two tests per case, α split.** Each round gives `ln(head / ref)` of the two process
 *   medians. A case FAILS when the median slowdown is over the floor with a significant
 *   sign test, OR the mean slowdown is over the floor with a significant sign-flip test
 *   on the mean. The second sees a regression that only some processes suffer
 *   (`bench/xproc-stats.ts`).
 * - **Sharded.** CI runs shards in parallel and takes one verdict over all of them. It
 *   fails if any shard is missing, short, foreign or corrupt.
 * - **Same-parse check.** Every worker reports a digest of its parse result, and the two
 *   sides must agree in every round.
 *
 * Usage:
 *   pnpm perf:xproc:gate                      # HEAD vs the previous release
 *   pnpm perf:xproc:gate --ref=<sha>          # another reference
 *   pnpm perf:xproc:gate --head-ref=<sha>     # head from a commit, not the working tree
 *   pnpm perf:xproc:gate --self               # the reference against itself (the A/A null)
 *   pnpm perf:xproc:gate --suite=density      # only the density cases (or --suite=workloads)
 *   pnpm perf:xproc:gate --peak               # the workloads against the committed peak release
 *   pnpm perf:xproc:gate --case=json          # substring filter on case id
 *   pnpm perf:xproc:gate --rounds=20          # override every case's round count
 *   pnpm perf:xproc:gate --report-only        # measure and print; never fail
 *   pnpm perf:xproc:gate --shard-out=<file>   # measure, write the rounds to <file>, no verdict
 *   pnpm perf:xproc:gate --aggregate=<dir> --expect-shards=<n>   # the verdict over all n shards
 *   pnpm perf:xproc:gate --seed=<n>           # replay a run's order and layout padding
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { materialise, previousRelease, git, fail, sign, sameSource, summary } from './ab-harness.ts'
import { caseVerdict, mergeShards, type Shard, type VerdictSettings } from './xproc-stats.ts'

const GATE = 'xproc-gate'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(HERE, 'xproc-gate.json')

type SuiteConfig = { warmup: number; samples: number; parsesPerSample: number }
type Config = {
  /** Rounds per shard for every case not named in `roundsByCase`. */
  rounds: number
  /** Rounds per shard where a case needs another count to reach its power target. */
  roundsByCase: Record<string, number>
  floorPct: number
  alphaMedian: number
  alphaMean: number
  flips: number
  density: SuiteConfig & { rules: number }
  workloads: SuiteConfig
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config
const WORKER_TIMEOUT_MS = 180_000

const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null

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
const SHARD_OUT = argValue('--shard-out')
const AGGREGATE = argValue('--aggregate')
const REF_ARG = argValue('--ref')
if (PEAK && (SELF || REF_ARG !== null)) fail(GATE, '--peak names its own reference and cannot be combined with --ref or --self.')
const SUITE = PEAK ? 'workloads' : argValue('--suite')
const SETTINGS: VerdictSettings = {
  floorPct: PEAK ? PEAK_CONFIG.allowancePct : CONFIG.floorPct,
  alphaMedian: CONFIG.alphaMedian,
  alphaMean: CONFIG.alphaMean,
  flips: CONFIG.flips,
}
const REFERENCE = PEAK
  ? { tag: `peak ${PEAK_CONFIG.version}`, sha: PEAK_CONFIG.sha }
  : REF_ARG === null ? previousRelease(ROOT, GATE) : { tag: REF_ARG, sha: REF_ARG }
const REF = REFERENCE.sha
const HEAD_REF = SELF ? REF : argValue('--head-ref')
const FILTER = argValue('--case')
const ROUNDS_ARG = argValue('--rounds')
if (ROUNDS_ARG !== null && !(Number.isSafeInteger(Number(ROUNDS_ARG)) && Number(ROUNDS_ARG) >= 2)) fail(GATE, '--rounds must be an integer >= 2')
/** `--rounds` overrides every case; otherwise each case gets its configured count. */
const roundsFor = (id: string): number => ROUNDS_ARG !== null ? Number(ROUNDS_ARG) : CONFIG.roundsByCase[id] ?? CONFIG.rounds
const IDENTICAL = !SELF && sameSource(ROOT, REF, HEAD_REF)

/**
 * Every random choice comes from one seeded generator, so a run can be replayed:
 * `--seed=<n>` reproduces which side went first in every round and every process's
 * layout padding. The seed is printed and written to the shard file.
 */
const SEED = Number(argValue('--seed') ?? Math.floor(Math.random() * 2 ** 31))
let state = SEED >>> 0
const random = (): number => {
  // mulberry32
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
}

const density = (await import(path.join(ROOT, 'bench', 'grammar-density', 'grammar.ts')) as {
  DENSITY_CASES: ReadonlyArray<{ id: string }>
}).DENSITY_CASES.map(c => ({ suite: 'density' as const, id: c.id }))
const workloads = (await import(path.join(ROOT, 'bench', 'workloads', 'index.ts')) as {
  buildWorkloads: () => Array<{ id: string }>
}).buildWorkloads().map(w => ({ suite: 'workloads' as const, id: w.id }))
const cases = [...density, ...workloads]
  .filter(c => (SUITE === null || c.suite === SUITE) && (FILTER === null || c.id.includes(FILTER)))
if (cases.length === 0) fail(GATE, `no case matches --case=${FILTER}`)

const headSha = git(['rev-parse', '--short', 'HEAD'], ROOT).trim()
console.log(
  `${GATE}: ${SELF ? `SELF-CHECK — ${REF} against itself` : `${HEAD_REF ? `head-ref ${HEAD_REF}` : `HEAD ${headSha}`} vs ${REFERENCE.tag === REF ? REF : `${REFERENCE.tag} (${REF})`}`}`
  + `\n  ${cases.map(c => `${c.id} ${roundsFor(c.id)}`).join(', ')} rounds,`
  + ` ONE PROCESS PER SIDE PER CASE PER ROUND, random order, each side's dist/ bundle under plain node, seed ${SEED}`
  + `\n  a case FAILS when its median slowdown exceeds ${SETTINGS.floorPct}% with sign-test p < ${SETTINGS.alphaMedian},`
  + ` OR its mean slowdown exceeds ${SETTINGS.floorPct}% with sign-flip p < ${SETTINGS.alphaMean}\n`,
)

let logs: Map<string, number[]>
let minLogs: Map<string, number[]>
if (AGGREGATE !== null) {
  const files = readdirSync(AGGREGATE).filter(f => f.endsWith('.json'))
    .map(name => ({ name, text: readFileSync(path.join(AGGREGATE, name), 'utf8') }))
  try {
    const merged = mergeShards(files, Number(argValue('--expect-shards')), REF, cases.map(c => c.id), roundsFor)
    logs = merged.logs
    minLogs = merged.minLogs
    console.log(`  aggregated ${files.length} shards, seeds ${merged.seeds.join(' ')}`)
  } catch (error) {
    fail(GATE, (error as Error).message)
  }
} else {
  ({ logs, minLogs } = await measureAll())
}

async function measureAll(): Promise<{ logs: Map<string, number[]>; minLogs: Map<string, number[]> }> {
  const COPY = ['bench/grammar-density', 'bench/workloads', 'examples'] as const
  const refDist = buildSide(materialise(GATE, ROOT, REF, COPY))
  const headDist = buildSide(HEAD_REF === null ? workingTreeBuildDir() : materialise(GATE, ROOT, HEAD_REF, COPY))
  const stage = await prepareStage()
  const out = { logs: new Map(cases.map(c => [c.id, [] as number[]])), minLogs: new Map(cases.map(c => [c.id, [] as number[]])) }
  const ROUNDS = Math.max(...cases.map(c => roundsFor(c.id)))
  const t0 = Date.now()
  for (let round = 0; round < ROUNDS; round++) {
    for (const c of cases) {
      if (round >= roundsFor(c.id)) continue
      const refFirst = random() < 0.5
      const first = measure(stage, refFirst ? refDist : headDist, c.suite, c.id)
      const second = measure(stage, refFirst ? headDist : refDist, c.suite, c.id)
      const [ref, head] = refFirst ? [first, second] : [second, first]
      if (ref.digest !== head.digest) {
        fail(GATE, `case ${c.id}: the two sides produced DIFFERENT parse results (ref ${ref.digest}, head ${head.digest}).`)
      }
      out.logs.get(c.id)!.push(Math.log(head.median / ref.median))
      out.minLogs.get(c.id)!.push(Math.log(head.min / ref.min))
    }
    console.log(`  round ${round + 1}/${ROUNDS} done (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
  return out
}

/** The working tree's build inputs, copied beside the reference's so it builds the same way. */
function workingTreeBuildDir(): string {
  const dir = path.join(ROOT, '.cache', `${GATE}-worktree`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const rel of ['src', 'scripts', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) {
    if (existsSync(path.join(ROOT, rel))) cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true })
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}

/** Build a side with its OWN `scripts/build.mjs`: the dist a user of that version installs. */
function buildSide(dir: string): string {
  try {
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 })
  } catch (error) {
    fail(GATE, `could not build ${dir}: ${String((error as { stderr?: unknown }).stderr ?? error).slice(-2000)}`)
  }
  if (!existsSync(path.join(dir, 'dist', 'index.js'))) fail(GATE, `${dir} built no dist/index.js`)
  return path.join(dir, 'dist')
}

/**
 * The one directory every worker runs from. The worker bundle, its fixtures and a
 * `package.json` marking it ESM sit here for the whole run; `dist/` is swapped per
 * process. Paths are inputs to a process's memory layout: with the two sides in two
 * directories, identical code read `graphql/document` −5.7% and `css/stylesheet` +1.8%
 * in 10 runs of 10.
 */
async function prepareStage(): Promise<string> {
  const stage = path.join(ROOT, '.cache', `${GATE}-run`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  writeFileSync(path.join(stage, 'package.json'), '{ "type": "module" }\n')
  cpSync(path.join(HERE, 'workloads', 'fixtures'), path.join(stage, 'fixtures'), { recursive: true })
  const parsemanEntry = path.join(ROOT, 'src', 'index.ts')
  // esbuild runs HERE, in the parent: building the worker is not part of any measurement.
  await build({
    entryPoints: [path.join(HERE, 'xproc-worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: path.join(stage, 'worker.mjs'),
    external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
    logLevel: 'error',
    plugins: [{
      name: 'parseman-from-dist',
      setup(ctx) {
        ctx.onResolve({ filter: /src\/index\.ts$/ }, args =>
          path.resolve(args.resolveDir, args.path) === parsemanEntry ? { path: './dist/index.js', external: true } : undefined)
      },
    }],
  })
  return stage
}

type Reading = { median: number; min: number; digest: string }
function measure(stage: string, dist: string, suite: 'density' | 'workloads', id: string): Reading {
  rmSync(path.join(stage, 'dist'), { recursive: true, force: true })
  cpSync(dist, path.join(stage, 'dist'), { recursive: true })
  const s = CONFIG[suite]
  const args = { suite, id, heapPad: Math.floor(random() * 65_536), rules: CONFIG.density.rules, ...s }
  const env: NodeJS.ProcessEnv = { ...process.env, PM_XPROC_LAYOUT_PAD: 'x'.repeat(Math.floor(random() * 4096)) }
  // A worker runs exactly what a user runs. `NODE_OPTIONS` would put flags on it behind
  // the command line's back, so it never reaches one.
  delete env['NODE_OPTIONS']
  const r = spawnSync(process.execPath, [path.join(stage, 'worker.mjs'), JSON.stringify(args)], {
    cwd: stage, encoding: 'utf8', timeout: WORKER_TIMEOUT_MS, env,
  })
  if (r.error !== undefined) fail(GATE, `worker for ${id} did not complete: ${String(r.error)}`)
  if (r.status !== 0) fail(GATE, `worker for ${id} exited ${r.status}:\n${r.stderr.slice(-2000)}`)
  const line = r.stdout.trim().split('\n').at(-1)
  if (line === undefined) fail(GATE, `worker for ${id} printed nothing:\n${r.stderr.slice(-2000)}`)
  return JSON.parse(line) as Reading
}

if (SHARD_OUT !== null) {
  const shard: Shard = { reference: REF, seed: SEED, logs: Object.fromEntries(logs!), minLogs: Object.fromEntries(minLogs!) }
  writeFileSync(SHARD_OUT, JSON.stringify(shard))
}

const rows = cases.map(c => {
  const d = logs!.get(c.id)!
  const mins = minLogs!.get(c.id)!
  const sortedMins = [...mins].sort((x, y) => x - y)
  const minCenter = (Math.exp(sortedMins[sortedMins.length >> 1] ?? 0) - 1) * 100
  return { id: c.id, minCenter, ...caseVerdict(d, SETTINGS, random) }
})
for (const r of rows) {
  console.log(
    `  ${r.failed ? 'FAIL' : 'ok  '}  ${r.id.padEnd(17)} median ${sign(r.center).padStart(6)} (p ${r.pMedian.toExponential(1)})`
    + `   mean ${sign(r.mean).padStart(6)} (p ${r.pMean.toExponential(1)})   min ${sign(r.minCenter).padStart(6)}`
    + `   head slower in ${r.slower}/${r.n} rounds`,
  )
}
console.log(`ROWS ${JSON.stringify(Object.fromEntries(cases.map(c => [c.id, logs!.get(c.id)!.map(x => +((Math.exp(x) - 1) * 100).toFixed(3))])))}`)
if (SHARD_OUT !== null) {
  console.log(`\n${GATE}: wrote this shard's rounds to ${SHARD_OUT}; the verdict is taken over all shards.`)
  process.exit(0)
}

const gating = !REPORT_ONLY && !SELF && !IDENTICAL
const counts = cases.map(c => logs!.get(c.id)!.length)
summary([
  `#### ${GATE}: ${SELF ? 'self-check' : `HEAD vs ${REFERENCE.tag}`} — one process per side per case, ${Math.min(...counts)}–${Math.max(...counts)} rounds per case`,
  '',
  '| case | median Δ | sign-test p | mean Δ | sign-flip p | head slower | verdict |',
  '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ...rows.map(r => `| ${r.id} | ${sign(r.center)} | ${r.pMedian.toExponential(1)} | ${sign(r.mean)} | ${r.pMean.toExponential(1)} | ${r.slower}/${r.n} | ${gating ? (r.failed ? '**FAIL**' : 'ok') : 'report only'} |`),
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
