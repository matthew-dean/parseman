/**
 * TEMPORARY investigation harness. Same as `floorprobe.ts`, but optionally warms
 * and interleaves EVERY workload on the side under test before timing the target
 * one — the condition `workload-perf-guard.ts` actually measures under.
 *
 * The table engine's pieces are minted from a fixed set of FunctionLiterals in
 * `assemble.ts`, SHARED by every grammar compiled in the process; the reference's
 * generated source is per-grammar. So "five grammars in one process" is not a
 * neutral detail for one side and not the other, and this measures whether it
 * costs anything.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialise } from './ab-harness.ts'
import type { Workload } from './workloads/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const COPY = ['bench/workloads', 'examples'] as const
const arg = (f: string): string | null =>
  process.argv.find(a => a.startsWith(`${f}=`))?.slice(f.length + 1) ?? null

const SIDE = arg('--side') ?? 'head'
const WL = arg('--wl') ?? 'json/document'
const N = Number(arg('--n') ?? '400')
const SHARED = process.argv.includes('--shared')

const dir = materialise('workload-perf-guard', ROOT, SIDE === 'ref' ? 'a5dc9bd' : null, COPY)
const mod = await import(path.join(dir, 'bench', 'workloads', 'index.ts')) as {
  buildWorkloads: () => Workload[]
}
const all = mod.buildWorkloads()
const target = all.find(x => x.id === WL)!

const WITH = arg('--with')
const others = WITH !== null
  ? all.filter(w => w.id.includes(WITH) && w.id !== WL).map(w => w.make())
  : SHARED ? all.filter(w => w.id !== WL).map(w => w.make()) : []
const built = target.make()

for (let i = 0; i < 20; i++) {
  built.parse()
  for (const o of others) o.parse()
}
const t0 = process.hrtime.bigint()
for (let i = 0; i < N; i++) built.parse()
const t1 = process.hrtime.bigint()
const ms = Number(t1 - t0) / 1e6
console.log(
  `FLOORSHARE side=${SIDE} wl=${WL} shared=${SHARED} n=${N}`
  + ` per=${(ms / N).toFixed(3)}ms`,
)
