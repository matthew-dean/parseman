import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * THE GATE MUST BE OBSERVED FAILING.
 *
 * `scripts/check-invariants.mjs` is only worth wiring into CI if each of its
 * rules actually fires on the shape it claims to decide. A gate that has never
 * gone red is not known to work — this repo says so about its own perf gates,
 * and it is the reason the checks below run the REAL script, the way CI runs
 * it, against fixture trees under `test/fixtures/invariant-gate/` that each
 * contain exactly one planted violation.
 *
 * The `clean` fixture is the other half and matters just as much: a gate that
 * fires on innocent code gets switched off, and the gates that matter get
 * switched off with it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/check-invariants.mjs')
const fixture = (name: string) => resolve(ROOT, 'test/fixtures/invariant-gate', name)

/** @returns stdout plus the exit code, without throwing on a non-zero exit. */
function runGate(args: string[]): { code: number, out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number, stdout?: string, stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('invariant gate', () => {
  it('is green on this repository', () => {
    const { code, out } = runGate([])
    expect(out).toContain('0 findings')
    expect(code).toBe(0)
  })

  // The `clean` fixture is not merely empty — it carries the shapes each rule
  // must NOT fire on: a literal getter (INV-1), an options field that IS read
  // (INV-2), and a `delete` on a scratch object built in the same call (INV-5).
  it('stays silent on a tree that violates nothing', () => {
    const { code, out } = runGate([`--root=${fixture('clean')}`])
    expect(out).toContain('0 findings')
    expect(code).toBe(0)
  })

  // One case per rule. Each asserts the exit code AND the rule id, so a rule
  // that stops working cannot be masked by a different rule firing.
  const planted: ReadonlyArray<readonly [string, string, string]> = [
    ['inv1', 'INV-1', 'accessor descriptor'],
    ['inv2', 'INV-2', 'never read anywhere in src/'],
    ['inv3', 'INV-3', 'not reachable by import'],
    ['inv4', 'INV-4', 'duplicated across modules'],
    ['inv5', 'INV-5', 'is not constructed by this function'],
  ]
  for (const [dir, rule, phrase] of planted) {
    it(`${rule} fires on its planted violation and exits non-zero`, () => {
      const { code, out } = runGate([`--root=${fixture(dir)}`])
      expect(out).toContain(rule)
      expect(out).toContain(phrase)
      expect(code).toBe(1)
    })
  }

  it('fails when an allowlist entry no longer matches a finding', () => {
    // The allowlist may only get SHORTER. A stale entry is a standing licence
    // to reintroduce the violation it names, so the gate treats it as a
    // failure rather than ignoring it. Proven here by pointing the repo
    // allowlist at a tree where none of its entries can match.
    const { code, out } = runGate([`--root=${fixture('clean')}`, '--assert-allowlist'])
    expect(out).toContain('DELETE them')
    expect(code).toBe(1)
  })
})
