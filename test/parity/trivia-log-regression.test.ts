/**
 * Regression: interpreted vs compiled `_triviaLog` must stay in sync.
 *
 * Red state (before fix):
 * - interpreter duplicated pairs (e.g. [13,14] ×4 on selector.css) because
 *   `_triviaLog` was committed speculatively but not rolled back with `_cstTriviaLog`
 * - compiled skipped the same pairs and advanced `curV` inside `_tc()` before the
 *   following term matched, swallowing trivia at `{` boundaries
 *
 * Green state: identical logs, no duplicate pairs, golden spans below.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveCssFixture } from '../../bench/css-fixture.ts'
import { Stylesheet, compiledCss } from '../../examples/css/parser.ts'
import {
  expectTriviaLogGolden,
  expectTriviaLogParity,
  runTriviaLogParity,
  triviaPairs,
} from './helpers/trivia-log-parity.ts'

/** Minimal single-line repro from selector.css — triggered duplicate/missing `{` trivia. */
const SELECTOR_LINE = 'a/* { } */ b {}'

/** Golden log for SELECTOR_LINE via full Stylesheet (post-fix). */
const SELECTOR_LINE_TRIVIA_LOG = [1, 11, 12, 13] as const

/** Golden log for fixtures/css/selector.css (post-fix). */
const SELECTOR_FILE_TRIVIA_LOG = [
  0, 1, 2, 12, 13,
  14, 16, 18, 19, 29,
  30, 31,
] as const

describe('regression: interpreted/compiled _triviaLog parity', () => {
  it('selector line — golden log, no duplicate pairs, interpreted === compiled', () => {
    const { iLog, cLog, interpreted, compiled } = runTriviaLogParity(
      Stylesheet,
      compiledCss,
      SELECTOR_LINE,
    )

    expect(interpreted.ok).toBe(true)
    expect(compiled.ok).toBe(true)
    expect(interpreted.span).toEqual(compiled.span)

    expectTriviaLogGolden(iLog, SELECTOR_LINE_TRIVIA_LOG)
    expectTriviaLogParity(iLog, cLog)

    // Explicit guard against the original duplicate-pair failure mode.
    expect(triviaPairs(iLog)).toEqual([
      [1, 11],
      [12, 13],
    ])
  })

  it('selector.css fixture — golden log and parity', () => {
    const src = readFileSync(resolveCssFixture('selector.css'), 'utf8')
    const { iLog, cLog } = runTriviaLogParity(Stylesheet, compiledCss, src)

    expectTriviaLogGolden(iLog, SELECTOR_FILE_TRIVIA_LOG)
    expectTriviaLogParity(iLog, cLog)
    expect(iLog.length / 2, 'six trivia pairs on selector.css').toBe(6)
  })

  it('space-before-{ trivia is logged exactly once per ruleset', () => {
    const src = readFileSync(resolveCssFixture('selector.css'), 'utf8')
    const { iLog, cLog } = runTriviaLogParity(Stylesheet, compiledCss, src)

    const pairs = triviaPairs(iLog)
    expect(pairs.filter(p => p[0] === 13 && p[1] === 14)).toHaveLength(1)
    expect(pairs.filter(p => p[0] === 30 && p[1] === 31)).toHaveLength(1)
    expect(cLog).toEqual(iLog)
  })
})
