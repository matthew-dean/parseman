/**
 * CODE-SIZE GATE
 * ==============
 *
 * parseman publishes a code-size budget in its own docs. Until this gate existed
 * nothing enforced it: `bench:size` (bench/measure-expansion.ts) was a hand-run
 * snapshot that appeared in `package.json` and in ZERO CI workflows, while speed
 * had two blocking gates (`grammar-perf`, `workload-perf`). The published budget
 * drifted by roughly an order of magnitude on real grammars without anything
 * going red.
 *
 * THE BUDGET
 * ----------
 * Owner's stated TARGET: **the most KB size accepted is 10x**, measured in RAW
 * BYTES of generated output over raw bytes of grammar source. That target is not
 * reachable in 0.45 — see THE 10x TARGET below — so what this gate ENFORCES in
 * 0.45 is the property that actually protects the product:
 *
 *   **no fixture may be worse than it is today, and any improvement must be
 *   banked immediately.**
 *
 * ONE mechanism, not two. Each fixture's committed `genBytes` in
 * bench/size-baseline.json IS its ceiling, and the check is two-sided:
 *
 *   1. GREW — measured bytes above the committed ceiling FAILS. Nothing can get
 *      bigger. This is an ABSOLUTE baseline, not a differential against the
 *      previous commit: gating each commit against its parent lets +2%/commit
 *      land forever, because every individual step is under tolerance.
 *
 *   2. SHRANK — measured bytes meaningfully BELOW the committed ceiling ALSO
 *      FAILS, with "ratchet the baseline down". This is the half that is usually
 *      left to a comment asking a human politely, and it is the half that rots:
 *      `bench/grammar-density/config.json` and `bench/workloads/config.json` both
 *      carried exactly such a comment and sat unbumped from v0.33.0/v0.35.0 for
 *      TEN releases. If a fix takes example/css from 27.2x to 19x and the ceiling
 *      does not move with it, 8x of fresh headroom silently becomes budget for
 *      the next regression. So banking a win is not a courtesy, it is the check.
 *
 * Raising a ceiling is a deliberate committed diff that needs owner sign-off.
 * Lowering one is mandatory. Both go through `pnpm size:baseline`, and both show
 * up as a reviewable change to bench/size-baseline.json.
 *
 * WHY THE CEILINGS CARRY NO HEADROOM
 * ----------------------------------
 * Every ceiling is the measured byte count EXACTLY. Not measured + 5%, not
 * measured rounded up. This is the one decision that keeps the gate worth having,
 * and it is worth writing down because the obvious alternative is very tempting
 * whenever the numbers move a lot at once — as they did when `compile()` flipped
 * to the table lowering and the example fixtures fell by 11-20x.
 *
 * A percentage of headroom is not safety margin, it is pre-approved regression
 * budget: at +5% a fixture may grow 5% before anyone hears about it, and the way
 * budgets get spent is that they get spent. There is nothing for headroom to
 * absorb, either — codegen and table emission are both DETERMINISTIC, proven
 * byte-identical across separate processes by test/unit/size-guard.test.ts, so
 * the measured noise floor is 0. `RATCHET_SLACK_PCT` at 0.1% exists only so a
 * one-byte churn does not thrash the file in both directions; it is not a
 * tolerance and it is not a budget.
 *
 * So the re-baselining rule is: run it, record what it says, change nothing by
 * hand. A number in this file that nobody measured is the failure this gate
 * exists to prevent, whichever direction it points.
 *
 * THE RULE'S ONE PRECONDITION — MEASURE SOMETHING WHOLE
 * ----------------------------------------------------
 * "Record what it says" is only safe while what it measures is REAL, and the
 * ceilings have already been cut once against artifacts that were not.
 * `compileTable` dropped the encoder's reducer sources, `emitTable*` substituted
 * `() => {}` for every author callback, and the modules that reached this gate
 * were 8-34% smaller than the correct ones — `example/graphql` by 33.7%. They
 * loaded, they parsed, they reported `ok`, and they returned `undefined` instead
 * of a tree. Every mechanism above then behaved exactly as designed: the smaller
 * number ratcheted, the win was banked, the ceilings were re-cut, and the file
 * recorded the defect as an improvement.
 *
 * A bytes-only gate cannot tell an artifact that got smaller from one that got
 * emptier — smaller is the only evidence it has, and hollow output is smaller.
 * So being PRINTABLE is necessary and not sufficient: `measureExamples()` now
 * refuses to record a size for any artifact containing an empty reducer, and
 * `bench/size/probe.ts` does the same for the macro half. Both use the one
 * definition in `bench/empty-reducer.ts`, shared with the property pinned in
 * `test/unit/table-compile.test.ts` so the size half and the correctness half
 * cannot drift apart again.
 *
 * UNPRINTABLE
 * -----------
 * The table lowering has a NAMED degradation that codegen did not: a grammar
 * whose trivia, `ref()` or `withCtx()` shape it cannot serialise is kept LIVE, so
 * the parser RUNS and `emitTableModule` refuses. `compile()` then returns an empty
 * `source` and a null `inlineExpression`.
 *
 * That is not zero bytes and it must never be scored as zero bytes — a bytes-only
 * gate reads a fixture that stopped emitting as a 100% improvement and congratulates
 * the change that broke it. So printability RATCHETS exactly like the bytes do:
 * losing it BLOCKS, regaining it is reported as a win to bank, and a loss recorded
 * in the baseline as `printable: false` is standing debt that is warned about on
 * every run. An unprintable fixture is UNGATED FOR SIZE, which is precisely why
 * dropping it from EXAMPLE_SPECS instead would be the wrong repair: that shrinks
 * the gated set silently, and the STALE check exists to stop exactly that.
 *
 * THE 10x TARGET
 * --------------
 * `CEILING` stays in this file, is measured every run, and is REPORTED — it just
 * does not fail the build in 0.45. Deleting it would lose the target, and a
 * permanently-red required check is worse than a tracked one: it trains everyone
 * to ignore CI, which is how several gates in this repo went dead in the first
 * place.
 *
 * WHAT IS LEFT OF THE GAP, measured rather than asserted — and it is no longer
 * the per-site preamble. That was the whole story while every fixture lowered to
 * source: marginal cost was ~5,170 generated bytes per `node()` site, constant
 * across a 4->32 node range, which put the `node-scale-*` series at 27-34x. The
 * macro build now lowers those four units through the table, marginal cost is
 * ~326 B/node, and the series measures 2.9-3.6x — under the target, with no
 * strategy change required. The hot/cold hybrid was aimed at a cost the table
 * lowering removed outright.
 *
 * The eight fixtures still over 10x are one of two things, and neither is
 * per-node:
 *
 *   - `compose-depth-1/2/3`, `compose-leaf`, `variant` (13.9-20.8x) — the probe
 *     units `transformMacro` still lowers to SOURCE. They are unchanged
 *     byte-for-byte from their pre-flip ceilings, and they move when their
 *     lowering does, not when a preamble shrinks.
 *   - `variants-1/2/4` (22.9-36.0x) — table-lowered and still over, because the
 *     cost here is variant DUPLICATION, not node sites: 4 variants cost 2.64x
 *     one variant of the SAME grammar while compression climbs 5.1:1 -> 9.2:1.
 *     Output that gzips better is output repeating itself.
 *
 * So the remaining levers are sharing across variants, and finishing the macro
 * flip. Every fixture still above the target gets a loud, itemised warning
 * naming the gap and the lever.
 *
 * WHY BYTES AND NOT THE LOC MULTIPLIER
 * ------------------------------------
 * Raw bytes are what V8 must parse at import. The LOC multiplier actively hides
 * regressions: GraphQL moved 63.9 -> 73.9 kB (+15.6%) while generated LOC moved
 * only +3.4% — lines got LONGER, not more numerous. A LOC gate sees +3.4% and
 * shrugs. So: raw bytes fail the build. Gzip and the LOC multiplier are recorded
 * and drift-reported, never the failure criterion.
 *
 * Gzip is baselined for a specific reason: the COMPRESSION RATIO is a duplication
 * detector. If a change makes output more repetitive, the ratio climbs even while
 * raw size looks stable. Having it in the baseline makes that visible.
 *
 * SLACK
 * -----
 * `RATCHET_SLACK_PCT` is 0.1%, and it is deliberately near-zero. Codegen output
 * is DETERMINISTIC: repeated compiles in one process and across separate
 * processes produce byte-identical output (sha256 equal, asserted by
 * test/unit/size-guard.test.ts), so the measured noise floor is exactly 0. The
 * slack exists only so a one-byte incidental churn does not thrash the baseline
 * in BOTH directions; it is not a noise allowance and it is not headroom to grow
 * into. At 0.1% a 20 kB fixture may move 20 B before the gate speaks.
 *
 * WHAT IS MEASURED
 * ----------------
 * A gate validated only on toy grammars is exactly how this happened. The docs'
 * fixtures are 39-196 source LOC and all three are WITHIN budget today — a gate
 * pointed only at them would have passed throughout. So the gated set covers:
 *
 *   - the doc fixtures (json, csv, graphql) — the published numbers
 *   - the LARGER in-repo grammars (css, lang, toml-ish) which `bench:size` never
 *     measured and which are the ones actually over budget
 *   - VARIANTS derived from a base (jsonc, jsonl) — never measured before
 *   - the canonical size probe (bench/size/probe.ts): node-count scaling,
 *     compose depth 1/2/3, composeLeaf, trivia on/off, hostMode ast/cst, variant
 *
 * TWO LOWERINGS, AND THE SET IS SPLIT ACROSS THEM
 * -----------------------------------------------
 * These halves no longer measure the same thing, and reading the table without
 * knowing that will mislead you.
 *
 *   - the `example/*` fixtures go through the library entry `compile()`, which
 *     `src/index.ts` now binds to `compileTable` — so they size the TABLE.
 *   - the `probe/*` fixtures go through `transformMacro` (`src/plugin/index.ts`),
 *     which imports BOTH `compile` (`src/compiler/codegen.ts`) and `compileTable`
 *     (`src/table/compile.ts`) and picks per unit — so they size whichever
 *     lowering that unit reached.
 *
 * The macro half is no longer uniformly source lowering, and reading it as though
 * it were will mislead you. Measured on this branch, 10 of the 16 probe units emit
 * `tableRules` — the four `node-scale-*`, both `trivia-*`, both `hostmode-*`, and
 * the three `variants-*` — and they fell by up to 91.5%. The six that do not
 * (`compose-depth-1/2/3`, `compose-leaf`, `variant`) are byte-identical to their
 * pre-flip ceilings, which is what the whole probe half used to be.
 *
 * That split is also why the 10x-target warning block emptied out: with the
 * `node-scale-*` rows down at ~2.9-3.6x, the only fixtures still over the target
 * are `compose-depth-*`, `compose-leaf`, `variant` and `variants-*` — the six
 * source-lowered units plus the three variant units. The 10x number they are
 * measured against is the ORIGINAL target, raw generated bytes over raw source
 * bytes, so those rows remain a true reading of what source lowering emits.
 *
 * NOTE ON COMPARING FIXTURES TO EACH OTHER: don't. Generated-bytes-per-source-
 * byte is NOT comparable across grammars that compose — a composing grammar's
 * source does not contain the node sites it emits, so its denominator lies. Each
 * fixture is gated against its OWN baseline and against the absolute ceiling.
 * Nothing here ranks fixtures against one another.
 *
 * FAILS CLOSED
 * ------------
 * This repo has a history of dishonest defaults (`ratio: ordered.length === 0 ? 1`
 * in src/coverage.ts reported 100% covered when nothing was analysable; both
 * scripts/coverage-guard.mjs and bench/perf-guard.ts still exit 0 when their
 * baseline is missing). This gate does the opposite everywhere: a missing
 * baseline, a missing fixture, a fixture absent from the baseline, an unreadable
 * or malformed baseline, a build/lowering failure, empty output, or zero
 * fixtures found are all HARD FAILURES. There is no path through this file that
 * reports success without having measured something.
 *
 * REBASELINING
 * ------------
 *   pnpm size:baseline
 *
 * That REWRITES bench/size-baseline.json, which then shows up as a changed
 * committed file in the diff and has to be reviewed like any other change. It is
 * never automatic. It records over-target fixtures as `overCeiling: true` so the
 * 10x gap stays visible in the committed file rather than being quietly dropped,
 * and a baseline that carries an over-target ratio WITHOUT that flag is rejected
 * as invalid.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { buildUnits, measure as measureProbeUnit, loadLowerer } from './size/probe.ts'
import { emptyReducersIn, emptyReducerReport } from './empty-reducer.ts'

const GATE = 'size-guard'
const HERE = dirname(fileURLToPath(import.meta.url))

function argValue(flag: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`${flag}=`))
  if (hit) return hit.slice(flag.length + 1)
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** `--root=` exists so the fail-closed tests can point the real gate at a fixture
 *  checkout. Neither perf guard has such an injection point and neither has a test. */
const ROOT = resolve(argValue('--root') ?? join(HERE, '..'))
/** `--baseline=` points the gate at a different baseline file while still measuring
 *  the real tree. Used by the tests to exercise the "crossed the ceiling in THIS
 *  change" path, which needs real fixtures against a different recorded history. */
const BASELINE_PATH = argValue('--baseline') ?? join(ROOT, 'bench', 'size-baseline.json')

/**
 * Owner's stated TARGET: raw generated bytes / raw source bytes.
 *
 * Measured every run and reported loudly. NOT build-failing in 0.45 — see THE
 * 10x TARGET in the file header. Do not delete it; it is the number 0.46 is aimed
 * at, and removing it would lose the target along with the failure.
 */
export const CEILING = 10

/**
 * How far a fixture may move from its committed ceiling, in EITHER direction,
 * before the gate speaks. Near-zero on purpose: codegen is deterministic, so the
 * noise floor is 0 and this is churn slack, not headroom.
 */
export const RATCHET_SLACK_PCT = 0.1

function fail(msg: string): never {
  console.error(`\n${GATE}: ${msg}`)
  process.exit(1)
}

export type Fixture = {
  id: string
  kind: 'example' | 'probe'
  srcBytes: number
  genBytes: number
  gzipBytes: number
  srcLines: number
  genLines: number
  bytesRatio: number
  locMultiplier: number
  compression: number
  /** False when the lowering RUNS the grammar but refuses to print it. See UNPRINTABLE. */
  printable: boolean
  /** Why it could not be printed, named construct by construct. Empty when printable. */
  reasons: readonly string[]
}

export type BaselineEntry = {
  genBytes: number
  gzipBytes: number
  bytesRatio: number
  locMultiplier: number
  /** Recorded when the fixture is above the 10x target. The number is written down
   *  so the gap stays visible in the committed file and in every run's warning
   *  block; it is NEVER treated as accepted. */
  overCeiling?: boolean
  /** Recorded when the lowering could not print this grammar at all — there is no
   *  artifact to size. Written down for the same reason as `overCeiling`: so the
   *  gap is visible in the committed file and warned about on every run, rather
   *  than the fixture quietly leaving the gated set. NEVER treated as accepted. */
  printable?: false
  /** The named constructs that blocked printing, recorded so the diff says WHICH. */
  unprintable?: readonly string[]
}

export type Baseline = {
  updatedAt: string
  gitRev: string
  ceiling: number
  ratchetSlackPct: number
  fixtures: Record<string, BaselineEntry>
}

/**
 * The in-repo example grammars.
 *
 * `bench/measure-expansion.ts` sizes exactly three of these (json, csv, graphql)
 * and is blind to css/lang/toml-ish and to the jsonc/jsonl VARIANTS — which is
 * precisely where the cost hides.
 */
export type ExampleSpec = { id: string; exportName: string; source: string; precompiled?: boolean }

/**
 * EXPORTED because it is the repo's ONE registry of shipped example grammars,
 * and `test/unit/example-emission.test.ts` gates emission over exactly this set.
 * A second hand-maintained list in the test would be a second thing to forget —
 * which is the failure mode both that test's STALE sweep and this file's own
 * STALE check exist to catch.
 */
export const EXAMPLE_SPECS: ExampleSpec[] = [
  { id: 'example/json', exportName: 'jsonDoc', source: 'examples/json/parser.ts' },
  { id: 'example/csv', exportName: 'csvParser', source: 'examples/csv/parser.ts' },
  { id: 'example/graphql', exportName: 'graphqlDoc', source: 'examples/graphql/parser.ts' },
  { id: 'example/css', exportName: 'Stylesheet', source: 'examples/css/parser.ts' },
  { id: 'example/lang', exportName: 'exprParser', source: 'examples/lang/parser.ts' },
  // toml-ish exports only its already-compiled artifact, not the combinator.
  { id: 'example/toml-ish', exportName: 'compiledConfig', source: 'examples/toml-ish/parser.ts', precompiled: true },
  { id: 'example/jsonc', exportName: 'jsoncValue', source: 'examples/json/jsonc.ts' },
  { id: 'example/jsonl', exportName: 'jsonl', source: 'examples/json/jsonl.ts' },
]

/**
 * Why a grammar could not be printed, named construct by construct.
 *
 * The table lowering records this on the encoded program as `runtimeOnly`, but
 * `CompiledParser` has nowhere to carry it, so the artifact arrives as an empty
 * `source` with a null `inlineExpression` and no reason attached. A gate that
 * reported "UNPRINTABLE" and stopped there would be the unreadable failure this
 * repo keeps re-finding, so re-encode — diagnostics only, only for the fixtures
 * that already failed — to recover the names.
 *
 * Degrades to an empty list rather than throwing: not knowing WHY must never
 * turn into not reporting THAT.
 */
async function printRefusalReasons(grammar: unknown, compiled: { runtimeOnly?: readonly string[] }): Promise<readonly string[]> {
  // The compiler now HANDS BACK its reasons, so prefer them: re-encoding is a
  // re-derivation, and for a `precompiled` fixture there is no combinator left to
  // re-encode at all — `grammar` is the artifact.
  if (compiled.runtimeOnly !== undefined && compiled.runtimeOnly.length > 0) return compiled.runtimeOnly
  try {
    const { encodeTable } = (await import(join(ROOT, 'src', 'table', 'encode.ts'))) as {
      encodeTable: (rules: Record<string, unknown>, settings: Record<string, unknown>) => { runtimeOnly?: readonly string[] }
    }
    return encodeTable({ Entry: grammar }, {}).runtimeOnly ?? []
  } catch {
    return []
  }
}

async function measureExamples(): Promise<Fixture[]> {
  type Compiled = { source: string; inlineExpression: string | null; runtimeOnly?: readonly string[] }
  let compile: (c: unknown) => Compiled
  try {
    ;({ compile } = (await import(join(ROOT, 'src', 'index.ts'))) as { compile: (c: unknown) => Compiled })
  } catch (e) {
    fail(`cannot load the compiler from ${join(ROOT, 'src', 'index.ts')} — ${(e as Error).message.split('\n')[0]}\n  Without it NOTHING can be measured. That is a gate failure, never a skip: a size\n  gate that exits 0 because the build is broken is how the budget stops being enforced.`)
  }
  const out: Fixture[] = []

  for (const spec of EXAMPLE_SPECS) {
    const sourcePath = join(ROOT, spec.source)
    if (!existsSync(sourcePath)) {
      fail(`fixture ${spec.id}: source file is MISSING at ${spec.source}.\n  A fixture that cannot be measured is a failure, never a skip — otherwise deleting a\n  grammar silently shrinks the gated set.`)
    }

    let mod: Record<string, unknown>
    try {
      // Imported through ROOT, not through `HERE`. `--root=` is documented as the
      // injection point that "points the real gate at a fixture checkout", and it
      // did not: only the baseline path and the existence check honoured it while
      // the grammar itself was always imported out of THIS checkout. So the one
      // property that cannot be constructed from a baseline — whether a grammar
      // PRINTS — had no way to be exercised at all, and the printability ratchet
      // was only ever observed working because two shipped fixtures happened to be
      // unprintable. `spec.source` and `spec.module` name the same file (one
      // root-relative, one bench-relative), so this is the same import in the
      // ordinary case and a real redirect under `--root=`.
      mod = (await import(sourcePath)) as Record<string, unknown>
    } catch (e) {
      fail(`fixture ${spec.id}: FAILED TO BUILD — ${(e as Error).message.split('\n')[0]}\n  A build failure is a gate failure. Fix the grammar; do not drop it from the set.`)
    }

    const grammar = mod[spec.exportName]
    if (grammar === undefined) fail(`fixture ${spec.id}: module ${spec.source} has no export '${spec.exportName}'`)

    let compiled: Compiled
    try {
      // A `precompiled` fixture exports the ARTIFACT, so read its printability off
      // the artifact instead of asserting it. Hard-coding `inlineExpression: ''`
      // asserted "this printed" for a fixture that may have refused, which turns a
      // named refusal into a bogus "compile() produced EMPTY output" gate failure.
      compiled = spec.precompiled
        ? {
            source: (grammar as Compiled).source,
            inlineExpression: (grammar as Compiled).inlineExpression,
            ...((grammar as Compiled).runtimeOnly === undefined ? {} : { runtimeOnly: (grammar as Compiled).runtimeOnly }),
          }
        : compile(grammar)
    } catch (e) {
      fail(`fixture ${spec.id}: compile() THREW — ${(e as Error).message.split('\n')[0]}`)
    }
    const gen = compiled.source

    // UNPRINTABLE IS NOT BROKEN, and conflating them costs the distinction that
    // matters. The table lowering has a NAMED degradation: a grammar whose trivia
    // (or ref/withCtx) shape it cannot serialise still RUNS — it keeps the live
    // combinator — but `emitTableModule` refuses, so `source` is '' and
    // `inlineExpression` is null. Empty output with a non-null expression is still
    // a broken compile and still a hard failure.
    const printable = !(gen === '' && compiled.inlineExpression === null)
    if (printable && (typeof gen !== 'string' || gen.trim().length === 0)) fail(`fixture ${spec.id}: compile() produced EMPTY output`)

    // A HOLLOW ARTIFACT IS NOT A SMALL ONE. This is the check whose absence let
    // the previous re-baselining happen: `compileTable` dropped the encoder's
    // reducer sources, `emitTable*` substituted `() => {}` for every author
    // callback, and the resulting modules were 8-34% SMALLER than the correct
    // ones. Every gate in this file then worked exactly as designed on a number
    // that meant nothing — the bytes ratcheted, the ceilings were re-cut, and the
    // artifacts returned `undefined` instead of a tree the whole time.
    //
    // So printability is necessary and not sufficient: an artifact must also be
    // WHOLE before its size is allowed to become a ceiling. Same property, same
    // pattern, same module as `test/unit/table-compile.test.ts` — see
    // bench/empty-reducer.ts for why it is one shared definition.
    if (printable) {
      const stubs = emptyReducersIn(gen)
      if (stubs.length > 0) fail(emptyReducerReport(spec.id, stubs))
    }

    const reasons = printable ? [] : await printRefusalReasons(grammar, compiled)

    const srcText = readFileSync(sourcePath, 'utf8')
    const srcBytes = Buffer.byteLength(srcText, 'utf8')
    if (srcBytes === 0) fail(`fixture ${spec.id}: source file is EMPTY`)
    const genBytes = Buffer.byteLength(gen, 'utf8')
    const gzipBytes = printable ? gzipSync(gen).length : 0

    out.push({
      id: spec.id,
      kind: 'example',
      srcBytes,
      genBytes,
      gzipBytes,
      srcLines: srcText.split('\n').length,
      genLines: printable ? gen.split('\n').length : 0,
      bytesRatio: printable ? +(genBytes / srcBytes).toFixed(3) : 0,
      locMultiplier: printable ? +(gen.split('\n').length / srcText.split('\n').length).toFixed(3) : 0,
      compression: printable ? +(genBytes / gzipBytes).toFixed(2) : 0,
      printable,
      reasons,
    })
  }
  return out
}

async function measureProbe(): Promise<Fixture[]> {
  const lower = await loadLowerer()
  const units = buildUnits()
  if (units.length === 0) fail('the size probe produced ZERO units — the gate would be measuring nothing')
  return units.map(u => {
    const r = measureProbeUnit(u, lower)
    return {
      id: `probe/${r.id}`,
      kind: 'probe' as const,
      srcBytes: r.srcBytes,
      genBytes: r.genBytes,
      gzipBytes: r.gzipBytes,
      srcLines: r.srcLines,
      genLines: r.genLines,
      bytesRatio: r.bytesRatio,
      locMultiplier: r.locMultiplier,
      compression: r.compression,
      // The probe lowers through `transformMacro` (the macro build), which
      // `measure()` already fails closed on — empty output, an implausibly small
      // one, and (since the macro build began emitting tables) a hollow one all
      // die there rather than arriving here as a number. Nothing reaches here
      // unprintable.
      printable: true,
      reasons: [],
    }
  })
}

export async function measureAll(): Promise<Fixture[]> {
  const fixtures = [...(await measureExamples()), ...(await measureProbe())]
  if (fixtures.length === 0) fail('ZERO fixtures measured — refusing to report a pass on an empty set')
  return fixtures
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    fail(`no baseline at bench/size-baseline.json.\n  This is a FAILURE, not a skip: a gate with no baseline measures nothing, and\n  exiting 0 here is how a size budget silently stops being enforced.\n  Create it deliberately with:  pnpm size:baseline`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch (e) {
    fail(`baseline bench/size-baseline.json is UNREADABLE/malformed: ${(e as Error).message}`)
  }
  const b = parsed as Partial<Baseline>
  if (!b || typeof b !== 'object' || !b.fixtures || typeof b.fixtures !== 'object') {
    fail('baseline bench/size-baseline.json has an unexpected shape (no `fixtures` map)')
  }
  if (Object.keys(b.fixtures).length === 0) fail('baseline bench/size-baseline.json contains ZERO fixtures')

  // The 10x target is not build-failing in 0.45, but it must stay VISIBLE in the
  // committed file. A baseline that records an over-target ratio without flagging
  // it is asserting that number is unremarkable — which is exactly how a target
  // stops being a target. Recording it as `overCeiling: true` is what keeps the
  // gap in the diff and in the warning block; omitting the flag is an invalid
  // baseline, not an accepted one.
  const smuggled = Object.entries(b.fixtures)
    .filter(([, e]) => e.bytesRatio > CEILING && e.overCeiling !== true)
    .map(([id, e]) => `${id} (${e.bytesRatio.toFixed(1)}x)`)
  if (smuggled.length > 0) {
    fail(
      `INVALID BASELINE — records over-ceiling sizes as accepted:\n    ${smuggled.join('\n    ')}\n` +
      `  The ${CEILING}x target cannot be waived by rebaselining. An over-target fixture must\n` +
      '  be recorded as `overCeiling: true` so the gap stays visible in the committed file\n' +
      '  and in every run\'s warning block. Re-run `pnpm size:baseline` to write it correctly.',
    )
  }
  return b as Baseline
}

function pct(actual: number, base: number): number {
  return (actual / base - 1) * 100
}

async function main(): Promise<void> {
  // Validate the baseline BEFORE measuring. It is the cheap check, and a baseline
  // that is missing, malformed, empty, or that tries to record an over-ceiling
  // size as accepted is a gate failure regardless of what the fixtures measure —
  // so there is no reason to spend minutes lowering grammars first.
  const baseline = process.argv.includes('--update') ? null : loadBaseline()

  const fixtures = await measureAll()

  if (process.argv.includes('--update')) {
    const entries: Record<string, BaselineEntry> = {}
    for (const f of fixtures) {
      const e: BaselineEntry = {
        genBytes: f.genBytes,
        gzipBytes: f.gzipBytes,
        bytesRatio: f.bytesRatio,
        locMultiplier: f.locMultiplier,
      }
      // Over-target numbers are recorded so the gap stays visible in the diff,
      // flagged so nobody can read the file as blessing them. They are warned
      // about on every run.
      if (f.bytesRatio > CEILING) e.overCeiling = true
      // Same treatment for a fixture with no artifact at all: written down, named,
      // and warned about — never dropped from the set.
      if (!f.printable) {
        e.printable = false
        e.unprintable = [...f.reasons]
      }
      entries[f.id] = e
    }
    let gitRev = 'unknown'
    try {
      gitRev = (await import('node:child_process')).execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch { /* metadata only */ }
    const baseline: Baseline = {
      updatedAt: new Date().toISOString().slice(0, 10),
      gitRev,
      ceiling: CEILING,
      ratchetSlackPct: RATCHET_SLACK_PCT,
      fixtures: entries,
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    const over = fixtures.filter(f => f.bytesRatio > CEILING)
    console.log(`${GATE}: wrote bench/size-baseline.json (${fixtures.length} fixtures)`)
    console.log(`${GATE}: each fixture's genBytes is now its CEILING — it may not grow, and if it`)
    console.log(`${GATE}: shrinks the gate will require this file to be written again.`)
    if (over.length > 0) {
      console.log(`${GATE}: ${over.length} fixture(s) are above the ${CEILING}x target and are recorded as \`overCeiling: true\`.`)
      console.log(`${GATE}: they are written down so the gap stays visible — they are NOT accepted, and`)
      console.log(`${GATE}: every run warns about them until 0.46 brings the emitted size down.`)
    }
    console.log(`${GATE}: review this file in the diff; rebaselining is a deliberate, reviewable act.`)
    return
  }

  if (!baseline) fail('internal: baseline was not loaded')

  const n = (v: number): string => v.toLocaleString('en-US')
  const RULE = '─'.repeat(76)

  // `base` is explicitly `| undefined`: a fixture that crosses the ceiling with NO
  // baseline row is a real, reportable case (`newOver`), so the absent baseline is
  // stored rather than omitted. `exactOptionalPropertyTypes` distinguishes the two.
  type Breach = { f: Fixture; base?: BaselineEntry | undefined; deltaPct?: number }
  const knownOver: Breach[] = []   // above the 10x target, already recorded — standing debt
  const newOver: Breach[] = []     // crossed the 10x target in THIS change
  const grew: Breach[] = []        // BLOCKING: past its committed ceiling
  const shrank: Breach[] = []      // NON-BLOCKING: below it — bank the win, but never fail on good news
  const missing: Fixture[] = []
  const lostPrint: Fixture[] = []  // BLOCKING: it used to print and now does not
  const gainedPrint: Fixture[] = []// NON-BLOCKING: it prints again — rebaseline to get a ceiling back
  const noArtifact: Fixture[] = [] // tracked, recorded: no artifact to size at all

  for (const f of fixtures) {
    const base = baseline.fixtures[f.id]
    if (!base) {
      missing.push(f)
    } else if (!f.printable || base.printable === false) {
      // PRINTABILITY RATCHETS TOO, in both directions and for the same reason the
      // bytes do. A fixture that stops printing has no ceiling left to breach, so
      // a bytes-only gate would read the loss as a 100% improvement and congratulate
      // the change that caused it. Sizing is not the only thing that can regress.
      if (!f.printable) noArtifact.push(f)
      if (!f.printable && base.printable !== false) lostPrint.push(f)
      else if (f.printable) gainedPrint.push(f)
    } else {
      // The committed genBytes IS the ceiling, and the check is two-sided: growth
      // is a regression, and an un-banked improvement is tomorrow's regression
      // budget. Both are failures; only the remedy differs.
      const d = pct(f.genBytes, base.genBytes)
      if (d > RATCHET_SLACK_PCT) grew.push({ f, base, deltaPct: d })
      else if (d < -RATCHET_SLACK_PCT) shrank.push({ f, base, deltaPct: d })
    }
    if (f.bytesRatio > CEILING) {
      // The distinction that matters to a human: is this standing debt we are
      // already tracking against the 10x target, or did THIS change cross it?
      // Neither blocks in 0.45 — both are reported, and they read differently.
      if (base?.overCeiling === true) knownOver.push({ f, base })
      else newOver.push({ f, base })
    }
  }

  const stale = Object.keys(baseline.fixtures).filter(id => !fixtures.some(f => f.id === id))
  // What FAILS the build: growth past a ceiling, and anything that could not be
  // measured against one. A fixture that SHRANK does not fail — a gate whose failure
  // mode is "you did well" trains everyone to skim past it, and the next real
  // regression arrives wearing the same red. The win is still reported, loudly, so
  // it gets banked. The 10x target is reported, never fatal.
  const blocking = missing.length + grew.length + stale.length + lostPrint.length

  // ---- the measured table -------------------------------------------------
  console.log(`\n${GATE}  ceilinged at baseline ${baseline.gitRev} (${baseline.updatedAt})  ·  slack ${RATCHET_SLACK_PCT}%  ·  ${CEILING}x target: reported, not blocking in 0.45`)
  console.log(`  ${RULE}`)
  console.log('  fixture                        source        generated    ratio      gzip   comp    LOCx   vs ceiling')
  console.log(`  ${RULE}`)
  for (const f of fixtures) {
    const base = baseline.fixtures[f.id]
    const note = !base ? 'unbaselined'
      : !f.printable ? (base.printable === false ? 'unprintable' : 'LOST PRINT')
      : base.printable === false ? 'PRINTS AGAIN'
      : `${pct(f.genBytes, base.genBytes) >= 0 ? '+' : ''}${pct(f.genBytes, base.genBytes).toFixed(2)}%`
    const flag = f.bytesRatio > CEILING ? (base?.overCeiling === true ? '  over 10x' : '  NEW >10x') : ''
    // A dash, not a zero. Printing "0 B / 0.0x" for a grammar with no artifact
    // reads as the best row in the table.
    const dash = (s: string): string => (f.printable ? s : '—')
    console.log(
      '  ' + f.id.padEnd(29) +
      (n(f.srcBytes) + ' B').padStart(10) +
      dash(n(f.genBytes) + ' B').padStart(15) +
      dash(f.bytesRatio.toFixed(1) + 'x').padStart(9) +
      dash(n(f.gzipBytes) + ' B').padStart(11) +
      dash(f.compression.toFixed(1) + ':1').padStart(8) +
      dash(f.locMultiplier.toFixed(1) + 'x').padStart(8) +
      note.padStart(14) + flag,
    )
  }
  console.log(`  ${RULE}`)

  // ---- 1. standing debt against the 10x target: WARNED, not blocking ------
  //
  // Printed on EVERY run, including green ones. This is the number 0.46 has to
  // move, and a target nobody is reminded of is a target nobody hits.
  const overTarget = [...knownOver, ...newOver].sort((a, b) => b.f.bytesRatio - a.f.bytesRatio)
  if (overTarget.length > 0) {
    const worst = overTarget[0]!
    console.log(`\n  ⚠  WARNING — ${overTarget.length} fixture(s) are above the ${CEILING}x size target`)
    console.log('  ' + RULE)
    console.log(`  TODO(0.46): bring these under ${CEILING}x. Ceilinged at today's bytes so they`)
    console.log('  cannot grow, but they are NOT accepted and this warning does not go away.')
    console.log('')
    console.log('    fixture                          ratio        generated     must fall by')
    for (const { f, base } of overTarget) {
      const budget = Math.round(f.srcBytes * CEILING)
      const fresh = base?.overCeiling === true ? '' : '   << crossed in THIS change'
      console.log(
        '    ' + f.id.padEnd(31) +
        (f.bytesRatio.toFixed(1) + 'x').padStart(7) +
        (n(f.genBytes) + ' B').padStart(15) +
        ((f.bytesRatio / CEILING).toFixed(1) + 'x').padStart(13) +
        `  (to ${n(budget)} B)` + fresh,
      )
    }
    console.log('')
    console.log(`  Worst: ${worst.f.id} at ${worst.f.bytesRatio.toFixed(1)}x — ${(worst.f.bytesRatio / CEILING).toFixed(1)}x the target.`)

    // Name the measured lever rather than leaving "make it smaller".
    const byId2 = new Map(fixtures.map(x => [x.id, x]))
    const s4 = byId2.get('probe/node-scale-4'), s32 = byId2.get('probe/node-scale-32')
    if (s4 && s32) {
      const marginal = Math.round((s32.genBytes - s4.genBytes) / 28)
      console.log('')
      console.log('  WHY, measured:')
      console.log(`    ~${n(marginal)} generated bytes per node() site, near-CONSTANT from 4 to 32 sites.`)
      // Whether the per-node cost is still the STORY depends on where the
      // node-scale series actually sits, so read it rather than asserting it.
      // It was ~5,170 B/node and 27-34x while everything lowered to source; the
      // table lowering took that series under the target outright, and a block
      // that kept reciting "needs a 4.5x cut" would be naming a solved problem
      // as the reason the remaining rows are over.
      if (s32.bytesRatio > CEILING) {
        console.log(`    The cost is per-site, so it does not amortise. Reaching ${CEILING}x needs`)
        console.log(`    ~${n(Math.round(s32.srcBytes * CEILING / 33))} B/node — which inlined preambles cannot give.`)
      } else {
        console.log(`    That series is now UNDER the target (${s4.bytesRatio.toFixed(1)}x -> ${s32.bytesRatio.toFixed(1)}x), so per-site`)
        console.log('    preamble cost is NOT what holds the rows below over it. See the lever.')
      }
    }
    const v1 = byId2.get('probe/variants-1'), v4 = byId2.get('probe/variants-4')
    if (v1 && v4) {
      console.log('')
      console.log('  LARGEST SINGLE LEVER — variant duplication:')
      console.log(`    probe/variants-4 costs ${(v4.genBytes / v1.genBytes).toFixed(2)}x probe/variants-1 for the SAME grammar,`)
      console.log(`    and compression climbs ${v1.compression.toFixed(1)}:1 -> ${v4.compression.toFixed(1)}:1 — output that gzips better is`)
      console.log('    output repeating itself. Each variant is emitted as a full copy.')
      console.log('    Real grammars emit four (trackLines x hostMode), so most of a shipped')
      console.log('    artifact can be copies.')
    }
    console.log('')
    console.log('  → 0.46 plan: share emitted declarations ACROSS VARIANTS, and finish flipping')
    console.log('    the macro build so the units still lowering to source stop paying the')
    console.log('    per-site preamble at all. Both are strategy changes, which is why the')
    console.log('    gate ceilings the numbers instead of pretending to hit 10x.')
    console.log('  → `pnpm size:probe` attributes cost per axis (bytes/node, compose depth,')
    console.log('    trivia, hostMode, variant duplication).')
    console.log('  ' + RULE)
  }

  // ---- 1b. fixtures with NO ARTIFACT: WARNED, not blocking once recorded ----
  //
  // Printed on EVERY run, including green ones, for the same reason the 10x block
  // is: this is a capability the codegen lowering had and the table lowering does
  // not, and the fixtures it costs include the LARGEST grammar in the repo. Left
  // only in the baseline file it would be read once and never again.
  if (noArtifact.length > 0) {
    console.log(`\n  ⚠  NO ARTIFACT — ${noArtifact.length} fixture(s) RUN but cannot be printed, so nothing can be sized`)
    console.log('  ' + RULE)
    console.log('  These are not failures of the grammar and not zero-byte wins. The table')
    console.log('  lowering keeps the unlowerable construct LIVE, so the parser works and')
    console.log('  `emitTableModule` refuses. There is simply no artifact to put a ceiling on.')
    console.log('')
    for (const f of noArtifact) {
      console.log(`    ${f.id}  (${n(f.srcBytes)} B of source, previously sized)`)
      for (const r of f.reasons.length > 0 ? f.reasons : ['reason unavailable — re-encode failed']) console.log(`      ${r}`)
    }
    console.log('')
    console.log('  TODO(0.48): lower these constructs, or accept that `compile()` cannot emit')
    console.log('  a module for every grammar it can run. Until then these fixtures are')
    console.log('  UNGATED for size — recorded so that is visible, never so it is accepted.')
    console.log('  ' + RULE)
  }

  if (blocking === 0) {
    console.log(`\n${GATE}: ok — ${fixtures.length} fixtures, none above its committed ceiling`)
    if (shrank.length > 0) {
      const total = shrank.reduce((sum, x) => sum + (x.base!.genBytes - x.f.genBytes), 0)
      console.log(`${GATE}: BANK THE WIN — ${shrank.length} fixture(s) below ceiling, ${n(total)} B reclaimed. Run \`pnpm size:baseline\` so the headroom is not left for the next regression.`)
      for (const { f: fx, base, deltaPct } of shrank) {
        console.log(`  ${fx.id}  ${n(base!.genBytes)} B -> ${n(fx.genBytes)} B  ${deltaPct!.toFixed(2)}%`)
      }
    }
    if (gainedPrint.length > 0) {
      console.log(`${GATE}: BANK THE WIN — ${gainedPrint.length} fixture(s) PRINT AGAIN and are back in reach of a ceiling. Run \`pnpm size:baseline\` so they are gated on size again.`)
      for (const f of gainedPrint) console.log(`  ${f.id}  ${n(f.genBytes)} B, ${f.bytesRatio.toFixed(1)}x`)
    }
    if (overTarget.length > 0) console.log(`${GATE}: ${overTarget.length} still above the ${CEILING}x target — see the warning above. Tracked for 0.46.`)
    if (noArtifact.length > 0) console.log(`${GATE}: ${noArtifact.length} UNGATED for size — no artifact to measure. See the warning above.`)
    return
  }

  const say = (line = ''): void => { console.error(line) }
  say(`\n${GATE}: FAILED`)

  // ---- 2. blocking: moved off the committed ceiling -----------------------
  if (grew.length > 0) {
    say(`\n  ✗ GREW PAST ITS CEILING — ${grew.length} fixture(s), slack ${RATCHET_SLACK_PCT}%`)
    say('    ' + RULE)
    for (const { f, base, deltaPct } of grew) {
      const gz = pct(f.gzipBytes, base!.gzipBytes)
      say(`    ${f.id}`)
      say(`      raw   ${n(base!.genBytes)} B → ${n(f.genBytes)} B   +${deltaPct!.toFixed(2)}%   (+${n(f.genBytes - base!.genBytes)} B)`)
      say(`      gzip  ${n(base!.gzipBytes)} B → ${n(f.gzipBytes)} B   ${gz >= 0 ? '+' : ''}${gz.toFixed(2)}%`)
      // Compression DIRECTION is a real signal, so name which one it is rather
      // than leaving the reader to divide two numbers.
      const baseComp = base!.genBytes / base!.gzipBytes
      if (f.compression > baseComp + 0.1) say(`      compresses BETTER (${baseComp.toFixed(1)}:1 → ${f.compression.toFixed(1)}:1) — the added bytes are repetitive; suspect duplicated output`)
      else if (f.compression < baseComp - 0.1) say(`      compresses WORSE (${baseComp.toFixed(1)}:1 → ${f.compression.toFixed(1)}:1) — the added bytes are distinct content, not more of the same`)
      say('')
    }
    say('    Codegen is deterministic — this is a real change, never noise.')
    say('    → Reduce it. Raising a ceiling is a deliberate committed diff that needs')
    say('      owner sign-off: `pnpm size:baseline`, then justify the number in the PR.')
  }

  if (shrank.length > 0) {
    const total = shrank.reduce((sum, b) => sum + (b.base!.genBytes - b.f.genBytes), 0)
    say(`\n  ⚠ BANK THE WIN — ${shrank.length} fixture(s) are BELOW their committed ceiling (does NOT fail the build)`)
    say('    ' + RULE)
    say('    Good news, reported and not fatal. Output got smaller and the ceiling did')
    say('    not move with it, so the difference is now silent headroom for the next')
    say('    regression to grow into. Bank it, but nothing here is blocking on it.')
    say('')
    for (const { f, base, deltaPct } of shrank) {
      say(`    ${f.id}`)
      say(`      raw   ${n(base!.genBytes)} B → ${n(f.genBytes)} B   ${deltaPct!.toFixed(2)}%   (${n(base!.genBytes - f.genBytes)} B reclaimed)`)
      if (base!.bytesRatio > CEILING && f.bytesRatio <= CEILING) say(`      and it is now UNDER the ${CEILING}x target (${base!.bytesRatio.toFixed(1)}x → ${f.bytesRatio.toFixed(1)}x)`)
      else if (base!.bytesRatio > CEILING) say(`      still above the ${CEILING}x target (${base!.bytesRatio.toFixed(1)}x → ${f.bytesRatio.toFixed(1)}x)`)
    }
    say('')
    say(`    ${n(total)} B reclaimed in total.`)
    say('    → Run `pnpm size:baseline` and commit it. Lowering a ceiling needs no')
    say('      sign-off, and this check is what makes it happen instead of a comment')
    say('      politely asking someone to remember.')
  }

  if (lostPrint.length > 0) {
    say(`\n  ✗ STOPPED PRINTING — ${lostPrint.length} fixture(s) had a ceiling and now emit nothing`)
    say('    ' + RULE)
    for (const f of lostPrint) {
      say(`    ${f.id}`)
      for (const r of f.reasons.length > 0 ? f.reasons : ['reason unavailable — re-encode failed']) say(`      ${r}`)
    }
    say('')
    say('    The grammar still RUNS; only the emitted module is gone. That is a loss of')
    say('    capability, not a size win, and it is BLOCKING for exactly that reason: a')
    say('    bytes-only gate would score it as the largest improvement ever recorded.')
    say('    → Lower the construct, or record the loss deliberately with `pnpm size:baseline`')
    say('      and justify it in the PR. It leaves the fixture UNGATED for size.')
  }

  if (missing.length > 0) {
    say(`\n  ✗ UNBASELINED — ${missing.length} fixture(s) the baseline has never seen`)
    say('    ' + RULE)
    for (const f of missing) say(`    ${f.id}  (${n(f.genBytes)} B, ${f.bytesRatio.toFixed(1)}x)`)
    say('')
    say('    → New fixtures are baselined deliberately: `pnpm size:baseline`.')
    say('      Passing an unmeasured fixture is how the budget stopped being enforced.')
  }

  if (stale.length > 0) {
    say(`\n  ✗ STALE — ${stale.length} baseline entr(ies) match no measured fixture`)
    say('    ' + RULE)
    for (const id of stale) say(`    ${id}`)
    say('')
    say('    → A fixture was renamed or deleted. Ignoring this shrinks the gated set')
    say('      without anyone noticing. Rebaseline if the removal was intended.')
  }

  say('')
  process.exit(1)
}



const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (invokedDirectly) {
  main().catch(e => fail(`unhandled: ${(e as Error).stack ?? String(e)}`))
}
