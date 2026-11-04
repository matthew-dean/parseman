/**
 * CALL-COUNT GATE — function calls and branch tests per parse, never more than the
 * previous release.
 *
 * Two of the four bars an engine refactor has to meet are counts, not timings:
 *
 *   3. no more function calls per parse than the previous release;
 *   4. nothing known at compile time becomes a parse-time check.
 *
 * Both used to be visible only as time. A "reuse" refactor of the left-corner routes
 * moved decisions into the pieces and added calls on the routed path; it read 10–25%
 * slower in the cross-process gate and nowhere else. A count sees the same change
 * with no noise: the same code over the same input executes the same calls on an idle
 * laptop and on a loaded runner.
 *
 * ## How it counts
 *
 * An instrumentation build (`bench/engine-guards/instrument.ts`): each side's bundle is
 * copied, every function entry and every branch test (`if`, `?:`, `&&`/`||`/`??`, loop
 * tests, `switch`) gets a counter, and `new Function` bodies are instrumented as they
 * are compiled. Nothing in `src/` changes, so published code pays nothing. Each side
 * runs in its own processes (`bench/engine-guards/count-worker.ts`).
 *
 * ## What it counts
 *
 *   emitted/<workload>   parseman's workloads (`bench/workloads/`) under runtime
 *                        `compile()`, which emits the whole grammar as code
 *   closure/<workload>   the same, with `Function` refusing (a CSP), so the closure
 *                        assembler runs it
 *   macro/<dialect>/<variant>/<fixture>
 *                        jess's four grammars from the vendored snapshot, macro-built as
 *                        jess ships them: `ast` is the hybrid (selected sites emitted,
 *                        the rest closures), `cst` runs on closures through a CST host.
 *                        These are the only rows that reach routed arms, `dispatch()`
 *                        and per-arm gates (docs/design/internals.md).
 *
 * `calls` is bar 3. `branches` is the proxy for bar 4: a decision moved from assembly
 * into a piece is a test the piece now runs on every visit, so it shows up here even
 * when it adds no call. See docs/design/perf-gates.md for what each misses.
 *
 * ## Verdict
 *
 * - **Previous release.** The same rows are counted on the previous release (the
 *   reference `perf:xproc:gate` uses), built from its own `src/` with this tree's
 *   grammars and fixtures. A row that counts more at HEAD fails, unless
 *   `bench/call-count-reasons.json` names that row and metric against that release.
 * - **Committed baseline.** `bench/call-count-baseline.json` must equal what HEAD
 *   counts, so a change in counts is a reviewed line in the diff. A drop is banked
 *   with `pnpm callcount:baseline`; that is the only direction the baseline moves
 *   without a reason entry.
 *
 * Usage:
 *   pnpm callcount:guard                   # working tree vs the previous release
 *   pnpm callcount:guard --ref=<sha>       # another reference
 *   pnpm callcount:guard --head-ref=<sha>  # head from a commit, not the working tree
 *   pnpm callcount:baseline                # rewrite the baseline from the working tree
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { assertIndependentLegs, fail, materialise, previousRelease, summary } from './ab-harness.ts'
import { instrument } from './engine-guards/instrument.ts'
import type { Counts, WorkerArgs } from './engine-guards/count-worker.ts'

const GATE = 'call-count'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASELINE_PATH = path.join(HERE, 'call-count-baseline.json')
const REASONS_PATH = path.join(HERE, 'call-count-reasons.json')
const WORKER = path.join(HERE, 'engine-guards', 'count-worker.ts')
/** The grammars and inputs both sides run: this tree's, so only the compiler differs. */
const COPY = ['bench/grammar-density', 'bench/workloads', 'examples', 'fixtures/jess-grammars', 'bench/jess/real-grammars.ts'] as const
const METRICS = ['calls', 'branches'] as const

export type Rows = Record<string, Counts>
export type Reasons = { against: string; rows: Record<string, string> }

/**
 * The jess rows. Every dialect parses the CSS fixture through a CST host (closures,
 * routed arms); Less also parses the Less fixture. Only css's AST variant runs here:
 * an AST parse runs jess's reducers over a stub of `@jesscss/core`, and the Less, SCSS
 * and `.jess` reducers check the children they are given and refuse the stub. Their
 * emitted sites are timed by `macro-perf` against a real jess build, not counted here.
 */
const JESS_CASES: ReadonlyArray<{ dialect: string; variant: 'ast' | 'cst'; fixture: string }> = [
  { dialect: 'css', variant: 'ast', fixture: 'site.css' },
  { dialect: 'css', variant: 'cst', fixture: 'site.css' },
  { dialect: 'less', variant: 'cst', fixture: 'site.css' },
  { dialect: 'less', variant: 'cst', fixture: 'app.less' },
  { dialect: 'scss', variant: 'cst', fixture: 'site.css' },
  { dialect: 'jess', variant: 'cst', fixture: 'site.css' },
]

function runWorker(args: WorkerArgs): Rows {
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', WORKER, JSON.stringify(args)], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 26,
  })
  if (r.error !== undefined) throw new Error(`count worker did not complete: ${String(r.error)}`)
  if (r.status !== 0) throw new Error(`count worker exited ${r.status}:\n${r.stderr.slice(-3000)}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Rows
}

/**
 * Every row, counted on the parseman whose `src/` is under `dir`. The bundles are
 * written to `out`, which must be outside `dir` only in the sense that nothing in
 * `dir` is edited.
 */
export async function measureSide(dir: string, out: string, only?: (row: string) => boolean): Promise<Rows> {
  mkdirSync(out, { recursive: true })
  const rows: Rows = {}
  const want = (prefix: string): boolean => only === undefined || only(prefix)

  if (want('emitted/') || want('closure/')) {
    const bundle = await build({
      stdin: { contents: "export { buildWorkloads } from './bench/workloads/index.ts'", resolveDir: dir, loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'error',
      external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
      // The workloads find their fixtures beside their own module, which is not where the bundle is.
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(dir, 'bench', 'workloads', 'index.ts')).href) },
    })
    const module = path.join(out, 'workloads.mjs')
    writeFileSync(module, instrument(bundle.outputFiles[0]!.text, module))
    for (const engine of ['emitted', 'closure'] as const) {
      if (!want(`${engine}/`)) continue
      for (const [id, c] of Object.entries(runWorker({ kind: 'workloads', module, engine }))) rows[`${engine}/${id}`] = c
    }
  }

  if (want('macro/')) {
    const { withBuiltSnapshot } = await import(path.join(dir, 'bench', 'jess', 'real-grammars.ts')) as {
      withBuiltSnapshot: <T>(fn: (snap: {
        shipped: (d: string, v: string) => Promise<unknown>
        runnable: (d: string, v: string) => Promise<string>
      }) => Promise<T>, fixture?: string) => Promise<T>
    }
    const fixtures = path.join(dir, 'bench', 'workloads', 'fixtures')
    await withBuiltSnapshot(async snap => {
      for (const key of new Set(JESS_CASES.map(c => `${c.dialect}/${c.variant}`))) {
        const [dialect, variant] = key.split('/') as [string, string]
        const cases = JESS_CASES.filter(c => `${c.dialect}/${c.variant}` === key)
          .map(c => ({ id: `macro/${key}/${c.fixture}`, input: path.join(fixtures, c.fixture), cst: variant === 'cst' }))
          .filter(c => want(c.id))
        if (cases.length === 0) continue
        await snap.shipped(dialect, variant)
        const runnable = await snap.runnable(dialect, variant)
        const module = runnable.replace(/\.mjs$/, '.instrumented.mjs')
        writeFileSync(module, instrument(readFileSync(runnable, 'utf8'), module))
        Object.assign(rows, runWorker({ kind: 'jess', module, cases }))
      }
    }, path.join(dir, 'fixtures', 'jess-grammars'))
  }
  return rows
}

/**
 * Every failure, named. Empty means green. `reasons` applies only when it was written
 * against this reference: once that release ships, the increase is in the reference
 * and the entry has nothing left to excuse.
 */
export function callCountFailures(ref: Rows, head: Rows, reasons: Reasons | null, refTag: string): string[] {
  const failures: string[] = []
  const excused = reasons !== null && reasons.against === refTag ? reasons.rows : {}
  const rows = [...new Set([...Object.keys(ref), ...Object.keys(head)])].sort()
  for (const row of rows) {
    const r = ref[row]
    const h = head[row]
    if (r === undefined || h === undefined) {
      failures.push(`${row}: counted on ${r === undefined ? 'HEAD only' : `${refTag} only`}`)
      continue
    }
    for (const m of METRICS) {
      if (h[m] <= r[m]) continue
      const key = `${row} ${m}`
      if (excused[key] !== undefined) continue
      failures.push(`${key}: ${r[m].toLocaleString('en-US')} at ${refTag} -> ${h[m].toLocaleString('en-US')} at HEAD (+${(h[m] - r[m]).toLocaleString('en-US')} per parse)`)
    }
  }
  return failures
}

/** The baseline must be exactly what HEAD counts: growth is a regression, a drop is a win to bank. */
export function baselineFailures(baseline: Rows, head: Rows): string[] {
  const failures: string[] = []
  for (const row of [...new Set([...Object.keys(baseline), ...Object.keys(head)])].sort()) {
    const b = baseline[row]
    const h = head[row]
    if (b === undefined || h === undefined) {
      failures.push(`${row}: ${b === undefined ? 'not in the baseline' : 'in the baseline but not counted'}`)
      continue
    }
    for (const m of METRICS) {
      if (h[m] === b[m]) continue
      failures.push(h[m] > b[m]
        ? `${row} ${m}: ${h[m].toLocaleString('en-US')} counted, baseline ${b[m].toLocaleString('en-US')} — more work per parse`
        : `${row} ${m}: ${h[m].toLocaleString('en-US')} counted, baseline ${b[m].toLocaleString('en-US')} — bank the win (pnpm callcount:baseline)`)
    }
  }
  return failures
}

const readJson = <T>(file: string): T | null => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : null

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argValue = (flag: string): string | null =>
    process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
  const UPDATE = process.argv.includes('--update')
  const HEAD_REF = argValue('--head-ref')
  const CACHE = path.join(ROOT, '.cache', GATE)

  const headDir = materialise(GATE, ROOT, HEAD_REF, COPY)
  if (UPDATE) {
    if (HEAD_REF !== null) fail(GATE, '--update writes the working tree\'s counts; it cannot be combined with --head-ref.')
    const head = await measureSide(headDir, path.join(CACHE, 'head'))
    writeFileSync(BASELINE_PATH, `${JSON.stringify(head, null, 2)}\n`)
    console.log(`${GATE}: wrote ${Object.keys(head).length} rows to ${path.relative(ROOT, BASELINE_PATH)}`)
    process.exit(0)
  }

  const REF_ARG = argValue('--ref')
  const reference = REF_ARG === null ? previousRelease(ROOT, GATE) : { tag: REF_ARG, sha: REF_ARG }
  const refDir = materialise(GATE, ROOT, reference.sha, COPY)
  console.log(`${GATE}: ${HEAD_REF === null ? 'working tree' : HEAD_REF} vs ${reference.tag} (${reference.sha}) — function calls and branch tests per parse`)
  assertIndependentLegs(GATE, { reference: path.join(refDir, 'src'), head: path.join(headDir, 'src') })

  let ref: Rows
  let head: Rows
  try {
    ref = await measureSide(refDir, path.join(CACHE, 'ref'))
    head = await measureSide(headDir, path.join(CACHE, 'head'))
  } catch (error) {
    fail(GATE, (error as Error).message)
  }
  const baseline = readJson<Rows>(BASELINE_PATH)
  if (baseline === null) fail(GATE, `${BASELINE_PATH} is missing; write it with pnpm callcount:baseline.`)
  const reasons = readJson<Reasons>(REASONS_PATH)
  if (reasons !== null && reasons.against !== reference.tag && Object.keys(reasons.rows).length > 0) {
    console.log(`  ${path.relative(ROOT, REASONS_PATH)} was written against ${reasons.against}; the reference is now ${reference.tag}, so it excuses nothing. Empty its rows.`)
  }

  const pct = (h: number, r: number): string => r === 0 ? 'n/a' : `${h >= r ? '+' : ''}${((h / r - 1) * 100).toFixed(2)}%`
  summary([
    `#### ${GATE}: HEAD vs ${reference.tag} — per parse`,
    '',
    '| row | calls | Δ | branch tests | Δ |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.keys(head).sort().map(row => {
      const h = head[row]!
      const r = ref[row]
      return `| ${row} | ${h.calls.toLocaleString('en-US')} | ${r === undefined ? 'new' : pct(h.calls, r.calls)} | ${h.branches.toLocaleString('en-US')} | ${r === undefined ? 'new' : pct(h.branches, r.branches)} |`
    }),
  ].join('\n'))

  const failures = [
    ...callCountFailures(ref, head, reasons, reference.tag),
    ...(HEAD_REF === null ? baselineFailures(baseline, head) : []),
  ]
  if (failures.length > 0) {
    fail(GATE, `FAILED\n  ${failures.join('\n  ')}\n\nAn increase that is the price of a change must be argued: set ${path.relative(ROOT, REASONS_PATH)} to { "against": "${reference.tag}", "rows": { "<row> <metric>": "<why>" } }, then rebaseline.`)
  }
  console.log(`\n${GATE}: ok — ${Object.keys(head).length} rows, none above ${reference.tag}${HEAD_REF === null ? ', baseline exact' : ''}`)
}
