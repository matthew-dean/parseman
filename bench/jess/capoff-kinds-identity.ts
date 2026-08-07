/**
 * THE PATH THE FIX MUST NOT TOUCH, on a real grammar.
 *
 * `emit-identity-one.ts` runs a plain `run()`, which never sets
 * `options.rootTrivia.select` — so `ctx._rootTriviaLog` stays undefined and the
 * whole sweep exercises only the branch where trivia KINDS are unobservable.
 * That is exactly the branch this lane changed, which makes the sweep necessary
 * and not sufficient.
 *
 * This drives the OTHER branch: with a selection live, `scanTrivia` must still
 * route through `scanWithLabels` and still classify every gap, because the kind
 * is now observable in the result. It prints the full row set so base and fix
 * can be diffed byte for byte.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { ENTRY, JESS_ROOT, corpus, loadGrammar, VARIANT_SETTINGS, type Dialect, type Variant } from './grammars.ts'

type RunnableLike = Parameters<typeof run>[0]

const dialect = (process.argv[2] ?? 'css') as Dialect
const variant = (process.argv[3] ?? 'ast') as Variant
const { rules } = await loadGrammar(dialect, variant)
const prog = encodeTable(rules, VARIANT_SETTINGS[variant])
const entry = assembledRules(prog)[ENTRY] as RunnableLike | undefined
if (entry === undefined) throw new Error(`no rule '${ENTRY}'`)

// The labels the grammar actually declares. Selecting a label the grammar does
// not define is a `TypeError` by design, so this asks the table rather than
// guessing — and prints them, because a selection that silently narrowed to
// nothing would make every row below vacuously equal.
const labels = (prog.triviaSpecs ?? []).flatMap(s => s.arms.map(a => a[0]))
const select = [...new Set(labels)]
console.log(`# ${dialect}/${variant} select=${JSON.stringify(select)}`)
if (select.length === 0) throw new Error(`${dialect}: no labelled trivia arms — this probe would be vacuous`)

for (const f of corpus(dialect)) {
  let cell: string
  try {
    const r = run(entry, f.input, { rootTrivia: { select } })
    const rt = r.rootTrivia
    cell = rt === undefined
      ? `ok=${r.ok} rootTrivia=ABSENT`
      : `ok=${r.ok} rows=${rt.rows.length} labels=${JSON.stringify(rt.index.labels)} d=${JSON.stringify(rt.rows).length}`
  } catch (e) { cell = `threw: ${(e as Error).message.split('\n')[0] ?? ''}` }
  console.log(`${f.name}\t${cell}`)
}
void readFileSync
void resolvePath
void JESS_ROOT
