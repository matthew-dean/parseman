/**
 * Confirms + measures the two parse-time allocation sources on the jess model.
 *
 *   node --import tsx/esm --expose-gc bench/alloc-profile.ts [decls] [passes]
 *
 * Reports the three profiling phases (recognizer / structuralCapture /
 * hostConstruction) so the CST-array cost (capture - recognizer) and AST/span
 * cost (host - capture) are separated, plus GC scavenge count + heap delta for a
 * full-output batch.
 */
import { run } from '../src/index.ts'
import { PerformanceObserver } from 'node:perf_hooks'
import { entry, host, compiled, buildInput } from './alloc-model.ts'

const decls = Number(process.argv[2] ?? 1500)
const passes = Number(process.argv[3] ?? 9)
const input = buildInput(decls)

// sanity
const sane = compiled.parse(input, 0)
if (!sane.ok) throw new Error('model grammar did not parse')

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

// ---- Phase profile (single representative run, medianed over passes) ----
const rec: number[] = [], cap: number[] = [], hos: number[] = []
let counts: { nodes: number; childSlots: number; rawSlots: number; triviaSlots: number } | undefined
for (let p = 0; p < passes + 3; p++) {
  const r = run(entry, input, { build: host, profile: true })
  if (p < 3) continue
  rec.push(r.profile!.recognizer.ms)
  cap.push(r.profile!.structuralCapture.ms)
  hos.push(r.profile!.hostConstruction.ms)
  counts = {
    nodes: r.profile!.hostConstruction.nodes,
    childSlots: r.profile!.hostConstruction.childSlots,
    rawSlots: r.profile!.hostConstruction.rawSlots,
    triviaSlots: r.profile!.hostConstruction.triviaSlots,
  }
}
const mRec = median(rec), mCap = median(cap), mHos = median(hos)

console.log(`\n== jess alloc model: ${decls} decls, input ${(input.length / 1024).toFixed(1)} KB, ${counts!.nodes} nodes ==`)
console.log(`slots: children=${counts!.childSlots} raw=${counts!.rawSlots} trivia=${counts!.triviaSlots}`)
console.log(`phase medians (ms), ${passes} passes:`)
console.log(`  recognizer         ${mRec.toFixed(3)}`)
console.log(`  + structuralCapture ${mCap.toFixed(3)}   (CST arrays cost = ${(mCap - mRec).toFixed(3)}, ${(100 * (mCap - mRec) / mHos).toFixed(1)}% of full)`)
console.log(`  + hostConstruction  ${mHos.toFixed(3)}   (AST+span cost   = ${(mHos - mCap).toFixed(3)}, ${(100 * (mHos - mCap) / mHos).toFixed(1)}% of full)`)

// ---- GC + heap over a full-output batch (uses compiled.parse w/ default host? no: use entry+host via run) ----
let scavenges = 0, gcPauseMs = 0
const obs = new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    // kind 1 = scavenge (young gen), 2 = mark-sweep-compact, 8 = incremental, 16 = weakcb
    // @ts-expect-error node perf entry detail
    const kind = e.detail?.kind
    if (kind === 1) scavenges++
    gcPauseMs += e.duration
  }
})
obs.observe({ entryTypes: ['gc'] })

const BATCH = 40
const gc = (globalThis as { gc?: () => void }).gc
if (gc) gc()
const heapBefore = process.memoryUsage().heapUsed
const t0 = performance.now()
for (let i = 0; i < BATCH; i++) {
  const r = compiled.parseWithContext(input, { trackLines: false, build: host, captureTrivia: true } as never, 0)
  if (!r.ok) throw new Error('batch parse failed')
}
const wall = performance.now() - t0
const heapAfter = process.memoryUsage().heapUsed
obs.disconnect()

console.log(`\nfull-output batch x${BATCH}: wall ${(wall / BATCH).toFixed(3)} ms/parse`)
console.log(`  young-gen scavenges: ${scavenges}  (${(scavenges / BATCH).toFixed(2)}/parse)`)
console.log(`  gc pause total: ${gcPauseMs.toFixed(1)} ms`)
console.log(`  heapUsed delta over batch: ${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MB`)
