/**
 * ABSOLUTE parse time, in milliseconds, on jess's canonical large fixtures.
 *
 * Ratios and MB/s do not let anyone compare against a number they already know.
 * This reports the wall time of ONE parse of ONE named fixture, with the fixture
 * named and its byte size printed, for all three engines.
 *
 * THE THREE ENGINES ARE `assembled (shipped)`, `exec (reference)` and
 * `interpreter`. They were called `codegen`, `table` and `interpreter` until this
 * commit and TWO of those three names were wrong: `codegen` names a source
 * lowering deleted in `37c57b5`, and `table` named the reference bytecode
 * interpreter rather than the shipped assembler. Any figure quoted from this
 * harness under the old column names means something other than what it printed.
 *
 * THE PATH IS THE AST PATH — `hostMode: 'ast'`, `trackLines: false` — the same
 * canonical measure `speed.ts` uses. Same one-process `interleave` engine, same
 * same-engine CONTROL contest.
 *
 * `benchmark.less` is EXEMPT from byte-identity by standing rule: it is a timing
 * fixture only, and nothing here compares its tree to anything. The three-way
 * agreement check still runs, because timing three different parses is not a
 * comparison — but a fixture the engines disagree on is REPORTED and skipped,
 * not silently dropped.
 *
 * NOT IN SCOPE, deliberately: jess's own `benchmark:*` harnesses
 * (`packages/jess/benchmark/*.mjs`) compare whole-pipeline compile against
 * stylis, dart-sass and postcss. They import `@jesscss/css-parser` from jess's
 * BUILT lib, which is pinned to a published parseman — so they cannot be aimed
 * at this worktree's table engine without rebuilding jess against it. The
 * standing `jess-ast at 1.35x PostCSS` bar is a whole-pipeline figure and is not
 * reproducible from parseman's side. Approximating it here would be inventing a
 * number.
 *
 * Usage: `node --import ./bench/jess/register.mjs bench/jess/fixture.ts [dialect]`
 */
import os from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { interleave, median, sign, type Case, type Contest, type Measurement } from '../ab-harness.ts'
import { digestValue } from '../../src/oracle/index.ts'
import { run } from '../../src/functional/run.ts'
import { encodeTable } from '../../src/table/encode.ts'
/**
 * THE REFERENCE INTERPRETER, imported BY ITS OWN NAME.
 *
 * This harness prints two table columns and they are two DIFFERENT ENGINES:
 *
 *   assembled (shipped)   the `pm-macro:` artifact, which emits
 *                         `import { tableRules } from 'parseman/table'` →
 *                         `src/table/index.ts:40`, `tableRules as tableRules`
 *   exec (reference)      `execRules(encodeTable(...))` — this import
 *
 * Both columns were previously wrong. The source lowering was DELETED in
 * `37c57b5`, so the column headed `codegen` has measured the ASSEMBLER, not a
 * source lowering, since that commit. And the column headed `table` bound
 * `tableRules` from `exec.ts` — the same identifier `parseman/table` exports for
 * the assembler — so it has always been the reference interpreter. The two names
 * type-checked identically, which is why the mislabel survived a cycle of being
 * quoted. See `src/table/exec.ts`'s export comment for the full defect class.
 */
import { execRules } from '../../src/table/exec.ts'
import {
  ENTRY, JESS_ROOT, LOAD_CEILING, VARIANT_SETTINGS,
  assertParseman, assertQuiet, exportName, headSha, loadGrammar, loads, VARIANTS,
  type Dialect, type Variant,
} from './grammars.ts'
import { COLUMNS, FACETS, digestRow } from './digest.ts'

const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

/** The repo's own large fixtures, by dialect. Nothing here is synthesised. */
const FIXTURES: Record<Dialect, string[]> = {
  less: ['packages/jess/benchmark/benchmark.less', 'packages/jess/benchmark/gen-workload.less'],
  scss: ['packages/jess/benchmark/gen-workload.scss'],
  jess: ['packages/jess/benchmark/chunk.jess', 'packages/jess/benchmark/benchmark.jess'],
  css: ['packages/jess/benchmark/benchmark.css'],
}

/** One parse per sample: these fixtures are 100 KB+, so a single parse is a
 * sample of useful size and the reported millisecond IS the answer. */
const M: Measurement = { targetSampleMs: 0, warmup: 3, timed: 5, rounds: 8, runs: 2 }

type Entry = Parameters<typeof run>[0]

/**
 * THE PROTOCOL, printed with the numbers.
 *
 * A millisecond figure that travels without its protocol is how the same fixture
 * ended up with two remembered baselines 27% apart. Every line here is a thing
 * that, changed, moves the number — so a pasted result carries the reason it is
 * what it is, and two results that disagree can be told apart by reading them.
 */
function protocol(m: Measurement, variant: Variant): string[] {
  return [
    `  fixture     a named file under jess's packages/jess/benchmark, read verbatim, byte size printed`,
    `  variant     ${variant} — hostMode='${VARIANT_SETTINGS[variant].hostMode ?? 'ast'}', trackLines=${VARIANT_SETTINGS[variant].trackLines === true}.`,
    `              The AST path is canonical by owner ruling; figures from any other variant`,
    `              are NOT the canonical baseline and must be quoted with the variant name.`,
    `  engines     assembled (shipped) — the pm-macro: artifact of the SHIPPING grammar module,`,
    `              which imports tableRules from parseman/table, i.e. tableRules;`,
    `              exec (reference) — execRules(encodeTable(...)) over the SAME rules, the`,
    `              bytecode INTERPRETER that nothing ships on; interpreter — the combinator`,
    `              graph itself. NOTE these are TWO TABLE ENGINES plus the graph, not a source`,
    `              lowering vs a table: the source lowering was DELETED in 37c57b5 and this`,
    `              harness has measured no codegen since. The proof below is a SHAPE check only`,
    `              (assembled must be a FUNCTION, interpreter must NOT be) — it cannot tell the`,
    `              two table engines apart, which is why they are imported by distinct names.`,
    `  entry       every engine is invoked through run() — the public entry, identically on all`,
    `              three sides, so run()'s own per-parse cost cannot favour one of them`,
    `  process     ONE process, all engines interleaved in adjacent order-alternated pairs`,
    `              (bench/ab-harness.ts interleave). Separate process launches on this hardware`,
    `              read 9.4 ms and 26 ms for the same case; nothing survives that.`,
    `  composition PINNED at exactly three legs plus the control, in this order. This is a`,
    `              LOAD-BEARING part of the protocol, not a detail: the legs share one heap, so`,
    `              adding or removing one MOVES the others. Dropping the interpreter leg and`,
    `              changing nothing else moved the exec leg 18% on benchmark.less. A harness with a`,
    `              different set of legs produces different absolute milliseconds from identical`,
    `              code — which is exactly how this fixture acquired two baselines 27% apart.`,
    `  warmup      ${m.warmup} parses per side before any sample is kept`,
    `  sampling    ${m.rounds} rounds x ${m.runs} runs = ${m.rounds * m.runs} samples per side. ONE parse per repetition —`,
    `              these fixtures are 100 KB+, so a single parse is already a sample of useful`,
    `              size and the reported millisecond IS one parse. Each sample is itself the`,
    `              median of ${m.timed} timed repetitions.`,
    `  statistic   MEDIAN of the ${m.rounds * m.runs} samples (each a median of ${m.timed}). Not the min, not the mean.`,
    `  control     an in-run exec-vs-exec contest — two independently built instances of the`,
    `              SAME engine. Its delta is this run's noise floor. A figure read without it is`,
    `              not a measurement.`,
    `  load gate   REFUSED above a 1-minute load average of ${LOAD_CEILING}. PM_FORCE=1 overrides and`,
    `              marks every figure FORCED.`,
  ]
}

/** Nodes and serialized size of one engine's tree — the scale a divergence is read against. */
function treeStats(v: unknown): { nodes: number; bytes: number } {
  let nodes = 0
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== 'object') return
    nodes++
    if (Array.isArray(x)) { for (const e of x) walk(e); return }
    for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k])
  }
  walk(v)
  let bytes = -1
  try { bytes = JSON.stringify(v)?.length ?? -1 } catch { /* not serializable; nodes still answer */ }
  return { nodes, bytes }
}

/**
 * The count of MINIMAL differing subtrees between two engines' trees.
 *
 * Descent stops at the first difference, so a whole differing subtree counts
 * ONCE. That is the number the "is the tree difference doing the work?" question
 * needs: it says how much of the tree the two engines built differently, against
 * a node count that says how much they built at all.
 */
function divergentSubtrees(a: unknown, b: unknown): number {
  if (a === b) return 0
  const ao = a !== null && typeof a === 'object'
  const bo = b !== null && typeof b === 'object'
  if (!ao || !bo) return 1
  if (Array.isArray(a) !== Array.isArray(b)) return 1
  if (Array.isArray(a) && Array.isArray(b)) {
    // A length mismatch used to return 1 and stop, which reported the whole
    // `benchmark.less` divergence as a single subtree — technically true and
    // useless. Descend over the common prefix and charge the tail, so the number
    // has the same units everywhere it appears.
    const min = Math.min(a.length, b.length)
    let n = Math.abs(a.length - b.length)
    for (let i = 0; i < min; i++) n += divergentSubtrees(a[i], b[i])
    return n
  }
  const ka = Object.keys(a as object).sort()
  const kb = Object.keys(b as object).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return 1
  let n = 0
  for (const k of ka) n += divergentSubtrees((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  return n
}

/** One engine's tree, or undefined if the parse threw. */
function treeOf(entry: Entry, input: string): unknown {
  try { return run(entry, input).value } catch { return undefined }
}

function digest(entry: Entry, input: string): string {
  try { return digestValue(run(entry, input)) }
  catch (e) { return `threw:${(e as Error).message.split('\n')[0] ?? ''}` }
}

/** The per-facet row `digest.ts` builds, so a disagreement can name itself. */
function rowOf(entry: Entry, input: string): string[] {
  try { return digestRow(run(entry, input)) }
  catch (e) { return Array.from({ length: COLUMNS.length }, () => `threw:${(e as Error).message.split('\n')[0] ?? ''}`) }
}

async function main(): Promise<void> {
  const pm = await assertParseman()
  const dialect = (process.argv[2] ?? 'less') as Dialect
  // The variant is OPTIONAL and defaults to the canonical AST path, so
  // `pnpm bench:less` is byte-for-byte the measurement it has always been.
  // Naming one measures THAT path instead — the only way to time a
  // `trackLines: true` grammar, which is where `valueUnused` actually bites.
  const variant = (process.argv[3] ?? 'ast') as Variant
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant '${String(process.argv[3])}'`)
  console.log(`parseman ${pm.version} @ ${headSha()}   ${pm.root}`)
  console.log(`node ${process.version}   ${os.platform()}/${os.arch()}   cpus ${os.cpus().length}`)
  console.log(`jess ${JESS_ROOT}   installs parseman ${pm.installed} — NOT what is measured here`)
  console.log(`loadavg at START ${loads()}   gate ${LOAD_CEILING}`)
  const { forced } = assertQuiet()
  console.log('')
  console.log('CANONICAL FIXTURE PROTOCOL — docs/design/canonical-fixture-benchmark.md')
  for (const line of protocol(M, variant)) console.log(line)
  if (forced) console.log('  *** FORCED PAST THE LOAD CEILING — these figures are NOT canonical ***')
  console.log('')

  const { rules } = await loadGrammar(dialect, variant)
  const interpreted = rules[ENTRY] as Entry
  const exec = execRules(encodeTable(rules, VARIANT_SETTINGS[variant]))[ENTRY] as Entry
  const execB = execRules(encodeTable(rules, VARIANT_SETTINGS[variant]))[ENTRY] as Entry
  const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, unknown>
  const assembled = (mod[exportName(dialect, variant)] as Record<string, unknown>)[ENTRY] as Entry
  if (typeof assembled !== 'function') throw new Error(`${dialect}: 'assembled' is not a function — the macro did not run`)
  if (typeof interpreted === 'function') throw new Error(`${dialect}: 'interpreted' is a function — macro lowering leaked`)

  for (const rel of FIXTURES[dialect]) {
    const p = resolvePath(JESS_ROOT, rel)
    if (!existsSync(p)) { console.log(`=== ${rel}  MISSING — not measured`); continue }
    const input = readFileSync(p, 'utf8')
    const bytes = Buffer.byteLength(input)
    const di = digest(interpreted, input)
    const dc = digest(assembled, input)
    const dt = digest(exec, input)
    const agree = di === dc && di === dt
    console.log(`=== ${rel}   ${bytes} B`)
    // A disagreement is REPORTED, and named. Silently skipping is how a fixture
    // an engine gets wrong stops appearing in anyone's numbers.
    if (!agree) {
      const who = di === dt ? 'the ASSEMBLED engine is the outlier — exec sides with the interpreter'
        : di === dc ? 'the EXEC reference is the outlier'
        : 'no two agree'
      console.log(`    three-way agreement: NO — ${who}`)
      const facets = FACETS.filter((_f, n) => {
        const [ri, rc, rt] = [rowOf(interpreted, input), rowOf(assembled, input), rowOf(exec, input)]
        return ri[n + 1] !== rc[n + 1] || ri[n + 1] !== rt[n + 1]
      })
      console.log(`    differing facets: ${facets.length > 0 ? facets.join(', ') : '(outside the facet set)'}`)
      console.log(`    parse ok: interp ${String(!di.startsWith('threw:'))}  assembled ${String(!dc.startsWith('threw:'))}  exec ${String(!dt.startsWith('threw:'))}`)
      // Timed ANYWAY, because this is the fixture that gets asked about by name
      // and "not measured" is a worse answer than a measured number with its
      // caveat attached. The three parses are NOT identical, so read the
      // milliseconds as indicative of cost, not as a like-for-like contest.
      console.log('    TIMED ANYWAY, CAVEATED: the three parses are not identical, so these')
      console.log('    milliseconds are indicative of cost and are NOT a like-for-like contest.')
      // HOW BIG is "not identical"? A caveat with no magnitude is unanswerable —
      // it licenses reading the whole gap as an artefact of the divergence, or
      // none of it. These three numbers bound it: if the engines build the same
      // number of nodes and differ on a handful of subtrees, the divergence is
      // not what a 2-3x gap is made of.
      const [ti, tc, tt] = [treeOf(interpreted, input), treeOf(assembled, input), treeOf(exec, input)]
      const [si, sc, st] = [treeStats(ti), treeStats(tc), treeStats(tt)]
      console.log(`    tree scale: interp ${si.nodes} nodes / ${si.bytes} B   assembled ${sc.nodes} / ${sc.bytes}   exec ${st.nodes} / ${st.bytes}`)
      console.log(`    minimal differing subtrees: assembled vs exec ${divergentSubtrees(tc, tt)}`
        + `   exec vs interp ${divergentSubtrees(tt, ti)}`)
      console.log(`    node-count delta assembled vs exec: ${sc.nodes - st.nodes} (${st.nodes === 0 ? 'n/a' : ((sc.nodes / st.nodes - 1) * 100).toFixed(2)}%)`)
      console.log('    Read the millisecond gap against THAT: an engine that built the same number')
      console.log('    of nodes did the same amount of allocation, whatever it labelled them.')
    } else {
      console.log('    three-way agreement: YES')
      console.log(`    parse ok: ${String(!di.startsWith('threw:'))}`)
    }

    const mk = (e: Entry, tag: string): Case[] => [{
      id: rel, detail: `${tag} ${bytes} B`,
      parse: () => { run(e, input) },
      run: (reps: number) => { for (let n = 0; n < reps; n++) run(e, input) },
    }]
    const reps = new Map([[rel, 1]])
    const contests: Contest[] = [
      { label: 'assembled -> exec', a: mk(assembled, 'assembled'), b: mk(exec, 'exec') },
      { label: 'CONTROL exec -> exec', a: mk(exec, 'exec'), b: mk(execB, 'exec') },
      { label: 'assembled -> interpreter', a: mk(assembled, 'assembled'), b: mk(interpreted, 'interp') },
    ]
    const out = interleave(contests, reps, M)
    const ms = (v: number[]): string => `${median(v).toFixed(2)} ms`
    const g = out.get('assembled -> exec')!
    const c = out.get('CONTROL exec -> exec')!
    const i = out.get('assembled -> interpreter')!
    const cm = median(g.get(`ref|${rel}`)!)
    const tm = median(g.get(`head|${rel}`)!)
    const im = median(i.get(`head|${rel}`)!)
    console.log('')
    console.log(`    ONE PARSE, median of ${M.rounds * M.runs} samples:`)
    console.log(`      assembled (shipped)  ${ms(g.get(`ref|${rel}`)!).padStart(10)}   ${(bytes / cm / 1000).toFixed(2)} MB/s`)
    console.log(`      exec (reference)     ${ms(g.get(`head|${rel}`)!).padStart(10)}   ${(bytes / tm / 1000).toFixed(2)} MB/s`)
    console.log(`      interpreter          ${ms(i.get(`head|${rel}`)!).padStart(10)}   ${(bytes / im / 1000).toFixed(2)} MB/s`)
    // NO RATIO COLUMN. It read `Nx codegen` and it was a ratio of the reference
    // interpreter to the assembler — neither of which is what either name said.
    // The ratio it is natural to want from this harness is table-lowering vs a
    // source lowering, and that quantity NO LONGER EXISTS: codegen.ts was deleted
    // in `37c57b5`. Absolute milliseconds against a named fixture and its byte
    // size are what this harness can honestly report, so that is all it prints.
    const ctlA = median(c.get(`ref|${rel}`)!), ctlB = median(c.get(`head|${rel}`)!)
    console.log(`      CONTROL exec/exec  ${sign((ctlB / ctlA - 1) * 100)} — this run's noise floor`)
    if (forced) console.log('      *** FORCED: taken over the load ceiling, NOT a canonical number ***')

    // THE COMPOSITION TAX, measured rather than left to be rediscovered.
    //
    // Every leg above shares ONE heap, and the interpreter allocates ~6x what
    // a table engine does per parse. Its garbage lands on its neighbours'
    // samples. Measured on `benchmark.less`: dropping the interpreter leg and
    // changing NOTHING else moved the exec leg by 18% while the assembled leg
    // did not move at all. (Those two legs were labelled `table` and `codegen`
    // when that was measured — see the import comment; the SHAPE of the finding
    // is unaffected, the NAMES on it were wrong.)
    //
    // That is why the canonical composition is PINNED, not why it is wrong: the
    // 3-leg shape is the one the standing reference figures were taken in, and
    // silently changing it would invalidate every number anyone remembers. So
    // the tax is REPORTED instead: the pinned figure stays comparable, and the
    // second line says how much of it is the harness.
    //
    // A lane optimising a table engine should watch BOTH. They move together; if
    // they ever stop, the change did something to allocation rather than to work.
    const soloOut = interleave([
      { label: 'assembled -> exec', a: mk(assembled, 'assembled'), b: mk(exec, 'exec') },
      { label: 'CONTROL exec -> exec', a: mk(exec, 'exec'), b: mk(execB, 'exec') },
    ], reps, M)
    const sg = soloOut.get('assembled -> exec')!
    const sc = soloOut.get('CONTROL exec -> exec')!
    const scm = median(sg.get(`ref|${rel}`)!)
    const stm = median(sg.get(`head|${rel}`)!)
    console.log('')
    console.log(`    SAME RUN, interpreter leg DROPPED — the composition tax:`)
    console.log(`      assembled (shipped)  ${scm.toFixed(2).padStart(7)} ms   ${sign((scm / cm - 1) * 100)} vs pinned`)
    console.log(`      exec (reference)     ${stm.toFixed(2).padStart(7)} ms   ${sign((stm / tm - 1) * 100)} vs pinned`)
    console.log(`      CONTROL exec/exec  ${sign((median(sc.get(`head|${rel}`)!) / median(sc.get(`ref|${rel}`)!) - 1) * 100)}`)
    console.log(`      The interpreter allocates ~6x a table engine per parse; they share one heap.`)
    console.log(`      Quote the PINNED figure — it is the one the reference was taken in — and read`)
    console.log(`      this one to know how much of it is the neighbour rather than the engine.`)
    console.log('')
  }
  console.log(`loadavg at END ${loads()}`)
  console.log('')
  console.log('  A figure from this harness is quotable only WITH the block above it: the sha, the')
  console.log('  loadavg at both ends, and the CONTROL row. A gap smaller than the control is not a')
  console.log('  result in either direction, and a run whose END load is far off its START load')
  console.log('  measured a moving box, ceiling or no ceiling.')
}

await main()
