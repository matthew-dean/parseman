#!/usr/bin/env node
/**
 * Refresh scripts/coverage-baseline.json from the coverage run's
 * coverage/coverage-summary.json (the standard istanbul "json-summary"
 * shape — a `total` row plus one row per covered file).
 *
 * Mirrors bench/parseman-perf.ts's `writeBaseline` pattern: a small committed
 * JSON file is the CI regression anchor, refreshed deliberately whenever you
 * accept a new coverage level (usually: you added tests and coverage went
 * up — never lower this to "make CI pass" without a real reason).
 *
 * Usage: pnpm coverage:baseline   (runs `vitest run --coverage` first, then this)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const SUMMARY_PATH = resolve(__dir, '../coverage/coverage-summary.json')
const BASELINE_PATH = resolve(__dir, 'coverage-baseline.json')

if (!existsSync(SUMMARY_PATH)) {
  console.error(
    `update-coverage-baseline: ${SUMMARY_PATH} not found — run \`pnpm test:coverage\` first ` +
    '(or just `pnpm coverage:baseline`, which does both steps).',
  )
  process.exit(1)
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'))
const total = summary.total
if (!total) {
  console.error('update-coverage-baseline: coverage-summary.json has no "total" row — unexpected shape')
  process.exit(1)
}

let gitRev = 'unknown'
try { gitRev = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { /* not fatal */ }

const baseline = {
  updatedAt: new Date().toISOString().slice(0, 10),
  gitRev,
  metrics: {
    lines: total.lines.pct,
    statements: total.statements.pct,
    functions: total.functions.pct,
    branches: total.branches.pct,
  },
}

writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
console.log(`update-coverage-baseline: wrote ${BASELINE_PATH}`)
console.log(`  lines ${baseline.metrics.lines}%  statements ${baseline.metrics.statements}%  functions ${baseline.metrics.functions}%  branches ${baseline.metrics.branches}%`)
console.log('Commit scripts/coverage-baseline.json to move the ratchet.')
