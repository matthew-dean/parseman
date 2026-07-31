/**
 * Measure Parséman's MARGIN over every competitor in the published comparison
 * charts (JSON / CSV / GraphQL / CST-JSON) — the bar the project holds itself
 * to: "still the fastest compiled JS parser in the SVG tests".
 *
 *   pnpm bench:margin              # 3 rounds, all four charts
 *   pnpm bench:margin -- --rounds 5 --charts json,graphql
 *
 * WHY THIS EXISTS SEPARATELY FROM `bench:svg`
 *
 * `bench:svg` renders the published pictures. It reduces each bar to a MEDIAN
 * over rounds and throws the per-round samples away, which is the right call for
 * a picture and the wrong one for a gate: a median cannot tell you whether a 4%
 * shift is a real regression or this box's noise floor. This script keeps every
 * round, and reports three things instead of one:
 *
 *   min          the fastest observed µs per bar. On a loaded box every sample
 *                is the true cost PLUS interference, so the distribution has a
 *                hard floor and a long right tail — the minimum is the closest
 *                estimate of the underlying cost, and it is what this harness
 *                leads with. A median moves when the machine gets busier; the
 *                min mostly does not.
 *   win-rate     of the R rounds, how many did Parséman win against that
 *                competitor? Rounds are PAIRED — within a round the two bars are
 *                measured seconds apart under the same machine conditions — so
 *                this is a sign test over paired samples, and it survives drift
 *                that would swamp a ratio of independent means.
 *   control      an A/A pair: `parseman-macro` measured twice per round, in two
 *                separate processes, under two slots. Its ratio should read ~1.0
 *                and its win-rate ~50%. It is measured in the SAME run as
 *                everything else, so it prices that run's noise floor directly.
 *                A margin smaller than the control's spread is not a margin.
 *
 * The measurement protocol itself is deliberately IDENTICAL to the published
 * charts' — same `bench/measure-bar.ts` child, one process per bar, same rotated
 * sweep order (see bench/collect-charts.ts for why both are load-bearing). This
 * script must report the margin the charts would show, not a friendlier one.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHART_GROUPS, CHART_BARS, BAR_MARKER, type ChartKey } from './chart-specs.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
const CHILD = resolve(__dir, 'measure-bar.ts')
const BAR_TIMEOUT_MS = 10 * 60_000

/** The bar every other bar is compared against — Parséman's compiled output. */
const SUBJECT = 'parseman-macro'
/** Slot name for the A/A control. Not a real bar; measures SUBJECT a second time. */
const CONTROL = '__control__'

type Slot = { slot: string; key: string }

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const ROUNDS = Number(argOf('rounds', '3'))
const CHARTS = argOf('charts', 'json,csv,graphql,cst')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean) as ChartKey[]
const OUT = argOf('out', '')

for (const c of CHARTS) {
  if (!(c in CHART_GROUPS)) throw new Error(`svg-margin: unknown chart ${c}`)
}
if (!Number.isInteger(ROUNDS) || ROUNDS < 1) throw new Error(`svg-margin: bad --rounds ${ROUNDS}`)

/** µs per size group for one bar, measured in a fresh process. */
function measureBar(chart: ChartKey, key: string): number[] {
  const out = execFileSync(process.execPath, ['--import', 'tsx/esm', CHILD, chart, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: BAR_TIMEOUT_MS,
  })
  const line = out.split('\n').find(l => l.startsWith(BAR_MARKER))
  if (!line) throw new Error(`svg-margin: ${chart}/${key} produced no ${BAR_MARKER} line`)
  return JSON.parse(line.slice(BAR_MARKER.length)) as number[]
}

const min = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a))

type GroupResult = {
  group: string
  subjectMin: number
  rows: {
    slot: string
    label: string
    min: number
    /** competitor_min / subject_min — >1 means Parséman is that many × faster. */
    ratio: number
    /** rounds Parséman won, out of ROUNDS (paired within round). */
    wins: number
    rounds: number
  }[]
}

const results: { chart: ChartKey; groups: GroupResult[] }[] = []
const raw: Record<string, Record<string, number[][]>> = {}

console.log(
  `bench:margin — ${ROUNDS} rounds, rotated order, one process per bar, ` +
    `charts: ${CHARTS.join(', ')}\n`,
)

for (const chart of CHARTS) {
  // Every real bar, plus an A/A control slot that re-measures the subject.
  const slots: Slot[] = [
    ...CHART_BARS[chart].map(b => ({ slot: b.key, key: b.key })),
    { slot: CONTROL, key: SUBJECT },
  ]
  const labelOf = (slot: string) =>
    slot === CONTROL
      ? 'CONTROL (A/A, same bar)'
      : CHART_BARS[chart].find(b => b.key === slot)!.label

  console.log(`  [${chart}] ${slots.length} slots × ${ROUNDS} rounds`)

  // samples[slot][groupIndex][roundIndex]
  const samples: Record<string, number[][]> = {}
  for (const s of slots) samples[s.slot] = CHART_GROUPS[chart].map(() => [])

  const shift = Math.max(1, Math.round(slots.length / ROUNDS))
  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < slots.length; k++) {
      const s = slots[(k + r * shift) % slots.length]!
      const us = measureBar(chart, s.key)
      us.forEach((v, gi) => samples[s.slot]![gi]!.push(v))
    }
    process.stdout.write(`    round ${r + 1}/${ROUNDS} done\n`)
  }
  raw[chart] = samples

  const groups: GroupResult[] = CHART_GROUPS[chart].map((g, gi) => {
    const subj = samples[SUBJECT]![gi]!
    const subjectMin = min(subj)
    const rows = slots
      .filter(s => s.slot !== SUBJECT)
      .map(s => {
        const other = samples[s.slot]![gi]!
        let wins = 0
        for (let r = 0; r < ROUNDS; r++) if (subj[r]! < other[r]!) wins++
        return {
          slot: s.slot,
          label: labelOf(s.slot),
          min: min(other),
          ratio: min(other) / subjectMin,
          wins,
          rounds: ROUNDS,
        }
      })
    return { group: g.title, subjectMin, rows }
  })
  results.push({ chart, groups })
  console.log()
}

// ── Report ────────────────────────────────────────────────────────────────────
let fastestEverywhere = true
for (const { chart, groups } of results) {
  console.log(`\n═══ ${chart.toUpperCase()} ═══`)
  for (const g of groups) {
    console.log(`\n  ${g.group}`)
    console.log(`  Parséman (macro build)         ${g.subjectMin.toFixed(3)} µs  (min of ${ROUNDS})`)
    console.log(`  ${'competitor'.padEnd(30)} ${'min µs'.padStart(9)} ${'×'.padStart(8)}  win-rate`)
    for (const row of g.rows) {
      const slower = row.ratio >= 1
      // A competitor being faster than Parséman is the thing this bar exists to
      // catch; do not let it read as an ordinary row.
      const flag = row.slot === CONTROL ? '  (control)' : slower ? '' : '  ← SLOWER THAN COMPETITOR'
      if (!slower && row.slot !== CONTROL && row.slot !== 'native') fastestEverywhere = false
      console.log(
        `  ${row.label.padEnd(30)} ${row.min.toFixed(3).padStart(9)} ` +
          `${row.ratio.toFixed(2).padStart(7)}× ${`${row.wins}/${row.rounds}`.padStart(9)}${flag}`,
      )
    }
  }
}

console.log(
  `\n\nBAR: ${
    fastestEverywhere
      ? 'HELD — Parséman (macro build) is fastest in every measured comparison'
      : 'BROKEN — see rows marked SLOWER THAN COMPETITOR above'
  }`,
)
console.log(
  'Note: `JSON.parse (native)` is C++ in the engine, not a JS parser generator; ' +
    'it is excluded from the bar.',
)

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ rounds: ROUNDS, results, raw }, null, 2))
  console.log(`\nraw samples → ${OUT}`)
}

process.exitCode = fastestEverywhere ? 0 : 1
