/**
 * CHOICE COST — the shape of an ordered choice, and what that shape costs.
 * ========================================================================
 *
 * A PEG `choice` is ordered: arm `i` is only reached once arms `0..i-1` have been
 * TRIED AND FAILED, and every one of those failures re-scanned input that the
 * winning arm then scans again. So each additional alternative, and each earlier
 * alternative, has a time cost — and that cost is invisible in the grammar source,
 * which is why grammar shape drifts without anything going red.
 *
 * This module makes it visible, in two halves that answer two different questions.
 *
 * STATIC — `analyzeChoiceInventory()`
 *   Which choice sites have alternatives that share a leading term, and for each:
 *   did the compiler LEFT-FACTOR it, or did it decline, and why? `detectSharedPrefix`
 *   (src/combinators/choice.ts) already computes this to decide whether to emit the
 *   `sharedPrefix` strategy, but it is ALL-OR-NOTHING (every arm must share) and it
 *   returns `null` on the first arm that does not qualify — silently, with no record
 *   of how close the site came or which arm blocked it. The inventory reports the
 *   declines, with the blocking arm and the reason. That set is the refactor backlog,
 *   GENERATED rather than noticed by a human reading grammar source.
 *
 *   It is complete, not sampled: every `choice` reachable from the rule map appears,
 *   including the ones with nothing to report (`groups: []`).
 *
 * DYNAMIC — `profileWastedWork()`
 *   How many BYTES were re-scanned because an alternative was tried and failed,
 *   attributed per choice site and per arm, over a real corpus. Ordering pathologies
 *   fall out of the ranking for free: an arm that fails 98% of the time while sitting
 *   first is exactly the top entry.
 *
 *   The static half can only see shape. It cannot know that one declined site is on
 *   the hot path of every stylesheet and another is reached twice a year. The dynamic
 *   half supplies that weight. Neither is sufficient alone.
 *
 * WHY BYTES, AND WHY THIS IS GATEABLE
 * -----------------------------------
 * The metric is a COUNT of input bytes, not a timing. It is a pure function of
 * (grammar, corpus): the same grammar over the same corpus yields the same number on
 * an idle machine and on a machine at load 10. There is no noise floor to argue about
 * and no rebaseline needed for a hardware change. That is what makes it usable as a
 * deterministic gate rather than a benchmark.
 *
 * INTERPRETED MODE ONLY
 * ---------------------
 * Nothing here is emitted into a compiled parser and nothing here costs codegen a
 * single byte or a single millisecond. The profiler does not add an instrumentation
 * flag to the hot combinators either — `src/combinators/choice.ts` is UNTOUCHED by
 * this file. Instrumentation is installed by temporarily substituting arm slots and
 * terminal `parse` methods on the combinator tree, and removed in a `finally`. When
 * you are not profiling, the cost is exactly zero because the shipping code contains
 * no profiling branch to skip.
 *
 * (For contrast: `run({ profile })` — the node/slot-count profiler — was compiled-path
 * only, was never implemented in the interpreter, and now throws rather than reporting
 * zeros. See src/functional/run.ts. This is a different measurement and a new build,
 * not a port of that one.)
 *
 * WHAT THIS INSTRUMENT CANNOT SEE
 * -------------------------------
 * Stated up front, because a diagnostic whose blind spots are undocumented gets read
 * as complete:
 *
 *   1. Only `firstMatch` and `sharedPrefix` choices are instrumented. Those are the
 *      two strategies that try arms in order and can fail one. A `disjoint` choice
 *      dispatches on the first character and tries exactly one arm; `greedyClassify`
 *      runs one regex; `literalsLongestFirst` captures its sorted arm array at
 *      construction, so slot substitution cannot reach it. Their sites still appear
 *      in the static inventory, with zero dynamic cost recorded and `instrumented:
 *      false` so the zero is not mistaken for a measurement.
 *   2. Backtracking that is not a choice arm — a failed `many` element, a failed
 *      `optional`, a rolled-back `attempt` — is not attributed. Those bytes are real
 *      but they are not an ORDERING decision, which is what this instrument exists to
 *      rank.
 *   3. An arm that SUCCEEDS and is then rejected by the `autoNot` check is recorded as
 *      a success, because the rejection happens inside the choice loop after the arm
 *      has returned. Its rescan is invisible here.
 *   4. `wastedBytes` is input bytes re-scanned, not CPU. An arm that fails after one
 *      byte but allocated on the way is cheap by this metric and not by the clock.
 *      This ranks ORDERING, and is deliberately not a profiler.
 *   5. Reach is measured by the furthest position at which a TERMINAL was attempted
 *      (`literal`/`regex`/`keywords`/`scanTo`). A combinator that consumes without
 *      going through one of those would under-report; none exists today.
 */

import type { Combinator, ParseContext, ParseResult, ParserDef } from '../types.ts'
import type { ChoiceStrategyTag } from './gating.ts'
import { run } from '../functional/run.ts'

// ── where a choice sits ──────────────────────────────────────────────────────

/** A combinator's location in the grammar: owning rule plus structural path. */
export type ChoiceSite = {
  /** Nearest enclosing `_ruleName`, or the rule-map key it was reached under. */
  rule: string
  /** Structural path inside that rule, e.g. `seq[2] › node(AtRule) › choice[0]`. */
  path: string
}

/** The stable identity of a site. Used as the sort key and the baseline key, so it
 *  must be derived only from grammar structure — never from a file path or a run. */
export const choiceSiteKey = (s: ChoiceSite): string =>
  s.path === '' ? s.rule : `${s.rule} › ${s.path}`

// ── static inventory ─────────────────────────────────────────────────────────

/** Why one ARM contributed no shareable leading term. */
export type ArmDeclineReason =
  /** The arm is not a (wrapper-peeled) `sequence` — e.g. a bare ref, a nested
   *  `choice`, an `optional`. `leadingTermOfArm` peels only node/grammar/transform/
   *  label, because those are the wrappers that consume nothing before the sequence. */
  | 'not-a-sequence'
  /** A `sequence` of one term: there is no residual to factor out from. */
  | 'sequence-shorter-than-2'
  /** The leading term is a case-INSENSITIVE literal. Excluded deliberately: the
   *  matched text differs from the literal's own value, so a replayed leaf would
   *  carry the wrong string. */
  | 'lead-case-insensitive-literal'
  /** The leading term is not a bare literal/regex — a ref, a node, a label, a
   *  transform, another choice. Factoring through it would change the value or
   *  capture shape of the arm. */
  | 'lead-not-concrete-terminal'

/** Why the SITE as a whole was not left-factored. */
export type SiteDeclineReason =
  /** First-char dispatch already selects exactly one arm; there is nothing to factor.
   *  Not a backlog entry — this is the good state. */
  | 'disjoint-dispatch'
  /** At least one arm carries a runtime gate; per-arm predicates are incompatible
   *  with the factoring strategies. */
  | 'gated-arms'
  /** `greedyClassify` or `literalsLongestFirst` matched first. Both are stronger than
   *  `sharedPrefix` (neither backtracks), so this is also not a backlog entry. */
  | 'strategy-preempted'
  /** Fewer than two arms. */
  | 'fewer-than-two-arms'
  /** At least one arm produced no shareable leading term. See `armDeclines` for which
   *  arm and why. THIS is the backlog: a subset of arms may still share a prefix that
   *  the all-or-nothing detector never records. */
  | 'arms-not-factorable'
  /** Every arm produced a leading term, but they are not all the same term. Also the
   *  backlog: two arms out of nine sharing `@` is real, repeated work. */
  | 'leads-differ'

/** A maximal set of arms at one site sharing an identical concrete leading term. */
export type PrefixGroup = {
  /** Structural key of the shared term. Injective by construction (JSON-encoded), so
   *  two structurally different regexes can never collide onto one group. */
  key: string
  /** Human rendering, e.g. `"@"` or `/[-\w]+/`. */
  render: string
  /** Arm indices, ascending. */
  members: readonly number[]
}

export type ChoiceInventoryEntry = {
  site: ChoiceSite
  siteKey: string
  arity: number
  strategy: ChoiceStrategyTag
  disjoint: boolean
  gated: boolean
  /** Every group of >= 2 arms sharing a concrete leading term, ordered by member
   *  count descending then key. Empty when no two arms share one. */
  groups: readonly PrefixGroup[]
  /** Per-arm reasons, ascending by arm index. Only arms that produced no key. */
  armDeclines: readonly { arm: number; reason: ArmDeclineReason; detail: string }[]
  factored: boolean
  /** Present iff `factored` is false. */
  declineReason?: SiteDeclineReason
  /** Arms that sit in some group but whose site was NOT factored — the count of
   *  alternatives currently re-scanning a prefix a sibling already scanned. */
  unfactoredArms: number
}

export type ChoiceInventoryReport = {
  readonly schema: 'parseman.choice-inventory/1'
  rules: number
  /** Distinct `choice` combinator instances reachable from the rule map. */
  choiceSites: number
  factoredSites: number
  /** Sites with >= 1 prefix group that were NOT factored. The backlog. */
  backlogSites: number
  backlogArms: number
  /**
   * Rule-map entries that are unresolvable references — a `g.X` hole that only
   * `compose()` binds. Their subtrees were NOT walked, so this report is partial by
   * exactly this much. Ascending. Empty is the only value that means "complete".
   */
  unresolvedRoots: readonly string[]
  /** Ascending by `siteKey`. Complete — every reachable choice, including the ones
   *  with nothing to report. */
  entries: readonly ChoiceInventoryEntry[]
}

// ── dynamic profile ──────────────────────────────────────────────────────────

export type WastedWorkArm = {
  siteKey: string
  site: ChoiceSite
  arm: number
  /** Short rendering of the arm's head, so the ranked list reads without opening
   *  the grammar. */
  label: string
  attempts: number
  failures: number
  /** Input bytes re-scanned by this arm's FAILED attempts, summed over the corpus.
   *  For one attempt: (furthest position a terminal was tried) - (entry position). */
  wastedBytes: number
}

export type WastedWorkSite = {
  siteKey: string
  site: ChoiceSite
  strategy: ChoiceStrategyTag
  arity: number
  /** False when the strategy cannot be instrumented; then `wastedBytes` is 0 because
   *  nothing was measured, NOT because nothing was wasted. */
  instrumented: boolean
  attempts: number
  failures: number
  wastedBytes: number
}

export type WastedWorkReport = {
  readonly schema: 'parseman.wasted-work/1'
  corpusFiles: number
  corpusBytes: number
  parsedOk: number
  parsedFailed: number
  /** Sites the profiler installed instrumentation on. */
  instrumentedSites: number
  /** Reachable choice sites whose strategy cannot be instrumented (see the module
   *  header, blind spot 1). Reported so a low total is not read as a clean grammar. */
  uninstrumentableSites: number
  /** Rule-map entries that are unresolvable references; their subtrees carry no
   *  instrumentation, so the total below is a LOWER BOUND by exactly this much. */
  unresolvedRoots: readonly string[]
  totalWastedBytes: number
  /** Descending by `wastedBytes`, then ascending by `siteKey`, then by `arm`. */
  arms: readonly WastedWorkArm[]
  /**
   * ORDERING INVERSIONS: arms that were attempted at least `inversionMinAttempts`
   * times and failed EVERY time, while a later arm at the same site matched.
   *
   * A second ranking, because bytes alone answer the wrong question for the clearest
   * class of defect. Measured on jess's CSS grammar: `StylesheetAtRule › dispatch[3]`
   * has arm 0 failing 19 of 19 attempts while arm 1 matches — an unambiguous ordering
   * bug — yet it is only the 14th largest site by bytes, because the prelude it
   * re-scans is short. Bytes rank what costs most; this ranks what is most obviously
   * WRONG. Both are in the report and neither is derived from the other.
   *
   * Descending by `wastedBytes`, then ascending by `siteKey`, then by `arm`.
   */
  inversions: readonly WastedWorkArm[]
  /** Descending by `wastedBytes`, then ascending by `siteKey`. */
  sites: readonly WastedWorkSite[]
}

// ── grammar walk ─────────────────────────────────────────────────────────────

/** Ordered structural children per def tag. `lazy` is a REFERENCE, not a subtree:
 *  descending through it would make every rule's walk cover the whole grammar and
 *  turn site paths into nonsense. */
function childrenOf(d: ParserDef): readonly Combinator<unknown>[] {
  switch (d.tag) {
    case 'sequence': case 'choice': return d.parsers
    case 'dispatch': return [
      d.selector,
      ...d.cases.map(c => c.parser),
      ...(d.otherwise === undefined ? [] : [d.otherwise]),
    ]
    case 'skip': return [d.main, d.skipped]
    case 'sepBy': return [d.parser, d.separator]
    case 'recover': return [d.parser, d.sentinel]
    case 'scanTo': return [d.sentinel, ...d.skip]
    case 'grammar': return d.triviaParser ? [d.parser, d.triviaParser] : [d.parser]
    case 'lazy': case 'literal': case 'regex': case 'keywords': case 'guard': case 'unknown':
      return []
    default: {
      const rec = d as unknown as { parser?: Combinator<unknown> }
      return rec.parser ? [rec.parser] : []
    }
  }
}

const ruleNameOf = (p: Combinator<unknown>): string | undefined =>
  (p as unknown as { _ruleName?: string })._ruleName

/** The path segment contributed by one step down. Names the SLOT, not the child, so
 *  a path stays stable when a child is replaced by an equivalent one. */
function slotLabel(d: ParserDef, index: number): string {
  switch (d.tag) {
    case 'sequence': return `seq[${index}]`
    case 'choice':   return `choice[${index}]`
    case 'dispatch': return index === 0 ? 'dispatch.selector' : `dispatch[${index - 1}]`
    case 'skip':     return index === 0 ? 'skip.main' : 'skip.skipped'
    case 'sepBy':    return index === 0 ? 'sepBy.item' : 'sepBy.sep'
    case 'recover':  return index === 0 ? 'recover.parser' : 'recover.sentinel'
    case 'scanTo':   return index === 0 ? 'scanTo.sentinel' : `scanTo.skip[${index - 1}]`
    case 'grammar':  return index === 0 ? 'grammar' : 'grammar.trivia'
    case 'node':     return `node(${d.type ?? 'anonymous'})`
    case 'label':    return `label(${d.label})`
    case 'field':    return `field(${d.name})`
    default:         return d.tag
  }
}

type Walked = { p: Combinator<unknown>; d: ParserDef; site: ChoiceSite }

/**
 * A rule-map VALUE may be a reference rather than a definition.
 *
 * `rules()` hands its factory a proxy that mints a `ref()` placeholder on first touch
 * (src/combinators/parser.ts:145-158), so a rule mentioned before it is defined —
 * or defined in a DIFFERENT composed piece — sits in the map as an undefined `lazy`.
 * Measured on jess's CSS grammar: 124 of 176 rule-map entries are such references.
 *
 * A walker that treats those as leaves therefore sees about a third of the grammar
 * and reports a small, clean-looking number — the exact silent-partial failure this
 * module refuses everywhere else. So a ROOT lazy is followed once, to the definition
 * it names. INTERIOR lazies are still leaves: following those would make every rule's
 * walk cover the whole reachable grammar and turn site paths into nonsense.
 *
 * A root reference that cannot resolve (a cross-piece hole that only `compose()`
 * binds) is returned as unresolved and COUNTED, never skipped quietly.
 */
function resolveRoot(p: Combinator<unknown>): { ok: true; p: Combinator<unknown> } | { ok: false } {
  let cur = p
  for (let hop = 0; hop < 8; hop++) {
    const d = cur._def as ParserDef
    if (d.tag !== 'lazy') return { ok: true, p: cur }
    let next: Combinator<unknown>
    try { next = d.thunk() } catch { return { ok: false } }
    if (next === cur) return { ok: false }
    cur = next
  }
  return { ok: false }
}

/**
 * One entry per distinct combinator INSTANCE, in deterministic pre-order.
 *
 * Rule-map order is the caller's array order, and within a rule the walk is the
 * declared child order — no `Map`/`Set` iteration and no filesystem order anywhere,
 * so the same rule map always produces the same sequence of sites.
 *
 * `assertAnalysable` first: the value `compose()`/`composeLeaf()` returns is a fused
 * artifact of parse FUNCTIONS with no `_def` to walk. Handed one of those, a walker
 * that shrugged would report zero sites — a tool's inability wearing the costume of
 * a clean result. That is the one outcome this module never produces.
 */
function walkRules(ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>): { walked: Walked[]; unresolvedRoots: string[] } {
  assertAnalysable(ruleMap)
  const out: Walked[] = []
  const seen = new Set<Combinator<unknown>>()
  const unresolvedRoots: string[] = []

  const visit = (p: Combinator<unknown>, rule: string, path: string): void => {
    if (seen.has(p)) return
    seen.add(p)
    const d = p._def as ParserDef
    const own = ruleNameOf(p)
    const here: ChoiceSite = own !== undefined && own !== rule ? { rule: own, path: '' } : { rule, path }
    out.push({ p, d, site: here })
    const kids = childrenOf(d)
    for (let i = 0; i < kids.length; i++) {
      const seg = slotLabel(d, i)
      visit(kids[i]!, here.rule, here.path === '' ? seg : `${here.path} › ${seg}`)
    }
  }

  for (const [name, rule] of ruleMap) {
    const r = resolveRoot(rule)
    if (!r.ok) { unresolvedRoots.push(name); continue }
    visit(r.p, name, '')
  }
  unresolvedRoots.sort()
  return { walked: out, unresolvedRoots }
}

function assertAnalysable(ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>): void {
  if (ruleMap.length === 0) {
    throw new TypeError(
      'choice-cost: the rule map is EMPTY. Analysing nothing and reporting no findings is '
      + 'indistinguishable from analysing a clean grammar, so this is refused rather than '
      + 'answered. Pass the rules() map (or the map given to compileRuleMap/compileLinkable).',
    )
  }
  for (const [name, rule] of ruleMap) {
    const def = (rule as { _def?: unknown } | null | undefined)?._def
    if (def !== null && typeof def === 'object' && typeof (def as { tag?: unknown }).tag === 'string') continue
    throw new TypeError(
      `choice-cost: rule '${name}' is not a combinator (no _def). This analysis walks the `
      + 'COMBINATOR TREE; the value returned by compose()/composeLeaf() is a fused artifact whose '
      + 'entries are parse functions. Pass the rules() map itself instead.',
    )
  }
}

// ── leading-term analysis (mirrors src/combinators/choice.ts) ─────────────────

/**
 * Peel the wrappers that consume nothing before their inner sequence, then return
 * that sequence's FIRST term. Mirrors `leadingTermOfArm` in choice.ts, but reports
 * WHY it gave up instead of returning `null` — the reason is the whole point of the
 * inventory. Kept structurally parallel to the original on purpose: if the two ever
 * disagree the inventory would describe a grammar the compiler does not see.
 */
function leadingTermOfArm(arm: Combinator<unknown>): { term: Combinator<unknown> } | { reason: ArmDeclineReason; detail: string } {
  let d = arm._def as ParserDef
  for (;;) {
    if (d.tag === 'node' || d.tag === 'grammar' || d.tag === 'transform' || d.tag === 'label') {
      d = ((d as unknown as { parser: Combinator<unknown> }).parser)._def as ParserDef
      continue
    }
    break
  }
  if (d.tag !== 'sequence') {
    return {
      reason: 'not-a-sequence',
      detail: `arm is \`${d.tag}\`; only node/grammar/transform/label wrappers are peeled, `
        + 'because they are the ones that consume nothing before the sequence',
    }
  }
  if (d.parsers.length < 2) {
    return { reason: 'sequence-shorter-than-2', detail: `sequence has ${d.parsers.length} term(s); nothing would remain after factoring` }
  }
  return { term: d.parsers[0]! }
}

/** Structural key of a bare leading terminal, or the reason it is not shareable.
 *  JSON-encoded rather than delimiter-joined: a collision would judge two different
 *  regexes identical, which is a correctness bug in a generated parser, not a missed
 *  optimisation. */
function leadingTermKey(term: Combinator<unknown>): { key: string; render: string } | { reason: ArmDeclineReason; detail: string } {
  const d = term._def as ParserDef
  if (d.tag === 'literal') {
    if (d.caseInsensitive) {
      return { reason: 'lead-case-insensitive-literal', detail: `literal ${JSON.stringify(d.value)} is case-insensitive; the matched text can differ from the literal's own value` }
    }
    return { key: `L:${JSON.stringify(d.value)}`, render: JSON.stringify(d.value) }
  }
  if (d.tag === 'regex') {
    return { key: `R:${JSON.stringify([d.source, d.flags])}`, render: `/${d.source}/${d.flags.replace(/[gy]/g, '')}` }
  }
  return {
    reason: 'lead-not-concrete-terminal',
    detail: `leading term is \`${d.tag}\`${d.tag === 'lazy' ? ` (ref${ruleNameOf(term) === undefined ? '' : ` to ${ruleNameOf(term)!}`})` : ''}; factoring through it would change the arm's value or capture shape`,
  }
}

/** A short, deterministic rendering of an arm's head, for the ranked list. */
export function armLabel(arm: Combinator<unknown>): string {
  const name = ruleNameOf(arm)
  if (name !== undefined) return name
  let d = arm._def as ParserDef
  for (let hop = 0; hop < 8; hop++) {
    if (d.tag === 'node' && d.type !== undefined) return `node(${d.type})`
    if (d.tag === 'label') return `label(${d.label})`
    if (d.tag === 'field') return `field(${d.name})`
    if (d.tag === 'literal') return JSON.stringify(d.value)
    if (d.tag === 'regex') return `/${d.source}/`
    if (d.tag === 'keywords') return `keywords(${d.words.length})`
    if (d.tag === 'sequence' || d.tag === 'choice') {
      const first = d.parsers[0]
      if (first === undefined) return d.tag
      const inner = ruleNameOf(first)
      if (inner !== undefined) return `${d.tag}(${inner}, …)`
      d = first._def as ParserDef
      continue
    }
    const rec = d as unknown as { parser?: Combinator<unknown> }
    if (rec.parser === undefined) return d.tag
    d = rec.parser._def as ParserDef
  }
  return (arm._def as ParserDef).tag
}

// ── HALF 1: static inventory ─────────────────────────────────────────────────

/**
 * Every `choice` reachable from `ruleMap`, with its shared-prefix groups and whether
 * the compiler factored the site.
 *
 * Complete by construction: the walk visits every reachable combinator instance and
 * emits an entry for each `choice`, whether or not it has anything to report. A site
 * missing from this report is a site the walk could not reach, never a site that was
 * judged uninteresting.
 */
export function analyzeChoiceInventory(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): ChoiceInventoryReport {
  const { walked, unresolvedRoots } = walkRules(ruleMap)
  const entries: ChoiceInventoryEntry[] = []

  for (const w of walked) {
    if (w.d.tag !== 'choice') continue
    const d = w.d
    const arity = d.parsers.length
    const strategy = d.strategy.tag as ChoiceStrategyTag
    const gated = d.gates.some(g => g !== null)

    // Group arms by their leading term. The compiler's detector returns null on the
    // FIRST arm that does not qualify; this keeps going, so a partial group — the
    // case the detector cannot represent at all — is recorded instead of lost.
    const byKey = new Map<string, { render: string; members: number[] }>()
    const armDeclines: { arm: number; reason: ArmDeclineReason; detail: string }[] = []
    for (let i = 0; i < arity; i++) {
      const lead = leadingTermOfArm(d.parsers[i]!)
      if ('reason' in lead) { armDeclines.push({ arm: i, reason: lead.reason, detail: lead.detail }); continue }
      const keyed = leadingTermKey(lead.term)
      if ('reason' in keyed) { armDeclines.push({ arm: i, reason: keyed.reason, detail: keyed.detail }); continue }
      const slot = byKey.get(keyed.key)
      if (slot === undefined) byKey.set(keyed.key, { render: keyed.render, members: [i] })
      else slot.members.push(i)
    }

    const groups: PrefixGroup[] = [...byKey.entries()]
      .filter(([, v]) => v.members.length >= 2)
      .map(([key, v]) => ({ key, render: v.render, members: v.members }))
      // Explicit sort: Map insertion order is walk order, which is deterministic,
      // but relying on it would make a later walk change reorder the report.
      .sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

    const factored = strategy === 'sharedPrefix'
    let declineReason: SiteDeclineReason | undefined
    if (!factored) {
      declineReason =
          arity < 2                        ? 'fewer-than-two-arms'
        : d.disjoint                       ? 'disjoint-dispatch'
        : gated                            ? 'gated-arms'
        : strategy !== 'firstMatch'        ? 'strategy-preempted'
        : armDeclines.length > 0           ? 'arms-not-factorable'
        :                                    'leads-differ'
    }

    const inGroups = new Set<number>()
    for (const g of groups) for (const m of g.members) inGroups.add(m)

    entries.push({
      site: w.site,
      siteKey: choiceSiteKey(w.site),
      arity,
      strategy,
      disjoint: d.disjoint,
      gated,
      groups,
      armDeclines,
      factored,
      ...(declineReason === undefined ? {} : { declineReason }),
      unfactoredArms: factored ? 0 : inGroups.size,
    })
  }

  entries.sort((a, b) => (a.siteKey < b.siteKey ? -1 : a.siteKey > b.siteKey ? 1 : 0))

  // A site whose decline reason is `disjoint-dispatch` or `strategy-preempted` is
  // NOT backlog: first-char dispatch and the two literal strategies already avoid
  // the re-scan. Counting them would inflate the backlog with sites that are
  // already in the good state.
  const backlog = entries.filter(e =>
    !e.factored && e.groups.length > 0
    && e.declineReason !== 'disjoint-dispatch' && e.declineReason !== 'strategy-preempted')

  return {
    schema: 'parseman.choice-inventory/1',
    rules: ruleMap.length,
    choiceSites: entries.length,
    factoredSites: entries.filter(e => e.factored).length,
    backlogSites: backlog.length,
    backlogArms: backlog.reduce((n, e) => n + e.unfactoredArms, 0),
    unresolvedRoots,
    entries,
  }
}

// ── HALF 2: corpus-driven wasted work ────────────────────────────────────────

/** Terminal tags. Reaching input position `q` means a terminal was ATTEMPTED at `q`,
 *  so bumping a high-water mark on terminal entry captures an attempt's furthest
 *  reach without inspecting any result. */
const TERMINAL_TAGS = new Set<ParserDef['tag']>(['literal', 'regex', 'keywords', 'scanTo'])

/** Strategies whose arms are tried in order through `def.parsers`, which is the same
 *  array object the choice's closure reads at call time — so substituting a slot
 *  installs instrumentation with no change to choice.ts and no flag on its hot path.
 *  `literalsLongestFirst` is excluded because it captures its sorted arm array at
 *  CONSTRUCTION time; a substituted slot would never be read, and instrumentation
 *  that silently does nothing is worse than none. */
const INSTRUMENTABLE = new Set<string>(['firstMatch', 'sharedPrefix'])

export type WastedWorkCorpusEntry = {
  /** Stable identifier. Use a repo-relative path, never an absolute one — it appears
   *  in the report, and an absolute path would make the report machine-dependent. */
  id: string
  text: string
}

export type ProfileWastedWorkOptions = {
  /** The combinator rule map, for site naming and instrumentation. */
  rules: ReadonlyArray<readonly [string, Combinator<unknown>]>
  /** The rule to start each parse at. A key of `rules`, or a combinator. */
  entry: string | Combinator<unknown>
  corpus: ReadonlyArray<WastedWorkCorpusEntry>
  /** Passed through to `run()`. Must not contain anything machine-dependent. */
  runOptions?: Record<string, unknown>
  /**
   * How to parse one corpus entry. Defaults to `run()` in interpreted mode.
   *
   * Overridable because a grammar can need a driver of its own — jess's Less dialect,
   * for instance, requires `state: { source: input }` because its reducers read it —
   * and because a caller who has already built a driver should not have to duplicate
   * it here. It must be a plain interpreted parse; anything compiled defeats the
   * instrumentation silently, since a compiled artifact never reads `def.parsers`.
   */
  runner?: (entry: Combinator<unknown>, input: string, options: Record<string, unknown>) => { ok: boolean }
  /** Minimum attempts before an always-failing arm counts as an ordering inversion.
   *  Default 4 — below that, "failed every time" is a sample size, not a finding. */
  inversionMinAttempts?: number
}

type ArmRecord = {
  site: ChoiceSite
  siteKey: string
  arm: number
  label: string
  attempts: number
  failures: number
  wastedBytes: number
}

/**
 * Parse `corpus` with `rules` in INTERPRETED mode, counting input bytes re-scanned
 * by failed choice alternatives.
 *
 * Fails closed on every way of measuring nothing: an empty rule map, an unknown entry
 * rule, an empty corpus, an empty corpus file, or a grammar in which no instrumentable
 * choice site exists. Each of those would otherwise produce a report of zero wasted
 * bytes, which reads as a clean grammar.
 */
export function profileWastedWork(opts: ProfileWastedWorkOptions): WastedWorkReport {
  const { rules, corpus } = opts
  const { walked, unresolvedRoots } = walkRules(rules)

  const entryParser = typeof opts.entry === 'string'
    ? rules.find(([n]) => n === opts.entry)?.[1]
    : opts.entry
  if (entryParser === undefined) {
    throw new TypeError(
      `choice-cost: entry rule '${String(opts.entry)}' is not in the rule map `
      + `(have: ${rules.map(([n]) => n).slice(0, 12).join(', ')}${rules.length > 12 ? ', …' : ''}).`,
    )
  }
  if (corpus.length === 0) {
    throw new TypeError('choice-cost: the corpus is EMPTY. A profile over no input measures nothing; refusing to report zero wasted bytes as a result.')
  }
  for (const f of corpus) {
    if (f.text.length === 0) throw new TypeError(`choice-cost: corpus entry '${f.id}' is EMPTY.`)
  }

  // ── install ────────────────────────────────────────────────────────────────
  // Two substitutions, both reverted in the `finally`:
  //   arms      — `def.parsers[i]` is replaced by a delegating combinator that carries
  //               its own (site, index). Identity by SLOT, not by object, so an arm
  //               subtree shared between two sites is attributed to the right one.
  //   terminals — `parse` is replaced in place, because a terminal can sit in a
  //               single-child slot (`node.parser`) that the wrapper captured as a
  //               closure local and would never re-read from the def.
  let highWater = 0
  const armRecords: ArmRecord[] = []
  const siteTotals = new Map<string, WastedWorkSite>()
  const restore: (() => void)[] = []

  let instrumentedSites = 0
  let uninstrumentableSites = 0

  for (const w of walked) {
    if (w.d.tag !== 'choice') continue
    const siteKey = choiceSiteKey(w.site)
    const strategy = w.d.strategy.tag as ChoiceStrategyTag
    const canInstrument = INSTRUMENTABLE.has(strategy) && !w.d.disjoint
    const rec: WastedWorkSite = {
      siteKey, site: w.site, strategy, arity: w.d.parsers.length,
      instrumented: canInstrument, attempts: 0, failures: 0, wastedBytes: 0,
    }
    // Two distinct choice INSTANCES can walk to the same site key only if the same
    // slot were visited twice, which `seen` prevents. Keep the first and count the
    // second as uninstrumentable rather than silently merging their numbers.
    if (siteTotals.has(siteKey)) { uninstrumentableSites++; continue }
    siteTotals.set(siteKey, rec)
    if (!canInstrument) { uninstrumentableSites++; continue }
    instrumentedSites++

    const slots = w.d.parsers
    for (let i = 0; i < slots.length; i++) {
      const original = slots[i]!
      const armRec: ArmRecord = {
        site: w.site, siteKey, arm: i, label: armLabel(original),
        attempts: 0, failures: 0, wastedBytes: 0,
      }
      armRecords.push(armRec)
      const wrapper: Combinator<unknown> = {
        _tag: original._tag,
        _meta: original._meta,
        _def: original._def,
        parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown> {
          const saved = highWater
          highWater = pos
          const r = original.parse(input, pos, ctx)
          const reach = highWater
          highWater = saved > reach ? saved : reach
          armRec.attempts++
          rec.attempts++
          if (!r.ok) {
            armRec.failures++
            rec.failures++
            const wasted = reach - pos
            if (wasted > 0) { armRec.wastedBytes += wasted; rec.wastedBytes += wasted }
          }
          return r
        },
      } as Combinator<unknown>
      // `_ruleName` is read by site naming and by `deriveExpected`; carry it across so
      // the substituted slot is indistinguishable from the original to everything but
      // the counter.
      const rn = ruleNameOf(original)
      if (rn !== undefined) (wrapper as unknown as { _ruleName?: string })._ruleName = rn
      slots[i] = wrapper
      restore.push(() => { slots[i] = original })
    }
  }

  if (instrumentedSites === 0) {
    for (const undo of restore) undo()
    throw new TypeError(
      'choice-cost: the grammar contains NO instrumentable choice site (no `firstMatch` or '
      + '`sharedPrefix` choice). A wasted-work profile over it would report zero for a reason '
      + 'that has nothing to do with the grammar being efficient, so it is refused.',
    )
  }

  for (const w of walked) {
    if (!TERMINAL_TAGS.has(w.d.tag)) continue
    const p = w.p as { parse: Combinator<unknown>['parse'] }
    const original = p.parse
    p.parse = ((input: string, pos: number, ctx: ParseContext) => {
      if (pos > highWater) highWater = pos
      return original.call(w.p as never, input, pos, ctx)
    }) as Combinator<unknown>['parse']
    restore.push(() => { p.parse = original })
  }

  // ── run ────────────────────────────────────────────────────────────────────
  let parsedOk = 0
  let parsedFailed = 0
  let corpusBytes = 0
  try {
    const runner = opts.runner ?? ((e, input, options) => run(e, input, options))
    for (const f of corpus) {
      corpusBytes += f.text.length
      highWater = 0
      const r = runner(entryParser, f.text, opts.runOptions ?? {})
      if (r.ok) parsedOk++
      else parsedFailed++
    }
  } finally {
    // LIFO: terminal `parse` patches were pushed after the slot substitutions, and a
    // terminal that also sits in a substituted slot must be unpatched before the slot
    // is restored, or the original object would be handed back still wearing a patch.
    for (let i = restore.length - 1; i >= 0; i--) restore[i]!()
  }

  const arms = armRecords
    .filter(a => a.attempts > 0)
    .map(a => ({ siteKey: a.siteKey, site: a.site, arm: a.arm, label: a.label, attempts: a.attempts, failures: a.failures, wastedBytes: a.wastedBytes }))
    .sort((x, y) => y.wastedBytes - x.wastedBytes
      || (x.siteKey < y.siteKey ? -1 : x.siteKey > y.siteKey ? 1 : 0)
      || x.arm - y.arm)

  const sites = [...siteTotals.values()]
    .sort((x, y) => y.wastedBytes - x.wastedBytes || (x.siteKey < y.siteKey ? -1 : x.siteKey > y.siteKey ? 1 : 0))

  // "A later arm matched" is what separates an inversion from an arm that is simply
  // never the right answer for this corpus. Without it, the last arm of every choice —
  // which fails whenever the whole choice fails — would head the list.
  const minAttempts = opts.inversionMinAttempts ?? 4
  const inversions = arms.filter(a =>
    a.attempts >= minAttempts && a.failures === a.attempts
    && arms.some(b => b.siteKey === a.siteKey && b.arm > a.arm && b.attempts > b.failures))

  return {
    schema: 'parseman.wasted-work/1',
    corpusFiles: corpus.length,
    corpusBytes,
    parsedOk,
    parsedFailed,
    instrumentedSites,
    uninstrumentableSites,
    unresolvedRoots,
    totalWastedBytes: sites.reduce((n, s) => n + s.wastedBytes, 0),
    arms,
    inversions,
    sites,
  }
}
