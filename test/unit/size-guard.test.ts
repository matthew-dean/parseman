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

/**
 * TIMEOUTS — every test here spawns the real gate or the real probe, and vitest's
 * default of 5s is a budget for an in-process unit test, not for a tsx-compiled
 * child that lowers 24 grammar fixtures.
 *
 * At load average ~60 this file failed about half its runs, always on its two
 * slowest cases: `PASSES on the committed tree` (the first `gate(ROOT)`, which
 * also pays the cold tsx compile) and `produces byte-identical output across
 * separate processes` (two probe spawns). Both sit near 1.3s idle, so a 4x
 * contention stall crossed 5s. `pnpm size:guard` never flaked because nothing
 * outside vitest was imposing a 5s ceiling on it, and CI is uncontended enough
 * that it never fired there either — the inverted budget was only ever visible
 * on a loaded developer box.
 *
 * The rule the numbers below encode: a test's vitest budget is strictly GREATER
 * than the budget of the children it spawns. The ordering matters more than the
 * absolute size. When a child genuinely hangs, the child's own timeout must be
 * what fires, because that path returns its stdout and stderr and the assertions
 * then say what went wrong; vitest firing first reports `Test timed out in
 * 5000ms` and throws the evidence away.
 *
 * So these are NOT noise absorption, and they are not sized against how long a
 * run takes. They are sized against SPAWN_BUDGET_MS, and a test that exceeds one
 * is a hang, not a slow machine.
 */
const SPAWN_BUDGET_MS = 180_000
/** Suites in which no single test spawns more than one child. */
const ONE_SPAWN_MS = SPAWN_BUDGET_MS + 30_000
/** The determinism suite spawns the probe twice inside one test. */
const TWO_SPAWN_MS = 2 * SPAWN_BUDGET_MS + 30_000

type Result = { out: string; ok: boolean }

function gate(rootDir: string, ...args: string[]): Result {
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx/esm', SCRIPT, `--root=${rootDir}`, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SPAWN_BUDGET_MS,
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
  // `maxRetries` defaults to 0, and Node documents ENOTEMPTY as a transient error
  // for recursive removal — on a loaded machine that turns tidying up into a suite
  // failure, after every case has already asserted correctly.
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
})

/**
 * Run the probe and return its JSON document.
 *
 * stderr is CAPTURED and folded into the thrown message. The probe reports why it
 * could not measure on stderr and its JSON on stdout, so discarding stderr — as
 * these call sites did — turns any probe failure into `Error: Command failed:
 * node --import tsx/esm …/probe.ts` with no reason attached, which is the exact
 * shape of unreadable failure `bench/size/probe.ts` documents at STREAM_TARGETS.
 */
function probeJson(): { rows: { id: string; genBytes: number }[] } {
  let out: string
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', path.join(ROOT, 'bench/size/probe.ts'), '--json=/dev/stdout'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SPAWN_BUDGET_MS,
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    throw new Error(`the size probe failed:\n${err.stderr ?? ''}${err.stdout ?? ''}\n${err.message ?? ''}`)
  }
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { rows: { id: string; genBytes: number }[] }
}

function writeBaseline(dir: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'bench', 'size-baseline.json'), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

describe('size gate fails closed when it cannot measure', { timeout: ONE_SPAWN_MS }, () => {
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

describe('size gate enforces the budget against the real tree', { timeout: ONE_SPAWN_MS }, () => {
  it('PASSES on the committed tree, because no fixture is above its ceiling', () => {
    // 0.45 policy: the committed genBytes IS the ceiling. The tree that produced
    // the baseline must therefore be green. The 10x target is reported, not
    // blocking — a permanently-red required check trains people to ignore CI,
    // which is how several gates in this repo went dead.
    const r = gate(ROOT)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/none above its committed ceiling/)
  })

  it('still WARNS, loudly and per fixture, about everything above the 10x target', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/WARNING — \d+ fixture\(s\) are above the 10x size target/)
    expect(r.out).toMatch(/TODO\(0\.46\)/)
    // Green must never read as "fine": the ok line itself repeats the gap.
    expect(r.out).toMatch(/still above the 10x target/)
  })

  it('names each over-target fixture, its ratio, and how far it must fall', () => {
    const r = gate(ROOT)
    // Actionable: which grammar, how far over, by what multiple, to what number.
    //
    // Pinned to a probe row, not example/css. The probe lowers through
    // `transformMacro`, which still emits SOURCE — so these are the rows that are
    // genuinely over the 10x target now. example/css goes through the library
    // `compile()`, which is the table, and it emits nothing at all (see the
    // NO ARTIFACT suite); a fixture with no artifact has no ratio to name.
    expect(r.out).toMatch(/probe\/node-scale-32\s+[\d.]+x\s+[\d,]+ B\s+[\d.]+x\s+\(to [\d,]+ B\)/)
    expect(r.out).toMatch(/Worst: \S+ at [\d.]+x/)
    expect(r.out).toMatch(/pnpm size:probe/)
  })

  it('explains WHY with the measured per-node cost, not just "make it smaller"', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/generated bytes per node\(\) site/)
    expect(r.out).toMatch(/near-CONSTANT/)
    expect(r.out).toMatch(/0\.46 plan/)
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

/**
 * The ceiling is TWO-SIDED, and the downward half is the one that usually rots.
 *
 * `bench/grammar-density/config.json` and `bench/workloads/config.json` both
 * carried a comment asking a human to bump them at each release, and both sat
 * unbumped from v0.33.0/v0.35.0 for TEN releases. A convention is not a check.
 * So an un-banked improvement fails the build exactly like a regression does.
 */
describe('the committed ceiling ratchets in both directions', { timeout: ONE_SPAWN_MS }, () => {
  /** The real tree, measured against a doctored copy of the real baseline. */
  function against(mutate: (fixtures: Record<string, { genBytes: number }>) => void): Result {
    const d = scratch()
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/size-baseline.json'), 'utf8')) as {
      fixtures: Record<string, { genBytes: number }>
    }
    mutate(real.fixtures)
    writeBaseline(d, real)
    return gate(ROOT, `--baseline=${path.join(d, 'bench', 'size-baseline.json')}`)
  }

  it('FAILS a fixture that grew past its committed ceiling', () => {
    const r = against(f => { f['example/json']!.genBytes = Math.round(f['example/json']!.genBytes * 0.95) })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/GREW PAST ITS CEILING/)
    expect(r.out).toMatch(/example\/json/)
    // Raising a ceiling is deliberate and reviewed, never incidental.
    expect(r.out).toMatch(/needs\n?\s*owner sign-off/)
  })

  it('REPORTS a fixture that shrank below it, loudly, without failing on good news', () => {
    const r = against(f => { f['example/json']!.genBytes = Math.round(f['example/json']!.genBytes * 1.05) })
    // A gate whose failure mode is "you did well" trains everyone to skim past it,
    // and the next real regression arrives wearing the same red. Report, do not block.
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/BANK THE WIN/)
    expect(r.out).toMatch(/reclaimed/)
  })

  it('does NOT report an improvement as a regression', () => {
    const r = against(f => { f['example/json']!.genBytes = Math.round(f['example/json']!.genBytes * 1.05) })
    expect(r.out).not.toMatch(/GREW PAST ITS CEILING/)
  })
})

/**
 * PRINTABILITY IS THE OTHER THING THAT CAN REGRESS, and a bytes-only gate scores
 * losing it as the best result it has ever seen.
 *
 * The table lowering keeps a construct it cannot serialise LIVE: the grammar still
 * parses, and `emitTableModule` refuses. `compile()` returns `source: ''` with a
 * null `inlineExpression`. Under the old gate that was an immediate hard failure
 * with no way to record it; under a naive re-baseline it would have become 0 B —
 * a 100% "improvement" — and the ceiling would have been 0 forever after, which is
 * a ceiling nothing can ever breach.
 *
 * So it ratchets in both directions like the bytes do, and both directions are
 * pinned here. A guard that cannot be observed failing is not known to work.
 */
describe('printability ratchets in both directions', { timeout: ONE_SPAWN_MS }, () => {
  type Entry = { genBytes: number; printable?: false; unprintable?: readonly string[] }

  function against(mutate: (fixtures: Record<string, Entry>) => void): Result {
    const d = scratch()
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/size-baseline.json'), 'utf8')) as {
      fixtures: Record<string, Entry>
    }
    mutate(real.fixtures)
    writeBaseline(d, real)
    return gate(ROOT, `--baseline=${path.join(d, 'bench', 'size-baseline.json')}`)
  }

  it('FAILS a fixture that had a ceiling and now emits nothing', () => {
    // The baseline says example/css printed; the tree says it does not. That is a
    // loss of capability, and it BLOCKS.
    const r = against(f => {
      delete f['example/css']!.printable
      delete f['example/css']!.unprintable
    })
    expect(r.ok).toBe(false)
    expect(r.out).toMatch(/STOPPED PRINTING/)
    expect(r.out).toMatch(/example\/css/)
    // Named, not just counted — otherwise the reader cannot act on it.
    expect(r.out).toMatch(/rules\(\{ trivia \}\)/)
    // And it must never be described as a size win.
    expect(r.out).not.toMatch(/BANK THE WIN[\s\S]*example\/css/)
  })

  it('REPORTS a fixture that prints again, without failing on good news', () => {
    const r = against(f => { f['example/json']!.printable = false })
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/PRINT AGAIN/)
    expect(r.out).toMatch(/example\/json/)
  })

  it('renders a recorded unprintable fixture as tracked debt, on a GREEN run', () => {
    const r = gate(ROOT)
    expect(r.ok).toBe(true)
    expect(r.out).toMatch(/NO ARTIFACT — \d+ fixture\(s\) RUN but cannot be printed/)
    // WHICH construct, not just which fixture.
    expect(r.out).toMatch(/trivia arm is 'regex', not a labelled arm/)
    // Green must never read as "fine": the ok line repeats that they are ungated.
    expect(r.out).toMatch(/UNGATED for size/)
  })

  it('shows a dash, never 0 B, for a fixture with no artifact', () => {
    // "0 B / 0.0x" would sort as the best row in the table and read as the win of
    // the release. There is no artifact; the table must say so.
    const r = gate(ROOT)
    expect(r.out).toMatch(/example\/css\s+[\d,]+ B\s+—\s+—\s+—\s+—\s+—\s+unprintable/)
    expect(r.out).not.toMatch(/example\/css\s+[\d,]+ B\s+0 B/)
  })
})

describe('standing debt never reads as a fresh regression', { timeout: ONE_SPAWN_MS }, () => {
  it('renders known over-target fixtures as tracked, not as something this change did', () => {
    const r = gate(ROOT)
    // The distinction that matters to a human: standing debt must not be
    // announced as news, and news must not be filed under standing debt.
    expect(r.out).not.toMatch(/CROSSED THE CEILING/)
    expect(r.out).not.toMatch(/crossed in THIS change/)
    expect(r.out).toMatch(/over 10x/)
  })

  it('marks a fixture that crosses the target in THIS change as fresh', () => {
    // Same tree, but a baseline claiming probe/node-scale-32 was comfortably under
    // target. The doctored genBytes must be the REAL measured value, or the fixture
    // trips the bytes ratchet first and this stops testing what it names.
    const d = scratch()
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/size-baseline.json'), 'utf8')) as {
      fixtures: Record<string, { genBytes: number; gzipBytes: number; bytesRatio: number; locMultiplier: number }>
    }
    const was = real.fixtures['probe/node-scale-32']!
    real.fixtures['probe/node-scale-32'] = { genBytes: was.genBytes, gzipBytes: was.gzipBytes, bytesRatio: 5, locMultiplier: 69.9 }
    writeBaseline(d, real)
    const r = gate(ROOT, `--baseline=${path.join(d, 'bench', 'size-baseline.json')}`)
    expect(r.out).toMatch(/crossed in THIS change/)
  })

  it('points at the largest measured lever instead of just saying "make it smaller"', () => {
    const r = gate(ROOT)
    expect(r.out).toMatch(/LARGEST SINGLE LEVER — variant duplication/)
    expect(r.out).toMatch(/costs [\d.]+x probe\/variants-1 for the SAME grammar/)
    expect(r.out).toMatch(/pnpm size:probe/)
  })
})

describe('size gate measures multi-variant duplication', { timeout: ONE_SPAWN_MS }, () => {
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

  it('holds variant duplication well below one copy per variant', () => {
    const parsed = probeJson()
    const get = (id: string): number => parsed.rows.find(r => r.id === id)!.genBytes
    const two = get('variants-2') / get('variants-1')
    const four = get('variants-4') / get('variants-1')
    // Perfectly shared variants would sit near 1.0x. Full copies sit near N, and
    // that is where this series started: before the module-level hoist the
    // measured ratios were 1.98x and 3.92x — one whole copy per variant.
    //
    // The hoist emits each byte-identical declaration ONCE at module scope, so
    // what remains per variant is only what genuinely differs (`_r_Doc`, the
    // public wrappers, `_map` and its stamps). Measured after the hoist:
    // 30,303/19,821 = 1.53x and 50,174/19,821 = 2.53x.
    //
    // These are RATCHET bounds in the same spirit as bench/size-baseline.json —
    // they may fall further, they may not rise. Deterministic codegen means there
    // is no noise to absorb, so they sit just above the measured values.
    expect(two).toBeLessThan(1.6)
    expect(four).toBeLessThan(2.7)
    // Still above 1.0x: each variant keeps its own differing rule and wrappers.
    expect(four).toBeGreaterThan(two)
    expect(two).toBeGreaterThan(1)
  })
})

describe('the size probe is deterministic', { timeout: TWO_SPAWN_MS }, () => {
  it('produces byte-identical output across separate processes', () => {
    // The drift tolerance is 1% and that is headroom, not noise absorption. It is
    // only defensible if codegen is deterministic — so prove it, rather than
    // assuming it and quietly widening the tolerance later.
    const a = probeJson()
    const b = probeJson()
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows))
  })
})
