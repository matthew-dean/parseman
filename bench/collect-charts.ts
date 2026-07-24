/**
 * Run only the benchmarks that feed the docs comparison charts (JSON / CSV /
 * GraphQL / CST-JSON), then return structured µs data for SVG generation.
 *
 * This is intentionally much smaller than `pnpm bench` — no incremental re-parse,
 * combinator inlining, codegen A/B, or Parseman-only regression suite.
 *
 * Each bar is measured in its OWN child process (bench/measure-bar.ts). These
 * numbers are published, and a measurement is sensitive to what else has run in
 * its process: measured all-in-one, Parséman's compiled GraphQL read ~11.5µs
 * against ~7µs alone (~60% inflation), and — worse for a comparison chart — the
 * inflation differed per library depending on what ran before it, so the bars
 * were not comparable to each other. One process per bar removes both.
 */
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PINNED_INIT, type Bar, type Chart } from './chart-types.ts'
import { CHART_GROUPS, CHART_BARS, BAR_MARKER, type ChartKey } from './chart-specs.ts'

const __dir = dirname(fileURLToPath(import.meta.url))
const CHILD = resolve(__dir, 'measure-bar.ts')

/** µs per size group for one bar, measured in a fresh process. */
function measureBar(chart: ChartKey, key: string): number[] {
  const out = execFileSync(process.execPath, ['--import', 'tsx/esm', CHILD, chart, key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  })
  const line = out.split('\n').find(l => l.startsWith(BAR_MARKER))
  if (!line) throw new Error(`collect-charts: ${chart}/${key} produced no ${BAR_MARKER} line`)
  return JSON.parse(line.slice(BAR_MARKER.length)) as number[]
}

const CHART_TITLES: Record<ChartKey, string> = {
  json: 'JSON PARSING',
  csv: 'CSV PARSING',
  graphql: 'GRAPHQL PARSING',
  cst: 'JSON CST — SYNTAX TREE BUILDING',
}

const INIT_TITLE = 'initialization (one-time; others: no setup cost)'
const CST_INIT_TITLE = 'initialization (macro build: zero runtime cost; others: no setup)'

/**
 * Rounds of measurement, each sweeping every bar in a ROTATED order.
 *
 * Isolation alone is NOT enough: one process per bar stretches a full regen to
 * ~10 minutes, and a bar measured at minute 9 reads systematically slower than
 * one measured at minute 1 (observed: the same graphql bar read 5.8µs standalone
 * and 10.5µs late in a serial run). That drift lands straight on the bar-vs-bar
 * comparison the chart exists to make, and it favours whichever bar is measured
 * FIRST — `parseman-macro`, in all four charts. A self-published comparison must
 * not carry a bias pointing that direction.
 *
 * Rounds alone do NOT fix it, and it is worth being precise about why: with a
 * fixed per-round order, bar `i` is measured at t ≈ r·T + i·τ in every round, so
 * its median across rounds still lands at T + i·τ. The whole `i·τ` position
 * offset survives — taking a median over rounds rejects transient BLIPS, but
 * cancels nothing that is correlated with a bar's position in the sweep.
 * Simulated at the drift magnitude observed above (7-bar graphql chart), a fixed
 * order still hands bar 0 a 38.4% apparent advantage over an identical
 * competitor — versus 69.4% for a single serial pass. Better, not fixed.
 *
 * So ROTATE the order each round: bar `i` is measured at sweep position
 * (i − r·shift) mod N, i.e. every bar takes a turn near the front. Same
 * simulation, per chart: bar 0's advantage goes +39.2%→−4.4% (json),
 * +37.3%→−5.7% (csv), +38.4%→−4.8% (graphql), +35.8%→−7.1% (cst). Results are
 * still stored by the bar's ORIGINAL index; only measurement order rotates.
 *
 * Be precise about what that buys, because the previous comment here overclaimed
 * and it went unnoticed: rotation removes the SYSTEMATIC tilt toward whichever
 * bar is listed first. It does NOT shrink the total spread between the luckiest
 * and unluckiest bar — with 3 rounds over N>3 bars each bar samples only 3 of N
 * positions, so the simulated max spread between two identical bars is unchanged
 * (~36–39%). What changes is that the residual no longer points at bar 0 by
 * construction. Fully balancing it would need ROUNDS = N (a Latin square), which
 * is not worth ~N× the regen time; if these charts ever need tighter bar-vs-bar
 * resolution than ~5%, that is the lever.
 *
 * Odd round count — median() of an even list takes the upper element.
 */
const ROUNDS = 3

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

export function collectChartData(): Chart[] {
  console.log(`bench:charts — one process per bar, ${ROUNDS} rounds in rotated order…\n`)

  const charts: Chart[] = []
  for (const chart of Object.keys(CHART_GROUPS) as ChartKey[]) {
    console.log(`  [${chart}]`)
    // rounds[roundIndex][barIndex][groupIndex] — indexed by the bar's ORIGINAL
    // position; only the order we MEASURE in rotates (see ROUNDS).
    const bars = CHART_BARS[chart]
    const shift = Math.max(1, Math.round(bars.length / ROUNDS))
    const rounds: number[][][] = []
    for (let r = 0; r < ROUNDS; r++) {
      const round: number[][] = Array.from({ length: bars.length }, () => [])
      for (let k = 0; k < bars.length; k++) {
        const bi = (k + r * shift) % bars.length
        round[bi] = measureBar(chart, bars[bi]!.key)
      }
      rounds.push(round)
      process.stdout.write(`    round ${r + 1}/${ROUNDS} done (started at bar ${(r * shift) % bars.length})\n`)
    }
    // barUs[barIndex][groupIndex] — median across rounds, per group
    const barUs = CHART_BARS[chart].map((spec, bi) => {
      const us = CHART_GROUPS[chart].map((_g, gi) => median(rounds.map(round => round[bi]![gi]!)))
      console.log(`    ${spec.label.padEnd(28)} ${us.map(v => v.toFixed(2) + ' µs').join('  ')}`)
      return us
    })

    const groups = CHART_GROUPS[chart].map((g, gi) => ({
      title: g.title,
      bars: CHART_BARS[chart].map((spec, bi): Bar => ({
        label: spec.label,
        us: barUs[bi]![gi]!,
        color: spec.color,
      })),
    }))

    charts.push({
      title: CHART_TITLES[chart],
      initGroup: {
        title: chart === 'cst' ? CST_INIT_TITLE : INIT_TITLE,
        bars: chart === 'cst' ? [] : [...(PINNED_INIT[chart as keyof typeof PINNED_INIT] ?? [])],
      },
      groups,
    })
    console.log()
  }

  return charts
}
