/**
 * BYTES CONSUMED, per parseman build × engine × grammar × fixture, as JSONL.
 *
 * WHY THIS EXISTS. A parse that stops early and still reports `ok: true` is this
 * project's worst failure mode: no error, no exception, every test green. It is
 * exactly what happened to jess's Less grammar at 0.47 — 73117 of `benchmark.less`'s
 * 106802 bytes, 68.5%, silent. Nothing in the repo recorded BYTES CONSUMED against a
 * previous build, so a 31.5% regression in what the parser accepts was invisible to
 * every gate while the timing harness reported it as a speedup.
 *
 * `notes/VERIFY-jess-ab-sweep.json` is keyed by sha and OVERWRITTEN per run, so a
 * curve across releases cannot be recovered from it. This emits APPEND-ONLY JSONL —
 * one record per (build, engine, dialect, fixture) — so results accumulate and a
 * later reader can plot the curve without re-running anything.
 *
 * HOW TO APPEND. One process per (build, engine, dialect) — the grammars' fuse
 * mutates shared recognition pieces in place, so only one dialect may be realised
 * per process, and `compiled` needs a whole-process `PM_MACRO=1`:
 *
 *   node --experimental-strip-types --import ./bench/jess/register.mjs \
 *     bench/jess/consumed-sweep.ts <dialect> <interpreted|table> <out.jsonl>
 *   PM_MACRO=1 node --experimental-strip-types --import ./bench/jess/register.mjs \
 *     bench/jess/consumed-sweep.ts <dialect> compiled <out.jsonl>
 *
 * Records are APPENDED; never rewrite the file in place. To add a build, check that
 * build out into its own worktree and run the same command there — the provenance
 * fields below are what make two runs comparable, and they are read at RUNTIME from
 * inside the graph that actually loaded, not assumed from the checkout.
 *
 * A CONTAMINATED RUN IS RECORDED, NOT DROPPED — `flags` carries why. A discarded run
 * that leaves no trace is how a curve quietly becomes a lie.
 *
 * NO TIMING HERE, deliberately. `ms` is present in the schema and left null: timing
 * needs a controlled box and a load gate, and mixing an untimed correctness sweep
 * into the same records as timed ones would invite reading noise as a curve. A timed
 * appender writes the same schema with `ms` populated and the load fields set.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/functional/run.ts'
import { PARSEMAN_VERSION } from '../../src/version.ts'
import { corpus, corpusTotal, loadGrammar, JESS_ROOT, ENTRY, type Dialect } from './grammars.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PM_ROOT = resolve(HERE, '../..')

/**
 * `table` IS THE BYTECODE INTERPRETER (`src/table/exec.ts`), NOT WHAT SHIPS.
 *
 * `src/table/index.ts` re-exports `tableRules` under the name `tableRules`,
 * so "the table engine" as a consumer sees it is the ASSEMBLED closure graph;
 * this file has always imported the interpreter by path instead. That is a
 * legitimate leg — it is the identity reference the assembler is gated against —
 * but it meant no record in `parse-consumed.jsonl` had ever exercised
 * `src/table/assemble.ts`, and a differential taken on `table` for a change to
 * the assembler is vacuous by construction.
 *
 * `assembled` is that missing leg, added rather than swapped so the 65k existing
 * `table` records stay comparable with future ones. It honours `PM_TABLE_EMIT`,
 * which only `assemble.ts` reads (0 forces the closure walk, 1 the emitted
 * source), and records it in `flags` so the two are never mistaken for each other.
 *
 * ENGINE TOKEN LEGEND. These four strings are a WIRE CONTRACT — they are written
 * into the `engine` field of the committed `notes/results/parse-consumed.jsonl`
 * and 65k existing records use them — so they keep their historical spelling.
 * This is what each one actually binds:
 *   table        execRules()        the REFERENCE bytecode interpreter (NOT what
 *                                   ships; the identity reference)
 *   assembled    tableRules()   the shipped ASSEMBLER
 *   compiled     PM_MACRO=1         also the shipped ASSEMBLER — the macro
 *                                   routes to it. There is no source-lowering
 *                                   "codegen" engine: `src/compiler/codegen.ts`
 *                                   was DELETED in `37c57b5`.
 *   interpreted  the combinator graph
 */
type Engine = 'interpreted' | 'compiled' | 'table' | 'assembled'

const dialect = process.argv[2] as Dialect
const engine = process.argv[3] as Engine
const out = process.argv[4]
if (!dialect || !engine || !out) throw new Error('usage: consumed-sweep.ts <dialect> <engine> <out.jsonl>')

const macro = process.env.PM_MACRO === '1'
if ((engine === 'compiled') !== macro) {
  throw new Error(`engine '${engine}' with PM_MACRO=${macro ? '1' : 'unset'} — 'compiled' needs PM_MACRO=1 and the others need it unset`)
}

function sh(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { cwd: PM_ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

/** Provenance, read from the graph that actually loaded — never assumed. */
const provenance = {
  parsemanSha: sh('git', ['rev-parse', 'HEAD']),
  parsemanVersion: PARSEMAN_VERSION,
  packageVersion: (JSON.parse(readFileSync(resolve(PM_ROOT, 'package.json'), 'utf8')) as { version: string }).version,
  srcRealpath: realpathSync(resolve(PM_ROOT, 'src')),
  srcDirty: sh('git', ['status', '--porcelain', '--', 'src']) !== '',
  jessRoot: JESS_ROOT,
  jessSha: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: JESS_ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' } })(),
  node: process.version,
}

const flags: string[] = []
if (provenance.parsemanVersion !== provenance.packageVersion) flags.push('version-mismatch')
if (provenance.srcDirty) flags.push('src-dirty')
if (process.env.NODE_PATH) flags.push('NODE_PATH-set')

const { rules } = await loadGrammar(dialect, 'ast')
let entry: unknown = rules[ENTRY]
if (engine === 'table') {
  const { encodeTable } = await import('../../src/table/encode.ts')
  const { execRules } = await import('../../src/table/exec.ts')
  entry = execRules(encodeTable(rules, {}))[ENTRY]
}
if (engine === 'assembled') {
  const { encodeTable } = await import('../../src/table/encode.ts')
  const { tableRules } = await import('../../src/table/assemble.ts')
  entry = tableRules(encodeTable(rules, {}))[ENTRY]
  flags.push(`PM_TABLE_EMIT=${process.env.PM_TABLE_EMIT ?? '(unset ⇒ 1)'}`)
}
// PROVE THE LEG IS THE LEG IT CLAIMS: the macro lowers a rule to a FUNCTION, the
// interpreted fuse leaves an object. A `compiled` run that silently got the
// combinator graph would agree with the interpreter perfectly and prove nothing.
const isFn = typeof entry === 'function'
if (engine === 'compiled' && !isFn) throw new Error("engine 'compiled' got a combinator — the macro did not run")
if (engine === 'interpreted' && isFn) throw new Error("engine 'interpreted' got an assembled rule — PM_MACRO leaked in")

/** Large hand-maintained fixtures the corpus roots do not cover. */
const EXTRA: Record<Dialect, string[]> = {
  less: ['packages/jess/benchmark/benchmark.less', 'packages/jess/benchmark/gen-workload.less'],
  css: ['packages/jess/benchmark/benchmark.css'],
  scss: ['packages/jess/benchmark/gen-workload.scss'],
  jess: [],
}

const files = [...corpus(dialect)]
for (const rel of EXTRA[dialect]) {
  try { files.push({ name: rel, input: readFileSync(resolve(JESS_ROOT, rel), 'utf8') }) } catch { /* absent */ }
}

const ts = new Date().toISOString()
const load0 = os.loadavg()[0]
const lines: string[] = []
for (const f of files) {
  let rec: Record<string, unknown>
  try {
    const r = run(entry as never, f.input)
    // CONSUMED is the point of this file. `unconsumedFrom` is where a permissive
    // top rule stopped; null means it reached the end.
    const consumed = r.unconsumedFrom ?? f.input.length
    rec = { ok: r.ok, consumed, unconsumedFrom: r.unconsumedFrom, errors: r.errors.length, threw: null }
  } catch (e) {
    rec = { ok: null, consumed: null, unconsumedFrom: null, errors: null, threw: (e as Error).message.split('\n')[0] }
  }
  lines.push(JSON.stringify({
    ts, engine, dialect, variant: 'ast', file: f.name, bytes: f.input.length,
    ...rec, ms: null, loadStart: load0, loadEnd: null, flags,
    ...provenance,
  }))
}
appendFileSync(out, lines.join('\n') + '\n')
console.log(`${dialect}/${engine}: ${lines.length} records appended to ${out} (corpus ${corpusTotal(dialect)} + ${EXTRA[dialect].length} extra)${flags.length ? '  FLAGS: ' + flags.join(',') : ''}`)
