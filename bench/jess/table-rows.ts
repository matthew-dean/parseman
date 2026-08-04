/**
 * ROWS EXECUTED PER BYTE PARSED — the measurement that separates the three live
 * explanations for the table lowering's 2.2x-3.3x penalty on the AST path.
 *
 *   too many rows   the grammars hand the table more combinators than codegen
 *                   has to inline, and the table pays per row where codegen
 *                   pays per inlined site  ->  rows/byte tracks the penalty
 *   each row slow   the driver's opcode read, switch and shared call sites cost
 *                   more than open-coded recognition  ->  rows/byte is FLAT and
 *                   the penalty is not explained by it
 *   fixed per parse ->  the penalty tracks mean FILE SIZE, not rows
 *
 * Rows are counted, not sampled: `PM_TABLE_COUNT=1` arms a counter in the driver
 * and this process reports no timing at all, because that counter is a store on
 * the driver's hottest path.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/table-rows.ts`
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIALECTS, type Dialect } from './grammars.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const ONE = resolvePath(HERE, 'table-rows-one.ts')

type Row = {
  dialect: Dialect
  parsemanRoot: string
  parsemanVersion: string
  rules: number
  words: number
  fns: number
  files: number
  ok: number
  bytes: number
  meanFileBytes: number
  rows: number
  rowsPerByte: number
  byOp: Record<string, number>
  staticSites: Record<string, number>
  dynamicSites: Record<string, number>
}

/** The measured AST-path penalty this diagnostic is trying to attribute. */
const PENALTY: Record<Dialect, number> = { css: 229, jess: 213, less: 134, scss: 115 }

const rows: Row[] = []
for (const d of DIALECTS) {
  const out = execFileSync(process.execPath, ['--import', REGISTER, ONE, d], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, PM_MACRO: '', PM_TABLE_COUNT: '1' },
  })
  rows.push(JSON.parse(out.trim().split('\n').at(-1)!) as Row)
}

console.log(`parseman ${rows[0]!.parsemanVersion} at ${rows[0]!.parsemanRoot}`)
console.log('')
console.log('ROWS EXECUTED PER BYTE PARSED  (AST variant, whole corpus)')
console.log('')
console.log('  dialect  rules  words  words/rule   files      bytes  mean B/file       rows  rows/byte  penalty')
for (const r of rows) {
  console.log(
    `  ${r.dialect.padEnd(7)}${String(r.rules).padStart(6)}${String(r.words).padStart(7)}`
    + `${(r.words / r.rules).toFixed(1).padStart(12)}${String(r.files).padStart(8)}`
    + `${String(r.bytes).padStart(11)}${r.meanFileBytes.toFixed(0).padStart(13)}`
    + `${String(r.rows).padStart(11)}${r.rowsPerByte.toFixed(3).padStart(11)}`
    + `${(`+${PENALTY[r.dialect]}%`).padStart(9)}`,
  )
}

/** Pearson r, printed with n so a reader can see how little it rests on. */
function corr(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  return sxy / Math.sqrt(sxx * syy)
}

const pen = rows.map(r => PENALTY[r.dialect])
console.log('')
console.log(`CORRELATION WITH THE PENALTY  (n=${rows.length} — four points, so this ORDERS candidates, it does not confirm one)`)
console.log(`  rows per byte        r = ${corr(rows.map(r => r.rowsPerByte), pen).toFixed(3)}`)
console.log(`  words per rule       r = ${corr(rows.map(r => r.words / r.rules), pen).toFixed(3)}`)
console.log(`  mean file bytes      r = ${corr(rows.map(r => r.meanFileBytes), pen).toFixed(3)}`)
console.log(`  1 / mean file bytes  r = ${corr(rows.map(r => 1 / r.meanFileBytes), pen).toFixed(3)}`)

console.log('')
console.log('SHARED CALL-SITE WIDTH — distinct author functions behind ONE call site in the driver.')
console.log('V8 goes megamorphic above 4. Codegen calls each reducer from its own site, so every')
console.log('one of these is monomorphic there and none of them is here.')
const siteNames = ['SEQX fn()', 'XFORM fn()', 'LEAF fn()', 'NODE build()']
console.log(`  dialect  ${siteNames.map(s => s.padStart(14)).join('')}   (static / executed)`)
for (const r of rows) {
  console.log(`  ${r.dialect.padEnd(9)}${siteNames.map(s =>
    `${r.staticSites[s] ?? 0}/${r.dynamicSites[s] ?? 0}`.padStart(14)).join('')}`)
}

console.log('')
console.log('ROW MIX — share of executed rows, per opcode, per dialect')
const allOps = [...new Set(rows.flatMap(r => Object.keys(r.byOp)))]
  .sort((a, b) => rows.reduce((s, r) => s + (r.byOp[b] ?? 0), 0) - rows.reduce((s, r) => s + (r.byOp[a] ?? 0), 0))
console.log(`  ${'op'.padEnd(14)}${rows.map(r => r.dialect.padStart(9)).join('')}`)
for (const op of allOps) {
  const cells = rows.map(r => `${(100 * (r.byOp[op] ?? 0) / r.rows).toFixed(1)}%`.padStart(9)).join('')
  console.log(`  ${op.padEnd(14)}${cells}`)
}
