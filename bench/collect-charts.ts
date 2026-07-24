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
 * Rounds of interleaved measurement. Isolation alone is NOT enough: one process
 * per bar stretches a full regen to ~10 minutes, and a bar measured at minute 9
 * reads systematically slower than one measured at minute 1 (observed: the same
 * graphql bar read 5.8µs standalone and 10.5µs late in a serial run). Since bar
 * order is fixed, that drift lands straight on the bar-vs-bar comparison the
 * chart exists to make — and it favours whichever bar is measured first, which is
 * Parséman in every chart.
 *
 * So sweep ALL bars per round and take each bar's median across rounds: drift
 * then hits every bar in roughly equal measure instead of accumulating down the
 * list. Odd count — median() of an even list takes the upper element.
 */
const ROUNDS = 3

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

export function collectChartData(): Chart[] {
  console.log(`bench:charts — one process per bar, ${ROUNDS} interleaved rounds…\n`)

  const charts: Chart[] = []
  for (const chart of Object.keys(CHART_GROUPS) as ChartKey[]) {
    console.log(`  [${chart}]`)
    // rounds[roundIndex][barIndex][groupIndex]
    const rounds: number[][][] = []
    for (let r = 0; r < ROUNDS; r++) {
      rounds.push(CHART_BARS[chart].map(spec => measureBar(chart, spec.key)))
      process.stdout.write(`    round ${r + 1}/${ROUNDS} done\n`)
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
