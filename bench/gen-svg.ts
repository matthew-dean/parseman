/**
 * Generate benchmark SVG charts from latest `pnpm bench` results.
 * Run: node --import tsx bench/gen-svg.ts
 *      (re-run pnpm bench first to refresh the numbers below)
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
  nearley:     '#3788C2',
  jison:       '#7C5CFC',
  native:      '#2E8B57',
  lezer:       '#5B7FC7',
  lezerWalk:   '#8FA8D9',
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

// Init bars: pinned from a stable snapshot (highly environment-sensitive — do not
// overwrite from `pnpm bench` output; warm-parse bars below are what we refresh).

const jsonChart: Chart = {
  title: 'JSON PARSING',
  initGroup: {
    title: 'initialization (one-time; others: no setup cost)',
    bars: [
      { label: 'Parséman (.compile())', us: 111.4,  color: C.compile },
      { label: 'Chevrotain',             us: 745.3, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (52 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 0.62,   color: C.macroBuild },
        { label: 'Parséman (interpreter)',  us: 1.79,   color: C.noCompile },
        { label: 'Peggy',                  us: 2.63,   color: C.peggy },
        { label: 'Jison',                  us: 6.43,   color: C.jison },
        { label: 'Nearley',                us: 6.95,   color: C.nearley },
        { label: 'Parsimmon',              us: 6.26,   color: C.parsimmon },
        { label: 'Chevrotain',             us: 7.67,   color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 0.17,   color: C.native },
      ],
    },
    {
      title: 'warm parse — medium  (1.8 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 16.30,  color: C.macroBuild },
        { label: 'Peggy',                  us: 66.70,  color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 54.50,  color: C.noCompile },
        { label: 'Jison',                  us: 195.59, color: C.jison },
        { label: 'Parsimmon',              us: 195.85, color: C.parsimmon },
        { label: 'Nearley',                us: 297.97, color: C.nearley },
        { label: 'Chevrotain',             us: 243.61, color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 3.73,   color: C.native },
      ],
    },
    {
      title: 'warm parse — large  (12 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 131.96, color: C.macroBuild },
        { label: 'Peggy',                  us: 477.14, color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 464.51, color: C.noCompile },
        { label: 'Jison',                  us: 1624.82,color: C.jison },
        { label: 'Parsimmon',              us: 1495.89,color: C.parsimmon },
        { label: 'Nearley',                us: 2573.39,color: C.nearley },
        { label: 'Chevrotain',             us: 1900.75,color: C.chevrotain },
        { label: 'JSON.parse (native)',    us: 44.74,  color: C.native },
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
      { label: 'Parséman (.compile())', us: 144.0,  color: C.compile },
      { label: 'Chevrotain',             us: 833.1, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (54 bytes, 4 rows)',
      bars: [
        { label: 'Parséman (macro build)', us: 0.34,  color: C.macroBuild },
        { label: 'Peggy',                  us: 2.02,  color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 2.31,  color: C.noCompile },
        { label: 'Parsimmon',              us: 3.59,  color: C.parsimmon },
        { label: 'Chevrotain',             us: 6.71,  color: C.chevrotain },
        { label: 'Nearley',                us: 7.80,  color: C.nearley },
      ],
    },
    {
      title: 'warm parse — large  (14.8 kB, 500 rows)',
      bars: [
        { label: 'Parséman (macro build)', us: 69.01,  color: C.macroBuild },
        { label: 'Peggy',                  us: 431.35, color: C.peggy },
        { label: 'Parsimmon',              us: 451.68, color: C.parsimmon },
        { label: 'Parséman (interpreter)',  us: 400.72, color: C.noCompile },
        { label: 'Chevrotain',             us: 1272.02,color: C.chevrotain },
        { label: 'Nearley',                us: 2754.74,color: C.nearley },
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
      { label: 'Parséman (.compile())', us: 602.7,  color: C.compile },
      { label: 'Chevrotain',             us: 1339.8, color: C.chevrotain },
    ],
  },
  groups: [
    {
      title: 'warm parse — small  (27 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 0.79,  color: C.macroBuild },
        { label: 'Peggy',                  us: 2.39,  color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 4.27,  color: C.noCompile },
        { label: 'Chevrotain',             us: 4.40,  color: C.chevrotain },
        { label: 'Nearley',                us: 6.62,  color: C.nearley },
        { label: 'Jison',                  us: 6.65,  color: C.jison },
        { label: 'Parsimmon',              us: 11.40, color: C.parsimmon },
      ],
    },
    {
      title: 'warm parse — medium  (336 bytes)',
      bars: [
        { label: 'Parséman (macro build)', us: 5.22,  color: C.macroBuild },
        { label: 'Peggy',                  us: 16.19, color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 24.76, color: C.noCompile },
        { label: 'Chevrotain',             us: 26.15, color: C.chevrotain },
        { label: 'Jison',                  us: 42.35, color: C.jison },
        { label: 'Nearley',                us: 44.40, color: C.nearley },
        { label: 'Parsimmon',              us: 58.61, color: C.parsimmon },
      ],
    },
    {
      title: 'warm parse — large  (7.8 kB)',
      bars: [
        { label: 'Parséman (macro build)', us: 125.34, color: C.macroBuild },
        { label: 'Peggy',                  us: 370.12, color: C.peggy },
        { label: 'Parséman (interpreter)',  us: 674.44, color: C.noCompile },
        { label: 'Chevrotain',             us: 752.01, color: C.chevrotain },
        { label: 'Jison',                  us: 1272.83,color: C.jison },
        { label: 'Parsimmon',              us: 1606.85,color: C.parsimmon },
        { label: 'Nearley',                us: 1464.42,color: C.nearley },
      ],
    },
  ],
}

// ── CST JSON (syntax tree building) ───────────────────────────────────────────

const cstJsonChart: Chart = {
  title: 'JSON CST — SYNTAX TREE BUILDING',
  initGroup: {
    title: 'initialization (macro build: zero runtime cost; others: no setup)',
    bars: [],
  },
  groups: [
    {
      title: 'warm parse — small  (52 bytes)',
      bars: [
        { label: 'Parséman CST (macro build)', us: 0.99,  color: C.macroBuild },
        { label: 'Lezer (parse only)',         us: 2.38,  color: C.lezer },
        { label: 'Lezer (parse + walk)',       us: 2.70,  color: C.lezerWalk },
        { label: 'Parséman CST (interpreter)', us: 2.81,  color: C.noCompile },
        { label: 'Chevrotain CST',             us: 7.81,  color: C.chevrotain },
      ],
    },
    {
      title: 'warm parse — medium  (1.8 kB)',
      bars: [
        { label: 'Parséman CST (macro build)', us: 31.01, color: C.macroBuild },
        { label: 'Lezer (parse only)',         us: 68.46, color: C.lezer },
        { label: 'Lezer (parse + walk)',       us: 76.55, color: C.lezerWalk },
        { label: 'Parséman CST (interpreter)', us: 102.22,color: C.noCompile },
        { label: 'Chevrotain CST',             us: 243.78,color: C.chevrotain },
      ],
    },
    {
      title: 'warm parse — large  (12 kB)',
      bars: [
        { label: 'Parséman CST (macro build)', us: 260.37, color: C.macroBuild },
        { label: 'Lezer (parse only)',         us: 581.87, color: C.lezer },
        { label: 'Parséman CST (interpreter)', us: 648.55, color: C.noCompile },
        { label: 'Lezer (parse + walk)',       us: 655.76, color: C.lezerWalk },
        { label: 'Chevrotain CST',             us: 1908.67,color: C.chevrotain },
      ],
    },
  ],
}

// ── write ─────────────────────────────────────────────────────────────────────

const assets = new URL('../assets', import.meta.url).pathname

writeFileSync(join(assets, 'bench-json.svg'),    buildSvg(jsonChart))
writeFileSync(join(assets, 'bench-csv.svg'),     buildSvg(csvChart))
writeFileSync(join(assets, 'bench-graphql.svg'), buildSvg(gqlChart))
writeFileSync(join(assets, 'bench-cst-json.svg'), buildSvg(cstJsonChart))

console.log('SVGs written to assets/')
