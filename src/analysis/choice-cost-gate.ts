/**
 * CHOICE COST — the policy layer.
 * ===============================
 *
 * Analysis says what the grammar costs. This says which of those numbers fail a build.
 * They are separate because they have different consumers and different lifetimes: a
 * developer wants the ranked list on every run, CI wants one bit, and the threshold
 * that produces that bit is a decision the owner makes once and writes down.
 *
 * This module is PURE — it takes a report and a baseline and returns a verdict. It
 * reads no files, spawns nothing, and prints nothing, so it is testable without a
 * fixture checkout and cannot be the reason a gate is flaky.
 *
 * THE BASELINE IS ABSOLUTE, NOT DIFFERENTIAL
 * ------------------------------------------
 * Gating each commit against its parent lets +2% per commit land forever: every
 * individual step is under tolerance and the total is unbounded. So the committed
 * baseline records the ACTUAL byte counts, and drift is measured against those
 * numbers, not against yesterday's.
 *
 * A baseline is committed DATA, reviewed like any other diff. Nothing here writes one.
 * Rebaselining is a deliberate act with a reviewable artifact and owner sign-off; there
 * is no automatic refresh, because a gate that rebaselines itself is a gate that
 * records regressions rather than catching them.
 *
 * AND IT IS TWO-SIDED — A WIN MUST BE BANKED
 * ------------------------------------------
 * Growth past the committed number fails, and so does an unbanked IMPROVEMENT. This is
 * the half usually left to a comment asking a human politely, and it is the half that
 * rots: `bench/grammar-density/config.json` and `bench/workloads/config.json` each
 * carried exactly such a comment and sat unbumped for TEN releases. If a reorder takes
 * a site from 7,846 wasted bytes to 2,000 and the baseline does not move with it, 5,846
 * bytes of fresh headroom silently become budget for the next regression — and the gate
 * that was supposed to catch that regression reads green through the whole of it.
 *
 * So the committed number is a BAND, not a floor: leaving it in either direction fails,
 * and only the remedy differs. Raising a number needs owner sign-off; lowering one is
 * mandatory. Both are the same one-line rebaseline and the same reviewable diff.
 *
 * `bench/size-guard.ts` is the shape this follows — it earned the tightness in 0.45 by
 * catching +0.14% moves a 1% tolerance would have waved through.
 *
 * A BASELINE CANNOT LAUNDER A CEILING
 * -----------------------------------
 * If a ceiling is configured, a baseline that records a number ABOVE it is rejected as
 * invalid rather than honoured. Otherwise the ceiling would be waivable by rebaselining,
 * which makes it a suggestion. (`bench/size-guard.ts` validates its own baseline for
 * exactly this reason; this follows it.)
 *
 * FAILS CLOSED
 * ------------
 * Every way of not having measured is a failure, never a pass: a missing baseline, a
 * baseline of the wrong shape, an empty baseline, a report over zero corpus files, a
 * report where no site was instrumentable, a report whose grammar walk was incomplete
 * (`unresolvedRoots` non-empty), a baselined key that no longer exists, and a measured
 * key with no baseline entry. This repo already contains the alternative — `ratio:
 * ordered.length === 0 ? 1` in src/coverage.ts reports 100% covered when nothing was
 * analysable — and the whole point of a gate is to not be that.
 */

import type { WastedWorkReport } from './choice-cost.ts'

export type WastedWorkBaseline = {
  readonly schema: 'parseman.wasted-work-baseline/1'
  /** Informational: which revision produced the numbers. Never compared. */
  gitRev: string
  /** Informational, `YYYY-MM-DD`. Never compared — comparing it would make the
   *  verdict depend on the clock. */
  updatedAt: string
  /** Absolute per-corpus totals, keyed by corpus id. */
  totals: Record<string, { corpusBytes: number; totalWastedBytes: number; instrumentedSites: number }>
  /** Absolute per-site wasted bytes, keyed by `<corpus>::<siteKey>`. */
  sites: Record<string, number>
}

export type WastedWorkPolicy = {
  /**
   * Maximum wasted bytes per corpus byte. A hard ceiling no rebaseline can waive.
   * Omit for drift-only gating; a project should set it once it knows its own number.
   */
  ceilingRatio?: number
  /**
   * Half-width of the band around each committed number, as a percentage. Default 1.
   *
   * SYMMETRIC: a measurement more than this ABOVE its baseline is a regression, and a
   * measurement more than this BELOW it is an unbanked win. Both fail.
   *
   * This is not a noise allowance — the metric is a deterministic count of input bytes,
   * so its noise floor is exactly zero and any non-zero value here is pure headroom.
   * It exists only so incidental one-byte churn does not thrash the baseline in both
   * directions. Set it as near zero as the corpus permits; `bench/choice-cost-guard.ts`
   * runs at 0.1, matching `bench/size-guard.ts`'s ratchet slack.
   */
  driftTolerancePct?: number
  /**
   * Fail on an ordering inversion — an arm that failed every one of its attempts while
   * a later arm at the same site matched. Off by default: on an existing grammar this
   * fires immediately, and a gate that is red on arrival for a pre-existing condition
   * gets disabled rather than fixed. Turn it on once the backlog is empty, to keep it
   * empty.
   */
  failOnInversions?: boolean
}

export type GateBreach = {
  /** `drift` is growth past the band; `shrank` is an improvement that was not banked.
   *  Both are failures, and the `detail` says which remedy applies. */
  kind: 'ceiling' | 'drift' | 'shrank' | 'unbaselined' | 'stale' | 'inversion' | 'unmeasurable' | 'invalid-baseline'
  key: string
  /** One line. Says what happened and what number to look at — never advice. */
  detail: string
}

export type GateVerdict = {
  readonly schema: 'parseman.wasted-work-verdict/1'
  ok: boolean
  /** Ascending by (kind, key). Deterministic, so a verdict is diffable. */
  breaches: readonly GateBreach[]
  checkedCorpora: number
  checkedSites: number
}

const KIND_ORDER: GateBreach['kind'][] = [
  'invalid-baseline', 'unmeasurable', 'ceiling', 'drift', 'shrank', 'inversion', 'unbaselined', 'stale',
]

const pct = (actual: number, base: number): number => base === 0 ? (actual === 0 ? 0 : Infinity) : (actual / base - 1) * 100

/**
 * Judge one or more measured corpora against a committed baseline.
 *
 * `reports` is keyed by corpus id — a grammar is usually gated over more than one body
 * of input, and a single blended number would let a regression on one hide behind an
 * improvement on another.
 */
export function checkWastedWork(
  reports: Readonly<Record<string, WastedWorkReport>>,
  baseline: unknown,
  policy: WastedWorkPolicy = {},
): GateVerdict {
  const breaches: GateBreach[] = []
  const tolerance = policy.driftTolerancePct ?? 1

  const add = (kind: GateBreach['kind'], key: string, detail: string): void => { breaches.push({ kind, key, detail }) }

  const finish = (checkedCorpora: number, checkedSites: number): GateVerdict => {
    breaches.sort((a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return {
      schema: 'parseman.wasted-work-verdict/1',
      ok: breaches.length === 0,
      breaches,
      checkedCorpora,
      checkedSites,
    }
  }

  // ── the baseline must be a baseline ───────────────────────────────────────
  const b = baseline as Partial<WastedWorkBaseline> | null | undefined
  if (b === null || b === undefined || typeof b !== 'object') {
    add('invalid-baseline', '<baseline>', 'no baseline supplied — a gate with no baseline measures nothing, and passing here is how a budget stops being enforced')
    return finish(0, 0)
  }
  if (b.schema !== 'parseman.wasted-work-baseline/1') {
    add('invalid-baseline', '<baseline>', `baseline schema is ${JSON.stringify(b.schema)}, expected "parseman.wasted-work-baseline/1"`)
    return finish(0, 0)
  }
  if (b.totals === undefined || b.sites === undefined || typeof b.totals !== 'object' || typeof b.sites !== 'object') {
    add('invalid-baseline', '<baseline>', 'baseline is missing `totals` or `sites`')
    return finish(0, 0)
  }
  if (Object.keys(b.totals).length === 0) {
    add('invalid-baseline', '<baseline>', 'baseline records ZERO corpora')
    return finish(0, 0)
  }
  if (policy.ceilingRatio !== undefined) {
    for (const [id, t] of Object.entries(b.totals).sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (t.corpusBytes > 0 && t.totalWastedBytes / t.corpusBytes > policy.ceilingRatio) {
        add('invalid-baseline', id,
          `baseline records ${t.totalWastedBytes} wasted / ${t.corpusBytes} corpus bytes = `
          + `${(t.totalWastedBytes / t.corpusBytes).toFixed(3)}x, above the ${policy.ceilingRatio}x ceiling — `
          + 'a rebaseline cannot accept an over-ceiling number')
      }
    }
    if (breaches.length > 0) return finish(0, 0)
  }

  if (Object.keys(reports).length === 0) {
    add('unmeasurable', '<reports>', 'no corpus was measured — refusing to report a pass on an empty measurement')
    return finish(0, 0)
  }

  let checkedSites = 0

  for (const id of Object.keys(reports).sort()) {
    const r = reports[id]!

    // ── could this report have measured anything? ───────────────────────────
    if (r.corpusFiles === 0) { add('unmeasurable', id, 'report covers ZERO corpus files'); continue }
    if (r.instrumentedSites === 0) { add('unmeasurable', id, 'report instrumented ZERO choice sites — the total below would be zero for a reason unrelated to the grammar'); continue }
    if (r.unresolvedRoots.length > 0) {
      add('unmeasurable', id,
        `${r.unresolvedRoots.length} rule(s) could not be resolved and were NOT walked `
        + `(${r.unresolvedRoots.slice(0, 4).join(', ')}${r.unresolvedRoots.length > 4 ? ', …' : ''}) — `
        + 'the total is a lower bound over an unknown fraction of the grammar')
      continue
    }

    const base = b.totals[id]
    if (base === undefined) {
      add('unbaselined', id, `measured but absent from the baseline (${r.totalWastedBytes} wasted bytes over ${r.corpusBytes})`)
      continue
    }

    if (policy.ceilingRatio !== undefined && r.corpusBytes > 0) {
      const ratio = r.totalWastedBytes / r.corpusBytes
      if (ratio > policy.ceilingRatio) {
        add('ceiling', id, `${r.totalWastedBytes} wasted / ${r.corpusBytes} corpus bytes = ${ratio.toFixed(3)}x, over the ${policy.ceilingRatio}x ceiling`)
      }
    }

    // The corpus itself is part of the measurement. If it changed, the totals are
    // not comparable and a "no drift" verdict would be meaningless.
    if (r.corpusBytes !== base.corpusBytes) {
      add('unmeasurable', id, `corpus changed: baseline ${base.corpusBytes} bytes, measured ${r.corpusBytes} — totals are not comparable until the baseline is refreshed`)
      continue
    }

    // Two-sided. Growth is a regression; an unbanked win is next quarter's regression
    // budget. Same band, same rebaseline, different sentence.
    const d = pct(r.totalWastedBytes, base.totalWastedBytes)
    if (d > tolerance) {
      add('drift', id, `total wasted ${base.totalWastedBytes} -> ${r.totalWastedBytes} bytes (${d >= 0 ? '+' : ''}${d.toFixed(2)}%, band ±${tolerance}%)`)
    } else if (d < -tolerance) {
      add('shrank', id, `total wasted ${base.totalWastedBytes} -> ${r.totalWastedBytes} bytes (${d.toFixed(2)}%, band ±${tolerance}%) — BANK THE WIN: rebaseline so the ${base.totalWastedBytes - r.totalWastedBytes} bytes you just saved cannot become headroom for the next regression`)
    }

    for (const s of r.sites) {
      const key = `${id}::${s.siteKey}`
      const bs = b.sites[key]
      if (bs === undefined) {
        if (s.wastedBytes > 0) add('unbaselined', key, `site measured ${s.wastedBytes} wasted bytes but has no baseline entry`)
        continue
      }
      checkedSites++
      const sd = pct(s.wastedBytes, bs)
      if (sd > tolerance) add('drift', key, `${bs} -> ${s.wastedBytes} bytes (${sd >= 0 ? '+' : ''}${sd.toFixed(2)}%, band ±${tolerance}%)`)
      else if (sd < -tolerance) add('shrank', key, `${bs} -> ${s.wastedBytes} bytes (${sd.toFixed(2)}%, band ±${tolerance}%) — BANK THE WIN: rebaseline, or this site's ${bs - s.wastedBytes} recovered bytes become budget`)
    }

    if (policy.failOnInversions === true) {
      for (const inv of r.inversions) {
        add('inversion', `${id}::${inv.siteKey}#${inv.arm}`,
          `arm ${inv.arm} (${inv.label}) failed all ${inv.attempts} attempts while a later arm matched; ${inv.wastedBytes} bytes re-scanned`)
      }
    }
  }

  const measuredKeys = new Set<string>()
  for (const id of Object.keys(reports)) for (const s of reports[id]!.sites) measuredKeys.add(`${id}::${s.siteKey}`)
  for (const key of Object.keys(b.sites).sort()) {
    if (!measuredKeys.has(key)) {
      add('stale', key, 'baselined site matches no measured site — a rule was renamed or removed, and ignoring it silently shrinks the gated set')
    }
  }
  for (const id of Object.keys(b.totals).sort()) {
    if (reports[id] === undefined) add('stale', id, 'baselined corpus was not measured')
  }

  return finish(Object.keys(reports).length, checkedSites)
}

/**
 * Build the baseline a passing measurement would record.
 *
 * Deliberately NOT called by the gate. It exists so a rebaseline is one explicit
 * command whose output is a file in the diff — the reviewable record — rather than
 * something the gate can do to itself on a red run.
 */
export function buildWastedWorkBaseline(
  reports: Readonly<Record<string, WastedWorkReport>>,
  meta: { gitRev: string; updatedAt: string },
): WastedWorkBaseline {
  const totals: WastedWorkBaseline['totals'] = {}
  const sites: WastedWorkBaseline['sites'] = {}
  for (const id of Object.keys(reports).sort()) {
    const r = reports[id]!
    totals[id] = { corpusBytes: r.corpusBytes, totalWastedBytes: r.totalWastedBytes, instrumentedSites: r.instrumentedSites }
    for (const s of [...r.sites].sort((a, c) => (a.siteKey < c.siteKey ? -1 : 1))) {
      if (s.wastedBytes > 0) sites[`${id}::${s.siteKey}`] = s.wastedBytes
    }
  }
  return { schema: 'parseman.wasted-work-baseline/1', gitRev: meta.gitRev, updatedAt: meta.updatedAt, totals, sites }
}
