/**
 * ALLOCATION PER PARSE, from `--trace-gc` BYTE DELTAS.
 *
 * `--heap-prof` cannot answer this question: it reports SURVIVING allocations,
 * and a parse's cost is almost entirely churn that dies in the nursery (15 MB
 * surviving against 9.2 GB of churn on this workload). What allocation pressure
 * actually is, is the bytes the young generation had to be handed between
 * collections — which is exactly what consecutive `--trace-gc` lines bracket.
 *
 * Run it as:
 *
 *   node --experimental-strip-types --trace-gc \
 *     --import ./bench/jess/register.mjs bench/jess/capoff-alloc.ts <dialect> [n]
 *
 * and pipe stderr to `capoff-alloc-read.mjs`, which does the arithmetic. This
 * half only produces the parses and prints the denominator, so that the number
 * and the count it is divided by come from the same process.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { assembledRules } from '../../src/table/assemble.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { ENTRY, JESS_ROOT, loadGrammar, VARIANT_SETTINGS, type Dialect, type Variant } from './grammars.ts'

type RunnableLike = Parameters<typeof run>[0]

const FIXTURE: Record<Dialect, string> = {
  css: 'packages/jess/benchmark/benchmark.css',
  less: 'packages/jess/benchmark/benchmark.less',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/benchmark.jess',
}

const dialect = (process.argv[2] ?? 'css') as Dialect
const n = Number(process.argv[3] ?? 40)
const variant = (process.argv[4] ?? 'ast') as Variant

const input = readFileSync(resolvePath(JESS_ROOT, FIXTURE[dialect]), 'utf8')
const { rules } = await loadGrammar(dialect, variant)
const prog = encodeTable(rules, VARIANT_SETTINGS[variant])
const entry = assembledRules(prog)[ENTRY] as RunnableLike | undefined
if (entry === undefined) throw new Error(`no rule '${ENTRY}'`)

// WARM, then MARK. Everything before the mark is compilation, first-call
// feedback and megamorphic settling; counting it as parse allocation would
// charge the parse for work no later parse repeats.
for (let i = 0; i < 5; i++) run(entry, input)
// STDOUT, deliberately: `--trace-gc` writes there, and a marker on stderr would
// be interleaved by two independently-buffered streams — the window would open
// and close at the wrong lines and the arithmetic would be over the wrong set.
process.stdout.write(`@@MARK ${dialect} ${variant} bytes=${input.length}\n`)

let ok = 0
let consumed = 0
for (let i = 0; i < n; i++) {
  const r = run(entry, input)
  // `consumed` READ WITH `ok`, never alone: `unconsumedFrom ?? bytes` records the
  // FULL byte count for a parse that failed, so a configuration that got cheaper
  // by no longer parsing reads as a full parse unless both are printed.
  if (r.ok) ok++
  consumed += r.unconsumedFrom ?? input.length
}
process.stdout.write(`@@END parses=${n} ok=${ok} consumed=${consumed}\n`)
