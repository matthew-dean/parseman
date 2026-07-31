import { describe, it, expect } from 'vitest'
import {
  loadBaseline,
  baselineCases,
  captureContextRows,
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
  // Both gates measure in a SPAWNED clean process, not in this worker. The worker
  // has already run the smoke tests above (every grammar) plus the other perf
  // files, so its interpreter inline caches are polluted: an in-process css-only
  // reading here measures like the full suite (~+17% on css interp) and would be
  // compared against a baseline captured in a pristine process. Spawning the same
  // capture child bench:baseline uses makes the comparison apples-to-apples.
  // See PERF_CONTEXTS in bench/parseman-perf.ts.

  // TIGHT gate — measured median speed must stay within PERF_TOLERANCE of the
  // committed baseline. Runs on the CSS subset, mirroring `pnpm perf:guard`.
  it('css median speed within tight tolerance vs baseline', () => {
    const baseline = loadBaseline()
    // A vitest `return` is a PASS. Skipping on a missing baseline made this gate report
    // success having compared nothing, which is the one state where it matters most.
    if (!baseline) throw new Error('bench/parseman-baseline.json is missing — run `pnpm bench:baseline` and commit it.')
    if (!baselineCases(baseline, 'css')) throw new Error('baseline has no "css" context — re-run `pnpm bench:baseline`.')

    const rows = captureContextRows('css', { samples: PERF_SAMPLES, passes: GUARD_PASSES })
    const regressions = findRegressions(rows, baseline, {
      checkSpeedup: false,
      checkAbsolute: true,
      tolerance: { compiled: PERF_TOLERANCE, interpreted: PERF_TOLERANCE },
      context: 'css',
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
    if (!baseline) throw new Error('bench/parseman-baseline.json is missing — run `pnpm bench:baseline` and commit it.')
    if (!baselineCases(baseline, 'all')) throw new Error('baseline has no "all" context — re-run `pnpm bench:baseline`.')

    // Cheap sweep — few samples, but at least 3 passes. Fewer reads COLD: a css
    // case does 50 warmup iterations, nowhere near enough for V8 to optimize the
    // big compiled parse function, so a 1-pass sweep reports css compiled at
    // ~5.2µs against a 2.05µs baseline (+164%). 3 passes lands warm (~2.2µs), and
    // an EVEN pass count is worse than useless here — median() of 2 takes the
    // upper element, i.e. the cold pass. The loose 50% tolerance absorbs what
    // remains.
    const rows = captureContextRows('all', { samples: 5, passes: 3 })
    const regressions = findRegressions(rows, baseline, {
      checkSpeedup: false,
      checkAbsolute: true,
      tolerance: { compiled: 50, interpreted: 50 },
      context: 'all',
    })
    if (regressions.length > 0) {
      console.log('\nParseman gross perf regressions vs baseline:')
      for (const m of regressions) console.log(`  ${m}`)
    }
    expect(regressions).toEqual([])
  }, 120_000)
})
