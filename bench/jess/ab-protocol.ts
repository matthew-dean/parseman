import type { Measurement } from '../ab-harness.ts'
import type { Dialect } from './grammars.ts'

export const JESS_AB_RESULT_MARKER = '__JESS_AB_RESULT__'

/** The exact configured inputs. A missing row is a failed measurement, not a smaller suite. */
export const JESS_AB_FIXTURES: Readonly<Record<Dialect, readonly string[]>> = {
  css: ['packages/jess/benchmark/benchmark.css'],
  less: ['packages/jess/benchmark/benchmark.less', 'packages/jess/benchmark/gen-workload.less'],
  scss: ['packages/jess/benchmark/gen-workload.scss'],
  jess: ['packages/jess/benchmark/benchmark.jess'],
}

export type StructuredRow = {
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

export type StructuredRun = {
  schemaVersion: number
  self: boolean
  twoGraph: boolean
  reference: string
  headSha: string
  headEngine: string
  referenceEngine: string
  measurement: Measurement
  rows: StructuredRow[]
}

export type MacroRunKind = 'correctness' | 'candidate' | 'self'

export type MacroRunExpectation = {
  dialect: 'css' | 'less'
  kind: MacroRunKind
  reference: string
  headSha: string
  headSource: string
}

export function rowKey(row: Pick<StructuredRow, 'dialect' | 'fixture'>): string {
  return `${row.dialect}/${row.fixture}`
}

export function expectedRowKeys(dialects: readonly ('css' | 'less')[]): string[] {
  return dialects.flatMap(dialect => JESS_AB_FIXTURES[dialect].map(fixture => `${dialect}/${fixture}`))
}

/**
 * Validate the structured child record before any result can be called a measurement.
 * The caller still owns semantic identity and timing thresholds; this owns run shape,
 * fixture completeness, and the engine/source provenance shared by both modes.
 */
export function validateStructuredRun(run: StructuredRun, expected: MacroRunExpectation): string[] {
  const errors: string[] = []
  const wantTwoGraph = expected.kind !== 'correctness'
  const wantSelf = expected.kind === 'self'
  if (run.schemaVersion !== 1) errors.push(`schemaVersion ${run.schemaVersion}, expected 1`)
  if (run.twoGraph !== wantTwoGraph) errors.push(`twoGraph ${run.twoGraph}, expected ${wantTwoGraph}`)
  if (run.self !== wantSelf) errors.push(`self ${run.self}, expected ${wantSelf}`)
  if (run.reference !== expected.reference) errors.push(`reference ${run.reference}, expected ${expected.reference}`)
  if (run.headSha !== expected.headSha) errors.push(`headSha ${run.headSha}, expected ${expected.headSha}`)
  if (run.headEngine !== 'macro' || run.referenceEngine !== 'macro') {
    errors.push(`run engines ${run.headEngine}/${run.referenceEngine}, expected macro/macro`)
  }

  const wanted = new Set(JESS_AB_FIXTURES[expected.dialect].map(fixture => `${expected.dialect}/${fixture}`))
  const seen = new Set<string>()
  let referenceSource: string | undefined
  for (const row of run.rows) {
    const key = rowKey(row)
    if (seen.has(key)) errors.push(`duplicate row ${key}`)
    seen.add(key)
    if (!wanted.has(key)) errors.push(`unexpected row ${key}`)
    if (row.head.engine !== 'macro' || row.reference.engine !== 'macro') {
      errors.push(`${key}: row engines ${row.head.engine}/${row.reference.engine}, expected macro/macro`)
    }
    if (row.head.lowering !== 'macro→static-table-assembly'
      || row.reference.lowering !== 'macro→static-table-assembly') {
      errors.push(`${key}: row lowerings ${row.head.lowering}/${row.reference.lowering}, expected static table assembly`)
    }
    if (row.head.source !== expected.headSource) {
      errors.push(`${key}: HEAD source ${row.head.source}, expected ${expected.headSource}`)
    }
    if (row.reference.source === expected.headSource) errors.push(`${key}: reference source aliases HEAD source`)
    if (referenceSource === undefined) referenceSource = row.reference.source
    else if (row.reference.source !== referenceSource) errors.push(`${key}: reference source changed within one run`)
  }
  for (const key of wanted) if (!seen.has(key)) errors.push(`missing row ${key}`)
  return errors
}

export type MacroTimingAcceptance = {
  fullRows: number
  expectedFullRows: number
  pairingArtifacts: number
  forcedRows: number
  provenanceValid: boolean
  aaWorstSwing: number
  aaSwingCeiling: number
  candidateRatios: readonly number[]
  candidateRatioCeiling: number
}

export function macroTimingErrors(value: MacroTimingAcceptance): string[] {
  const errors: string[] = []
  if (value.fullRows !== value.expectedFullRows) {
    errors.push(`full rows ${value.fullRows}, expected ${value.expectedFullRows}`)
  }
  if (value.pairingArtifacts !== 0) errors.push(`${value.pairingArtifacts} pairing artifacts`)
  if (value.forcedRows !== 0) errors.push(`${value.forcedRows} forced rows`)
  if (!value.provenanceValid) errors.push('invalid engine/source provenance')
  if (value.aaWorstSwing > value.aaSwingCeiling) {
    errors.push(`A/A swing ${value.aaWorstSwing} exceeds ${value.aaSwingCeiling}`)
  }
  const slow = value.candidateRatios.filter(ratio => ratio > value.candidateRatioCeiling)
  if (slow.length > 0) errors.push(`${slow.length} candidate ratios exceed ${value.candidateRatioCeiling}`)
  return errors
}

/** Convert the acceptance result into the blocking process status used by CI. */
export function macroTimingExitCode(errors: readonly string[]): 0 | 1 {
  return errors.length === 0 ? 0 : 1
}
