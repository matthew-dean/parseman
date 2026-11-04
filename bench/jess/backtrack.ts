/**
 * BACKTRACKING IN JESS'S FOUR GRAMMARS, per dialect and engine, over each dialect's
 * fixture corpus (`grammars.ts` `corpus`). The baseline a grammar change must not
 * raise and the removal work drives to zero.
 *
 * One process per dialect: the grammars' fuse mutates shared recognition pieces in
 * place, so only one dialect may be realised per process.
 *
 *   JESS_ROOT=<jess checkout> node --import ./bench/jess/register.mjs \
 *     bench/jess/backtrack.ts <css|less|scss|jess> [interpreter|closure|emitted ...]
 *
 * `emitted` loads its assembly from a module this harness writes (`bench/emitted-assembly.ts`).
 *
 * Prints one JSON line per engine: the totals, the files the probe measured, and the
 * files it could not (a parse that throws, or whose probed result differs from the
 * plain one — those are named, never dropped). `PM_BT_TOP=<n>` adds the n files with
 * the most rewinds.
 */
import { backtrackProbe, backtrackProbeAssembled, type BacktrackProbe } from '../../src/analysis/backtrack.ts'
import { probeCfg, zeroCounts, type BacktrackCounts } from '../../src/table/backtrack-probe.ts'
import { withEmittedAssembly } from '../emitted-assembly.ts'
import { assertParseman, corpus, corpusTotal, headSha, loadGrammar, JESS_ROOT, ENTRY, DIALECTS, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect
if (!DIALECTS.includes(dialect)) throw new Error(`usage: backtrack.ts <${DIALECTS.join('|')}> [engine ...]`)
const ENGINES = ['interpreter', 'closure', 'emitted'] as const
const engines = (process.argv.length > 3 ? process.argv.slice(3) : ['closure']) as Array<typeof ENGINES[number]>
for (const e of engines) if (!ENGINES.includes(e)) throw new Error(`unknown engine ${e}; one of ${ENGINES.join(', ')}`)
const top = Number(process.env.PM_BT_TOP ?? 0)

const pm = await assertParseman()
const { rules } = await loadGrammar(dialect)
const files = corpus(dialect)

for (const engine of engines) {
  // The emitted engine comes from a build-time module, as a macro build ships it.
  const probe: BacktrackProbe = engine === 'emitted'
    ? await backtrackProbeAssembled(rules, p => withEmittedAssembly(p, probeCfg(p)))
    : backtrackProbe(rules, engine)
  const total: BacktrackCounts = zeroCounts()
  const failed: Array<{ file: string; error: string }> = []
  const perFile: Array<{ file: string; rewinds: number; bytesReread: number }> = []
  let bytes = 0
  for (const f of files) {
    try {
      // Jess reducers read the authored bytes from the parse state.
      const { counts } = probe.measure(ENTRY, f.input, { state: { source: f.input } })
      for (const k of Object.keys(total) as (keyof BacktrackCounts)[]) total[k] += counts[k]
      bytes += f.input.length
      perFile.push({ file: f.name, rewinds: counts.rewinds, bytesReread: counts.bytesReread })
    } catch (e) {
      failed.push({ file: f.name, error: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200) })
    }
  }
  perFile.sort((a, b) => b.rewinds - a.rewinds)
  console.log(JSON.stringify({
    dialect, engine: probe.engine, parseman: `${pm.version} ${headSha()} ${pm.root}`, jess: JESS_ROOT,
    files: perFile.length, corpusTotal: corpusTotal(dialect), bytes, ...total,
    failed: failed.length, failures: failed.slice(0, 10),
    ...(top > 0 ? { top: perFile.slice(0, top) } : {}),
  }))
}
