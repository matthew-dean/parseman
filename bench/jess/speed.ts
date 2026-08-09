/**
 * AST-path parse speed over jess's real corpora: the REFERENCE BYTECODE
 * INTERPRETER vs the shipped ASSEMBLER vs the COMBINATOR INTERPRETER.
 *
 * ENGINE TOKEN LEGEND — the `Engines` field names and the argv/label tokens keep
 * their historical spelling; this is what each one actually binds:
 *   table        execRules()   the REFERENCE bytecode interpreter (NOT what ships)
 *   compiled     pm-macro:     the shipped ASSEMBLER — the macro routes
 *                              `compileLinkableTable` to the assembler; there is
 *                              no source-lowering "codegen" engine, because
 *                              it was DELETED in `37c57b5`
 *   interpreted  the combinator graph
 *
 * THE PATH IS THE AST PATH. By owner ruling that is the canonical performance
 * measure, and a speed number that does not name its path is not a result. Every
 * figure below is `hostMode: 'ast'`, `trackLines: false` — the `<dialect>Grammar`
 * export, encoded with the matching `TableSettings`.
 *
 * ALL THREE ENGINES IN ONE PROCESS. `bench/ab-harness.ts`'s header records that
 * separate process launches on this hardware produced 9.4 ms and 26 ms for the
 * same case in consecutive runs; nothing survives that except interleaving, so a
 * cross-process comparison is not a comparison. The three engines were previously
 * held to be un-coexistable — `PM_MACRO=1` is a whole-process switch and
 * `composeLeaf()`'s interpreted fuse binds the shared recognition pieces in place
 * — so `hooks.mjs` gained `pm-macro:<path>`, which lowers ONE module into its own
 * module instance and leaves the process alone.
 *
 * That sharing is the risk, so it is CHECKED, not asserted: this harness times
 * only the files on which all three engines produce an identical `RunResult`, and
 * prints the agreeing count against the corpus total. The counts reproduce
 * `divergence.ts`'s separate-process three-way sweep exactly (css 58/87), which
 * is the evidence that one process is not contaminating anything.
 *
 * Timing a set of files the engines disagree about would be timing three
 * different parses, which `ab-harness.ts`'s `assertSameParse` exists to prevent.
 * The excluded files are the known combinator-interpreter/assembler drift the
 * three-way sweep catalogues, not reference-interpreter defects — the reference
 * interpreter is the outlier on zero of them.
 *
 * A CONTROL contest runs alongside: exec-vs-exec, two instances of the SAME
 * path. Its delta is this machine's noise floor for this run, and no gate number
 * is readable without it.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/speed.ts [dialect...]`
 */
import os from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { calibrate, interleave, median, pairedMedianRatio, pairedMinRatio, pairedWins, sign, type Case, type Contest, type Measurement } from '../ab-harness.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
import { execRules } from '../../src/table/exec.ts'
import {
  DIALECTS, ENTRY, JESS_ROOT, LOAD_CEILING, VARIANT_SETTINGS,
  assertParseman, assertQuiet, corpus, corpusTotal, exportName, loadGrammar, loads,
  type CorpusFile, type Dialect,
} from './grammars.ts'

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

const M: Measurement = { targetSampleMs: 25, warmup: 3, timed: 5, rounds: 8, runs: 2 }

/** The variant under measurement, stated once so no figure can drift off it. */
const VARIANT = 'ast'

type Entry = Parameters<typeof run>[0]
type Engines = { interpreted: Entry; compiled: Entry; table: Entry; tableB: Entry }

async function engines(dialect: Dialect): Promise<Engines> {
  const { rules } = await loadGrammar(dialect, VARIANT)
  const interpreted = rules[ENTRY] as Entry
  if (interpreted === undefined) throw new Error(`${dialect}: no rule '${ENTRY}'`)
  // Two independently built tables. `ab-harness.ts` records that two instances of
  // byte-identical code do not run at identical speed and that the winner is
  // fixed for the life of a pass; the control contest exists to show that.
  const table = execRules(encodeTable(rules, VARIANT_SETTINGS[VARIANT]))[ENTRY] as Entry
  const tableB = execRules(encodeTable(rules, VARIANT_SETTINGS[VARIANT]))[ENTRY] as Entry
  const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, unknown>
  const grammar = mod[exportName(dialect, VARIANT)] as Record<string, unknown> | undefined
  if (grammar === undefined) throw new Error(`${dialect}: macro lowering exposed no ${exportName(dialect, VARIANT)}`)
  const compiled = grammar[ENTRY] as Entry
  // PROVE EACH LEG IS THE LEG IT CLAIMS. `run()` takes both shapes, so a
  // 'compiled' side that quietly got the combinator graph would produce a
  // flattering table-vs-compiled number and prove nothing. The macro lowers a
  // rule to a FUNCTION; the interpreted fuse leaves an object.
  if (typeof compiled !== 'function') throw new Error(`${dialect}: 'compiled' is not a function — the macro did not run`)
  if (typeof interpreted === 'function') throw new Error(`${dialect}: 'interpreted' is a function — macro lowering leaked`)
  return { interpreted, compiled, table, tableB }
}

function digest(entry: Entry, input: string): string {
  try { return digestValue(run(entry, input)) }
  catch (e) { return `threw:${(e as Error).message.split('\n')[0] ?? ''}` }
}

/**
 * The files all three engines answer identically — the only ones timeable.
 *
 * `threw` counts the agreeing files whose answer is a reducer THROW. That is a
 * real answer — jess's dialects reject illegal constructs that way, and all
 * three engines call the same reducer — so those files stay in the workload;
 * the count is reported because exception unwinding is not parse throughput and
 * a reader should know how much of the sweep is it.
 */
function agreeing(e: Engines, files: readonly CorpusFile[]): { files: CorpusFile[]; threw: number } {
  const out: CorpusFile[] = []
  let threw = 0
  for (const f of files) {
    const i = digest(e.interpreted, f.input)
    if (i !== digest(e.compiled, f.input) || i !== digest(e.table, f.input)) continue
    out.push(f)
    if (i.startsWith('threw:')) threw++
  }
  return { files: out, threw }
}

/**
 * One case per dialect: a sweep of the whole agreeing corpus.
 *
 * Per-FILE cases were rejected: hundreds of cases inside `interleave` multiply
 * the round count by the case count, and a 300-byte sass-spec input parses inside
 * timer granularity. The sweep is the workload a consumer actually has.
 */
function makeCase(entry: Entry, files: readonly CorpusFile[], id: string, tag: string): Case {
  const bytes = files.reduce((a, f) => a + f.input.length, 0)
  // A reducer THROW is one of the answers this corpus contains, and all three
  // engines throw the same one on the same files (that is what `agreeing`
  // checked). Letting it escape kills the run; catching it costs all three
  // sides the same, so it cannot favour one.
  const sweep = (): void => {
    for (const f of files) {
      try { run(entry, f.input) } catch { /* the file's answer, taken identically by all three */ }
    }
  }
  return {
    id,
    detail: `${tag} ${files.length} files, ${bytes} B`,
    parse: sweep,
    run: (reps: number) => { for (let n = 0; n < reps; n++) sweep() },
  }
}

async function main(): Promise<void> {
  const pm = await assertParseman()
  const picked = process.argv.slice(2).filter(a => (DIALECTS as readonly string[]).includes(a)) as Dialect[]
  const dialects = picked.length > 0 ? picked : DIALECTS

  console.log(`parseman ${pm.version}   ${pm.root}   node ${process.version}`)
  console.log(`jess     ${JESS_ROOT}   installs parseman ${pm.installed} — NOT what is measured here`)
  console.log(`cpus ${os.cpus().length}   loadavg at START ${loads()}`)
  const { forced } = assertQuiet()
  console.log(`loadavg gate ${LOAD_CEILING}${forced ? '   *** FORCED PAST THE CEILING — NOT a canonical number ***' : ''}`)
  console.log(`variant  hostMode=ast trackLines=false — THE AST PATH, the canonical measure`)
  console.log('')

  for (const d of dialects) {
    // One process per dialect: the interpreted fuse binds the shared recognition
    // pieces in place, so a second dialect in this process would fuse against a
    // grammar the first one already mutated.
    const e = await engines(d)
    const all = corpus(d)
    const { files, threw } = agreeing(e, all)
    const total = corpusTotal(d)
    const bytes = files.reduce((a, f) => a + f.input.length, 0)
    console.log(`=== ${d}   timing ${files.length} files (${bytes} B) of ${all.length} taken, of ${total} in the corpus`)
    console.log(`    ${threw} of the timed files end in a reducer throw — a real answer, taken identically by all three`)
    console.log(`    excluded ${all.length - files.length}: the three engines do not agree on them, so timing them`)
    console.log(`    would time three different parses. See divergence.ts — the reference interpreter is the outlier on none.`)
    if (files.length === 0) { console.log('    NOTHING TO TIME.'); continue }

    const cases = (entry: Entry, tag: string): Case[] => [makeCase(entry, files, d, tag)]
    const reps = calibrate(cases(e.compiled, 'cal'), M)

    const contests: Contest[] = [
      { label: 'gate:      assembled -> exec', a: cases(e.compiled, 'compiled'), b: cases(e.table, 'table') },
      { label: 'CONTROL:   exec      -> exec', a: cases(e.table, 'table'), b: cases(e.tableB, 'table') },
      { label: 'reference: assembled -> interpreter', a: cases(e.compiled, 'compiled'), b: cases(e.interpreted, 'interp') },
    ]
    const out = interleave(contests, reps, M)
    console.log(`    ${reps.get(d)} sweep(s) per sample, ${M.rounds * M.runs} samples per side`)
    for (const k of contests) {
      const s = out.get(k.label)!
      const a = s.get(`ref|${d}`)!
      const b = s.get(`head|${d}`)!
      const dMed = (pairedMedianRatio(a, b) - 1) * 100
      const dMin = (pairedMinRatio(s, `ref|${d}`, `head|${d}`) - 1) * 100
      const wins = pairedWins(a, b)
      console.log(
        `    ${k.label.padEnd(36)} median ${sign(dMed).padStart(8)}   min ${sign(dMin).padStart(8)}`
        + `   B-wins ${String(wins).padStart(2)}/${b.length}   (${median(a).toFixed(2)} -> ${median(b).toFixed(2)} ms)`,
      )
    }
    console.log('')
  }

  console.log(`loadavg at END ${loads()}`)
  console.log('')
  console.log('  Read every gate row AGAINST its control row. The control is two independently')
  console.log('  built instances of the SAME path, so its delta is this run\'s noise floor.')
  console.log('  A gate delta inside the control\'s magnitude is not a result in either direction.')
}

await main()
