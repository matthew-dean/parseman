/**
 * SPECULATIVE ARM ENTRIES AT UNGATED CHOICES, for ONE dialect — counts, no time.
 *
 * Step 2 of the speculation-mass lane; `table-gating-one.ts` is the static half.
 * Requires `PM_TABLE_COUNT=1`, which arms the counters in `src/table/exec.ts`.
 * This process therefore MEASURES NO TIME and prints none.
 *
 * `ungatedFails` is the ceiling's numerator: an arm entered at a site with no
 * dispatch, which then failed. By `choice-cost.ts`'s result that the first-char
 * gate removes ATTEMPTS but not rescanned BYTES, each such entry consumed
 * nothing the winning arm will not scan again — so its whole cost is entry
 * overhead (mark, child array, recognizer call, rollback) and a per-arm gate
 * of codegen's kind removes it outright.
 *
 * Usage: PM_TABLE_COUNT=1 node … bench/jess/table-speculation-one.ts less [file]
 */
import { existsSync, readFileSync } from 'node:fs'
import { encodeTable } from '../../src/table/encode.ts'
import { resetTableCounters, tableCounters, tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { assertParseman, corpus, ENTRY, loadGrammar, type Dialect } from './grammars.ts'

if (process.env.PM_TABLE_COUNT !== '1') throw new Error('set PM_TABLE_COUNT=1')

const dialect = process.argv[2] as Dialect
const only = process.argv[3]

const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const rules = tableRules(prog)
const entry = rules[ENTRY]
if (entry === undefined) throw new Error(`${dialect}: table has no '${ENTRY}'`)

// An explicit path wins over the corpus glob: the pinned fixtures
// (`benchmark.less`, `gen-workload.less`) live outside the dialect corpus roots.
const files = only !== undefined && existsSync(only)
  ? [{ name: only, input: readFileSync(only, 'utf8') }]
  : corpus(dialect).filter(f => only === undefined || f.name.includes(only))
if (files.length === 0) throw new Error(`no corpus file matching ${only}`)

resetTableCounters()
let bytes = 0
let ok = 0
for (const f of files) {
  try { if (run(entry, f.input).ok) ok++ } catch { /* rows still executed */ }
  bytes += f.input.length
}

const c = tableCounters
const total = c.gatedEntries + c.ungatedEntries
const pct = (a: number, b: number): string => b === 0 ? '—' : `${(100 * a / b).toFixed(1)}%`

console.log(JSON.stringify({
  parsemanRoot: prov.root,
  parsemanVersion: prov.version,
  dialect,
  files: files.map(f => f.name),
  bytes,
  ok,
  rows: c.rows,
  armEntriesTotal: total,
  gatedEntries: c.gatedEntries,
  ungatedEntries: c.ungatedEntries,
  ungatedShareOfEntries: pct(c.ungatedEntries, total),
  ungatedFails: c.ungatedFails,
  ungatedFailRate: pct(c.ungatedFails, c.ungatedEntries),
  ungatedFailsPerByte: c.ungatedFails / bytes,
  ungatedFailRows: c.ungatedFailRows,
  failRowShareOfAllRows: pct(c.ungatedFailRows, c.rows),
  rowsPerByte: c.rows / bytes,
}, null, 2))
