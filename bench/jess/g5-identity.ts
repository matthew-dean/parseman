/**
 * ASSEMBLER vs INTERPRETER — full-facet digest identity over a dialect's corpus.
 *
 * The gate for the closure assembler is that it answers what `exec.ts` answers,
 * file for file, on every facet the three-way sweep compares: value, span,
 * expected set, errors. `exec.ts` is the reference here rather than codegen
 * because it is the engine being replaced — a table-vs-table comparison isolates
 * the assembler from the interpreter/codegen drift `divergence.ts` catalogues.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/g5-identity.ts [dialect]`
 */
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import { tableRules } from '../../src/table/assemble.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { corpus, ENTRY, loadGrammar, type Dialect } from './grammars.ts'

type Entry = Parameters<typeof run>[0]

const dialect = (process.argv[2] ?? 'less') as Dialect
const g = await loadGrammar(dialect, 'ast')
const prog = encodeTable(g.rules, {})
const interp = execRules(prog)[ENTRY]! as unknown as Entry
const asm = tableRules(prog)[ENTRY]! as unknown as Entry

function digest(entry: Entry, input: string): string {
  try {
    const r = run(entry, input)
    return digestValue({
      ok: r.ok,
      value: r.value,
      unconsumedFrom: r.unconsumedFrom,
      expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
    })
  } catch (e) { return `threw:${(e as Error).message.split('\n')[0] ?? ''}` }
}

const files = corpus(dialect)
let same = 0
const diffs: string[] = []
for (const f of files) {
  const a = digest(interp, f.input)
  const b = digest(asm, f.input)
  if (a === b) same++
  else if (diffs.length < 12) diffs.push(`${f.name}\n    exec:      ${a.slice(0, 200)}\n    assembled: ${b.slice(0, 200)}`)
}
console.log(`${dialect}: ${same}/${files.length} identical (exec.ts vs assemble.ts)`)
for (const d of diffs) console.log(`  DIFF ${d}`)
if (same !== files.length) process.exitCode = 1
