/**
 * Machine-readable optimization harness for the shipping macro parser.
 *
 * Timing uses Jess's established two-graph A/B. Correctness uses its richer
 * three-way macro/reference/interpreter identity mode. This wrapper captures the
 * verbose provenance transcript and emits one JSON object for ce-optimize.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const AB = path.resolve(ROOT, 'bench/jess/ab.ts')
const REGISTER = path.resolve(ROOT, 'bench/jess/ab-register.mjs')
const RESULT_MARKER = '__JESS_AB_RESULT__'
const RANKABLE_BYTES = 4096

type Dialect = 'css' | 'less'
type StructuredRow = {
  dialect: Dialect
  fixture: string
  bytes: number
  headMs: number
  referenceMs: number
  ratio: number
  pairedRoundRatios: number[]
  headWins: number
  full: boolean
  identityChecked: boolean
  identityAgreement: boolean
  pairingWorstDrift: number
  pairingTolerance: number
  pairingArtifact: boolean
  forced: boolean
  head: { engine: string; lowering: string; source: string }
  reference: { engine: string; lowering: string; source: string }
}

type StructuredRun = {
  schemaVersion: number
  self: boolean
  twoGraph: boolean
  reference: string
  headSha: string
  headEngine: string
  referenceEngine: string
  measurement: { warmup: number; timed: number; rounds: number; runs: number }
  rows: StructuredRow[]
}

function arg(name: string): string | null {
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null
}

function positiveInt(name: string, fallback: number): number {
  const raw = arg(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be an integer >= 1`)
  return value
}

function positiveNumber(name: string, fallback: number): number {
  const raw = arg(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`)
  return value
}

function geomean(values: readonly number[]): number {
  if (values.length === 0 || values.some(value => !(value > 0))) {
    throw new Error(`cannot take geomean of ${JSON.stringify(values)}`)
  }
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
}

function runAb(dialect: Dialect, args: readonly string[], env: NodeJS.ProcessEnv = process.env): StructuredRun {
  let output: string
  try {
    output = execFileSync(process.execPath, [
      '--import', pathToFileURL(REGISTER).href,
      AB,
      dialect,
      ...args,
    ], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const e = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8')
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8')
    throw new Error(
      `macro optimize ${dialect} child failed\n${stderr?.trim() || ''}\n${stdout?.slice(-4000).trim() || ''}`,
      { cause: error },
    )
  }
  const line = output.split('\n').find(value => value.startsWith(RESULT_MARKER))
  if (!line) throw new Error(`macro optimize ${dialect} child emitted no ${RESULT_MARKER} record`)
  const parsed = JSON.parse(line.slice(RESULT_MARKER.length)) as StructuredRun
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error(`macro optimize ${dialect} child emitted an unusable record`)
  }
  return parsed
}

const mode = arg('mode') ?? 'timing'
if (mode !== 'timing' && mode !== 'correctness') throw new Error('--mode must be timing or correctness')
const dialectsRaw = (arg('dialects') ?? 'less,css').split(',')
if (dialectsRaw.length === 0 || dialectsRaw.some(value => value !== 'less' && value !== 'css')) {
  throw new Error('--dialects must be a comma-separated subset of less,css')
}
const dialects = [...new Set(dialectsRaw)] as Dialect[]
const reference = arg('ref') ?? process.env.PM_MACRO_OPT_REF
if (!reference) throw new Error('--ref=<immutable 0.50.2 sha> or PM_MACRO_OPT_REF is required')

const warmup = positiveInt('warmup', mode === 'timing' ? 3 : 1)
const timed = positiveInt('timed', mode === 'timing' ? 5 : 1)
const rounds = positiveInt('rounds', mode === 'timing' ? 8 : 1)
const runs = positiveInt('runs', mode === 'timing' ? 2 : 1)
const slowdownPlant = positiveNumber('assert-candidate-slowdown', 1)
const common = [
  `--warmup=${warmup}`,
  `--timed=${timed}`,
  `--rounds=${rounds}`,
  `--runs=${runs}`,
]

if (mode === 'correctness') {
  const rows = dialects.flatMap(dialect => runAb(dialect, [
    `--ref=${reference}`,
    '--require-identity',
    '--require-full',
    ...common,
  ]).rows)
  const valid = rows.filter(row => row.full && row.identityChecked && row.identityAgreement && !row.forced)
  process.stdout.write(`${JSON.stringify({
    measurement_valid: valid.length === rows.length ? 1 : 0,
    macro_identity_rows: valid.length,
    macro_expected_identity_rows: rows.length,
    macro_full_rows: rows.filter(row => row.full).length,
    macro_pairing_artifacts: rows.filter(row => row.pairingArtifact).length,
    provenance: {
      harness: realpathSync(import.meta.filename),
      jess_ab: realpathSync(AB),
      reference,
      dialects,
      mode,
    },
  })}\n`)
  process.exit(valid.length === rows.length ? 0 : 1)
}

const candidateRuns = dialects.map(dialect => runAb(dialect, [
  `--ref=${reference}`,
  '--two-graph',
  '--require-full',
  ...common,
]))
const selfRuns = dialects.map(dialect => runAb(dialect, [
  '--self',
  '--two-graph',
  '--require-full',
  ...common,
]))

const candidateRows = candidateRuns.flatMap(run => run.rows).filter(row => row.bytes >= RANKABLE_BYTES)
const selfRows = selfRuns.flatMap(run => run.rows).filter(row => row.bytes >= RANKABLE_BYTES)
const selfByFixture = new Map(selfRows.map(row => [`${row.dialect}/${row.fixture}`, row]))
const normalizedRows = candidateRows.map(row => {
  const self = selfByFixture.get(`${row.dialect}/${row.fixture}`)
  if (!self) throw new Error(`self run omitted ${row.dialect}/${row.fixture}`)
  return {
    ...row,
    selfRatio: self.ratio,
    normalizedRatio: row.ratio / self.ratio * slowdownPlant,
  }
})

const ratios = normalizedRows.map(row => row.normalizedRatio)
const lessRatios = normalizedRows.filter(row => row.dialect === 'less').map(row => row.normalizedRatio)
const cssRatios = normalizedRows.filter(row => row.dialect === 'css').map(row => row.normalizedRatio)
const allRows = [...candidateRows, ...selfRows]
const fullRows = allRows.filter(row => row.full).length
const pairingArtifacts = allRows.filter(row => row.pairingArtifact).length
const forcedRows = allRows.filter(row => row.forced).length
const provenanceValid = allRows.every(row => row.head.engine === 'macro'
  && row.reference.engine === 'macro'
  && row.head.lowering === 'macro→static-table-assembly'
  && row.reference.lowering === 'macro→static-table-assembly')
const aaWorstSwing = Math.max(...selfRows.map(row => Math.max(row.ratio, 1 / row.ratio)))

process.stdout.write(`${JSON.stringify({
  macro_geomean_ratio: geomean(ratios),
  macro_less_geomean_ratio: lessRatios.length > 0 ? geomean(lessRatios) : 1,
  macro_css_geomean_ratio: cssRatios.length > 0 ? geomean(cssRatios) : 1,
  macro_worst_fixture_ratio: Math.max(...ratios),
  macro_rows_better: ratios.filter(ratio => ratio < 1).length,
  macro_rankable_rows: normalizedRows.length,
  macro_full_rows: fullRows,
  macro_expected_full_rows: allRows.length,
  macro_pairing_artifacts: pairingArtifacts,
  macro_forced_rows: forcedRows,
  macro_provenance_valid: provenanceValid ? 1 : 0,
  aa_worst_swing_ratio: aaWorstSwing,
  measurement_valid: fullRows === allRows.length && pairingArtifacts === 0
    && forcedRows === 0 && provenanceValid ? 1 : 0,
  asserted_candidate_slowdown: slowdownPlant,
  rows: normalizedRows,
  provenance: {
    harness: realpathSync(import.meta.filename),
    jess_ab: realpathSync(AB),
    reference,
    head_shas: candidateRuns.map(run => run.headSha),
    self_head_shas: selfRuns.map(run => run.headSha),
    dialects,
    mode,
    measurement: { warmup, timed, rounds, runs },
  },
})}\n`)
