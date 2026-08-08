/**
 * The arithmetic half of `capoff-alloc.ts`: turn `--trace-gc` lines into bytes
 * allocated per parse.
 *
 * A `--trace-gc` line reads `... Scavenge 8.1 (10.3) -> 2.5 (10.3) MB ...`. The
 * heap was `after` at the end of one collection and `before` at the start of the
 * next, so `before(i) - after(i-1)` is what the program allocated in between.
 * Summing that over the marked window and dividing by the parse count is the
 * allocation figure — churn included, which is the whole point, since a heap
 * profile would report only the fraction that survived.
 *
 * Lines OUTSIDE the `@@MARK`/`@@END` window are dropped: compilation and warmup
 * allocate heavily and once.
 *
 *   node bench/jess/capoff-alloc-read.mjs < trace.err
 */
import { createInterface } from 'node:readline'

const GC = /\bMark-Compact|Scavenge|Mark-Sweep/
const NUM = /([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB/

let armed = false
let parses = 0
let meta = ''
let tail = ''
let prevAfter = null
let total = 0
let events = 0
let compacts = 0

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (line.startsWith('@@MARK')) { armed = true; meta = line.slice(7).trim(); prevAfter = null; continue }
  if (line.startsWith('@@END')) {
    armed = false
    tail = line.slice(6).trim()
    parses = Number(/parses=(\d+)/.exec(tail)?.[1] ?? 0)
    continue
  }
  if (!armed || !GC.test(line)) continue
  const m = NUM.exec(line)
  if (!m) continue
  const before = Number(m[1]) * 1024 * 1024
  const after = Number(m[3]) * 1024 * 1024
  if (/Mark-Compact|Mark-Sweep/.test(line)) compacts++
  if (prevAfter !== null) {
    const d = before - prevAfter
    // A NEGATIVE delta is not allocation. It happens when a major collection
    // reports a smaller `before` than the previous minor's `after` (different
    // spaces in the same counter), and adding it would UNDERCOUNT. Dropped, and
    // counted, so the drop is visible rather than silent.
    if (d > 0) { total += d; events++ }
  }
  prevAfter = after
}

const perParse = parses > 0 ? total / parses : 0
console.log(JSON.stringify({
  meta,
  tail,
  gcIntervals: events,
  majorCollections: compacts,
  totalBytes: Math.round(total),
  parses,
  bytesPerParse: Math.round(perParse),
  mbPerParse: +(perParse / 1024 / 1024).toFixed(2),
}, null, 2))
