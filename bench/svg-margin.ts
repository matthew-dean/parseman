/**
 * Measure Parséman's MARGIN over every competitor in the published comparison
 * charts (JSON / CSV / GraphQL / CST-JSON) — the bar the project holds itself
 * to: "still the fastest compiled JS parser in the SVG tests".
 *
 *   pnpm bench:margin              # 3 rounds, all four charts
 *   pnpm bench:margin -- --rounds 5 --charts json,graphql
 *
 * WHY THIS EXISTS SEPARATELY FROM `bench:svg`
 *
 * `bench:svg` renders the published pictures. It reduces each bar to a MEDIAN
 * over rounds and throws the per-round samples away, which is the right call for
 * a picture and the wrong one for a gate: a median cannot tell you whether a 4%
 * shift is a real regression or this box's noise floor. This script keeps every
 * round, and reports three things instead of one:
 *
 *   min          the fastest observed µs per bar. On a loaded box every sample
 *                is the true cost PLUS interference, so the distribution has a
 *                hard floor and a long right tail — the minimum is the closest
 *                estimate of the underlying cost, and it is what this harness
 *                leads with. A median moves when the machine gets busier; the
 *                min mostly does not.
 *   win-rate     of the R rounds, how many did Parséman win against that
 *                competitor? Rounds are PAIRED — within a round the two bars are
 *                measured seconds apart under the same machine conditions — so
 *                this is a sign test over paired samples, and it survives drift
 *                that would swamp a ratio of independent means.
 *   control      an A/A pair: `parseman-macro` measured twice per round, in two
 *                separate processes, under two slots. Its ratio should read ~1.0
 *                and its win-rate ~50%. It is measured in the SAME run as
 *                everything else, so it prices that run's noise floor directly.
 *                A margin smaller than the control's spread is not a margin.
 *
 * The measurement protocol itself is deliberately IDENTICAL to the published
 * charts' — same `bench/measure-bar.ts` child, one process per bar, same rotated
 * sweep order (see bench/collect-charts.ts for why both are load-bearing). This
 * script must report the margin the charts would show, not a friendlier one.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { CHART_GROUPS, CHART_BARS, BAR_MARKER, type ChartKey } from './chart-specs.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dir, '..')
const CHILD = resolve(__dir, 'measure-bar.ts')
const require_ = createRequire(import.meta.url)
const BAR_TIMEOUT_MS = 10 * 60_000
/** Repo metadata calls are metadata, not work: they must never be the thing that hangs a run. */
const GIT_TIMEOUT_MS = 30_000

/** The bar every other bar is compared against — Parséman's compiled output. */
const SUBJECT = 'parseman-macro'
/** Slot name for the A/A control. Not a real bar; measures SUBJECT a second time. */
const CONTROL = '__control__'

/**
 * Minimum ratio over a rival for the gate to call it a win — the cushion above a
 * tie, applied to EVERY rival, EVERY size group, EVERY chart.
 *
 * ABSOLUTE, and deliberately loose. The owner's bar is a RANK bar: "still the
 * fastest compiled JS parser in the SVG comparisons", with the explicit rider
 * that Parséman getting slower than a previous Parséman is acceptable. So this
 * must NOT be set from the margin measured today — a floor of 1.79× taken from
 * the current JSON-small row would turn a rank gate into a differential gate and
 * would fail exactly the regressions the owner blessed. It is set from the
 * harness's own resolution instead: MARGIN.md's interpretation table says a run
 * whose control reads ≤1.02× can be trusted for claims of ~5% and up, so 1.05 is
 * the smallest lead this instrument can distinguish from a tie.
 *
 * Changing this is an owner decision, on the same standing rule as a rebaseline.
 */
const MIN_MARGIN = 1.05

/**
 * Bars that are NOT rival JS parsers, with the reason. Excluded from the verdict,
 * still measured and still printed — the interpreter and native columns are
 * informative (MARGIN.md tabulates both), they are just not things Parséman can
 * "lose" the rank bar to. Before this map, `parseman-interp` counted as a rival:
 * a build where the interpreter beat the macro build would have reported the gate
 * BROKEN, which is a false failure, not a rank loss.
 */
const NON_RIVAL: Record<string, string> = {
  [SUBJECT]: 'subject under test',
  'parseman-interp': "Parséman's own interpreter build, not a competitor",
  native: 'JSON.parse is C++ inside the engine, not a JS parser generator',
}

type Slot = { slot: string; key: string }

/* ── ARTIFACT EVIDENCE ──────────────────────────────────────────────────────
 *
 * What was actually measured, resolved and versioned, printed beside the
 * numbers. Stale pointers in this project fail silently and cleanly: a run that
 * measured a months-old generated parser, or a Parséman source that does not
 * match the commit being claimed, produces a perfectly plausible table.
 *
 * Peggy, Nearley and Jison do not load their generator at parse time — they
 * import a parser GENERATED from it and checked into bench/. Both are recorded:
 * the package version says where the artifact came from, the file hash says what
 * actually ran. Version alone would let a stale generated file read as current.
 */
type ArtifactRef =
  | { kind: 'pkg'; name: string }
  | { kind: 'file'; rel: string }
  | { kind: 'repo' }
  | { kind: 'runtime' }

const BAR_ARTIFACTS: Record<string, ArtifactRef[]> = {
  'json/parseman-macro': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/json/parser.ts' }],
  'json/parseman-interp': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/json/parser.ts' }],
  'json/peggy': [{ kind: 'pkg', name: 'peggy' }, { kind: 'file', rel: 'bench/json-parser.js' }],
  'json/jison': [{ kind: 'pkg', name: 'jison' }, { kind: 'file', rel: 'bench/json-jison.cjs' }],
  'json/nearley': [{ kind: 'pkg', name: 'nearley' }, { kind: 'file', rel: 'bench/json-nearley.cjs' }],
  'json/parsimmon': [{ kind: 'pkg', name: 'parsimmon' }, { kind: 'file', rel: 'bench/parsimmon-json.ts' }],
  'json/chevrotain': [{ kind: 'pkg', name: 'chevrotain' }, { kind: 'file', rel: 'bench/chevrotain-json.ts' }],
  'json/native': [{ kind: 'runtime' }],

  'csv/parseman-macro': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/csv/parser.ts' }],
  'csv/parseman-interp': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/csv/parser.ts' }],
  'csv/peggy': [{ kind: 'pkg', name: 'peggy' }, { kind: 'file', rel: 'bench/csv-parser.js' }],
  'csv/nearley': [{ kind: 'pkg', name: 'nearley' }, { kind: 'file', rel: 'bench/csv-nearley.cjs' }],
  'csv/parsimmon': [{ kind: 'pkg', name: 'parsimmon' }, { kind: 'file', rel: 'bench/parsimmon-csv.ts' }],
  'csv/chevrotain': [{ kind: 'pkg', name: 'chevrotain' }, { kind: 'file', rel: 'bench/chevrotain-csv.ts' }],

  'graphql/parseman-macro': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/graphql/parser.ts' }],
  'graphql/parseman-interp': [{ kind: 'repo' }, { kind: 'file', rel: 'examples/graphql/parser.ts' }],
  'graphql/peggy': [{ kind: 'pkg', name: 'peggy' }, { kind: 'file', rel: 'bench/graphql-parser.js' }],
  'graphql/jison': [{ kind: 'pkg', name: 'jison' }, { kind: 'file', rel: 'bench/graphql-jison.cjs' }],
  'graphql/nearley': [{ kind: 'pkg', name: 'nearley' }, { kind: 'file', rel: 'bench/graphql-nearley.cjs' }],
  'graphql/parsimmon': [{ kind: 'pkg', name: 'parsimmon' }, { kind: 'file', rel: 'bench/parsimmon-graphql.ts' }],
  'graphql/chevrotain': [{ kind: 'pkg', name: 'chevrotain' }, { kind: 'file', rel: 'bench/chevrotain-graphql.ts' }],

  'cst/parseman-macro': [{ kind: 'repo' }, { kind: 'file', rel: 'bench/parseman-cst-json.ts' }],
  'cst/parseman-interp': [{ kind: 'repo' }, { kind: 'file', rel: 'bench/parseman-cst-json.ts' }],
  'cst/chevrotain': [{ kind: 'pkg', name: 'chevrotain' }, { kind: 'file', rel: 'bench/chevrotain-cst-json.ts' }],
  'cst/lezer-parse': [{ kind: 'pkg', name: '@lezer/json' }, { kind: 'pkg', name: '@lezer/common' }],
  'cst/lezer-walk': [{ kind: 'pkg', name: '@lezer/json' }, { kind: 'pkg', name: '@lezer/common' }],
}

type Resolved = { label: string; path: string; version: string }

function pkgJsonPath(name: string): string {
  // require.resolve(`${name}/package.json`) throws when a package's "exports"
  // map does not expose it, which is now the common case. Fall back to walking
  // node_modules upward.
  try {
    return require_.resolve(`${name}/package.json`)
  } catch {
    let dir = __dir
    for (;;) {
      const p = join(dir, 'node_modules', name, 'package.json')
      if (existsSync(p)) return p
      const up = dirname(dir)
      if (up === dir) throw new Error(`svg-margin: cannot resolve package ${name}`)
      dir = up
    }
  }
}

let repoInfoCache: Resolved | undefined
function repoInfo(): Resolved {
  if (repoInfoCache) return repoInfoCache
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  // Ask git for the SHA. Do NOT read .git/HEAD as a path: inside a git worktree
  // .git is a FILE, not a directory, so that read is a silent per-worktree
  // failure that happens to pass on a primary checkout.
  // Bounded like every other subprocess here: a hung `git` (lock contention, a
  // credential prompt, a slow filesystem) would otherwise block the whole run
  // with no recovery and no indication of which call stalled.
  const g = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
    } catch (e) {
      if (isTimeoutError(e)) {
        throw new Error(`svg-margin: git ${args.join(' ')} timed out after ${GIT_TIMEOUT_MS / 1000}s in ${REPO}`)
      }
      throw e
    }
  }
  const dirty = g(['status', '--porcelain']).length > 0
  repoInfoCache = {
    label: `${pkg.name} (source, run via tsx)`,
    path: join(REPO, 'src/index.ts'),
    version: `${pkg.version} @ ${g(['rev-parse', '--short', 'HEAD'])}${dirty ? '  +DIRTY-WORKTREE' : ''}`,
  }
  return repoInfoCache
}

function resolveArtifact(ref: ArtifactRef): Resolved {
  switch (ref.kind) {
    case 'repo':
      return repoInfo()
    case 'runtime':
      return { label: 'node (V8 builtin)', path: process.execPath, version: process.version }
    case 'pkg': {
      const pj = pkgJsonPath(ref.name)
      const { version } = JSON.parse(readFileSync(pj, 'utf8')) as { version: string }
      return { label: ref.name, path: dirname(pj), version }
    }
    case 'file': {
      const abs = join(REPO, ref.rel)
      if (!existsSync(abs)) {
        throw new Error(
          `svg-margin: measured artifact is not on disk: ${abs}\n` +
            '  This is a stale-pointer failure. Refusing to report numbers for it.',
        )
      }
      const st = statSync(abs)
      const sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12)
      return {
        label: ref.rel,
        path: abs,
        version: `sha256:${sha}  ${st.size} B  mtime ${st.mtime.toISOString().slice(0, 19)}Z`,
      }
    }
  }
}

/** Print provenance for every bar about to be measured. Aborts on a bad pointer. */
function printEvidence(charts: ChartKey[]): void {
  console.log('─'.repeat(76))
  console.log('ARTIFACT EVIDENCE — resolved path and version of everything measured')
  console.log('─'.repeat(76))
  for (const chart of charts) {
    for (const b of CHART_BARS[chart]) {
      console.log(`  ${chart}/${b.key}`)
      for (const ref of BAR_ARTIFACTS[`${chart}/${b.key}`]!) {
        const r = resolveArtifact(ref)
        const short = r.path.startsWith(REPO) ? `<repo>/${relative(REPO, r.path)}` : r.path
        console.log(`      ${r.label.padEnd(26)} ${r.version}`)
        console.log(`      ${' '.repeat(26)} ${short}`)
      }
    }
  }
  if (repoInfo().version.includes('DIRTY')) {
    console.log()
    console.log('  ⚠ WORKTREE IS DIRTY — measured source does not match the reported commit.')
  }
  console.log()
}

/**
 * A bar charted but absent from BAR_ARTIFACTS would be measured with no
 * provenance; a BAR_ARTIFACTS entry for a bar no longer charted is a stale
 * pointer. Either way, abort rather than print a table that silently covers less
 * than it appears to.
 */
function assertInventoryExhaustive(): void {
  const missing: string[] = []
  for (const chart of Object.keys(CHART_GROUPS) as ChartKey[]) {
    for (const b of CHART_BARS[chart]) {
      if (!BAR_ARTIFACTS[`${chart}/${b.key}`]) missing.push(`${chart}/${b.key}`)
    }
  }
  const stale = Object.keys(BAR_ARTIFACTS).filter(k => {
    const i = k.indexOf('/')
    return !CHART_BARS[k.slice(0, i) as ChartKey]?.some(b => b.key === k.slice(i + 1))
  })
  if (missing.length || stale.length) {
    if (missing.length) console.error(`svg-margin: charted but no provenance entry: ${missing.join(', ')}`)
    if (stale.length) console.error(`svg-margin: provenance entry for an uncharted bar: ${stale.join(', ')}`)
    throw new Error('svg-margin: bar inventory out of sync with chart-specs.ts')
  }
}

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const ROUNDS = Number(argOf('rounds', '3'))
const ALL_CHARTS = Object.keys(CHART_GROUPS) as ChartKey[]
const CHARTS = argOf('charts', ALL_CHARTS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean) as ChartKey[]
const OUT = argOf('out', '')

/**
 * VERIFICATION ONLY — override the floor for a known-answer run.
 *
 * A gate nobody has watched fail is not known to be a gate, and this project has
 * been collecting instruments that print a verdict and grade nothing.
 * `--assert-floor 1000` demands Parséman be 1000× its rivals, which it is not, so
 * a working harness MUST report FAIL. It does not change MIN_MARGIN, and any run
 * that uses it says so in the banner, in DROPPED, and in the verdict, so an
 * overridden run can never be mistaken for the gate itself.
 */
// `argOf` cannot distinguish "flag absent" from "flag present with no value", and
// for this flag those mean opposite things: absent is the real gate, present is a
// verification override. Silently treating a valueless `--assert-floor` as the real
// gate would report a PASS for a run the operator believed was a known-answer check.
const floorIdx = process.argv.indexOf('--assert-floor')
if (floorIdx >= 0 && !process.argv[floorIdx + 1]) {
  throw new Error('svg-margin: --assert-floor requires a value (e.g. --assert-floor 1000)')
}
const floorArg = argOf('assert-floor', '')
const FLOOR = floorArg === '' ? MIN_MARGIN : Number(floorArg)

for (const c of CHARTS) {
  if (!(c in CHART_GROUPS)) throw new Error(`svg-margin: unknown chart ${c}`)
}
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) throw new Error(`svg-margin: bad --rounds ${ROUNDS}`)
if (!Number.isFinite(FLOOR) || FLOOR <= 0) throw new Error(`svg-margin: bad --assert-floor ${floorArg}`)

assertInventoryExhaustive()

/**
 * Everything this run does NOT cover, printed at the end of every run. Silent
 * truncation reads as "covered everything".
 */
const DROPPED: string[] = [
  'bench:incremental (bench/incremental-run.ts) — excluded by the owner\'s wording of the bar, and ' +
    'structurally out of scope: it is not a comparison chart and has no competitor bars to rank against',
  'initialization bars (PINNED_INIT, chart-types.ts) — pinned constants in the published chart, not ' +
    'measured here; the bar is about parse speed',
  'any change that does not reach examples/{json,csv,graphql} or the JSON CST build — a null here is ' +
    'NOT evidence a change is free (see "What these charts CANNOT read" in bench/MARGIN.md)',
]
if (CHARTS.length !== ALL_CHARTS.length) {
  DROPPED.push(`charts NOT run this invocation: ${ALL_CHARTS.filter(c => !CHARTS.includes(c)).join(', ')} (--charts)`)
}
if (ROUNDS !== 3) {
  DROPPED.push(`--rounds ${ROUNDS}, not the published 3 — position-bias treatment differs from the charts`)
}
if (floorArg !== '') {
  DROPPED.push(
    `THE POLICY FLOOR ITSELF: --assert-floor ${FLOOR} overrode MIN_MARGIN ${MIN_MARGIN}. ` +
      'This run is a harness verification, NOT the gate.',
  )
}

/** An expired `timeout` surfaces as ETIMEDOUT and/or the SIGTERM used to kill it. */
function isTimeoutError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const { code, signal } = e as { code?: unknown; signal?: unknown }
  return code === 'ETIMEDOUT' || signal === 'SIGTERM'
}

/** µs per size group for one bar, measured in a fresh process. */
function measureBar(chart: ChartKey, key: string): number[] {
  let out: string
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', CHILD, chart, key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: BAR_TIMEOUT_MS,
    })
  } catch (e) {
    // Name the bar. A run spawns dozens of children and a raw ETIMEDOUT dump
    // names none of them — same reasoning as collect-charts.ts.
    if (isTimeoutError(e)) {
      throw new Error(
        `svg-margin: ${chart}/${key} timed out after ${BAR_TIMEOUT_MS / 1000}s (child killed). ` +
          'The slow competitors on the large fixtures need a quiet box; re-run without other load.',
        { cause: e },
      )
    }
    throw e
  }
  const line = out.split('\n').find(l => l.startsWith(BAR_MARKER))
  if (!line) throw new Error(`svg-margin: ${chart}/${key} produced no ${BAR_MARKER} line`)
  const us = JSON.parse(line.slice(BAR_MARKER.length)) as number[]
  // A zero, NaN or negative µs would sail through min() and every ratio built on
  // it, producing an infinite or absurd margin that reads like a huge win.
  if (us.length !== CHART_GROUPS[chart].length || us.some(v => !Number.isFinite(v) || v <= 0)) {
    throw new Error(`svg-margin: ${chart}/${key} returned unusable timings ${JSON.stringify(us)}`)
  }
  return us
}

const min = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a))

type GroupResult = {
  group: string
  subjectMin: number
  rows: {
    slot: string
    label: string
    min: number
    /** competitor_min / subject_min — >1 means Parséman is that many × faster. */
    ratio: number
    /** rounds Parséman won, out of ROUNDS (paired within round). */
    wins: number
    rounds: number
  }[]
}

const results: { chart: ChartKey; groups: GroupResult[] }[] = []
const raw: Record<string, Record<string, number[][]>> = {}

/** Tightest rival margin seen so far, and where. */
type Tightest = { chart: string; group: string; rival: string; ratio: number; wins: number }
let tightest: Tightest | undefined
/**
 * Worst A/A control spread seen, as a ratio ≥ 1. The control measures the SAME
 * bar twice, so its honest reading is 1.00; whatever it actually reads is this
 * run's discrimination floor.
 */
let worstControl = 1
let worstControlAt = ''
/** Rows where a rival won at least one paired round. */
const splitRounds: string[] = []

/**
 * Print one chart's table. Called as each chart FINISHES, not once at the end:
 * a full four-chart run is tens of minutes, and up to a couple of hours on a
 * loaded box. A version that reported only on completion produced nothing at all
 * from a run that was interrupted or still going — the numbers existed, in a
 * process nobody could read. Partial output that is correct beats complete
 * output that arrives late.
 */
function reportChart(chart: ChartKey, groups: GroupResult[]): void {
  console.log(`\n═══ ${chart.toUpperCase()} ═══`)
  for (const g of groups) {
    console.log(`\n  ${g.group}`)
    console.log(`  Parséman (macro build)         ${g.subjectMin.toFixed(3)} µs  (min of ${ROUNDS})`)
    console.log(`  ${'competitor'.padEnd(30)} ${'min µs'.padStart(9)} ${'×'.padStart(8)}  win-rate`)
    for (const row of g.rows) {
      let flag: string
      if (row.slot === CONTROL) {
        // Two measurements of one bar. Deviation in EITHER direction is noise.
        const spread = Math.max(row.ratio, 1 / row.ratio)
        if (spread > worstControl) {
          worstControl = spread
          worstControlAt = `${chart} / ${g.group}`
        }
        flag = `  (control, A/A — spread ${((spread - 1) * 100).toFixed(1)}%)`
      } else if (NON_RIVAL[row.slot]) {
        flag = `  (excluded: ${NON_RIVAL[row.slot]})`
      } else {
        if (row.ratio < 1) flag = '  ← SLOWER THAN COMPETITOR'
        else if (row.ratio < FLOOR) flag = '  ← BELOW FLOOR'
        else flag = ''
        if (!tightest || row.ratio < tightest.ratio) {
          tightest = { chart, group: g.group, rival: row.slot, ratio: row.ratio, wins: row.wins }
        }
        if (row.wins < row.rounds) {
          splitRounds.push(`${chart} / ${g.group} / ${row.slot}: won only ${row.wins}/${row.rounds} paired rounds`)
          flag += `  ← SPLIT ROUNDS`
        }
      }
      console.log(
        `  ${row.label.padEnd(30)} ${row.min.toFixed(3).padStart(9)} ` +
          `${row.ratio.toFixed(2).padStart(7)}× ${`${row.wins}/${row.rounds}`.padStart(9)}${flag}`,
      )
    }
  }
}

console.log('═'.repeat(76))
console.log('bench:margin — is Parséman still the fastest JS parser in the published charts?')
console.log('═'.repeat(76))
console.log(`  floor    ${FLOOR.toFixed(2)}× over EVERY competitor, EVERY group, EVERY chart (ABSOLUTE)`)
if (floorArg !== '') {
  console.log(`  ⚠ OVERRIDE  --assert-floor ${FLOOR} replaced MIN_MARGIN ${MIN_MARGIN}.`)
  console.log(`              HARNESS VERIFICATION RUN — not the gate.`)
}
console.log(`  charts   ${CHARTS.join(', ')}`)
console.log(`  rounds   ${ROUNDS}, rotated order, one process per bar`)
console.log(`  node     ${process.version}  ${process.platform}/${process.arch}`)
console.log()
printEvidence(CHARTS)

for (const chart of CHARTS) {
  // Every real bar, plus an A/A control slot that re-measures the subject.
  const slots: Slot[] = [
    ...CHART_BARS[chart].map(b => ({ slot: b.key, key: b.key })),
    { slot: CONTROL, key: SUBJECT },
  ]
  const labelOf = (slot: string) =>
    slot === CONTROL
      ? 'CONTROL (A/A, same bar)'
      : CHART_BARS[chart].find(b => b.key === slot)!.label

  console.log(`  [${chart}] ${slots.length} slots × ${ROUNDS} rounds`)

  // samples[slot][groupIndex][roundIndex]
  const samples: Record<string, number[][]> = {}
  for (const s of slots) samples[s.slot] = CHART_GROUPS[chart].map(() => [])

  const shift = Math.max(1, Math.round(slots.length / ROUNDS))
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < slots.length; k++) {
      const s = slots[(k + r * shift) % slots.length]!
      const us = measureBar(chart, s.key)
      us.forEach((v, gi) => samples[s.slot]![gi]!.push(v))
    }
    process.stdout.write(`    round ${r + 1}/${ROUNDS} done\n`)
  }
  raw[chart] = samples

  const groups: GroupResult[] = CHART_GROUPS[chart].map((g, gi) => {
    const subj = samples[SUBJECT]![gi]!
    const subjectMin = min(subj)
    const rows = slots
      .filter(s => s.slot !== SUBJECT)
      .map(s => {
        const other = samples[s.slot]![gi]!
        let wins = 0
        for (let r = 0; r < ROUNDS; r++) if (subj[r]! < other[r]!) wins++
        return {
          slot: s.slot,
          label: labelOf(s.slot),
          min: min(other),
          ratio: min(other) / subjectMin,
          wins,
          rounds: ROUNDS,
        }
      })
    return { group: g.title, subjectMin, rows }
  })
  results.push({ chart, groups })
  reportChart(chart, groups)
  // Flush raw samples after every chart for the same reason the table prints
  // early — an interrupted run should still leave its finished charts behind.
  if (OUT) writeFileSync(OUT, JSON.stringify({ rounds: ROUNDS, results, raw }, null, 2))
  console.log()
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ rounds: ROUNDS, results, raw }, null, 2))
  console.log(`\nraw samples → ${OUT}`)
}

console.log()
console.log('─'.repeat(76))
console.log('DROPPED / NOT COVERED BY THIS RUN')
console.log('─'.repeat(76))
for (const d of DROPPED) console.log(`  - ${d}`)
for (const [slot, why] of Object.entries(NON_RIVAL)) {
  if (slot !== SUBJECT) console.log(`  - ${slot} excluded from the verdict: ${why}`)
}

console.log()
console.log('═'.repeat(76))
console.log('SELF-CALIBRATION')
console.log('═'.repeat(76))
console.log(`  Worst A/A control spread: ${((worstControl - 1) * 100).toFixed(1)}%  (ratio ${worstControl.toFixed(4)})`)
if (worstControlAt) console.log(`  at ${worstControlAt}`)
console.log('  The control measures ONE bar twice, in two processes, in the same sweep.')
console.log('  Its honest reading is 1.0000. Whatever it reads is this run\'s noise floor,')
console.log('  and no margin narrower than it is a margin.')
if (splitRounds.length) {
  console.log()
  console.log('  Rows where a competitor won at least one paired round:')
  for (const s of splitRounds) console.log(`    ${s}`)
}

console.log()
console.log('═'.repeat(76))

/**
 * Verdict. The control is applied FIRST and can veto a win.
 *
 * Before this, the control was measured, printed, and then ignored: the exit code
 * came from `ratio >= 1` alone, so a run whose A/A pair disagreed by 40% could
 * still report the bar HELD on a 1.02× "win" that was entirely noise. The doc
 * said "a margin smaller than the control's spread is not a margin" and nothing
 * enforced it. It is enforced here.
 */
if (!tightest) {
  console.log('VERDICT: INDETERMINATE — no competitor bars were measured.')
  process.exitCode = 2
} else if (worstControl >= tightest.ratio) {
  console.log('VERDICT: INDETERMINATE')
  console.log()
  console.log(`  Control spread ${((worstControl - 1) * 100).toFixed(1)}% is not smaller than the tightest claimed`)
  console.log(`  margin ${((tightest.ratio - 1) * 100).toFixed(1)}% (${tightest.chart}/${tightest.rival}).`)
  console.log('  One bar measured against itself moved that far in this run, so the narrowest')
  console.log('  row here cannot be told from noise. Reporting that instead of a win.')
  console.log('  Re-run on a quiet box, or raise --rounds.')
  process.exitCode = 2
} else if (worstControl >= FLOOR) {
  console.log('VERDICT: INDETERMINATE')
  console.log()
  console.log(`  Control spread ${((worstControl - 1) * 100).toFixed(1)}% meets or exceeds the ${((FLOOR - 1) * 100).toFixed(1)}% floor.`)
  console.log('  This run could not have FAILED a borderline case, so a pass from it would be')
  console.log('  unearned no matter how wide today\'s margin happens to be.')
  process.exitCode = 2
} else if (tightest.ratio < FLOOR) {
  console.log('VERDICT: BAR BROKEN — FAIL')
  console.log()
  console.log(`  Tightest row: ${tightest.rival} on ${tightest.chart} / ${tightest.group}`)
  console.log(`  ${tightest.ratio.toFixed(3)}× is below the ${FLOOR.toFixed(2)}× floor` +
    (tightest.ratio < 1 ? ' — the competitor is FASTER.' : '.'))
  console.log(`  Control spread was ${((worstControl - 1) * 100).toFixed(1)}%, well inside the margin, so this is real.`)
  process.exitCode = 1
} else {
  console.log('VERDICT: BAR HELD — PASS')
  console.log()
  console.log('  Parséman (macro build) is the fastest competitor-ranked JS parser in every')
  console.log('  group of every chart measured by this run.')
  console.log(`  Tightest row ${tightest.ratio.toFixed(2)}× over ${tightest.rival} (${tightest.chart} / ${tightest.group}),`)
  console.log(`  against a ${FLOOR.toFixed(2)}× floor and a live control spread of ${((worstControl - 1) * 100).toFixed(1)}%.`)
  process.exitCode = 0
}
