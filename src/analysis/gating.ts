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
 * `analyzeGating()` is the pure programmatic surface, and `diagnoseGrammar()`
 * (`src/analysis/diagnose.ts`) is the entry point most callers want. `compile()` does
 * NOT run either: a diagnostic is a deliberate act, not a side effect of producing an
 * artifact. Accept a deliberately-ungated choice by listing its `id` in the gating
 * snapshot allowlist (`analyzeGating(entry, { accept })` / `diagnoseGrammar(g, {
 * accept })`) — the single suppression mechanism.
 *
 * WHERE the question is asked matters as much as the answer. A SHARED SHAPE — a
 * `rules()` map referencing a rule it doesn't define (`g.Value`) — has no verdict of
 * its own: the hole makes every first-set through it `any`, but that configuration is
 * never executed and its author cannot fix it. Such a choice is `deferred` here, and
 * re-asked with `resolveRef` at the site that BINDS the name — `analyzeGrammarGating`
 * on the fused artifact, which really runs and whose author really can fix it.
 */
import type { Combinator, FirstSet, ParserDef } from '../types.ts'
import { firstSetOf, intersects, matchesEmpty, type RefResolver } from '../combinators/first-set.ts'

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
   * FUSED artifact, where the name is bound — see `analyzeGrammarGating`.
   *
   * Deferred choices are excluded from `ungated`: they neither warn nor fail the
   * `'error'` gate at this site.
   */
  deferred: boolean
  combinedFirstSet: { shallow: FirstSet; deep: FirstSet }
  anyArms: AnyArm[]
  overlaps: Overlap[]
}

/**
 * The arms a `ChoiceGating` describes, in arm order — or `undefined` when the report did
 * not come from a live walk (a deserialized snapshot). Carried non-enumerably, so it
 * never reaches the JSON a CI snapshot diffs.
 */
export const choiceArms = (c: ChoiceGating): readonly Combinator<unknown>[] | undefined =>
  (c as { arms?: readonly Combinator<unknown>[] }).arms

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

/**
 * A rule the walk could NOT introspect. Its choices were never examined, so no
 * verdict about it — clean or otherwise — is available.
 *
 * This exists because the alternative is silence. A `compose()` result is a map of
 * FUSED rule functions with no `_def` combinator graph; walking one used to throw a
 * bare `TypeError: Cannot read properties of undefined (reading 'tag')`, and the
 * default-on diagnostic swallowed that throw and returned `undefined` — a failed
 * analysis and a clean grammar were indistinguishable. Every unanalysable input is
 * now counted and named here, and `formatGatingWarnings` always reports it.
 */
export type Unanalysable = {
  /** The rule name (or seed name) whose walk stopped. */
  rule: string
  /** Why it could not be walked, in terms the caller can act on. */
  reason: string
  kind: 'fused-rule' | 'opaque-artifact' | 'not-a-combinator'
}

export type GatingReport = {
  totalChoices: number
  gated: number
  recoverable: number
  /**
   * Rules the walk could not introspect (see `Unanalysable`). NON-EMPTY MEANS THE
   * REPORT IS PARTIAL: `totalChoices === 0` with a non-empty `unanalysable` is a
   * blind walk, not a clean grammar. Callers that treat an empty `ungated` as a pass
   * MUST also assert this is empty.
   */
  unanalysable: Unanalysable[]
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

// ── grammar walk ─────────────────────────────────────────────────────────────

/**
 * Ordered structural children per def tag. Explicit rather than "every key that
 * holds a Combinator" because a SLOT's position is what near-duplicate detection
 * varies — a stable, meaningful order is load-bearing, not cosmetic.
 *
 * Lives here, in the module every analysis pass already imports, because
 * `./choice-cost.ts` and `./duplication.ts` each carried a byte-identical copy.
 */
export function childrenOf(d: ParserDef): readonly Combinator<unknown>[] {
  switch (d.tag) {
    case 'sequence': case 'choice': return d.parsers
    case 'dispatch': return [
      d.selector,
      ...d.cases.map(c => c.parser),
      ...(d.matchers ? d.matchers.map(c => c.parser) : []),
      ...(d.otherwise === undefined ? [] : [d.otherwise]),
    ]
    case 'sepBy': return [d.parser, d.separator]
    case 'recover': return [d.parser, d.sentinel]
    case 'scanTo': return [d.sentinel, ...d.skip]
    case 'grammar': return d.triviaParser ? [d.parser, d.triviaParser] : [d.parser]
    case 'routed': return d.fallback ? [d.fallback] : []
    // A `lazy` is a REFERENCE, not a subtree. Descending through it would make
    // every rule's walk cover the whole reachable grammar — site paths become
    // nonsense, and a structural hash includes half the grammar. Treated as a
    // leaf, keyed by the rule name it refers to, which is also the right
    // semantics: two productions referencing `g.Ident` really do fill that slot
    // the same way.
    case 'lazy': case 'literal': case 'regex': case 'keywords': case 'guard': case 'adjacency': case 'unknown':
      return []
    default: {
      const rec = d as unknown as { parser?: Combinator<unknown> }
      return rec.parser ? [rec.parser] : []
    }
  }
}

// ── first-set helpers (local, to avoid importing codegen and creating a cycle) ──

const isAny = (fs: FirstSet): boolean => fs.kind === 'any'

/**
 * Do two first-sets share any character?
 *
 * THE DEFINITION LIVES IN `../combinators/first-set.ts`, beside `union` and the
 * rest of the first-set algebra, and is re-exported here only because
 * `./duplication.ts` imports it from this module.
 *
 * This used to be a third copy. Two byte-identical copies in `./choice-cost.ts`
 * and `./duplication.ts` were collapsed into a declaration here, and the note
 * recording that said `intersects` now "lives once" — while
 * `../combinators/first-set.ts` had been exporting its own since before any of
 * them. INV-4 could not see it: the two bodies differ only in whether the nested
 * `for` carries braces, and INV-4 decides on byte-identity after whitespace is
 * stripped. INV-8 sees it, because it decides on the NAME.
 */
export { intersects }

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

/** A regex source that is really a keyword (a literal word, optionally with a
 *  trailing boundary lookahead) — the case word()/keywords() should own. */
const KEYWORD_REGEX_RE = /^\^?[@#.-]?[A-Za-z][\w-]*(\(\?![^)]*\))?\$?$/

/**
 * What each cause MEANS and what to do about it, in words a grammar author can act on
 * without having read parseman's source.
 *
 * These strings are the diagnostic. An earlier version of them was accurate and
 * unreadable — "give the arm a concrete leading terminal", "resolves a g.Foo ref
 * first-set at fuse time" — which is the same as having no diagnostic, because the
 * reader cannot tell what happened or what to change. Every term of art here is either
 * replaced or explained where it is used; nothing is deferred to a glossary.
 */
const SUGGESTIONS: Record<FirstSetCause, string> = {
  'broad-recognizer':
    'This arm can begin with any character, so no single-character test can rule it out. '
    + 'The parser has to enter it — set up, try, and undo — at every position it reaches, '
    + 'instead of skipping it for free.\n'
    + 'To fix: make the arm begin with a fixed character, word or keyword. If it is meant '
    + 'to be a catch-all that matches anything, leave it and add the choice to the accept '
    + 'list at the end.',
  'leading-not':
    'This arm begins with a not(...) check, which matches nothing and so says nothing about '
    + 'which character the arm starts with. The parser then cannot rule the arm out and '
    + 'enters it everywhere.\n'
    + 'To fix: put the term that actually consumes text first and keep not(...) after it as '
    + 'a trailing boundary. If you need to REQUIRE something ahead without consuming it, use '
    + 'peek(X) — it checks the same thing but still tells parseman that the arm starts with X.',
  'nullable-prefix':
    'This arm begins with something optional — an optional(...) or a repeat that allows zero '
    + 'items — so the arm can also start with whatever comes AFTER it, and that is broad '
    + 'enough that no character rules the arm out.\n'
    + 'To fix: give the optional part its own arm so each arm has a definite beginning, or '
    + 'require at least one item. A plain sepBy(item, sep) also matches nothing at all; pass '
    + '{ min: 1 } when the list must not be empty.',
  'cross-artifact-ref':
    'This arm hands off to another rule, and that rule has the same problem — it can begin '
    + 'with any character — so the cost is inherited rather than caused here.\n'
    + 'To fix: run this check on the rule it refers to and fix it there. One rule given a '
    + 'definite beginning fixes every choice that uses it.',
  'opaque-wrapper':
    'This arm begins with a wrapper that only inspects parser state (a gate/withCtx/recover) '
    + 'and consumes no text, so it says nothing about which character the arm starts with.\n'
    + 'To fix: put a term that actually matches text in front of the wrapper.',
  'ref-cycle':
    'This arm refers back to itself through a cycle of rules, and parseman could not work out '
    + 'a definite first character for any of them.\n'
    + 'To fix: make sure the base case of the recursion begins with a fixed character or '
    + 'keyword, so the cycle has somewhere definite to start.',
}

/**
 * The generic per-cause advice, sharpened by what the arm ACTUALLY leads with.
 *
 * One string per cause was quietly wrong in the common case. `broad-recognizer` covers
 * both `regex(/@media/)` — which `word()` fixes outright — and `regex(/[^()]+/)`, a
 * genuine catch-all scanner that no primitive can gate and where the keyword advice is
 * noise the reader has to discard. Telling someone "if this is X, do Y" when the tool
 * can already see whether it is X is exactly the gap between advice and a diagnostic.
 */
function refineSuggestion(cause: FirstSetCause, arm: Combinator<unknown>): string {
  if (cause !== 'broad-recognizer') return SUGGESTIONS[cause]
  const lead = peelToLeading(arm)
  const d = lead._def as ParserDef
  if (d.tag === 'regex' && KEYWORD_REGEX_RE.test(d.source)) {
    return `This arm matches the fixed word \`${d.source}\` with a regular expression, and parseman `
      + 'cannot always tell from a regular expression which character it starts with.\n'
      + "To fix: write it as word('…') or keywords([…]) instead. They match exactly the same text and "
      + 'compile to the same character scan, but they also tell parseman the first character, which is '
      + 'what lets the parser skip this arm when it cannot match.'
  }
  if (d.tag === 'scanTo') {
    return 'This arm ends in a scanTo(...) catch-all, which reads forward until it finds something and '
      + 'so can begin at any character. The parser can never rule it out. That is usually exactly what '
      + 'you want from a fallback.\n'
      + 'To fix: usually nothing. Add this choice to the accept list at the end so the check keeps '
      + 'flagging the choices that are real problems.'
  }
  return SUGGESTIONS[cause]
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
      // Zero-width and dropped from a sequence's first-set (isZeroWidthAssertion),
      // so it is never the reason an arm is broad — but it can be reached as the
      // sole term of a degenerate arm. Report it precisely rather than as a wrapper.
      case 'adjacency':
        return { cause: 'broad-recognizer', detail: `${d.polarity}() (zero-width assertion)` }
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
      case 'dispatch':
        return walk(d.selector)
      default:
        return { cause: 'broad-recognizer', detail: `unmodeled construct (${d.tag})` }
    }
  }
  return walk(arm) ?? { cause: 'broad-recognizer', detail: 'broad (cause not localized)' }
}

// ── anti-pattern detection ──

/** Peel non-consuming wrappers to the arm's leading term (mirrors leadingTermOfArm). */
export function peelToLeading(arm: Combinator<unknown>): Combinator<unknown> {
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
          message: 'not(not(X)) is a hand-written way of saying "X must come next, but do not consume it". '
            + 'parseman does that for you, and the hand-written form is worse than nothing here: because '
            + 'not(...) reveals no first character, the arm cannot be skipped, and among sibling arms that '
            + 'share a first character it can select the wrong one.\n'
            + 'To fix: write peek(X). It checks the same thing without consuming, and it also tells '
            + 'parseman that the arm starts with whatever X starts with.' })
      } else {
        out.push({ kind: 'leading-not', rule, armIndex: i,
          message: 'This arm begins with not(...), which matches no text and so reveals no first '
            + 'character. The parser therefore cannot skip the arm and enters it at every position.\n'
            + 'To fix: put the term that actually consumes text first, and keep not(...) after it as a '
            + 'trailing boundary check.' })
      }
    }
    // (b) bare leading regex(/keyword/) — word()/keywords() would give an exact,
    //     resolvable first-set (and lower identically).
    if (ld.tag === 'regex' && KEYWORD_REGEX_RE.test(ld.source)) {
      out.push({ kind: 'keyword-regex', rule, armIndex: i,
        message: `This arm starts with the fixed word \`${ld.source}\` written as a regular expression. `
          + "Writing it as word('…') or keywords([…]) matches exactly the same text and compiles to the "
          + 'same character scan, but also tells parseman the first character, which is what lets the '
          + 'parser skip the arm when it cannot match.' })
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
  const raw: { g: Omit<ChoiceGating, 'id' | 'accepted'>; rule: string; arms: readonly Combinator<unknown>[] }[] = []
  const antiPatterns: AntiPattern[] = []
  const unanalysable: Unanalysable[] = []
  const seenUnanalysable = new Set<string>()
  const visited = new Set<Combinator<unknown>>()

  const noteUnanalysable = (u: Unanalysable): void => {
    const key = `${u.rule}\u0000${u.kind}`
    if (seenUnanalysable.has(key)) return
    seenUnanalysable.add(key)
    unanalysable.push(u)
  }

  const visit = (p: Combinator<unknown>, enclosingRule: string): void => {
    if (visited.has(p)) return
    visited.add(p)
    // A grammar VALUE that carries no combinator descriptor cannot be walked. The
    // dominant case is a `compose()` result: fusion lowers every rule to an executable
    // function, discarding the combinator graph. Record it — never throw, and never
    // let the caller mistake the resulting empty walk for a clean grammar.
    const def = (p as { _def?: unknown } | null | undefined)?._def
    if (def === null || typeof def !== 'object') {
      noteUnanalysable(
        typeof p === 'function'
          ? {
              rule: enclosingRule, kind: 'fused-rule',
              reason: 'fused rule function — a compose()/fuse result has no combinator graph. '
                + 'Analyze the composed grammar itself (analyzeGrammarGating) so the carried IR is re-lowered first.',
            }
          : {
              rule: enclosingRule, kind: 'not-a-combinator',
              reason: `value of type ${p === null ? 'null' : typeof p} is not a combinator and carries no _def descriptor.`,
            },
      )
      return
    }
    const d = def as ParserDef
    const rule = ruleNameOf(p) ?? enclosingRule
    if (d.tag === 'choice') {
      raw.push({ g: analyzeChoice(p, d, rule, opts?.resolveRef), rule, arms: d.parsers })
      antiPatterns.push(...detectAntiPatterns(rule, d.parsers))
    }
    // Structural recursion (+ through refs once). Keep the child inventory in
    // one place: choice-cost, duplication and dependency analysis use the same
    // authored edge order, including matcher arms, grammar trivia, and routed
    // fallbacks.
    const kids = [...childrenOf(d)]
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
  const choices: ChoiceGating[] = raw.map(({ g, rule, arms }) => {
    const n = seenInRule.get(rule) ?? 0
    seenInRule.set(rule, n + 1)
    const id = (perRule.get(rule) ?? 1) === 1 ? rule : `${rule}#${n}`
    const isAccepted = g.gates === 'no' && accept.has(id)
    if (isAccepted) usedAccept.add(id)
    const out: ChoiceGating = { ...g, id, accepted: isAccepted }
    // The arms themselves, carried for a RENDERER that wants to show the ordering with a
    // dispatch key beside each arm. NON-ENUMERABLE deliberately: `GatingReport` is
    // JSON-serialized into a committed, byte-identity-tested snapshot, and combinators are
    // cyclic graphs full of closures. Attaching them here rather than letting a caller
    // re-walk the grammar is what keeps a second walk from drifting out of step with this
    // one's `id` assignment — which it did, silently, and mislabelled every arm.
    Object.defineProperty(out, 'arms', { value: arms, enumerable: false, writable: false })
    return out
  })

  const gated = choices.filter(c => c.gates === 'yes').length
  const recoverable = choices.filter(c => c.gates === 'recoverable').length
  const ungated = choices.filter(c => c.gates === 'no' && !c.accepted && !c.deferred)
  const accepted = choices.filter(c => c.gates === 'no' && c.accepted)
  const deferred = choices.filter(c => c.gates === 'no' && !c.accepted && c.deferred)
  const acceptedUnused = [...accept].filter(id => !usedAccept.has(id))
  return {
    totalChoices: choices.length, gated, recoverable, unanalysable,
    ungated, accepted, deferred, acceptedUnused, choices, antiPatterns,
  }
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
      return {
        index, cause, detail, shallowAnyOnly: false,
        unresolvedExternal: unresolvedExternal === true,
        suggestion: refineSuggestion(cause, arms[index]!),
      }
    })

  const overlaps: Overlap[] = []
  for (let i = 0; i < deep.length; i++)
    for (let j = i + 1; j < deep.length; j++)
      if (!isAny(deep[i]!) && !isAny(deep[j]!) && intersects(deep[i]!, deep[j]!))
        overlaps.push({ a: i, b: j, on: intersection(deep[i]!, deep[j]!),
          suggestion: 'Two arms of this choice can begin with the same character, so the parser cannot '
            + 'tell from that character which one to try. It tries them in order and undoes the ones that '
            + 'do not match.\n'
            + 'To fix: pull the shared beginning out in front of the choice so it is matched once — '
            + 'sequence(shared, choice(rest…)) — instead of repeating it inside each arm. parseman '
            + 'recognises that shape automatically and turns it back into a single test.' })

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

/**
 * Format the genuinely-ungated findings + anti-patterns as ready-to-print lines.
 * Precise by design: only 'no'-gated choices NOT in the accepted allowlist, plus
 * the anti-pattern lints. Recoverable / gated / accepted / DEFERRED choices produce
 * nothing (a deferred choice's verdict belongs to the fusing artifact, not here).
 */
export function formatGatingWarnings(report: GatingReport): string[] {
  const lines: string[] = []
  // FIRST, and unconditionally: a partial walk must never present as a clean one.
  // These lines are emitted even when there are no findings at all, because "no
  // findings" over an unanalysable grammar is precisely the failure this reports.
  if (report.unanalysable.length > 0) {
    lines.push(
      `parseman gating: ${report.unanalysable.length} rule(s) UNANALYSABLE — this report is PARTIAL `
      + `(${report.totalChoices} choice(s) examined). An empty finding list below does NOT mean the grammar is clean.`,
    )
    for (const u of report.unanalysable)
      lines.push(`  · ${u.rule} [${u.kind}]: ${u.reason}`)
  }
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

/**
 * Dependency manifest for a rule map: for each rule, the set of OTHER rule names
 * its body references. A referenced rule is a BOUNDARY — record the edge and do
 * NOT descend into it (its own deps are its own entry). Self-references are
 * included, because a recursive rule does depend on itself.
 *
 * Used for a la carte dep-closure selection (`pick`) and the compose-time name
 * closure check. This lives here rather than in a lowering because it is a walk
 * over the COMBINATOR GRAPH and has nothing to do with how that graph is lowered
 * — it outlived the source lowering it was first written inside.
 */
export function ruleDependencies(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): Map<string, string[]> {
  const nameOf = new Map<Combinator<unknown>, string>()
  for (const [name, comb] of ruleMap) nameOf.set(comb, name)

  const deps = new Map<string, string[]>()
  for (const [name, comb] of ruleMap) {
    const found = new Set<string>()
    const seen = new Set<Combinator<unknown>>()
    const walk = (p: Combinator<unknown>, isRoot: boolean): void => {
      const def = p._def
      // `_ruleName` (set by `rules()`) also catches EXTERNAL refs — rules referenced
      // by name but defined in another artifact — which is what makes the closure
      // correct across a composition boundary.
      const boundary = def.tag === 'lazy'
        ? (nameOf.get(p) ?? (p as unknown as { _ruleName?: string })._ruleName)
        : nameOf.get(p)
      if (!isRoot && boundary !== undefined) { found.add(boundary); return }
      if (seen.has(p)) return
      seen.add(p)
      if (def.tag === 'lazy') {
        let resolved: Combinator<unknown>
        try { resolved = def.thunk() } catch { return }
        walk(resolved, false)
        return
      }
      for (const child of childrenOf(def)) walk(child, false)
    }
    walk(comb, true)
    deps.set(name, [...found])
  }
  return deps
}
