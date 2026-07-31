/**
 * `scripts/coverage-guard.mjs` is the CI coverage ratchet
 * (`.github/workflows/ci.yml`). These tests cover the two ways it used to report
 * SUCCESS having checked nothing.
 *
 *   - A missing `scripts/coverage-baseline.json` exited 0 with the word "skipping".
 *     The file going missing is precisely when the ratchet matters, and the job
 *     that consumed the exit code could not tell that state from a clean run.
 *
 *   - Istanbul reports `pct: 100` when `total === 0`. A run that instrumented ZERO
 *     files — a broken include glob, a provider that never attached, a suite that
 *     imported no source — therefore reads as 100% on every metric, which the guard
 *     compared favourably against the baseline and printed as an IMPROVEMENT. The
 *     baseline stores percentages only, so nothing downstream could catch it either.
 *     Only the denominator distinguishes "all covered" from "nothing looked at".
 *
 * They run the real script over fixture reports, which is the only way to cover a
 * script that executes at module scope, and the only way to produce a zero-
 * denominator report at all. Same approach as `release-gate.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'scripts/coverage-guard.mjs')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface Metric {
  pct: number
  total: number
}

const metric = (pct: number, total = 1000): Metric => ({ pct, total })

/** Write a fixture summary and baseline, then run the guard over them. */
function guard(
  total: Record<string, Metric> | null,
  baseline: Record<string, number> | null = { lines: 90, statements: 90, functions: 90, branches: 80 },
): { out: string; ok: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'pm-covguard-'))
  dirs.push(dir)
  const summaryPath = join(dir, 'coverage-summary.json')
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(summaryPath, JSON.stringify(total === null ? {} : { total }))
  if (baseline !== null) {
    writeFileSync(
      baselinePath,
      JSON.stringify({ updatedAt: '2026-07-30', gitRev: 'abc1234', metrics: baseline }),
    )
  }
  try {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, `--summary=${summaryPath}`, `--baseline=${baselinePath}`],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    )
    return { out, ok: true }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? ''), ok: false }
  }
}

const healthy = {
  lines: metric(91),
  statements: metric(91),
  functions: metric(91),
  branches: metric(81),
}

describe('coverage guard — fails closed', () => {
  it('passes a report that is genuinely above baseline', () => {
    const r = guard(healthy)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/coverage-guard: ok/)
  })

  it('FAILS when the baseline is missing, instead of skipping', () => {
    // The ratchet's whole value is that it is always on. "Skipping" made losing one
    // file equivalent to deleting the gate, and reported it as a pass.
    const r = guard(healthy, null)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no baseline/)
    expect(r.out).toMatch(/NOTHING was checked/)
  })

  it('FAILS a report whose denominators are ZERO, however good the percentages look', () => {
    // Istanbul's own output for "instrumented nothing": pct 100, total 0. Without the
    // denominator check this reads as +10pp on every metric and prints an IMPROVEMENT.
    const r = guard({
      lines: metric(100, 0),
      statements: metric(100, 0),
      functions: metric(100, 0),
      branches: metric(100, 0),
    })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/ZERO denominator/)
    expect(r.out).not.toMatch(/coverage-guard: ok/)
  })

  it('FAILS when only ONE metric has a zero denominator', () => {
    // Partial instrumentation is the subtler shape and gets named specifically.
    const r = guard({ ...healthy, functions: metric(100, 0) })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/functions have a ZERO denominator/)
  })

  it('still catches an ordinary regression', () => {
    // The new checks must not have displaced the thing the guard is for.
    const r = guard({ ...healthy, lines: metric(80) })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/REGRESSION/)
  })

  it('FAILS a summary with no "total" row', () => {
    const r = guard(null)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no "total" row/)
  })
})
