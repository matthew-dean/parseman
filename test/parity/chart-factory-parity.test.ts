/**
 * The chart runner deliberately keeps each bar isolated in its own process.
 * This gate exercises the same `makeParse()` factories before timing them, so a
 * fast prefix parser or a factory wiring drift cannot become a chart claim.
 */
import { describe, expect, it } from 'vitest'
import { CHART_GROUPS, makeParse, type ChartKey } from '../../bench/chart-specs.ts'
import { parseCSV } from '../../examples/csv/parser.ts'
import { parseGraphQL } from '../../examples/graphql/parser.ts'
import type { ParseResult } from '../../src/index.ts'

const suites: readonly {
  chart: Extract<ChartKey, 'json' | 'csv' | 'graphql'>
  reference: (input: string) => unknown
}[] = [
  { chart: 'json', reference: JSON.parse },
  { chart: 'csv', reference: parseCSV },
  { chart: 'graphql', reference: parseGraphQL },
]

describe('chart Parseman runtime factories', () => {
  it('keeps the small comparison row in every chart rather than cherry-picking wins', () => {
    for (const chart of ['json', 'csv', 'graphql', 'cst'] as const) {
      expect(CHART_GROUPS[chart][0]?.title).toContain('small')
    }
  })

  for (const { chart, reference } of suites) {
    for (const group of CHART_GROUPS[chart]) {
      it(`${chart} — ${group.title} consumes and builds the reference value`, async () => {
        const parse = await makeParse(chart, 'parseman-runtime')
        const result = parse(group.input) as ParseResult<unknown>
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.span.end).toBe(group.input.length)
        expect(result.value).toEqual(reference(group.input))
      })
    }
  }
})
