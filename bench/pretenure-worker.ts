/**
 * One gate case in a process of its own, for `bench/pretenure-check.ts`: N parses,
 * then the number of mark-compacts the process ran. Bundled onto the built `dist/`
 * and run under plain `node`; refuses to count under a changed runtime.
 */
import { PerformanceObserver, constants } from 'node:perf_hooks'
import { buildWorkloads } from './workloads/index.ts'
import { DENSITY_CASES, caseGrammar, caseInput } from './grammar-density/grammar.ts'
import { compile } from '../src/index.ts'

if (process.execArgv.length > 0 || process.env['NODE_OPTIONS'] !== undefined) {
  console.error('pretenure-worker: refusing to count under a changed runtime')
  process.exit(2)
}

const [id, parsesArg] = process.argv.slice(2)
const parses = Number(parsesArg)
let parse: () => unknown
const density = DENSITY_CASES.find(c => c.id === id)
if (density !== undefined) {
  const compiled = compile(caseGrammar(density))
  const input = caseInput(density, 200)
  parse = () => compiled.parseWithContext(input, { trackLines: false, _triviaLog: [] }, 0)
} else {
  const w = buildWorkloads().find(x => x.id === id)
  if (w === undefined) throw new Error(`no case ${String(id)}`)
  const built = w.make()
  parse = () => built.parse()
}

let markCompacts = 0
new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    const detail: unknown = 'detail' in e ? e.detail : undefined
    if (typeof detail === 'object' && detail !== null && 'kind' in detail && detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) markCompacts++
  }
}).observe({ entryTypes: ['gc'] })
for (let i = 0; i < parses; i++) parse()
// GC entries are delivered asynchronously.
await new Promise(resolve => setTimeout(resolve, 20))
console.log(JSON.stringify({ markCompacts }))
