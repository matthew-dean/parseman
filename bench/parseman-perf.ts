/**
 * Parseman-only perf suite: interpreted vs macro-compiled across all example grammars.
 * - parseman-baseline.json — CI regression anchor (overwritten on bench:baseline)
 * - parseman-history.jsonl — append-only time series (one line per bench:baseline)
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { compile } from '../src/index.ts'
import { parseJSON, jsonDoc } from '../examples/json/parser.ts'
import { parseCSV, compiledCSV } from '../examples/csv/parser.ts'
import { parseGraphQL, graphqlDoc } from '../examples/graphql/parser.ts'
import { parseConfig, compiledConfig } from '../examples/toml-ish/parser.ts'
import { parseExpr, exprParser } from '../examples/lang/parser.ts'
import { parseCss, parseCssCompiled } from '../examples/css/parser.ts'
import { readCssFixture } from './css-fixture.ts'
import {
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
  SMALL_CONFIG, MEDIUM_CONFIG,
  SMALL_EXPR, MEDIUM_EXPR,
} from './fixtures.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
export const BASELINE_PATH = resolve(__dir, 'parseman-baseline.json')
/** Append-only time series — one JSON object per line, written by pnpm bench:baseline. */
export const HISTORY_PATH = resolve(__dir, 'parseman-history.jsonl')

/**
 * Shared measurement profile — the baseline capture and the regression guard
 * MUST use the same numbers, otherwise the guard compares medians taken under
 * different conditions and you're forced to widen the tolerance to hide the
 * methodology gap.
 *
 * Matched sample/pass counts control *within-machine, same-profile* noise — but
 * they cannot cancel two other error sources that dominate the tiny sub-µs CSS
 * cases (`css/selector` ≈ 2.7µs, `css/decls` ≈ 3.4µs): (a) run-to-run variance
 * on this hardware, empirically ~10% even at 9×3, and (b) cross-machine ratio
 * drift — the committed baseline is captured on one machine, the guard runs on
 * another, and interpreted-vs-compiled JIT/microarchitecture differences move
 * the ratio ~7–11% between machines despite the "ratio cancels clock speed"
 * intent. An 8% gate sits *below* that noise floor and false-positives about
 * half the time (verified: `css/selector`, which a numeric-terminal change
 * cannot touch, "regressed" 5–11% run-to-run). So: more samples/passes to
 * tighten (a), and a tolerance comfortably above (b).
 */
export const PERF_SAMPLES = 15
/**
 * Interleaved passes for a robust baseline (manual, thoroughness over speed).
 * Robustness against thermal/GC blips comes mostly from spreading measurement
 * across independent passes over time, so a moderate sample count × several
 * passes beats one big sample window while keeping total wall-time sane.
 */
export const BASELINE_PASSES = 5
/** Interleaved passes for the guard — MUST match BASELINE_PASSES so ratio comparisons are apples-to-apples. */
export const GUARD_PASSES = 5
/** Hard regression gate: max % a measured case may get slower than baseline. */
export const PERF_TOLERANCE = 15

const compiledJSON = compile(jsonDoc)
const compiledGraphQL = compile(graphqlDoc)
const compiledExpr = compile(exprParser)

export type ParsemanMode = 'interpreted' | 'compiled'

export type ParsemanBenchRow = {
  id: string
  language: string
  fixture: string
  mode: ParsemanMode
  bytes: number
  iterations: number
  medianUs: number
  opsPerSec: number
}

export type ParsemanBaseline = {
  updatedAt: string
  gitRev: string
  /** Measurement settings used when this baseline was captured. */
  measurement?: { scale: number; samples: number }
  cases: Record<string, { medianUs: number; iterations: number; bytes: number }>
}

/** One committed snapshot in the append-only history log (same shape as baseline). */
export type ParsemanSnapshot = ParsemanBaseline

type CaseDef = {
  id: string
  language: string
  fixture: string
  input: string
  iterations: number
  interpreted: () => void
  compiled: () => void
  optional?: boolean
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

export function measureMedianUs(
  fn: () => void,
  iterations: number,
  opts?: { warmup?: number; samples?: number },
): number {
  const warm = opts?.warmup ?? Math.min(Math.floor(iterations / 10), 500)
  const samples = opts?.samples ?? 15
  // Warm up, timing it to estimate per-op cost, then bound the timed work by a
  // wall-clock budget instead of the raw configured counts. The configured
  // `iterations × samples` are tuned so a sub-µs case swamps timer jitter, but
  // applied literally to a medium/large fixture (csv/large ≈ 0.35 ms × 5000, or
  // bootstrap4 ≈ 60 ms) one sample takes ~1 s — and `× robust-passes` turned a
  // full baseline into minutes for medians that are stable in a handful of reads.
  //   effIter    — cap each sample to ~SAMPLE_BUDGET_MS of parses.
  //   effSamples — a slow op (per-op already ≫ jitter) needs far fewer samples;
  //                15 reads of a 60 ms parse is pure waste.
  // Both are no-ops for the sub-ms cases, so their jitter margin is untouched.
  const SAMPLE_BUDGET_MS = 5
  const wStart = performance.now()
  for (let i = 0; i < warm; i++) fn()
  const perOpMs = warm > 0 ? (performance.now() - wStart) / warm : 0
  const effIter = perOpMs > 0
    ? Math.min(iterations, Math.max(1, Math.ceil(SAMPLE_BUDGET_MS / perOpMs)))
    : iterations
  const effSamples = perOpMs > 1 ? Math.min(samples, 5) : samples
  const perOpUs: number[] = []
  for (let s = 0; s < effSamples; s++) {
    const t0 = performance.now()
    for (let i = 0; i < effIter; i++) fn()
    perOpUs.push((performance.now() - t0) / effIter * 1000)
  }
  return median(perOpUs)
}

export type ParsemanSuiteOpts = {
  /** Scale iteration counts. Must match baseline scale for regression checks (default 1). */
  scale?: number
  /** Passed through to measureMedianUs. */
  measure?: { samples?: number }
  /** Skip optional large fixtures (e.g. bootstrap4.css) — use in CI. */
  skipOptional?: boolean
  /** Only run cases whose id starts with one of these prefixes (e.g. ['css']). */
  only?: string[]
  /** Called before each case/mode measurement (for long interactive runs). */
  onProgress?: (id: string, mode: ParsemanMode) => void
}

function buildCases(): CaseDef[] {
  const cases: CaseDef[] = [
    // JSON
    { id: 'json/small', language: 'json', fixture: 'small', input: SMALL_JSON, iterations: 50_000,
      interpreted: () => parseJSON(SMALL_JSON), compiled: () => { compiledJSON.parse(SMALL_JSON, 0) } },
    { id: 'json/medium', language: 'json', fixture: 'medium', input: MEDIUM_JSON, iterations: 10_000,
      interpreted: () => parseJSON(MEDIUM_JSON), compiled: () => { compiledJSON.parse(MEDIUM_JSON, 0) } },
    { id: 'json/large', language: 'json', fixture: 'large', input: LARGE_JSON, iterations: 2_000,
      interpreted: () => parseJSON(LARGE_JSON), compiled: () => { compiledJSON.parse(LARGE_JSON, 0) } },
    // CSV
    { id: 'csv/small', language: 'csv', fixture: 'small', input: SMALL_CSV, iterations: 50_000,
      interpreted: () => parseCSV(SMALL_CSV), compiled: () => { compiledCSV.parse(SMALL_CSV) } },
    { id: 'csv/large', language: 'csv', fixture: 'large', input: LARGE_CSV, iterations: 5_000,
      interpreted: () => parseCSV(LARGE_CSV), compiled: () => { compiledCSV.parse(LARGE_CSV) } },
    // GraphQL
    { id: 'graphql/small', language: 'graphql', fixture: 'small', input: SMALL_GQL, iterations: 50_000,
      interpreted: () => parseGraphQL(SMALL_GQL), compiled: () => { compiledGraphQL.parse(SMALL_GQL, 0) } },
    { id: 'graphql/medium', language: 'graphql', fixture: 'medium', input: MEDIUM_GQL, iterations: 10_000,
      interpreted: () => parseGraphQL(MEDIUM_GQL), compiled: () => { compiledGraphQL.parse(MEDIUM_GQL, 0) } },
    { id: 'graphql/large', language: 'graphql', fixture: 'large', input: LARGE_GQL, iterations: 2_000,
      interpreted: () => parseGraphQL(LARGE_GQL), compiled: () => { compiledGraphQL.parse(LARGE_GQL, 0) } },
    // TOML-ish config
    { id: 'toml/small', language: 'toml', fixture: 'small', input: SMALL_CONFIG, iterations: 50_000,
      interpreted: () => parseConfig(SMALL_CONFIG), compiled: () => { compiledConfig.parse(SMALL_CONFIG.endsWith('\n') ? SMALL_CONFIG : SMALL_CONFIG + '\n') } },
    { id: 'toml/medium', language: 'toml', fixture: 'medium', input: MEDIUM_CONFIG, iterations: 10_000,
      interpreted: () => parseConfig(MEDIUM_CONFIG), compiled: () => { compiledConfig.parse(MEDIUM_CONFIG) } },
    // Lang expressions
    { id: 'lang/small', language: 'lang', fixture: 'small', input: SMALL_EXPR, iterations: 50_000,
      interpreted: () => parseExpr(SMALL_EXPR), compiled: () => { compiledExpr.parse(SMALL_EXPR, 0) } },
    { id: 'lang/medium', language: 'lang', fixture: 'medium', input: MEDIUM_EXPR, iterations: 5_000,
      interpreted: () => parseExpr(MEDIUM_EXPR), compiled: () => { compiledExpr.parse(MEDIUM_EXPR, 0) } },
  ]

  // CSS — optional bootstrap fixture
  for (const fixture of ['selector.css', 'decls.css'] as const) {
    try {
      const input = readCssFixture(fixture)
      cases.push({
        id: `css/${fixture.replace('.css', '')}`,
        language: 'css',
        fixture,
        input,
        iterations: 500,
        interpreted: () => parseCss(input),
        compiled: () => parseCssCompiled(input),
      })
    } catch {
      // fixture missing
    }
  }
  try {
    const input = readCssFixture('bootstrap4.css')
    cases.push({
      id: 'css/bootstrap4',
      language: 'css',
      fixture: 'bootstrap4',
      input,
      iterations: 30,
      optional: true,
      interpreted: () => parseCss(input),
      compiled: () => parseCssCompiled(input),
    })
  } catch {
    // optional large fixture
  }

  return cases
}

export function runParsemanSuite(opts?: ParsemanSuiteOpts): ParsemanBenchRow[] {
  const scale = opts?.scale ?? 1
  const rows: ParsemanBenchRow[] = []
  for (const c of buildCases()) {
    if (opts?.skipOptional && c.optional) continue
    if (opts?.only && !opts.only.some(p => c.id.startsWith(p))) continue
    const iterations = Math.max(50, Math.floor(c.iterations * scale))
    for (const mode of ['interpreted', 'compiled'] as const) {
      opts?.onProgress?.(c.id, mode)
      const fn = mode === 'interpreted' ? c.interpreted : c.compiled
      const medianUs = measureMedianUs(fn, iterations, opts?.measure)
      rows.push({
        id: c.id,
        language: c.language,
        fixture: c.fixture,
        mode,
        bytes: c.input.length,
        iterations,
        medianUs,
        opsPerSec: Math.round(1_000_000 / medianUs),
      })
    }
  }
  return rows
}

/**
 * Run the suite `passes` times and keep the per-case/mode MEDIAN of the
 * per-pass medians. A single pass of a sub-microsecond case (e.g. `toml/small`
 * at ~0.5µs) can land ~15% off due to a thermal/GC blip inside its sample
 * window; taking the median across several independent, interleaved passes makes
 * both the stored baseline AND the guard reading reproducible, which is what lets
 * the regression tolerance be tight (≈8%) instead of absorbing measurement junk.
 * Passes are interleaved (whole suite per pass) so slow drift spreads across all
 * cases rather than biasing whichever case happened to run during a hiccup.
 */
export function runParsemanSuiteRobust(opts?: ParsemanSuiteOpts, passes = 5): ParsemanBenchRow[] {
  if (passes <= 1) return runParsemanSuite(opts)
  const acc = new Map<string, { row: ParsemanBenchRow; us: number[] }>()
  for (let p = 0; p < passes; p++) {
    for (const r of runParsemanSuite(opts)) {
      const key = `${r.id}/${r.mode}`
      const e = acc.get(key)
      if (e) e.us.push(r.medianUs)
      else acc.set(key, { row: r, us: [r.medianUs] })
    }
  }
  const rows: ParsemanBenchRow[] = []
  for (const { row, us } of acc.values()) {
    const m = median(us)
    rows.push({ ...row, medianUs: m, opsPerSec: Math.round(1_000_000 / m) })
  }
  return rows
}

export function loadBaseline(): ParsemanBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as ParsemanBaseline
}

/** All snapshots in capture order (oldest first). */
export function loadHistory(): ParsemanSnapshot[] {
  if (!existsSync(HISTORY_PATH)) return []
  return readFileSync(HISTORY_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ParsemanSnapshot)
}

/** Append a snapshot to the history log (skipped when identical gitRev+date to last entry). */
export function appendHistory(snapshot: ParsemanSnapshot): void {
  const history = loadHistory()
  const last = history[history.length - 1]
  if (last?.gitRev === snapshot.gitRev && last?.updatedAt === snapshot.updatedAt) return
  appendFileSync(HISTORY_PATH, JSON.stringify(snapshot) + '\n')
}

export function historyAnchors(history: ParsemanSnapshot[]): {
  origin: ParsemanSnapshot | null
  previous: ParsemanSnapshot | null
} {
  if (history.length === 0) return { origin: null, previous: null }
  const origin = history[0]!
  const previous = history.length >= 2 ? history[history.length - 2]! : null
  return { origin, previous }
}

export function writeBaseline(
  rows: ParsemanBenchRow[],
  measurement?: { scale: number; samples: number },
): ParsemanBaseline {
  let gitRev = 'unknown'
  try { gitRev = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { /* */ }
  const baseline: ParsemanBaseline = {
    updatedAt: new Date().toISOString().slice(0, 10),
    gitRev,
    measurement: measurement ?? { scale: 1, samples: 15 },
    cases: {},
  }
  for (const r of rows) {
    const key = `${r.id}/${r.mode}`
    baseline.cases[key] = { medianUs: r.medianUs, iterations: r.iterations, bytes: r.bytes }
  }
  appendHistory(baseline)
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  return baseline
}

function pctDelta(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100
}

function fmtDelta(pct: number): string {
  if (Math.abs(pct) < 0.5) return '±0%'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

export function printParsemanReport(
  rows: ParsemanBenchRow[],
  baseline: ParsemanBaseline | null,
  opts?: { skipTitle?: boolean },
): void {
  const history = loadHistory()
  const { origin, previous } = historyAnchors(history)

  if (!opts?.skipTitle) {
    console.log('\n=== Parseman perf — interpreted vs compiled (all example grammars) ===')
  }
  if (baseline) {
    console.log(`  baseline: ${baseline.updatedAt} @ ${baseline.gitRev}`)
  } else {
    console.log('  baseline: (none — run pnpm bench:baseline to create parseman-baseline.json)')
  }
  if (history.length > 0) {
    const parts = [`${history.length} snapshot${history.length === 1 ? '' : 's'}`]
    if (origin) parts.push(`origin ${origin.updatedAt} @ ${origin.gitRev}`)
    if (previous) parts.push(`prev ${previous.updatedAt} @ ${previous.gitRev}`)
    console.log(`  history: ${parts.join(' · ')}`)
  } else {
    console.log('  history: (none — each pnpm bench:baseline appends parseman-history.jsonl)')
  }

  const byId = new Map<string, { interp?: ParsemanBenchRow; comp?: ParsemanBenchRow }>()
  for (const r of rows) {
    const g = byId.get(r.id) ?? {}
    if (r.mode === 'interpreted') g.interp = r
    else g.comp = r
    byId.set(r.id, g)
  }

  let lastLang = ''
  for (const [id, { interp, comp }] of [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!interp || !comp) continue
    if (interp.language !== lastLang) {
      console.log(`\n  [${interp.language}]`)
      lastLang = interp.language
    }
    const speedup = interp.medianUs / comp.medianUs
    let line = `    ${id.padEnd(22)} ${String(interp.bytes).padStart(7)}B  interp ${interp.medianUs.toFixed(2).padStart(8)}µs  compiled ${comp.medianUs.toFixed(2).padStart(8)}µs  ${speedup.toFixed(2)}×`

    if (baseline) {
      const bi = baseline.cases[`${id}/interpreted`]?.medianUs
      const bc = baseline.cases[`${id}/compiled`]?.medianUs
      if (bi !== undefined && bc !== undefined) {
        line += `  Δi ${fmtDelta(pctDelta(interp.medianUs, bi))} Δc ${fmtDelta(pctDelta(comp.medianUs, bc))}`
      }
    }
    if (previous || origin) {
      const pc = previous?.cases[`${id}/compiled`]?.medianUs
      const oc = origin?.cases[`${id}/compiled`]?.medianUs
      if (pc !== undefined) line += `  Δc↓prev ${fmtDelta(pctDelta(comp.medianUs, pc))}`
      if (oc !== undefined && oc !== pc) line += `  Δc↓origin ${fmtDelta(pctDelta(comp.medianUs, oc))}`
    }
    console.log(line)
  }
  console.log()
}

/** Compact index of all history snapshots (compiled µs for one case, or average speedup). */
export function printHistoryIndex(caseId = 'css/bootstrap4'): void {
  const history = loadHistory()
  if (history.length === 0) {
    console.log('  (no history yet — run pnpm bench:baseline after perf changes)')
    return
  }
  console.log(`\n=== Parseman history — ${caseId}/compiled median µs ===`)
  for (const snap of history) {
    const us = snap.cases[`${caseId}/compiled`]?.medianUs
    const label = us !== undefined ? `${us.toFixed(2)}µs` : '(missing)'
    console.log(`  ${snap.updatedAt} @ ${snap.gitRev.padEnd(8)}  ${label}`)
  }
  console.log()
}

/** Returns regression messages when any case exceeds tolerance vs baseline. */
/**
 * Detect perf regressions vs the committed baseline.
 *
 * PRIMARY check — absolute median µs per measured mode. Ratios are useful
 * reporting, but not a regression signal: making the interpreter faster lowers
 * the compiled/interpreted ratio without making anything slower.
 */
export function findRegressions(
  rows: ParsemanBenchRow[],
  baseline: ParsemanBaseline,
  opts?: {
    tolerance?: { compiled?: number; interpreted?: number; speedup?: number }
    /** Which modes to check (default both). */
    modes?: ParsemanMode[]
    /** Run the speedup-ratio check (default false; ratios are usually informational). */
    checkSpeedup?: boolean
    /** Run the absolute-µs speed check (default true). */
    checkAbsolute?: boolean
  },
): string[] {
  const tolCompiled = opts?.tolerance?.compiled ?? PERF_TOLERANCE
  const tolInterpreted = opts?.tolerance?.interpreted ?? PERF_TOLERANCE
  const tolSpeedup = opts?.tolerance?.speedup ?? PERF_TOLERANCE
  const modes = opts?.modes ?? ['interpreted', 'compiled']
  const checkAbsolute = opts?.checkAbsolute ?? true
  const msgs: string[] = []

  const byId = new Map<string, { interp?: ParsemanBenchRow; comp?: ParsemanBenchRow }>()
  for (const r of rows) {
    const g = byId.get(r.id) ?? {}
    if (r.mode === 'interpreted') g.interp = r
    else g.comp = r
    byId.set(r.id, g)
  }

  // ── Optional: speedup ratio — informational for normal guard use ──────────
  if (opts?.checkSpeedup === true) {
    for (const [id, { interp, comp }] of byId) {
      if (!interp || !comp) continue
      const bi = baseline.cases[`${id}/interpreted`]?.medianUs
      const bc = baseline.cases[`${id}/compiled`]?.medianUs
      if (bi === undefined || bc === undefined) continue
      const speedup = interp.medianUs / comp.medianUs
      const baseSpeedup = bi / bc
      const dropPct = ((baseSpeedup - speedup) / baseSpeedup) * 100
      if (dropPct > tolSpeedup) {
        msgs.push(`${id}/speedup: ${speedup.toFixed(2)}× vs baseline ${baseSpeedup.toFixed(2)}× (${dropPct.toFixed(1)}% below baseline ratio)`)
      }
    }
  }

  // ── Primary: absolute speed regression ────────────────────────────────────
  if (checkAbsolute) {
    for (const r of rows) {
      if (!modes.includes(r.mode)) continue
      const key = `${r.id}/${r.mode}`
      const b = baseline.cases[key]
      if (!b) continue
      const pct = pctDelta(r.medianUs, b.medianUs)
      const limit = r.mode === 'compiled' ? tolCompiled : tolInterpreted
      if (pct > limit) {
        msgs.push(`${key}: ${r.medianUs.toFixed(2)}µs vs baseline ${b.medianUs.toFixed(2)}µs (${fmtDelta(pct)} regression, absolute)`)
      }
    }
  }

  return msgs
}
