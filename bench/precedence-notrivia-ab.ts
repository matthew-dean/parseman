/**
 * Does the level-collapse help at all when trivia is OFF? Stacks N leftAssoc
 * levels vs N precedence levels over a bare ident (no trivia), bare-value input.
 * If precedence is flat vs leftAssoc's ~22ns/level slope, the win is real but
 * gated by trivia; if both are equal, V8 already eats the scaffolding.
 * Run: node --import tsx/esm bench/precedence-notrivia-ab.ts
 */
import { compile, transform, sequence, many, literal, regex, precedence } from '../src/index.ts'
import type { Combinator } from '../src/index.ts'

const ident = transform(regex(/[a-z][a-z0-9]*/), (s) => ({ type: 'id', name: s }))
const OPCHARS = '*/+-<>=!&|%^~?:@#'.split('')

function leftAssoc(base: Combinator<unknown>, op: Combinator<string>): Combinator<unknown> {
  return transform(sequence(base, many(sequence(op, base))), ([left, rest]: any) => {
    let node = left; for (const [o, r] of rest) node = { type: 'binary', op: o, left: node, right: r }; return node
  })
}
function buildLA(n: number): Combinator<unknown> {
  let lvl: Combinator<unknown> = ident
  for (let i = 0; i < n; i++) lvl = leftAssoc(lvl, literal(OPCHARS[i % OPCHARS.length]) as Combinator<string>)
  return lvl
}
function buildPR(n: number): Combinator<unknown> {
  const rows = Array.from({ length: n }, (_, i) => [OPCHARS[i % OPCHARS.length]!])
  return precedence(ident as Combinator<unknown>, rows)
}

const INPUT = 'x'
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

console.log('=== no-trivia, bare `x`, ns/parse ===')
for (const d of [6, 12, 24]) {
  const la = compile(buildLA(d)), pr = compile(buildPR(d))
  const nLA = bench(() => { la.parse(INPUT, 0) }, 1_000_000)
  const nPR = bench(() => { pr.parse(INPUT, 0) }, 1_000_000)
  console.log(`depth ${String(d).padStart(2)}: leftAssoc ${nLA.toFixed(1)}ns  precedence ${nPR.toFixed(1)}ns  → ${(nLA / nPR).toFixed(2)}x`)
}
