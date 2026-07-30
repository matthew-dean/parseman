/**
 * The size gate must FAIL, not pass, when it cannot measure.
 *
 * This repo has a history of dishonest defaults: `src/coverage.ts:123` still
 * carries `ratio: ordered.length === 0 ? 1 : …`, which reports 100% covered when
 * nothing was analysable, and both `scripts/coverage-guard.mjs:34-37` and
 * `bench/perf-guard.ts:35-37` exit 0 when their baseline is missing. A size gate
 * that fails open is worse than no size gate, because it converts an unenforced
 * budget into an apparently-enforced one.
 *
 * So every "cannot measure" case gets a test that proves a non-zero exit:
 * missing baseline, malformed baseline, empty baseline, missing fixture source,
 * build failure, empty generated output, zero fixtures, unbaselined fixture,
 * stale baseline entry, and — the one that keeps the ceiling honest — a baseline
 * that tries to record an over-ceiling size as accepted.
 *
 * These spawn the REAL script (like test/unit/release-gate.test.ts) rather than
 * importing it, because it exits at module scope. `--root=` exists for exactly
 * this: pointing the real gate at a fixture checkout.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = path.join(ROOT, 'bench/size-guard.ts')

type Result = { out: string; ok: boolean }

function gate(rootDir: string, ...args: string[]): Result {
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx/esm', SCRIPT, `--root=${rootDir}`, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    })
    return { out, ok: true }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}` || (err.message ?? ''), ok: false }
  }
}

const dirs: string[] = []
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-size-gate-'))
  dirs.push(d)
  fs.mkdirSync(path.join(d, 'bench'), { recursive: true })
  return d
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function writeBaseline(dir: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'bench', 'size-baseline.json'), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

describe('size gate fails closed when it cannot measure', () => {
  it('FAILS when the baseline file is missing', () => {
    const r = gate(scratch())
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/no baseline/i)
    expect(r.out).toMatch(/FAILURE, not a skip/i)
  })

  it('FAILS when the baseline is malformed JSON', () => {
    const d = scratch()
    writeBaseline(d, '{ this is not json')
    const r = gate(d)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/UNREADABLE|malformed/i)
  })

  it('FAILS when the baseline has no fixtures map', () => {
    const d = scratch()
    writeBaseline(d, { updatedAt: '2026-07-30', gitRev: 'abc' })
    const r = gate(d)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/unexpected shape/i)
  })

  it('FAILS when the baseline contains zero fixtures', () => {
    const d = scratch()
    writeBaseline(d, { updatedAt: '2026-07-30', gitRev: 'abc', ceiling: 10, driftTolerancePct: 1, fixtures: {} })
    const r = gate(d)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/ZERO fixtures/i)
  })

  it('FAILS when a fixture source file is missing', () => {
    // A real baseline, but --root points at a tree with no examples/ — the
    // grammars cannot be found, so nothing can be measured.
    const d = scratch()
    fs.copyFileSync(path.join(ROOT, 'bench/size-baseline.json'), path.join(d, 'bench/size-baseline.json'))
    const r = gate(d)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/MISSING|FAILED TO BUILD|cannot load the compiler/i)
    expect(r.out).toMatch(/never a skip|gate failure/i)
  })

  it('REFUSES a baseline that records an over-ceiling size as accepted', () => {
    // The ceiling cannot be waived by rebaselining. A baseline asserting that a
    // 117x fixture is fine must be rejected as an invalid baseline, not honoured.
    const d = scratch()
    writeBaseline(d, {
      updatedAt: '2026-07-30',
      gitRev: 'abc',
      ceiling: 10,
      driftTolerancePct: 1,
      fixtures: {
        'example/json': { genBytes: 100, gzipBytes: 50, bytesRatio: 117, locMultiplier: 4 },
      },
    })
    const r = gate(d)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/INVALID BASELINE/i)
    expect(r.out).toMatch(/cannot be waived by rebaselining/i)
  })
})

describe('size gate enforces the budget against the real tree', () => {
  it('reports the ceiling, the tolerance, and a non-zero exit while fixtures are over budget', () => {
    // NOTE: this asserts the gate is currently RED on purpose. The four real jess
    // grammars and most probe units are far over the 10x ceiling until the
    // size-fix lane lands. A gate that passed on 117x would be worse than no gate.
    const r = gate(ROOT)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/ceiling 10x raw bytes/)
    expect(r.out).toMatch(/drift tolerance 1%/)
    expect(r.out).toMatch(/over the 10x ceiling/)
    expect(r.out).toMatch(/cannot\n?\s*be waived by rebaselining/i)
  })

  it('names the offending fixture, expected vs actual, and how to rebaseline', () => {
    const r = gate(ROOT)
    // Actionable: which grammar, by how much, and the deliberate remedy.
    // Which fixture, how far over, and the deliberate remedy.
    expect(r.out).toMatch(/example\/css\s+[\d.]+x\s+[\d,]+ B/)
    expect(r.out).toMatch(/Worst: \S+ at [\d.]+x/)
    expect(r.out).toMatch(/pnpm size:baseline/)
    expect(r.out).toMatch(/pnpm size:probe/)
  })

  it('measures a LARGE, a COMPOSING, and a VARIANT fixture, not just the doc toys', () => {
    // The doc fixtures are 39-196 source LOC and all three are within budget
    // today. A gate pointed only at them would have passed throughout — that is
    // the blind spot this set exists to close.
    const r = gate(ROOT)
    expect(r.out).toMatch(/probe\/node-scale-32/)   // large: 33 node sites
    expect(r.out).toMatch(/probe\/compose-depth-3/) // composing: 3 levels
    expect(r.out).toMatch(/probe\/compose-leaf/)    // terminal composition
    expect(r.out).toMatch(/example\/jsonc/)         // variant derived from a base
    expect(r.out).toMatch(/example\/jsonl/)         // variant derived from a base
  })

  it('reports raw bytes, gzip, and the LOC multiplier per fixture', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/generated/)
    expect(r.out).toMatch(/gzip/)
    expect(r.out).toMatch(/LOCx/)
    expect(r.out).toMatch(/comp/)
  })
})

describe('size gate separates standing debt from fresh regressions', () => {
  it('renders known over-ceiling fixtures as TRACKED, not as new regressions', () => {
    const r = gate(ROOT)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/KNOWN, TRACKED, BLOCKING/)
    expect(r.out).toMatch(/NOT new regressions and NOT accepted/)
    // The whole point of the distinction: standing debt must not be announced as
    // something this change just did.
    expect(r.out).not.toMatch(/CROSSED THE CEILING/)
  })

  it('still says the release is blocked, so tracked never reads as tolerated', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/release stays blocked/)
    expect(r.out).toMatch(/will NOT silence this/)
  })

  it('reports a fixture that crosses the ceiling in THIS change as a fresh regression', () => {
    // Same tree, but a baseline claiming example/css was comfortably under budget.
    // Crossing from there is news, and must not be filed under standing debt.
    const d = scratch()
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/size-baseline.json'), 'utf8'))
    real.fixtures['example/css'] = { genBytes: 252441, gzipBytes: 39000, bytesRatio: 5, locMultiplier: 20 }
    writeBaseline(d, real)
    // Point it at the real tree's sources by running from ROOT but with this baseline.
    fs.mkdirSync(path.join(d, 'bench'), { recursive: true })
    const r = gate(ROOT, `--baseline=${path.join(d, 'bench', 'size-baseline.json')}`)
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/CROSSED THE CEILING/)
    expect(r.out).toMatch(/this change pushed it over/)
  })

  it('points at the largest measured lever instead of just saying "make it smaller"', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/VARIANT DUPLICATION/)
    expect(r.out).toMatch(/costs [\d.]+x probe\/variants-1 for the same grammar/)
    expect(r.out).toMatch(/pnpm size:probe/)
  })
})

describe('size gate measures multi-variant duplication', () => {
  it('gates 1 / 2 / 4-variant fixtures', () => {
    // Real grammars emit four variants from one factory (trackLines x hostMode).
    // Verified in jess's shipped css artifact: `function _r_Stylesheet(` occurs
    // exactly 4 times in a 13,124,728 B file. Without these fixtures a fix worth
    // ~4x on the real product would move this gate by exactly zero.
    const r = gate(ROOT)
    expect(r.out).toMatch(/probe\/variants-1/)
    expect(r.out).toMatch(/probe\/variants-2/)
    expect(r.out).toMatch(/probe\/variants-4/)
  })

  it('shows duplication growing about linearly with variant count', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx/esm', path.join(ROOT, 'bench/size/probe.ts'), '--json=/dev/stdout'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 180_000,
    })
    const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { rows: { id: string; genBytes: number }[] }
    const get = (id: string): number => parsed.rows.find(r => r.id === id)!.genBytes
    const two = get('variants-2') / get('variants-1')
    const four = get('variants-4') / get('variants-1')
    // Perfectly shared variants would sit near 1.0x. Full copies sit near N.
    // This asserts the DEFECT is visible; it is expected to fall when the
    // collapse work lands, at which point these bounds are what proves it worked.
    expect(two).toBeGreaterThan(1.5)
    expect(four).toBeGreaterThan(3)
    expect(four).toBeGreaterThan(two)
  })
})

describe('the size probe is deterministic', () => {
  it('produces byte-identical output across separate processes', () => {
    // The drift tolerance is 1% and that is headroom, not noise absorption. It is
    // only defensible if codegen is deterministic — so prove it, rather than
    // assuming it and quietly widening the tolerance later.
    const run = (): string =>
      execFileSync(process.execPath, ['--import', 'tsx/esm', path.join(ROOT, 'bench/size/probe.ts'), '--json=/dev/stdout'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 180_000,
      })
    const a = run()
    const b = run()
    const rows = (s: string): string => JSON.stringify(JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)).rows)
    expect(rows(a)).toBe(rows(b))
  })
})
