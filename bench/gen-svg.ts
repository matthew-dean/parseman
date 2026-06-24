/**
 * Generate benchmark SVG charts from hardcoded results.
 * Run: node --import tsx bench/gen-svg.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

const C = {
  macroBuild:  '#534AB7',
  compile:     '#9B8FEF',
  noCompile:   '#C4BAFF',
  peggy:       '#1D9E75',
  parsimmon:   '#E24B4A',
  chevrotain:  '#BA7517',
  native:      '#2E8B57',
  track:       '#eaeef2',
  initTrack:   '#f0f0f5',
  label:       '#24292f',
  muted:       '#57606a',
  dim:         '#8c959f',
}

type Bar = { label: string; us: number; color: string }
type Group = { title: string; bars: Bar[] }
type Chart = {
  title: string
  /** One-time setup costs — linear scale, rendered first */
  initGroup: Group
  /** Warm-parse groups — shared sqrt scale */
  groups: Group[]
}

function fmtUs(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`
  if (us >= 100)  return `${Math.round(us)} µs`
  if (us >= 10)   return `${us.toFixed(1)} µs`
  if (us < 0.05)  return `&lt; 0.1 µs`
  return `${us.toFixed(2)} µs`
}

function buildSvg(chart: Chart): string {
  const W    = 720
  const BAR_X = 238
  const BAR_W = 386
  const ROW_H = 28
  const BAR_H = 18

  const lines: string[] = []
  const push = (...s: string[]) => lines.push(...s)

  // ── scales ──────────────────────────────────────────────────────────────────
  // Init group: linear (one-time costs, accuracy matters more than range)
  const initMax = Math.max(...chart.initGroup.bars.map(b => b.us), 1)
  const initPx = (us: number) => us <= 0 ? 0 : Math.max(us / initMax * BAR_W, 3)

  // Parse groups: shared sqrt scale across all sizes
  const parseMax = Math.max(...chart.groups.flatMap(g => g.bars.map(b => b.us)))
  const parsePx = (us: number) => Math.pow(us / parseMax, 0.5) * BAR_W

  // ── sort bars fastest-first within every group ───────────────────────────────
  for (const b of chart.initGroup.bars) { /* already sorted below */ }
  chart.initGroup.bars.sort((a, b) => a.us - b.us)
  for (const g of chart.groups) g.bars.sort((a, b) => a.us - b.us)

  // ── layout ───────────────────────────────────────────────────────────────────
  const initRows  = chart.initGroup.bars.length
  const parseRows = chart.groups.reduce((n, g) => n + g.bars.length, 0)
  const totalRows = initRows + parseRows
  const H = 20 + 50 + 30 + 10           // top + legend + title + gap
    + 30 + (initRows  * ROW_H) + 24     // init header + rows + gap
    + (chart.groups.length * 30)         // parse group headers
    + (parseRows * ROW_H) + 20          // parse rows + bottom pad

  push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`)
  push(`<rect width="${W}" height="${H}" fill="white" rx="6"/>`)

  // ── legend ───────────────────────────────────────────────────────────────────
  const allLabels = new Set([
    ...chart.initGroup.bars.map(b => b.label),
    ...chart.groups.flatMap(g => g.bars.map(b => b.label)),
  ])
  const allLegend = [
    { color: C.macroBuild, label: 'Parséman (macro build)' },
    { color: C.compile,    label: 'Parséman (.compile())' },
    { color: C.noCompile,  label: 'Parséman (no compile)' },
    { color: C.peggy,      label: 'Peggy' },
    { color: C.parsimmon,  label: 'Parsimmon' },
    { color: C.chevrotain, label: 'Chevrotain' },
    { color: C.native,     label: 'JSON.parse (native)' },
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

  // ── chart title ───────────────────────────────────────────────────────────────
  push(`<text x="20" y="86" font-size="10.5" font-weight="600" fill="${C.dim}" letter-spacing="0.06em" font-family="${FONT}">${chart.title}</text>`)

  let y = 101

  // ── init group (linear scale, tinted track) ───────────────────────────────────
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

  // divider
  y += 8
  push(`<line x1="20" y1="${y}" x2="${W - 20}" y2="${y}" stroke="${C.track}" stroke-width="1"/>`)
  y += 16

  // ── parse groups (sqrt scale) ─────────────────────────────────────────────────
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

// ── JSON data ─────────────────────────────────────────────────────────────────

const jsonChart: Chart = {
  title: 'JSON PARSING',
  initGroup: {
    title: 'initialization (one-time; others: no setup cost)',
    bars: [
      { label: 'Parséman (.compile())', us: 86.5,   color: C.compile },
      { label: 'Chevrotain',             us: 841.4, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (52 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/1010070, color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/386521,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/577567,  color: C.noCompile },
        { label: 'Parsimmon',              us: 1e6/166279,  color: C.parsimmon },
        { label: 'Chevrotain',             us: 1e6/127148,  color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 1e6/5784304, color: C.native },
      ],
    },
    {
      title: 'warm parse — medium  (1.8 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/35941,  color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/14895,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/19464,  color: C.noCompile },
        { label: 'Parsimmon',              us: 1e6/5101,   color: C.parsimmon },
        { label: 'Chevrotain',             us: 1e6/4077,   color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 1e6/263114, color: C.native },
      ],
    },
    {
      title: 'warm parse — large  (12 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/4311,   color: C.macroBuild },
        { label: 'Parséman (no compile)',  us: 1e6/2215,   color: C.noCompile },
        { label: 'Peggy',                  us: 1e6/2103,   color: C.peggy },
        { label: 'Parsimmon',              us: 1e6/661,    color: C.parsimmon },
        { label: 'Chevrotain',             us: 1e6/518,    color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 1e6/23129,  color: C.native },
      ],
    },
  ],
}

// ── CSV data ──────────────────────────────────────────────────────────────────

const csvChart: Chart = {
  title: 'CSV PARSING',
  initGroup: {
    title: 'initialization (one-time; others: no setup cost)',
    bars: [
      { label: 'Parséman (.compile())', us: 76.1, color: C.compile },
      { label: 'Chevrotain',             us: 950.1, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (54 bytes, 4 rows)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/2963036, color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/480480,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/460276,  color: C.noCompile },
        { label: 'Parsimmon',              us: 1e6/280333,  color: C.parsimmon },
        { label: 'Chevrotain',             us: 1e6/149842,  color: C.chevrotain },
      ],
    },
    {
      title: 'warm parse — large  (14.8 kB, 500 rows)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/14600,  color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/2266,   color: C.peggy },
        { label: 'Parsimmon',              us: 1e6/2233,   color: C.parsimmon },
        { label: 'Parséman (no compile)',  us: 1e6/2658,   color: C.noCompile },
        { label: 'Chevrotain',             us: 1e6/789,    color: C.chevrotain },
      ],
    },
  ],
}

// ── GraphQL data ──────────────────────────────────────────────────────────────

const gqlChart: Chart = {
  title: 'GRAPHQL PARSING',
  initGroup: {
    title: 'initialization (one-time; others: no setup cost)',
    bars: [
      { label: 'Parséman (.compile())', us: 646.9,  color: C.compile },
      { label: 'Chevrotain',             us: 1392.2, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (27 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/1173416, color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/417964,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/247842,  color: C.noCompile },
        { label: 'Chevrotain',             us: 1e6/227064,  color: C.chevrotain },
        { label: 'Parsimmon',              us: 1e6/88231,   color: C.parsimmon },
      ],
    },
    {
      title: 'warm parse — medium  (336 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/172031, color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/62176,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/41831,  color: C.noCompile },
        { label: 'Chevrotain',             us: 1e6/37977,  color: C.chevrotain },
        { label: 'Parsimmon',              us: 1e6/17497,  color: C.parsimmon },
      ],
    },
    {
      title: 'warm parse — large  (7.8 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 1e6/6889,  color: C.macroBuild },
        { label: 'Peggy',                  us: 1e6/2681,  color: C.peggy },
        { label: 'Parséman (no compile)',  us: 1e6/1572,  color: C.noCompile },
        { label: 'Chevrotain',             us: 1e6/1343,  color: C.chevrotain },
        { label: 'Parsimmon',              us: 1e6/638,   color: C.parsimmon },
      ],
    },
  ],
}

// ── write ─────────────────────────────────────────────────────────────────────

const assets = new URL('../assets', import.meta.url).pathname

writeFileSync(join(assets, 'bench-json.svg'),    buildSvg(jsonChart))
writeFileSync(join(assets, 'bench-csv.svg'),     buildSvg(csvChart))
writeFileSync(join(assets, 'bench-graphql.svg'), buildSvg(gqlChart))

console.log('SVGs written to assets/')
