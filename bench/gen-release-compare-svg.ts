/** Render the committed 0.26/0.27/0.28 release-comparison evidence. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Version = { revision: string; cases: Record<string, number[]> }
type Collector = { revision: string; samples: number[]; outputHash: string; sourceBytes: number }
type Data = {
  protocol: { metric: string; freshProcesses: number; samplesPerRun: number }
  versions: Record<string, Version>
  collectorElision: { baseline: Collector; candidate: Collector }
}

const root = new URL('..', import.meta.url).pathname
const data = JSON.parse(readFileSync(join(root, 'bench/release-0.28-performance.json'), 'utf8')) as Data
const out = join(root, 'assets')
const font = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
const colors = ['#8c959f', '#9b8fef', '#534ab7']

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function fmt(us: number): string {
  return us < 10 ? `${us.toFixed(2)} µs` : `${us.toFixed(1)} µs`
}

function releaseChart(): string {
  const versions = Object.keys(data.versions)
  const cases = Object.keys(data.versions[versions[0]!]!.cases)
  const width = 800
  const barX = 292
  const barW = 360
  const rowH = 48
  const top = 98
  const height = top + cases.length * rowH + 38
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" rx="6" fill="white"/>`,
    `<text x="20" y="30" font-size="16" font-weight="600" fill="#24292f" font-family="${font}">Parseman 0.28 release comparison — compiled parsers</text>`,
    `<text x="20" y="50" font-size="11" fill="#57606a" font-family="${font}">${esc(data.protocol.metric)} · ${data.protocol.freshProcesses} fresh processes/version · median of ${data.protocol.samplesPerRun} samples/process</text>`,
    `<text x="780" y="50" text-anchor="end" font-size="10.5" fill="#8c959f" font-family="${font}">shorter is faster · each fixture scaled independently</text>`,
  ]
  let legendX = 20
  for (let i = 0; i < versions.length; i++) {
    const version = versions[i]!
    const revision = data.versions[version]!.revision
    lines.push(`<rect x="${legendX}" y="66" width="11" height="11" rx="2" fill="${colors[i]!}"/>`)
    lines.push(`<text x="${legendX + 15}" y="76" font-size="11.5" fill="#57606a" font-family="${font}">${version} (${revision})</text>`)
    legendX += 160
  }
  for (let index = 0; index < cases.length; index++) {
    const id = cases[index]!
    const values = versions.map(version => median(data.versions[version]!.cases[id]!))
    const max = Math.max(...values, 1)
    const y = top + index * rowH
    lines.push(`<text x="${barX - 12}" y="${y + 27}" text-anchor="end" font-size="12" fill="#24292f" font-family="${font}">${id}</text>`)
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!
      const py = y + i * 13
      const w = Math.max(3, value / max * barW)
      lines.push(`<rect x="${barX}" y="${py}" width="${barW}" height="10" rx="2" fill="#eaeef2"/>`)
      lines.push(`<rect x="${barX}" y="${py}" width="${w.toFixed(1)}" height="10" rx="2" fill="${colors[i]!}"/>`)
      lines.push(`<text x="${barX + w + 5}" y="${py + 9}" font-size="10.5" fill="#57606a" font-family="${font}">${fmt(value)}</text>`)
    }
  }
  lines.push('</svg>')
  return lines.join('\n')
}

function collectorChart(): string {
  const { baseline, candidate } = data.collectorElision
  const values = [median(baseline.samples), median(candidate.samples)]
  const labels = ['before elision', 'AST-only collector elision']
  const max = Math.max(...values)
  const width = 760
  const barX = 285
  const barW = 360
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 230" width="${width}" height="230">`,
    `<rect width="${width}" height="230" rx="6" fill="white"/>`,
    `<text x="20" y="30" font-size="16" font-weight="600" fill="#24292f" font-family="${font}">Direct-AST collector elision</text>`,
    `<text x="20" y="50" font-size="11" fill="#57606a" font-family="${font}">2,000 direct AST nodes per parse · same output SHA-256 in both generated parsers</text>`,
  ]
  for (let i = 0; i < values.length; i++) {
    const y = 82 + i * 52
    const w = values[i]! / max * barW
    lines.push(`<text x="${barX - 12}" y="${y + 17}" text-anchor="end" font-size="12" fill="#24292f" font-family="${font}">${labels[i]}</text>`)
    lines.push(`<rect x="${barX}" y="${y}" width="${barW}" height="22" rx="3" fill="#eaeef2"/>`)
    lines.push(`<rect x="${barX}" y="${y}" width="${w.toFixed(1)}" height="22" rx="3" fill="${colors[i === 0 ? 0 : 2]!}"/>`)
    lines.push(`<text x="${barX + w + 6}" y="${y + 17}" font-size="11" fill="#57606a" font-family="${font}">${fmt(values[i]!)}</text>`)
  }
  lines.push(`<text x="20" y="196" font-size="10.5" fill="#8c959f" font-family="${font}">output ${baseline.outputHash.slice(0, 12)}… · source ${baseline.sourceBytes} B → ${candidate.sourceBytes} B</text>`, '</svg>')
  return lines.join('\n')
}

writeFileSync(join(out, 'bench-release-0.28-compiled.svg'), releaseChart())
writeFileSync(join(out, 'bench-release-0.28-direct-ast.svg'), collectorChart())
console.log('release comparison SVGs written to assets/')
