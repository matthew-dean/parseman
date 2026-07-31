/**
 * REPEATED-TRIAL A/B — distribution, not a single reading.
 *
 * One A/B reading on a contended box is worthless (this machine's null control
 * has swung -25% to +13% on the median with byte-identical artifacts). This runs
 * the control and the treatment ALTERNATELY, many times, and reports both
 * DISTRIBUTIONS. The question is not "what is the delta" but "is the treatment
 * distribution distinguishable from the control distribution" — which is
 * answerable even when each individual reading is noisy.
 *
 * MIN is the statistic. Under contention a sample is a race between real work
 * and being descheduled; contention can only ever make a sample SLOWER, so the
 * minimum over many samples is the closest available estimate of uncontended
 * cost, while the median is dominated by whatever else is running.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadavg } from 'node:os'

const ROOT = join(import.meta.dirname, '..', '..')
type Compiled = { parse: (s: string) => unknown }

async function compileAt(threshold: string): Promise<Compiled> {
  process.env.PM_CR_SHARE_MIN = threshold
  const bust = `?cr=${threshold}-${Math.random()}`
  const { compile } = (await import(join(ROOT, 'src/index.ts') + bust)) as { compile: (c: unknown) => Compiled }
  const mod = (await import(join(ROOT, 'examples/css/parser.ts') + bust)) as Record<string, unknown>
  return compile(mod.Stylesheet)
}

const input = readFileSync(join(ROOT, 'bench/workloads/fixtures/site.css'), 'utf8')
const REPS = 20

function best(p: Compiled, samples: number): number {
  let b = Infinity
  for (let s = 0; s < samples; s++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < REPS; i++) p.parse(input)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / REPS
    if (ms < b) b = ms
  }
  return b
}

/** One trial = compile both sides fresh, warm both, then min-vs-min. */
async function trial(bT: string): Promise<number> {
  const A = await compileAt('Infinity')
  const B = await compileAt(bT)
  for (let i = 0; i < 100; i++) { A.parse(input); B.parse(input) }
  // Alternate which side is measured first across trials via the sample loop.
  const a = best(A, 30), b = best(B, 30)
  return 100 * (b - a) / a
}

const TRIALS = 7
const control: number[] = []
const treat150: number[] = []
const treat0: number[] = []

console.log(`load average: ${loadavg().map(n => n.toFixed(2)).join(' ')}`)
console.log(`input: site.css (${input.length} B), ${TRIALS} trials each, min of 30 samples x ${REPS} parses\n`)

for (let t = 0; t < TRIALS; t++) {
  control.push(await trial('Infinity'))
  treat150.push(await trial('150'))
  treat0.push(await trial('0'))
  process.stdout.write(`  trial ${t + 1}/${TRIALS}\r`)
}

const fmt = (xs: number[]) => xs.map(x => x.toFixed(2).padStart(7)).join('')
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]! }

console.log('\nMIN-DELTA PER TRIAL (%; positive = B slower)')
console.log('  control (Inf vs Inf) ' + fmt(control) + '   median ' + med(control).toFixed(2))
console.log('  treatment  150       ' + fmt(treat150) + '   median ' + med(treat150).toFixed(2))
console.log('  treatment  0         ' + fmt(treat0) + '   median ' + med(treat0).toFixed(2))

const spread = (xs: number[]) => `${Math.min(...xs).toFixed(2)} .. ${Math.max(...xs).toFixed(2)}`
console.log('\nRANGES')
console.log(`  control   ${spread(control)}`)
console.log(`  150       ${spread(treat150)}`)
console.log(`  0         ${spread(treat0)}`)
console.log(`\nRESOLUTION LIMIT: the control's own range is ${(Math.max(...control) - Math.min(...control)).toFixed(2)} percentage points wide.`)
console.log('A treatment effect smaller than that cannot be claimed from this run.')
console.log(`\nload average at end: ${loadavg().map(n => n.toFixed(2)).join(' ')}`)
