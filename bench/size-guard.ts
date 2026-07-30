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
 * Owner's stated budget: **the most KB size accepted is 10x**, measured in RAW
 * BYTES of generated output over raw bytes of grammar source.
 *
 * Two independent checks, both blocking:
 *
 *   1. CEILING — any fixture over `CEILING` raw-bytes ratio fails, unconditionally.
 *      There is NO waiver and no per-fixture exemption. A rebaseline cannot raise
 *      a fixture above the ceiling: the baseline file is itself validated, and a
 *      baseline that records an over-ceiling number as acceptable is rejected as
 *      an invalid baseline. A gate that can be argued past is not a gate.
 *
 *   2. DRIFT — any fixture whose raw bytes exceed its committed baseline by more
 *      than `DRIFT_TOLERANCE_PCT` fails, EVEN WHILE UNDER THE CEILING, so growth
 *      is caught at the point it happens instead of accumulating up to the
 *      ceiling. This is an ABSOLUTE baseline, not a differential against the
 *      previous commit: gating each commit against its parent lets +2%/commit
 *      land forever, because every individual step is under tolerance.
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
 * TOLERANCE
 * ---------
 * DRIFT_TOLERANCE_PCT is 1%. That is not a noise allowance — codegen output is
 * DETERMINISTIC. Measured: repeated compiles in one process and across separate
 * processes produce byte-identical output (sha256 equal), so the noise floor is
 * exactly 0. The 1% is pure headroom for incidental churn, and it is tight enough
 * to catch the +15.6% byte move that the LOC view hid.
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
 * never automatic, and it cannot raise anything above the ceiling.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { buildUnits, measure as measureProbeUnit, loadLowerer } from './size/probe.ts'

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
const BASELINE_PATH = join(ROOT, 'bench', 'size-baseline.json')

/** Owner's budget: raw generated bytes / raw source bytes. No waivers. */
export const CEILING = 10
/** Codegen is deterministic (measured noise floor: exactly 0). This is headroom, not noise. */
export const DRIFT_TOLERANCE_PCT = 1

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
}

export type BaselineEntry = {
  genBytes: number
  gzipBytes: number
  bytesRatio: number
  locMultiplier: number
  /** Recorded when the fixture is over the ceiling. The number is written down so
   *  it is visible, but it is NEVER treated as accepted — the ceiling still fails. */
  overCeiling?: boolean
}

export type Baseline = {
  updatedAt: string
  gitRev: string
  ceiling: number
  driftTolerancePct: number
  fixtures: Record<string, BaselineEntry>
}

/**
 * The in-repo example grammars.
 *
 * `bench/measure-expansion.ts` sizes exactly three of these (json, csv, graphql)
 * and is blind to css/lang/toml-ish and to the jsonc/jsonl VARIANTS — which is
 * precisely where the cost hides.
 */
const EXAMPLE_SPECS: { id: string; module: string; exportName: string; source: string; precompiled?: boolean }[] = [
  { id: 'example/json', module: '../examples/json/parser.ts', exportName: 'jsonDoc', source: 'examples/json/parser.ts' },
  { id: 'example/csv', module: '../examples/csv/parser.ts', exportName: 'csvParser', source: 'examples/csv/parser.ts' },
  { id: 'example/graphql', module: '../examples/graphql/parser.ts', exportName: 'graphqlDoc', source: 'examples/graphql/parser.ts' },
  { id: 'example/css', module: '../examples/css/parser.ts', exportName: 'Stylesheet', source: 'examples/css/parser.ts' },
  { id: 'example/lang', module: '../examples/lang/parser.ts', exportName: 'exprParser', source: 'examples/lang/parser.ts' },
  // toml-ish exports only its already-compiled artifact, not the combinator.
  { id: 'example/toml-ish', module: '../examples/toml-ish/parser.ts', exportName: 'compiledConfig', source: 'examples/toml-ish/parser.ts', precompiled: true },
  { id: 'example/jsonc', module: '../examples/json/jsonc.ts', exportName: 'jsoncValue', source: 'examples/json/jsonc.ts' },
  { id: 'example/jsonl', module: '../examples/json/jsonl.ts', exportName: 'jsonl', source: 'examples/json/jsonl.ts' },
]

async function measureExamples(): Promise<Fixture[]> {
  let compile: (c: unknown) => { source: string }
  try {
    ;({ compile } = (await import(join(ROOT, 'src', 'index.ts'))) as { compile: (c: unknown) => { source: string } })
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
      mod = (await import(join(HERE, spec.module))) as Record<string, unknown>
    } catch (e) {
      fail(`fixture ${spec.id}: FAILED TO BUILD — ${(e as Error).message.split('\n')[0]}\n  A build failure is a gate failure. Fix the grammar; do not drop it from the set.`)
    }

    const grammar = mod[spec.exportName]
    if (grammar === undefined) fail(`fixture ${spec.id}: module ${spec.source} has no export '${spec.exportName}'`)

    let gen: string
    try {
      gen = spec.precompiled
        ? (grammar as { source: string }).source
        : compile(grammar).source
    } catch (e) {
      fail(`fixture ${spec.id}: compile() THREW — ${(e as Error).message.split('\n')[0]}`)
    }
    if (typeof gen !== 'string' || gen.trim().length === 0) fail(`fixture ${spec.id}: compile() produced EMPTY output`)

    const srcText = readFileSync(sourcePath, 'utf8')
    const srcBytes = Buffer.byteLength(srcText, 'utf8')
    if (srcBytes === 0) fail(`fixture ${spec.id}: source file is EMPTY`)
    const genBytes = Buffer.byteLength(gen, 'utf8')
    const gzipBytes = gzipSync(gen).length

    out.push({
      id: spec.id,
      kind: 'example',
      srcBytes,
      genBytes,
      gzipBytes,
      srcLines: srcText.split('\n').length,
      genLines: gen.split('\n').length,
      bytesRatio: +(genBytes / srcBytes).toFixed(3),
      locMultiplier: +(gen.split('\n').length / srcText.split('\n').length).toFixed(3),
      compression: +(genBytes / gzipBytes).toFixed(2),
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

  // A rebaseline must not be able to raise a fixture above the ceiling. If a
  // baseline records an over-ceiling number WITHOUT flagging it as such, it is
  // asserting that number is acceptable — which no rebaseline is allowed to do.
  const smuggled = Object.entries(b.fixtures)
    .filter(([, e]) => e.bytesRatio > CEILING && e.overCeiling !== true)
    .map(([id, e]) => `${id} (${e.bytesRatio.toFixed(1)}x)`)
  if (smuggled.length > 0) {
    fail(`INVALID BASELINE — records over-ceiling sizes as accepted:\n    ${smuggled.join('\n    ')}\n  The ${CEILING}x ceiling cannot be waived by rebaselining. Reduce the size instead.`)
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
      // Over-ceiling numbers are recorded so drift stays visible, but flagged so
      // nobody can read the file as blessing them. The ceiling check still fails.
      if (f.bytesRatio > CEILING) e.overCeiling = true
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
      driftTolerancePct: DRIFT_TOLERANCE_PCT,
      fixtures: entries,
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    const over = fixtures.filter(f => f.bytesRatio > CEILING)
    console.log(`${GATE}: wrote bench/size-baseline.json (${fixtures.length} fixtures)`)
    if (over.length > 0) {
      console.log(`${GATE}: ${over.length} fixture(s) are OVER the ${CEILING}x ceiling and are recorded as \`overCeiling: true\`.`)
      console.log(`${GATE}: they are written down so drift stays visible — they are NOT accepted. The gate still fails on them.`)
    }
    console.log(`${GATE}: review this file in the diff; rebaselining is a deliberate, reviewable act.`)
    return
  }

  if (!baseline) fail('internal: baseline was not loaded')

  console.log(`\n${GATE}: ceiling ${CEILING}x raw bytes, drift tolerance ${DRIFT_TOLERANCE_PCT}% (baseline ${baseline.gitRev}, ${baseline.updatedAt})\n`)
  console.log('  fixture                       src B      gen B    ratio    gzip B   comp   LOCx   vs baseline')

  const ceilingBreaches: string[] = []
  const driftBreaches: string[] = []
  const missing: string[] = []

  for (const f of fixtures) {
    const base = baseline.fixtures[f.id]
    let note = ''
    if (!base) {
      missing.push(f.id)
      note = 'NO BASELINE'
    } else {
      const d = pct(f.genBytes, base.genBytes)
      note = `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`
      if (d > DRIFT_TOLERANCE_PCT) {
        driftBreaches.push(
          `${f.id}: raw ${base.genBytes} -> ${f.genBytes} B (${note}, tolerance ${DRIFT_TOLERANCE_PCT}%)` +
          `\n      gzip ${base.gzipBytes} -> ${f.gzipBytes} B (${pct(f.gzipBytes, base.gzipBytes).toFixed(2)}%)` +
          `, LOC mult ${base.locMultiplier} -> ${f.locMultiplier}`,
        )
      }
    }
    if (f.bytesRatio > CEILING) {
      ceilingBreaches.push(`${f.id}: ${f.bytesRatio.toFixed(1)}x raw bytes (${f.genBytes} B generated from ${f.srcBytes} B source) — over the ${CEILING}x ceiling by ${(f.bytesRatio - CEILING).toFixed(1)}x`)
    }

    console.log(
      '  ' + f.id.padEnd(28) +
      String(f.srcBytes).padStart(7) +
      String(f.genBytes).padStart(11) +
      (f.bytesRatio.toFixed(1) + 'x').padStart(9) +
      String(f.gzipBytes).padStart(10) +
      (f.compression.toFixed(1) + ':1').padStart(7) +
      f.locMultiplier.toFixed(1).padStart(7) +
      note.padStart(14) +
      (f.bytesRatio > CEILING ? '  << OVER CEILING' : ''),
    )
  }

  const stale = Object.keys(baseline.fixtures).filter(id => !fixtures.some(f => f.id === id))

  if (missing.length > 0 || ceilingBreaches.length > 0 || driftBreaches.length > 0 || stale.length > 0) {
    console.error(`\n${GATE}: FAILED\n`)

    if (ceilingBreaches.length > 0) {
      console.error(`  CEILING — ${ceilingBreaches.length} fixture(s) exceed the ${CEILING}x raw-bytes budget:`)
      for (const b of ceilingBreaches) console.error(`    ${b}`)
      console.error(`\n  The ${CEILING}x ceiling is the owner's stated budget and CANNOT be waived by`)
      console.error('  rebaselining. `pnpm size:baseline` will not silence this. Reduce the emitted')
      console.error('  size. Run `node --import tsx/esm bench/size/probe.ts` to attribute the cost')
      console.error('  per axis (bytes-per-node, compose depth, trivia, hostMode).\n')
    }

    if (driftBreaches.length > 0) {
      console.error(`  DRIFT — ${driftBreaches.length} fixture(s) grew past the committed baseline:`)
      for (const b of driftBreaches) console.error(`    ${b}`)
      console.error('\n  Codegen is deterministic, so this is a real change, not noise. Either reduce')
      console.error('  it, or rebaseline DELIBERATELY with `pnpm size:baseline` and justify the new')
      console.error('  number in the PR — the changed baseline file is the reviewable record.\n')
    }

    if (missing.length > 0) {
      console.error(`  UNBASELINED — ${missing.length} fixture(s) have no baseline entry:`)
      for (const id of missing) console.error(`    ${id}`)
      console.error('\n  A new fixture must be baselined deliberately: `pnpm size:baseline`.')
      console.error('  Passing an unmeasured fixture is how the budget stopped being enforced.\n')
    }

    if (stale.length > 0) {
      console.error(`  STALE — ${stale.length} baseline entr(ies) match no measured fixture:`)
      for (const id of stale) console.error(`    ${id}`)
      console.error('\n  A fixture was renamed or deleted. Silently ignoring this shrinks the gated')
      console.error('  set without anyone noticing. Rebaseline if the removal was intended.\n')
    }

    process.exit(1)
  }

  console.log(`\n${GATE}: ok — ${fixtures.length} fixtures, all under ${CEILING}x and within ${DRIFT_TOLERANCE_PCT}% of baseline`)
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return resolve(entry) === resolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (invokedDirectly) {
  main().catch(e => fail(`unhandled: ${(e as Error).stack ?? String(e)}`))
}
