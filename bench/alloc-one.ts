/**
 * Single-variant batch for --trace-gc counting. Run in its own process:
 *   node --import tsx/esm --trace-gc bench/alloc-one.ts <base|opt> [decls] [batch]
 * Count Scavenge lines on stderr to compare young-gen allocation pressure.
 */
import { compiled, host, hostOptOut, buildInput } from './alloc-model.ts'
import type { ParseContext } from '../src/index.ts'

const variant = process.argv[2] ?? 'base'
const decls = Number(process.argv[3] ?? 1500)
const BATCH = Number(process.argv[4] ?? 60)
const input = buildInput(decls)
const h = variant === 'opt' ? hostOptOut : host

for (let i = 0; i < 8; i++) compiled.parseWithContext(input, { trackLines: false, build: h, captureTrivia: true } as unknown as ParseContext, 0)
const t0 = performance.now()
for (let i = 0; i < BATCH; i++) {
  const r = compiled.parseWithContext(input, { trackLines: false, build: h, captureTrivia: true } as unknown as ParseContext, 0)
  if (!r.ok) throw new Error('fail')
}
console.error(`WALL ${variant} ${((performance.now() - t0) / BATCH).toFixed(3)} ms/parse`)
