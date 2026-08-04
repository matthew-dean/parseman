/**
 * ABSOLUTE parse time, in milliseconds, on jess's canonical large fixtures.
 *
 * Ratios and MB/s do not let anyone compare against a number they already know.
 * This reports the wall time of ONE parse of ONE named fixture, with the fixture
 * named and its byte size printed, for all three engines.
 *
 * THE PATH IS THE AST PATH — `hostMode: 'ast'`, `trackLines: false` — the same
 * canonical measure `speed.ts` uses. Same one-process `interleave` engine, same
 * table-vs-table CONTROL contest.
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
import { tableRules } from '../../src/table/exec.ts'
import { ENTRY, JESS_ROOT, VARIANT_SETTINGS, assertParseman, exportName, loadGrammar, type Dialect } from './grammars.ts'
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
  console.log(`parseman ${pm.version}   ${pm.root}   node ${process.version}`)
  console.log(`cpus ${os.cpus().length}   loadavg at START ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
  console.log(`variant  hostMode=ast trackLines=false — THE AST PATH`)
  console.log('')

  const { rules } = await loadGrammar(dialect, 'ast')
  const interpreted = rules[ENTRY] as Entry
  const table = tableRules(encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as Entry
  const tableB = tableRules(encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as Entry
  const mod = await import(`pm-macro:${resolvePath(JESS_ROOT, MODULE[dialect])}`) as Record<string, unknown>
  const compiled = (mod[exportName(dialect, 'ast')] as Record<string, unknown>)[ENTRY] as Entry
  if (typeof compiled !== 'function') throw new Error(`${dialect}: 'compiled' is not a function — the macro did not run`)
  if (typeof interpreted === 'function') throw new Error(`${dialect}: 'interpreted' is a function — macro lowering leaked`)

  for (const rel of FIXTURES[dialect]) {
    const p = resolvePath(JESS_ROOT, rel)
    if (!existsSync(p)) { console.log(`=== ${rel}  MISSING — not measured`); continue }
    const input = readFileSync(p, 'utf8')
    const bytes = Buffer.byteLength(input)
    const di = digest(interpreted, input)
    const dc = digest(compiled, input)
    const dt = digest(table, input)
    const agree = di === dc && di === dt
    console.log(`=== ${rel}   ${bytes} B`)
    // A disagreement is REPORTED, and named. Silently skipping is how a fixture
    // the table gets wrong stops appearing in anyone's numbers.
    if (!agree) {
      const who = di === dt ? 'the COMPILED engine is the outlier — table sides with the interpreter'
        : di === dc ? 'the TABLE is the outlier'
        : 'no two agree'
      console.log(`    three-way agreement: NO — ${who}`)
      const facets = FACETS.filter((_f, n) => {
        const [ri, rc, rt] = [rowOf(interpreted, input), rowOf(compiled, input), rowOf(table, input)]
        return ri[n + 1] !== rc[n + 1] || ri[n + 1] !== rt[n + 1]
      })
      console.log(`    differing facets: ${facets.length > 0 ? facets.join(', ') : '(outside the facet set)'}`)
      console.log(`    parse ok: interp ${String(!di.startsWith('threw:'))}  compiled ${String(!dc.startsWith('threw:'))}  table ${String(!dt.startsWith('threw:'))}`)
      // Timed ANYWAY, because this is the fixture that gets asked about by name
      // and "not measured" is a worse answer than a measured number with its
      // caveat attached. The three parses are NOT identical, so read the
      // milliseconds as indicative of cost, not as a like-for-like contest.
      console.log('    TIMED ANYWAY, CAVEATED: the three parses are not identical, so these')
      console.log('    milliseconds are indicative of cost and are NOT a like-for-like contest.')
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
      { label: 'compiled -> table', a: mk(compiled, 'compiled'), b: mk(table, 'table') },
      { label: 'CONTROL table -> table', a: mk(table, 'table'), b: mk(tableB, 'table') },
      { label: 'compiled -> interpreter', a: mk(compiled, 'compiled'), b: mk(interpreted, 'interp') },
    ]
    const out = interleave(contests, reps, M)
    const ms = (v: number[]): string => `${median(v).toFixed(2)} ms`
    const g = out.get('compiled -> table')!
    const c = out.get('CONTROL table -> table')!
    const i = out.get('compiled -> interpreter')!
    const cm = median(g.get(`ref|${rel}`)!)
    const tm = median(g.get(`head|${rel}`)!)
    const im = median(i.get(`head|${rel}`)!)
    console.log('')
    console.log(`    ONE PARSE, median of ${M.rounds * M.runs} samples:`)
    console.log(`      codegen (shipped)  ${ms(g.get(`ref|${rel}`)!).padStart(10)}   ${(bytes / cm / 1000).toFixed(2)} MB/s`)
    console.log(`      table              ${ms(g.get(`head|${rel}`)!).padStart(10)}   ${(bytes / tm / 1000).toFixed(2)} MB/s   ${(tm / cm).toFixed(2)}x codegen`)
    console.log(`      interpreter        ${ms(i.get(`head|${rel}`)!).padStart(10)}   ${(bytes / im / 1000).toFixed(2)} MB/s   ${(im / cm).toFixed(2)}x codegen`)
    const ctlA = median(c.get(`ref|${rel}`)!), ctlB = median(c.get(`head|${rel}`)!)
    console.log(`      CONTROL table/table ${sign((ctlB / ctlA - 1) * 100)} — this run's noise floor`)
    console.log('')
  }
  console.log(`loadavg at END ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`)
}

await main()
