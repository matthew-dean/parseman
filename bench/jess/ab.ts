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
 * ## Same MACRO on both sides — NOT the same engine
 *
 * The comparison is MACRO vs MACRO by default, and a mixed pair is refused. 0.46
 * has no `src/table/` — the table landed in the 0.47 stack — so the tempting
 * default of "each side's shipping engine" would fold "what did 0.47 do to the
 * grammar" together with "how does the table compare to codegen", which is
 * fixture.ts's question, not this one. It also does not produce a stable number;
 * see `solo`.
 *
 * THIS SECTION USED TO SAY "Same engine on both sides", AND IT WAS FALSE. The
 * flag was spelled `codegen` and defaulted on both sides, but `codegen` only ever
 * named the MACRO — and `src/compiler/codegen.ts` is DELETED at HEAD, where the
 * macro instead routes `compileLinkableTable` → `compileRuleMapRunnable` →
 * `assembledRules` → the emitted assembly. So the banner announced one engine
 * while the run measured 0.46's source lowering against HEAD's emitted table.
 * The harness could already SEE it — the leg shapes read `entryFn 888 B` against
 * `(anon) 406 B`, and `Leg`'s own comment says two legs whose shapes differ "are
 * not comparable no matter what the engine LABELS say" — and it printed the
 * mismatch and carried on under the contrary headline.
 *
 * The COMPARISON is left exactly as it was: each side's macro output is what a
 * user of that release gets, which is the right thing for a release A/B. Only the
 * CLAIM is corrected. `Leg.lowering` is detected per side and printed, and the
 * banner names the two lowerings rather than asserting they are one.
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
 *   pnpm bench:jess:ab                       # less, macro vs macro (see above)
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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
/**
 * TWO GRAPHS, AND NOTHING ELSE — the only configuration measured to be unbiased.
 *
 * The rich configuration realises seven module graphs per dialect (the gate pair,
 * two control pairs, the identity interpreter). MEASURED, that is the confound:
 *
 *   2 graphs (head, ref)            benchmark.less  33.11 / 33.87 ms   0.98x
 *   6 graphs (3 per side)           benchmark.css   h1 12.6  h3 12.7  h4 15.5
 *                                                   r1 15.2  r2 15.3  r3 15.1
 *
 * `h4` is a HEAD leg on HEAD's own `src/`, and it runs with the reference legs,
 * not with its own side. So the split is not head-versus-reference and not the
 * `.cache` copy: graphs realised beyond the first couple run ~18-20% slower, and
 * the effect is stable across rounds and does NOT move when the reference group is
 * constructed first (0.837x head-first, 0.856x ref-first — the same answer).
 *
 * Since the head leg was always among the earliest graphs and the reference legs
 * later, EVERY ratio this harness printed carried that bias, in the direction that
 * makes HEAD look faster. `--self` read 0.820x-0.839x on css and both less
 * fixtures with every control inside 1.9%.
 *
 * So the timed comparison gets its own process with exactly two graphs in it. The
 * noise floor is a SEPARATE `--self --two-graph` run of the identical shape rather
 * than an in-process control leg, because an in-process control is a third graph
 * and a third graph is the thing being avoided. Identity checking keeps the rich
 * mode, where realising an interpreter costs nothing that matters.
 */
const TWO_GRAPH = process.argv.includes('--two-graph')
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

// `macro` WAS SPELLED `codegen`, and the rename is the point: it selects the
// MACRO, and what the macro lowers to is a property of the side. `codegen` is
// still accepted so committed invocations keep working, and is normalised below.
const ENGINES = ['table', 'macro', 'interpreter'] as const
type Engine = (typeof ENGINES)[number]
const normEngine = (e: string): Engine => (e === 'codegen' ? 'macro' : e) as Engine

type Entry = Parameters<typeof run>[0]
type Runner = (entry: Entry, input: string) => ReturnType<typeof run>

/**
 * `provenance` is not decoration — it is the only thing that can distinguish a
 * release difference from the two sides running DIFFERENT CODE.
 *
 * A leg is a triple: which `src/` compiled it, which engine it ended up in, and
 * what `run()` it is driven by. All three were previously invisible, and each of
 * them has already been wrong once here: a chimera leg (`h<n>` given a non-HEAD
 * `src`), a mixed-engine pair, and a stale reference pointer. `assertSideMatchesSrc`
 * catches the first by construction; the other two are only catchable by LOOKING,
 * so every row now prints what it actually ran.
 *
 * `shape` is the discriminator that costs nothing and settles the "is one side on
 * the emitted engine and the other on the closure engine?" question outright: an
 * emitted entry is a generated function of some size, an interpreted one is a
 * combinator object, and a table entry is a closure over encoded rows. Two legs
 * whose shapes differ are not comparable no matter what the engine LABELS say.
 */
type Leg = {
  entry: Entry
  run: Runner
  engine: Engine
  side: string
  /** `realpath` of the `src/` this leg's compiler and `run()` came from. */
  srcReal: string
  /** `typeof` the entry, plus its source size when it is a function. */
  shape: string
  /**
   * WHAT THE MACRO ACTUALLY LOWERED TO on this side — detected, never assumed.
   *
   * `engine: 'macro'` names a REQUEST ("lower this grammar with the macro"), and
   * the answer is a property of the side's `src/`, not of the flag. 0.46 has
   * `src/compiler/codegen.ts` and lowers to generated source; HEAD deleted it and
   * the macro routes `compileLinkableTable` → `compileRuleMapRunnable` →
   * `assembledRules` → the EMITTED ASSEMBLY. So the historic default of
   * `codegen` on both sides names one engine and runs two.
   *
   * That is still the right comparison for a RELEASE — it is what users get on
   * each side — but it is not the same engine, and this field is what stops the
   * banner claiming otherwise.
   */
  lowering: string
}

/**
 * The macro's realised lowering for one `src/`, from the FILE that decides it.
 *
 * `src/compiler/codegen.ts` is the source lowerer. Its presence is the whole
 * discriminator, and it is checked on the side's own tree rather than inferred
 * from a version string, because a `--ref=<sha>` may sit anywhere in the stack.
 */
function loweringOf(engine: Engine, src: string): string {
  if (engine !== 'macro') return engine
  return existsSync(path.join(src, 'compiler', 'codegen.ts')) ? 'macro→source' : 'macro→emitted'
}

/** What the entry actually IS, in a form two legs can be compared on. */
function shapeOf(entry: unknown): string {
  if (typeof entry === 'function') return `fn ${(entry as { name: string }).name || '(anon)'} ${String(entry).length} B`
  if (typeof entry === 'object' && entry !== null) return `obj ${entry.constructor?.name ?? '(null-proto)'} keys=${Object.keys(entry).length}`
  return typeof entry
}

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
/** This worktree's `src/`, resolved the same way `ab-hooks.mjs` resolves it. */
const HEAD_SRC = path.resolve(HERE, '../../src')

/**
 * A LEG'S SIDE LETTER AND ITS `src` MUST AGREE, or the leg is two versions at once.
 *
 * `ab-hooks.mjs`'s `srcOf()` maps every `h<n>` side to HEAD unconditionally and
 * never sees this `src` argument. So `buildLeg('h1', …, anchorSrc)` loads the
 * ANCHOR's modules by absolute path while every bare `parseman` underneath them —
 * and the macro that lowers the grammar — comes from HEAD. The `src` argument is
 * silently half-ignored and the result is a chimera.
 *
 * That is not hypothetical: the first pass of the 0.46-vs-0.47 sweep did exactly
 * this and read 44.65 ms for 0.46 against the same anchor's 17.34 ms — a 2.5x
 * "self-check" that looked like a real finding. Both legs of an anchor must be
 * `r<n>`.
 *
 * Cheap to check and impossible to get wrong once checked: an `h` side must be
 * HEAD's `src/`, an `r` side must not be — with the ONE exception of a deliberate
 * self-check, where the reference IS head and both legs are still built `r<n>`.
 */
function assertSideMatchesSrc(side: string, src: string): void {
  const isHead = path.resolve(src) === path.resolve(HEAD_SRC)
  if (/^h\d+$/.test(side) && !isHead) {
    throw new Error(
      `leg '${side}' was given src ${src}, which is not this worktree's ${HEAD_SRC}. `
      + "`srcOf()` maps every h-side to HEAD, so this leg would load that src's modules by path while "
      + 'every bare `parseman` under them — and the macro lowering the grammar — came from HEAD. '
      + 'That is a two-version chimera, and it previously produced a convincing 2.5x self-check. '
      + 'Both legs of an anchor must be r<n>.',
    )
  }
}

async function buildLeg(side: string, engine: Engine, dialect: Dialect, src: string): Promise<Leg> {
  assertSideMatchesSrc(side, src)
  const grammarPath = path.resolve(JESS_ROOT, MODULE[dialect])
  const name = exportName(dialect, 'ast')
  const { run: runner } = await import(`pm-side:${side}:${path.join(src, 'functional/run.ts')}`) as { run: Runner }

  const srcReal = realpathSync(src)

  const lowering = loweringOf(engine, src)

  if (engine === 'macro') {
    const mod = await import(`pm-side:${side}:macro:${grammarPath}`) as Record<string, Record<string, unknown>>
    const entry = mod[name]?.[ENTRY] as Entry
    if (typeof entry !== 'function') throw new Error(`${side} macro: not a function — the macro did not run`)
    return { entry, run: runner, engine, side, srcReal, shape: shapeOf(entry), lowering }
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
    return { entry, run: runner, engine, side, srcReal, shape: shapeOf(entry), lowering }
  }

  if (!existsSync(path.join(src, 'table', 'encode.ts'))) {
    throw new Error(
      `${src} has no src/table/ — the table engine landed in the 0.47 stack, so --ref-engine=table `
      + 'cannot be honoured at this reference. Use macro (the shipping lowering there) or interpreter.',
    )
  }
  const enc = await import(`pm-side:${side}:${path.join(src, 'table/encode.ts')}`) as Pick<TableModule, 'encodeTable'>
  const exec = await import(`pm-side:${side}:${path.join(src, 'table/exec.ts')}`) as Pick<TableModule, 'tableRules'>
  const entry = exec.tableRules(enc.encodeTable(rules, VARIANT_SETTINGS.ast))[ENTRY] as Entry
  return { entry, run: runner, engine, side, srcReal, shape: shapeOf(entry), lowering }
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
    `  composition THREE hot graphs PER SIDE, symmetric by construction: the gate pair (h1/r1,`,
    `              used nowhere else) plus one control pair on each side. They share one heap and`,
    `              adding a leg MOVES the others by ~18% on benchmark.less, so the two sides must`,
    `              carry the SAME number of legs. They did not: the reference leg was the 'a' side`,
    `              of both the gate and the control, giving the reference side two hot graphs to`,
    `              the head side's one, and --self read 0.835x/0.822x on the two less fixtures`,
    `              against controls of +0.3%/-0.1% — a 17-18% bias flattering HEAD.`,
    `  warmup      ${M.warmup} parses per side before any sample is kept`,
    `  sampling    ${M.rounds} rounds x ${M.runs} runs = ${M.rounds * M.runs} samples per side, ONE parse per repetition, each`,
    `              sample itself the median of ${M.timed} timed repetitions`,
    `  statistic   MEDIAN of the ${M.rounds * M.runs} samples. Not the min, not the mean.`,
    `  control     ONE PER SIDE — two independently loaded graphs of the SAME build against each`,
    `              other, on the reference side and on the head side. Identical code in both cases.`,
    `              The WORSE of the two deltas is this run's noise floor; a gap smaller than it is`,
    `              not a result. A control that is flat on one side and not the other is a finding.`,
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

/**
 * DID THE LEG PARSE THE FILE, or did it stop 218 bytes in?
 *
 * `parse ok` used to be `!row[0].startsWith('threw:')` — which reports whether
 * `run()` THREW, and a failing parse does not throw. It returns `ok: false` with
 * `span` at the failure position, and the old line printed `parse ok: true` for
 * it.
 *
 * That is not a cosmetic wrong label. `gen-workload.scss` is 287,543 B and HEAD
 * stops at byte 218 of it; the row read `HEAD 0.1615 ms` against the reference's
 * `34.64 ms`, printed `1780 MB/s` — computed from the file's FULL size, none of
 * which was parsed — and ranked it `0.005x`, i.e. as a 200-fold SPEEDUP. It was a
 * grammar the release had stopped being able to parse, and every part of the row
 * was consistent with a triumph.
 *
 * So acceptance and the consumed-byte count are read off the RunResult directly
 * and printed on every row, and a row that did not consume its file is refused a
 * ratio. A throughput figure over bytes nobody looked at is not slow or fast, it
 * is nothing.
 */
type Outcome = { threw: boolean; ok: boolean; consumed: number; at: number; detail: string }
function outcomeOf(leg: Leg, input: string, bytes: number): Outcome {
  try {
    const r = leg.run(leg.entry, input) as unknown as {
      ok?: boolean; span?: { start?: number; end?: number }
    }
    const ok = r.ok === true
    const consumed = ok ? r.span?.end ?? 0 : 0
    const at = r.span?.start ?? 0
    return {
      threw: false, ok, consumed, at,
      detail: ok
        ? consumed >= bytes ? 'parsed in full' : `ACCEPTED only ${consumed} of ${bytes} B`
        : `FAILED at byte ${at} of ${bytes}`,
    }
  } catch (e) {
    return { threw: true, ok: false, consumed: 0, at: 0, detail: `THREW: ${(e as Error).message.split('\n')[0] ?? ''}` }
  }
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

  // THE GATE PAIR — h1 and r1 — and nothing else touches either of them.
  const head = await buildLeg('h1', headEngine, dialect, headSrc)
  const ref = await buildLeg('r1', refEngine, dialect, refSrc)
  // A CONTROL PAIR PER SIDE. Three hot graphs on each side, symmetric by
  // construction; see the `contests` comment for the 17-18% this cost while the
  // reference side carried two hot legs and the head side carried one.
  const ref2 = TWO_GRAPH ? null : await buildLeg('r2', refEngine, dialect, refSrc)
  const ref3 = TWO_GRAPH ? null : await buildLeg('r3', refEngine, dialect, refSrc)
  const head2 = TWO_GRAPH ? null : await buildLeg('h3', headEngine, dialect, headSrc)
  const head3 = TWO_GRAPH ? null : await buildLeg('h4', headEngine, dialect, headSrc)
  // The third opinion, in its OWN graph. The identity question is three-way —
  // interpreter, HEAD engine, reference engine — and two agreeing engines out of
  // two prove nothing about which is right when they disagree. It gets its own
  // graph because the interpreted fuse mutates recognition pieces in place: built
  // beside the timed head leg it de-optimises it, which is precisely the bias the
  // self-check caught.
  // The identity leg is a THIRD graph, so `--two-graph` does not build it and the
  // three-way check is skipped there. Identity is the rich mode's job; this mode
  // exists only to produce a millisecond that is not 18% wrong.
  const interp = headEngine === 'interpreter' || TWO_GRAPH
    ? head
    : await buildLeg('h2', 'interpreter', dialect, headSrc)

  // WHAT EACH LEG ACTUALLY IS, before any millisecond is printed. See `Leg`.
  // A self-check that reads 17% apart on identical code is answered here or not
  // at all: if the two sides' `src` realpaths or entry shapes differ, that is the
  // finding, and no amount of re-running the timing will produce a better one.
  console.log(`    legs (${TWO_GRAPH ? 'TWO-GRAPH mode — the only shape measured to be unbiased' : 'rich mode — see --two-graph'}):`)
  for (const l of [head, ref, ref2, ref3, head2, head3, interp].filter((l): l is Leg => l !== null)) {
    console.log(`      ${l.side.padEnd(3)} ${l.engine.padEnd(11)} ${l.lowering.padEnd(14)} ${l.shape.padEnd(34)} ${l.srcReal}`)
  }
  // THE ENGINE CLAIM, MADE FROM WHAT WAS DETECTED rather than from the flags.
  // Same request on both sides does NOT imply same engine — see the header. The
  // gate pair is the only pair whose lowerings decide how a row may be read.
  if (head.lowering === ref.lowering) {
    console.log(`    engine: SAME on both sides — ${head.lowering}`)
  } else {
    console.log(`    engine: DIFFERENT — head ${head.lowering}, ref ${ref.lowering}`)
    console.log('      This is a release A/B (each side\'s macro output is what that release ships),')
    console.log('      NOT an engine-held-still comparison. Do not quote a row here as the cost of a')
    console.log('      grammar change: it also carries the lowering change. fixture.ts holds the')
    console.log('      release still and moves the engine, which is the other half.')
  }

  for (const rel of FIXTURES[dialect]) {
    const p = path.resolve(JESS_ROOT, rel)
    if (!existsSync(p)) { console.log(`=== ${rel}  MISSING — not measured`); continue }
    const input = readFileSync(p, 'utf8')
    const bytes = Buffer.byteLength(input)
    console.log(`\n=== ${rel}   ${bytes} B`)

    const rh = rowOf(head, input), rr = rowOf(ref, input), ri = rowOf(interp, input)
    const [ih, ir, ii] = [identity(rh), identity(rr), identity(ri)]
    // ACCEPTANCE, read off the RunResult rather than inferred from the absence of
    // a throw. See `outcomeOf` — this line is the one that was lying.
    const oh = outcomeOf(head, input, bytes)
    const or = outcomeOf(ref, input, bytes)
    const oi = outcomeOf(interp, input, bytes)
    console.log(`    parse:  HEAD ${headEngine} ${oh.detail}`)
    if (!TWO_GRAPH) console.log(`            HEAD interpreter ${oi.detail}`)
    console.log(`            ${REF} ${refEngine} ${or.detail}`)
    if (TWO_GRAPH) {
      console.log('    identity: NOT CHECKED — the interpreter is a third graph. Run without')
      console.log('              --two-graph for the three-way check.')
    } else if (ih === ir && ih === ii) {
      console.log(`    three-way agreement (HEAD ${headEngine} / HEAD interpreter / ${REF} ${refEngine}): YES`)
      console.log(`    facets: ${FACETS.join(', ')}`)
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
      console.log('    TIMED ANYWAY, CAVEATED: the sides are not doing identical work, so the')
      console.log('    milliseconds below are indicative of cost and NOT a like-for-like contest.')
    }
    // A leg that did not consume the file is not a slower or faster parse of it —
    // it is not a parse of it. Say so where the ratio would otherwise be read.
    const bothParsed = oh.consumed >= bytes && or.consumed >= bytes
    if (!bothParsed) {
      console.log('    *** NO RATIO IS QUOTABLE FOR THIS ROW: a side did not consume the file.')
      console.log(`        HEAD consumed ${oh.consumed} B, ${REF} consumed ${or.consumed} B, of ${bytes} B.`)
      console.log('        The milliseconds below are the cost of REACHING THE FAILURE, and the MB/s')
      console.log('        figures are computed over bytes that side never looked at.')
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
    /**
     * ONE CONTROL PER SIDE, and the gate's legs are not reused by either.
     *
     * The composition this replaces was: gate `ref -> head`, control `ref -> ref2`.
     * Read as a set of hot parsers rather than as two contests, that is THREE hot
     * codegen graphs on the reference side (r1 twice over, r2) and ONE on the head
     * side (h1) — because `ref` was the `a` side of BOTH contests. The head leg
     * therefore ran in a lightly-loaded heap and the reference legs in a crowded
     * one, and the file's own protocol block already knew what that is worth:
     * "adding a leg MOVES the others (measured elsewhere: 18% on benchmark.less)".
     *
     * MEASURED, on this composition, `--self` — HEAD against a checkout of the SAME
     * commit, byte-identical `src/`, macro lowerings verified byte-identical, entry
     * functions the same 888 B — read 0.835x on benchmark.less and 0.822x on
     * gen-workload.less against controls of +0.3% and -0.1%, and the gap survived
     * the solo cross-check. A 17-18% instrument bias, in the direction that makes
     * HEAD look FASTER, sitting under every ratio this harness has ever printed.
     *
     * So: three graphs per side, symmetric by construction. The gate pair is h1/r1
     * and neither appears anywhere else; each side's control is its own untouched
     * pair. Two noise floors get printed instead of one, which is strictly more
     * information — a control that is flat on one side and not the other is itself
     * a finding, and the old single control could not express it.
     *
     * This costs two more graphs, and the absolute milliseconds rise accordingly
     * (~18% for everyone, measured). That is the correct trade: the ratio is what
     * this harness exists to produce, and it is now taken between two legs that
     * were treated identically.
     */
    const contests: Contest[] = [
      { label: 'ref -> head', a: mk(ref, `${REF} ${refEngine}`), b: mk(head, `HEAD ${headEngine}`) },
    ]
    if (ref2 !== null && ref3 !== null && head2 !== null && head3 !== null) {
      contests.push(
        { label: 'CONTROL ref -> ref', a: mk(ref2, `${REF} ${refEngine}`), b: mk(ref3, `${REF} ${refEngine}`) },
        { label: 'CONTROL head -> head', a: mk(head2, `HEAD ${headEngine}`), b: mk(head3, `HEAD ${headEngine}`) },
      )
    }
    const out = interleave(contests, reps, M)
    const g = out.get('ref -> head')!
    const c = out.get('CONTROL ref -> ref')
    const ch = out.get('CONTROL head -> head')
    const rm = median(g.get(`ref|${rel}`)!)
    const hm = median(g.get(`head|${rel}`)!)
    console.log('')
    console.log(`    ONE PARSE, median of ${M.rounds * M.runs} samples:`)
    // Sub-millisecond fixtures print more places rather than a row of `0.00 ms`.
    // A figure the format rounds to zero is not reported, it is erased.
    const ms = (v: number): string => (v >= 1 ? v.toFixed(2) : v.toFixed(4)).padStart(8)
    console.log(`      HEAD    ${headEngine.padEnd(11)} ${ms(hm)} ms   ${(bytes / hm / 1000).toFixed(2)} MB/s`)
    console.log(`      ${REF} ${refEngine.padEnd(11)} ${ms(rm)} ms   ${(bytes / rm / 1000).toFixed(2)} MB/s`)
    console.log(`      ratio HEAD/${REF}   ${(hm / rm).toFixed(3)}x   (${sign((hm / rm - 1) * 100)} — negative is HEAD faster)`)
    if (!bothParsed) console.log('      ^ VOID — see the acceptance lines above. This is not a like-for-like ratio.')
    // BOTH noise floors. The worst of the two is what the gate is judged against:
    // a gap smaller than either side's own self-disagreement is not a result.
    //
    // In `--two-graph` there is no in-process control BY DESIGN — a control leg is
    // a third graph, and a third graph is the bias. The floor for this shape comes
    // from a separate `--self --two-graph` run, and the row says so rather than
    // printing a floor it did not measure.
    let ctl = 0
    if (c !== undefined && ch !== undefined) {
      const ctlA = median(c.get(`ref|${rel}`)!), ctlB = median(c.get(`head|${rel}`)!)
      const ctlHA = median(ch.get(`ref|${rel}`)!), ctlHB = median(ch.get(`head|${rel}`)!)
      ctl = Math.max(Math.abs(ctlB / ctlA - 1), Math.abs(ctlHB / ctlHA - 1))
      console.log(`      CONTROL ref/ref     ${sign((ctlB / ctlA - 1) * 100)}   — ${REF}-side noise floor`)
      console.log(`      CONTROL head/head   ${sign((ctlHB / ctlHA - 1) * 100)}   — HEAD-side noise floor`)
      console.log('      ^ NOTE both controls are taken in a SEVEN-GRAPH process, and graphs realised')
      console.log('        beyond the first couple run ~18-20% slower. A flat control here does NOT')
      console.log('        clear the gate ratio; only --two-graph does. See TWO_GRAPH in this file.')
    } else {
      console.log('      CONTROL             none in-process — --two-graph deliberately has no third')
      console.log('        graph. Take the floor from a separate `--self --two-graph` run of this shape.')
    }
    if (ctl > 0 && Math.abs(hm / rm - 1) <= ctl) {
      console.log('      ^ the gap is INSIDE the control. That is not a result in either direction.')
    }

    // THE PAIRING CROSS-CHECK. See `solo`.
    //
    // BOTH ORDERS, and the median of the two — because "alone" still has a
    // position. Timed head-then-ref every time, the head leg always gets the
    // cleaner heap, so a positional bias would reproduce identically in the solo
    // figures and be read as CONFIRMING the paired ones. Running it both ways
    // costs one more pass and removes the only ordering this check had.
    const hs1 = solo(head, input, M), rs1 = solo(ref, input, M)
    const rs2 = solo(ref, input, M), hs2 = solo(head, input, M)
    const hs = median([hs1, hs2]), rs = median([rs1, rs2])
    const drift = (paired: number, alone: number): number => paired / alone - 1
    console.log('')
    console.log('    SAME LEGS, TIMED ALONE — does the pairing agree with itself?')
    console.log(`      HEAD    ${headEngine.padEnd(11)} ${ms(hs)} ms   paired ${sign(drift(hm, hs) * 100)}   (first ${ms(hs1)}, second ${ms(hs2)})`)
    console.log(`      ${REF} ${refEngine.padEnd(11)} ${ms(rs)} ms   paired ${sign(drift(rm, rs) * 100)}   (first ${ms(rs1)}, second ${ms(rs2)})`)
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
  const headEngine = normEngine(argValue('--head-engine') ?? 'macro')
  const refEngine = normEngine(argValue('--ref-engine') ?? 'macro')
  for (const e of [headEngine, refEngine]) if (!ENGINES.includes(e)) throw new Error(`unknown engine '${e}'`)
  // MIXED ENGINE REQUESTS ARE REFUSED, and the default is the macro on BOTH
  // sides. Note what this can and cannot enforce: it holds the REQUEST equal, and
  // what each side's macro lowers to is detected and reported by `loweringOf`,
  // not constrained here. At this anchor the two differ, and that is printed.
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
