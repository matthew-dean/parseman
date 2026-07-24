/**
 * Child entry: measure ONE chart bar in a pristine process, across that chart's
 * size groups, and print the µs on a `__BAR__` line.
 *
 *   node --import tsx/esm bench/measure-bar.ts graphql parseman-macro
 *
 * One process per bar is the whole point — see chart-specs.ts. Loading every
 * competitor into one process (what bench/parsers.ts does) inflated Parséman's
 * compiled GraphQL by ~60%, and inflated each library by a different amount, so
 * bars measured that way were not comparable to one another.
 */
import { CHART_GROUPS, CHART_BARS, makeParse, BAR_MARKER, type ChartKey } from './chart-specs.ts'
import { warmUsRobust } from './measure.ts'

const chart = process.argv[2] as ChartKey
const key = process.argv[3]!
if (!chart || !(chart in CHART_GROUPS) || !CHART_BARS[chart]?.some(b => b.key === key)) {
  console.error(`measure-bar: unknown bar ${String(chart)}/${String(key)}`)
  process.exit(2)
}

const parse = await makeParse(chart, key)
const us = CHART_GROUPS[chart].map(g => warmUsRobust(() => parse(g.input), g.iters, 5))
process.stdout.write(`\n${BAR_MARKER}${JSON.stringify(us)}\n`)
