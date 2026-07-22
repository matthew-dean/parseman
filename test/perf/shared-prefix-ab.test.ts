/**
 * Guards the `sharedPrefix` choice strategy with a within-process A/B, and doubles
 * as its proof artifact (the pseudo `::?` case shows no win because the prefix is a
 * 2-char scan; the win is real only when the shared prefix does meaningful work and
 * several arms re-scan it before one wins):
 *   - VALIDITY: the grouped grammar really compiles to `sharedPrefix` and the forced
 *     grammar to ordered `firstMatch` (distinct code paths).
 *   - CORRECTNESS: both paths produce byte-identical parse results.
 *   - PERF (opt-in): sharedPrefix (scan once) beats firstMatch (re-scan per arm) on a
 *     worst case (winning arm last), and never regresses.
 *
 * Absolute medians are printed for humans and captured by
 * `node --import tsx/esm bench/shared-prefix-ab.ts`.
 */
import { describe, it, expect } from 'vitest'
import { buildAbPairs, runSharedPrefixAb } from '../../bench/shared-prefix-ab.ts'

const describePerf = process.env.PARSEMAN_PERF === '1' ? describe : describe.skip

describe('sharedPrefix A/B — validity & correctness', () => {
  const pairs = buildAbPairs()

  it('each case compiles to the two distinct paths (sharedPrefix vs firstMatch)', () => {
    for (const p of pairs) {
      expect(p.valid, `${p.name}: A/B paths not distinct`).toBe(true)
    }
  })

  for (const p of pairs) {
    it(`${p.name}: shared and firstMatch produce identical results`, () => {
      const a = p.shared(p.input), b = p.firstMatch(p.input)
      expect(a).toEqual(b)
      expect(a.ok).toBe(true)
      // Edge / non-matching inputs stay identical too.
      for (const s of [p.input.slice(0, 3), p.input.slice(0, 1), 'zzz', '']) {
        expect(p.shared(s)).toEqual(p.firstMatch(s))
      }
    })
  }
})

describePerf('sharedPrefix A/B — perf (proof + regression floor)', () => {
  it('shared-once beats re-scan-per-arm on the worst case, and never regresses', () => {
    const results = runSharedPrefixAb(200_000)
    for (const r of results) {
      console.log(`  ${r.name.padEnd(44)} firstMatch ${r.firstMatchUs.toFixed(3)}µs  shared ${r.sharedUs.toFixed(3)}µs  ${r.speedup.toFixed(3)}×`)
      expect(r.ok, `${r.name}: outputs differ`).toBe(true)
      // sharedPrefix does strictly less scanning work → must not be slower than
      // firstMatch. A discrete floor below the measured ~1.2–2.0× margin, loose
      // enough to never flake on a noisy box but tight enough to catch a real
      // regression (or the win silently disappearing).
      expect(r.speedup, `${r.name}: sharedPrefix regressed vs firstMatch`).toBeGreaterThan(1.05)
    }
  }, 60_000)
})
