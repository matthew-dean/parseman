/**
 * G4 — one input grammar, ONE compiled output — measured across all four
 * dialects, before and after the variant fold.
 *
 * BEFORE is what shipped: four separately emitted modules per dialect, one per
 * `trackLines` x `hostMode` pair. Their distinctness is proven by a sha256 of
 * each emitted module, not inferred from unequal byte counts.
 *
 * AFTER is one folded module per dialect: the code stream, const pool, char
 * classes, expected sets, dispatch tables, rule index and REDUCER POOL printed
 * once, plus per variant the words that differ. The reducer pool dominates the
 * artifact and is byte-identical in all four, so it is the single largest term
 * in the saving — the code stream is the smaller share.
 *
 * Usage: `pnpm fold:jess`
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DIALECTS, VARIANTS, type Dialect } from './grammars.ts'
import type { FoldRow } from './fold-size-one.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REGISTER = resolvePath(HERE, 'register.mjs')
const ONE = resolvePath(HERE, 'fold-size-one.ts')

function rowOf(dialect: Dialect): FoldRow & { parseman: { version: string; root: string } } {
  const out = execFileSync(process.execPath, ['--import', REGISTER, ONE, dialect], {
    encoding: 'utf8', maxBuffer: 1 << 28,
  })
  return JSON.parse(out.trim().split('\n').at(-1)!) as FoldRow & { parseman: { version: string; root: string } }
}

function pct(before: number, after: number): string {
  return `${(((before - after) / before) * 100).toFixed(1)}% smaller`
}

function main(): void {
  const rows = DIALECTS.map(rowOf)
  console.log(`parseman ${rows[0]!.parseman.version}   ${rows[0]!.parseman.root}`)
  console.log('')
  console.log('=== BEFORE: four separately emitted modules per dialect')
  console.log('    dialect  variant       raw B      gzip B    sha256(module)')
  for (const r of rows) {
    for (const v of VARIANTS) {
      console.log(`    ${r.dialect.padEnd(8)} ${v.padEnd(12)} ${String(r.before[v][0]).padStart(9)}  ${String(r.before[v][1]).padStart(9)}    ${r.beforeHash[v]}`)
    }
  }
  const distinct = rows.every(r => new Set(VARIANTS.map(v => r.beforeHash[v])).size === 4)
  console.log('')
  console.log(`    all four variants DISTINCT in every dialect: ${distinct ? 'yes — 4 tables, not 2' : 'NO'}`)
  console.log('')
  console.log('=== AFTER: one folded module per dialect')
  console.log('    dialect     rules  words   before raw    after raw       before gzip   after gzip')
  let bR = 0, bG = 0, aR = 0, aG = 0
  for (const r of rows) {
    bR += r.beforeTotal[0]; bG += r.beforeTotal[1]; aR += r.after[0]; aG += r.after[1]
    console.log(
      `    ${r.dialect.padEnd(8)} ${String(r.rules).padStart(6)} ${String(r.words).padStart(6)}`
      + `  ${String(r.beforeTotal[0]).padStart(9)}  ${String(r.after[0]).padStart(9)}`
      + `    ${String(r.beforeTotal[1]).padStart(9)}  ${String(r.after[1]).padStart(9)}   ${pct(r.beforeTotal[0], r.after[0])}`,
    )
  }
  console.log('')
  console.log(`    ALL FOUR DIALECTS  raw ${bR} -> ${aR} B  (${pct(bR, aR)}, ${(bR / 1e6).toFixed(2)} MB -> ${(aR / 1e6).toFixed(2)} MB)`)
  console.log(`                       gzip ${bG} -> ${aG} B  (${pct(bG, aG)})`)
  console.log('')
  console.log('=== THE DELTA each variant carries, in code words')
  console.log(`    dialect  words   ${VARIANTS.map(v => v.padEnd(10)).join('')}`)
  for (const r of rows) {
    console.log(`    ${r.dialect.padEnd(8)} ${String(r.words).padStart(5)}   ${VARIANTS.map(v => String(r.deltaWords[v]).padEnd(10)).join('')}`)
  }
  console.log('')
  console.log('    trackLines swaps OPCODE words for their *_TRACK twins; hostMode:cst sets')
  console.log('    capture bits in one NODE operand. The two are disjoint and compose, which')
  console.log('    is why the cst-lines column is the sum of the other two.')
}

main()
