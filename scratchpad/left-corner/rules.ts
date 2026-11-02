import { resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { JESS_ROOT, exportName, type Dialect } from '../../bench/jess/grammars.ts'
const MODULE: Record<string, string> = { css: 'packages/syntax/css/css-parser/src/grammar.ts', less: 'packages/syntax/less/less-parser/src/grammar.ts' }
const [d, input] = process.argv.slice(2) as [Dialect, string]
const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[d]!)}`) as Record<string, Record<string, Parameters<typeof run>[0]>>
const g = mod[exportName(d, 'ast')]!
for (const [name, e] of Object.entries(g)) {
  try { const r = run(e, input); if (r.ok && r.unconsumedFrom === null) console.log(name, JSON.stringify(r.value).slice(0, 80)) } catch { /* skip */ }
}
