import { describe, it, expect } from 'vitest'
import {
  runParsemanSuite,
  runParsemanSuiteRobust,
  loadBaseline,
  findRegressions,
  measureMedianUs,
  loadHistory,
  historyAnchors,
  PERF_SAMPLES,
  GUARD_PASSES,
  PERF_TOLERANCE,
} from '../../bench/parseman-perf.ts'
import { parseJSON, jsonDoc } from '../../examples/json/parser.ts'
import { compile } from '../../src/index.ts'
import { parseCSV } from '../../examples/csv/parser.ts'
import { parseGraphQL } from '../../examples/graphql/parser.ts'
import { parseConfig } from '../../examples/toml-ish/parser.ts'
import { parseExpr } from '../../examples/lang/parser.ts'
import { parseCss, parseCssCompiled } from '../../examples/css/parser.ts'
import { readCssFixture } from '../../bench/css-fixture.ts'
import { SMALL_JSON, SMALL_CSV, SMALL_GQL, SMALL_CONFIG, SMALL_EXPR } from '../../bench/fixtures.ts'

const compiledJSON = compile(jsonDoc)

describe('Parseman perf — correctness smoke', () => {
  it('all example grammars parse small fixtures', () => {
    expect(() => parseJSON(SMALL_JSON)).not.toThrow()
    expect(() => parseCSV(SMALL_CSV)).not.toThrow()
    expect(() => parseGraphQL(SMALL_GQL)).not.toThrow()
    expect(() => parseConfig(SMALL_CONFIG)).not.toThrow()
    expect(() => parseExpr(SMALL_EXPR)).not.toThrow()
    expect(parseCss(readCssFixture('selector.css')).errors).toEqual([])
    expect(parseCssCompiled(readCssFixture('selector.css')).errors).toEqual([])
  })

  it('compiled is faster than interpreted on JSON small (sanity)', () => {
    const interp = measureMedianUs(() => parseJSON(SMALL_JSON), 5_000, { samples: 5 })
    const comp = measureMedianUs(() => compiledJSON.parse(SMALL_JSON, 0), 5_000, { samples: 5 })
    expect(comp).toBeLessThan(interp)
  })
})

describe('Parseman perf — history', () => {
  it('history file loads and has origin anchor', () => {
    const history = loadHistory()
    expect(history.length).toBeGreaterThan(0)
    const { origin } = historyAnchors(history)
    expect(origin?.gitRev).toBeTruthy()
    expect(origin?.cases['json/small/compiled']?.medianUs).toBeGreaterThan(0)
  })
})

describe('Parseman perf — baseline regression guard', () => {
  // TIGHT gate — measured median speed must stay within PERF_TOLERANCE of the
  // committed baseline. Runs on the CSS subset, mirroring `pnpm perf:guard`.
  it('css median speed within tight tolerance vs baseline', () => {
    const baseline = loadBaseline()
    if (!baseline) return

    const rows = runParsemanSuiteRobust({
      scale: baseline.measurement?.scale ?? 1,
      skipOptional: true,
      only: ['css'],
      measure: { samples: PERF_SAMPLES },
    }, GUARD_PASSES)
    const regressions = findRegressions(rows, baseline, {
      checkSpeedup: false,
      checkAbsolute: true,
      tolerance: { compiled: PERF_TOLERANCE, interpreted: PERF_TOLERANCE },
    })
    if (regressions.length > 0) {
      console.log('\nParseman CSS perf regressions vs baseline:')
      for (const m of regressions) console.log(`  ${m}`)
    }
    expect(regressions).toEqual([])
  }, 120_000)

  // WIDE net — cheap single-pass sweep of every grammar to catch a gross
  // regression anywhere. Loose tolerance because a fast single pass is noisy on
  // sub-µs cases; the authoritative tight gate is `pnpm perf:guard --all`.
  it('no grammar grossly regresses vs committed baseline', () => {
    const baseline = loadBaseline()
    if (!baseline) return

    const rows = runParsemanSuite({
      scale: baseline.measurement?.scale ?? 1,
      skipOptional: true,
      measure: { samples: 5 },
    })
    const regressions = findRegressions(rows, baseline, {
      checkSpeedup: false,
      checkAbsolute: true,
      tolerance: { compiled: 50, interpreted: 50 },
    })
    if (regressions.length > 0) {
      console.log('\nParseman gross perf regressions vs baseline:')
      for (const m of regressions) console.log(`  ${m}`)
    }
    expect(regressions).toEqual([])
  }, 120_000)
})
