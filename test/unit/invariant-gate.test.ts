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
  // (INV-2), a `delete` on a scratch object built in the same call (INV-5), a
  // BARREL re-export (INV-8 — this codebase is mostly barrels, and a rule that
  // fired on them would be switched off within a day), a symbol description
  // minted once in one module (INV-9), and a comment naming a file that EXISTS
  // (INV-10).
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
    // The three NAMING rules. Each planted fixture is a miniature of a defect
    // this project actually shipped: one name for two engines, one sentinel
    // minted twice, and a comment naming a module that was deleted.
    ['inv8', 'INV-8', 'resolves to 2 DIFFERENT declarations'],
    ['inv9', 'INV-9', 'is minted in 2 modules'],
    ['inv10', 'INV-10', 'which does not exist'],
    // INV-11 plants BOTH halves in one fixture. 11a is `import { execRules as
    // tableRules }` — the edit that let the reference interpreter answer to the
    // shipped engine's name for two releases. 11b is a renaming re-export from an
    // entry point, which is the shape that MINTED that collision rather than the
    // one that expressed it. Both type-check, so only a specifier rule catches
    // either.
    ['inv11', 'INV-11', 'TWO DIFFERENT table engines'],
  ]
  for (const [dir, rule, phrase] of planted) {
    it(`${rule} fires on its planted violation and exits non-zero`, () => {
      const { code, out } = runGate([`--root=${fixture(dir)}`])
      expect(out).toContain(rule)
      expect(out).toContain(phrase)
      expect(code).toBe(1)
    })
  }

  /**
   * INV-11's two halves catch DIFFERENT shapes, so one assertion on the rule id
   * cannot show both work — 11a alone would satisfy the loop above while 11b was
   * silently broken. 11b is the half that matters most: it is the shape that
   * MINTED the engine collision (`assembledRules as tableRules`), not the one
   * that expressed it, and it is the half with no second gate behind it.
   */
  it('INV-11 fires on BOTH halves — the cross-engine rename and the renaming re-export', () => {
    const { code, out } = runGate([`--root=${fixture('inv11')}`])
    expect(out, '11a — a rename across the two engines\' vocabularies')
      .toContain('TWO DIFFERENT table engines')
    expect(out, '11b — one function published under a second name from an entry point')
      .toContain('may not rename one')
    expect(code).toBe(1)
  })

  it('fails when an allowlist entry no longer matches a finding', () => {
    // The allowlist may only get SHORTER. A stale entry is a standing licence
    // to reintroduce the violation it names, so the gate treats it as a
    // failure rather than ignoring it. Proven here by pointing the repo
    // allowlist at a tree where none of its entries can match.
    const { code, out } = runGate([`--root=${fixture('clean')}`, '--assert-allowlist'])
    expect(out).toContain('DELETE them')
    expect(code).toBe(1)
  })

  /**
   * THE RATCHET AND THE STRUCTURE CHECK MUST BE OBSERVED FAILING TOO.
   *
   * "THIS LIST MAY ONLY GET SHORTER" and "a numbered lane, not an acceptance"
   * were both true sentences that nothing enforced, and an entry with no owner
   * and no expiry turned a live finding into a permanent accepted state. These
   * two cases are the enforcement, so by this file's own standard they have to
   * be seen going red. Each fixture ships its own `scripts/invariant-allowlist.mjs`,
   * which the gate prefers over the repo's when `--root` points at a tree that
   * has one — no bypass flag, the same script CI runs.
   */
  it('fails when the allowlist grows without its committed count being raised', () => {
    const { code, out } = runGate([`--root=${fixture('allowlist-grew')}`, '--assert-allowlist'])
    expect(out).toContain('the allowlist GREW')
    expect(out).toContain('2 entries against a committed ALLOW_COUNT of 1')
    expect(code).toBe(1)
  })

  // A ratchet that cannot be raised is a hard block, and a hard block gets
  // bypassed. Raising the count is the SANCTIONED way to add an entry — an
  // architectural change that retires modules from the export graph needs it —
  // and it costs exactly one deliberate edit to a numbered line.
  it('passes when an added entry comes with the committed count raised', () => {
    const { code, out } = runGate([`--root=${fixture('allowlist-raised')}`, '--assert-allowlist'])
    expect(out).toContain('2 allowlisted pre-existing entries')
    expect(out).toContain('0 findings')
    expect(code).toBe(0)
  })

  it('fails on an entry with no category, an invented category, or DEBT with no ref', () => {
    const { code, out } = runGate([`--root=${fixture('allowlist-shape')}`, '--assert-allowlist'])
    expect(out).toContain('malformed allowlist entries')
    expect(out).toContain('INV-3:src/uncategorized.ts')
    expect(out).toContain('got "TEMPORARY"')
    expect(out).toContain('DEBT requires a `ref`')
    expect(code).toBe(1)
  })

  // Debt that is never restated is debt that is never paid, so the gate names
  // it on every GREEN run — not only when something else has already failed.
  it('prints outstanding DEBT entries with their refs on a passing run', () => {
    const { code, out } = runGate([])
    expect(code).toBe(0)
    expect(out).toMatch(/\d+ outstanding DEBT entr(y|ies) — these are owed, not accepted:/)
    expect(out).toContain('INV-3:src/compiler/token-alphabet.ts  →  docs/design/derived-tokenization.md')
  })
})
