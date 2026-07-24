/**
 * Deterministic allocation signal for the chV-elision: count young-gen GC
 * scavenges + total GC pause over a fixed parse batch, per variant. Run each
 * variant in its OWN process section so GC state doesn't cross-contaminate.
 *
 *   node --import tsx/esm --expose-gc bench/alloc-count.ts [decls] [batch]
 */
import { compiled, host, hostOptOut, buildInput } from './alloc-model.ts'
import { PerformanceObserver } from 'node:perf_hooks'
import type { ParseContext } from '../src/index.ts'

const decls = Number(process.argv[2] ?? 1500)
const BATCH = Number(process.argv[3] ?? 60)
const input = buildInput(decls)

/**
 * Parse a fixed batch for one variant, counting young-gen scavenges, major GCs
 * and total GC pause (ms) plus median-free wall time. GC entries are delivered
 * asynchronously, so any still-queued entries are drained via `takeRecords()`
 * before `disconnect()` — otherwise the last batch's GCs would be dropped.
 */
function run(optOut: boolean): { scavenges: number; major: number; gcMs: number; wallMs: number } {
  const h = optOut ? hostOptOut : host
  let scavenges = 0, major = 0, gcMs = 0
  const tally = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      // @ts-expect-error node gc detail
      const kind = e.detail?.kind
      if (kind === 1) scavenges++
      else major++
      gcMs += e.duration
    }
  }
  const obs = new PerformanceObserver(list => tally(list.getEntries()))
  // warmup (JIT) outside the measured window
  for (let i = 0; i < 8; i++) {
    const r = compiled.parseWithContext(input, { trackLines: false, build: h, captureTrivia: true } as unknown as ParseContext, 0)
    if (!r.ok) throw new Error('fail')
  }
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) { gc(); gc() }
  obs.observe({ entryTypes: ['gc'] })
  const t0 = performance.now()
  for (let i = 0; i < BATCH; i++) {
    const r = compiled.parseWithContext(input, { trackLines: false, build: h, captureTrivia: true } as unknown as ParseContext, 0)
    if (!r.ok) throw new Error('fail')
  }
  const wallMs = (performance.now() - t0) / BATCH
  tally(obs.takeRecords()) // drain queued GC entries before teardown
  obs.disconnect()
  return { scavenges, major, gcMs, wallMs }
}

// alternate to balance any thermal/JIT drift
const A: ReturnType<typeof run>[] = [], B: ReturnType<typeof run>[] = []
for (let i = 0; i < 5; i++) { B.push(run(true)); A.push(run(false)) }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const baseScav = sum(A.map(x => x.scavenges)), optScav = sum(B.map(x => x.scavenges))
const baseGc = sum(A.map(x => x.gcMs)), optGc = sum(B.map(x => x.gcMs))
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const baseWall = med(A.map(x => x.wallMs)), optWall = med(B.map(x => x.wallMs))

console.log(`\n== chV-elision allocation A/B: ${decls} decls, ${(input.length / 1024).toFixed(1)} KB, batch ${BATCH} x5 ==`)
console.log(`baseline  (chV kept):    scavenges ${baseScav}   gcPause ${baseGc.toFixed(0)} ms   wall ${baseWall.toFixed(3)} ms/parse`)
console.log(`optimized (chV elided):  scavenges ${optScav}   gcPause ${optGc.toFixed(0)} ms   wall ${optWall.toFixed(3)} ms/parse`)
console.log(`scavenge reduction: ${((1 - optScav / baseScav) * 100).toFixed(1)}%   gcPause reduction: ${((1 - optGc / baseGc) * 100).toFixed(1)}%   wall: ${((1 - optWall / baseWall) * 100).toFixed(1)}% faster`)
