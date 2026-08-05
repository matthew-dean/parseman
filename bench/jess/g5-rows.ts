/**
 * Rows executed for the NAMED fixture alone (`benchmark.less`), plus program size.
 * Requires `PM_TABLE_COUNT=1`. Measures no time.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { encodeTable } from '../../src/table/encode.ts'
import { resetTableCounters, tableCounters, tableRules } from '../../src/table/exec.ts'
import { run } from '../../src/functional/run.ts'
import { ENTRY, JESS_ROOT, loadGrammar } from './grammars.ts'

type Entry = Parameters<typeof run>[0]

const input = readFileSync(resolvePath(JESS_ROOT, 'packages/jess/benchmark/benchmark.less'), 'utf8')
const g = await loadGrammar('less', 'ast')
const prog = encodeTable(g.rules, {})
const entry = tableRules(prog)[ENTRY]! as unknown as Entry
resetTableCounters()
run(entry, input)
console.log(JSON.stringify({
  bytes: input.length,
  rows: tableCounters.rows,
  words: prog.code.length,
  rules: Object.keys(prog.rules).length,
}))
