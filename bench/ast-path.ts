/**
 * parseman's AST-PATH instrument: what a compiler pays, measured against what an
 * editor pays, on ONE grammar and ONE input.
 *
 * ## The failure this exists to fix
 *
 * The owner's ruling: "our canonical measure is our AST construction. CST is our
 * nice-to-have convenience, and also for IDE / diagnostics where speed slowdowns
 * can be slightly more hidden (you're not waiting on the command line)."
 *
 * Every speed number this repo produced was nonetheless a CST number. A lane spent
 * a very large effort on deferred leaf materialisation — a design whose entire
 * thesis is "don't build what nobody reads" — and benchmarked it exclusively on
 * `bootstrap4` CST, which reads every leaf and is therefore the one consumer where
 * that design cannot win BY CONSTRUCTION. It read 0/4 and ~19% slower and was
 * nearly closed on that evidence.
 *
 * The evidence was not wrong. It was evidence about the wrong consumer, and
 * nothing in the harness said so. So: the path is part of every workload ID
 * (`bench/workloads/index.ts`), and this instrument reports both paths side by
 * side, so an AST win with a CST cost reads as a TRADE rather than as a win.
 *
 * ## What is being compared
 *
 * Not two grammars. `bench/workloads/less.ts` is parameterised over its node
 * factory, so the AST and CST rows are the same 31 rules, the same 52 KB of Less,
 * and the same speculative rollback — differing only in the reducer and the parse
 * context. A second copy of the grammar would drift, and a drifted grammar turns a
 * path comparison into a grammar comparison.
 *
 * ## This is an INSTRUMENT, not a regression gate
 *
 * `pnpm perf:workloads` remains the ref-vs-head gate; it now carries the AST rows
 * too, so an AST regression fails a PR the same way a CST one does. This script
 * answers a different question — "which path did that number describe, and what
 * did the other path do?" — and it therefore exits 0 on a slow AST path. It exits
 * NON-ZERO only when its own self-checks fail, because an instrument that cannot
 * be trusted is worse than no instrument.
 *
 * Usage:
 *   pnpm bench:ast                # AST vs CST at HEAD, both paths, artifact bytes
 *   pnpm bench:ast --self         # SELF-CHECK 2: two byte-identical sides must not
 *                                 #   produce a win. Exits non-zero if one does.
 *   pnpm bench:ast --prove        # SELF-CHECK 1: inject a known slowdown into the
 *                                 #   AST reducer and require the instrument to see
 *                                 #   it. Exits non-zero if it does not.
 *   pnpm bench:ast --prove=40     # the same, with the injected work dialled
 *   pnpm bench:ast --quick        # fewer passes — TRIAGE ONLY, never a result
 */
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  calibrate, measurePasses, median, fail, sign,
  type Case, type Measurement, type Thresholds,
} from './ab-harness.ts'
import { compile } from '../src/index.ts'
import { beginDegradationCapture, endDegradationCapture } from '../src/compiler/degradation.ts'
import { buildWorkloads, lessEntry, type Workload } from './workloads/index.ts'
import { cstNodeFactory } from './workloads/less.ts'
import {
  astNodeFactory, censusNodeFactory, slowedNodeFactory, emptyCensus, astSize,
  type LeafCensus,
} from './workloads/ast.ts'

const GATE = 'ast-path'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = JSON.parse(readFileSync(path.join(HERE, 'workloads', 'config.json'), 'utf8')) as {
  measurement: Measurement & { passes: number }
  thresholds: Thresholds
}

/**
 * The RESOLUTION FLOOR, taken from the same measured self-check the gate's
 * thresholds are (`bench/workloads/config.json`, `_resolutionLimit`), and applied
 * by this script rather than left to the reader.
 *
 * Measured on this machine: 5.144 ms against 5.200 ms min-of-mins at a 6/15 win
 * rate, on artifacts that were BYTE-IDENTICAL. Anything smaller than this is the
 * instrument. Every delta printed below is labelled against it, because "−1.2%,
 * therefore faster" is exactly the sentence this number exists to prevent.
 */
const FLOOR_PCT = CONFIG.thresholds.signTest.medianPct

const argValue = (flag: string): string | null =>
  process.argv.find(a => a === flag || a.startsWith(`${flag}=`))?.split('=')[1] ?? null
const hasFlag = (flag: string): boolean => process.argv.some(a => a === flag || a.startsWith(`${flag}=`))

const SELF = hasFlag('--self')
const PROVE = hasFlag('--prove')
const QUICK = hasFlag('--quick')
if (SELF && PROVE) fail(GATE, '--self and --prove are two different self-checks; run them one at a time.')

const PROVE_SPINS = PROVE ? Number(argValue('--prove') ?? '24') : 0
if (PROVE && (!Number.isFinite(PROVE_SPINS) || PROVE_SPINS <= 0)) {
  fail(GATE, `--prove needs a positive spin count; got ${String(argValue('--prove'))}.`)
}

const M: Measurement & { passes: number } = QUICK
  ? { ...CONFIG.measurement, rounds: 2, runs: 1, passes: 3 }
  : CONFIG.measurement

/**
 * Every delta this script prints, checked for being a NUMBER.
 *
 * A gate in this project failed open because `NaN > tol` and `NaN < -tol` are both
 * false, so a comparison that produced no data reported no problem. A non-finite
 * delta here is a broken measurement, and a broken measurement is a FAILURE.
 */
function finite(what: string, ...values: number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) {
      fail(GATE, `${what} produced a non-finite value (${String(v)}). A measurement that produced no number `
        + `is a failure, never a pass — this check exists because a previous gate failed open on exactly `
        + `this, NaN comparing false against both its thresholds.`)
    }
  }
}

// ── the rows ────────────────────────────────────────────────────────────────
//
// Paired by base name: a row exists here only when the SAME workload is present
// on both paths, so the comparison can never silently degrade into comparing
// unrelated rows.

type Pair = { name: string; ast: Workload; cst: Workload }

const all = buildWorkloads()
const byName = new Map<string, { ast?: Workload; cst?: Workload }>()
for (const w of all) {
  const name = w.id.replace(/ \[[a-z]+\]$/, '')
  const slot = byName.get(name) ?? {}
  if (w.path === 'ast') slot.ast = w
  if (w.path === 'cst') slot.cst = w
  byName.set(name, slot)
}
const pairs: Pair[] = [...byName.entries()]
  .filter((e): e is [string, { ast: Workload; cst: Workload }] => e[1].ast !== undefined && e[1].cst !== undefined)
  .map(([name, s]) => ({ name, ast: s.ast, cst: s.cst }))

/**
 * EXAMINED SOMETHING.
 *
 * A gate in this project reported "176 problems, 1 cause" while examining
 * nothing, and a corpus gate looked clean at 582 pairs and only found a real
 * defect at 6,243. An empty or trivial comparison is a failure of this script,
 * not a clean bill of health for the compiler.
 */
if (pairs.length === 0) {
  fail(GATE, 'no workload exists on BOTH the ast and cst paths, so there is nothing to compare. '
    + 'That is a failure of this instrument, never a pass.')
}

// ── artifact bytes ──────────────────────────────────────────────────────────
//
// Raw AND gzip, because they have been measured moving in OPPOSITE directions: a
// lane shrank css −1.5% raw while it GREW +1.6% gzip, and less −0.5% raw against
// +3.7% gzip, from a fixed ~700 B prelude a small artifact cannot amortise. A raw
// number alone would have reported that as a win.

type Artifact = { label: string; raw: number; gzip: number; degraded: Map<string, number> }

/**
 * Compile, and RECORD what the compiler complained about while doing it.
 *
 * This column is not decoration. The CST reducer this repo has always used trips
 * `mk-inline-missed` on all 31 of its node sites — its parameter order does not
 * match the shape codegen can inline — so every CST node pays a `_build[n](...)`
 * call frame the AST side does not. That is a real and pre-existing cost, and part
 * of the AST-vs-CST delta below is therefore a FIXABLE CODEGEN MISS on the CST
 * side rather than an intrinsic property of the path. Printing it is the
 * difference between a measurement and a misattribution.
 */
function artifactOf(label: string, combinator: Parameters<typeof compile>[0]): Artifact {
  const degraded = new Map<string, number>()
  let src = ''
  beginDegradationCapture()
  try {
    src = compile(combinator).source
  } finally {
    for (const d of endDegradationCapture()) degraded.set(d.code, (degraded.get(d.code) ?? 0) + 1)
  }
  if (typeof src !== 'string' || src.length === 0) fail(GATE, `${label}: compile() produced no source.`)
  return { label, raw: Buffer.byteLength(src, 'utf8'), gzip: gzipSync(src).length, degraded }
}

const artifacts: Artifact[] = [
  artifactOf('less  [ast]', lessEntry(astNodeFactory)),
  artifactOf('less  [cst]', lessEntry(cstNodeFactory)),
]

// ── leaf census ─────────────────────────────────────────────────────────────
//
// Run OUTSIDE the timed path. A tally inside the reducer would put the cost of
// measuring into every number this script prints.

function censusFor(input: string): LeafCensus {
  const c = emptyCensus()
  const compiled = compile(lessEntry(censusNodeFactory(c)))
  compiled.parseWithContext(input, { trackLines: false }, 0)
  return c
}

// ── measurement ─────────────────────────────────────────────────────────────

const toCases = (pick: (p: Pair) => Workload): (() => Case[]) => () => pairs.map(p => {
  const w = pick(p)
  const built = w.make()
  return {
    id: p.name,
    detail: `${(w.bytes / 1024).toFixed(0)} KB`,
    parse: () => built.parse(),
    run: (reps: number) => { for (let n = 0; n < reps; n++) built.parse() },
  }
})

const cstSide = toCases(p => p.cst)
const astSide = toCases(p => p.ast)

/**
 * The head side, per mode.
 *
 * `--self` makes it the CST side AGAIN — two independently compiled instances of
 * byte-identical code. The instrument must not call that a win.
 * `--prove` makes it the AST side with a known amount of extra work per leaf read.
 * The instrument must call that a slowdown.
 */
const provedAst = PROVE ? lessEntry(slowedNodeFactory(PROVE_SPINS)) : null
const headSide: () => Case[] = SELF
  ? cstSide
  : PROVE
    ? () => pairs.map(p => {
      const compiled = compile(provedAst!)
      const input = p.ast.input
      return {
        id: p.name,
        detail: `${(p.ast.bytes / 1024).toFixed(0)} KB`,
        parse: () => compiled.parseWithContext(input, { trackLines: false }, 0),
        run: (reps: number) => { for (let n = 0; n < reps; n++) compiled.parseWithContext(input, { trackLines: false }, 0) },
      }
    })
    : astSide

const refSide: () => Case[] = PROVE ? astSide : cstSide

const headLabel = SELF ? 'cst (identical build)' : PROVE ? `ast + ${PROVE_SPINS} spins/leaf` : 'ast'
const refLabel = PROVE ? 'ast' : 'cst'

console.log(
  `${GATE}: ${SELF
    ? 'SELF-CHECK 2 — two BYTE-IDENTICAL builds. A win here would mean the instrument invents results.'
    : PROVE
      ? `SELF-CHECK 1 — a DELIBERATE slowdown of known size (${PROVE_SPINS} spins per leaf read) injected into the`
        + `\n  AST reducer. The instrument must see it; if it reads flat, it cannot see a real one either.`
      : 'AST path (canonical) against CST path (convenience), one grammar, one input'}`,
)
console.log(
  `  ${pairs.length} paired workload(s): ${pairs.map(p => p.name).join(', ')}`
  + `\n  ${M.passes} passes x ${M.rounds} rounds x ${M.runs} runs, ${M.warmup} warmup + ${M.timed} timed samples`
  + `\n  both sides RECOMPILED every pass, interleaved in ONE process in ONE directory, order alternated`
  + `${QUICK ? '\n  [--quick: TRIAGE ONLY, not a result]' : ''}`,
)

// Calibrated on a THROWAWAY instance set, on the reference side, and applied to
// both — so the repetition count can never favour one side and the calibration
// parses never warm an instance that then races.
const reps = calibrate(refSide(), M)
console.log(`  parses per sample: ${pairs.map(p => `${p.name} ${reps.get(p.name)}`).join(', ')}`)

const load0 = os.loadavg()[0] ?? 0
const { passRows, calibration } = measurePasses(refSide, headSide, reps, M, CONFIG.thresholds)
const load1 = os.loadavg()[0] ?? 0

type PassVerdict = 'faster' | 'slower' | 'noise'

type Summary = {
  name: string
  detail: string
  dMedians: number[]
  dMins: number[]
  passVerdicts: PassVerdict[]
  wins: number
  pairs: number
  refMedian: number
  headMedian: number
}

const summaries: Summary[] = pairs.map((p, n) => {
  const rows = passRows.map(pass => pass[n]!)
  const dMedians = rows.map(r => r.dMedian)
  const dMins = rows.map(r => r.dMin)
  finite(`${p.name} delta`, ...dMedians, ...dMins)
  return {
    name: p.name,
    detail: rows[0]!.id === p.name ? `${(p.cst.bytes / 1024).toFixed(0)} KB` : '',
    dMedians,
    dMins,
    wins: rows.reduce((a, r) => a + r.wins, 0),
    pairs: rows.reduce((a, r) => a + r.pairs, 0),
    refMedian: median(rows.map(r => r.refMedian)),
    headMedian: median(rows.map(r => r.headMedian)),
  }
})

/**
 * TWO INDEPENDENT SIGNALS MUST AGREE. A percentage alone is not a result.
 *
 * This rule is the one thing in this file that was written twice, and the reason
 * is worth keeping. The first version judged on the median alone, and
 * `--self` — two byte-identical builds — promptly called `less/mixins` 1.6%
 * FASTER, because a −1.6% median is entirely ordinary on a loaded machine. Its
 * win rate at the same moment was 34/60 against a measured null of 36/60: the
 * pairwise signal said "no effect" while the percentage said "win", and a rule
 * that reads only the percentage believes the percentage.
 *
 * That is exactly how a gate lies, and the fix is NOT to widen the floor — the
 * floor is what every other number here is judged against. The fix is to require
 * what `bench/ab-harness.ts` has always required: a magnitude past the floor AND
 * a win rate that has departed from THIS row's own measured null by the
 * configured distance. An unbiased row is judged at exactly `winRateCeiling`; a
 * row the instrument favours is judged at the same DISTANCE from its own null,
 * so the calibration can never loosen the rule.
 */
const SHIFT = 0.5 - CONFIG.thresholds.winRateCeiling

const verdictOf = (s: Summary): 'faster' | 'slower' | 'noise' => {
  const m = median(s.dMedians)
  const mn = median(s.dMins)
  const rate = s.wins / s.pairs
  const nullRate = calibration.get(s.name)!.nullRate
  finite(`${s.name} verdict`, m, mn, rate, nullRate)
  const big = Math.abs(m) >= FLOOR_PCT || Math.abs(mn) >= FLOOR_PCT
  if (!big) return 'noise'
  if (m < 0 && rate >= Math.min(1, nullRate + SHIFT)) return 'faster'
  if (m > 0 && rate <= Math.max(0, nullRate - SHIFT)) return 'slower'
  return 'noise'
}

console.log(
  `\n${headLabel} relative to ${refLabel} — negative means ${headLabel} is FASTER`
  + `\n  A row is a RESULT only when two independent signals agree: |median| or |min| past the ${FLOOR_PCT}%`
  + `\n  resolution floor, AND a win rate at least ${SHIFT.toFixed(2)} away from that row's OWN measured null.`
  + `\n  Anything else prints 'noise', however consistent its sign looks — the measured null on`
  + `\n  byte-identical artifacts on this machine is 5.144 vs 5.200 ms min-of-mins at a 6/15 win rate.\n`,
)
console.log(`  ${'workload'.padEnd(20)} ${'size'.padStart(6)}  ${refLabel.padStart(9)}  ${headLabel.padStart(22)}   median over passes        won   verdict`)
for (const s of summaries) {
  const k = calibration.get(s.name)!
  console.log(
    `  ${s.name.padEnd(20)} ${s.detail.padStart(6)}`
    + `  ${s.refMedian.toFixed(2).padStart(7)}ms`
    + `  ${s.headMedian.toFixed(2).padStart(20)}ms`
    + `   ${sign(Math.min(...s.dMedians)).padStart(7)} … ${sign(Math.max(...s.dMedians)).padStart(7)}`
    + `   ${String(s.wins).padStart(3)}/${s.pairs}`
    + `   ${verdictOf(s).padEnd(6)}`
    + (verdictOf(s) === 'noise' ? '' : `  (null ${(k.nullRate * 100).toFixed(0)}%)`),
  )
}

console.log(
  `\n  measured NULL — a control pair of two independently compiled REFERENCE instances, identical code,`
  + `\n  same passes and same run positions. Every number in this block is instrument, not compiler.\n`,
)
for (const s of summaries) {
  const k = calibration.get(s.name)!
  console.log(
    `  ${s.name.padEnd(20)} null won ${String(k.wins).padStart(3)}/${k.pairs}`
    + ` = ${(k.nullRate * 100).toFixed(1).padStart(5)}%   worst null median ${sign(k.worstNullMedian).padStart(7)}`,
  )
}

// ── the other two columns ───────────────────────────────────────────────────

if (!SELF && !PROVE) {
  console.log(`\n  compiled artifact — RAW and GZIP, because they have been measured moving in opposite directions\n`)
  const rawBase = artifacts[1]!.raw
  const gzipBase = artifacts[1]!.gzip
  for (const a of artifacts) {
    const dRaw = (a.raw / rawBase - 1) * 100
    const dGzip = (a.gzip / gzipBase - 1) * 100
    finite(`${a.label} artifact delta`, dRaw, dGzip)
    const deg = [...a.degraded.entries()].map(([code, n]) => `${code} x${n}`).join(', ')
    console.log(
      `  ${a.label.padEnd(20)} raw ${String(a.raw).padStart(8)} B (${sign(dRaw).padStart(7)})`
      + `   gzip ${String(a.gzip).padStart(7)} B (${sign(dGzip).padStart(7)})`
      + `   compression ${(a.raw / a.gzip).toFixed(2)}x`
      + `   degraded: ${deg === '' ? 'none' : deg}`,
    )
  }
  console.log(
    '  (deltas are against the cst artifact; a raw shrink beside a gzip growth is a REAL trade, not a rounding error)'
    + '\n  READ THE DEGRADED COLUMN BEFORE THE TIMINGS. The CST side trips `mk-inline-missed` on every node site,'
    + '\n  so each CST node pays a call frame the AST side does not. Part of the AST-vs-CST delta above is that'
    + '\n  FIXABLE MISS, not the path. This instrument reports the confound rather than attributing past it.',
  )

  console.log(`\n  leaf accounting on the AST path — the POPULATION any deferred-materialisation design has to win in\n`)
  for (const p of pairs) {
    const c = censusFor(p.ast.input)
    const size = astSize((p.ast.make().parse() as { value?: unknown }).value)
    if (c.allocated === 0 || size.nodes === 0) {
      fail(GATE, `${p.name}: the census examined nothing (allocated=${c.allocated}, astNodes=${size.nodes}). `
        + `A zero here is a broken instrument, not an efficient parser.`)
    }
    const pctStructural = (c.structural / c.allocated) * 100
    finite(`${p.name} census`, pctStructural)
    const rolledBack = c.nodes - size.nodes
    console.log(
      `  ${p.name.padEnd(20)} reducer calls ${String(c.nodes).padStart(6)}`
      + `   nodes KEPT ${String(size.nodes).padStart(6)}`
      + `   built-then-rolled-back ${String(rolledBack).padStart(5)}`
      + `\n  ${''.padEnd(20)} leaves ALLOCATED ${String(c.allocated).padStart(6)}`
      + `   text READ ${String(c.read).padStart(6)}`
      + `   never read ${String(c.structural).padStart(6)} = ${pctStructural.toFixed(1)}%`,
    )
  }
  console.log(
    '\n  Every leaf is allocated as a {_tag,value,span} object with its text already sliced BEFORE a reducer'
    + '\n  sees it (src/compiler/codegen.ts:794-812; there is no laziness on leaf strings today — only on the'
    + '\n  containers). So the "never read" column is work a compiler pays for and throws away, and it is the'
    + '\n  POPULATION a deferred-materialisation design would have to win in. The CST path reads all of it,'
    + '\n  which is exactly why benchmarking such a design on CST can only ever refute it.',
  )
}

console.log(`\n  load average ${load0.toFixed(2)} → ${load1.toFixed(2)}`)

// ── the self-checks ─────────────────────────────────────────────────────────

if (SELF) {
  // Two byte-identical builds. The instrument must not report a win in EITHER
  // direction — a false 'faster' is how a no-op change gets landed as an
  // improvement, and this direction is the one nobody checks.
  const claimed = summaries.filter(s => verdictOf(s) !== 'noise')
  const worst = Math.max(...summaries.map(s => Math.abs(median(s.dMedians))))
  console.log(
    `\nSELF-CHECK 2 — byte-identical sides.`
    + `\n  worst |median| across rows: ${worst.toFixed(2)}%, floor ${FLOOR_PCT}%`
    + `\n  rows that claimed a result: ${claimed.length === 0 ? 'none' : claimed.map(s => `${s.name} (${sign(median(s.dMedians))})`).join(', ')}`,
  )
  if (claimed.length > 0) {
    console.error(
      `\n${GATE}: FAILED — the instrument reported a result on code that cannot differ.`
      + `\nEither the machine is too loud to measure on right now, or the floor is wrong.`
      + `\nDo NOT widen the floor to make this pass: the floor is what every other number is judged against.`,
    )
    process.exit(1)
  }
  console.log(`\n${GATE}: self-check 2 PASSED — no win claimed on byte-identical artifacts.`)
  process.exit(0)
}

if (PROVE) {
  // A slowdown of known size, in the AST reducer, on the AST path. Every row must
  // see it. A row that reads flat is a row this instrument is blind on.
  const blind = summaries.filter(s => verdictOf(s) !== 'slower')
  console.log(
    `\nSELF-CHECK 1 — injected slowdown, ${PROVE_SPINS} spins per leaf read.`
    + `\n  rows that DETECTED it: ${summaries.filter(s => verdictOf(s) === 'slower').map(s => `${s.name} (${sign(median(s.dMedians))})`).join(', ') || 'none'}`
    + `\n  rows that read flat:   ${blind.length === 0 ? 'none' : blind.map(s => `${s.name} (${sign(median(s.dMedians))})`).join(', ')}`,
  )
  if (blind.length > 0) {
    console.error(
      `\n${GATE}: FAILED — ${blind.length} row(s) could not see a slowdown that was deliberately put there.`
      + `\nAn instrument that cannot be watched failing is not known to work. Raise --prove and try again to`
      + `\nfind this instrument's actual resolution, then say what it is — do not assume it is the floor.`,
    )
    process.exit(1)
  }
  console.log(`\n${GATE}: self-check 1 PASSED — every row detected the injected slowdown.`)
  process.exit(0)
}

console.log(
  `\n${GATE}: reported, not gated. The ref-vs-head REGRESSION gate is \`pnpm perf:workloads\`, which now`
  + `\ncarries the [ast] rows alongside the [cst] ones and thresholds each on its own.`
  + `\nBefore quoting any number above, run \`pnpm bench:ast --self\` on this machine: it is the only`
  + `\nevidence that the numbers are not the machine.`,
)
