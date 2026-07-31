/**
 * CHOICE COST — the POLICY layer (src/analysis/choice-cost-gate.ts).
 *
 * `test/unit/choice-cost.test.ts` gates the paths a real measurement reaches. This
 * file covers the ones it cannot reach from a live grammar without contriving one:
 * a corpus that measured nothing, a baseline whose recorded number is zero, a report
 * whose compiled and interpreted columns have PARTED, and the per-site halves of
 * each. Those are exactly the branches where a fail-open would be invisible — the
 * gate would report a pass over a number it never compared.
 *
 * Reports are built as data rather than measured, deliberately: the module is pure,
 * takes a report and a baseline, and returns a verdict, so a fixture grammar would
 * add a dependency on the parser without adding a single assertion. Every case here
 * asserts BOTH the verdict bit and the breach line, because a gate whose message
 * does not name the number to look at is a gate people learn to ignore.
 */
import { describe, it, expect } from 'vitest'
import { checkWastedWork, buildWastedWorkBaseline } from '../../src/analysis/choice-cost-gate.ts'
import type { WastedWorkBaseline, GateBreach } from '../../src/analysis/choice-cost-gate.ts'
import type { WastedWorkReport, WastedWorkArm, WastedWorkSite } from '../../src/analysis/choice-cost.ts'

const armOf = (siteKey: string, arm: number, label: string, o: Partial<WastedWorkArm>): WastedWorkArm => ({
  siteKey, site: { rule: siteKey, path: '' }, arm, label,
  attempts: 0, failures: 0, wastedBytes: 0, firstCharGated: false,
  gatedAttempts: 0, gatedFailures: 0, gatedWastedBytes: 0, ...o,
})
const siteOf = (siteKey: string, o: Partial<WastedWorkSite>): WastedWorkSite => ({
  siteKey, site: { rule: siteKey, path: '' }, strategy: 'firstMatch', arity: 2,
  instrumented: true, attempts: 0, failures: 0, wastedBytes: 0,
  gatedAttempts: 0, gatedFailures: 0, gatedWastedBytes: 0, ...o,
})
/** A measurable report: non-zero corpus, an instrumented site, a complete walk. */
const reportOf = (o: Partial<WastedWorkReport>): WastedWorkReport => ({
  schema: 'parseman.wasted-work/1', corpusFiles: 1, corpusBytes: 1000, parsedOk: 1, parsedFailed: 0,
  instrumentedSites: 2, uninstrumentableSites: 0, unresolvedRoots: [],
  totalWastedBytes: 0, totalGatedWastedBytes: 0, arms: [], inversions: [], sites: [], ...o,
})
const REV = { gitRev: 'abc1234', updatedAt: '2026-07-30' }
const only = (v: { breaches: readonly GateBreach[] }): GateBreach => {
  expect(v.breaches).toHaveLength(1)
  return v.breaches[0]!
}

/** One corpus, one site, 100 wasted bytes, both columns agreeing. */
const BASIC = reportOf({
  totalWastedBytes: 100, totalGatedWastedBytes: 100,
  sites: [siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 100 })],
})

describe('a report that measured nothing is never a pass', () => {
  const base = buildWastedWorkBaseline({ unit: BASIC }, REV)

  it('names ZERO corpus files as the reason, not the resulting zero total', () => {
    const v = checkWastedWork({ unit: reportOf({ ...BASIC, corpusFiles: 0 }) }, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.map(b => [b.kind, b.key, b.detail])).toContainEqual(
      ['unmeasurable', 'unit', 'report covers ZERO corpus files'],
    )
  })

  it('names ZERO instrumented sites — a zero total there says nothing about the grammar', () => {
    const v = checkWastedWork({ unit: reportOf({ ...BASIC, instrumentedSites: 0 }) }, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.some(b => b.kind === 'unmeasurable' && b.key === 'unit'
      && b.detail === 'report instrumented ZERO choice sites — the total below would be zero for a reason unrelated to the grammar')).toBe(true)
  })

  it('names the unresolved rules, and elides past four so the line stays one line', () => {
    const two = checkWastedWork({ unit: reportOf({ ...BASIC, unresolvedRoots: ['Alpha', 'Beta'] }) }, base)
    expect(two.ok).toBe(false)
    expect(two.breaches.find(b => b.kind === 'unmeasurable')!.detail).toBe(
      '2 rule(s) could not be resolved and were NOT walked (Alpha, Beta) — '
      + 'the total is a lower bound over an unknown fraction of the grammar',
    )
    const six = checkWastedWork(
      { unit: reportOf({ ...BASIC, unresolvedRoots: ['A', 'B', 'C', 'D', 'E', 'F'] }) }, base)
    expect(six.breaches.find(b => b.kind === 'unmeasurable')!.detail).toBe(
      '6 rule(s) could not be resolved and were NOT walked (A, B, C, D, …) — '
      + 'the total is a lower bound over an unknown fraction of the grammar',
    )
  })

  it('stops at the first unmeasurable reason — no drift verdict is offered alongside it', () => {
    // The baseline says 100 and the report says 900, which WOULD be drift; the
    // report is unmeasurable, so no comparison is made at all.
    const v = checkWastedWork({
      unit: reportOf({ ...BASIC, corpusFiles: 0, totalWastedBytes: 900, totalGatedWastedBytes: 900 }),
    }, base)
    expect(v.breaches.map(b => b.kind)).toEqual(['unmeasurable'])
    expect(v.checkedSites).toBe(0)
    expect(v.checkedCorpora).toBe(1)
  })
})

describe('a corpus with no baseline row is unbaselined, not skipped', () => {
  it('reports the measured numbers so the rebaseline can be checked against them', () => {
    const base = buildWastedWorkBaseline({ unit: BASIC }, REV)
    const v = checkWastedWork({ unit: BASIC, extra: BASIC }, base)
    expect(v.ok).toBe(false)
    const b = v.breaches.find(x => x.key === 'extra')!
    expect(b.kind).toBe('unbaselined')
    expect(b.detail).toBe('measured but absent from the baseline (100 wasted bytes over 1000)')
  })

  it('a MEASURED site with no baseline entry is unbaselined only when it cost something', () => {
    const r = reportOf({
      totalWastedBytes: 100, totalGatedWastedBytes: 100,
      sites: [
        siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 100 }),
        siteOf('New › choice[0]', { wastedBytes: 7, gatedWastedBytes: 7 }),
        siteOf('Free › choice[0]', {}),
      ],
    })
    // buildWastedWorkBaseline records only sites that cost something, so `Free` has
    // no entry by construction and `New` gets one — remove it to make the case.
    const base = buildWastedWorkBaseline({ unit: r }, REV)
    expect(Object.keys(base.sites)).toEqual(['unit::Doc › choice[0]', 'unit::New › choice[0]'])
    delete base.sites['unit::New › choice[0]']
    const v = checkWastedWork({ unit: r }, base)
    expect(v.breaches.map(b => [b.kind, b.key])).toEqual([
      ['unbaselined', 'unit::New › choice[0]'],
    ])
    // `Free` is silent — a zero-cost site is not a gap in the baseline.
    expect(v.breaches.some(b => b.key.includes('Free'))).toBe(false)
    // And only the site that HAS a baseline row was compared.
    expect(v.checkedSites).toBe(1)
  })
})

describe('a baselined zero is a real number, not a free pass', () => {
  const zeroBase: WastedWorkBaseline = {
    schema: 'parseman.wasted-work-baseline/1', ...REV,
    totals: { unit: { corpusBytes: 1000, totalWastedBytes: 0, instrumentedSites: 2 } },
    sites: {},
  }

  it('measuring zero against a baselined zero is quiet', () => {
    const v = checkWastedWork({ unit: reportOf({ sites: [siteOf('Doc › choice[0]', {})] }) }, zeroBase)
    expect(v.ok).toBe(true)
    expect(v.breaches).toEqual([])
  })

  it('growth away from a baselined zero is unbounded drift, and says so', () => {
    const v = checkWastedWork({
      unit: reportOf({
        totalWastedBytes: 5, totalGatedWastedBytes: 5,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 5, gatedWastedBytes: 5 })],
      }),
    }, zeroBase)
    expect(v.ok).toBe(false)
    // A percentage of zero has no finite value; the gate reports it rather than
    // letting NaN/Infinity read as "within band".
    expect(v.breaches.some(b => b.kind === 'drift' && b.key === 'unit'
      && b.detail === 'total wasted 0 -> 5 bytes (+Infinity%, band ±1%)')).toBe(true)
  })
})

describe('the CEILING is checked against the measurement, not only the baseline', () => {
  it('fails a report over the ceiling even though the baseline is under it', () => {
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: { unit: { corpusBytes: 1000, totalWastedBytes: 5, instrumentedSites: 2 } },
      sites: {},
    }
    const v = checkWastedWork({
      unit: reportOf({ totalWastedBytes: 500, totalGatedWastedBytes: 500 }),
    }, base, { ceilingRatio: 0.01 })
    expect(v.ok).toBe(false)
    // Ceiling sorts ahead of drift, so the hard limit is the first thing read.
    expect(v.breaches.map(b => b.kind)).toEqual(['ceiling', 'drift'])
    expect(v.breaches[0]!.detail).toBe('500 wasted / 1000 corpus bytes = 0.500x, over the 0.01x ceiling')
  })

  it('passes a report under the ceiling, and the ceiling never fires on a zero corpus', () => {
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: { unit: { corpusBytes: 0, totalWastedBytes: 100, instrumentedSites: 2 } },
      sites: { 'unit::Doc › choice[0]': 100 },
    }
    // corpusBytes 0 on both sides: a ratio has no denominator, so the ceiling is not
    // evaluated in either the baseline validation or the report check.
    const v = checkWastedWork({
      unit: reportOf({
        corpusBytes: 0, totalWastedBytes: 100, totalGatedWastedBytes: 100,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 100 })],
      }),
    }, base, { ceilingRatio: 0.01 })
    expect(v.ok).toBe(true)
  })
})

describe('the COMPILED column is held to the same band wherever it parts from the interpreted one', () => {
  const base = buildWastedWorkBaseline({ unit: BASIC }, REV)

  it('a compiled total above the band is drift, and the message says the columns PARTED', () => {
    const v = checkWastedWork({
      unit: reportOf({ ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 400 }),
    }, base)
    expect(v.ok).toBe(false)
    const b = only(v)
    expect(b.kind).toBe('drift')
    expect(b.detail).toBe(
      'compiled-model total wasted 100 -> 400 bytes (+300.00%, band ±1%) — '
      + 'the compiled and interpreted columns have PARTED (400 vs 100); the baseline records the interpreted one',
    )
  })

  it('a compiled total below the band is an unbanked win, reported against the same baseline', () => {
    const v = checkWastedWork({
      unit: reportOf({ ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 10 }),
    }, base)
    expect(v.ok).toBe(false)
    const b = only(v)
    expect(b.kind).toBe('shrank')
    expect(b.detail).toBe(
      'compiled-model total wasted 100 -> 10 bytes (-90.00%, band ±1%) — '
      + 'the compiled and interpreted columns have PARTED (10 vs 100); the baseline records the interpreted one',
    )
  })

  it('a parted compiled column INSIDE the band is quiet', () => {
    const v = checkWastedWork({
      unit: reportOf({ ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 100.5 }),
    }, base)
    expect(v.ok).toBe(true)
  })

  it('holds the per-SITE compiled column to the band too, in both directions', () => {
    const grew = checkWastedWork({
      unit: reportOf({
        ...BASIC,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 250 })],
      }),
    }, base)
    expect(only(grew).detail).toBe(
      'compiled-model 100 -> 250 bytes (+150.00%, band ±1%) — columns PARTED (250 vs 100)',
    )
    expect(grew.breaches[0]!.key).toBe('unit::Doc › choice[0]')

    const shrank = checkWastedWork({
      unit: reportOf({
        ...BASIC,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 25 })],
      }),
    }, base)
    expect(only(shrank).kind).toBe('shrank')
    expect(shrank.breaches[0]!.detail).toBe(
      'compiled-model 100 -> 25 bytes (-75.00%, band ±1%) — columns PARTED (25 vs 100)',
    )
  })

  it('says nothing extra while the two columns agree — the identity adds no line', () => {
    expect(checkWastedWork({ unit: BASIC }, base).breaches).toEqual([])
  })
})

describe('per-site drift names the two numbers a reviewer compares', () => {
  const base = buildWastedWorkBaseline({ unit: BASIC }, REV)

  it('growth', () => {
    const v = checkWastedWork({
      unit: reportOf({
        ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 100,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 130, gatedWastedBytes: 130 })],
      }),
    }, base)
    expect(only(v)).toEqual({
      kind: 'drift', key: 'unit::Doc › choice[0]',
      detail: '100 -> 130 bytes (+30.00%, band ±1%)',
    })
  })

  it('an unbanked per-site win names the reclaimed bytes', () => {
    const v = checkWastedWork({
      unit: reportOf({
        ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 100,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 60, gatedWastedBytes: 60 })],
      }),
    }, base)
    expect(only(v)).toEqual({
      kind: 'shrank', key: 'unit::Doc › choice[0]',
      detail: '100 -> 60 bytes (-40.00%, band ±1%) — BANK THE WIN: rebaseline, or this site\'s 40 recovered bytes become budget',
    })
  })

  it('honours a tighter tolerance than the default 1%', () => {
    const r = reportOf({
      ...BASIC, totalWastedBytes: 100, totalGatedWastedBytes: 100,
      sites: [siteOf('Doc › choice[0]', { wastedBytes: 100.5, gatedWastedBytes: 100.5 })],
    })
    expect(checkWastedWork({ unit: r }, base).breaches.some(b => b.kind === 'drift')).toBe(false)
    const tight = checkWastedWork({ unit: r }, base, { driftTolerancePct: 0.1 })
    expect(tight.ok).toBe(false)
    expect(tight.breaches.some(b => b.kind === 'drift' && b.detail.includes('band ±0.1%'))).toBe(true)
  })
})

describe('the verdict is ordered by kind then key, so it is diffable', () => {
  it('sorts a mixed set into the documented kind order', () => {
    const r = reportOf({
      totalWastedBytes: 400, totalGatedWastedBytes: 400,
      sites: [
        siteOf('Zed › choice[0]', { wastedBytes: 200, gatedWastedBytes: 200 }),
        siteOf('Doc › choice[0]', { wastedBytes: 200, gatedWastedBytes: 200 }),
      ],
      inversions: [armOf('Doc › choice[0]', 0, 'Narrow', { attempts: 9, failures: 9, gatedAttempts: 9, gatedFailures: 9, gatedWastedBytes: 31 })],
    })
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: { unit: { corpusBytes: 1000, totalWastedBytes: 100, instrumentedSites: 2 } },
      sites: {
        'unit::Doc › choice[0]': 100,
        'unit::Zed › choice[0]': 900,
        'unit::Gone › choice[0]': 5,
      },
    }
    const v = checkWastedWork({ unit: r }, base, { ceilingRatio: 0.1, failOnInversions: true })
    expect(v.breaches.map(b => `${b.kind}:${b.key}`)).toEqual([
      'ceiling:unit',
      'drift:unit',
      'drift:unit::Doc › choice[0]',
      'shrank:unit::Zed › choice[0]',
      'inversion:unit::Doc › choice[0]#0',
      'stale:unit::Gone › choice[0]',
    ])
    expect(v.checkedCorpora).toBe(1)
    expect(v.checkedSites).toBe(2)
    expect(v.breaches.find(b => b.kind === 'inversion')!.detail).toBe(
      'arm 0 (Narrow) failed all 9 compiled entries while a later arm matched; 31 bytes re-scanned',
    )
    // Deterministic: the same inputs render the same verdict bytes.
    expect(JSON.stringify(checkWastedWork({ unit: r }, base, { ceilingRatio: 0.1, failOnInversions: true })))
      .toBe(JSON.stringify(v))
  })

  it('keeps two breaches of the same kind on the same key, in the order they were found', () => {
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: { unit: { corpusBytes: 1000, totalWastedBytes: 130, instrumentedSites: 2 } },
      sites: { 'unit::Doc › choice[0]': 100 },
    }
    const v = checkWastedWork({
      unit: reportOf({
        totalWastedBytes: 130, totalGatedWastedBytes: 250,
        sites: [siteOf('Doc › choice[0]', { wastedBytes: 130, gatedWastedBytes: 250 })],
      }),
    }, base)
    expect(v.ok).toBe(false)
    // Same kind, same key, twice: the interpreted column and the parted compiled one
    // are two separate findings about one site, and neither is dropped as a duplicate.
    expect(v.breaches.map(b => `${b.kind}:${b.key}`)).toEqual([
      'drift:unit',
      'drift:unit::Doc › choice[0]',
      'drift:unit::Doc › choice[0]',
    ])
    expect(v.breaches[1]!.detail).toBe('100 -> 130 bytes (+30.00%, band ±1%)')
    expect(v.breaches[2]!.detail).toBe(
      'compiled-model 100 -> 250 bytes (+150.00%, band ±1%) — columns PARTED (250 vs 130)',
    )
  })

  it('rejects EVERY over-ceiling baseline row, ordered by corpus id', () => {
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: {
        less: { corpusBytes: 1000, totalWastedBytes: 500, instrumentedSites: 2 },
        css: { corpusBytes: 1000, totalWastedBytes: 900, instrumentedSites: 2 },
        clean: { corpusBytes: 1000, totalWastedBytes: 1, instrumentedSites: 2 },
      },
      sites: {},
    }
    const v = checkWastedWork({ css: BASIC, less: BASIC, clean: BASIC }, base, { ceilingRatio: 0.01 })
    expect(v.ok).toBe(false)
    expect(v.breaches.map(b => `${b.kind}:${b.key}`)).toEqual(['invalid-baseline:css', 'invalid-baseline:less'])
    expect(v.breaches[0]!.detail).toBe(
      'baseline records 900 wasted / 1000 corpus bytes = 0.900x, above the 0.01x ceiling — '
      + 'a rebaseline cannot accept an over-ceiling number',
    )
    // Nothing was compared: an invalid baseline stops before any measurement is read.
    expect(v.checkedCorpora).toBe(0)
    expect(v.checkedSites).toBe(0)
  })

  it('judges each corpus separately — one improving cannot pay for another regressing', () => {
    const base: WastedWorkBaseline = {
      schema: 'parseman.wasted-work-baseline/1', ...REV,
      totals: {
        css: { corpusBytes: 1000, totalWastedBytes: 100, instrumentedSites: 2 },
        less: { corpusBytes: 1000, totalWastedBytes: 100, instrumentedSites: 2 },
      },
      sites: {},
    }
    const v = checkWastedWork({
      css: reportOf({ totalWastedBytes: 200, totalGatedWastedBytes: 200 }),
      less: reportOf({ totalWastedBytes: 0, totalGatedWastedBytes: 0 }),
    }, base)
    expect(v.ok).toBe(false)
    expect(v.breaches.map(b => `${b.kind}:${b.key}`)).toEqual(['drift:css', 'shrank:less'])
    expect(v.checkedCorpora).toBe(2)
  })
})

describe('buildWastedWorkBaseline records what a passing run measured', () => {
  it('sorts corpora and sites, drops zero-cost sites, and round-trips to a pass', () => {
    const reports = {
      zeta: reportOf({
        corpusBytes: 22, totalWastedBytes: 3, totalGatedWastedBytes: 3,
        sites: [siteOf('Z › choice[0]', { wastedBytes: 3, gatedWastedBytes: 3 })],
      }),
      alpha: reportOf({
        corpusBytes: 11, instrumentedSites: 5, totalWastedBytes: 30, totalGatedWastedBytes: 30,
        sites: [
          siteOf('Mid › choice[0]', { wastedBytes: 20, gatedWastedBytes: 20 }),
          siteOf('Beginning › choice[0]', { wastedBytes: 10, gatedWastedBytes: 10 }),
          siteOf('Costless › choice[0]', {}),
        ],
      }),
    }
    const b = buildWastedWorkBaseline(reports, REV)
    expect(b.schema).toBe('parseman.wasted-work-baseline/1')
    expect(b.gitRev).toBe('abc1234')
    expect(b.updatedAt).toBe('2026-07-30')
    expect(Object.keys(b.totals)).toEqual(['alpha', 'zeta'])
    expect(b.totals.alpha).toEqual({ corpusBytes: 11, totalWastedBytes: 30, instrumentedSites: 5 })
    // Site keys ascending WITHIN a corpus, not in the report's byte ranking.
    expect(Object.keys(b.sites)).toEqual([
      'alpha::Beginning › choice[0]',
      'alpha::Mid › choice[0]',
      'zeta::Z › choice[0]',
    ])
    expect(b.sites['alpha::Mid › choice[0]']).toBe(20)
    // What it records is exactly what passes.
    expect(checkWastedWork(reports, b).ok).toBe(true)
  })

  it('records the INTERPRETED column, and the gate then reads the compiled one against it', () => {
    const r = reportOf({
      totalWastedBytes: 100, totalGatedWastedBytes: 40,
      sites: [siteOf('Doc › choice[0]', { wastedBytes: 100, gatedWastedBytes: 40 })],
    })
    const b = buildWastedWorkBaseline({ unit: r }, REV)
    expect(b.totals.unit!.totalWastedBytes).toBe(100)
    expect(b.sites['unit::Doc › choice[0]']).toBe(100)
    // Round-tripping its OWN measurement still fails: the compiled column is 60%
    // below the recorded interpreted one, and a baseline cannot record both.
    const v = checkWastedWork({ unit: r }, b)
    expect(v.ok).toBe(false)
    expect(v.breaches.every(x => x.kind === 'shrank' && /PARTED/.test(x.detail))).toBe(true)
  })
})
