/**
 * A/B for the structural children-array (chV) elision, on the jess model.
 * Same compiled grammar + same host body; only `_parsemanReadsChildren` toggles.
 * Proves byte-identical output, then measures wall-clock (median) + heap churn.
 *
 *   node --import tsx/esm --expose-gc bench/alloc-ab.ts [decls] [samples]
 */
import { compiled, host, hostOptOut, buildInput } from './alloc-model.ts'
import type { ParseContext } from '../src/index.ts'

const decls = Number(process.argv[2] ?? 1500)
const samples = Number(process.argv[3] ?? 11)
const input = buildInput(decls)

/** Parse the model input once with the chosen host (opt-out toggles chV elision). */
function parse(optOut: boolean): unknown {
  const h = optOut ? hostOptOut : host
  const ctx = { trackLines: false, build: h, captureTrivia: true } as unknown as ParseContext
  const r = compiled.parseWithContext(input, ctx, 0)
  if (!r.ok) throw new Error('parse failed')
  return (r as { value: unknown }).value
}

// ---- byte-identity ----
const a = JSON.stringify(parse(false))
const b = JSON.stringify(parse(true))
console.log(`byte-identical output: ${a === b ? 'YES' : 'NO'}  (len ${a.length})`)
if (a !== b) {
  console.log('  A[0:200]', a.slice(0, 200))
  console.log('  B[0:200]', b.slice(0, 200))
  process.exit(1)
}

/** Median of a numeric sample. */
function median(xs: number[]): number { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]! }

/**
 * Median wall-clock per parse, plus the net heap delta over a fixed batch.
 * `netHeapMB` is `(heapUsed_after - heapUsed_before) / BATCH` — a NOISY average
 * net change in live V8 heap, NOT per-parse allocation: GC can reclaim mid-batch,
 * so it undercounts churn and swings run-to-run. Use bench/alloc-count.ts
 * (scavenge counts) for the real allocation signal.
 */
function measure(optOut: boolean): { med: number; netHeapMB: number } {
  const gc = (globalThis as { gc?: () => void }).gc
  // warmup
  for (let i = 0; i < 5; i++) parse(optOut)
  const times: number[] = []
  const REP = 20
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now()
    for (let i = 0; i < REP; i++) parse(optOut)
    times.push((performance.now() - t0) / REP)
  }
  if (gc) gc()
  const h0 = process.memoryUsage().heapUsed
  const BATCH = 40
  for (let i = 0; i < BATCH; i++) parse(optOut)
  const netHeapMB = (process.memoryUsage().heapUsed - h0) / 1024 / 1024 / BATCH
  return { med: median(times), netHeapMB }
}

// interleave to cancel drift: measure both several times, take median of medians
const aMeds: number[] = [], bMeds: number[] = [], aHeap: number[] = [], bHeap: number[] = []
for (let round = 0; round < 5; round++) {
  const mb = measure(true)   // optimized
  const ma = measure(false)  // baseline
  bMeds.push(mb.med); aMeds.push(ma.med); bHeap.push(mb.netHeapMB); aHeap.push(ma.netHeapMB)
}
const base = median(aMeds), opt = median(bMeds)
console.log(`\n== chV-elision A/B: ${decls} decls, ${(input.length / 1024).toFixed(1)} KB ==`)
console.log(`baseline  (chV kept):    ${base.toFixed(3)} ms/parse   net heap Δ ${median(aHeap).toFixed(2)} MB/parse (noisy)`)
console.log(`optimized (chV elided):  ${opt.toFixed(3)} ms/parse   net heap Δ ${median(bHeap).toFixed(2)} MB/parse (noisy)`)
console.log(`wall-clock delta: ${((1 - opt / base) * 100).toFixed(1)}% faster   net heap Δ delta: ${((1 - median(bHeap) / median(aHeap)) * 100).toFixed(1)}% less (noisy; see alloc-count.ts for scavenge counts)`)
