/**
 * Run only the benchmarks that feed the docs comparison charts (JSON / CSV /
 * GraphQL / CST-JSON), then return structured µs data for SVG generation.
 *
 * This is intentionally much smaller than `pnpm bench` — no incremental re-parse,
 * combinator inlining, codegen A/B, or Parseman-only regression suite.
 */
import {
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
} from './fixtures.ts'
import { warmUs } from './measure.ts'
import { PINNED_INIT, CHART_COLORS, type Bar, type Chart } from './chart-types.ts'
import * as P from './parsers.ts'

function bar(label: string, us: number, color: string): Bar {
  return { label, us, color }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  return `${(n / 1024).toFixed(1)} kB`
}

export function collectChartData(): Chart[] {
  console.log('bench:charts — warm-parse timings for comparison SVGs…\n')

  // ── JSON ──────────────────────────────────────────────────────────────────
  const jsonGroups = [
    { title: `warm parse — small  (${fmtBytes(SMALL_JSON.length)})`, input: SMALL_JSON, iters: 50_000 },
    { title: `warm parse — medium  (${fmtBytes(MEDIUM_JSON.length)})`, input: MEDIUM_JSON, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_JSON.length)})`, input: LARGE_JSON, iters: 2_000 },
  ].map(({ title, input, iters }) => {
    console.log(`  JSON ${title}`)
    const bars = [
      bar('Parséman (macro build)', warmUs(() => P.compiledJSON.parse(input, 0), iters), CHART_COLORS.macroBuild),
      bar('Parséman (interpreter)',  warmUs(() => P.parseJSON(input), iters), CHART_COLORS.noCompile),
      bar('Peggy',                  warmUs(() => P.peggyJSON(input), iters), CHART_COLORS.peggy),
      bar('Jison',                  warmUs(() => P.jisonJSON(input), iters), CHART_COLORS.jison),
      bar('Nearley',                warmUs(() => P.nearleyJSON(input), iters), CHART_COLORS.nearley),
      bar('Parsimmon',              warmUs(() => P.parsimmonJSON(input), iters), CHART_COLORS.parsimmon),
      bar('Chevrotain',             warmUs(() => P.chevrotainJSON(input), iters), CHART_COLORS.chevrotain),
      bar('JSON.parse (native)',    warmUs(() => JSON.parse(input), iters), CHART_COLORS.native),
    ]
    for (const b of bars) console.log(`    ${b.label.padEnd(28)} ${b.us.toFixed(2)} µs`)
    return { title, bars }
  })

  // ── CSV ───────────────────────────────────────────────────────────────────
  const csvGroups = [
    { title: `warm parse — small  (${SMALL_CSV.length} bytes, 4 rows)`, input: SMALL_CSV, iters: 50_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_CSV.length)}, 500 rows)`, input: LARGE_CSV, iters: 5_000 },
  ].map(({ title, input, iters }) => {
    console.log(`\n  CSV ${title}`)
    const bars = [
      bar('Parséman (macro build)', warmUs(() => P.compiledCSV.parse(input), iters), CHART_COLORS.macroBuild),
      bar('Peggy',                  warmUs(() => P.peggyCSV(input), iters), CHART_COLORS.peggy),
      bar('Parséman (interpreter)',  warmUs(() => P.parseCSV(input), iters), CHART_COLORS.noCompile),
      bar('Parsimmon',              warmUs(() => P.parsimmonCSV(input), iters), CHART_COLORS.parsimmon),
      bar('Chevrotain',             warmUs(() => P.chevrotainCSV(input), iters), CHART_COLORS.chevrotain),
      bar('Nearley',                warmUs(() => P.nearleyCSV(input), iters), CHART_COLORS.nearley),
    ]
    for (const b of bars) console.log(`    ${b.label.padEnd(28)} ${b.us.toFixed(2)} µs`)
    return { title, bars }
  })

  // ── GraphQL ───────────────────────────────────────────────────────────────
  const gqlGroups = [
    { title: `warm parse — small  (${SMALL_GQL.length} bytes)`, input: SMALL_GQL, iters: 50_000 },
    { title: `warm parse — medium  (${MEDIUM_GQL.length} bytes)`, input: MEDIUM_GQL, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_GQL.length)})`, input: LARGE_GQL, iters: 2_000 },
  ].map(({ title, input, iters }) => {
    console.log(`\n  GraphQL ${title}`)
    const bars = [
      bar('Parséman (macro build)', warmUs(() => P.compiledGraphQL.parse(input), iters), CHART_COLORS.macroBuild),
      bar('Peggy',                  warmUs(() => P.peggyGQL(input), iters), CHART_COLORS.peggy),
      bar('Parséman (interpreter)',  warmUs(() => P.parseGraphQL(input), iters), CHART_COLORS.noCompile),
      bar('Chevrotain',             warmUs(() => P.chevrotainGQL(input), iters), CHART_COLORS.chevrotain),
      bar('Nearley',                warmUs(() => P.nearleyGQL(input), iters), CHART_COLORS.nearley),
      bar('Jison',                  warmUs(() => P.jisonGQL(input), iters), CHART_COLORS.jison),
      bar('Parsimmon',              warmUs(() => P.parsimmonGQL(input), iters), CHART_COLORS.parsimmon),
    ]
    for (const b of bars) console.log(`    ${b.label.padEnd(28)} ${b.us.toFixed(2)} µs`)
    return { title, bars }
  })

  // ── CST JSON ──────────────────────────────────────────────────────────────
  const cstGroups = [
    { title: `warm parse — small  (${fmtBytes(SMALL_JSON.length)})`, input: SMALL_JSON, iters: 50_000 },
    { title: `warm parse — medium  (${fmtBytes(MEDIUM_JSON.length)})`, input: MEDIUM_JSON, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_JSON.length)})`, input: LARGE_JSON, iters: 2_000 },
  ].map(({ title, input, iters }) => {
    console.log(`\n  CST JSON ${title}`)
    const bars = [
      bar('Parséman CST (macro build)', warmUs(() => P.parsermanCSTCompiled(input), iters), CHART_COLORS.macroBuild),
      bar('Lezer (parse only)',         warmUs(() => P.lezerJSONParse(input), iters), CHART_COLORS.lezer),
      bar('Lezer (parse + walk)',       warmUs(() => P.lezerJSON(input), iters), CHART_COLORS.lezerWalk),
      bar('Parséman CST (interpreter)', warmUs(() => P.parsermanCSTJSONNoTriv(input), iters), CHART_COLORS.noCompile),
      bar('Chevrotain CST',             warmUs(() => P.chevrotainJSON(input), iters), CHART_COLORS.chevrotain),
    ]
    for (const b of bars) console.log(`    ${b.label.padEnd(28)} ${b.us.toFixed(2)} µs`)
    return { title, bars }
  })

  console.log()
  return [
    {
      title: 'JSON PARSING',
      initGroup: {
        title: 'initialization (one-time; others: no setup cost)',
        bars: [...PINNED_INIT.json],
      },
      groups: jsonGroups,
    },
    {
      title: 'CSV PARSING',
      initGroup: {
        title: 'initialization (one-time; others: no setup cost)',
        bars: [...PINNED_INIT.csv],
      },
      groups: csvGroups,
    },
    {
      title: 'GRAPHQL PARSING',
      initGroup: {
        title: 'initialization (one-time; others: no setup cost)',
        bars: [...PINNED_INIT.graphql],
      },
      groups: gqlGroups,
    },
    {
      title: 'JSON CST — SYNTAX TREE BUILDING',
      initGroup: {
        title: 'initialization (macro build: zero runtime cost; others: no setup)',
        bars: [],
      },
      groups: cstGroups,
    },
  ]
}
