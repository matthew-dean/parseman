/**
 * THE PER-GRAMMAR RELEASE A/B: jess's four SHIPPING dialect grammars, HEAD
 * against a pinned parseman release, in one process with a null control.
 *
 * ## What this measures, and what the neighbouring harnesses measure
 *
 * This file measures the SHIPPING grammars — the four `grammar.ts` files jess
 * actually ships — parsing the repo's own large fixtures, with parseman at HEAD
 * on one side and parseman at `referenceSha` (bench/jess/ab-config.json) on the
 * other. Both sides load the SAME grammar source; only the compiler underneath
 * moves. So a row here answers exactly one question: what did this release do to
 * the dialect a downstream parser ships?
 *
 * Two harnesses are easy to mistake for this one. They are not:
 *
 *   bench/jess/fixture.ts       Same grammars, same fixtures, EVERY LEG AT HEAD.
 *                               Its contests are `compiled -> table`, `CONTROL
 *                               table -> table` and `compiled -> interpreter`,
 *                               and its `ref|`/`head|` labels are a/b labels
 *                               WITHIN a contest, not a reference build. It
 *                               cannot answer "versus the last release", and a
 *                               previous report quoted its table-vs-table row as
 *                               if it were one. Reach for it to compare parseman's
 *                               three ENGINES against each other.
 *
 *   bench/workload-perf-guard.ts  The release gate, and the source of the
 *                               `materialise` + `interleave` machinery below —
 *                               but over parseman's OWN synthetic workloads in
 *                               `bench/workloads/`, not jess's grammars. Reach
 *                               for it to gate a release.
 *
 *   <jess>/scripts/bench-compare-ref.mjs   The COMPLEMENTARY axis, in the jess
 *                               repo: jess at HEAD against jess at a git ref,
 *                               with parseman held still (its own model string is
 *                               "jess-vs-jess"). It tracks grammar-side change
 *                               and sees parseman only indirectly, through
 *                               whatever version jess has installed. Reach for it
 *                               when the GRAMMAR moved. Reach for THIS file when
 *                               PARSEMAN moved. Neither substitutes for the
 *                               other, and running only the jess-side one is how
 *                               the whole table cutover went unrecorded.
 *
 *                               NOTE, verified 2026-08-06: it does not currently
 *                               run. Its `packageMap` points at
 *                               `<pkg>/test/bench.ts` for both css and less, and
 *                               those files are now `test/parse-bench.mjs` with a
 *                               different interface (no `--save`, no
 *                               `bench-results/latest.json`). Its newest committed
 *                               record is 2026-07-07, which is consistent with it
 *                               having broken around that rename. Fixing it is a
 *                               jess-repo change and is NOT done here.
 *
 * ## Same engine on both sides
 *
 * The comparison is CODEGEN vs CODEGEN by default, and a mixed pair is refused.
 * 0.46 has no `src/table/` — the table landed in the 0.47 stack — so the
 * tempting default of "each side's shipping engine" would fold "what did 0.47
 * do to the grammar" together with "how does the table compare to codegen",
 * which is fixture.ts's question, not this one. It also does not produce a
 * stable number; see `solo`.
 *
 * ## Reading a result — three things, not one
 *
 * 1. The CONTROL row: two independently loaded REFERENCE graphs, identical code,
 *    same positions. A gap smaller than it is NOT a result, in either direction.
 * 2. The PAIRING CROSS-CHECK: each leg also timed alone. If the paired and solo
 *    figures disagree, the pairing moved the measurement and nothing on the row
 *    is quotable. See `solo` for the artefact that put it there.
 * 3. The loadavg at both ends. Far apart means the box moved under the run.
 *
 * Usage:
 *   pnpm bench:jess:ab                       # less, codegen vs codegen
 *   pnpm bench:jess:ab css
 *   pnpm bench:jess:ab all
 *   pnpm bench:jess:ab less --ref=<sha>
 *   pnpm bench:jess:ab less --head-engine=interpreter --ref-engine=interpreter
 *   pnpm bench:jess:ab all --self          # HEAD against ITSELF — the noise floor
 *
 * RUN `--self` FIRST on any machine or node version this has not run on. It is
 * not ceremony: the first working version of this harness left the head legs
 * untagged and sharing one module graph, and `--self` read 3.70x. See buildLeg.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { interleave, materialise, median, sign, type Case, type Contest, type Measurement } from '../ab-harness.ts'
import { run } from '../../src/functional/run.ts'
import {
  DIALECTS, ENTRY, JESS_ROOT, LOAD_CEILING, VARIANT_SETTINGS,
  assertParseman, assertQuiet, exportName, headSha, loads,
  type Dialect,
} from './grammars.ts'
import { COLUMNS, FACETS, digestRow } from './digest.ts'

const GATE = 'jess-ab'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CONFIG_PATH = path.join(HERE, 'ab-config.json')

type Config = { referenceSha: string; measurement: Measurement }
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Config

const argValue = (flag: string): string | null =>
  process.argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null

/**
 * `--self` measures HEAD against ITSELF: same commit, both sides, every leg
 * built the same way. It must read flat, and it is the only thing that says so.
 *
 * It is not a nicety. The first working version of this harness left the head
 * legs untagged and sharing one module graph, and a self-check read 3.70x — a
 * bias big enough to have been reported as a release regression. Run it before
 * quoting any number from here on a machine or a node version this has not been
 * run on.
 */
const SELF = process.argv.includes('--self')
const cleanHeadSha = (): string => {
  const sha = headSha()
  if (sha.includes('dirty')) {
    throw new Error(`--self needs a clean src/: HEAD is ${sha}, and the reference side is a CHECKOUT of the sha, so the two sides would genuinely differ.`)
  }
  return sha
}
const REF = SELF ? cleanHeadSha() : argValue('--ref') ?? CONFIG.referenceSha
const M = CONFIG.measurement

/** The grammar module of each dialect, in the jess repo. */
const MODULE: Record<Dialect, string> = {
  css: 'packages/syntax/css/css-parser/src/grammar.ts',
  less: 'packages/syntax/less/less-parser/src/grammar.ts',
  scss: 'packages/syntax/scss/scss-parser/src/grammar.ts',
  jess: 'packages/syntax/jess/jess-parser/src/grammar.ts',
}

/**
 * The repo's own large fixtures, by dialect. Nothing here is synthesised.
 *
 * `benchmark.jess` is 124 B — SUB-MILLISECOND, and it is reported rather than
 * ranked on. A 0.1 ms row is dominated by `run()`'s own per-call cost and a
 * ratio taken from it says nothing about the grammar.
 */
const FIXTURES: Record<Dialect, string[]> = {
  css: ['packages/jess/benchmark/benchmark.css'],
  less: ['packages/jess/benchmark/benchmark.less', 'packages/jess/benchmark/gen-workload.less'],
  scss: ['packages/jess/benchmark/gen-workload.scss'],
  jess: ['packages/jess/benchmark/benchmark.jess'],
}

/** Under this many bytes a fixture is REPORTED but never ranked on. */
const RANKABLE_BYTES = 4096

/**
 * A leg timed ALONE, outside `interleave` — the cross-check every row carries.
 *
 * `interleave` is right about a lot: pairing two legs makes them share GC state,
 * cache state and run position, and that is what removes the directional bias a
 * block-structured harness has. What it cannot do is notice when the pairing
 * ITSELF has changed what it is measuring. Measured here, and the reason this
 * function exists: with a HEAD `table` leg and a 0.46 `codegen` leg interleaved,
 * the codegen leg read 5.35 ms on benchmark.css — against 19.2 ms from
 * bench/jess/fixture.ts, 19.4 ms from the same leg timed solo, 19.4 ms from two
 * 0.46 codegen legs alone, and 19.8 ms from the same harness with both engines
 * set to codegen. Five measurements agree and the interleaved mixed-engine one is
 * 3.6x off. Nothing in the output said so, and the figure was quotable.
 *
 * So every leg is also timed by itself, and the two numbers are printed side by
 * side. They should agree to within the control. When they do not, the row says
 * the pairing moved the measurement and the run is not quotable — which is a
 * cheap, permanent guard against a whole class of artefact that is otherwise
 * invisible.
 */
function solo(leg: Leg, input: string, m: Measurement): number {
  const once = (): void => { leg.run(leg.entry, input) }
  for (let i = 0; i < m.warmup + 2; i++) once()
  const samples: number[] = []
  for (let round = 0; round < m.rounds; round++) {
    const ts: number[] = []
    for (let k = 0; k < m.timed; k++) {
      const t0 = performance.now()
      once()
      ts.push(performance.now() - t0)
    }
    samples.push(median(ts))
  }
  return median(samples)
}

const ENGINES = ['table', 'codegen', 'interpreter'] as const
type Engine = (typeof ENGINES)[number]

type Entry = Parameters<typeof run>[0]
type Runner = (entry: Entry, input: string) => ReturnType<typeof run>

type Leg = { entry: Entry; run: Runner; engine: Engine; side: string }

type TableModule = {
  encodeTable: (rules: Record<string, unknown>, settings: unknown) => unknown
  tableRules: (t: unknown) => Record<string, unknown>
}

/**
 * ONE leg, in its OWN module graph, on the named side.
 *
 * EVERY leg goes through `pm-side:` — the HEAD ones too. That symmetry is the
 * whole reason a self-check (`--ref` = HEAD) means anything: with the head legs
 * left untagged and sharing one graph, a HEAD-vs-HEAD run read 3.70x, because
 * the interpreter leg's `composeLeaf()` fuse MUTATES the shared
 * `@jesscss/parser-shared` recognition pieces in place and de-optimised the
 * codegen leg beside it, while the reference side had no interpreter leg to do
 * that to it. Every leg isolated, both sides built the same way, and the
 * self-check reads flat.
 *
 * `run`, `encodeTable` and `tableRules` come from the SIDE'S OWN `src/`. A
 * reference leg driven by HEAD's `run()` is HEAD wearing the reference's name.
 */
async function buildLeg(side: string, engine: Engine, dialect: Dialect, src: string): Promise<Leg> {
  const grammarPath = path.resolve(JESS_ROOT, MODULE[dialect])
  const name = exportName(dialect, 'ast')
  const { run: runner } = await import(`pm-side:${side}:${path.join(src, 'functional/run.ts')}`) as { run: Runner }

  if (engine === 'codegen') {
    const mod = await import(`pm-side:${side}:macro:${grammarPath}`) as Record<string, Record<string, unknown>>
    const entry = mod[name]?.[ENTRY] as Entry
    if (typeof entry !== 'function') throw new Error(`${side} codegen: not a function — the macro did not run`)
    return { entry, run: runner, engine, side }
  }

  const mod = await import(`pm-side:${side}:${grammarPath}`) as Record<string, Record<string, unknown>>
  const grammar = mod[name]
  if (grammar === undefined) throw new Error(`${side}: no export ${name}`)
  // Realise the lazy getters: reading one fuses all of them, reading all of them
  // is what turns the map into a plain own-property record `encodeTable` wants.
  const rules: Record<string, unknown> = {}
  for (const k of Object.keys(grammar)) rules[k] = grammar[k]

  if (engine === 'interpreter') {
    const entry = rules[ENTRY] as Entry
    if (typeof entry === 'function') throw new Error(`${side} interpreter: got a function — macro lowering leaked`)
    return { entry, run: runner, engine, side }
  }

  if (!existsSync(path.join(src, 'table', 'encode.ts'))) {
    throw new Error(
      `${src} has no src/table/ — the table engine landed in the 0.47 stack, so --ref-engine=table `
      + 'cannot be honoured at this reference. Use codegen (the shipping engine there) or interpreter.',
    )
  }
  const enc = await import(`pm-side:${side}:${path.join(src, 'table/encode.ts')}`) as Pick<TableModule, 'encodeTable'>
  const exec = await import(`pm-side:${side}:${path.join(src, 'table/exec.ts')}`) as Pick<TableModule, 'tableRules'>
  const entry = exec.tableRules(enc.encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as Entry
  return { entry, run: runner, engine, side }
}

/** THE PROTOCOL, printed with the numbers. A figure without it is not quotable. */
function protocol(headEngine: Engine, refEngine: Engine, refSha: string): string[] {
  return [
    `  question    what did parseman HEAD do to a SHIPPING jess dialect, versus ${refSha}?`,
    `  grammars    jess's four real grammar.ts files, loaded from SOURCE (never lib/, which is a`,
    `              compiled artifact of an older parseman and does not even fuse for less/scss)`,
    `  fixtures    named files under jess's packages/jess/benchmark, read verbatim, byte size printed`,
    `  variant     ast — hostMode='ast', trackLines=false. Canonical by owner ruling.`,
    `  engines     HEAD ${headEngine}   vs   ${refSha} ${refEngine}. BOTH printed on every row, and a`,
    `              MIXED pair is refused by default — it folds the engine difference into the`,
    `              release difference, and was measured not to produce a stable number.`,
    `  binding     the reference leg loads the SAME grammar source through bench/jess/ab-hooks.mjs,`,
    `              which binds its 'parseman' and '@jesscss/parser-shared' to the reference`,
    `              worktree. @jesscss/core/ast is SHARED — identical on both sides, and one set of`,
    `              AST builders is what makes the two trees comparable by digest.`,
    `  process     ONE process, sides interleaved in adjacent order-alternated pairs`,
    `              (bench/ab-harness.ts interleave). Separate process launches on this hardware read`,
    `              9.4 ms and 26 ms for the same case; nothing survives that.`,
    `  composition PINNED at exactly two contests — the gate pair and the control — so the legs a`,
    `              figure was taken beside never change silently. They share one heap; adding a leg`,
    `              MOVES the others (measured elsewhere: 18% on benchmark.less).`,
    `  warmup      ${M.warmup} parses per side before any sample is kept`,
    `  sampling    ${M.rounds} rounds x ${M.runs} runs = ${M.rounds * M.runs} samples per side, ONE parse per repetition, each`,
    `              sample itself the median of ${M.timed} timed repetitions`,
    `  statistic   MEDIAN of the ${M.rounds * M.runs} samples. Not the min, not the mean.`,
    `  control     two INDEPENDENTLY LOADED reference graphs against each other. Identical code.`,
    `              Its delta is this run's noise floor; a gap smaller than it is not a result.`,
    `  cross-check every leg is ALSO timed alone, outside the pairing, and both figures printed.`,
    `              They must agree; when they do not, the pairing changed what was measured and`,
    `              the row says so. A mixed-engine pair once read 5.35 ms for a 19.4 ms leg.`,
    `  load gate   REFUSED above a 1-minute load average of ${LOAD_CEILING}. PM_FORCE=1 overrides and`,
    `              marks every figure FORCED.`,
  ]
}

function rowOf(leg: Leg, input: string): string[] {
  try { return digestRow(leg.run(leg.entry, input)) }
  catch (e) { return Array.from({ length: COLUMNS.length }, () => `threw:${(e as Error).message.split('\n')[0] ?? ''}`) }
}

/** The constructor `run()` returns its result in — see {@link identity}. */
function containerOf(leg: Leg, input: string): string {
  try {
    const r = leg.run(leg.entry, input) as unknown as { constructor?: { name?: string } }
    return r.constructor?.name ?? '(null-prototype)'
  } catch { return '(threw)' }
}

/**
 * Identity across two parseman RELEASES is the FACETS, not `whole`.
 *
 * `digestRow`'s first column digests the entire `RunResult`, and `digestValue`
 * TAGS every object with its constructor name — deliberately, so a refactor that
 * swaps one node class for another with the same fields cannot pass unnoticed.
 * Within one release that is exactly right. Across two it is not: 0.47 returns a
 * `RunResultRecord` where 0.46 returned a plain object, so `whole` differs on
 * EVERY file of EVERY dialect while all six facets — value, span, expected,
 * expected-order, errors, rootTrivia — agree byte for byte. Measured on
 * benchmark.css: every field digest equal, `whole` unequal, container the only
 * difference.
 *
 * Gating on `whole` here would report a total, permanent, meaningless
 * disagreement and drown the one thing this check exists to find. So the verdict
 * is the facets, and the container change is REPORTED by name rather than
 * silently normalised away — a container change is real, it is just not a change
 * to the parse.
 */
const FACET_COLS = FACETS.map((_f, n) => n + 1)
const identity = (row: string[]): string => FACET_COLS.map(n => row[n]).join('|')

async function measureDialect(
  dialect: Dialect, headSrc: string, refSrc: string, headEngine: Engine, refEngine: Engine, forced: boolean,
): Promise<void> {
  console.log(`\n################  ${dialect.toUpperCase()}  ${MODULE[dialect]}`)

  const head = await buildLeg('h1', headEngine, dialect, headSrc)
  const ref = await buildLeg('r1', refEngine, dialect, refSrc)
  const ref2 = await buildLeg('r2', refEngine, dialect, refSrc)
  // The third opinion, in its OWN graph. The identity question is three-way —
  // interpreter, HEAD engine, reference engine — and two agreeing engines out of
  // two prove nothing about which is right when they disagree. It gets its own
  // graph because the interpreted fuse mutates recognition pieces in place: built
  // beside the timed head leg it de-optimises it, which is precisely the bias the
  // self-check caught.
  const interp = headEngine === 'interpreter' ? head : await buildLeg('h2', 'interpreter', dialect, headSrc)

  for (const rel of FIXTURES[dialect]) {
    const p = path.resolve(JESS_ROOT, rel)
    if (!existsSync(p)) { console.log(`=== ${rel}  MISSING — not measured`); continue }
    const input = readFileSync(p, 'utf8')
    const bytes = Buffer.byteLength(input)
    console.log(`\n=== ${rel}   ${bytes} B`)

    const rh = rowOf(head, input), rr = rowOf(ref, input), ri = rowOf(interp, input)
    const [ih, ir, ii] = [identity(rh), identity(rr), identity(ri)]
    const threw = (r: string[]): boolean => r[0]!.startsWith('threw:')
    if (ih === ir && ih === ii) {
      console.log(`    three-way agreement (HEAD ${headEngine} / HEAD interpreter / ${REF} ${refEngine}): YES`)
      console.log(`    parse ok: ${String(!threw(rh))}   facets: ${FACETS.join(', ')}`)
    } else {
      // A disagreement OUTRANKS every timing number here, and it is named rather
      // than skipped: a fixture the engines get differently must not quietly stop
      // appearing in anyone's numbers.
      const who = ih === ii ? `the ${REF} ${refEngine} leg is the outlier`
        : ih === ir ? 'the HEAD INTERPRETER is the outlier'
        : ii === ir ? `the HEAD ${headEngine} leg is the outlier`
        : 'no two agree'
      console.log(`    three-way agreement: *** NO *** — ${who}`)
      const differing = FACETS.filter((_f, n) => rh[n + 1] !== rr[n + 1] || rh[n + 1] !== ri[n + 1])
      console.log(`    differing facets: ${differing.join(', ')}`)
      console.log(`    parse ok: HEAD ${String(!threw(rh))}  interp ${String(!threw(ri))}  ${REF} ${String(!threw(rr))}`)
      console.log('    TIMED ANYWAY, CAVEATED: the sides are not doing identical work, so the')
      console.log('    milliseconds below are indicative of cost and NOT a like-for-like contest.')
    }
    // The container is reported EVERY time, agreement or not: it is the reason
    // `whole` cannot be the verdict across releases, and a reader who does not
    // see it stated will reach for `whole` and get a permanent false red.
    if (rh[0] !== rr[0]) {
      console.log(`    whole-RunResult digest differs — container HEAD ${containerOf(head, input)}`
        + ` vs ${REF} ${containerOf(ref, input)}. Not a parse difference; see identity() in this file.`)
    }

    const mk = (leg: Leg, tag: string): Case[] => [{
      id: rel, detail: `${tag} ${bytes} B`,
      parse: () => { leg.run(leg.entry, input) },
      run: (reps: number) => { for (let n = 0; n < reps; n++) leg.run(leg.entry, input) },
    }]
    const reps = new Map([[rel, 1]])
    const contests: Contest[] = [
      { label: 'ref -> head', a: mk(ref, `${REF} ${refEngine}`), b: mk(head, `HEAD ${headEngine}`) },
      { label: 'CONTROL ref -> ref', a: mk(ref, `${REF} ${refEngine}`), b: mk(ref2, `${REF} ${refEngine}`) },
    ]
    const out = interleave(contests, reps, M)
    const g = out.get('ref -> head')!
    const c = out.get('CONTROL ref -> ref')!
    const rm = median(g.get(`ref|${rel}`)!)
    const hm = median(g.get(`head|${rel}`)!)
    const ctlA = median(c.get(`ref|${rel}`)!), ctlB = median(c.get(`head|${rel}`)!)
    console.log('')
    console.log(`    ONE PARSE, median of ${M.rounds * M.runs} samples:`)
    // Sub-millisecond fixtures print more places rather than a row of `0.00 ms`.
    // A figure the format rounds to zero is not reported, it is erased.
    const ms = (v: number): string => (v >= 1 ? v.toFixed(2) : v.toFixed(4)).padStart(8)
    console.log(`      HEAD    ${headEngine.padEnd(11)} ${ms(hm)} ms   ${(bytes / hm / 1000).toFixed(2)} MB/s`)
    console.log(`      ${REF} ${refEngine.padEnd(11)} ${ms(rm)} ms   ${(bytes / rm / 1000).toFixed(2)} MB/s`)
    console.log(`      ratio HEAD/${REF}   ${(hm / rm).toFixed(3)}x   (${sign((hm / rm - 1) * 100)} — negative is HEAD faster)`)
    const ctl = Math.abs(ctlB / ctlA - 1)
    console.log(`      CONTROL ref/ref     ${sign((ctlB / ctlA - 1) * 100)}   — this run's noise floor`)
    if (Math.abs(hm / rm - 1) <= ctl) {
      console.log('      ^ the gap is INSIDE the control. That is not a result in either direction.')
    }

    // THE PAIRING CROSS-CHECK. See `solo`.
    const hs = solo(head, input, M), rs = solo(ref, input, M)
    const drift = (paired: number, alone: number): number => paired / alone - 1
    console.log('')
    console.log('    SAME LEGS, TIMED ALONE — does the pairing agree with itself?')
    console.log(`      HEAD    ${headEngine.padEnd(11)} ${ms(hs)} ms   paired ${sign(drift(hm, hs) * 100)}`)
    console.log(`      ${REF} ${refEngine.padEnd(11)} ${ms(rs)} ms   paired ${sign(drift(rm, rs) * 100)}`)
    // A tolerance of 5x the control, and no tighter: a solo leg genuinely runs in
    // a different GC and cache environment, so small drift is expected and is not
    // what this is looking for. It is looking for the 3.6x kind.
    const tol = Math.max(5 * ctl, 0.15)
    const worst = Math.max(Math.abs(drift(hm, hs)), Math.abs(drift(rm, rs)))
    if (worst > tol && bytes >= RANKABLE_BYTES) {
      console.log(`      *** PAIRING ARTEFACT: a leg moved ${(worst * 100).toFixed(0)}% between paired and solo,`)
      console.log(`          past this run's ${(tol * 100).toFixed(0)}% tolerance. The interleaved figures above are NOT`)
      console.log('          quotable — the pairing changed what was being measured, not the compiler.')
      console.log('          This is exactly how a mixed-engine run read 5.35 ms for a 19.4 ms leg.')
    }
    if (bytes < RANKABLE_BYTES) {
      console.log(`      ^ ${bytes} B is SUB-MILLISECOND work. Reported, NOT ranked on: at this size the`)
      console.log('        figure is dominated by run()\'s own per-call cost, not by the grammar.')
    }
    if (forced) console.log('      *** FORCED: taken over the load ceiling, NOT a canonical number ***')
  }
}

async function main(): Promise<void> {
  const pm = await assertParseman()
  const first = process.argv[2]
  const requested = first === undefined || first.startsWith('--') ? 'less' : first
  const dialects: Dialect[] = requested === 'all' ? [...DIALECTS] : [requested as Dialect]
  for (const d of dialects) if (!DIALECTS.includes(d)) throw new Error(`unknown dialect '${d}'`)
  const headEngine = (argValue('--head-engine') ?? 'codegen') as Engine
  const refEngine = (argValue('--ref-engine') ?? 'codegen') as Engine
  for (const e of [headEngine, refEngine]) if (!ENGINES.includes(e)) throw new Error(`unknown engine '${e}'`)
  // MIXED ENGINES ARE REFUSED, and the default is codegen on BOTH sides.
  //
  // The obvious default was HEAD's shipping engine (table) against the
  // reference's (codegen, since 0.46 has no table). It is wrong twice over. It is
  // not an A/B of the RELEASE — it folds "what did 0.47 do" together with "how
  // does the table compare to codegen", which bench/jess/fixture.ts already
  // answers at HEAD. And, measured, it does not even produce a stable number: the
  // 0.46 codegen leg interleaved against a HEAD table leg read 5.35 ms on
  // benchmark.css where five other measurements of that same leg read 19.2-19.8.
  // See `solo` for the full list.
  //
  // So: same engine both sides, which at this anchor means codegen, and the
  // table-vs-codegen question stays where it belongs, in fixture.ts.
  if (headEngine !== refEngine && !process.argv.includes('--allow-mixed-engines')) {
    throw new Error(
      `refusing --head-engine=${headEngine} with --ref-engine=${refEngine}. A release A/B compares the SAME `
      + 'engine on both sides; a mixed pair folds the engine difference into the release difference, and it was '
      + 'MEASURED to produce a leg reading 5.35 ms where every other measurement of it read 19.2-19.8 ms. '
      + 'For table-vs-codegen at HEAD use bench/jess/fixture.ts. --allow-mixed-engines overrides, and the '
      + 'pairing cross-check on every row is what will tell you the number is junk.',
    )
  }

  // Materialise the reference and hand its `src/` to the loader. The hooks run on
  // their own thread with a SNAPSHOT of the environment taken at register() time,
  // so this cannot be an env var set from here — hence the pointer file, read
  // lazily by the first tagged resolve. See ab-hooks.mjs.
  const refDir = materialise(GATE, ROOT, REF, [])
  const refSrc = path.join(refDir, 'src')
  mkdirSync(path.join(ROOT, '.cache'), { recursive: true })
  writeFileSync(path.join(ROOT, '.cache', 'jess-ab-refsrc'), refSrc)
  const refSha = (JSON.parse(readFileSync(path.join(refDir, 'package.json'), 'utf8')) as { version: string }).version
  const headSrc = path.join(ROOT, 'src')

  console.log(`${GATE}: ${SELF
    ? `SELF-CHECK — ${REF} against itself. Identical code on both sides; this MUST read flat.`
    : `HEAD ${headSha()} (parseman ${pm.version}) vs reference ${REF} (parseman ${refSha})`}`)
  console.log(`  HEAD src      ${headSrc}`)
  console.log(`  reference src ${refSrc}`)
  console.log(`  jess          ${JESS_ROOT}   (READ ONLY here; it installs parseman ${pm.installed}, which is NOT what is measured)`)
  console.log(`node ${process.version}   ${os.platform()}/${os.arch()}   cpus ${os.cpus().length}`)
  console.log(`loadavg at START ${loads()}   gate ${LOAD_CEILING}`)
  const { forced } = assertQuiet()
  console.log('')
  for (const line of protocol(headEngine, refEngine, REF)) console.log(line)
  if (forced) console.log('  *** FORCED PAST THE LOAD CEILING — these figures are NOT canonical ***')

  for (const d of dialects) await measureDialect(d, headSrc, refSrc, headEngine, refEngine, forced)

  console.log(`\nloadavg at END ${loads()}`)
  console.log('')
  console.log('  A figure from this harness is quotable only WITH the block above it: both shas, both')
  console.log('  engine names, the loadavg at each end, and the CONTROL row. A gap smaller than the')
  console.log('  control is not a result in either direction, and a run whose END load is far off its')
  console.log('  START load measured a moving box, ceiling or no ceiling.')
}

await main()
