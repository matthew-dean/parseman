/**
 * Decisive REAL-compiled-path experiment for #7.
 * Stack N leftAssoc levels over a bare identifier, compile each depth, and
 * measure per-parse time on operator-free input. The SLOPE (ns per added level)
 * is the per-level no-op-descent cost on the actual compiled path — exactly what
 * a `chainl1` emitter could remove. Steep slope → build it. Flat → park it.
 *
 * Run: node --import tsx/esm bench/precedence-depth.ts
 */
import { compile, transform, sequence, many, choice, literal, regex } from '../src/index.ts'
import type { Combinator } from '../src/index.ts'

// mirror examples/lang/parser.ts leftAssoc exactly
function leftAssoc(base: Combinator<unknown>, opParser: Combinator<string>): Combinator<unknown> {
  return transform(
    sequence(base, many(sequence(opParser, base))),
    ([left, rest]: any) => {
      let node = left
      for (const [op, right] of rest) node = { type: 'binary', op, left: node, right }
      return node
    },
  )
}

const ident = transform(regex(/[a-z][a-z0-9]*/), (s) => ({ type: 'id', name: s }))
// distinct single-char ops per level so first-sets are disjoint, like the real chain
const OPCHARS = '*/+-<>=!&|%^~?:@#'.split('')

function buildDepth(n: number): Combinator<unknown> {
  let level: Combinator<unknown> = ident
  for (let i = 0; i < n; i++) {
    level = leftAssoc(level, literal(OPCHARS[i % OPCHARS.length]) as Combinator<string>)
  }
  return level
}

const INPUT = 'x' // bare identifier: descends every level, zero operators

function bench(fn: () => void, iters: number): number {
  for (let i = 0; i < 200_000; i++) fn()
  const runs: number[] = []
  for (let r = 0; r < 11; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn()
    const t1 = process.hrtime.bigint()
    runs.push(Number(t1 - t0) / iters)
  }
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)]
}

console.log('=== per-level cost, real compiled path, bare `x` ===')
const depths = [1, 3, 6, 12, 24]
const results: { d: number; ns: number }[] = []
for (const d of depths) {
  const compiled = compile(buildDepth(d))
  // sanity
  const r = compiled.parse(INPUT, 0)
  const ns = bench(() => { compiled.parse(INPUT, 0) }, 1_000_000)
  results.push({ d, ns })
  console.log(`depth ${String(d).padStart(2)}: ${ns.toFixed(2)} ns/parse   ok=${(r as any).ok ?? !!r}`)
}
// linear fit slope between smallest and largest
const a = results[0], b = results[results.length - 1]
const slope = (b.ns - a.ns) / (b.d - a.d)
console.log(`\nper-level cost (slope ${a.d}->${b.d}): ${slope.toFixed(2)} ns/level`)
console.log(`=> a 6-level chain spends ~${(slope * 6).toFixed(0)} ns on no-op descent per bare value`)
