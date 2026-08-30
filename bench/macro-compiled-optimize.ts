/**
 * Machine-readable optimization harness for the shipping macro parser.
 *
 * Timing uses Jess's established two-graph A/B. Correctness uses its richer
 * three-way macro/reference/interpreter identity mode. This wrapper captures the
 * verbose provenance transcript and emits one JSON object for ce-optimize.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { JESS_ROOT } from './jess/grammars.ts'
import {
  JESS_AB_RESULT_MARKER as RESULT_MARKER,
  expectedRowKeys,
  macroCandidateGateRatio,
  macroTimingExitCode,
  macroTimingErrors,
  rowKey,
  validateStructuredRun,
  type MacroRunKind,
  type StructuredRun,
} from './jess/ab-protocol.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const AB = path.resolve(ROOT, 'bench/jess/ab.ts')
const REGISTER = path.resolve(ROOT, 'bench/jess/ab-register.mjs')
const CONFIG_PATH = path.resolve(ROOT, 'bench/jess/macro-optimize-config.json')
const RANKABLE_BYTES = 4096

type Dialect = 'css' | 'less'
type Config = {
  referenceSha: string
  referenceVersion: string
  jessSha: string
  aaSwingCeiling: number
  candidateRatioCeiling: number
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

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

function gitCommit(cwd: string, ref: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
  } catch (error) {
    throw new Error(`could not resolve ${ref} to a commit in ${cwd}`, { cause: error })
  }
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
  if (process.argv.includes('--assert-omit-first-row')) parsed.rows = parsed.rows.slice(1)
  return parsed
}

function validateRuns(runs: readonly StructuredRun[], dialects: readonly Dialect[], kind: MacroRunKind,
  reference: string, headSha: string, headSource: string): void {
  if (runs.length !== dialects.length) throw new Error(`${kind}: got ${runs.length} runs, expected ${dialects.length}`)
  const errors = runs.flatMap((run, index) => validateStructuredRun(run, {
    dialect: dialects[index]!,
    kind,
    reference: kind === 'self' ? headSha : reference,
    headSha,
    headSource,
  }).map(error => `${kind}/${dialects[index]}: ${error}`))
  if (errors.length > 0) throw new Error(`macro optimize rejected ${kind} provenance:\n${errors.join('\n')}`)
}

function printLegProvenance(label: string, runs: readonly StructuredRun[]): void {
  process.stdout.write(`${label} legs (engine, lowering, resolved source):\n`)
  for (const run of runs) {
    for (const row of run.rows) {
      process.stdout.write(`  ${rowKey(row)} HEAD ${row.head.engine} ${row.head.lowering} ${row.head.source}\n`)
      process.stdout.write(`  ${rowKey(row)} REF  ${row.reference.engine} ${row.reference.lowering} ${row.reference.source}\n`)
    }
  }
}

const mode = arg('mode') ?? 'timing'
if (mode !== 'timing' && mode !== 'correctness') throw new Error('--mode must be timing or correctness')
const dialectsRaw = (arg('dialects') ?? 'less,css').split(',')
if (dialectsRaw.length === 0 || dialectsRaw.some(value => value !== 'less' && value !== 'css')) {
  throw new Error('--dialects must be a comma-separated subset of less,css')
}
const dialects = [...new Set(dialectsRaw)] as Dialect[]
const requestedReference = arg('ref') ?? process.env.PM_MACRO_OPT_REF ?? CONFIG.referenceSha
const reference = gitCommit(ROOT, requestedReference)
const releaseReference = gitCommit(ROOT, CONFIG.referenceSha)
if (reference !== releaseReference) {
  throw new Error(`--ref must resolve to the pinned ${CONFIG.referenceVersion} release ${releaseReference}; got ${reference}`)
}
const headCommit = gitCommit(ROOT, 'HEAD')
if (headCommit === reference) throw new Error('--ref resolves to HEAD, so the candidate and reference would be the same build')
const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const headSource = realpathSync(path.resolve(ROOT, 'src'))
const jessCommit = gitCommit(JESS_ROOT, 'HEAD')
if (jessCommit !== CONFIG.jessSha) {
  throw new Error(`JESS_ROOT must be pinned at ${CONFIG.jessSha}; got ${jessCommit} from ${realpathSync(JESS_ROOT)}`)
}
const jessDirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: JESS_ROOT,
  encoding: 'utf8',
  timeout: 10_000,
}).trim()
if (jessDirty !== '') throw new Error(`JESS_ROOT has uncommitted changes; refusing an unpinned fixture/grammar source:\n${jessDirty}`)

const warmup = positiveInt('warmup', mode === 'timing' ? 3 : 1)
const timed = positiveInt('timed', mode === 'timing' ? 5 : 1)
const rounds = positiveInt('rounds', mode === 'timing' ? 8 : 1)
const runs = positiveInt('runs', mode === 'timing' ? 2 : 1)
const slowdownPlant = positiveNumber('assert-candidate-slowdown', 1)
const aaSwingPlant = positiveNumber('assert-aa-swing', 1)
const common = [
  `--warmup=${warmup}`,
  `--timed=${timed}`,
  `--rounds=${rounds}`,
  `--runs=${runs}`,
]

if (mode === 'correctness') {
  const correctnessRuns = dialects.map(dialect => runAb(dialect, [
    `--ref=${reference}`,
    '--require-identity',
    '--require-full',
    ...common,
  ], { ...process.env, PM_FORCE: '1' }))
  validateRuns(correctnessRuns, dialects, 'correctness', reference, headSha, headSource)
  printLegProvenance('correctness', correctnessRuns)
  const rows = correctnessRuns.flatMap(run => run.rows)
  const expectedRows = expectedRowKeys(dialects).length
  // Correctness does not consume the timing columns, so host load cannot invalidate
  // semantic identity. The timing mode below still refuses forced measurements.
  const valid = rows.filter(row => row.full && row.identityChecked && row.identityAgreement)
  const measurementValid = valid.length === expectedRows
  process.stdout.write(`${JSON.stringify({
    measurement_valid: measurementValid ? 1 : 0,
    macro_identity_rows: valid.length,
    macro_expected_identity_rows: expectedRows,
    macro_full_rows: rows.filter(row => row.full).length,
    macro_expected_full_rows: expectedRows,
    macro_pairing_artifacts: rows.filter(row => row.pairingArtifact).length,
    macro_forced_rows: rows.filter(row => row.forced).length,
    rows,
    provenance: {
      harness: realpathSync(import.meta.filename),
      jess_ab: realpathSync(AB),
      reference,
      reference_version: CONFIG.referenceVersion,
      jess_sha: jessCommit,
      dialects,
      mode,
    },
  })}\n`)
  process.exit(measurementValid ? 0 : 1)
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

validateRuns(candidateRuns, dialects, 'candidate', reference, headSha, headSource)
validateRuns(selfRuns, dialects, 'self', reference, headSha, headSource)
printLegProvenance('candidate', candidateRuns)
printLegProvenance('self-control', selfRuns)

const candidateRows = candidateRuns.flatMap(run => run.rows).filter(row => row.bytes >= RANKABLE_BYTES)
const selfRows = selfRuns.flatMap(run => run.rows).filter(row => row.bytes >= RANKABLE_BYTES)
const selfByFixture = new Map(selfRows.map(row => [`${row.dialect}/${row.fixture}`, row]))
const scoredRows = candidateRows.map(row => {
  const self = selfByFixture.get(`${row.dialect}/${row.fixture}`)
  if (!self) throw new Error(`self run omitted ${row.dialect}/${row.fixture}`)
  return {
    ...row,
    selfRatio: self.ratio,
    gateRatio: macroCandidateGateRatio(row.ratio, slowdownPlant),
  }
})

const ratios = scoredRows.map(row => row.gateRatio)
const lessRatios = scoredRows.filter(row => row.dialect === 'less').map(row => row.gateRatio)
const cssRatios = scoredRows.filter(row => row.dialect === 'css').map(row => row.gateRatio)
const allRows = [...candidateRows, ...selfRows]
const fullRows = allRows.filter(row => row.full).length
const pairingArtifacts = allRows.filter(row => row.pairingArtifact).length
const forcedRows = allRows.filter(row => row.forced).length
const provenanceValid = allRows.every(row => row.head.engine === 'macro'
  && row.reference.engine === 'macro'
  && row.head.lowering === 'macro→static-table-assembly'
  && row.reference.lowering === 'macro→static-table-assembly')
const aaWorstSwing = Math.max(...selfRows.map(row => Math.max(row.ratio, 1 / row.ratio))) * aaSwingPlant
const expectedFullRows = expectedRowKeys(dialects).length * 2
const timingErrors = macroTimingErrors({
  fullRows,
  expectedFullRows,
  pairingArtifacts,
  forcedRows,
  provenanceValid,
  aaWorstSwing,
  aaSwingCeiling: CONFIG.aaSwingCeiling,
  candidateRatios: ratios,
  candidateRatioCeiling: CONFIG.candidateRatioCeiling,
})
const measurementValid = timingErrors.length === 0

process.stdout.write(`${JSON.stringify({
  macro_geomean_ratio: geomean(ratios),
  macro_less_geomean_ratio: lessRatios.length > 0 ? geomean(lessRatios) : 1,
  macro_css_geomean_ratio: cssRatios.length > 0 ? geomean(cssRatios) : 1,
  macro_worst_fixture_ratio: Math.max(...ratios),
  macro_rows_better: ratios.filter(ratio => ratio < 1).length,
  macro_rankable_rows: scoredRows.length,
  macro_full_rows: fullRows,
  macro_expected_full_rows: expectedFullRows,
  macro_pairing_artifacts: pairingArtifacts,
  macro_forced_rows: forcedRows,
  macro_provenance_valid: provenanceValid ? 1 : 0,
  aa_worst_swing_ratio: aaWorstSwing,
  aa_swing_ceiling: CONFIG.aaSwingCeiling,
  candidate_ratio_ceiling: CONFIG.candidateRatioCeiling,
  measurement_valid: measurementValid ? 1 : 0,
  asserted_candidate_slowdown: slowdownPlant,
  asserted_aa_swing: aaSwingPlant,
  rejection_reasons: timingErrors,
  rows: scoredRows,
  provenance: {
    harness: realpathSync(import.meta.filename),
    jess_ab: realpathSync(AB),
    reference,
    reference_version: CONFIG.referenceVersion,
    jess_sha: jessCommit,
    head_shas: candidateRuns.map(run => run.headSha),
    self_head_shas: selfRuns.map(run => run.headSha),
    dialects,
    mode,
    measurement: { warmup, timed, rounds, runs },
  },
})}\n`)
process.exit(macroTimingExitCode(timingErrors))
