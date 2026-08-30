import { describe, expect, it } from 'vitest'
import {
  JESS_AB_FIXTURES,
  macroCandidateGateRatio,
  macroTimingExitCode,
  macroTimingErrors,
  validateStructuredRun,
  type StructuredRow,
  type StructuredRun,
} from '../../bench/jess/ab-protocol.ts'

const HEAD_SOURCE = '/repo/src'
const REFERENCE_SOURCE = '/cache/release/src'

function row(fixture: string): StructuredRow {
  return {
    dialect: 'less',
    fixture,
    bytes: 100_000,
    headMs: 10,
    referenceMs: 10,
    ratio: 1,
    pairedRoundRatios: [1],
    headWins: 1,
    full: true,
    identityChecked: true,
    identityAgreement: true,
    pairingWorstDrift: 0,
    pairingTolerance: 0.20,
    pairingArtifact: false,
    forced: false,
    head: { engine: 'macro', lowering: 'macro→static-table-assembly', source: HEAD_SOURCE },
    reference: { engine: 'macro', lowering: 'macro→static-table-assembly', source: REFERENCE_SOURCE },
  }
}

function run(rows = JESS_AB_FIXTURES.less.map(row)): StructuredRun {
  return {
    schemaVersion: 1,
    self: false,
    twoGraph: false,
    reference: 'release-sha',
    headSha: 'head-sha',
    headEngine: 'macro',
    referenceEngine: 'macro',
    measurement: { targetSampleMs: 0, warmup: 1, timed: 1, rounds: 1, runs: 1 },
    rows,
  }
}

const expected = {
  dialect: 'less' as const,
  kind: 'correctness' as const,
  reference: 'release-sha',
  headSha: 'head-sha',
  headSource: HEAD_SOURCE,
}

describe('macro optimization gate contract', () => {
  it('judges the adjacent candidate pair without dividing by separate-process A/A noise', () => {
    expect(macroCandidateGateRatio(1.013)).toBe(1.013)
    expect(macroCandidateGateRatio(1.013, 1.2)).toBeCloseTo(1.2156)
  })

  it('accepts only the complete pinned macro run shape', () => {
    expect(validateStructuredRun(run(), expected)).toEqual([])

    const missing = run([row(JESS_AB_FIXTURES.less[0]!)])
    expect(validateStructuredRun(missing, expected)).toContain(
      `missing row less/${JESS_AB_FIXTURES.less[1]}`,
    )

    const aliased = run()
    aliased.rows[0]!.reference.source = HEAD_SOURCE
    expect(validateStructuredRun(aliased, expected)).toContain(
      `less/${JESS_AB_FIXTURES.less[0]}: reference source aliases HEAD source`,
    )
  })

  it('keeps the calibrated A/A validity band separate from the 3% candidate bar', () => {
    const base = {
      fullRows: 6,
      expectedFullRows: 6,
      pairingArtifacts: 0,
      forcedRows: 0,
      provenanceValid: true,
      aaWorstSwing: 1.02,
      aaSwingCeiling: 1.10,
      candidateRatios: [0.99, 1.01],
      candidateRatioCeiling: 1.03,
    }
    expect(macroTimingErrors(base)).toEqual([])
    expect(macroTimingExitCode(macroTimingErrors(base))).toBe(0)
    expect(macroTimingErrors({ ...base, aaWorstSwing: 1.101 })).toContain('A/A swing 1.101 exceeds 1.1')
    const candidateErrors = macroTimingErrors({ ...base, candidateRatios: [1.031] })
    expect(candidateErrors).toContain(
      '1 candidate ratios exceed 1.03',
    )
    expect(macroTimingExitCode(candidateErrors)).toBe(1)
  })

  it('rejects incomplete, forced, artifacted, or wrongly lowered measurements', () => {
    const base = {
      fullRows: 6,
      expectedFullRows: 6,
      pairingArtifacts: 0,
      forcedRows: 0,
      provenanceValid: true,
      aaWorstSwing: 1,
      aaSwingCeiling: 1.10,
      candidateRatios: [1],
      candidateRatioCeiling: 1.03,
    }
    expect(macroTimingErrors({ ...base, fullRows: 5 })).toContain('full rows 5, expected 6')
    expect(macroTimingErrors({ ...base, pairingArtifacts: 1 })).toContain('1 pairing artifacts')
    expect(macroTimingErrors({ ...base, forcedRows: 1 })).toContain('1 forced rows')
    expect(macroTimingErrors({ ...base, provenanceValid: false })).toContain('invalid engine/source provenance')
  })
})
