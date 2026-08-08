/**
 * CHOICE GATING IN THE TABLE, for ONE dialect — STATIC, no timing.
 *
 * Step 1 of the speculation-mass lane. The question: how many `choice()` sites
 * in the encoded table carry NO first-char dispatch at all, so that every arm is
 * entered unconditionally at every position the choice is reached?
 *
 * WHY `open.length` IS THE WRONG STATISTIC. `ResolvedDispatch.open` is
 * documented as "arms with no gate at all" (program.ts:239) and is built from
 * class index `< 0` (program.ts:302). But `encode.ts:368-376` pushes a dispatch
 * table ONLY when `classes.every(c => c >= 0)`, so no entry of `prog.disp` ever
 * holds a negative class and `open` is ALWAYS EMPTY on the choice path. The
 * partial-gating structure `open` describes is not reachable from the encoder.
 *
 * The real statistic is `code[ip+1]` — the choice's dispatch index — where −1
 * means the whole site fell to the linear arm loop at `exec.ts:678-688`.
 *
 * THE ASYMMETRY THIS MEASURES. Codegen gates PER ARM: `emitFirstMatch` emits an
 * arm's own first-char guard, which is sound whatever the other arms do. The
 * table's dispatch is ALL-OR-NOTHING and demands three global preconditions at
 * once (`encode.ts:368-376`): no arm nullable, ALL arms pairwise disjoint, ALL
 * arms mapping to a real char class. Any single failure ungates every arm of
 * the site. So this reports, per dialect, what fraction of choice sites and
 * choice arms the table cannot gate but codegen can.
 *
 * One dialect per process — `composeLeaf()`'s fuse mutates shared pieces in
 * place (`grammars.ts` header).
 *
 * Usage: `node --experimental-strip-types bench/jess/table-gating-one.ts less`
 */
import { encodeTable } from '../../src/table/encode.ts'
import { reachableIps } from '../../src/table/inspect.ts'
import { OP_CHOICE } from '../../src/table/ops.ts'
import { assertParseman, loadGrammar, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect
if (dialect === undefined) throw new Error('usage: table-gating-one.ts <dialect>')

const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const code = prog.code

let sites = 0
let gated = 0
let ungated = 0
let armsGated = 0
let armsUngated = 0
const ungatedByArity = new Map<number, number>()

for (const ip of reachableIps(prog)) {
  if (code[ip] !== OP_CHOICE) continue
  const d = code[ip + 1]!
  const n = code[ip + 2]!
  sites++
  if (d >= 0) { gated++; armsGated += n }
  else {
    ungated++
    armsUngated += n
    ungatedByArity.set(n, (ungatedByArity.get(n) ?? 0) + 1)
  }
}

const pct = (a: number, b: number): string => b === 0 ? '—' : `${(100 * a / b).toFixed(1)}%`

console.log(`parseman: ${prov.root} @ ${prov.version} (installed ${prov.installed})`)
console.log(`dialect:  ${dialect} (ast)`)
console.log(`choice sites (reachable): ${sites}`)
console.log(`  dispatched (d >= 0):    ${gated} (${pct(gated, sites)})  arms ${armsGated}`)
console.log(`  UNGATED    (d === -1):  ${ungated} (${pct(ungated, sites)})  arms ${armsUngated} (${pct(armsUngated, armsGated + armsUngated)} of all arms)`)
console.log('ungated sites by arm count:')
for (const k of [...ungatedByArity.keys()].sort((a, b) => a - b)) {
  console.log(`  ${String(k).padStart(3)} arms: ${ungatedByArity.get(k)} sites`)
}
