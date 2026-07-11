/**
 * Standalone runner for the incremental re-parse benchmark (Parséman vs Lezer).
 * Not part of `pnpm bench`; run directly:  node --import tsx/esm bench/incremental-run.ts
 */
import { SCENARIOS, makeParsemanIncremental, makeLezerIncremental } from './incremental.ts'

function warmUs(fn: () => unknown, iters: number): number {
  for (let i = 0; i < Math.min(200, iters); i++) fn() // warm
  const samples: number[] = []
  for (let s = 0; s < 15; s++) {
    const t0 = performance.now()
    for (let i = 0; i < iters; i++) fn()
    samples.push((performance.now() - t0) / iters)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]! * 1000 // µs
}

console.log('Incremental re-parse — µs/op (median of 15)\n')
const pad = (s: string, n: number) => s.padEnd(n)
console.log(pad('scenario', 34), pad('parseman-inc', 14), pad('lezer-inc', 12), pad('parseman-full', 14))
for (const s of SCENARIOS) {
  const pm = makeParsemanIncremental(s)
  const lz = makeLezerIncremental(s)
  const iters = 2000
  const pmInc = warmUs(pm.incremental, iters)
  const lzInc = warmUs(lz.incremental, iters)
  const pmFull = warmUs(pm.fullReparse, 500)
  console.log(
    pad(s.name, 34),
    pad(pmInc.toFixed(1), 14),
    pad(lzInc.toFixed(1), 12),
    pad(pmFull.toFixed(1), 14),
  )
}
