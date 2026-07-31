/**
 * CHOICE COST — the human layer.
 * ==============================
 *
 * Three layers, not two:
 *
 *   ANALYSIS   src/analysis/choice-cost.ts  — what the sites are and what they cost.
 *   POLICY     bench/choice-cost-guard.ts   — which of those numbers fail a build.
 *   RENDERING  this file                    — how a person reads either of them.
 *
 * The structured report is the source of truth. Nothing here computes a finding, and
 * nothing here decides pass or fail; a gate consumes the data and never this text. If
 * a number appears below that is not in the report, that is a bug in this file.
 *
 * WHAT A PARSER GENERATOR CAN SHOW THAT A COMPILER CANNOT
 * -------------------------------------------------------
 * A type error has one source to point at. A wasted-work finding has TWO, and relating
 * them is the whole diagnostic:
 *
 *   - the GRAMMAR site — the ordered choice whose arm ordering costs the time
 *   - the COST — measured, over a real corpus, per alternative
 *
 * So the ordering is printed WITH its measured cost beside each arm, which makes the
 * fix self-evident without a paragraph explaining it:
 *
 *   StylesheetAtRule › dispatch[0]              1.31 MB rescanned
 *     0  RoutedAtRuleStatement    failed 4,182 / 4,271     1.31 MB
 *     1  RoutedLayerBlock         matched 4,182
 *
 * Reading that, nobody needs to be told what to do.
 *
 * QUIET BY DEFAULT
 * ----------------
 * Nothing in this module prints. It returns strings. There is no console call and no
 * process-wide default-on channel, deliberately: importing `examples/css/parser.ts`
 * already emits roughly sixty lines of gating advice before any user code runs, and a
 * beautiful diagnostic that nobody reads because it is buried in build noise is not
 * beautiful. This one is available on request — from the CLI gate, or by calling it —
 * and silent otherwise.
 *
 * DETERMINISM BINDS THE RENDERING TOO
 * -----------------------------------
 * The rendering is diffable: it preserves the report's ordering, contains no timings,
 * no dates, no absolute paths, and colour is opt-in rather than auto-detected, so the
 * same report always renders to the same bytes. A renderer that sniffed `isTTY` would
 * produce two different outputs from one report and break exactly that.
 */

import type {
  ChoiceInventoryReport, ChoiceInventoryEntry, WastedWorkReport, ArmDeclineReason, SiteDeclineReason,
} from './choice-cost.ts'

export type RenderOptions = {
  /** Rows to show. Default 20. The report always holds all of them. */
  limit?: number
  /**
   * ANSI colour. Default false — NOT auto-detected from `isTTY`, because a renderer
   * whose bytes depend on where it is piped cannot be diffed or snapshotted.
   */
  color?: boolean
}

// ── formatting primitives ────────────────────────────────────────────────────

/** Deterministic thousands grouping. `toLocaleString()` is locale-dependent and would
 *  make the output differ between machines — the one thing a gateable rendering
 *  cannot do. */
export function groupDigits(n: number): string {
  const s = String(Math.trunc(Math.abs(n)))
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return (n < 0 ? '-' : '') + out
}

/** Byte counts at a glance. Binary units, fixed to one decimal, so 1,376,256 renders
 *  as `1.3 MB` on every machine. */
export function bytes(n: number): string {
  if (n < 1024) return `${groupDigits(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Written as \u001B escapes, never as raw ESC bytes. A raw control byte makes the
// whole file BINARY to git: `git diff --numstat` shows `- -`, GitHub declines to
// render it, and `grep -rn` skips it SILENTLY — no output and exit 0. Enforced by
// `pnpm check:control-bytes`.
const ESC = '\u001B'
const ANSI = {
  dim: `${ESC}[2m`, bold: `${ESC}[1m`, red: `${ESC}[31m`,
  yellow: `${ESC}[33m`, cyan: `${ESC}[36m`, reset: `${ESC}[0m`,
} as const

const paint = (on: boolean) => (code: keyof typeof ANSI, s: string): string =>
  on ? `${ANSI[code]}${s}${ANSI.reset}` : s

const pad = (s: string, w: number): string => s.length >= w ? s : s + ' '.repeat(w - s.length)
const padStart = (s: string, w: number): string => s.length >= w ? s : ' '.repeat(w - s.length) + s

// ── why a site declined, in one line each ────────────────────────────────────

/**
 * Every entry lands in exactly one of two states — ACTIONABLE (here is the rewrite) or
 * LOCATED (here is the site and the precise reason no rewrite can be offered). There
 * is no third "consider refactoring" state; a sentence of advice with no location and
 * no rewrite is what this table exists to replace.
 */
const ARM_DECLINE_LINE: Record<ArmDeclineReason, string> = {
  'not-a-sequence':
    'arm is not a sequence, so there is no leading term to lift out',
  'sequence-shorter-than-2':
    'arm is a one-term sequence; lifting its only term would leave an empty arm',
  'lead-case-insensitive-literal':
    'leading literal is case-insensitive, so the matched text can differ from the literal — a lifted prefix would carry the wrong string',
  'lead-not-concrete-terminal':
    'leading term is not a bare literal or regex; lifting it would change the arm’s value or capture shape',
}

const SITE_DECLINE_LINE: Record<SiteDeclineReason, string> = {
  'disjoint-dispatch':      'first-char dispatch already selects one arm — nothing is re-scanned',
  'gated-arms':             'an arm carries a runtime gate; per-arm predicates are incompatible with factoring',
  'strategy-preempted':     'a stronger non-backtracking strategy already applies',
  'fewer-than-two-arms':    'fewer than two arms',
  'arms-not-factorable':    'at least one arm cannot contribute a leading term (see below)',
  'leads-differ':           'the arms do not all begin with the same term',
}

/**
 * The combinator source a left-factoring would produce, ready to paste.
 *
 * Offered ONLY for the shape where it is mechanical and total: every arm of the choice
 * in one group. A partial group needs the author to decide which arms move and in what
 * order — an ordering decision that changes what the grammar accepts, which no
 * generated rewrite may make silently.
 *
 * This is a PREVIEW. It is not applied, and — until the digest-verification loop
 * described in `docs/` is wired — it is not yet proven behaviour-preserving, so it is
 * labelled a candidate rather than offered as a fix. An unverified rewrite presented
 * as verified is worse than no suggestion at all.
 */
export function leftFactorPreview(e: ChoiceInventoryEntry): string | null {
  if (e.factored) return null
  if (e.groups.length !== 1) return null
  const g = e.groups[0]!
  if (g.members.length !== e.arity) return null
  const tails = g.members.map(i => `sequence(…arm[${i}] tail…)`).join(',\n    ')
  return `sequence(\n  ${g.render === '' ? '<prefix>' : (g.render.startsWith('/') ? `regex(${g.render})` : `literal(${g.render})`)},\n  choice(\n    ${tails},\n  ),\n)`
}

// ── static inventory rendering ───────────────────────────────────────────────

export function renderChoiceInventory(r: ChoiceInventoryReport, opts: RenderOptions = {}): string {
  const c = paint(opts.color === true)
  const limit = opts.limit ?? 20
  const out: string[] = []

  out.push(c('bold', 'shared-prefix inventory'))
  out.push(c('dim', '  Static grammar shape only. A site listed here may already cost nothing at runtime:'))
  out.push(c('dim', '  compiled output gates each arm on its first character. Rank with profileWastedWork().'))
  out.push(`  ${groupDigits(r.rules)} rules, ${groupDigits(r.choiceSites)} choice sites`)
  out.push(`  ${groupDigits(r.factoredSites)} left-factored by the compiler`)
  out.push(`  ${groupDigits(r.backlogSites)} sites where alternatives share a leading term and the compiler DECLINED (${groupDigits(r.backlogArms)} arms)`)

  const backlog = r.entries
    .filter(e => !e.factored && e.groups.length > 0
      && e.declineReason !== 'disjoint-dispatch' && e.declineReason !== 'strategy-preempted')
    .sort((a, b) => b.unfactoredArms - a.unfactoredArms || (a.siteKey < b.siteKey ? -1 : 1))

  if (backlog.length === 0) {
    out.push('')
    out.push('  no declined shared prefixes.')
    return out.join('\n')
  }

  out.push('')
  for (const e of backlog.slice(0, limit)) {
    out.push(`  ${c('cyan', e.siteKey)}  ${c('dim', `${e.arity} arms · ${e.strategy}`)}`)
    for (const g of e.groups) {
      out.push(`    arms ${g.members.join(', ')} all begin with ${c('bold', g.render)}`)
    }
    out.push(`    ${c('yellow', 'declined')}: ${SITE_DECLINE_LINE[e.declineReason!]}`)
    for (const a of e.armDeclines) {
      out.push(`      arm[${a.arm}] — ${ARM_DECLINE_LINE[a.reason]}`)
    }
    const fix = leftFactorPreview(e)
    if (fix !== null) {
      out.push(`    ${c('dim', 'candidate rewrite (preview — not applied, not yet digest-verified):')}`)
      for (const line of fix.split('\n')) out.push(`      ${line}`)
    }
    out.push('')
  }
  if (backlog.length > limit) out.push(`  … and ${groupDigits(backlog.length - limit)} more (the report holds all of them)`)
  return out.join('\n')
}

// ── wasted-work rendering ────────────────────────────────────────────────────

/**
 * The ranked list, with each top site expanded into its arm ordering.
 *
 * The expansion is the point. A ranked list of site keys tells you WHERE; the arm
 * breakdown beside it tells you WHY, and "arm 0 failed 4,182 of 4,271 times" is an
 * argument for moving arm 0 that needs no prose attached.
 */
export function renderWastedWork(r: WastedWorkReport, opts: RenderOptions = {}): string {
  const c = paint(opts.color === true)
  const limit = opts.limit ?? 20
  const out: string[] = []
  const removed = r.arms.reduce((n, a) => n + (a.attempts - a.gatedAttempts), 0)
  const totalAttempts = r.arms.reduce((n, a) => n + a.attempts, 0)

  out.push(c('bold', 'wasted work — input bytes re-scanned after a failed alternative'))
  out.push(...interpretedBanner(c, removed, totalAttempts))
  out.push(`  corpus: ${groupDigits(r.corpusFiles)} files, ${bytes(r.corpusBytes)} (${groupDigits(r.parsedOk)} parsed, ${groupDigits(r.parsedFailed)} failed)`)
  out.push(`  sites:  ${groupDigits(r.instrumentedSites)} instrumented, ${groupDigits(r.uninstrumentableSites)} not instrumentable`)
  if (r.unresolvedRoots.length > 0) {
    out.push(`  ${c('yellow', 'PARTIAL')}: ${groupDigits(r.unresolvedRoots.length)} rule(s) could not be resolved and were NOT walked — the total below is a lower bound`)
  }
  out.push(`  total:  ${c('bold', bytes(r.totalGatedWastedBytes))} re-scanned` +
    (r.corpusBytes > 0 ? ` — ${(r.totalGatedWastedBytes / r.corpusBytes).toFixed(2)}x the corpus` : '') +
    (r.totalWastedBytes === r.totalGatedWastedBytes ? '' : `  (interpreted: ${bytes(r.totalWastedBytes)})`))

  const ranked = r.sites.filter(s => s.gatedWastedBytes > 0 || s.wastedBytes > 0)
  if (ranked.length === 0) {
    out.push('')
    out.push('  no alternative failed on this corpus.')
    return out.join('\n')
  }

  out.push('')
  out.push(c('dim', '  per arm: "entered" counts what the COMPILED parser reaches; the parenthesised'))
  out.push(c('dim', '  number is the interpreted count, shown only where the first-char gate differs.'))
  out.push('')
  const w = Math.min(52, Math.max(...ranked.slice(0, limit).map(s => s.siteKey.length)))
  for (const s of ranked.slice(0, limit)) {
    const share = r.totalGatedWastedBytes > 0 ? ` ${padStart((100 * s.gatedWastedBytes / r.totalGatedWastedBytes).toFixed(1) + '%', 7)}` : ''
    out.push(`  ${c('cyan', pad(s.siteKey.slice(0, w), w))} ${padStart(bytes(s.gatedWastedBytes), 10)}${c('dim', share)}`)
    const arms = r.arms.filter(a => a.siteKey === s.siteKey).sort((a, b) => a.arm - b.arm)
    for (const a of arms) {
      const entered = a.gatedAttempts === a.attempts
        ? groupDigits(a.attempts)
        : `${groupDigits(a.gatedAttempts)} (${groupDigits(a.attempts)} interp)`
      // A 100%-failure arm is the actionable shape, but only if the SHIPPED parser
      // enters it — so the verdict reads the gated columns.
      // PAD FIRST, PAINT SECOND. `pad` measures `s.length`, so padding a string that
      // already carries ANSI escapes spends the column width on invisible bytes and the
      // arm table loses its alignment in colour mode. Every other cell here does it in
      // this order; this one is not allowed to be the exception.
      const verdict: { text: string; color: 'dim' | 'red' | null } = a.gatedAttempts === 0
        ? { text: 'never entered when compiled', color: 'dim' }
        : a.gatedFailures === a.gatedAttempts
          ? { text: `failed ALL ${entered}`, color: 'red' }
          : a.gatedFailures === 0
            ? { text: `matched ${entered}`, color: 'dim' }
            : { text: `failed ${groupDigits(a.gatedFailures)} / ${entered}`, color: null }
      const cell = verdict.color === null ? pad(verdict.text, 34) : c(verdict.color, pad(verdict.text, 34))
      out.push(`    ${padStart(String(a.arm), 2)}  ${pad(a.label.slice(0, 30), 30)} ${cell} ${a.gatedWastedBytes > 0 ? padStart(bytes(a.gatedWastedBytes), 10) : ''}`)
    }
    out.push('')
  }
  if (ranked.length > limit) out.push(`  … and ${groupDigits(ranked.length - limit)} more sites (the report holds all of them)`)

  if (r.inversions.length > 0) {
    out.push(c('bold', '  ordering inversions — arm failed EVERY compiled entry while a later arm matched'))
    out.push(c('dim', '  ranked by entries, not bytes: an arm can fail 100% of the time and re-scan nothing.'))
    for (const a of r.inversions.slice(0, limit)) {
      out.push(`    ${c('cyan', pad(a.siteKey.slice(0, w), w))} arm ${padStart(String(a.arm), 2)}  ${pad(a.label.slice(0, 26), 26)} ${padStart(groupDigits(a.gatedAttempts), 8)} entries  ${a.gatedWastedBytes > 0 ? padStart(bytes(a.gatedWastedBytes), 10) : padStart('0 B', 10)}`)
    }
    if (r.inversions.length > limit) out.push(`    … and ${groupDigits(r.inversions.length - limit)} more`)
  }
  return out.join('\n')
}

/**
 * The interpreted-vs-compiled warning, on EVERY rendered report.
 *
 * Not a footnote and not a docs link. A consumer who reads only the ranking must be
 * told, in the ranking, that first-set gating — the largest parse lever this project
 * has — is modelled rather than measured, or they will chase arms codegen already
 * skips for free. The measured share of removed entries is included because "some
 * attempts are gated" is ignorable and "78% of them are" is not.
 */
function interpretedBanner(c: (k: 'dim' | 'bold' | 'red' | 'yellow' | 'cyan', s: string) => string, removed: number, total: number): string[] {
  const share = total > 0 ? ` — ${(100 * removed / total).toFixed(0)}% of interpreted arm entries` : ''
  return [
    c('yellow', '  MEASURED IN THE INTERPRETER. Compiled output gates each arm on its first'),
    c('yellow', `  character; ${groupDigits(removed)} entries below never happen in the shipped parser${share}.`),
    c('dim', '  Counts shown are the modelled COMPILED ones. Byte totals are unaffected by the'),
    c('dim', '  gate (a gated-out arm consumes nothing); entry counts and failure RATES are not.'),
  ]
}
