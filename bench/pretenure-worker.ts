/**
 * One gate case in a process of its own, for `bench/pretenure-check.ts`: N parses,
 * then the number of mark-compacts the process ran. Bundled onto the built `dist/`
 * and run under plain `node`; refuses to count under a changed runtime.
 */
import { PerformanceObserver, constants } from 'node:perf_hooks'
import { buildWorkloads } from './workloads/index.ts'
import { DENSITY_CASES, caseGrammar, caseInput } from './grammar-density/grammar.ts'
import { SpanKeepingNode } from './grammar-density/tree-node.js'
import { Stylesheet } from '../examples/css/parser.ts'
import { compile, cstBuildHost, literal, many, node, regex, rules, sequence, trivia, type Combinator } from '../src/index.ts'

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
} else if (id === 'css/cst') {
  // A CST host: the tree is `cstBuildHost()`'s nodes over parseman's leaves and spans.
  const input = buildWorkloads().find(w => w.id === 'css/stylesheet')!.input
  const compiled = compile(Stylesheet, undefined, { hostMode: 'cst' })
  parse = () => compiled.parseWithContext(input, { trackLines: false, build: cstBuildHost() }, 0)
} else if (id === 'nolines/doc' || id === 'lines/doc' || id === 'spans/doc') {
  // Builder-less default nodes keep parseman's own nodes, child arrays and leaves
  // (`lines/doc` with line-tracked spans); `spans/doc` keeps the span object parseman
  // passes a builder.
  const keep = id === 'spans/doc'
  const g = rules({ trivia: trivia(regex(/[ \t\n]+/)), trackLines: id === 'lines/doc' }, (r: { Doc: Combinator<unknown>; Item: Combinator<unknown> }) => ({
    Doc: keep
      ? node('Doc', many(r.Item), (kids: readonly unknown[], _f: unknown, span: { start: number; end: number }) => new SpanKeepingNode('Doc', span, [...kids]))
      : node('Doc', many(r.Item)),
    Item: keep
      ? node('Item', sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/), literal(';')), (kids: readonly unknown[], _f: unknown, span: { start: number; end: number }) => new SpanKeepingNode('Item', span, [...kids]))
      : node('Item', sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/), literal(';'))),
  }))
  const compiled = compile(g.Doc)
  const input = Array.from({ length: 3000 }, (_, i) => `k${String.fromCharCode(97 + (i % 26))}: ${i};`).join('\n')
  parse = () => compiled.parseWithContext(input, { trackLines: false }, 0)
} else {
  const w = buildWorkloads().find(x => x.id === id)
  if (w === undefined) throw new Error(`no case ${String(id)}`)
  const built = w.make()
  parse = () => built.parse()
}

if (id === 'lines/doc') {
  const doc = (parse() as { value?: { span?: { startLine?: number } } }).value
  if (doc?.span?.startLine === undefined) throw new Error('pretenure-worker: lines/doc produced no line-annotated spans')
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
