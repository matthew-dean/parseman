/**
 * Table-lowering divergence sweep over jess's REAL corpora.
 *
 * One dialect per process — `composeLeaf()`'s interpreted fuse binds the shared
 * recognition pieces IN PLACE, so a second dialect in the same process either
 * throws or, worse, runs against another dialect's bindings.
 *
 * Outcome classes, per file:
 *   identical   interpreter and table digest the same whole outcome
 *   both-reject the parse fails on both, and only the FAILURE REPORT differs
 *   wrong-tree  both succeed (or both agree on ok) and the VALUE differs — the
 *               worst class this project has, because nothing is loud
 *   table-throw the table driver threw where the interpreter returned
 *   other       anything else, including an interpreter throw
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/divergence.ts less`
 */
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { tableRules } from '../../src/table/exec.ts'
import { corpus, DIALECTS, ENTRY, loadGrammar, type Dialect } from './grammars.ts'
import type { Combinator } from '../../src/types.ts'

type RunnableLike = Parameters<typeof run>[0]

export type Outcome = 'identical' | 'both-reject' | 'wrong-tree' | 'table-throw' | 'other'

export type FileResult = {
  name: string
  outcome: Outcome
  detail?: string
}

function digestOutcome(r: ReturnType<typeof run>): { whole: string; value: string; ok: boolean } {
  return {
    whole: digestValue({
      ok: r.ok,
      value: r.value,
      unconsumedFrom: r.unconsumedFrom,
      expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
    }),
    value: digestValue({ ok: r.ok, value: r.value, unconsumedFrom: r.unconsumedFrom }),
    ok: r.ok,
  }
}

export function sweep(rules: Record<string, Combinator<unknown>>, files: readonly { name: string; input: string }[]): FileResult[] {
  const prog = encodeTable(rules, {})
  const tbl = tableRules(prog)[ENTRY]
  if (tbl === undefined) throw new Error(`table has no rule '${ENTRY}'`)
  const interp = rules[ENTRY]
  if (interp === undefined) throw new Error(`no rule '${ENTRY}'`)

  const out: FileResult[] = []
  for (const f of files) {
    let i: ReturnType<typeof digestOutcome>
    try {
      i = digestOutcome(run(interp as RunnableLike, f.input))
    } catch (e) {
      // A grammar REDUCER may throw as its way of rejecting (jess's dialects do
      // this for constructs that parse but are not legal Less/CSS). That is the
      // interpreter's own behaviour, so the table matches it only by throwing
      // the same thing — which is an identity result, not an unscored file.
      const im = (e as Error).message.split('\n')[0]
      let tm: string | undefined
      try { digestOutcome(run(tbl as RunnableLike, f.input)); tm = undefined }
      catch (te) { tm = (te as Error).message.split('\n')[0] }
      out.push(tm === im
        ? { name: f.name, outcome: 'identical', detail: `both throw: ${im}` }
        : { name: f.name, outcome: 'other', detail: `interp threw ${JSON.stringify(im)}, table ${tm === undefined ? 'returned' : JSON.stringify(tm)}` })
      continue
    }
    let t: ReturnType<typeof digestOutcome>
    try {
      t = digestOutcome(run(tbl as RunnableLike, f.input))
    } catch (e) {
      out.push({ name: f.name, outcome: 'table-throw', detail: (e as Error).message.split('\n')[0] ?? '' })
      continue
    }
    if (t.whole === i.whole) out.push({ name: f.name, outcome: 'identical' })
    else if (t.value === i.value) out.push({ name: f.name, outcome: 'both-reject', detail: i.ok ? 'value agrees, report differs' : 'both reject, report differs' })
    else out.push({ name: f.name, outcome: 'wrong-tree', detail: `interp ok=${i.ok} table ok=${t.ok}` })
  }
  return out
}

const ORDER: Outcome[] = ['identical', 'both-reject', 'wrong-tree', 'table-throw', 'other']

async function main(): Promise<void> {
  const arg = process.argv[2]
  const dialect = (arg ?? 'less') as Dialect
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown dialect '${arg}'`)
  const { rules } = await loadGrammar(dialect)
  const files = corpus(dialect)
  const results = sweep(rules, files)
  const counts = Object.fromEntries(ORDER.map(o => [o, results.filter(r => r.outcome === o).length]))
  console.log(`${dialect}\tfiles=${files.length}\t` + ORDER.map(o => `${o}=${counts[o]}`).join('\t'))
  const verbose = process.argv.includes('--list')
  if (verbose) {
    for (const r of results) {
      if (r.outcome === 'identical') continue
      console.log(`  ${r.outcome.padEnd(12)} ${r.name}${r.detail === undefined ? '' : `  — ${r.detail}`}`)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
