import type { Chart } from './chart-types.ts'
import { CHART_COLORS } from './chart-types.ts'

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

const C = {
  ...CHART_COLORS,
  track:     '#eaeef2',
  initTrack: '#f0f0f5',
  label:     '#24292f',
  muted:     '#57606a',
  dim:       '#8c959f',
}

function fmtUs(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`
  if (us >= 100)  return `${Math.round(us)} µs`
  if (us >= 10)   return `${us.toFixed(1)} µs`
  if (us < 0.05)  return `&lt; 0.1 µs`
  return `${us.toFixed(2)} µs`
}

export function buildSvg(chart: Chart): string {
  const W    = 720
  const BAR_X = 238
  const BAR_W = 386
  const ROW_H = 28
  const BAR_H = 18

  const lines: string[] = []
  const push = (...s: string[]) => lines.push(...s)

  const initMax = Math.max(...chart.initGroup.bars.map(b => b.us), 1)
  const initPx = (us: number) => us <= 0 ? 0 : Math.max(us / initMax * BAR_W, 3)

  const parseMax = Math.max(...chart.groups.flatMap(g => g.bars.map(b => b.us)))
  const parsePx = (us: number) => Math.pow(us / parseMax, 0.5) * BAR_W

  chart.initGroup.bars.sort((a, b) => a.us - b.us)
  for (const g of chart.groups) g.bars.sort((a, b) => a.us - b.us)

  const initRows  = chart.initGroup.bars.length
  const parseRows = chart.groups.reduce((n, g) => n + g.bars.length, 0)
  const H = 20 + 50 + 30 + 10
    + 30 + (initRows  * ROW_H) + 24
    + (chart.groups.length * 30)
    + (parseRows * ROW_H) + 20

  push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`)
  push(`<rect width="${W}" height="${H}" fill="white" rx="6"/>`)

  const allLabels = new Set([
    ...chart.initGroup.bars.map(b => b.label),
    ...chart.groups.flatMap(g => g.bars.map(b => b.label)),
  ])
  const allLegend = [
    { color: C.macroBuild, label: 'Parséman (macro build)' },
    { color: C.compile,    label: 'Parséman (compile())' },
    { color: C.noCompile,  label: 'Parséman (interpreter)' },
    { color: C.peggy,      label: 'Peggy' },
    { color: C.parsimmon,  label: 'Parsimmon' },
    { color: C.chevrotain, label: 'Chevrotain' },
    { color: C.nearley,    label: 'Nearley' },
    { color: C.jison,      label: 'Jison' },
    { color: C.native,     label: 'JSON.parse (native)' },
    { color: C.lezer,      label: 'Lezer (parse only)' },
    { color: C.lezerWalk,  label: 'Lezer (parse + walk)' },
    { color: C.macroBuild, label: 'Parséman CST (macro build)' },
    { color: C.noCompile,  label: 'Parséman CST (interpreter)' },
    { color: C.chevrotain, label: 'Chevrotain CST' },
  ].filter(e => allLabels.has(e.label))

  const row1 = allLegend.slice(0, 3)
  const row2 = allLegend.slice(3)
  let lx = 20
  for (const { color, label } of row1) {
    push(`<rect x="${lx}" y="20" width="11" height="11" rx="2" fill="${color}"/>`)
    push(`<text x="${lx + 15}" y="31" font-size="11.5" fill="${C.muted}" font-family="${FONT}">${label}</text>`)
    lx += label.length * 7 + 22
  }
  lx = 20
  for (const { color, label } of row2) {
    push(`<rect x="${lx}" y="40" width="11" height="11" rx="2" fill="${color}"/>`)
    push(`<text x="${lx + 15}" y="51" font-size="11.5" fill="${C.muted}" font-family="${FONT}">${label}</text>`)
    lx += label.length * 7 + 22
  }
  push(`<text x="${W - 20}" y="31" font-size="10.5" fill="${C.dim}" text-anchor="end" font-family="${FONT}">µs — shorter is faster</text>`)

  push(`<text x="20" y="86" font-size="10.5" font-weight="600" fill="${C.dim}" letter-spacing="0.06em" font-family="${FONT}">${chart.title}</text>`)

  let y = 101

  push(`<text x="20" y="${y}" font-size="12.5" fill="${C.muted}" font-family="${FONT}">${chart.initGroup.title}</text>`)
  y += 20

  for (const bar of chart.initGroup.bars) {
    const textY = y + BAR_H - 3
    const px = initPx(bar.us)
    push(`<text x="${BAR_X - 8}" y="${textY}" text-anchor="end" font-size="12" fill="${C.label}" font-family="${FONT}">${bar.label}</text>`)
    push(`<rect x="${BAR_X}" y="${y}" width="${BAR_W}" height="${BAR_H}" rx="3" fill="${C.initTrack}"/>`)
    push(`<rect x="${BAR_X}" y="${y}" width="${px.toFixed(1)}" height="${BAR_H}" rx="3" fill="${bar.color}"/>`)
    const valX = bar.us > 0 ? BAR_X + px + 5 : BAR_X + 8
    push(`<text x="${valX}" y="${textY}" font-size="11" fill="${C.muted}" font-family="${FONT}">${fmtUs(bar.us)}</text>`)
    y += ROW_H
  }

  y += 8
  push(`<line x1="20" y1="${y}" x2="${W - 20}" y2="${y}" stroke="${C.track}" stroke-width="1"/>`)
  y += 16

  for (const group of chart.groups) {
    push(`<text x="20" y="${y}" font-size="12.5" fill="${C.muted}" font-family="${FONT}">${group.title}</text>`)
    y += 20

    for (const bar of group.bars) {
      const textY = y + BAR_H - 3
      const px = Math.min(parsePx(bar.us), BAR_W)
      push(`<text x="${BAR_X - 8}" y="${textY}" text-anchor="end" font-size="12" fill="${C.label}" font-family="${FONT}">${bar.label}</text>`)
      push(`<rect x="${BAR_X}" y="${y}" width="${BAR_W}" height="${BAR_H}" rx="3" fill="${C.track}"/>`)
      push(`<rect x="${BAR_X}" y="${y}" width="${px.toFixed(1)}" height="${BAR_H}" rx="3" fill="${bar.color}"/>`)
      push(`<text x="${BAR_X + px + 5}" y="${textY}" font-size="11" fill="${C.muted}" font-family="${FONT}">${fmtUs(bar.us)}</text>`)
      y += ROW_H
    }

    y += 16
  }

  push(`</svg>`)
  return lines.join('\n')
}
