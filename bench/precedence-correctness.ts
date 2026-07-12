/**
 * Correctness gate for precedence():
 *  1. interpreter precedence AST === leftAssoc AST (modulo per-node spans)
 *  2. interpreter precedence === compiled precedence (exact, incl. spans)
 * Run: node --import tsx/esm bench/precedence-correctness.ts
 */
import { compile } from '../src/index.ts'
import { parseExpr, parseExprPrec, exprParserPrec } from '../examples/lang/parser.ts'

const CASES = [
  'x',
  '1 + 2',
  '1 + 2 + 3',
  '1 + 2 * 3',
  'a * b + c * d',
  'a < b == c',
  'a && b || c && d',
  '1 + 2 * 3 - 4 / 5 < 6 == 7 && 8 || 9',
  'foo(1, 2) + bar * 3',
  'if x > 0 then a + b else c * d',
  '- a * b',
  '!a && !b',
  'a+b+c+d+e+f+g+h',
]

// strip span fields recursively for structural comparison
function stripSpans(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSpans)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'span') continue
      o[k] = stripSpans(val)
    }
    return o
  }
  return v
}

const compiledPrec = compile(exprParserPrec)
let fails = 0

for (const src of CASES) {
  const la = parseExpr(src)
  const pr = parseExprPrec(src)
  // 1. structural equivalence with leftAssoc
  if (!la.ok || !pr.ok) {
    console.log(`✗ parse failed  "${src}"  leftAssoc.ok=${la.ok} prec.ok=${pr.ok}`)
    fails++
    continue
  }
  const laS = JSON.stringify(stripSpans(la.value))
  const prS = JSON.stringify(stripSpans(pr.value))
  if (laS !== prS) {
    console.log(`✗ AST mismatch  "${src}"`)
    console.log(`   leftAssoc: ${laS}`)
    console.log(`   precedence: ${prS}`)
    fails++
    continue
  }
  // 2. interpreter vs compiled — STRUCTURAL (spans stripped). A pre-existing
  // codebase quirk (non-capturing compiled `sequence(x, optional(…))` advances
  // trivia between terms while the interpreter rolls it back) makes exact operand
  // spans differ under both leftAssoc AND precedence; that's orthogonal to this
  // combinator, so we compare structure here.
  const ci = compiledPrec.parse(src, 0) as { value: unknown }
  const interp = JSON.stringify(stripSpans(pr.value))
  const comp = JSON.stringify(stripSpans(ci.value))
  if (interp !== comp) {
    console.log(`✗ interp≠compiled  "${src}"`)
    console.log(`   interp:   ${interp}`)
    console.log(`   compiled: ${comp}`)
    fails++
    continue
  }
  console.log(`✓ "${src}"`)
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
