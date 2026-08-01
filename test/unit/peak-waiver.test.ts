/**
 * `decideWaiver` is the half of `PERF-PEAK-WAIVER` that lives inside the perf gate —
 * the decision `bench/workload-perf-guard.ts` makes AFTER it has measured a drawdown
 * and printed the report. `test/unit/release-gate.test.ts` covers the other half, the
 * form validation in `scripts/check-changelog.mjs` §D'.
 *
 * It is a separate function, in `scripts/peak-waiver.mjs`, precisely so this file can
 * exist. The guard's failure branch is only reachable with a REAL measured breach,
 * which costs two materialised worktrees and several minutes of quiet machine — so if
 * the decision stayed inline, the two rules that matter most (you may not UNDERSTATE
 * the breach, and a waiver does not CARRY to the next PR) would be covered by nothing.
 * That is exactly how a hatch stops being checked and starts being a bypass.
 */
import { describe, it, expect } from 'vitest'
import { decideWaiver, parsePeakWaivers, isBreach, WAIVER_TAG } from '../../scripts/peak-waiver.mjs'

const CONFIG = 'bench/workloads/config.json'
const PEAK = { version: '0.45.0', sha: '7d1817f', allowancePct: 5 }

/** A measured, badly-breaching run: 2.65x parse time, as the table lowering costs. */
const BREACHING = [
  { dMedian: 164.9, dMin: 158.2, breach: true },
  { dMedian: 171.2, dMin: 166.0, breach: true },
]

const LINE = `${WAIVER_TAG} ${CONFIG} median -164.9% min -158.2%`
  + ' — table lowering: 2.65x parse time buys a 40x smaller artifact'

const decide = (over: Partial<Parameters<typeof decideWaiver>[0]> = {}) =>
  decideWaiver({
    section: `\n- a change\n${LINE}\n`,
    config: CONFIG,
    peak: PEAK,
    breaching: BREACHING,
    base: 'abc1234',
    baseChangelog: '# Changelog\n\n## 0.47.0 — unreleased\n\n- something else\n',
    ...over,
  })

describe('peak-clause waiver — the decision inside the perf gate', () => {
  it('honours a well-formed, fresh waiver', () => {
    const d = decide()
    expect(d.applied).toBe(true)
    expect(d.message).toMatch(/PEAK CLAUSE WAIVED/)
  })

  it('says the breach is DECLARED, not forgiven, and that the record did not move', () => {
    // A waived run must never read as green. The whole justification for having the
    // hatch at all is that the number stays visible and the bar stays put.
    const { message } = decide()
    expect(message).toMatch(/NOT forgiven, it is DECLARED/)
    expect(message).toMatch(/peak record is UNCHANGED/)
    expect(message).toMatch(/did NOT raise it/)
    expect(message).toContain('0.45.0')
    expect(message).toContain('7d1817f')
    // And it states the size of what was waived, in units of the allowance.
    expect(message).toMatch(/33\.0x/)
    expect(message).toMatch(/31\.6x/)
    expect(message).toMatch(/40x smaller artifact/)
  })

  it('does nothing at all when no waiver is declared', () => {
    const d = decide({ section: '\n- an ordinary change\n' })
    expect(d.applied).toBe(false)
    expect(d.message).toBe('')
  })

  it('ignores a waiver naming a DIFFERENT gate', () => {
    const d = decide({ config: 'bench/grammar-density/config.json' })
    expect(d.applied).toBe(false)
    expect(d.message).toBe('')
  })

  it('REFUSES a waiver that understates the breach', () => {
    // The point of the flag is the real number being visible. Declaring "-6%" against a
    // measured -164.9% would satisfy every syntactic rule and defeat the entire design.
    const d = decide({
      section: `${WAIVER_TAG} ${CONFIG} median -6.0% min -5.5% — the table lowering costs a little time`,
    })
    expect(d.applied).toBe(false)
    expect(d.message).toMatch(/UNDERSTATES the breach/)
    // It names what was actually measured, so the fix is obvious.
    expect(d.message).toMatch(/158\.2%/)
  })

  it('accepts an honest quote of the MILDEST breaching pass, not only the worst', () => {
    // Bar set at the mildest breaching pass on purpose: an author who copies any real
    // row from the report is being honest, and a rule demanding one specific pass would
    // be a flake about which line they picked.
    const d = decide({
      section: `${WAIVER_TAG} ${CONFIG} median -164.9% min -158.2% — deliberate: buys a 40x smaller artifact`,
    })
    expect(d.applied).toBe(true)
  })

  it('REFUSES a STALE waiver — the line is already on the base', () => {
    // Non-stickiness. Without this the PR after the waiving one inherits the text and
    // the peak clause is silently off for the rest of the release cycle.
    const d = decide({ baseChangelog: `# Changelog\n\n## 0.47.0 — unreleased\n\n${LINE}\n` })
    expect(d.applied).toBe(false)
    expect(d.message).toMatch(/ALREADY on the base/)
    expect(d.message).toMatch(/spent on the diff that declares it/)
  })

  it('REFUSES any waiver when there is no base to check freshness against', () => {
    // Freshness is not optional, so an unverifiable waiver is refused rather than
    // trusted. This is also what makes a push to `main` unwaivable.
    const d = decide({ base: null })
    expect(d.applied).toBe(false)
    expect(d.message).toMatch(/freshness cannot be verified/)
    expect(d.message).toMatch(/--base/)
  })

  it('REFUSES a number inside the allowance', () => {
    const d = decide({
      section: `${WAIVER_TAG} ${CONFIG} median -2.0% min -1.0% — a tiny cost for a big artifact win`,
    })
    expect(d.applied).toBe(false)
    expect(d.message).toMatch(/waives nothing/)
  })

  it('REFUSES a malformed waiver rather than ignoring it', () => {
    // Silence here would be the worst outcome: the author believes the gate is waived,
    // the gate believes nothing was declared, and the red is a mystery to both.
    const d = decide({ section: `${WAIVER_TAG} ${CONFIG} it got slower but it is worth it` })
    expect(d.applied).toBe(false)
    expect(d.message).toMatch(/does not parse/)
  })
})

describe('peak-clause waiver — parsing', () => {
  it('does not match the tag mid-sentence', () => {
    // Prose ABOUT the flag — a CHANGELOG entry, this repo's own docs — must not read as
    // a declaration of it. Contrast §D's `/\bpeak\b/i`, which the word "peak" in any
    // sentence satisfies; that looseness is what this spelling exists to avoid.
    expect(parsePeakWaivers('- we could use `PERF-PEAK-WAIVER foo/config.json median -9% min -9% — x`\n')).toHaveLength(0)
  })

  it('matches through a list marker or blockquote', () => {
    for (const prefix of ['', '- ', '  - ', '> ', '* ']) {
      const got = parsePeakWaivers(`${prefix}${LINE}\n`)
      expect(got).toHaveLength(1)
      expect(got[0]!.problems).toEqual([])
      expect(got[0]!.config).toBe(CONFIG)
      expect(got[0]!.medianPct).toBe(-164.9)
      expect(got[0]!.minPct).toBe(-158.2)
    }
  })

  it('reads either sign — the harness prints +, prose writes −', () => {
    expect(isBreach({ medianPct: 164.9, minPct: 158.2 }, 5)).toBe(true)
    expect(isBreach({ medianPct: -164.9, minPct: -158.2 }, 5)).toBe(true)
    // Both must breach, not either: the peak clause is structurally stricter than the
    // per-release rule and this mirrors it.
    expect(isBreach({ medianPct: -164.9, minPct: -1.0 }, 5)).toBe(false)
    expect(isBreach({ medianPct: null, minPct: -158.2 }, 5)).toBe(false)
  })
})
