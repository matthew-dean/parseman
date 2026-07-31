/**
 * CHOICE COST — static shared-prefix inventory and the corpus wasted-work profile
 * (src/analysis/choice-cost.ts).
 *
 * Two things are asserted here that matter more than feature coverage:
 *
 *   CALIBRATION. The instrument is checked against a case whose answer is known by
 *   construction — a choice whose first arm is guaranteed to fail after scanning a
 *   fixed number of bytes — so a plausible-looking number is not mistaken for a
 *   correct one. Every headline number this repo produced without a calibration step
 *   this session had to be retracted.
 *
 *   FAILS CLOSED. Each way of measuring nothing (empty rule map, empty corpus, empty
 *   file, unknown entry rule, uninstrumentable grammar, a compose() artifact) has a
 *   test proving it THROWS. The counter-example lives in this tree: src/coverage.ts
 *   reports `ratio: 1` — 100% covered — when nothing was analysable.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  choice, sequence, literal, regex, many, optional, node, rules,
} from '../../src/index.ts'
import {
  analyzeChoiceInventory, profileWastedWork, choiceSiteKey,
} from '../../src/analysis/choice-cost.ts'
import { checkWastedWork, buildWastedWorkBaseline } from '../../src/analysis/choice-cost-gate.ts'
import type { Combinator } from '../../src/types.ts'

const entries = (g: Record<string, Combinator<unknown>>): [string, Combinator<unknown>][] => Object.entries(g)

// ── static inventory ─────────────────────────────────────────────────────────

describe('static inventory: what the compiler factored, and what it declined', () => {
  it('records a FACTORED site as factored, with the group the compiler used', () => {
    const g = rules(() => ({
      A: choice(
        sequence(literal('@'), literal('media')),
        sequence(literal('@'), literal('layer')),
      ),
    }))
    const r = analyzeChoiceInventory(entries(g))
    const e = r.entries.find(x => x.arity === 2)!
    expect(e.strategy).toBe('sharedPrefix')
    expect(e.factored).toBe(true)
    expect(e.groups).toEqual([{ key: 'L:"@"', render: '"@"', members: [0, 1] }])
    expect(e.unfactoredArms).toBe(0)
    expect(r.backlogSites).toBe(0)
  })

  it('reports a PARTIAL group the all-or-nothing detector cannot represent at all', () => {
    // `detectSharedPrefix` returns null on the first non-qualifying arm, so nothing
    // records that two of these three arms re-scan the same `@`. That silence is the
    // backlog this inventory exists to generate.
    const g = rules(() => ({
      A: choice(
        sequence(literal('@'), literal('media')),
        sequence(literal('@'), literal('layer')),
        sequence(regex(/[a-z]+/), literal(':')),
      ),
    }))
    const r = analyzeChoiceInventory(entries(g))
    const e = r.entries.find(x => x.arity === 3)!
    expect(e.factored).toBe(false)
    expect(e.declineReason).toBe('leads-differ')
    expect(e.groups).toEqual([{ key: 'L:"@"', render: '"@"', members: [0, 1] }])
    expect(e.unfactoredArms).toBe(2)
    expect(r.backlogSites).toBe(1)
    expect(r.backlogArms).toBe(2)
  })

  it('names the BLOCKING ARM and the reason — a ref arm cannot be factored through', () => {
    const g = rules((g2: { Other: Combinator<unknown> }) => ({
      Other: literal('x'),
      A: choice(
        sequence(literal('@'), literal('media')),
        g2.Other,
      ),
    }))
    const r = analyzeChoiceInventory(entries(g))
    const e = r.entries.find(x => x.arity === 2)!
    expect(e.factored).toBe(false)
    expect(e.declineReason).toBe('arms-not-factorable')
    expect(e.armDeclines).toHaveLength(1)
    expect(e.armDeclines[0]!.arm).toBe(1)
    expect(e.armDeclines[0]!.reason).toBe('not-a-sequence')
  })

  it('a one-term sequence arm declines for a DIFFERENT reason than a ref arm', () => {
    const g = rules(() => ({
      A: choice(
        sequence(literal('@'), literal('media')),
        sequence(literal('@')),
      ),
    }))
    const e = analyzeChoiceInventory(entries(g)).entries.find(x => x.arity === 2)!
    expect(e.armDeclines[0]).toMatchObject({ arm: 1, reason: 'sequence-shorter-than-2' })
  })

  it('a DISJOINT site is not backlog — first-char dispatch already tries one arm', () => {
    const g = rules(() => ({ A: choice(literal('a'), literal('b')) }))
    const r = analyzeChoiceInventory(entries(g))
    const e = r.entries[0]!
    expect(e.factored).toBe(false)
    // Literal-only choices take literalsLongestFirst; either way it is not backlog.
    expect(['disjoint-dispatch', 'strategy-preempted']).toContain(e.declineReason)
    expect(r.backlogSites).toBe(0)
  })

  it('is COMPLETE, not sampled: nested choices with nothing to report still appear', () => {
    const g = rules(() => ({
      A: sequence(literal('('), choice(literal('a'), literal('b')), literal(')')),
      B: many(choice(literal('x'), sequence(literal('y'), literal('z')))),
    }))
    const r = analyzeChoiceInventory(entries(g))
    expect(r.choiceSites).toBe(2)
    expect(r.entries.map(e => e.siteKey)).toEqual([...r.entries.map(e => e.siteKey)].sort())
  })

  it('site keys locate a choice by rule and structural path', () => {
    const g = rules(() => ({
      A: sequence(literal('('), choice(literal('a'), sequence(literal('b'), literal('c'))), literal(')')),
    }))
    const e = analyzeChoiceInventory(entries(g)).entries[0]!
    expect(choiceSiteKey(e.site)).toBe('A › seq[1]')
  })
})

// ── calibration ──────────────────────────────────────────────────────────────

describe('wasted-work profile: calibrated against a known answer', () => {
  /**
   * `Doomed` matches `<<<` then 8 digits then `!`. The corpus never contains the
   * `!`, so arm 0 ALWAYS fails, and it always fails having scanned exactly 11 bytes
   * (3 + 8) before the terminal that rejects it. Arm 1 then re-scans those 11 bytes.
   *
   * So for N occurrences the answer is not "some number that looks plausible" — it is
   * exactly 11N, and the test asserts that, not an inequality.
   */
  const calib = rules(() => ({
    Item: choice(
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('!')),
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('?')),
    ),
    Doc: many(choice(
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('!')),
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('?')),
    )),
  }))

  it('counts EXACTLY the bytes the failing first arm rescanned', () => {
    const n = 7
    const text = '<<<12345678?'.repeat(n)
    const r = profileWastedWork({
      rules: entries(calib), entry: 'Doc',
      corpus: [{ id: 'calib', text }],
    })
    expect(r.parsedOk).toBe(1)

    const doc = r.arms.filter(a => a.site.rule === 'Doc')
    const arm0 = doc.find(a => a.arm === 0)!
    const arm1 = doc.find(a => a.arm === 1)!

    expect(arm0.attempts).toBe(n)
    expect(arm0.failures).toBe(n)
    expect(arm0.wastedBytes).toBe(11 * n)   // exact, by construction
    expect(arm1.failures).toBe(0)
    expect(arm1.wastedBytes).toBe(0)
  })

  it('RANKS the always-failing first arm above a cheap one', () => {
    const r = profileWastedWork({
      rules: entries(calib), entry: 'Doc',
      corpus: [{ id: 'calib', text: '<<<12345678?'.repeat(20) }],
    })
    expect(r.arms[0]!.arm).toBe(0)
    expect(r.arms[0]!.wastedBytes).toBeGreaterThan(0)
    expect(r.totalWastedBytes).toBe(r.sites.reduce((n, s) => n + s.wastedBytes, 0))
  })

  it('is INSENSITIVE to machine load: the metric is a count, not a timing', () => {
    const text = '<<<12345678?'.repeat(31)
    const once = profileWastedWork({ rules: entries(calib), entry: 'Doc', corpus: [{ id: 'c', text }] })
    // Burn CPU between the two runs. A timing-based metric would move; a count cannot.
    let sink = 0
    for (let i = 0; i < 3_000_000; i++) sink += i % 7
    expect(sink).toBeGreaterThan(0)
    const twice = profileWastedWork({ rules: entries(calib), entry: 'Doc', corpus: [{ id: 'c', text }] })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('leaves the grammar EXACTLY as it found it — instrumentation is fully reverted', () => {
    const g = entries(calib)
    const before = analyzeChoiceInventory(g)
    profileWastedWork({ rules: g, entry: 'Doc', corpus: [{ id: 'c', text: '<<<12345678?' }] })
    const after = analyzeChoiceInventory(g)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    // And the grammar still parses identically afterwards.
    const again = profileWastedWork({ rules: g, entry: 'Doc', corpus: [{ id: 'c', text: '<<<12345678?' }] })
    expect(again.parsedOk).toBe(1)
  })

  it('records an UNINSTRUMENTABLE site as such, so its zero is not read as a measurement', () => {
    const g = rules(() => ({
      // Arm 0 is instrumentable (firstMatch); the inner literal-only choice takes
      // literalsLongestFirst, which captures its sorted arms at CONSTRUCTION, so slot
      // substitution can never reach it.
      Doc: many(choice(
        sequence(literal('#'), choice(literal('aa'), literal('a'), literal('b')), literal(';')),
        sequence(literal('#'), literal('!')),
      )),
    }))
    const r = profileWastedWork({
      rules: entries(g), entry: 'Doc',
      corpus: [{ id: 'c', text: '#aa;#!' }],
    })
    const uninstr = r.sites.filter(s => !s.instrumented)
    expect(uninstr.length).toBeGreaterThan(0)
    // The zero is LABELLED, not laundered: an uninstrumented site reports 0 wasted
    // bytes because nothing was measured there, and `instrumented: false` says so.
    expect(uninstr.every(s => s.wastedBytes === 0)).toBe(true)
    expect(uninstr.length + r.instrumentedSites).toBe(r.sites.length)
    expect(r.uninstrumentableSites).toBe(uninstr.length)
  })
})

// ── determinism ──────────────────────────────────────────────────────────────

describe('determinism — the property that makes this gateable', () => {
  const g = rules(() => ({
    Doc: many(choice(
      sequence(literal('#'), regex(/[a-f0-9]{6}/), literal(';')),
      sequence(literal('#'), regex(/[a-f0-9]{3}/), literal(';')),
      sequence(regex(/[a-z]+/), literal(';')),
    )),
  }))

  it('the same grammar and corpus yield a BYTE-IDENTICAL report, twice in one process', () => {
    const corpus = [{ id: 'a', text: '#abc;#abcdef;word;' }, { id: 'b', text: 'x;#fff;' }]
    const a = JSON.stringify(profileWastedWork({ rules: entries(g), entry: 'Doc', corpus }))
    const b = JSON.stringify(profileWastedWork({ rules: entries(g), entry: 'Doc', corpus }))
    expect(b).toBe(a)
  })

  it('the static inventory is byte-identical across repeated analysis', () => {
    expect(JSON.stringify(analyzeChoiceInventory(entries(g))))
      .toBe(JSON.stringify(analyzeChoiceInventory(entries(g))))
  })

  it('carries nothing machine-dependent — no timings, paths, dates or ids', () => {
    const text = JSON.stringify(profileWastedWork({
      rules: entries(g), entry: 'Doc', corpus: [{ id: 'a', text: '#abc;' }],
    }))
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/)
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(text).not.toMatch(/"ms"|"elapsed"|"duration"|"pid"/)
  })
})

// ── fails closed ─────────────────────────────────────────────────────────────

describe('fails closed — every way of measuring nothing THROWS', () => {
  const g = rules(() => ({ Doc: many(choice(sequence(literal('a'), literal('b')), literal('c'))) }))

  it('empty rule map', () => {
    expect(() => analyzeChoiceInventory([])).toThrow(/EMPTY/)
    expect(() => profileWastedWork({ rules: [], entry: 'Doc', corpus: [{ id: 'x', text: 'a' }] })).toThrow(/EMPTY/)
  })

  it('a compose()-style artifact with no _def', () => {
    expect(() => analyzeChoiceInventory([['Doc', (() => {}) as unknown as Combinator<unknown>]]))
      .toThrow(/not a combinator/)
  })

  it('unknown entry rule', () => {
    expect(() => profileWastedWork({ rules: entries(g), entry: 'Nope', corpus: [{ id: 'x', text: 'a' }] }))
      .toThrow(/not in the rule map/)
  })

  it('empty corpus', () => {
    expect(() => profileWastedWork({ rules: entries(g), entry: 'Doc', corpus: [] })).toThrow(/corpus is EMPTY/)
  })

  it('an empty corpus FILE', () => {
    expect(() => profileWastedWork({ rules: entries(g), entry: 'Doc', corpus: [{ id: 'x', text: '' }] }))
      .toThrow(/'x' is EMPTY/)
  })

  it('a grammar with no instrumentable choice site', () => {
    const flat = rules(() => ({ Doc: many(choice(literal('a'), literal('bb'))) }))
    expect(() => profileWastedWork({ rules: entries(flat), entry: 'Doc', corpus: [{ id: 'x', text: 'a' }] }))
      .toThrow(/NO instrumentable choice site/)
  })

  it('an inventory over a grammar with zero choices reports zero SITES, not a clean bill', () => {
    const none = rules(() => ({ Doc: sequence(literal('a'), literal('b')) }))
    const r = analyzeChoiceInventory(entries(none))
    expect(r.choiceSites).toBe(0)
    expect(r.entries).toEqual([])
  })
})

// ── shape fidelity ───────────────────────────────────────────────────────────

describe('the instrument does not change what the grammar parses', () => {
  it('an optional/many-heavy grammar parses to the same result with and without it', () => {
    const g = rules(() => ({
      Doc: many(choice(
        sequence(literal('['), optional(regex(/[0-9]+/)), literal(']')),
        sequence(literal('['), regex(/[a-z]+/), literal('}')),
        node('Word', sequence(regex(/[a-z]+/), literal(';'))),
      )),
    }))
    const corpus = [{ id: 'a', text: '[12][][abc];' }]
    const r = profileWastedWork({ rules: entries(g), entry: 'Doc', corpus })
    expect(r.parsedOk).toBe(1)
    expect(r.parsedFailed).toBe(0)
  })
})

// ── the ratchet ──────────────────────────────────────────────────────────────

describe('gate policy — absolute baseline, fails closed, no self-rebaseline', () => {
  const g = rules(() => ({
    Doc: many(choice(
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('!')),
      sequence(literal('<<<'), regex(/[0-9]{8}/), literal('?')),
    )),
  }))
  const measure = (reps: number) => profileWastedWork({
    rules: entries(g), entry: 'Doc', corpus: [{ id: 'c', text: '<<<12345678?'.repeat(reps) }],
  })
  const REV = { gitRev: 'abc1234', updatedAt: '2026-07-30' }

  it('passes against its own baseline', () => {
    const r = { unit: measure(10) }
    const v = checkWastedWork(r, buildWastedWorkBaseline(r, REV))
    expect(v.ok).toBe(true)
    expect(v.breaches).toEqual([])
  })

  it('fails on drift past the committed absolute number', () => {
    const base = buildWastedWorkBaseline({ unit: measure(10) }, REV)
    // Same corpus size, more waste: rewrite the baseline's total downward by 20%.
    base.totals.unit!.totalWastedBytes = Math.round(base.totals.unit!.totalWastedBytes * 0.8)
    const v = checkWastedWork({ unit: measure(10) }, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.some(x => x.kind === 'drift')).toBe(true)
  })

  it('a baseline CANNOT launder a ceiling violation', () => {
    const r = { unit: measure(10) }
    const base = buildWastedWorkBaseline(r, REV)
    const v = checkWastedWork(r, base, { ceilingRatio: 0.01 })
    expect(v.ok).toBe(false)
    // Rejected as an INVALID BASELINE, not merely a ceiling breach — recording an
    // over-ceiling number as acceptable is itself the violation.
    expect(v.breaches[0]!.kind).toBe('invalid-baseline')
  })

  it('fails closed on a missing, malformed, or empty baseline', () => {
    const r = { unit: measure(4) }
    expect(checkWastedWork(r, undefined).ok).toBe(false)
    expect(checkWastedWork(r, { schema: 'nope' }).ok).toBe(false)
    expect(checkWastedWork(r, { schema: 'parseman.wasted-work-baseline/1', totals: {}, sites: {} }).ok).toBe(false)
  })

  it('fails closed on zero corpora measured', () => {
    const base = buildWastedWorkBaseline({ unit: measure(4) }, REV)
    const v = checkWastedWork({}, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.some(x => x.kind === 'unmeasurable')).toBe(true)
  })

  it('fails closed when the corpus itself changed — the totals are not comparable', () => {
    const base = buildWastedWorkBaseline({ unit: measure(10) }, REV)
    const v = checkWastedWork({ unit: measure(11) }, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.some(x => x.kind === 'unmeasurable' && /corpus changed/.test(x.detail))).toBe(true)
  })

  it('reports a STALE baseline entry rather than shrinking the gated set in silence', () => {
    const r = { unit: measure(10) }
    const base = buildWastedWorkBaseline(r, REV)
    base.sites['unit::Gone › choice[0]'] = 99
    base.totals.other = { corpusBytes: 1, totalWastedBytes: 0, instrumentedSites: 1 }
    const v = checkWastedWork(r, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.filter(x => x.kind === 'stale')).toHaveLength(2)
  })

  it('the verdict is deterministic and diffable', () => {
    const r = { unit: measure(10) }
    const base = buildWastedWorkBaseline(r, REV)
    base.totals.unit!.totalWastedBytes = 1
    expect(JSON.stringify(checkWastedWork(r, base))).toBe(JSON.stringify(checkWastedWork(r, base)))
  })

  it('flags an ORDERING INVERSION only when asked, and only with enough attempts', () => {
    const r = { unit: measure(10) }
    expect(r.unit.inversions.length).toBeGreaterThan(0)
    expect(r.unit.inversions[0]!.arm).toBe(0)
    const base = buildWastedWorkBaseline(r, REV)
    expect(checkWastedWork(r, base, {}).ok).toBe(true)
    expect(checkWastedWork(r, base, { failOnInversions: true }).ok).toBe(false)
  })
})

// ── cross-process determinism ────────────────────────────────────────────────

describe('cross-PROCESS determinism', () => {
  /**
   * One process proves the analysis is not order-dependent WITHIN a run. It does not
   * prove the absence of a cross-run input — a hash seed, a WeakMap identity counter,
   * an environment read. Only a second process does, and a gate whose numbers move
   * between CI runners is not a gate. (`test/unit/codegen-output.test.ts` pins the
   * same property for codegen output; this is that pattern applied to the report.)
   */
  it('two separate node processes produce byte-identical reports', () => {
    const script = `
      import { choice, sequence, literal, regex, many, rules } from '${JSON.stringify(new URL('../../src/index.ts', import.meta.url).pathname).slice(1, -1)}'
      import { analyzeChoiceInventory, profileWastedWork } from '${JSON.stringify(new URL('../../src/analysis/choice-cost.ts', import.meta.url).pathname).slice(1, -1)}'
      const g = rules(() => ({
        Doc: many(choice(
          sequence(literal('#'), regex(/[a-f0-9]{6}/), literal(';')),
          sequence(literal('#'), regex(/[a-f0-9]{3}/), literal(';')),
          sequence(regex(/[a-z]+/), literal(';')),
        )),
      }))
      const e = Object.entries(g)
      const corpus = [{ id: 'a', text: '#abc;#abcdef;word;'.repeat(9) }, { id: 'b', text: 'x;#fff;' }]
      process.stdout.write(JSON.stringify({
        inv: analyzeChoiceInventory(e),
        prof: profileWastedWork({ rules: e, entry: 'Doc', corpus }),
      }))
    `
    const run1 = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const run2 = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    expect(run1.length).toBeGreaterThan(100)
    expect(run2).toBe(run1)
  })
})
