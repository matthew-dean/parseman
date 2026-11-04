/**
 * Each engine-refactor gate, shown failing on a planted violation and passing clean.
 *
 *   call-count     an extra call per parse, planted in a copy of `src/`
 *   branch tests   an always-false parse-time check, which adds no call
 *   dup-function   a function printed twice under different local names
 *   legs           two A/B legs that resolve to one tree through a symlink
 *
 * INV-13's planted fixture is in test/unit/invariant-gate.test.ts with the other rules.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { baselineFailures, callCountFailures, measureSide, type Rows } from '../../bench/call-count-guard.ts'
import { dupFailures, measure } from '../../bench/dup-function-guard.ts'
import { COUNTER, instrument } from '../../bench/engine-guards/instrument.ts'
import { duplicateCount, functionShapes } from '../../scripts/function-shapes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = mkdtempSync(path.join(tmpdir(), 'pm-engine-guards-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** Workload rows only: the jess snapshot build is the gate's job, not this file's. */
const workloadsOnly = (row: string): boolean => row.startsWith('emitted/') || row.startsWith('closure/')

/** A side whose `src/` is this repo's with one edit, built the way the gate builds a reference. */
function plantedSide(name: string, file: string, find: string, replace: string): string {
  const dir = path.join(TMP, name)
  for (const rel of ['src', 'bench/grammar-density', 'bench/workloads', 'examples', 'package.json']) cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  const target = path.join(dir, file)
  const text = readFileSync(target, 'utf8')
  if (text.split(find).length !== 2) throw new Error(`plant anchor must occur exactly once in ${file}: ${find}`)
  writeFileSync(target, text.replace(find, replace))
  return dir
}

const ENTRY = 'src/table/compile.ts'
const ANCHOR = '      return runOnce(input, pos, parseCtx)'

describe('instrumentation', () => {
  it('counts one call per function entry and one per branch test, and keeps strict mode', () => {
    const code = [
      'export function f(a) { "use strict"; return a ? g(a) : 0 }',
      'export const g = (x) => x && h()',
      'function h() { let n = 0; for (let i = 0; i < 3; i++) n++; return n }',
    ].join('\n')
    const out = instrument(code, 'probe.mjs')
    expect(out).toContain('"use strict";__pmK.c++;')
    const k = { c: 0, b: 0 }
    const run = new Function(COUNTER, `${out.replace(/export /g, '')}\nreturn f(1)`) as (k: object) => number
    expect(run(k)).toBe(3)
    // f, g, h: three entries. Tests: `a ?`, `x &&`, and four loop tests (3 true, 1 false).
    expect(k).toEqual({ c: 3, b: 6 })
  })
})

describe('call-count gate', () => {
  let clean: Rows
  it('counts the same rows twice from separate processes', async () => {
    clean = await measureSide(ROOT, path.join(TMP, 'clean-a'), workloadsOnly)
    const again = await measureSide(ROOT, path.join(TMP, 'clean-b'), workloadsOnly)
    expect(Object.keys(clean).length).toBe(10)
    expect(again).toEqual(clean)
    expect(callCountFailures(clean, again, null, 'clean')).toEqual([])
    expect(baselineFailures(clean, again)).toEqual([])
  }, 180_000)

  it('FAILS on one extra function call per parse', async () => {
    const dir = plantedSide('extra-call', ENTRY, ANCHOR, `      ;(() => 0)()\n${ANCHOR}`)
    const planted = await measureSide(dir, path.join(TMP, 'extra-call-out'), workloadsOnly)
    const failures = callCountFailures(clean, planted, null, 'clean')
    expect(failures.filter(f => f.includes(' calls: '))).toHaveLength(10)
    expect(failures.every(f => f.includes('(+1 per parse)'))).toBe(true)
    expect(baselineFailures(clean, planted).some(f => f.includes('more work per parse'))).toBe(true)
  }, 180_000)

  it('FAILS on a parse-time check that adds no call', async () => {
    const dir = plantedSide('extra-check', ENTRY, ANCHOR, `      if (pos < 0) throw new RangeError('pos')\n${ANCHOR}`)
    const planted = await measureSide(dir, path.join(TMP, 'extra-check-out'), workloadsOnly)
    const failures = callCountFailures(clean, planted, null, 'clean')
    expect(failures.some(f => f.includes(' calls: '))).toBe(false)
    expect(failures.filter(f => f.includes(' branches: '))).toHaveLength(10)
  }, 180_000)

  it('keeps a baseline row for the AST path each dialect ships', () => {
    const rows = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'bench/call-count-baseline.json'), 'utf8')) as Rows)
    for (const d of ['css', 'less', 'scss', 'jess']) expect(rows).toContain(`macro/${d}/ast/site.css`)
  })

  it('excuses an increase only for the reference its reason was written against', () => {
    const ref: Rows = { r: { calls: 10, branches: 5 } }
    const head: Rows = { r: { calls: 11, branches: 5 } }
    const reasons = { against: 'v1.0.0', rows: { 'r calls': 'the price of a fix' } }
    expect(callCountFailures(ref, head, reasons, 'v1.0.0')).toEqual([])
    expect(callCountFailures(ref, head, reasons, 'v1.0.1')).toHaveLength(1)
    expect(baselineFailures(head, ref)[0]).toContain('bank the win')
  })
})

describe('duplicate-function gate', () => {
  const body = 'let n = 0; for (let i = 0; i < xs.length; i++) { if (xs[i] > limit) n += xs[i] * 2; else n -= 1 } return n'
  it('passes functions that close over different names', () => {
    const code = `const a = (xs) => { ${body} }\nconst b = (xs) => { ${body.replace(/limit/g, 'other')} }`
    expect(duplicateCount(functionShapes(code, 'clean.mjs'))).toBe(0)
  })

  it('FAILS on a function printed twice under different local names', () => {
    const copy = body.replace(/\bn\b/g, 'acc').replace(/\bi\b/g, 'j').replace(/\bxs\b/g, 'items')
    const code = `const a = (xs) => { ${body} }\nconst b = (items) => { ${copy} }`
    const { rows } = measure([{ id: 'emitted/probe', code }])
    expect(rows['emitted/probe']).toEqual({ functions: 2, duplicates: 1 })
    expect(dupFailures({ 'emitted/probe': 0 }, rows)[0]).toContain('1 duplicated functions, baseline 0')
    expect(dupFailures({ 'emitted/probe': 1 }, rows)).toEqual([])
  })
})

describe('independent legs', () => {
  const run = (legs: Record<string, string>, self = false): { code: number | null; out: string } => {
    const script = `import { assertIndependentLegs } from ${JSON.stringify(path.join(ROOT, 'bench/ab-harness.ts'))}\n`
      + `assertIndependentLegs('legs-test', ${JSON.stringify(legs)}, ${self})`
    const r = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const a = path.join(TMP, 'leg-a')
  const b = path.join(TMP, 'leg-b')
  const link = path.join(TMP, 'leg-link')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  symlinkSync(a, link, 'dir')

  it('is called by every harness that materialises a second side', () => {
    const benches = readdirSync(path.join(ROOT, 'bench'), { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts') && f !== 'ab-harness.ts' && !f.startsWith('vendor') && !f.startsWith('node_modules'))
    const harnesses = benches.filter(f => /\bmaterialise\b[^\n]*\bfrom '[^']*ab-harness\.ts'|^\s*(?:\w+, )*materialise, /m.test(readFileSync(path.join(ROOT, 'bench', f), 'utf8')))
    expect(harnesses.sort()).toEqual([
      'call-count-guard.ts', 'grammar-perf-guard.ts', 'jess/ab.ts', 'workload-perf-guard.ts', 'xproc-ab.ts', 'xproc-gate.ts',
    ])
    for (const f of harnesses) expect(readFileSync(path.join(ROOT, 'bench', f), 'utf8'), f).toContain('assertIndependentLegs(')
  })

  it('runs on two real trees', () => {
    expect(run({ ref: a, head: b }).code).toBe(0)
  }, 30_000)

  it('REFUSES two legs that resolve to one tree', () => {
    const r = run({ ref: a, head: link })
    expect(r.code).toBe(1)
    expect(r.out).toContain('both resolve parseman from')
  }, 30_000)

  it('allows one tree only for a declared self-check', () => {
    expect(run({ ref: a, head: link }, true).code).toBe(0)
  }, 30_000)
})
