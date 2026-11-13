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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { baselineFailures, callCountFailures, measureSide, minimumWorkFailures, type Reasons, type Rows } from '../../bench/call-count-guard.ts'
import { vanishedRows } from '../../bench/ab-harness.ts'
import { baseRiseFailures, dupFailures, measure, minimumWorkFailures as dupMinimumWorkFailures } from '../../bench/dup-function-guard.ts'
import { COUNTER, instrument } from '../../bench/engine-guards/instrument.ts'
import { children, duplicateCount, functionShapes, parseModule } from '../../scripts/function-shapes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = mkdtempSync(path.join(tmpdir(), 'pm-engine-guards-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** Workload rows only: the jess snapshot build is the gate's job, not this file's. */
const workloadsOnly = (row: string): boolean => row.startsWith('emitted/') || row.startsWith('closure/')

type Plant = readonly [file: string, find: string, replace: string]

/** A side whose `src/` is this repo's with the given edits, built the way the gate builds a reference. */
function plantedSide(name: string, ...plants: readonly Plant[]): string {
  const dir = path.join(TMP, name)
  for (const rel of ['src', 'bench/grammar-density', 'bench/workloads', 'bench/all-trivia.ts', 'examples', 'package.json']) cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  for (const [file, find, replace] of plants) {
    const target = path.join(dir, file)
    const text = readFileSync(target, 'utf8')
    if (text.split(find).length !== 2) throw new Error(`plant anchor must occur exactly once in ${file}: ${find}`)
    writeFileSync(target, text.replace(find, replace))
  }
  return dir
}

/**
 * The two places a workload's parse enters: `parseWithContext` on a compiled parser, and
 * `run()`, which a workload that records its trivia calls. A plant goes in both, once each.
 */
const ENTRIES = [
  ['src/table/compile.ts', '      return runOnce(input, pos, parseCtx)'],
  ['src/functional/run.ts', '  const r = invoke(entry, input, 0, ctx)'],
] as const
const atEntries = (line: string): Plant[] => ENTRIES.map(([file, anchor]) => [file, anchor, `${line}\n${anchor}`])

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
    expect(Object.keys(clean).length).toBe(14)
    expect(again).toEqual(clean)
    expect(callCountFailures(clean, again, null, 'clean')).toEqual([])
    expect(baselineFailures(clean, again)).toEqual([])
  }, 180_000)

  it('FAILS on one extra function call per parse', async () => {
    const dir = plantedSide('extra-call', ...atEntries('      ;(() => 0)()'))
    const planted = await measureSide(dir, path.join(TMP, 'extra-call-out'), workloadsOnly)
    const failures = callCountFailures(clean, planted, null, 'clean')
    expect(failures.filter(f => f.includes(' calls: '))).toHaveLength(14)
    expect(failures.every(f => f.includes('(+1 per parse)'))).toBe(true)
    expect(baselineFailures(clean, planted).some(f => f.includes('more work per parse'))).toBe(true)
  }, 180_000)

  it('FAILS on a parse-time check that adds no call', async () => {
    const dir = plantedSide('extra-check', ...atEntries("      if (input.length < 0) throw new RangeError('input')"))
    const planted = await measureSide(dir, path.join(TMP, 'extra-check-out'), workloadsOnly)
    const failures = callCountFailures(clean, planted, null, 'clean')
    expect(failures.some(f => f.includes(' calls: '))).toBe(false)
    expect(failures.filter(f => f.includes(' branches: '))).toHaveLength(14)
  }, 180_000)

  it('keeps a baseline row for the AST path each dialect ships', () => {
    const rows = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'bench/call-count-baseline.json'), 'utf8')) as Rows)
    for (const d of ['css', 'less', 'scss', 'jess']) expect(rows).toContain(`macro/${d}/ast/site.css`)
  })

  it('REFUSES a workload that stops early, instead of reading it as fewer calls', async () => {
    const dir = plantedSide('partial', ['bench/workloads/index.ts', 'const cssInput = scaleStyles(cssCorpus, 48)', "const cssInput = scaleStyles(cssCorpus, 48).replace('}', '}\\n}}}@@@ !!! not css\\n')"])
    await expect(measureSide(dir, path.join(TMP, 'partial-out'), row => row === 'emitted/')).rejects.toThrow(/css\/stylesheet: parse (FAILED|stopped|left)/)
  }, 180_000)

  describe('reason entries', () => {
    const ref: Rows = { r: { calls: 10, branches: 5 } }
    const head: Rows = { r: { calls: 13, branches: 5 } }
    const against = (rows: Record<string, unknown>): Reasons => ({ against: 'v1.0.0', rows: rows as Reasons['rows'] })

    it('excuses an increase within its limit, only for the reference it was written against', () => {
      const reasons = against({ 'r calls': { why: 'the price of a fix', limit: 3 } })
      expect(callCountFailures(ref, head, reasons, 'v1.0.0')).toEqual([])
      expect(callCountFailures(ref, head, reasons, 'v1.0.1')).toHaveLength(1)
      expect(baselineFailures(head, ref)[0]).toContain('bank the win')
    })

    it('FAILS an increase above the limit', () => {
      const [failure] = callCountFailures(ref, head, against({ 'r calls': { why: 'the price of a fix', limit: 2 } }), 'v1.0.0')
      expect(failure).toContain('above the limit of +2')
    })

    it('FAILS an entry with no reason, no limit or the old string form', () => {
      expect(callCountFailures(ref, head, against({ 'r calls': { why: '  ', limit: 3 } }), 'v1.0.0')[0]).toContain('must say why')
      expect(callCountFailures(ref, head, against({ 'r calls': { why: 'x', limit: 0 } }), 'v1.0.0')[0]).toContain('positive integer')
      expect(callCountFailures(ref, head, against({ 'r calls': 'the price of a fix' }), 'v1.0.0').length).toBeGreaterThan(0)
    })

    it('FAILS an entry that excuses nothing', () => {
      const unused = against({ 'r calls': { why: 'x', limit: 3 }, 'r branches': { why: 'x', limit: 3 }, 'gone calls': { why: 'x', limit: 3 } })
      const failures = callCountFailures(ref, head, unused, 'v1.0.0')
      expect(failures).toHaveLength(2)
      expect(failures.every(f => f.endsWith('it excuses no increase; remove it'))).toBe(true)
    })
  })

  it('REFUSES a run that counted nothing', () => {
    expect(minimumWorkFailures({}, null)).toHaveLength(3)
    expect(minimumWorkFailures({ 'emitted/a': { calls: 1, branches: 1 } }, 'emitted/')).toEqual([])
    expect(minimumWorkFailures({ 'emitted/a': { calls: 0, branches: 1 } }, 'emitted/')[0]).toContain('counted no work')
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

  it('FAILS a baseline raised from the merge base, and allows a drop or a new artifact', () => {
    expect(baseRiseFailures({ a: 1 }, { a: 2 })[0]).toContain('rose from 1 to 2')
    expect(baseRiseFailures({ a: 2 }, { a: 1, b: 9 })).toEqual([])
  })

  it('FAILS a row gone from the merge base, and allows a new one', () => {
    expect(vanishedRows({ a: 1, b: 1 }, { a: 1, c: 1 })).toEqual([expect.stringContaining('b: in the baseline at the merge base')])
    expect(vanishedRows({ a: 1 }, { a: 9, b: 1 })).toEqual([])
  })

  it('REFUSES a run that read nothing', () => {
    expect(dupMinimumWorkFailures({}, null)).toHaveLength(2)
    expect(dupMinimumWorkFailures({ 'emitted/a': { functions: 0, duplicates: 0 } }, 'emitted/')[0]).toContain('no functions')
  })

  describe('one shape', () => {
    const shape = (code: string): string => {
      const shapes = functionShapes(code, 'probe.ts', 0)
      if (shapes.length !== 1) throw new Error(`expected one function in: ${code}`)
      return shapes[0]!.hash
    }
    const original = 'function f(a) { const n = a + limit; if (n > 2) return f(n); return n }'
    it.each([
      ['an arrow copy', 'const g = (b) => { const m = b + limit; if (m > 2) return g(m); return m }'],
      ['a function expression', 'const g = function (b) { const m = b + limit; if (m > 2) return g(m); return m }'],
      ['an added return type', 'function g(b): number { const m = b + limit; if (m > 2) return g(m); return m }'],
      ['annotated parameters and locals', 'function g(b: number) { const m: number = b + limit; if (m > 2) return g(m); return m }'],
      ['an `as` cast', 'function g(b) { const m = (b as number) + limit; if (m > 2) return g(m); return m }'],
      ['a non-null assertion', 'function g(b) { const m = b! + limit; if (m > 2) return g(m); return m }'],
      ['`let` for `const`', 'function g(b) { let m = b + limit; if (m > 2) return g(m); return m }'],
    ])('treats %s as the same function', (_label, copy) => {
      expect(shape(copy)).toBe(shape(original))
    })
    it('treats an expression-bodied arrow as its return statement', () => {
      expect(shape('const g = (b) => b + limit')).toBe(shape('function f(a) { return a + limit }'))
    })
    it.each([
      ['a different free name', 'function g(b) { const m = b + other; if (m > 2) return g(m); return m }'],
      ['a different constant', 'function g(b) { const m = b + limit; if (m > 3) return g(m); return m }'],
      ['a call to another function', 'function g(b) { const m = b + limit; if (m > 2) return f(m); return m }'],
    ])('keeps %s apart', (_label, other) => {
      expect(shape(other)).not.toBe(shape(original))
    })
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

  /** Whether a module can reach `materialise`, and whether it calls the check, read from its AST. */
  const legsWiring = (code: string, file: string): { materialises: boolean; checks: boolean } => {
    let materialises = false
    let checks = false
    type Node = ReturnType<typeof parseModule>
    const fromHarness = (n: Node): boolean => {
      const source = n['source'] as { value?: unknown } | null | undefined
      return typeof source?.value === 'string' && source.value.endsWith('/ab-harness.ts')
    }
    const walk = (n: Node): void => {
      if (n.type === 'ImportDeclaration' && fromHarness(n)) {
        for (const s of n['specifiers'] as Node[]) {
          const imported = s['imported'] as { name?: unknown } | undefined
          if (s.type === 'ImportNamespaceSpecifier' || imported?.name === 'materialise') materialises = true
        }
      }
      if (n.type === 'VariableDeclarator') {
        // `const { a, b } = await import(...)` takes only what it names.
        const id = n['id'] as Node
        const init = n['init'] as Node | null
        const awaited = init?.type === 'AwaitExpression' ? init['argument'] as Node : init
        if (id.type === 'ObjectPattern' && awaited?.type === 'ImportExpression' && fromHarness(awaited)) {
          const names = (id['properties'] as Node[]).map(p => (p['key'] as { name?: unknown } | undefined)?.name)
          if (names.includes('materialise')) materialises = true
          return
        }
      }
      if (n.type === 'ImportExpression' && fromHarness(n)) materialises = true
      if (n.type === 'CallExpression') {
        const callee = n['callee'] as { name?: unknown; property?: { name?: unknown } }
        if (callee.name === 'assertIndependentLegs' || callee.property?.name === 'assertIndependentLegs') checks = true
      }
      for (const c of children(n)) walk(c)
    }
    walk(parseModule(code, file))
    return { materialises, checks }
  }

  it('reads a harness import in any form', () => {
    expect(legsWiring("import {\n  fail,\n  materialise,\n} from './ab-harness.ts'", 'a.ts')).toEqual({ materialises: true, checks: false })
    expect(legsWiring("import * as ab from './ab-harness.ts'\nab.assertIndependentLegs('g', {})", 'a.ts')).toEqual({ materialises: true, checks: true })
    expect(legsWiring("const ab = await import('./ab-harness.ts')", 'a.ts').materialises).toBe(true)
    expect(legsWiring("const { materialise } = await import('./ab-harness.ts')", 'a.ts').materialises).toBe(true)
    expect(legsWiring("const { fail } = await import('./ab-harness.ts')", 'a.ts').materialises).toBe(false)
    expect(legsWiring("// assertIndependentLegs(\nimport { fail } from './ab-harness.ts'", 'a.ts')).toEqual({ materialises: false, checks: false })
  })

  it('is called by every harness that materialises a second side', () => {
    const benches = readdirSync(path.join(ROOT, 'bench'), { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts') && f !== 'ab-harness.ts' && !f.startsWith('vendor') && !f.startsWith('node_modules'))
    const wiring = new Map(benches.map(f => [f, legsWiring(readFileSync(path.join(ROOT, 'bench', f), 'utf8'), f)]))
    const harnesses = benches.filter(f => wiring.get(f)!.materialises)
    expect(harnesses.length).toBeGreaterThanOrEqual(6)
    for (const f of harnesses) expect(wiring.get(f)!.checks, f).toBe(true)
  })

  it.runIf(existsSync(TMP.toUpperCase()))('REFUSES a case variant of the same path', () => {
    const r = run({ ref: a, head: a.toUpperCase() })
    expect(r.code).toBe(1)
    expect(r.out).toContain('both resolve parseman from')
  }, 30_000)

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
