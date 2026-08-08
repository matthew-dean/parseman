/**
 * SHAPE LOWERING AGAINST `RegExp.exec`, ON ONE SHIPPING JESS GRAMMAR.
 *
 * `bench/scan-shape-oracle.ts` covers the four workload grammars. This is the
 * same oracle aimed at the four grammars that actually ship, and it exists
 * because they only recently began to EMIT at all: until the seven remaining
 * opcodes were lowered, every jess grammar refused emission and fell back to the
 * closure engine, so `emit-assembly.ts`'s regex lowering never ran on one. The
 * moment they emit, every regex constant in them is lowered by code no gate in
 * this repo had pointed at them.
 *
 * Method is the workload oracle's: for each distinct regex constant in the
 * encoded table, compile the emitted scan and compare it to the sticky `exec` it
 * replaces at EVERY position of the dialect's own corpus — matched or not, and
 * the exact end. A shape that agrees end-to-end because the grammar never drives
 * it to the hard position fails here.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates the shared
 * recognition pieces in place (`grammars.ts` header).
 *
 *   node --import ./bench/jess/register.mjs \
 *     bench/jess/scan-shape-oracle-one.ts <dialect> [variant]
 */
import { encodeTable } from '../../src/table/encode.ts'
import { emitShapeMatch, scanShapeFromRegex } from '../../src/table/scan-shapes.ts'
import { corpus, loadGrammar, type Dialect, type Variant, VARIANT_SETTINGS } from './grammars.ts'

const dialect = (process.argv[2] ?? 'css') as Dialect
const variant = (process.argv[3] ?? 'ast') as Variant

const { rules } = await loadGrammar(dialect, variant)
const prog = encodeTable(rules, VARIANT_SETTINGS[variant])

const seen = new Map<string, RegExp>()
for (const c of prog.k) if (c instanceof RegExp) seen.set(`${c.source}/${c.flags}`, c)

const text = corpus(dialect).map(f => f.input).join('\n')

let lowered = 0
let checks = 0
let mismatches = 0
for (const re of seen.values()) {
  const shape = scanShapeFromRegex(re.source, re.flags)
  if (shape === null) continue
  lowered++
  let n = 0
  const m = emitShapeMatch(shape, 'pos', (prefix = '_v') => `${prefix}${n++}`, '  ')
  const probe = new Function(
    'input', 'pos',
    [...m.setup, `  return (${m.ok}) ? (${m.end}) : -1`].join('\n'),
  ) as (input: string, pos: number) => number
  const sticky = new RegExp(re.source, re.flags.includes('y') ? re.flags : `${re.flags}y`)
  let bad = 0
  for (let pos = 0; pos <= text.length; pos++) {
    sticky.lastIndex = pos
    const hit = sticky.exec(text)
    const want = hit === null ? -1 : pos + hit[0].length
    checks++
    if (probe(text, pos) !== want) {
      bad++
      mismatches++
      if (bad <= 3) {
        console.log(`  MISMATCH /${re.source}/${re.flags} @${pos} want ${want} got ${probe(text, pos)} ctx=${JSON.stringify(text.slice(pos, pos + 24))}`)
      }
    }
  }
}

console.log(`${dialect}/${variant}: ${lowered}/${seen.size} regexes lowered · ${text.length} corpus bytes · ${checks} checks · ${mismatches} mismatches`)
process.exitCode = mismatches === 0 ? 0 : 1
