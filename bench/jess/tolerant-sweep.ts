/**
 * BYTES CONSUMED AND DIAGNOSTICS UNDER `tolerant: true`, per engine, as JSONL.
 *
 * WHY THIS EXISTS, AND WHY `consumed-sweep.ts` COULD NOT BE REUSED. That file
 * calls `run(entry, input)` with NO options, and `run-tabled.ts:143` reads
 * `options.tolerant === true` to pick WHICH TABLE is built. A strict call
 * therefore never realises the tolerant assembly at all — so a change confined
 * to the tolerant assembly produces a byte-identical `consumed-sweep` on both
 * sides while proving nothing whatsoever. That is a vacuous differential, and it
 * is the exact failure this project has been bitten by repeatedly.
 *
 * This sweep sets `tolerant: true`, so the recovery table is the one under test.
 *
 * WHAT IS DIGESTED. `consumed-sweep.ts` records `errors.length` only. A recovery
 * change can preserve the COUNT while moving every span — so this records each
 * error's message and span, and the value digest, because `ok` and `consumed`
 * agreeing while the tree differs is the defect class that shipped twice today.
 *
 * Usage: one process per (dialect, engine) — the grammars' fuse mutates shared
 * recognition pieces in place, so only one dialect may be realised per process.
 *
 *   PM_TABLE_EMIT=<0|1> node --experimental-strip-types \
 *     --import ./bench/jess/register.mjs \
 *     bench/jess/tolerant-sweep.ts <dialect> <out.jsonl>
 *
 * `PM_TABLE_EMIT` is read once at `assemble.ts` module load: 0 forces the
 * closure walk, 1 allows the emitter. Comparing the two files is the
 * emitted-vs-closure identity claim for the recovery path. `run-tabled.ts` always
 * builds closures, so the emitted leg goes through `compile()` to reach the emitter.
 *
 * Less and `.jess` stop at load: `compose()` refuses a macro-lowered base at runtime. For
 * those, compare built artifacts with `leg-sweep.mjs --tolerant`.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'
import { run as runInterpreter } from '../../src/functional/run.ts'
import { run as runClosure } from '../../src/functional/run-tabled.ts'
import { compile } from '../../src/table/compile.ts'
import { REC } from '../../src/recovery/scan.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { assertParseman, corpus, corpusTotal, loadGrammar, JESS_ROOT, ENTRY, type Dialect } from './grammars.ts'

const dialect = process.argv[2] as Dialect
const out = process.argv[3]
if (!dialect || !out) throw new Error('usage: tolerant-sweep.ts <dialect> <out.jsonl>')

const emit = process.env.PM_TABLE_EMIT === '0' ? 'closure' : 'emitted'
const prov = await assertParseman()
const g = await loadGrammar(dialect, 'ast')
const entry = g.rules[ENTRY]
if (entry === undefined) throw new Error(`${dialect}: no rule ${ENTRY}`)
const parse = emit === 'closure'
  ? (input: string) => runClosure(entry as never, input, { tolerant: true })
  : (compiled => (input: string) => runInterpreter(compiled, input, { tolerant: true }))((compile(g.rules as unknown as Record<string, unknown> & { readonly _def?: never }) as Record<string, never>)[ENTRY]!)

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
// Reading text again is for damage only: a document that comes out clean must not have got here.
let armReads = 0
const furthest = REC.furthest
REC.furthest = (ctx, n, attempt) => { armReads++; return furthest(ctx, n, attempt) }
const reread: string[] = []
for (const f of files) {
  armReads = 0
  let rec: Record<string, unknown>
  try {
    const r = parse(f.input)
    // EVERY facet a recovery change can move, not just the count.
    // A `ParseError` IS its span and its expected set (`types.ts:408`) — there is
    // no message field. BOTH are digested: a recovery change that preserves every
    // span while altering the expected sets changes what an editor offers at the
    // cursor, and `expected` is public API.
    const errs = r.errors.map(e => `${e.span.start}-${e.span.end}:${e.expected.join('|')}`)
    rec = {
      ok: r.ok,
      consumed: r.unconsumedFrom ?? f.input.length,
      unconsumedFrom: r.unconsumedFrom,
      errorCount: r.errors.length,
      errorDigest: digestValue(errs),
      valueDigest: r.ok ? digestValue(r.value) : null,
      expectedDigest: digestValue(r.expected),
      threw: null,
    }
    if (armReads > 0 && r.ok && r.errors.length === 0 && r.unconsumedFrom === null) reread.push(f.name)
  } catch (e) {
    rec = {
      ok: null, consumed: null, unconsumedFrom: null, errorCount: null,
      errorDigest: null, valueDigest: null, expectedDigest: null,
      threw: (e as Error).message.split('\n')[0],
    }
  }
  lines.push(JSON.stringify({
    ts, engine: emit, dialect, variant: 'ast', tolerant: true,
    file: f.name, bytes: f.input.length, ...rec,
    loadStart: load0, parsemanVersion: prov.version, parsemanRoot: prov.root,
  }))
}
appendFileSync(out, lines.join('\n') + '\n')
if (reread.length > 0) {
  console.error(`${dialect}/${emit}: ${reread.length} clean documents read an arm again:\n${reread.join('\n')}`)
  process.exitCode = 1
}
console.log(`${dialect}/${emit}: ${lines.length} records -> ${out} (corpus ${corpusTotal(dialect)} + ${EXTRA[dialect].length} extra)`)
