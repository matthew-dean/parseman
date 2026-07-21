/**
 * Guards the two codegen optimizations (regex scan lowering, switch dispatch)
 * with a within-process A/B:
 *   - VALIDITY: the "optimized" and "baseline" grammars really compile to the
 *     two different code paths (charCodeAt vs exec; switch vs if/else).
 *   - CORRECTNESS: both paths produce byte-identical parse results.
 *   - PERF (lenient): the optimized path is not a regression vs its baseline.
 *
 * The perf floor is deliberately loose so it never flakes on a noisy CI box, but
 * still fires if an "optimization" ever makes the hot path meaningfully slower.
 * Absolute ratios are printed for humans and captured by `pnpm bench` (the
 * proper profiling tool via bench/codegen-ab.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  buildScanAbCases, buildDispatchAbCases, runScanAb, runDispatchAb,
} from '../../bench/codegen-ab.ts'

// A timing ratio needs an isolated worker. The ordinary suite still runs the
// generated-source and result-parity checks above, while `pnpm test:perf` turns
// this gate on under a serial perf configuration.
const describePerf = process.env.PARSEMAN_PERF === '1' ? describe : describe.skip

// A regression is only flagged if the optimized path is >40% slower than its
// same-semantics baseline — well outside measurement noise for these medians.
const PERF_FLOOR = 0.7

describe('codegen A/B — regex scan lowering', () => {
  const cases = buildScanAbCases()

  it('each case exercises the two distinct code paths (charCodeAt vs exec)', () => {
    for (const c of cases) {
      expect(c.valid, `${c.name}: A/B paths not distinct`).toBe(true)
    }
  })

  for (const c of cases) {
    it(`${c.name}: scan and exec produce identical results`, () => {
      const long = c.scan(c.input)
      expect(long).toEqual(c.exec(c.input))
      // A few short/edge inputs too.
      for (const s of [c.input.slice(0, 3), c.input.slice(0, 1), 'zzz', '']) {
        expect(c.scan(s)).toEqual(c.exec(s))
      }
    })
  }
})

describe('codegen A/B — disjoint dispatch (switch vs if/else)', () => {
  const cases = buildDispatchAbCases()

  it('each case exercises switch vs if/else', () => {
    for (const c of cases) {
      expect(c.valid, `${c.name}: A/B paths not distinct`).toBe(true)
    }
  })

  for (const c of cases) {
    it(`${c.name}: switch and if/else produce identical results`, () => {
      expect(c.sw(c.input)).toEqual(c.iff(c.input))
      for (const s of [c.input.slice(0, 5), c.input.slice(0, 1), 'zzz', '']) {
        expect(c.sw(s)).toEqual(c.iff(s))
      }
    })
  }
})

describePerf('codegen A/B — perf floor (lenient)', () => {
  it('regex scan is not a regression vs exec', () => {
    const results = runScanAb(4_000)
    for (const r of results) {
      console.log(`  scan ${r.name.padEnd(24)} ${r.speedup.toFixed(2)}× vs exec`)
      expect(r.speedup, `${r.name} scan regressed`).toBeGreaterThan(PERF_FLOOR)
    }
  }, 60_000)

  it('switch dispatch is not a regression vs if/else', () => {
    const results = runDispatchAb(4_000)
    for (const r of results) {
      console.log(`  switch ${r.name.padEnd(24)} ${r.speedup.toFixed(2)}× vs if/else`)
      expect(r.speedup, `${r.name} switch regressed`).toBeGreaterThan(PERF_FLOOR)
    }
  }, 60_000)
})
