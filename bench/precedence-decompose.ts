/**
 * Decompose the ~22 ns/level cost to predict whether a `chainl1` emitter can
 * capture it. Measures per-level slope for three nested shapes over a bare id:
 *
 *   A. transform-only wrapper:  transform(base, x=>x)          — irreducible
 *      per-level cost of a value passing through a node the compiler doesn't
 *      elide. chainl1 is ALSO a per-level value wrapper, so it pays >= this.
 *   B. seq+empty-many (no transform): sequence(base, many(seq(op,base)))
 *      — the scaffolding chainl1 REMOVES (tuple + array + inner seq), minus fold.
 *   C. full leftAssoc (transform + seq + many)                 — the baseline.
 *
 * If A (floor chainl1 can't beat) is close to C, chainl1 wins little.
 * If A << C, the gap (B/C scaffolding) is chainl1's headroom.
 *
 * Run: node --import tsx/esm bench/precedence-decompose.ts
 */
import { compile, transform, sequence, many, literal, regex } from '../src/index.ts'
import type { Combinator } from '../src/index.ts'

const ident = transform(regex(/[a-z][a-z0-9]*/), (s) => ({ type: 'id', name: s }))
const OPCHARS = '*/+-<>=!&|%^~?:@#'.split('')
const INPUT = 'x'

function stackTransform(n: number): Combinator<unknown> {
  let lvl: Combinator<unknown> = ident
  for (let i = 0; i < n; i++) lvl = transform(lvl, (x: any) => x)
  return lvl
}
function stackSeqMany(n: number): Combinator<unknown> {
  let lvl: Combinator<unknown> = ident
  for (let i = 0; i < n; i++) {
    lvl = sequence(lvl, many(sequence(literal(OPCHARS[i % OPCHARS.length]), lvl))) as any
  }
  return lvl
}
function stackLeftAssoc(n: number): Combinator<unknown> {
  let lvl: Combinator<unknown> = ident
  for (let i = 0; i < n; i++) {
    lvl = transform(
      sequence(lvl, many(sequence(literal(OPCHARS[i % OPCHARS.length]), lvl))),
      ([left, rest]: any) => { let node = left; for (const [op, r] of rest) node = { op, left: node, right: r }; return node },
    )
  }
  return lvl
}

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

function slope(build: (n: number) => Combinator<unknown>, label: string) {
  const lo = 2, hi = 24
  const cLo = compile(build(lo)), cHi = compile(build(hi))
  const nLo = bench(() => { cLo.parse(INPUT, 0) }, 1_000_000)
  const nHi = bench(() => { cHi.parse(INPUT, 0) }, 1_000_000)
  const s = (nHi - nLo) / (hi - lo)
  console.log(`${label.padEnd(22)} depth${lo}=${nLo.toFixed(1)}  depth${hi}=${nHi.toFixed(1)}  => ${s.toFixed(2)} ns/level`)
  return s
}

console.log('=== per-level slope by shape (bare `x`, compiled) ===')
const a = slope(stackTransform, 'A transform-only')
const b = slope(stackSeqMany, 'B seq+many (no xf)')
const c = slope(stackLeftAssoc, 'C full leftAssoc')
console.log(`\nfloor chainl1 can't beat (A): ${a.toFixed(1)} ns/level`)
console.log(`scaffolding headroom (C - A): ${(c - a).toFixed(1)} ns/level`)
console.log(`=> best case chainl1 on 6 levels: save ~${((c - a) * 6).toFixed(0)} ns of ~${(c * 6).toFixed(0)} ns descent`)
