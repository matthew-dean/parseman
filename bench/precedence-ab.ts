/**
 * A/B: leftAssoc (transform+sequence+many) vs precedence() combinator.
 * Same lang grammar, same inputs; only the operator-chain construction differs.
 * Measures BOTH the compiled path and the interpreter (the win must hit both).
 * Run: node --import tsx/esm bench/precedence-ab.ts
 */
import { compile } from '../src/index.ts'
import {
  exprParser, exprParserPrec, parseExpr, parseExprPrec,
} from '../examples/lang/parser.ts'
import { MEDIUM_EXPR } from './fixtures.ts'

const compiledLA = compile(exprParser)
const compiledPR = compile(exprParserPrec)

// operator-sparse, value-dense: 120 bare call-args, each descending all 6 levels
// with zero operators — the case the level-collapse targets.
const OPSPARSE = 'f(' + Array.from({ length: 120 }, (_, i) => `a${i}`).join(', ') + ')'

function bench(fn: () => void, iters: number): number {
  for (let i = 0; i < 50_000; i++) fn()
  const runs: number[] = []
  for (let r = 0; r < 9; r++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn()
    const t1 = process.hrtime.bigint()
    runs.push(Number(t1 - t0) / iters)
  }
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)] / 1000 // µs
}

function row(label: string, la: number, pr: number) {
  const speedup = la / pr
  console.log(
    `${label.padEnd(22)} leftAssoc ${la.toFixed(3)}µs  precedence ${pr.toFixed(3)}µs  ` +
    `${speedup >= 1 ? '→ ' + speedup.toFixed(2) + 'x faster' : '→ ' + (pr / la).toFixed(2) + 'x SLOWER'}`,
  )
}

console.log('=== COMPILED path ===')
row('opsparse (' + OPSPARSE.length + 'B)',
  bench(() => { compiledLA.parse(OPSPARSE, 0) }, 40_000),
  bench(() => { compiledPR.parse(OPSPARSE, 0) }, 40_000))
row('opmix medium (' + MEDIUM_EXPR.length + 'B)',
  bench(() => { compiledLA.parse(MEDIUM_EXPR, 0) }, 20_000),
  bench(() => { compiledPR.parse(MEDIUM_EXPR, 0) }, 20_000))

console.log('\n=== INTERPRETER path ===')
row('opsparse',
  bench(() => { parseExpr(OPSPARSE) }, 10_000),
  bench(() => { parseExprPrec(OPSPARSE) }, 10_000))
row('opmix medium',
  bench(() => { parseExpr(MEDIUM_EXPR) }, 5_000),
  bench(() => { parseExprPrec(MEDIUM_EXPR) }, 5_000))
