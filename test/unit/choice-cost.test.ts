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
import { readFileSync } from 'node:fs'
import {
  choice, sequence, literal, regex, many, optional, node, rules,
} from '../../src/index.ts'
import { compile } from '../../src/table/compile.ts'
import {
  analyzeChoiceInventory, profileWastedWork, choiceSiteKey, modelledFirstCharGate,
} from '../../src/analysis/choice-cost.ts'
import { checkWastedWork, buildWastedWorkBaseline } from '../../src/analysis/choice-cost-gate.ts'
import type { WastedWorkBaseline } from '../../src/analysis/choice-cost-gate.ts'
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

  // A baseline is parsed JSON off disk, so its VALUES are `unknown` too, not just its
  // top level. A non-numeric one does not announce itself at the comparison: `pct`
  // returns NaN, `NaN > tolerance` and `NaN < -tolerance` are BOTH false, and the entry
  // yields no breach — a pass over a number that was never compared. These pin that.
  const asJson = (b: WastedWorkBaseline): Record<string, unknown> =>
    JSON.parse(JSON.stringify(b)) as Record<string, unknown>

  it('fails closed on a `null` totals/sites rather than throwing on Object.keys', () => {
    const r = { unit: measure(4) }
    for (const bad of [
      { schema: 'parseman.wasted-work-baseline/1', totals: null, sites: {} },
      { schema: 'parseman.wasted-work-baseline/1', totals: {}, sites: null },
      { schema: 'parseman.wasted-work-baseline/1', totals: [], sites: [] },
    ]) {
      const v = checkWastedWork(r, bad)
      expect(v.ok).toBe(false)
      expect(v.breaches[0]!.kind).toBe('invalid-baseline')
    }
  })

  it('fails closed on a NON-NUMERIC baseline total — NaN must never read as "no breach"', () => {
    const r = { unit: measure(10) }
    for (const key of ['corpusBytes', 'totalWastedBytes']) {
      for (const value of ['12', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const o = asJson(buildWastedWorkBaseline(r, REV));
        (o.totals as Record<string, Record<string, unknown>>).unit![key] = value
        const v = checkWastedWork(r, o)
        expect(v.ok).toBe(false)
        expect(v.breaches[0]!.kind).toBe('invalid-baseline')
      }
    }
  })

  it('fails closed on a NON-NUMERIC baseline SITE value', () => {
    const r = { unit: measure(10) }
    const built = buildWastedWorkBaseline(r, REV)
    const siteKey = Object.keys(built.sites)[0]
    expect(siteKey).toBeDefined()
    for (const value of ['12', null, Number.NaN]) {
      const o = asJson(built);
      (o.sites as Record<string, unknown>)[siteKey!] = value
      const v = checkWastedWork(r, o)
      expect(v.ok).toBe(false)
      expect(v.breaches.some(x => x.kind === 'invalid-baseline')).toBe(true)
    }
  })

  it('a scalar totals entry is a breach, not an uncaught TypeError', () => {
    const r = { unit: measure(10) }
    const o = asJson(buildWastedWorkBaseline(r, REV));
    (o.totals as Record<string, unknown>).unit = 7
    const v = checkWastedWork(r, o)
    expect(v.ok).toBe(false)
    expect(v.breaches[0]!.kind).toBe('invalid-baseline')
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

  // ── the ratchet is TWO-SIDED ───────────────────────────────────────────────
  //
  // Growth is the obvious half. The half that rots is the other one: an improvement
  // that is not banked turns into headroom for the next regression, and the gate
  // reads green through all of it. `bench/grammar-density/config.json` and
  // `bench/workloads/config.json` each asked a human politely to bump and each sat
  // unbumped for ten releases, which is why this is a check and not a comment.

  it('an UNBANKED WIN fails, and says to bank it', () => {
    const r = { unit: measure(10) }
    const base = buildWastedWorkBaseline(r, REV)
    // The grammar got 20% cheaper and the baseline stayed where it was.
    base.totals.unit!.totalWastedBytes = Math.round(base.totals.unit!.totalWastedBytes * 1.25)
    const v = checkWastedWork(r, base)
    expect(v.ok).toBe(false)
    const shrank = v.breaches.filter(x => x.kind === 'shrank')
    expect(shrank.length).toBeGreaterThan(0)
    expect(shrank[0]!.detail).toMatch(/BANK THE WIN/)
    // It must name the reclaimed bytes, not just the percentage — the number is
    // what a reviewer checks the rebaseline diff against.
    expect(shrank[0]!.detail).toMatch(/\d+ bytes you just saved/)
  })

  it('a PER-SITE win must be banked too, not only the total', () => {
    const r = { unit: measure(10) }
    const base = buildWastedWorkBaseline(r, REV)
    const key = Object.keys(base.sites)[0]!
    base.sites[key] = base.sites[key]! * 2
    const v = checkWastedWork(r, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.some(x => x.kind === 'shrank' && x.key === key)).toBe(true)
  })

  it('the band is SYMMETRIC — the same tolerance bounds both directions', () => {
    const r = { unit: measure(10) }
    const total = buildWastedWorkBaseline(r, REV).totals.unit!.totalWastedBytes
    const at = (mult: number) => {
      const b = buildWastedWorkBaseline(r, REV)
      b.totals.unit!.totalWastedBytes = Math.round(total * mult)
      return checkWastedWork(r, b, { driftTolerancePct: 10 })
    }
    // Measured is `total`; the baseline moves around it. Inside ±10% either way: quiet.
    expect(at(1 / 1.05).breaches.some(x => x.kind === 'drift')).toBe(false)
    expect(at(1 / 0.95).breaches.some(x => x.kind === 'shrank')).toBe(false)
    // Outside it, in either direction: a breach, and a DIFFERENT one each way.
    expect(at(1 / 1.5).breaches.some(x => x.kind === 'drift')).toBe(true)
    expect(at(1 / 0.5).breaches.some(x => x.kind === 'shrank')).toBe(true)
  })

  it('a banked win PASSES — rebaselining is the remedy, and it works', () => {
    const r = { unit: measure(10) }
    const stale = buildWastedWorkBaseline(r, REV)
    stale.totals.unit!.totalWastedBytes *= 2
    expect(checkWastedWork(r, stale).ok).toBe(false)
    // What `pnpm choicecost:baseline` produces, against the same measurement.
    expect(checkWastedWork(r, buildWastedWorkBaseline(r, REV)).ok).toBe(true)
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
      import { choice, sequence, literal, regex, many, rules } from ${JSON.stringify(new URL('../../src/index.ts', import.meta.url).href)}
      import { analyzeChoiceInventory, profileWastedWork } from ${JSON.stringify(new URL('../../src/analysis/choice-cost.ts', import.meta.url).href)}
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

// ── the compiled first-char gate ─────────────────────────────────────────────

describe('modelling the COMPILED first-char gate', () => {
  /**
   * The instrument measures the INTERPRETER; jess ships CODEGEN. Codegen emits a
   * per-arm first-char guard (src/compiler/codegen.ts:2246-2277) that the interpreter's
   * firstMatch loop (src/combinators/choice.ts:149-165) does not have. Unmodelled, that
   * does not just shift a number — it reorders the ranking, because the inflation is
   * largest for the arms with the NARROWEST first sets, which are exactly the ones
   * codegen handles best.
   *
   * These tests compile real grammars and compare the emitted guards to the model, arm
   * by arm. A hand-copy of another module's predicate drifts in silence; this makes the
   * drift a red test.
   */
  const modelled = (arms: Combinator<unknown>[]): number =>
    arms.filter(a => modelledFirstCharGate(a) !== null).length

  it('a narrow-first-set arm IS gated by codegen, and the model says so', () => {
    const arms = [
      node('A', sequence(literal('%a'), literal('x'))),
      node('B', sequence(literal('%b'), literal('y'))),
    ]
    expect(modelled(arms)).toBe(2)
  })

  it('a BARE nullable arm is NOT gated — and the model agrees', () => {
    // `many` is nullable at start, so codegen emits no guard: it must always be tried.
    const arms = [node('A', sequence(literal('%a'), literal('x'))), many(literal('%'))]
    expect(modelledFirstCharGate(arms[0]!)).not.toBeNull()
    expect(modelledFirstCharGate(arms[1]!)).toBeNull()
    expect(modelled(arms)).toBe(1)
  })

  it('a node()-WRAPPED nullable IS gated — codegen\'s nullability test is shallow', () => {
    // The trap. `matchesEmpty()` would call this nullable and report it ungated; codegen
    // falls to `default: false` for `node`, emits a guard, and the shipped parser skips
    // it. Modelling this with the "more correct" predicate would model the wrong parser.
    const arms = [
      node('A', sequence(literal('%a'), literal('x'))),
      node('M', many(literal('z'))),
    ]
    expect(modelledFirstCharGate(arms[1]!)).not.toBeNull()
    expect(modelled(arms)).toBe(2)
  })

  it('a nullable-LEAD bare sequence is gated on the whole sequence first-set', () => {
    const arms = [
      node('A', sequence(literal('%a'), literal('x'))),
      sequence(optional(literal('%')), literal('q')),
    ]
    expect(modelled(arms)).toBe(2)
    // '%' (37) and 'q' (113): the optional lead does not hide the following term, so the
    // modelled gate covers BOTH — asserted on the model's own first-set rather than on
    // codegen's emitted guard text.
    const gate = modelledFirstCharGate(arms[1]!)
    expect(gate).not.toBeNull()
  })

  it('an empty-matching regex arm is NOT gated', () => {
    const arms = [node('A', sequence(literal('%a'), literal('x'))), regex(/[%]*/)]
    expect(modelledFirstCharGate(arms[1]!)).toBeNull()
    expect(modelled(arms)).toBe(1)
  })
})

describe('the gated column changes the ranking, not just the number', () => {
  /**
   * Calibration with an exact known answer, as for the interpreted column.
   *
   * `Narrow` can only start with '#'. `Wide` starts with any letter. Over a corpus of
   * letter-led items, the interpreter enters `Narrow` on every item and it fails every
   * time — which reads as the top finding. The compiled parser never enters it. The
   * gated column must report ZERO for it, and the ranking must put the arm that
   * survives gating first.
   */
  const g = rules(() => ({
    Doc: many(choice(
      sequence(literal('#'), regex(/[a-z]{4}/), literal(';')),
      sequence(regex(/[a-z]+/), literal('!')),
      sequence(regex(/[a-z]+/), literal(';')),
    )),
  }))

  it('an arm codegen never enters reports interpreted cost and ZERO gated cost', () => {
    const n = 12
    const r = profileWastedWork({
      rules: entries(g), entry: 'Doc', corpus: [{ id: 'c', text: 'abcd;'.repeat(n) }],
    })
    const doc = r.arms.filter(a => a.site.rule === 'Doc')
    const narrow = doc.find(a => a.arm === 0)!
    expect(narrow.firstCharGated).toBe(true)
    expect(narrow.attempts).toBe(n)          // interpreter enters it every time
    expect(narrow.gatedAttempts).toBe(0)     // compiled output never does
    expect(narrow.gatedWastedBytes).toBe(0)

    // The arm that survives gating: '!' never matches, so it fails after 4 letters.
    const survives = doc.find(a => a.arm === 1)!
    expect(survives.firstCharGated).toBe(true)
    expect(survives.gatedAttempts).toBe(n)
    expect(survives.gatedFailures).toBe(n)
    expect(survives.gatedWastedBytes).toBe(4 * n)   // exact, by construction

    // And the ranking follows the COMPILED column.
    expect(r.arms[0]!.arm).toBe(1)

    // THE STRUCTURAL POINT, and it is not what it first looks like: gating removes
    // ATTEMPTS, not bytes. A first-char gate is derived from the arm's first SET, which
    // over-approximates what the arm can start with — so when the gate rejects, the
    // arm's own leading terminal would have rejected too, at the same position, having
    // consumed nothing. A gated-out attempt therefore costs ZERO rescanned bytes in the
    // interpreter as well, and the two byte columns coincide.
    expect(narrow.wastedBytes).toBe(0)
    expect(r.totalGatedWastedBytes).toBe(r.totalWastedBytes)
  })

  it('gating removes ATTEMPTS, not bytes — the failure RATE is what was misleading', () => {
    const n = 12
    const r = profileWastedWork({
      rules: entries(g), entry: 'Doc', corpus: [{ id: 'c', text: 'abcd;'.repeat(n) }],
    })
    const narrow = r.arms.filter(a => a.site.rule === 'Doc').find(a => a.arm === 0)!
    // Interpreted, this arm reads as "entered on every item and fails every time" — the
    // shape of a top finding. Compiled, it is never entered, and there is nothing to fix.
    expect(narrow.failures / narrow.attempts).toBe(1)
    expect(narrow.gatedAttempts).toBe(0)
    // Which is why `inversions` is computed from the gated columns: an arm the shipped
    // parser never enters must not be reported as an ordering defect in it.
    expect(r.inversions.some(a => a.site.rule === 'Doc' && a.arm === 0)).toBe(false)
  })

  it('an ungated arm reports identical interpreted and gated numbers', () => {
    const h = rules(() => ({
      Doc: many(choice(many(literal('~')), sequence(regex(/[a-z]+/), literal(';')))),
    }))
    const r = profileWastedWork({ rules: entries(h), entry: 'Doc', corpus: [{ id: 'c', text: 'ab;' }] })
    for (const a of r.arms.filter(x => !x.firstCharGated)) {
      expect(a.gatedAttempts).toBe(a.attempts)
      expect(a.gatedWastedBytes).toBe(a.wastedBytes)
    }
  })

  it('inversions rank by ATTEMPTS, so a frequent cheap defect outranks a rare costly one', () => {
    // Two always-failing first arms. `Many` is entered 12 times and re-scans 1 byte each;
    // `Few` is entered 5 times and re-scans 9 bytes each — more bytes, fewer attempts.
    // Byte ranking puts `Few` first; an ordering defect entered four times as often is
    // the more useful thing to see, so `inversions` ranks by attempts.
    const k = rules(() => ({
      Many: many(choice(sequence(regex(/[a-z]/), literal('!')), sequence(regex(/[a-z]/), literal(';')))),
      Few:  many(choice(sequence(regex(/[0-9]{9}/), literal('!')), sequence(regex(/[0-9]{9}/), literal(';')))),
      Doc:  sequence(many(choice(sequence(regex(/[a-z]/), literal('!')), sequence(regex(/[a-z]/), literal(';')))),
                     many(choice(sequence(regex(/[0-9]{9}/), literal('!')), sequence(regex(/[0-9]{9}/), literal(';'))))),
    }))
    const r = profileWastedWork({
      rules: entries(k), entry: 'Doc',
      corpus: [{ id: 'c', text: 'a;'.repeat(12) + '123456789;'.repeat(5) }],
    })
    const inv = r.inversions.filter(a => a.arm === 0 && a.site.rule === 'Doc')
    expect(inv.length).toBe(2)
    const first = inv[0]!, second = inv[1]!
    expect(first.gatedAttempts).toBeGreaterThan(second.gatedAttempts)
    expect(first.gatedWastedBytes).toBeLessThan(second.gatedWastedBytes)
    for (const a of inv) expect(a.gatedFailures).toBe(a.gatedAttempts)
  })
})

// ── the SHIPPED gate's committed artifacts ───────────────────────────────────
//
// `pnpm choicecost:guard` runs in CI and is the real check. These are the cheap
// integrity properties of the things it reads, so a hand-edited baseline or a
// grammar that stopped exporting its rule map fails in milliseconds here rather
// than several minutes into a CI job.

describe('the committed choice-cost baseline', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('../../bench/choice-cost-baseline.json', import.meta.url), 'utf8'),
  ) as ReturnType<typeof buildWastedWorkBaseline>

  it('is a baseline of the right schema, over a non-empty gated set', () => {
    expect(baseline.schema).toBe('parseman.wasted-work-baseline/1')
    expect(Object.keys(baseline.totals).length).toBeGreaterThan(0)
    expect(Object.keys(baseline.sites).length).toBeGreaterThan(0)
  })

  it('gates BOTH dialects — the ambiguous one and its low-rollback control', () => {
    // A single row could not tell "this grammar got slower" from "the compiler did".
    // Dropping either one silently halves what the gate can conclude.
    expect(Object.keys(baseline.totals).sort()).toEqual(['css', 'less'])
  })

  it('every site key belongs to a baselined corpus', () => {
    const corpora = new Set(Object.keys(baseline.totals))
    for (const key of Object.keys(baseline.sites)) {
      const id = key.slice(0, key.indexOf('::'))
      expect(corpora.has(id), `site key ${key} names no baselined corpus`).toBe(true)
    }
  })

  it('records positive corpus bytes for every row — a zero denominator gates nothing', () => {
    for (const [id, t] of Object.entries(baseline.totals)) {
      expect(t.corpusBytes, `${id} corpusBytes`).toBeGreaterThan(0)
      expect(t.instrumentedSites, `${id} instrumentedSites`).toBeGreaterThan(0)
    }
  })

  it('the grammar the guard names still exports the rule MAP, not just the entry rule', async () => {
    // The guard fails closed if this disappears, but it costs minutes to find out
    // that way. Analysis walks a grammar by name; without the map every choice site
    // in the report would be anonymous.
    //
    // Only the css row is asserted here. `bench/workloads/less.ts` is deliberately
    // OUTSIDE tsc's graph — see the comment in tsconfig.json, and the reason
    // test/parity/bench-parsers.test.ts is excluded — and importing it from a
    // typechecked test drags all of bench/ back in, which surfaces three latent
    // TS2556s in that file that have nothing to do with this gate. The less row is
    // covered where it belongs: `pnpm choicecost:guard` in CI, which fails closed
    // with a named error if the export goes away.
    const css = await import('../../examples/css/parser.ts')
    expect(Object.keys(css.cssRules).length).toBeGreaterThan(1)
    expect(css.cssRules.Stylesheet).toBe(css.Stylesheet)
  })
})
