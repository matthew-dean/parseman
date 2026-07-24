/**
 * Declarative spec for the comparison charts: which bars exist, and how to build
 * ONE of them without loading any of the others.
 *
 * Every factory here is a dynamic import on purpose. `bench/parsers.ts` builds
 * every competitor at module load, so importing it drags Chevrotain, Peggy,
 * Nearley, Jison, Parsimmon and Lezer into the process whether or not you measure
 * them — and a measurement is sensitive to what else has run in its process (see
 * PERF_CONTEXTS in parseman-perf.ts). Measured: Parséman's compiled GraphQL reads
 * ~11.5µs inside the all-in-one chart harness vs ~7µs alone, a ~60% inflation. The
 * contamination is also UNEVEN — each library sees a different amount of it
 * depending on what ran before it — so the published bars were not comparable to
 * each other. bench/measure-bar.ts measures one bar per process using these.
 */
import {
  SMALL_JSON, MEDIUM_JSON, LARGE_JSON,
  SMALL_CSV, LARGE_CSV,
  SMALL_GQL, MEDIUM_GQL, LARGE_GQL,
} from './fixtures.ts'
import { CHART_COLORS } from './chart-types.ts'

export type ChartKey = 'json' | 'csv' | 'graphql' | 'cst'

/** Line prefix measure-bar.ts uses to hand its µs back to the collector. */
export const BAR_MARKER = '__BAR__'
export type GroupSpec = { title: string; input: string; iters: number }
export type BarSpec = { key: string; label: string; color: string }

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  return `${(n / 1024).toFixed(1)} kB`
}

export const CHART_GROUPS: Record<ChartKey, GroupSpec[]> = {
  json: [
    { title: `warm parse — small  (${fmtBytes(SMALL_JSON.length)})`, input: SMALL_JSON, iters: 50_000 },
    { title: `warm parse — medium  (${fmtBytes(MEDIUM_JSON.length)})`, input: MEDIUM_JSON, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_JSON.length)})`, input: LARGE_JSON, iters: 2_000 },
  ],
  csv: [
    { title: `warm parse — small  (${SMALL_CSV.length} bytes, 4 rows)`, input: SMALL_CSV, iters: 50_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_CSV.length)}, 500 rows)`, input: LARGE_CSV, iters: 5_000 },
  ],
  graphql: [
    { title: `warm parse — small  (${SMALL_GQL.length} bytes)`, input: SMALL_GQL, iters: 50_000 },
    { title: `warm parse — medium  (${MEDIUM_GQL.length} bytes)`, input: MEDIUM_GQL, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_GQL.length)})`, input: LARGE_GQL, iters: 2_000 },
  ],
  cst: [
    { title: `warm parse — small  (${fmtBytes(SMALL_JSON.length)})`, input: SMALL_JSON, iters: 50_000 },
    { title: `warm parse — medium  (${fmtBytes(MEDIUM_JSON.length)})`, input: MEDIUM_JSON, iters: 10_000 },
    { title: `warm parse — large  (${fmtBytes(LARGE_JSON.length)})`, input: LARGE_JSON, iters: 2_000 },
  ],
}

export const CHART_BARS: Record<ChartKey, BarSpec[]> = {
  json: [
    { key: 'parseman-macro', label: 'Parséman (macro build)', color: CHART_COLORS.macroBuild },
    { key: 'parseman-interp', label: 'Parséman (interpreter)', color: CHART_COLORS.noCompile },
    { key: 'peggy', label: 'Peggy', color: CHART_COLORS.peggy },
    { key: 'jison', label: 'Jison', color: CHART_COLORS.jison },
    { key: 'nearley', label: 'Nearley', color: CHART_COLORS.nearley },
    { key: 'parsimmon', label: 'Parsimmon', color: CHART_COLORS.parsimmon },
    { key: 'chevrotain', label: 'Chevrotain', color: CHART_COLORS.chevrotain },
    { key: 'native', label: 'JSON.parse (native)', color: CHART_COLORS.native },
  ],
  csv: [
    { key: 'parseman-macro', label: 'Parséman (macro build)', color: CHART_COLORS.macroBuild },
    { key: 'peggy', label: 'Peggy', color: CHART_COLORS.peggy },
    { key: 'parseman-interp', label: 'Parséman (interpreter)', color: CHART_COLORS.noCompile },
    { key: 'parsimmon', label: 'Parsimmon', color: CHART_COLORS.parsimmon },
    { key: 'chevrotain', label: 'Chevrotain', color: CHART_COLORS.chevrotain },
    { key: 'nearley', label: 'Nearley', color: CHART_COLORS.nearley },
  ],
  graphql: [
    { key: 'parseman-macro', label: 'Parséman (macro build)', color: CHART_COLORS.macroBuild },
    { key: 'peggy', label: 'Peggy', color: CHART_COLORS.peggy },
    { key: 'parseman-interp', label: 'Parséman (interpreter)', color: CHART_COLORS.noCompile },
    { key: 'chevrotain', label: 'Chevrotain', color: CHART_COLORS.chevrotain },
    { key: 'nearley', label: 'Nearley', color: CHART_COLORS.nearley },
    { key: 'jison', label: 'Jison', color: CHART_COLORS.jison },
    { key: 'parsimmon', label: 'Parsimmon', color: CHART_COLORS.parsimmon },
  ],
  cst: [
    { key: 'parseman-macro', label: 'Parséman CST (macro build)', color: CHART_COLORS.macroBuild },
    { key: 'lezer-parse', label: 'Lezer (parse only)', color: CHART_COLORS.lezer },
    { key: 'lezer-walk', label: 'Lezer (parse + walk)', color: CHART_COLORS.lezerWalk },
    { key: 'parseman-interp', label: 'Parséman CST (interpreter)', color: CHART_COLORS.noCompile },
    { key: 'chevrotain', label: 'Chevrotain CST', color: CHART_COLORS.chevrotain },
  ],
}

/** Build the single parse fn for one bar. Loads only that library. */
export async function makeParse(
  chart: ChartKey,
  key: string,
): Promise<(input: string) => unknown> {
  const k = `${chart}/${key}`
  switch (k) {
    // ── Parséman ────────────────────────────────────────────────────────────
    case 'json/parseman-macro': {
      const { compile } = await import('../src/index.ts')
      const { jsonDoc } = await import('../examples/json/parser.ts')
      const c = compile(jsonDoc)
      return input => c.parse(input, 0)
    }
    case 'json/parseman-interp': {
      const { parseJSON } = await import('../examples/json/parser.ts')
      return input => parseJSON(input)
    }
    case 'csv/parseman-macro': {
      const { compiledCSV } = await import('../examples/csv/parser.ts')
      return input => compiledCSV.parse(input)
    }
    case 'csv/parseman-interp': {
      const { parseCSV } = await import('../examples/csv/parser.ts')
      return input => parseCSV(input)
    }
    case 'graphql/parseman-macro': {
      const { compile } = await import('../src/index.ts')
      const { graphqlDoc } = await import('../examples/graphql/parser.ts')
      const c = compile(graphqlDoc)
      return input => c.parse(input)
    }
    case 'graphql/parseman-interp': {
      const { parseGraphQL } = await import('../examples/graphql/parser.ts')
      return input => parseGraphQL(input)
    }
    case 'cst/parseman-macro': {
      const { buildParsermanCSTJSONCompiled } = await import('./parseman-cst-json.ts')
      return buildParsermanCSTJSONCompiled()
    }
    case 'cst/parseman-interp': {
      const { buildParsermanCSTJSONNoTriv } = await import('./parseman-cst-json.ts')
      return buildParsermanCSTJSONNoTriv()
    }
    // ── Competitors ─────────────────────────────────────────────────────────
    case 'json/peggy': return (await import('./peggy-json.ts')).buildPeggyJSON()
    case 'csv/peggy': return (await import('./peggy-csv.ts')).buildPeggyCSV()
    case 'graphql/peggy': return (await import('./peggy-graphql.ts')).buildPeggyGraphQL()
    case 'json/jison': return (await import('./jison-json.ts')).buildJisonJSON()
    case 'graphql/jison': return (await import('./jison-graphql.ts')).buildJisonGraphQL()
    case 'json/nearley': return (await import('./nearley-json.ts')).buildNearleyJSON()
    case 'csv/nearley': return (await import('./nearley-csv.ts')).buildNearleyCSV()
    case 'graphql/nearley': return (await import('./nearley-graphql.ts')).buildNearleyGraphQL()
    case 'json/parsimmon': return (await import('./parsimmon-json.ts')).buildParsimmonJSON()
    case 'csv/parsimmon': return (await import('./parsimmon-csv.ts')).buildParsimmonCSV()
    case 'graphql/parsimmon': return (await import('./parsimmon-graphql.ts')).buildParsimmonGraphQL()
    case 'json/chevrotain': return (await import('./chevrotain-json.ts')).buildChevrotainJSON()
    case 'csv/chevrotain': return (await import('./chevrotain-csv.ts')).buildChevrotainCSV()
    case 'graphql/chevrotain': return (await import('./chevrotain-graphql.ts')).buildChevrotainGraphQL()
    case 'cst/chevrotain': return (await import('./chevrotain-cst-json.ts')).buildChevrotainCSTJSON()
    case 'cst/lezer-parse': return (await import('./lezer-json.ts')).buildLezerJSONParseOnly()
    case 'cst/lezer-walk': return (await import('./lezer-json.ts')).buildLezerJSON()
    case 'json/native': return input => JSON.parse(input)
    default:
      throw new Error(`chart-specs: no factory for ${k}`)
  }
}
