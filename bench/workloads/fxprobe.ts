/**
 * Diagnostic: how wide are the expected-sets this grammar actually BUILDS AT RUN
 * TIME?
 *
 * Not the width of the derived constants — most of those are dead. What costs is
 * the concatenation a choice performs when it loses EVERY arm: `_ctx._fx =
 * [...arm0, ...arm1, …]`. So the number that matters is, per concat site, the
 * summed width of the constants its arm snapshots can hold.
 *
 * Used to check that a workload is genuinely EXPOSED to an expected-set
 * regression before trusting a flat reading from it. A workload that reads flat
 * because it is fast is a result; a workload that reads flat because the code
 * under test is unreachable from it is a hole in the gate.
 */
process.env.PARSEMAN_GATING = 'off'
import path from 'node:path'

const dir = path.resolve(process.argv[2]!)
const which = process.argv[3] ?? 'less'
const pm = await import(path.join(dir, 'src', 'index.ts')) as { compile: (c: unknown) => { source: string } }
const g = await import(path.join(dir, 'bench', 'workloads', `${which}.ts`)) as { Stylesheet: unknown }

const src = pm.compile(g.Stylesheet).source

const fxWidth = new Map<string, number>()
for (const m of src.matchAll(/const (_fx\d+) = (\[[^\n]*\])/g)) {
  try { fxWidth.set(m[1]!, (JSON.parse(m[2]!) as unknown[]).length) } catch { /* not a plain array literal */ }
}

/** Every `_cfxN = _fxK` assignment: what an arm snapshot can hold. */
const cfxWidth = new Map<string, number>()
for (const m of src.matchAll(/(_cfx\d+) = (_fx\d+)/g)) {
  const w = fxWidth.get(m[2]!) ?? 0
  cfxWidth.set(m[1]!, Math.max(cfxWidth.get(m[1]!) ?? 0, w))
}

const siteTotals: number[] = []
for (const m of src.matchAll(/_ctx\._fx = \[([^\n]*?)\]; break/g)) {
  const arms = [...m[1]!.matchAll(/(_cfx\d+)/g)].map(a => cfxWidth.get(a[1]!) ?? 0)
  siteTotals.push(arms.reduce((a, b) => a + b, 0))
}
siteTotals.sort((a, b) => b - a)

console.log(
  `${dir.split('/').pop()} / ${which}: `
  + `${siteTotals.length} concat sites, widest ${siteTotals[0] ?? 0}, `
  + `total reachable ${siteTotals.reduce((a, b) => a + b, 0)}, `
  + `top ${siteTotals.slice(0, 6).join(',')}`,
)
