import { afterEach, describe, expect, it, vi } from 'vitest'
import { report } from '../../bench/spelling-equivalence.ts'

/**
 * The identity control compiles two BYTE-IDENTICAL spellings and expects 1.000x.
 * It was measured, printed, and then ignored — the run exited 0 regardless — so a
 * non-deterministic harness would have reported every other ratio as evidence.
 *
 * That is the same defect the goal-1 margin gate had, in a second harness, on the
 * same day. Both are now fatal, and this pins it: a breached control certifies
 * NOTHING, and the exit code has to say so.
 */
const fake = (rawRatio: number): Parameters<typeof report>[0] => ([
  { id: 'control-identity', rawRatio, gzipRatio: 1, equivalent: true, proven: true, breaches: false,
    a: { rawBytes: 100, gzipBytes: 50 }, b: { rawBytes: 100, gzipBytes: 50 } },
] as unknown as Parameters<typeof report>[0])

describe('spelling gate — a breached identity control is fatal', () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks() })

  it('exits non-zero when two identical spellings do not measure 1.000x', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    report(fake(1.04))
    expect(process.exitCode, 'a non-deterministic harness must not report a pass').toBe(2)
  })

  it('says the run certifies nothing, not merely that the control moved', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    report(fake(0.92))
    expect(lines.join('\n')).toMatch(/HARNESS BROKEN/)
    expect(lines.join('\n')).toMatch(/certifies nothing/)
  })

  it('leaves the exit code alone when the control is honest', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    report(fake(1))
    expect(process.exitCode).toBeUndefined()
  })

  /**
   * `process.exitCode` is read once, when the process ends. Between `report()`
   * and that moment `main()` writes `--json` and, under `--update`, BANKS THE
   * BASELINE — so a non-deterministic run could still commit its own noise as
   * the ratchet every later run is compared against, and exit 2 having done it.
   * The verdict has to be a value `main()` can stop on, not a side effect.
   */
  it('RETURNS the verdict so main() can stop before writing anything', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(report(fake(1.04)), 'a breached control must be reportable as a value').toBe(true)
  })

  it('returns false on an honest control, so a good run proceeds', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(report(fake(1))).toBe(false)
  })
})
