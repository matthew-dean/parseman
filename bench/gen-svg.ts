/** Write comparison-chart SVGs to assets/ (runs chart benchmarks, then renders). */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectChartData } from './collect-charts.ts'
import { buildSvg } from './svg-render.ts'

const assets = new URL('../assets', import.meta.url).pathname
const charts = collectChartData()

writeFileSync(join(assets, 'bench-json.svg'),     buildSvg(charts[0]!))
writeFileSync(join(assets, 'bench-csv.svg'),      buildSvg(charts[1]!))
writeFileSync(join(assets, 'bench-graphql.svg'),  buildSvg(charts[2]!))
writeFileSync(join(assets, 'bench-cst-json.svg'), buildSvg(charts[3]!))

console.log('SVGs written to assets/')
