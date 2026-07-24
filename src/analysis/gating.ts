/**
 * Static first-char gating diagnostic.
 *
 * Parseman is scannerless PEG: a `choice` is CORRECT regardless of whether it
 * first-char-gates. When a hot choice fails to gate, every non-matching input
 * position speculatively ENTERS a doomed arm (ctx save/restore + child array +
 * recognizer + rollback) instead of being skipped by a cheap first-char test —
 * and nothing tells the author, because the grammar still passes every test. The
 * only symptom is a CPU profile. This module surfaces, at build time, exactly what
 * the compiler already knows: which choices gate, and for those that don't, which
 * arm poisons dispatch and why.
 *
 * `analyzeGating()` is the pure programmatic surface. `compile()` runs it by
 * default and emits `formatGatingWarnings()` output for genuinely-ungated choices
 * (see `src/compiler/codegen.ts`). Accept a deliberately-ungated choice by listing
 * its `id` in the gating snapshot allowlist (`analyzeGating(entry, { accept })` /
 * `compile(g, { gating: { level, accept } })`) — the single suppression mechanism.
 *
 * WHERE the question is asked matters as much as the answer. A SHARED SHAPE — a
 * `rules()` map referencing a rule it doesn't define (`g.Value`) — has no verdict of
 * its own: the hole makes every first-set through it `any`, but that configuration is
 * never executed and its author cannot fix it. Such a choice is `deferred` here, and
 * re-asked with `resolveRef` at the site that BINDS the name (`runFusedGatingDiagnostic`
 * in codegen.ts) — the artifact that really runs, whose author really can fix it.
 */
import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, matchesEmpty, type RefResolver } from '../combinators/first-set.ts'

/** Why an arm's (deep) first-set is `any` / over-broad — the poison source. */
export type FirstSetCause =
  | 'leading-not'          // a leading zero-width not(...) (its first-set is `any`)
  | 'nullable-prefix'      // a leading optional/many skips to a broad following term
  | 'cross-artifact-ref'   // a g.Foo ref resolves to `any` (unresolved across a boundary)
  | 'broad-recognizer'     // a scanTo / any-first-set regex / guard leads the arm
  | 'opaque-wrapper'       // guard/withCtx/recover contributes `any`
  | 'ref-cycle'            // a mutually-recursive ref cycle resolved to `any`

/** An arm whose deep first-set is `any` / over-broad. */
export type AnyArm = {
  index: number
  cause: FirstSetCause
  /** Human-readable trail to the poison, e.g. "via ref g.anyValue → broad recognizer (regex)". */
  detail: string
  /**
   * True when only the CONSTRUCTION-time (shallow) first-set was `any` but the
   * deep, ref-resolving first-set is finite — the monolithic compile recovers a
   * real per-arm guard, so this is NOT a genuine cliff. Never present on a
   * genuinely-ungated finding.
   */
  shallowAnyOnly: boolean
  /**
   * True when the poison is a NAMED cross-artifact hole this artifact cannot resolve
   * (`g.Value` in a shared shape). The author of THIS artifact cannot act on it — the
   * arm's real first-set only exists once a consumer binds the name — so a choice
   * whose every `any` arm is one of these is `deferred`, not `ungated`.
   *
   * An UNNAMED unresolved `ref()` is NOT this: nobody can bind it by name, so it is a
   * genuine local finding and stays reportable here.
   */
  unresolvedExternal: boolean
  /** Concrete fix, naming a real primitive. */
  suggestion: string
}

/** Two arms whose finite first-sets intersect — a shared prefix. */
export type Overlap = {
  a: number
  b: number
  on: FirstSet
  suggestion: string
}

/** An API-misuse pattern detected in a choice's arms (independent of gating). */
export type AntiPattern = {
  kind: 'double-not' | 'leading-not' | 'keyword-regex'
  rule: string
  armIndex: number
  message: string
}

export type ChoiceStrategyTag = 'firstMatch' | 'greedyClassify' | 'literalsLongestFirst' | 'sharedPrefix'

export type ChoiceGating = {
  /**
   * Stable per-choice identity for the accepted-snapshot allowlist. The enclosing
   * rule name when that rule holds exactly one choice, else `rule#N` (0-based
   * occurrence order within the rule). This is the key you list in the snapshot to
   * ACCEPT a known ungated choice.
   */
  id: string
  /** Nearest enclosing rule name (from `_ruleName`), or a synthetic path label. */
  rule: string
  strategy: ChoiceStrategyTag
  /**
   * `yes`  — emits O(1) first-char dispatch (a switch/if jump table).
   * `recoverable` — not O(1) dispatch, but every arm still first-char-guards via
   *   the deep, ref-resolving first-set (monolithic compile) / fuse-time resolution
   *   (compose). NOT a cliff; never warned.
   * `no`   — genuinely ungated: a broad/any arm or a finite overlap forces ordered
   *   speculative entry with no per-arm first-char skip.
   */
  gates: 'yes' | 'recoverable' | 'no'
  /** True when this ungated choice's `id` is in the accepted-snapshot allowlist. */
  accepted: boolean
  /**
   * `gates: 'no'` was decided by cross-artifact HOLES ONLY — every `any` arm is an
   * unresolved NAMED `g.Foo` ref and no two finite arms overlap. The verdict is not
   * this artifact's to make: the shape module can't fix it (the hole has no body
   * here) and the configuration it describes never runs. The answer belongs to the
   * FUSED artifact, where the name is bound — see `runFusedGatingDiagnostic`.
   *
   * Deferred choices are excluded from `ungated`: they neither warn nor fail the
   * `'error'` gate at this site.
   */
  deferred: boolean
  combinedFirstSet: { shallow: FirstSet; deep: FirstSet }
  anyArms: AnyArm[]
  overlaps: Overlap[]
}

/** Options for `analyzeGating` — the accepted-snapshot allowlist. */
export type AnalyzeGatingOptions = {
  /**
   * Choice `id`s that are accepted as intentionally ungated. An ungated choice
   * whose id is here is moved to `accepted` (silent, does not fail the CI gate); one
   * whose id is NOT here stays in `ungated` (warned + fails the gate). This is the
   * SINGLE per-choice suppression mechanism.
   */
  accept?: Iterable<string>
  /**
   * Name to attribute an UNNAMED entry to, instead of the synthetic `<entry>`.
   * The macro plugin passes the binding's own variable name, so a warning on a
   * top-level combinator const reads `choice @ directMixinReferenceAhead`
   * (actionable, and a discriminating `accept` key) rather than `choice @
   * <entry>` repeated once per const. Ignored when the entry already carries a
   * `_ruleName`.
   */
  entryName?: string
  /**
   * Bind NAMED cross-artifact holes (`g.Foo`) by name — supply the FUSED winner map's
   * lookup. With it, an arm led by a shared shape's hole reports the first-set it
   * really has once bound, so `deferred` collapses to a real `yes`/`no` verdict.
   * Without it (the authoring site) such a choice stays `deferred`.
   */
  resolveRef?: RefResolver
}

export type GatingReport = {
  totalChoices: number
  gated: number
  recoverable: number
  /** Genuinely-ungated choices NOT in the accepted allowlist — warned + gate-failing. */
  ungated: ChoiceGating[]
  /** Ungated choices whose id was in the accepted allowlist — silent, accepted with intent. */
  accepted: ChoiceGating[]
  /**
   * Choices whose verdict is NOT this artifact's to make — every `any` arm is an
   * unresolved cross-artifact hole (see `ChoiceGating.deferred`). Silent here; the
   * fused artifact re-asks the question with the hole bound.
   */
  deferred: ChoiceGating[]
  /** Accepted ids that matched no ungated choice — stale snapshot entries to prune. */
  acceptedUnused: string[]
  /** Every choice, for full inspection / CI snapshots. */
  choices: ChoiceGating[]
  antiPatterns: AntiPattern[]
}

// ── first-set helpers (local, to avoid importing codegen and creating a cycle) ──

const isAny = (fs: FirstSet): boolean => fs.kind === 'any'

function intersects(a: FirstSet, b: FirstSet): boolean {
  if (a.kind === 'any' || b.kind === 'any') return true
  if (a.kind === 'empty' || b.kind === 'empty') return false
  for (const ra of a.ranges) for (const rb of b.ranges) if (ra.lo <= rb.hi && rb.lo <= ra.hi) return true
  return false
}

/** The SHARED first characters of two sets (the actual overlap, not the union). */
function intersection(a: FirstSet, b: FirstSet): FirstSet {
  if (a.kind === 'any') return b
  if (b.kind === 'any') return a
  if (a.kind === 'empty' || b.kind === 'empty') return { kind: 'empty' }
  const ranges = []
  for (const ra of a.ranges) for (const rb of b.ranges) {
    const lo = Math.max(ra.lo, rb.lo)
    const hi = Math.min(ra.hi, rb.hi)
    if (lo <= hi) ranges.push({ lo, hi })
  }
  return ranges.length === 0 ? { kind: 'empty' } : { kind: 'ranges', ranges }
}

function combine(sets: FirstSet[]): FirstSet {
  let acc: FirstSet = { kind: 'empty' }
  for (const s of sets) {
    if (s.kind === 'any') return { kind: 'any' }
    if (s.kind === 'empty') continue
    acc = acc.kind === 'ranges' ? { kind: 'ranges', ranges: [...acc.ranges, ...s.ranges] } : s
  }
  return acc
}

const ch = (c: number): string => (c >= 32 && c < 127 ? `'${String.fromCharCode(c)}'` : `\\u${c}`)
export function firstSetToString(fs: FirstSet): string {
  if (fs.kind === 'any') return 'ANY'
  if (fs.kind === 'empty') return '(empty)'
  return fs.ranges.map(r => (r.lo === r.hi ? ch(r.lo) : `${ch(r.lo)}-${ch(r.hi)}`)).join(',')
}

const ruleNameOf = (p: Combinator<unknown>): string | undefined =>
  (p as unknown as { _ruleName?: string })._ruleName

// ── cause attribution: walk the leading structure, stop at the first `any` ──

const SUGGESTIONS: Record<FirstSetCause, string> = {
  'broad-recognizer':
    "if this arm leads with a keyword regex, use word('kw', boundary) / keywords([...]) — they expose an EXACT, gating first-set and lower to the same charCodeAt scan. A genuine scanTo fallback is fine; accept it in the gating snapshot if intentional.",
  'leading-not':
    'let the arm lead with its actual consuming terminal (first-sets gate it automatically); keep not(...) only as a TRAILING boundary. Do not hand-roll not(not(...)) to fake gating — use peek(X), which is zero-width AND carries X first-set.',
  'nullable-prefix':
    'a leading optional/many lets a later, broad term start the arm. Split the empty case into its own arm, or gate on the prefix first char. A plain sepBy(item, sep) is ALSO nullable — pass { min: 1 } for a list that cannot be empty.',
  'cross-artifact-ref':
    'parseman >=0.32.0 resolves a g.Foo ref first-set at fuse time; if still ANY the target rule is itself ungated — analyze it and give it a concrete non-nullable lead.',
  'opaque-wrapper':
    'this wrapper (guard/withCtx/recover) contributes no first char; put a concrete leading terminal before it.',
  'ref-cycle':
    'a recursive ref resolved to ANY; ensure the recursion has a concrete terminal lead on the base case.',
}

/** The classifier's verdict for one arm: the poison, and whether it is a hole that
 *  only a downstream fuse can fill (`unresolvedExternal`). */
type ArmCause = { cause: FirstSetCause; detail: string; unresolvedExternal?: boolean }

function classifyBroadArm(arm: Combinator<unknown>, resolve?: RefResolver): ArmCause {
  const seen = new Set<Combinator<unknown>>()
  /** Re-label an inner verdict, carrying its `unresolvedExternal` through unchanged —
   *  the cause changes, but who can FIX it does not. */
  const relabel = (inner: ArmCause | null, cause: FirstSetCause, detail: string): ArmCause =>
    ({ cause, detail, ...(inner?.unresolvedExternal ? { unresolvedExternal: true } : {}) })
  const walk = (p: Combinator<unknown>): ArmCause | null => {
    if (seen.has(p)) return { cause: 'ref-cycle', detail: 'ref cycle' }
    seen.add(p)
    const d = p._def as ParserDef
    switch (d.tag) {
      case 'literal': case 'regex': case 'keywords':
        return isAny(p._meta.firstSet) ? { cause: 'broad-recognizer', detail: `broad recognizer (${d.tag})` } : null
      case 'not':
        return { cause: 'leading-not', detail: 'leading not(...) (first-set ANY)' }
      // peek() CARRIES its body's first-set, so it is only broad when the body is
      // (or the body is nullable) — walk in for the real cause.
      case 'peek':
        return walk(d.parser)
      case 'scanTo':
        return { cause: 'broad-recognizer', detail: 'scanTo (any first char)' }
      // `guard` (the `gate()` state predicate) has a genuinely-`any` first-set of
      // its own — it is the poison. `withCtx`/`recover` FORWARD their inner
      // first-set (see firstSetOf), so a broad result comes from the inner parser:
      // walk into it for a precise cause.
      case 'guard':
        return { cause: 'opaque-wrapper', detail: `opaque wrapper (${d.tag})` }
      // attempt/withCtx/recover FORWARD their inner first-set (transparent for
      // dispatch), so a broad result comes from the inner parser — walk into it.
      case 'attempt': case 'withCtx': case 'recover':
        return walk(d.parser)
      case 'lazy': {
        const name = (p as unknown as { _ruleName?: string })._ruleName
        let target: Combinator<unknown>
        try { target = (d as { thunk(): Combinator<unknown> }).thunk() }
        catch {
          // A NAMED ref the fuse resolver can bind is analyzed against its real body;
          // otherwise the hole itself is the poison — and it is only the AUTHOR's
          // problem when it is unnamed (nothing can ever bind it by name).
          const bound = name !== undefined ? resolve?.(name) : undefined
          if (bound === undefined)
            return { cause: 'cross-artifact-ref', detail: `unresolved ref${name ? ` g.${name}` : ''}`, unresolvedExternal: name !== undefined }
          target = bound
        }
        const inner = walk(target)
        if (name !== undefined) return inner ? relabel(inner, 'cross-artifact-ref', `via ref g.${name} → ${inner.detail}`) : null
        return inner
      }
      case 'optional': case 'many': {
        const inner = walk(d.parser)
        return relabel(inner, 'nullable-prefix', inner ? `nullable prefix → ${inner.detail}` : 'nullable prefix to broad term')
      }
      case 'oneOrMore': case 'transform': case 'label': case 'field':
      case 'trivia': case 'token': case 'leaf': case 'node': case 'grammar': case 'expect':
        return walk(d.parser)
      case 'skip': return walk(d.main)
      case 'sequence': {
        // Scan the nullable prefix the way sequenceFirstSet does: a `not(...)` or a
        // FINITE nullable term (optional/many/nullable regex) is skipped so a LATER
        // term's first chars can start the sequence. Stop at the first term that is
        // non-nullable (it gates → return null) or broad (it's the poison).
        let sawNullablePrefix = false
        for (const t of d.parsers) {
          if ((t._def as ParserDef).tag === 'not') { sawNullablePrefix = true; continue }
          if (isAny(firstSetOf(t, new Set(), resolve))) {
            const inner = walk(t)
            if (sawNullablePrefix)
              return relabel(inner, 'nullable-prefix', inner ? `nullable prefix → ${inner.detail}` : 'nullable prefix to broad term')
            return inner ?? { cause: 'broad-recognizer', detail: 'sequence leading term is broad' }
          }
          if (matchesEmpty(t, new Set(), resolve)) { sawNullablePrefix = true; continue } // finite but nullable → keep scanning
          return null // finite, non-nullable → this term gates the sequence
        }
        return { cause: 'broad-recognizer', detail: 'sequence of only nullable/zero-width terms' }
      }
      case 'choice': {
        for (const a of d.parsers) { const r = walk(a); if (r) return relabel(r, r.cause, `choice arm → ${r.detail}`) }
        return null
      }
      default:
        return { cause: 'broad-recognizer', detail: `unmodeled construct (${d.tag})` }
    }
  }
  return walk(arm) ?? { cause: 'broad-recognizer', detail: 'broad (cause not localized)' }
}

// ── anti-pattern detection ──

/** Peel non-consuming wrappers to the arm's leading term (mirrors leadingTermOfArm). */
function peelToLeading(arm: Combinator<unknown>): Combinator<unknown> {
  let d = arm._def as ParserDef
  let cur = arm
  for (;;) {
    if (d.tag === 'node' || d.tag === 'grammar' || d.tag === 'transform' || d.tag === 'label' || d.tag === 'attempt') {
      cur = (d as { parser: Combinator<unknown> }).parser
      d = cur._def as ParserDef
      continue
    }
    break
  }
  if (d.tag === 'sequence' && d.parsers.length >= 1) return d.parsers[0]!
  return cur
}

/** A regex source that is really a keyword (a literal word, optionally with a
 *  trailing boundary lookahead) — the case word()/keywords() should own. */
const KEYWORD_REGEX_RE = /^\^?[@#.-]?[A-Za-z][\w-]*(\(\?![^)]*\))?\$?$/

function detectAntiPatterns(rule: string, arms: readonly Combinator<unknown>[]): AntiPattern[] {
  const out: AntiPattern[] = []
  arms.forEach((arm, i) => {
    const lead = peelToLeading(arm)
    const ld = lead._def as ParserDef
    // (a) not(not(...)) — hand-rolled first-char gating that MISCOMPILES among
    //     sibling arms sharing a first char.
    if (ld.tag === 'not') {
      const inner = (ld as { parser: Combinator<unknown> }).parser
      if ((inner._def as ParserDef).tag === 'not') {
        out.push({ kind: 'double-not', rule, armIndex: i,
          message: 'not(not(...)) hand-rolls automatic first-char gating and MISCOMPILES among shared-first-char sibling arms (its first-set is ANY, poisoning dispatch). Prefer letting the arm lead with its consuming terminal; where a real positive lookahead IS needed, use peek(X) — zero-width like not(not(X)) but it CARRIES X\'s first-set, so the arm still dispatches.' })
      } else {
        out.push({ kind: 'leading-not', rule, armIndex: i,
          message: 'a leading not(...) on a choice arm hand-rolls gating and poisons the choice first-set (not() is ANY). Reorder so a consuming terminal leads; keep not(...) as a TRAILING boundary only.' })
      }
    }
    // (b) bare leading regex(/keyword/) — word()/keywords() would give an exact,
    //     resolvable first-set (and lower identically).
    if (ld.tag === 'regex' && KEYWORD_REGEX_RE.test(ld.source)) {
      out.push({ kind: 'keyword-regex', rule, armIndex: i,
        message: `regex(/${ld.source}/) leads this arm but is a keyword — use word('…', boundary) / keywords([…]) for an EXACT resolvable first-set (they lower to the same charCodeAt scan).` })
    }
  })
  return out
}

// ── the walk ──

export function analyzeGating(entry: Combinator<unknown>, opts?: AnalyzeGatingOptions): GatingReport {
  return analyzeGatingRules([[ruleNameOf(entry) ?? opts?.entryName ?? '<entry>', entry]], opts)
}

/**
 * Multi-root variant: analyze a WHOLE `rules()` map in one walk, so every choice
 * is attributed to the rule that owns it.
 *
 * The macro build compiles a grammar through `compileRuleMap`/`compileLinkable`,
 * never through the single-entry `compile()`. Analyzing one entry at a time (or
 * not at all) is what produced unnamed `choice @ <entry>` warnings and ZERO
 * anti-patterns for grammars that in fact have dozens: an unnamed warning in a
 * multi-thousand-line grammar is unactionable. Seeding the walk with EVERY named
 * root is what recovers the rule names — and, because the walk is shared, each
 * choice is still analyzed exactly once however many rules reach it.
 */
export function analyzeGatingRules(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts?: AnalyzeGatingOptions,
): GatingReport {
  const raw: { g: Omit<ChoiceGating, 'id' | 'accepted'>; rule: string }[] = []
  const antiPatterns: AntiPattern[] = []
  const visited = new Set<Combinator<unknown>>()

  const visit = (p: Combinator<unknown>, enclosingRule: string): void => {
    if (visited.has(p)) return
    visited.add(p)
    const d = p._def as ParserDef
    const rule = ruleNameOf(p) ?? enclosingRule
    if (d.tag === 'choice') {
      raw.push({ g: analyzeChoice(p, d, rule, opts?.resolveRef), rule })
      antiPatterns.push(...detectAntiPatterns(rule, d.parsers))
    }
    // Structural recursion (+ through refs once).
    const rec = d as Record<string, unknown>
    const kids: Combinator<unknown>[] = []
    if (Array.isArray(rec.parsers)) kids.push(...(rec.parsers as Combinator<unknown>[]))
    for (const k of ['parser', 'main', 'skipped', 'separator', 'sentinel'] as const)
      if (rec[k]) kids.push(rec[k] as Combinator<unknown>)
    if (Array.isArray(rec.skip)) kids.push(...(rec.skip as Combinator<unknown>[]))
    // Deliberately NOT `resolveRef`-aware: the WALK must visit the same choices with
    // and without a resolver, so a choice's `id` (per-rule occurrence order) is the
    // same in both passes — that identity is what lets the fuse-time diagnostic report
    // exactly the choices its authoring site deferred. Nothing is lost: every rule of
    // the fused map is its own seed below, so a rule reached only through a hole is
    // still analyzed, under its own name.
    if (d.tag === 'lazy') { try { kids.push((d as { thunk(): Combinator<unknown> }).thunk()) } catch { /* unresolved */ } }
    for (const k of kids) visit(k, rule)
  }

  // Seed with the map's OWN names first: a rule root is usually a `ref()` that
  // already carries `_ruleName`, but a plain (untagged) root would otherwise
  // inherit whichever rule reached it first.
  for (const [name, root] of ruleMap) visit(root, ruleNameOf(root) ?? name)

  // Assign a stable per-choice id: bare rule name when unique in the rule, else
  // `rule#N` (occurrence order). This is the key the accepted allowlist uses.
  const perRule = new Map<string, number>()
  for (const r of raw) perRule.set(r.rule, (perRule.get(r.rule) ?? 0) + 1)
  const seenInRule = new Map<string, number>()
  const accept = new Set(opts?.accept ?? [])
  const usedAccept = new Set<string>()
  const choices: ChoiceGating[] = raw.map(({ g, rule }) => {
    const n = seenInRule.get(rule) ?? 0
    seenInRule.set(rule, n + 1)
    const id = (perRule.get(rule) ?? 1) === 1 ? rule : `${rule}#${n}`
    const isAccepted = g.gates === 'no' && accept.has(id)
    if (isAccepted) usedAccept.add(id)
    return { ...g, id, accepted: isAccepted }
  })

  const gated = choices.filter(c => c.gates === 'yes').length
  const recoverable = choices.filter(c => c.gates === 'recoverable').length
  const ungated = choices.filter(c => c.gates === 'no' && !c.accepted && !c.deferred)
  const accepted = choices.filter(c => c.gates === 'no' && c.accepted)
  const deferred = choices.filter(c => c.gates === 'no' && !c.accepted && c.deferred)
  const acceptedUnused = [...accept].filter(id => !usedAccept.has(id))
  return { totalChoices: choices.length, gated, recoverable, ungated, accepted, deferred, acceptedUnused, choices, antiPatterns }
}

// analyzeChoice returns a ChoiceGating WITHOUT id/accepted — analyzeGating assigns
// those after the full walk (id needs per-rule counts; accepted needs the allowlist).
function analyzeChoice(
  p: Combinator<unknown>,
  d: Extract<ParserDef, { tag: 'choice' }>,
  rule: string,
  resolve?: RefResolver,
): Omit<ChoiceGating, 'id' | 'accepted'> {
  const arms = d.parsers
  const shallow = arms.map(a => a._meta.firstSet)
  const deep = arms.map(a => firstSetOf(a, new Set(), resolve))

  const anyArms: AnyArm[] = deep
    .map((fs, index) => ({ fs, index }))
    .filter(x => isAny(x.fs))
    .map(({ index }) => {
      const { cause, detail, unresolvedExternal } = classifyBroadArm(arms[index]!, resolve)
      return { index, cause, detail, shallowAnyOnly: false, unresolvedExternal: unresolvedExternal === true, suggestion: SUGGESTIONS[cause] }
    })

  const overlaps: Overlap[] = []
  for (let i = 0; i < deep.length; i++)
    for (let j = i + 1; j < deep.length; j++)
      if (!isAny(deep[i]!) && !isAny(deep[j]!) && intersects(deep[i]!, deep[j]!))
        overlaps.push({ a: i, b: j, on: intersection(deep[i]!, deep[j]!),
          suggestion: 'arms share a first char — left-factor. parseman auto-detects the sharedPrefix strategy for bare sequences (choice.ts); make the arms bare sequences with a common leading terminal, or restructure.' })

  // Classification. `disjoint` (from construction, shallow) ⇒ O(1) dispatch.
  // Otherwise, if the DEEP (ref-resolved) arms are all-finite and pairwise
  // disjoint, monolithic compile still first-char-guards each arm (codegen emits
  // firstSetOf() per-arm guards) — 'recoverable', not a cliff. Else 'no'.
  let gates: ChoiceGating['gates']
  if (d.disjoint) gates = 'yes'
  else if (anyArms.length === 0 && overlaps.length === 0) gates = 'recoverable'
  else gates = 'no'

  // Ungated SOLELY because of holes this artifact can't fill: nothing here is
  // actionable and the configuration described never runs. A finite-arm overlap is a
  // real local finding, so it keeps the choice reportable even alongside a hole.
  const deferred = gates === 'no' && overlaps.length === 0 && anyArms.length > 0 && anyArms.every(a => a.unresolvedExternal)

  return {
    rule,
    strategy: ((d.strategy as { tag: ChoiceStrategyTag } | undefined)?.tag) ?? 'firstMatch',
    gates,
    deferred,
    combinedFirstSet: { shallow: combine(shallow), deep: combine(deep) },
    anyArms, overlaps,
  }
}

// ── warning formatting ──

export type GatingWarnLevel = 'off' | 'warn' | 'error'

/**
 * Format the genuinely-ungated findings + anti-patterns as ready-to-print lines.
 * Precise by design: only 'no'-gated choices NOT in the accepted allowlist, plus
 * the anti-pattern lints. Recoverable / gated / accepted / DEFERRED choices produce
 * nothing (a deferred choice's verdict belongs to the fusing artifact, not here).
 */
export function formatGatingWarnings(report: GatingReport): string[] {
  const lines: string[] = []
  for (const c of report.ungated) {
    lines.push(`parseman gating: choice @ ${c.id} is UNGATED [${c.strategy}] — no first-char dispatch; every position speculatively enters doomed arms.`)
    for (const a of c.anyArms)
      lines.push(`  · arm[${a.index}] first-set ANY (${a.cause}): ${a.detail}\n    fix: ${a.suggestion}`)
    for (const o of c.overlaps)
      lines.push(`  · arm[${o.a}] ∩ arm[${o.b}] overlap on ${firstSetToString(o.on)}\n    fix: ${o.suggestion}`)
    lines.push(`    (intentional? accept it in the gating snapshot: { accept: ['${c.id}'] }.)`)
  }
  for (const ap of report.antiPatterns)
    lines.push(`parseman anti-pattern [${ap.kind}] @ ${ap.rule} arm[${ap.armIndex}]: ${ap.message}`)
  return lines
}
