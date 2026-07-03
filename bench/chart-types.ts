/** Chart data model + color palette for comparison SVGs (docs/assets/bench-*.svg). */

export const CHART_COLORS = {
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
} as const

export type Bar = { label: string; us: number; color: string }
export type Group = { title: string; bars: Bar[] }
export type Chart = {
  title: string
  /** One-time setup costs — linear scale, rendered first */
  initGroup: Group
  /** Warm-parse groups — shared sqrt scale */
  groups: Group[]
}

/** Init bars pinned from a stable snapshot — highly environment-sensitive. */
export const PINNED_INIT = {
  json: [
    { label: 'Parséman (.compile())', us: 111.4,  color: CHART_COLORS.compile },
    { label: 'Chevrotain',             us: 745.3, color: CHART_COLORS.chevrotain },
  ],
  csv: [
    { label: 'Parséman (.compile())', us: 144.0,  color: CHART_COLORS.compile },
    { label: 'Chevrotain',             us: 833.1, color: CHART_COLORS.chevrotain },
  ],
  graphql: [
    { label: 'Parséman (.compile())', us: 602.7,  color: CHART_COLORS.compile },
    { label: 'Chevrotain',             us: 1339.8, color: CHART_COLORS.chevrotain },
  ],
} satisfies Record<string, Bar[]>
