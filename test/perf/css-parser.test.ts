import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveCssFixture } from '../../bench/css-fixture.ts'
import { parseCss, parseCssCompiled, Stylesheet, compiledCss } from '../../examples/css/parser.ts'
import { expectTriviaLogParity, runTriviaLogParity } from '../parity/helpers/trivia-log-parity.ts'

describe('CSS grammar (jess port) — correctness', () => {
  it('parses selector.css without errors (interpreted)', () => {
    const src = readFileSync(resolveCssFixture('selector.css'), 'utf8')
    const { errors } = parseCss(src)
    expect(errors).toEqual([])
  })

  it('parses selector.css without errors (compiled)', () => {
    const src = readFileSync(resolveCssFixture('selector.css'), 'utf8')
    const { errors } = parseCssCompiled(src)
    expect(errors).toEqual([])
  })

  it('compiled matches interpreted on selector.css', () => {
    const src = readFileSync(resolveCssFixture('selector.css'), 'utf8')
    const i = parseCss(src)
    const c = parseCssCompiled(src)
    expect(c.errors).toEqual(i.errors)
    expect(c.tree.type).toBe(i.tree.type)
    expect(c.trivia.triples).toBe(i.trivia.triples)
    const { iLog, cLog } = runTriviaLogParity(Stylesheet, compiledCss, src)
    expectTriviaLogParity(iLog, cLog)
  })

  it('parses decls.css without errors', () => {
    const src = readFileSync(resolveCssFixture('decls.css'), 'utf8')
    expect(parseCssCompiled(src).errors).toEqual([])
  })
})

describe('CSS grammar — bootstrap perf smoke', () => {
  it('parses bootstrap4.css when fixture is available', () => {
    let src: string
    try {
      src = readFileSync(resolveCssFixture('bootstrap4.css'), 'utf8')
    } catch {
      return // optional — large fixture lives in less.js checkout
    }
    const { errors } = parseCssCompiled(src)
    expect(errors.length).toBeLessThanOrEqual(0)
  })

  it('bootstrap4.css timing report (CST + trivia — jess parseCssFn shape)', () => {
    let src: string
    try {
      src = readFileSync(resolveCssFixture('bootstrap4.css'), 'utf8')
    } catch {
      return
    }
    for (let i = 0; i < 3; i++) {
      parseCssCompiled(src)
      parseCss(src)
    }
    const iterations = 20
    const time = (fn: () => void) => {
      const times: number[] = []
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        fn()
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      return times[Math.floor(times.length / 2)]!
    }
    const compiledMs = time(() => {
      const r = parseCssCompiled(src)
      expect(r.trivia.triples).toBeGreaterThan(0)
    })
    const interpMs = time(() => parseCss(src))
    console.log(`\n  bootstrap4.css (${(src.length / 1024).toFixed(1)}KB) — CST + trivia capture`)
    console.log(`  compiled median:    ${compiledMs.toFixed(2)}ms`)
    console.log(`  interpreted median: ${interpMs.toFixed(2)}ms`)
    expect(compiledMs).toBeLessThan(interpMs)
  })
})
