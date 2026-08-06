/**
 * TEMPORARY investigation harness — not a gate. Materialises the same two sides
 * `bench/workload-perf-guard.ts` compares, then runs ONE side, ONE workload, in
 * its own process so `--cpu-prof` / `--trace-deopt` / `--trace-gc` attribute to
 * that side alone.
 *
 *   node --import tsx/esm bench/floorprobe.ts --side=head --wl=json/document --n=200
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialise } from './ab-harness.ts'
import type { Workload } from './workloads/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GATE = 'workload-perf-guard'
const COPY = ['bench/workloads', 'examples'] as const

const arg = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null

const SIDE = arg('--side') ?? 'head'
const WL = arg('--wl') ?? 'json/document'
const N = Number(arg('--n') ?? '200')
const REF = arg('--ref') ?? 'a5dc9bd'

const dir = materialise(GATE, ROOT, SIDE === 'ref' ? REF : null, COPY)
const mod = await import(path.join(dir, 'bench', 'workloads', 'index.ts')) as {
  buildWorkloads: () => Workload[]
}
const w = mod.buildWorkloads().find(x => x.id === WL)
if (w === undefined) throw new Error(`no workload ${WL}`)
const built = w.make()

// warm
for (let i = 0; i < 20; i++) built.parse()
const t0 = process.hrtime.bigint()
for (let i = 0; i < N; i++) built.parse()
const t1 = process.hrtime.bigint()
const ms = Number(t1 - t0) / 1e6
console.log(`FLOORPROBE side=${SIDE} wl=${WL} n=${N} total=${ms.toFixed(1)}ms per=${(ms / N).toFixed(3)}ms bytes=${w.bytes}`)
