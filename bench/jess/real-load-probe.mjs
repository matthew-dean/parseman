// One fresh-process load measurement for `bench/jess-grammar-load-guard.ts`.
//   node real-load-probe.mjs <bundle.mjs> <cst|ast> <compile?>
// Prints JSON: import, first parse (CST host), and optionally compile() of the
// grammar map plus a parse through it — each in milliseconds.
import { performance } from 'node:perf_hooks'

const [bundle, mode, compileToo] = process.argv.slice(2)
const INPUT = '.a { color: red; }\n.b .c > d { margin: 0 auto; }\n'
const t0 = performance.now()
const mod = await import(bundle)
const t1 = performance.now()
const out = { import: t1 - t0 }
if (mode === 'cst') {
  const r = mod.run(mod.grammar.Stylesheet, INPUT, { build: mod.cstBuildHost })
  out.firstParse = performance.now() - t1
  out.ok = r.ok && r.unconsumedFrom === null
}
if (compileToo === 'compile') {
  const t2 = performance.now()
  const table = mod.compile(mod.grammar)
  const t3 = performance.now()
  const r = mod.run(table.Stylesheet, INPUT, { build: mod.cstBuildHost })
  out.compile = t3 - t2
  out.compiledFirstParse = performance.now() - t3
  out.compiledOk = r.ok && r.unconsumedFrom === null
}
process.stdout.write(JSON.stringify(out))
