/**
 * DO THE FOUR MACRO-BUILT VARIANTS OF EACH DIALECT ACTUALLY PARSE?
 *
 * The `*PositionsGrammar` / `*CstPositionsGrammar` exports — the `trackLines: true`
 * half of the variant axis — are recorded as dead: self-referential `OP_RULE ip->ip`
 * and a stack overflow on every file of every corpus, all four dialects. That is two
 * of the four tables in every emitted artifact.
 *
 * This asks the question directly, per variant, and reports `ok` WITH `consumed`
 * because `consumed` is `unconsumedFrom ?? bytes` — a failed parse records the full
 * byte count and reads as success if you look at it alone.
 *
 * Deterministic. Reads no clock.
 *
 * Usage: node --import ./bench/jess/register.mjs bench/jess/macro-variant-liveness.ts [dialect]
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { run } from '../../src/functional/run.ts'
import { cstBuildHost } from '../../src/index.ts'
import { ENTRY, JESS_ROOT, VARIANTS, assertParseman, exportName, headSha, type Dialect, type Variant } from './grammars.ts'

type Entry = Parameters<typeof run>[0]

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

const FIXTURE: Record<Dialect, string> = {
  css: 'packages/jess/benchmark/benchmark.css',
  less: 'packages/jess/benchmark/benchmark.less',
  scss: 'packages/jess/benchmark/gen-workload.scss',
  jess: 'packages/jess/benchmark/benchmark.jess',
}

const dialect = (process.argv[2] ?? 'less') as Dialect

const prov = await assertParseman()
console.log(`parseman ${prov.version} at ${prov.root}  HEAD ${headSha()}`)
console.log(`  node ${process.version}   dialect ${dialect}`)

const path = resolvePath(JESS_ROOT, FIXTURE[dialect])
const input = readFileSync(path, 'utf8')
console.log(`  fixture ${path}  ${statSync(path).size} B`)

const modPath = resolvePath(JESS_ROOT, MODULE[dialect])
const mod = await import(`pm-macro:${modPath}`) as Record<string, unknown>

console.log('')
console.log('variant        export                          ok   consumed / bytes   outcome')
for (const v of VARIANTS as readonly Variant[]) {
  const name = exportName(dialect, v)
  const g = mod[name] as Record<string, unknown> | undefined
  if (g === undefined) { console.log(`  ${v.padEnd(12)} ${name.padEnd(30)} —    —                  NO SUCH EXPORT`); continue }
  const entry = g[ENTRY] as Entry | undefined
  if (typeof entry !== 'function') { console.log(`  ${v.padEnd(12)} ${name.padEnd(30)} —    —                  NOT LOWERED`); continue }
  let ok = false
  let consumed = 0
  let outcome = ''
  try {
    // A `cst` artifact builds every node through a positioned-CST host and REFUSES
    // to run without one. Supplying it is not part of the question being asked —
    // omitting it made two of the four variants report a throw that is the
    // artifact working exactly as designed.
    const r = v.startsWith('cst') ? run(entry, input, { build: cstBuildHost() }) : run(entry, input)
    ok = r.ok
    consumed = r.unconsumedFrom ?? input.length
    outcome = ok && consumed === input.length ? 'PARSES' : 'parse FAILED'
  } catch (e) {
    outcome = `THREW — ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
  }
  console.log(`  ${v.padEnd(12)} ${name.padEnd(30)} ${String(ok).padEnd(5)}${String(consumed).padStart(8)} / ${input.length}   ${outcome}`)
}
