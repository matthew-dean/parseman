/**
 * The DELIBERATE grammar diagnostic — the one call that asks parseman "is anything
 * wrong with this grammar?" and answers in a form a machine can gate on.
 *
 * Why this exists as its own entry point, and why nothing in `compile()` prints any
 * more: a diagnostic that rides along with the thing that produces the artifact is a
 * diagnostic nobody chose to run. Importing one example grammar used to print ~51
 * lines of gating advice through `console.warn` before a single byte was parsed —
 * advice that was correct, detailed, and read by no one, because it arrived unasked
 * in the middle of an unrelated build log. The same principle is already settled one
 * layer down for codegen ("anything 'diagnostic' doesn't end up in codegen"); this is
 * that principle applied at build time. Compiling produces an artifact and says
 * nothing. Asking for a diagnosis produces a diagnosis.
 *
 * Design rules this surface holds itself to:
 *
 *  1. MACHINE-READABLE FIRST. `diagnoseGrammar()` returns a plain, JSON-serializable
 *     object with a versioned `schema` tag. The human rendering is a separate,
 *     optional function over that object — never the primary product. A CI job gates
 *     on `ok`; a person reads `formatGrammarDiagnosis()`.
 *  2. DETERMINISTIC. Findings are sorted by (severity, code, id). Two runs over the
 *     same grammar produce byte-identical JSON, so a diagnosis can be committed as a
 *     snapshot and diffed.
 *  3. FAILS CLOSED. An analysis that could not run is NOT a pass. `unanalysable` stays
 *     authoritative (see `GatingReport.unanalysable`), it is a BLOCKING finding, and a
 *     diagnosis whose analysis THREW is reported as a blocking finding rather than as
 *     an empty, clean-looking report.
 *  4. ONE ENTRY POINT. It accepts a combinator, a rule-name→combinator map, a `rules()`
 *     map, or a `compose()` result, and figures out which it got. Choosing between
 *     `analyzeGating` / `analyzeGatingRules` / `analyzeGrammarGating` is exactly the
 *     kind of decision that makes people not bother.
 */
import type { Combinator } from '../types.ts'
import {
  analyzeGating, analyzeGatingRules, firstSetToString,
  type AnalyzeGatingOptions, type GatingReport,
} from './gating.ts'
import { analyzeGrammarGating, type AnalysableGrammar } from './grammar.ts'
import {
  beginDegradationCapture, degradationCaptureDepth, unwindDegradationCapture,
  formatDegradation, type Degradation,
} from '../compiler/degradation.ts'

/** Anything `diagnoseGrammar()` knows how to read. */
export type DiagnosableGrammar =
  | Combinator<unknown>
  | AnalysableGrammar
  | ReadonlyArray<readonly [string, Combinator<unknown>]>

/**
 * `blocking` fails `ok` (and therefore a CI gate). `advisory` is reported but does not
 * fail: the author either already acknowledged it (`accepted`) or has nothing to act on.
 */
export type DiagnosisSeverity = 'blocking' | 'advisory'

/** Stable, greppable finding class. New codes may be added; existing ones are not renamed. */
export type DiagnosisCode =
  /** A hot choice with no first-char dispatch — every position enters doomed arms. */
  | 'ungated-choice'
  /** An API-misuse pattern in a choice's arms (double-not, leading-not, keyword-regex). */
  | 'anti-pattern'
  /** Part of the grammar could not be examined. A clean report over it is NOT a pass. */
  | 'unanalysable'
  /** The compiler took a correct-but-slower path. Mirrors the `[parseman] degraded` channel. */
  | 'degraded'
  /** An `accept` entry that matched no ungated choice — a stale snapshot line to prune. */
  | 'stale-accept'

export type DiagnosisFinding = {
  /** Stable identity: the choice id, `rule#arm`, the rule name, or the degradation code. */
  id: string
  code: DiagnosisCode
  severity: DiagnosisSeverity
  /** Rule / node type the finding lands on. */
  rule: string
  /** One-line statement of what is wrong. */
  message: string
  /** Arm-level evidence and concrete fixes, one entry per contributing cause. */
  details: string[]
  /** The `accept` snapshot key that would silence this finding, when one exists. */
  acceptKey?: string
}

export type GrammarDiagnosis = {
  /** Versioned so a committed snapshot can be migrated rather than silently reinterpreted. */
  schema: 'parseman.diagnosis/1'
  /**
   * True only when there is no blocking finding. A CI gate is
   * `process.exit(diagnoseGrammar(g).ok ? 0 : 1)` — nothing else to remember.
   */
  ok: boolean
  summary: {
    totalChoices: number
    gated: number
    recoverable: number
    ungated: number
    accepted: number
    deferred: number
    antiPatterns: number
    unanalysable: number
    degraded: number
    staleAccepts: number
  }
  /** Sorted (severity, code, id). Deterministic across runs. */
  findings: DiagnosisFinding[]
  /**
   * Every blocking-choice id, sorted — paste straight into `{ accept: [...] }` to
   * acknowledge the current state as intentional.
   */
  acceptSnapshot: string[]
  /** The full underlying gating report, for callers that want the raw per-choice detail. */
  gating: GatingReport
  /**
   * Degradations recorded WHILE this analysis ran (e.g. an opaque composed artifact).
   * NOT the compile-time set — compiling is a separate act; see `PARSEMAN_DEGRADATION`.
   *
   * Empty when `PARSEMAN_DEGRADATION=off`, because `recordDegradation` short-circuits on
   * the level. That is not a blind spot: everything this analysis can record is ALSO
   * present in `gating.unanalysable`, which no env var can switch off.
   */
  degradations: Degradation[]
}

export type DiagnoseOptions = Pick<AnalyzeGatingOptions, 'accept' | 'entryName'>

const isCombinator = (g: DiagnosableGrammar): g is Combinator<unknown> =>
  typeof g === 'object' && g !== null && '_def' in (g as object)

const isRuleEntries = (g: DiagnosableGrammar): g is ReadonlyArray<readonly [string, Combinator<unknown>]> =>
  Array.isArray(g)

/**
 * Diagnose a grammar. Never throws: an analysis that cannot run is reported as a
 * blocking `unanalysable` finding, because a thrown diagnostic and a clean grammar
 * must not look the same to a caller that wrapped this in a try/catch.
 */
export function diagnoseGrammar(grammar: DiagnosableGrammar, opts?: DiagnoseOptions): GrammarDiagnosis {
  // Collect rather than print/throw. `analyzeGrammarGating` records an `opaque-artifact`
  // degradation, and with no sink open `PARSEMAN_DEGRADATION=error` makes that THROW —
  // a deliberate diagnostic must report that fact, not die of it. The depth/unwind pair
  // (not a bare begin/end) is what keeps an analysis that throws from leaving the sink
  // open for the rest of the process.
  const depth = degradationCaptureDepth()
  beginDegradationCapture()
  let report: GatingReport
  let degradations: Degradation[]
  try {
    report = runAnalysis(grammar, opts)
  }
  catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    report = emptyReport(`gating analysis threw — ${reason}`)
  }
  finally {
    degradations = unwindDegradationCapture(depth)
  }
  return assemble(report, degradations)
}

/**
 * The analysis examined NOTHING: no choice was walked, and rules were skipped.
 *
 * This is NOT "problems were found" and must never be presented as a finding count. A
 * diagnosis over a fully opaque grammar has one blocking finding per skipped rule, which
 * `findings.length` then reports as "176 problems, 176 failing the check" — a sentence
 * that reads as 176 discovered defects and actually means the tool inspected zero
 * choices. `ok` is correctly false either way, so `ok` alone cannot tell the two apart;
 * a caller that needs to distinguish "measured, and it is bad" from "could not measure"
 * asks here. The CLI maps this to exit 2 (COULD NOT ANALYSE), not exit 1.
 *
 * `unanalysable > 0` is required, so a genuinely choice-free grammar (nothing to walk,
 * nothing skipped) stays an ordinary clean pass rather than a measurement failure.
 */
export function examinedNothing(d: GrammarDiagnosis): boolean {
  return d.summary.totalChoices === 0 && d.summary.unanalysable > 0
}

/** Render a diagnosis for a human. The structured object stays the product of record. */
export function formatGrammarDiagnosis(d: GrammarDiagnosis): string[] {
  const s = d.summary
  const lines: string[] = []
  lines.push(
    examinedNothing(d)
      // NOT a finding count. See `examinedNothing`.
      ? `parseman: COULD NOT ANALYSE — 0 choice(s) examined; ${s.unanalysable} rule(s) `
        + 'unreadable. No verdict about this grammar is available, good or bad.'
      : d.ok
        ? `parseman: grammar OK — ${s.gated}/${s.totalChoices} choice(s) gate on first char`
          + `${s.recoverable > 0 ? `, ${s.recoverable} recoverable` : ''}`
          + `${s.accepted > 0 ? `, ${s.accepted} accepted` : ''}`
          + `${s.deferred > 0 ? `, ${s.deferred} deferred to the fusing artifact` : ''}.`
        : `parseman: grammar NOT OK — ${blockingOf(d).length - s.unanalysable} blocking finding(s) over `
          + `${s.totalChoices} examined choice(s).`,
  )
  // Unanalysable first, always: "no findings" over a grammar that was never walked is
  // precisely the failure being reported, and it must not read as a clean bill of health.
  if (s.unanalysable > 0 && !examinedNothing(d)) {
    lines.push(
      `  ${s.unanalysable} rule(s) UNANALYSABLE — THIS REPORT IS PARTIAL. `
      + 'An empty finding list below does NOT mean the grammar is clean.',
    )
  }
  for (const f of d.findings) {
    lines.push(`${f.severity === 'blocking' ? '✗' : '·'} [${f.code}] ${f.id}: ${f.message}`)
    for (const detail of f.details) lines.push(`    ${detail.replace(/\n/g, '\n    ')}`)
    if (f.acceptKey !== undefined) {
      lines.push(`    intentional? add to the gating snapshot: { accept: ['${f.acceptKey}'] }`)
    }
  }
  if (!d.ok && d.acceptSnapshot.length > 0) {
    lines.push(`  accept-all snapshot: { accept: [${d.acceptSnapshot.map(i => `'${i}'`).join(', ')}] }`)
  }
  return lines
}

// ── internals ──

function runAnalysis(grammar: DiagnosableGrammar, opts?: DiagnoseOptions): GatingReport {
  if (isCombinator(grammar)) return analyzeGating(grammar, opts)
  if (isRuleEntries(grammar)) return analyzeGatingRules(grammar, opts)
  // A `rules()` map or a `compose()` result. `analyzeGrammarGating` recovers the carried
  // IR of a composed grammar (whose fused map holds rule FUNCTIONS, not combinators) and
  // re-asks every deferred question with the holes bound — the fuse-time analysis that
  // used to run implicitly inside `compose()`.
  return analyzeGrammarGating(grammar as AnalysableGrammar, opts)
}

function emptyReport(reason: string): GatingReport {
  return {
    totalChoices: 0, gated: 0, recoverable: 0,
    unanalysable: [{ rule: '<whole grammar>', kind: 'not-a-combinator', reason }],
    ungated: [], accepted: [], deferred: [], acceptedUnused: [], choices: [], antiPatterns: [],
  }
}

const blockingOf = (d: GrammarDiagnosis): DiagnosisFinding[] => d.findings.filter(f => f.severity === 'blocking')

/** Sort key order — blocking before advisory, then by code, then by id. */
const SEVERITY_RANK: Record<DiagnosisSeverity, number> = { blocking: 0, advisory: 1 }
const CODE_RANK: Record<DiagnosisCode, number> = {
  unanalysable: 0, 'ungated-choice': 1, 'anti-pattern': 2, degraded: 3, 'stale-accept': 4,
}

function assemble(report: GatingReport, degradations: Degradation[]): GrammarDiagnosis {
  const findings: DiagnosisFinding[] = []

  for (const u of report.unanalysable) {
    findings.push({
      id: u.rule, code: 'unanalysable', severity: 'blocking', rule: u.rule,
      message: `could not be examined [${u.kind}] — no verdict about it is available`,
      details: [u.reason],
    })
  }
  for (const c of report.ungated) {
    findings.push({
      id: c.id, code: 'ungated-choice', severity: 'blocking', rule: c.rule,
      message: `choice is UNGATED [${c.strategy}] — no first-char dispatch; `
        + 'every position speculatively enters doomed arms',
      details: [
        ...c.anyArms.map(a => `arm[${a.index}] first-set ANY (${a.cause}): ${a.detail}\nfix: ${a.suggestion}`),
        ...c.overlaps.map(o => `arm[${o.a}] ∩ arm[${o.b}] overlap on ${firstSetToString(o.on)}\nfix: ${o.suggestion}`),
      ],
      acceptKey: c.id,
    })
  }
  for (const ap of report.antiPatterns) {
    findings.push({
      id: `${ap.rule}#arm${ap.armIndex}`, code: 'anti-pattern', severity: 'blocking', rule: ap.rule,
      message: `[${ap.kind}] ${ap.message}`,
      details: [],
    })
  }
  for (const d of degradations) {
    findings.push({
      // `where` + `code` is the degradation channel's own identity; reuse it so the two
      // surfaces name the same thing the same way.
      id: `${d.code}@${d.where}`, code: 'degraded',
      // Mirrors `DegradationSeverity`: 'warn' is a real cost the author can remove,
      // 'info' is a fact they cannot act on (someone else's package).
      severity: d.severity === 'warn' ? 'blocking' : 'advisory',
      rule: d.where, message: formatDegradation(d), details: [],
    })
  }
  for (const id of report.acceptedUnused) {
    findings.push({
      id, code: 'stale-accept', severity: 'advisory', rule: id,
      message: 'accept entry matched no ungated choice — the grammar was fixed; prune this line',
      details: [],
    })
  }

  findings.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || CODE_RANK[a.code] - CODE_RANK[b.code]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    schema: 'parseman.diagnosis/1',
    ok: !findings.some(f => f.severity === 'blocking'),
    summary: {
      totalChoices: report.totalChoices,
      gated: report.gated,
      recoverable: report.recoverable,
      ungated: report.ungated.length,
      accepted: report.accepted.length,
      deferred: report.deferred.length,
      antiPatterns: report.antiPatterns.length,
      unanalysable: report.unanalysable.length,
      degraded: degradations.length,
      staleAccepts: report.acceptedUnused.length,
    },
    findings,
    acceptSnapshot: report.ungated.map(c => c.id).sort(),
    gating: report,
    degradations,
  }
}
