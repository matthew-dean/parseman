/**
 * HOT/COLD SPEED A/B — same tree, same process, one env read apart.
 * ================================================================
 *
 * The perf gates in this repo have been shown to self-breach on byte-identical
 * `src/` (0.45: `rollback/none` at +64.3%, winning 1 of 12 pairs), so a gate
 * verdict cannot currently adjudicate a small regression. This harness removes
 * every confound it can:
 *
 *   - ONE process, ONE tree, ONE build. The two sides differ only in the value
 *     `CR_SHARE_MIN` had while their artifact was generated, so there is no
 *     cross-worktree bias, no rebuild, and no machine-state drift between sides.
 *   - Artifacts are compiled up front; only PARSING is timed.
 *   - Pairs are INTERLEAVED and order-ALTERNATED (A,B then B,A), so a monotonic
 *     drift in machine load cancels rather than accruing to one side.
 *   - A NULL CONTROL (Infinity vs Infinity — two separately compiled but
 *     identical artifacts) runs through the identical path. Its spread IS the
 *     noise floor, and any effect smaller than it is unresolvable, full stop.
 *
 * Reports median delta, min delta (min is the least noise-contaminated
 * statistic) and win rate. A win rate near 50% means the difference is noise no
 * matter what the percentage says.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const HERE = import.meta.dirname
const ROOT = join(HERE, '..', '..')

type Compiled = { parse: (s: string) => unknown }

/**
 * Compile a fixture at a given threshold. `compile()` reads CR_SHARE_MIN at Ctx
 * construction, and the module-level constant is captured at import — so each
 * threshold needs a FRESH module registry. A cache-busting query string gives
 * one without a subprocess.
 */
async function compileAt(threshold: string, modPath: string, exportName: string): Promise<Compiled> {
  process.env.PM_CR_SHARE_MIN = threshold
  const bust = `?cr=${threshold}-${Math.random()}`
  const { compile } = (await import(join(ROOT, 'src', 'index.ts') + bust)) as { compile: (c: unknown) => Compiled }
  const mod = (await import(join(ROOT, modPath) + bust)) as Record<string, unknown>
  return compile(mod[exportName])
}

function timed(p: Compiled, input: string, reps: number): number {
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < reps; i++) p.parse(input)
  return Number(process.hrtime.bigint() - t0) / 1e6
}

async function run(label: string, aT: string, bT: string, modPath: string, exportName: string, input: string) {
  const A = await compileAt(aT, modPath, exportName)
  const B = await compileAt(bT, modPath, exportName)

  // Calibrate reps so one sample is ~25 ms. Longer samples than the workload
  // gate's 8 ms on purpose: under contention a sample is a race between real
  // work and being descheduled, and a longer sample raises the chance that at
  // least one lands on an uncontended slice — which is the only kind of sample
  // MIN can use.
  let reps = 1
  while (timed(A, input, reps) < 25 && reps < 1 << 20) reps *= 2

  for (let i = 0; i < 10; i++) { timed(A, input, reps); timed(B, input, reps) }

  const da: number[] = [], db: number[] = []
  const PAIRS = 60
  for (let i = 0; i < PAIRS; i++) {
    if (i % 2 === 0) { da.push(timed(A, input, reps)); db.push(timed(B, input, reps)) }
    else { db.push(timed(B, input, reps)); da.push(timed(A, input, reps)) }
  }

  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s[s.length >> 1]! }
  const pct = (b: number, a: number) => (100 * (b - a) / a)
  const wins = da.filter((_, i) => db[i]! < da[i]!).length

  console.log(
    `  ${label.padEnd(30)} median ${pct(med(db), med(da)).toFixed(2).padStart(7)}%   ` +
    `min ${pct(Math.min(...db), Math.min(...da)).toFixed(2).padStart(7)}%   ` +
    `B-wins ${wins}/${PAIRS}`,
  )
  return pct(Math.min(...db), Math.min(...da))
}

const cssInput = readFileSync(join(ROOT, 'bench', 'workloads', 'fixtures', 'site.css'), 'utf8')

console.log(`\nload average: ${(await import('node:os')).loadavg().map(n => n.toFixed(2)).join(' ')}`)
console.log(`input: site.css (${cssInput.length} B)\n`)
console.log('NULL CONTROL (identical artifacts — this spread IS the noise floor)')
const c1 = await run('Infinity vs Infinity #1', 'Infinity', 'Infinity', 'examples/css/parser.ts', 'Stylesheet', cssInput)
const c2 = await run('Infinity vs Infinity #2', 'Infinity', 'Infinity', 'examples/css/parser.ts', 'Stylesheet', cssInput)

console.log('\nTREATMENT (B = shared cold restores)')
await run('Infinity vs 250', 'Infinity', '250', 'examples/css/parser.ts', 'Stylesheet', cssInput)
await run('Infinity vs 150', 'Infinity', '150', 'examples/css/parser.ts', 'Stylesheet', cssInput)
await run('Infinity vs 0', 'Infinity', '0', 'examples/css/parser.ts', 'Stylesheet', cssInput)

console.log(`\nNOISE FLOOR (min statistic) from control: +-${Math.max(Math.abs(c1), Math.abs(c2)).toFixed(2)}%`)
console.log('Any treatment effect smaller than that is NOT RESOLVABLE by this run.')
