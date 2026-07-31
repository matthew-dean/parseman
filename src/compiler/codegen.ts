/**
 * Compile a Combinator<T> definition tree into an optimized JavaScript function.
 *
 * Design: every sub-emitter uses early-return on failure. Fallible contexts
 * (optional, sepBy loops, many loops) use labeled blocks so early-exit is a
 * `break <label>` rather than an IIFE return — no function call, no result
 * object allocation per node.
 */
import type { Combinator, ParserDef, FirstSet, ParseResult, ParseContext, ParseError, ChoiceStrategy, FieldMap } from '../types.ts'
import { getCoreLiteralValue, getCoreRegexDef, leadingTermOfArm } from '../combinators/choice.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { firstSetOf, matchesEmpty, union, empty, any, isZeroWidthAssertion } from '../combinators/first-set.ts'
import { mayCommitFailure, mayLeavePartialCapture, capturesLeaf, hasNodeDef, alwaysConsumes } from '../analysis/commitment.ts'
import { PARSEMAN_VERSION } from '../version.ts'
import { assertHostModeCompatible, type HostMode } from '../cst/host-mode.ts'
import { analyzeDuplication, analyzeDuplicationRules, formatDuplicationFindings, duplicationFindingCount, type DuplicationReport, type DuplicationWarnLevel } from '../analysis/duplication.ts'

/**
 * A rule's LEADING first-set as a fuse-resolvable recipe.
 *
 * A recipe is a UNION of ORDERED CHAINS (`alts`). Each chain is the leading-term
 * sequence of one alternative; `fusedBody()` resolves it left-to-right against the
 * WINNING rules, UNIONING each segment's first-set and STOPPING after the first
 * segment that is not nullable. A segment is either
 *   - a concrete first-set (`set`) with its build-time-known `nullable` flag, or
 *   - a rule REFERENCE (`ref`) whose first-set AND nullability are resolved at fuse
 *     time (`nullable` is a conservative placeholder until then).
 *
 * Why the ORDER + per-segment nullability matter (the bug this shape fixes): a rule
 * like `sequence(g.CssAstSyntaxStatementAtRuleName, prelude, ';')` leads with a
 * cross-artifact ref. At compile time that ref's nullability is unknown, so a flat
 * "concrete chars + ref names" recipe would conservatively treat it as nullable and
 * union the FOLLOWING terms' first-sets — and the prelude's first-set is `any` (a
 * `scanTo`), collapsing the whole recipe to `any` and losing first-char dispatch.
 * Keeping the leading chain ordered lets fuse-time resolution see the ref is actually
 * NON-nullable and STOP — so the arm gates on `{@}`, exactly as a grammar-local
 * `regex(/@…/)` would. Grammar authors had to hand-copy those recognizers to work
 * around this; the ordered chain removes the need.
 *
 * Soundness: the resolved set is always a SUPERSET of the rule's true first chars.
 * An unknown/opaque construct contributes its shallow `_meta.firstSet`; a ref whose
 * nullability can't be resolved defaults to nullable (keep unioning — never drops a
 * valid first char).
 */
// VERSION-LOCKED FORMAT: this recipe shape is part of the compiled-artifact format
// (see src/version.ts). It may change freely between parseman versions and carries NO
// cross-version back-compat — a fused artifact is always produced and consumed by the
// SAME parseman version. Do NOT add a "legacy"/dual-format read path for an older
// recipe shape; it is dead code by design (fusedBody's version lock rejects a
// cross-version artifact before it is ever read).
export type FirstSetSeg = { set: FirstSet; nullable: boolean; ref?: string }
export type FirstSetRecipe = { alts: FirstSetSeg[][] }
export function leadingFirstSetRecipe(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): FirstSetRecipe {
  const d = p._def as ParserDef
  // A NAMED rule reference is deferred to fuse time and NEVER recursed into here, so
  // it needs no cycle guard and must NOT be added to `seen`. Otherwise the SAME ref
  // object appearing in two sibling positions of a rule — e.g. `choice(sequence(not,
  // g.R), sequence(g.R, …))`, where `g.R` is both arm-0's (nullable-prefix) tail and
  // arm-1's lead — would hit the `seen` guard on its 2nd visit and return an EMPTY
  // recipe, silently dropping arm-1's first chars (an unsound FALSE-EXCLUDE: the
  // fused choice then gates that arm out and rejects valid input). This is handled
  // BEFORE the cycle guard precisely so a legit multi-occurrence ref is never mistaken
  // for a cycle. (Rule ref: first-set + chain-stop nullability both deferred to fuse;
  // `nullable: false` = "not forced skippable" — a wrapping optional/many forces true.)
  if (d.tag === 'lazy') {
    const name = (p as unknown as { _ruleName?: string })._ruleName
    if (name !== undefined) return { alts: [[{ set: empty(), nullable: false, ref: name }]] }
  }
  // PATH-BASED cycle guard: `seen` holds only the combinators on the CURRENT recursion
  // path (ancestors), added on entry and removed on exit (the `finally` below). A
  // genuine self-cycle (a node reachable from itself through the leading structure)
  // returns an empty chain, but a node SHARED across SIBLING / DAG positions — e.g. an
  // inlined `const term = node(…)` used in several arms — is recomputed fresh instead
  // of being mistaken for a cycle and silently dropped (which would under-approximate
  // its arm's first-set into a FALSE-EXCLUDE). A global visited-set would conflate the
  // two; only ancestors on the current path are true cycles.
  if (seen.has(p)) return { alts: [[]] }
  seen.add(p)
  const rec = (c: Combinator<unknown>): FirstSetRecipe => leadingFirstSetRecipe(c, seen)
  const seg = (set: FirstSet, nullable: boolean): FirstSetSeg => ({ set, nullable })
  // Force every segment of a recipe to nullable — used for `optional`/`many`, which
  // are skippable as a whole, so the leading chain must be able to continue PAST
  // them to a following term (and a wrapped rule REF must not stop the chain even if
  // it resolves non-nullable — the optional can omit it).
  const forceNullable = (r: FirstSetRecipe): FirstSetRecipe =>
    ({ alts: r.alts.map(alt => alt.map(s => ({ ...s, nullable: true }))) })
  // Collapse a multi-alternative term (an inner choice) reached inside a sequence
  // chain into ONE segment. If any alternative's leading run holds a rule REF, its
  // real first chars are only known at fuse time and can't be carried in a linear
  // chain, so widen to `any` (sound superset); otherwise union the concrete sets.
  const collapse = (r: FirstSetRecipe, nullable: boolean): FirstSetSeg => {
    let set: FirstSet = empty()
    let hasRef = false
    for (const alt of r.alts) {
      for (const s of alt) { if (s.ref !== undefined) hasRef = true; set = union(set, s.set); if (!s.nullable) break }
    }
    return seg(hasRef ? any() : set, nullable)
  }
  const compute = (): FirstSetRecipe => {
  switch (d.tag) {
    case 'lazy': {
      // Named lazies (rule refs) are handled above, before the cycle guard. An
      // UNNAMED lazy is an inline thunk — recurse into it (cycle-guarded by `seen`).
      try { return rec(d.thunk()) } catch { return { alts: [[seg(any(), false)]] } }
    }
    case 'literal': case 'regex': case 'keywords': case 'routed':
      return { alts: [[seg(p._meta.firstSet, matchesEmpty(p))]] }
    case 'choice': {
      // Alternatives union: concat every arm's chains.
      const alts: FirstSetSeg[][] = []
      for (const arm of d.parsers) alts.push(...rec(arm).alts)
      return { alts }
    }
    case 'dispatch':
      return rec(d.selector)
    case 'sequence': {
      // One ordered chain through the nullable prefix, stopping at (and including)
      // the first non-nullable term — same rule as `sequenceFirstSet`. A leading
      // zero-width assertion (`not`) contributes nothing but is nullable (keep
      // scanning past it). A multi-alt term is collapsed to keep the chain linear.
      const chain: FirstSetSeg[] = []
      for (const term of d.parsers) {
        if (!isZeroWidthAssertion(term)) {
          const tr = rec(term)
          if (tr.alts.length === 1) chain.push(...tr.alts[0]!)
          else chain.push(collapse(tr, matchesEmpty(term)))
        }
        if (!matchesEmpty(term)) return { alts: [chain] }
      }
      return { alts: [chain] }
    }
    // `many`/`optional` are skippable as a whole → their leading chars start the
    // sequence but the chain must continue past them (force nullable). `oneOrMore`
    // requires at least one repetition, so it is NOT made nullable here.
    case 'many': case 'optional':
      return forceNullable(rec(d.parser))
    case 'oneOrMore': case 'transform': case 'label':
    case 'field': case 'trivia': case 'token': case 'leaf': case 'node': case 'grammar': case 'expect':
      return rec(d.parser)
    case 'sepBy': return rec(d.parser)
    case 'skip': return rec(d.main)
    // not / scanTo / guard / withCtx / recover / unknown → shallow set (safe).
    default: return { alts: [[seg(p._meta.firstSet, matchesEmpty(p))]] }
  }
  }
  try { return compute() } finally { seen.delete(p) }   // pop from the current path
}
import { markUnusedValues } from './value-usage.ts'
import { buildBalancedInterior, type BalancedAmbient } from '../combinators/scanTo.ts'
import { buildGrammarPlan, type GrammarCoveragePlan } from './grammar-coverage-ids.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'
import {
  analyzeLabeledScannableRun,
  analyzeTriviaFastPath,
  buildFastTriviaFnDecl,
  buildLabeledRegexTriviaFnDecl,
  buildLabeledRuntimeTriviaFnDecl,
  buildLabeledScannableTriviaFnDecl,
  labeledTriviaRegexArms,
} from './trivia-fast-path.ts'
import { scanShapeFromRegex, parseClassRanges, emitShapeMatch, foldEq, type ScanShape, type Mint } from './scannable-run.ts'
import { emitScannableTerminal } from './scannable-terminal.ts'
import { analyzeMkInlineBuild, emitInlineMkNodeExpr } from './inline-build.ts'
import { buildReadsChildren, buildReadsRaw, buildReadsTrivia, buildReadsState } from './build-arity.ts'
import { buildReadsFields, parserEnablesTriviaCapture, parserHasOwnFields, parserHasTriviaSite } from './fields.ts'
import {
  isDispatchTailOnlyTransform,
  transformFnSource,
  tryInlineUnaryTransform,
  tryInlineDestructureTransform,
} from './inline-callback.ts'
import { annotateSpan, normalizeLineIndex, recordLineRange } from './line-index.ts'
import { collectGrammarReflection, type GrammarReflection } from '../cst/reflection.ts'
import { beginCompileDegradationDrain } from './degradation.ts'
import { dispatchConfigFromEnv, emitDispatchId, sharedHelperDecl, type SharedHelper } from './token-dispatch.ts'

/**
 * Emission-time constant folding for gate expressions.
 *
 * Several per-node gates are compile-time constants once a capability is not
 * compiled in (profiling is the motivating case: it is interpreted-mode only, so
 * every profiling gate is the literal `'false'` here). Building the ternary as a
 * string would leave `false ? undefined : []` in the artifact — correct, but it
 * is emitted once per node, and a real grammar has thousands of nodes. Folding
 * at emission keeps the artifact free of provably-dead branches instead of
 * relying on a downstream minifier that callers may not run.
 */
function tern(cond: string, whenTrue: string, whenFalse: string): string {
  if (cond === 'false') return whenFalse
  if (cond === 'true') return whenTrue
  return `${cond} ? ${whenTrue} : ${whenFalse}`
}

/** Fold `!(cond)` when `cond` is a literal. */
function notGate(cond: string): string {
  if (cond === 'false') return 'true'
  if (cond === 'true') return 'false'
  return `!(${cond})`
}

/** Fold `a || b` when either side is a literal. */
function orGate(a: string, b: string): string {
  if (a === 'false') return b
  if (b === 'false') return a
  if (a === 'true' || b === 'true') return 'true'
  return `${a} || ${b}`
}

/** Fold `a && b` when either side is a literal. */
function andGate(a: string, b: string): string {
  if (a === 'false' || b === 'false') return 'false'
  if (a === 'true') return b
  if (b === 'true') return a
  return `${a} && ${b}`
}

/**
 * Runtime prelude helper for the structural-node capture gate. Answers "does the
 * injected `_ctx.build` host read its (n+1)th positional arg?" — `.length` alone
 * under-counts with rest/default params and can't see through a bound fn, so a
 * rest/default param or an `arguments` reference forces full capture (output-safe).
 * Plain positional and bound-native hosts (the common case) trust `.length`.
 * Emitted (memoized on `_ctx._pmCapTL`/`_pmCapST`) wherever a structural node()
 * arity-gates host capture; shared, un-namespaced, mirrors `_EMPTY_TL` placement.
 */
export const HOST_READS_DECL =
  'const _hostReads = (b, n) => { if (b === undefined) return false; let s; try { s = Function.prototype.toString.call(b) } catch (e) { return true } if (/\\barguments\\b/.test(s)) return true; const m = /^[^(]*\\(([\\s\\S]*?)\\)/.exec(s); if (m && /\\.\\.\\.|=/.test(m[1])) return true; return b.length > n }'

/**
 * Raw-children coercion, hoisted out of every node site.
 *
 * The `rawChildren` entry for a produced value is either the value itself (when it
 * is already a tagged CST thing) or a synthesized leaf. Inlined, that test plus the
 * leaf literal is ~300 bytes emitted PER `node()` site — measured at 2.6% of
 * `example/css`, 7.1% of `probe/node-scale-32`, 11.2% of `probe/trivia-off`.
 *
 * Allocation behaviour is preserved exactly, which is why `span` is the last
 * parameter and may be absent:
 *  - line-tracked grammars already hold their span in a local, so they pass it and
 *    nothing extra is allocated;
 *  - untracked grammars pass nothing and the `{ start, end }` literal is built
 *    INSIDE, on the fallback branch only — exactly where the inline form built it.
 * Passing the literal as an argument instead would have allocated a span on the
 * fast path, which is the one thing this hoist must not do.
 */
export const RAW_ENTRY_DECL =
  'const _rawEntry = (v, input, s, e, span) => (typeof v === \'object\' && v !== null && (v._tag === \'node\' || v._tag === \'leaf\' || v._tag === \'parseError\')) ? v : { _tag: \'leaf\', value: typeof v === \'string\' ? v : (typeof v === \'object\' && v !== null ? input.slice(s, e) : \'\'), span: span ?? { start: s, end: e } }'

export const LINE_TRACK_DECL =
  'const _trackLines = (_ctx, input, start, end) => { const from = _ctx._lineScannedTo ?? 0; if (end <= from) return; for (let i = from; i < end; i++) if (input.charCodeAt(i) === 10) _ctx._lineStarts.push(i + 1); _ctx._lineScannedTo = end }'

export const LINE_SPAN_DECL =
  'const _lineCol = (_ctx, offset) => { const starts = _ctx._lineStarts; let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1 } return [lo + 1, offset - starts[lo] + 1] }\n'
  + 'const _spanLines = (_ctx, start, end) => { const s = _lineCol(_ctx, start), e = _lineCol(_ctx, end); return { start, end, startLine: s[0], startColumn: s[1], endLine: e[0], endColumn: e[1] } }'

// ---------------------------------------------------------------------------
// Regex-lowering diagnostics
//
// A regex terminal "lowers" when `scanShapeFromRegex` recognizes it and it emits
// a tight `charCodeAt` scan loop. When it can't, emitRegex falls back to a real
// `RegExp.exec` call — correct, but slower. Compilation is single-module and
// synchronous, so a module-level capture sink (opened per transform, drained
// after) records the un-lowered patterns without threading a field through every
// Ctx and compile*() return. Keyed by regex source → one entry per unique pattern.
// ---------------------------------------------------------------------------
let _loweringSink: Set<string> | null = null

/** Begin capturing regexes that fall back to `RegExp.exec` (didn't lower). */
export function beginLoweringCapture(): void {
  _loweringSink = new Set()
}

/** Stop capturing and return the un-lowered regex sources seen since begin. */
export function endLoweringCapture(): string[] {
  const misses = _loweringSink ? [..._loweringSink] : []
  _loweringSink = null
  return misses
}

// ---------------------------------------------------------------------------
// Inline-cap reporting
//
// When the inline-expansion cap binds it changes what gets emitted, which is a fact a
// grammar author needs. It is deliberately NOT routed through `recordDegradation`: the
// cap binding is INTENDED behaviour, and `PARSEMAN_DEGRADATION=error` turns any recorded
// degradation into a thrown build failure — a consumer that asserts zero degradations
// would start failing the moment a grammar grew past the budget, which is the opposite
// of what a cap is for. It is also not printed during compile. It is collected here and
// drained by whoever asks, so a separate diagnostic call can report it.
// ---------------------------------------------------------------------------

/** One emitted function whose inline budget was spent, and what it cost. */
export type InlineCapSite = {
  /** The emitted function that hit the budget. */
  fn: string
  /** Approximate combinator nodes in the ref body that became a call instead. */
  nodes: number
}

let _inlineCapSink: InlineCapSite[] | null = null

/** Begin collecting inline-cap sites. */
export function beginInlineCapCapture(): void {
  _inlineCapSink = []
}

/** Stop collecting and return the sites, in emission order (deterministic). */
export function endInlineCapCapture(): InlineCapSite[] {
  const sites = _inlineCapSink ?? []
  _inlineCapSink = null
  return sites
}

/**
 * One line per capped function, in the shape the degradation formatter uses so the two
 * read alike. Says exactly what happened and exactly what to do about it, because a
 * diagnostic that does neither is noise.
 */
export function formatInlineCapSites(sites: readonly InlineCapSite[], max: number): string[] {
  if (sites.length === 0) return []
  const byFn = new Map<string, { count: number; nodes: number }>()
  for (const s of sites) {
    const cur = byFn.get(s.fn)
    if (cur) { cur.count += 1; cur.nodes += s.nodes }
    else byFn.set(s.fn, { count: 1, nodes: s.nodes })
  }
  return [...byFn].map(([fn, { count, nodes }]) =>
    `[parseman] inline-cap ${fn}: inline budget of ${max} node(s) spent — `
    + `${count} single-use ref(s) totalling ~${nodes} node(s) became called functions instead of inline bodies. `
    + `Raise it with maxInline (or PARSEMAN_MAX_INLINE) if this rule is hot.`)
}

// ---------------------------------------------------------------------------
// Codegen context
// ---------------------------------------------------------------------------
type Ctx = {
  vars: number
  indent: number
  /** Coverage-only emission. Undefined for ordinary compile/macro output. */
  coverage?: { plan: GrammarCoveragePlan; entry?: Combinator<unknown> } | undefined
  activeCoverageRuleId?: string | undefined
  /** A generated named-rule wrapper emits failure after its `_pfail` boundary. */
  suppressCoverageFailure?: boolean | undefined
  /**
   * Compile-time recovery gate (opt-in via `compile(g, { recovery: true })`).
   * When off (default) NO recovery code is emitted — byte-identical output, and
   * `runtimeParsers` stays empty so macro-inlining is unaffected. When on, lists
   * emit a `_ctx._tolerant`-gated recovery branch and sequences publish an inferred
   * sync sentinel; the machinery is dormant unless the parse is run tolerant.
   */
  recovery?: boolean | undefined
  /**
   * Compile-time HOST MODE (opt-in via `compile(g, { hostMode: 'cst' })`), exactly the
   * shape of the `recovery` gate above.
   *
   * A `node()` with its OWN build is re-routed through a positioned-CST `ctx.build`
   * host when that host marks itself `_parsemanCstOutput` — that is what lets ONE
   * grammar serve eval-AST and positioned-CST/language-service modes. But `ctx.build`
   * arrives at PARSE time, so asking "is a CST host installed?" was a per-node property
   * chain on the hot path of every grammar, even though an eval-AST parse can never
   * take that branch. Measured, that per-node read is enough to move which large
   * compiled functions V8 elects to optimize.
   *
   * The mode is knowable at compile time, so it is decided there:
   *   - `'ast'` (default) — direct builders own their result. The `_parsemanCstOutput`
   *     ternary and the `_dcst` host probe are not emitted at all; capture follows the
   *     builder's arity alone. Byte-identical to a build with no host machinery.
   *   - `'cst'` — direct builders always build through the host, and the collectors the
   *     host reads are captured unconditionally. No per-node probing either way.
   *
   * Misuse cannot be silent: driving an `'ast'` artifact with a positioned-CST host
   * throws (see `assertHostModeCompatible`) rather than producing a thin tree.
   */
  hostMode?: HostMode | undefined
  /**
   * Compile-time line-start tracking gate. When false/undefined, generated parser
   * source contains no line tracking helper, branches, or terminal call sites.
   * When true, successful newline-capable terminals append line starts to
   * `_ctx._lineStarts`; the driver normalizes once before span annotation.
   */
  lineTracking?: boolean | undefined
  /** Regex declarations hoisted to module scope */
  regexDecls: string[]
  /** Shared dispatch helpers already hoisted for this artifact. */
  dispatchHelpers?: Set<SharedHelper>
  /** Per-artifact counter naming each dispatch site's tables. */
  dispatchTrieCount?: number
  /** Dedup map: "source/flags" → variable name (_re0 etc.) */
  regexMap: Map<string, string>
  /** Frozen constant expected-set arrays hoisted to module scope (_fx0 etc.) */
  expectedDecls: string[]
  /** Dedup map: array source → hoisted const name */
  expectedMap: Map<string, string>
  /** Map functions that need to be captured at compile time */
  mapFns: Array<(v: unknown, span: { start: number; end: number }) => unknown>
  /**
   * Source text of each map function, captured in lockstep with `mapFns`
   * (parallel array). Populated from `def.fnSrc` when present — lets the macro
   * inline transform callbacks in codegen-traversal order without a fragile
   * pre-accumulated positional array. `null` entries mean the source was not
   * available (interpreter/compile() path with no macro source).
   */
  mapFnSrcs: Array<string | null>
  /** Runtime parser fallbacks (for unknown/_def-less parsers) */
  runtimeParsers: Array<Combinator<unknown>>
  /** Whether any node() elided trivia capture and needs the shared frozen empty log. */
  needsEmptyTl?: boolean | undefined
  /** Whether any structural node() arity-gates host capture and needs the `_hostReads` helper. */
  needsHostReads?: boolean | undefined
  needsRawEntry?: boolean | undefined
  /** Whether any emitted terminal needs the dynamic `_trackLines` helper. */
  needsLineTrack?: boolean | undefined
  /** Whether generated code materializes line/column fields into span objects. */
  needsLineSpan?: boolean | undefined
  /** Set when a DIRECT builder's positioned-CST branch was omitted (host mode 'ast'). */
  hostBranchElided?: boolean | undefined
  /** Lazy/ref parsers and trivia helpers: parser identity → generated function name */
  namedParsers: Map<Combinator<unknown>, string>
  /**
   * Rule-map composition (linkable form): the `ref` placeholder for each named
   * rule → its canonical `_r_<Name>` function name. When a `lazy`/`ref` in
   * `emitLazy` is one of these, it is emitted once as `_r_<Name>` (never inlined,
   * so it stays addressable/overridable by name) and siblings call it by that
   * name — so the whole map fuses into one scope with direct local calls. Unset
   * for single-combinator `compile()` (no rule map → today's `_pfN` naming).
   */
  ruleNames?: Map<Combinator<unknown>, string> | undefined
  /**
   * Namespace prefix for HOISTED closure-level names (`_re`, `_fx`, `_pf`, `_mf`,
   * `_build`) so two independently-compiled rule maps fuse into one scope without
   * colliding (the linkable form). Empty by default → byte-identical output.
   * Function-local vars (`_v`/`_e`/…) are per-scope and never namespaced; the
   * sentinel protocol (`_NAMED_FN_*`), `_EMPTY_TL` are SHARED across
   * fused packages (a namespaced sentinel would break cross-package calls) and so
   * are also left un-prefixed; `_r_<Name>` is the composition surface (intended
   * collision = override) and is never prefixed.
   */
  ns?: string | undefined
  /**
   * Linkable (compose) mode: a `choice` arm that is a named rule REF must not bake
   * an inline first-set dispatch guard — the referenced rule can be overridden at
   * fuse time, changing its first-set. Instead emit a `/*@FS:rule:codevar@*​/true`
   * placeholder that fusedBody() substitutes with the WINNING rule's first-set
   * condition (or leaves `true` = always-try when unknown). Off for monolithic
   * compile() / compileRuleMap where rules are final.
   */
  deferFirstSetRefs?: boolean | undefined
  /** Generated function declaration strings, prepended before the main body */
  namedFnDecls: string[]
  /** Active trivia parser (set by grammar() wrappers, cleared on exit) */
  activeTrivia?: Combinator<unknown> | undefined
  /**
   * Active grammar-level ambient scan-skip (from `rules({ scanSkip })`), seeded at
   * the grammar-seed sites alongside `activeTrivia`. `emitScanTo` bakes it (with
   * `activeTrivia`) in front of a scan's per-call skip list so the compiled scan
   * matches the interpreter's `resolveScanSkip`.
   */
  activeScanSkip?: Combinator<unknown>[] | undefined
  /**
   * The set of balanced() combinators whose ambient interior is CURRENTLY being
   * rebuilt (the active rebuild stack). A precise, identity-keyed cycle guard: the
   * ambient rebuild is suppressed ONLY when re-entering a balanced already on this
   * stack (the true self-cycle — a balanced that is a MEMBER of its own
   * `activeScanSkip`), which then emits in its eager (non-ambient) form. A NESTED
   * DIFFERENT balanced (not on the stack) still gets its own ambient rebuild, so it
   * keeps skipping ambient opaque units — matching the interpreter. Entries are
   * added on rebuild entry and removed on exit (finally). `activeScanSkip` is fixed
   * within one rebuild chain, so keying on the balanced identity is precise.
   */
  balancedRebuildStack?: Set<Combinator<unknown>> | undefined
  /** Label table from grammar trivia for default ParseContext. */
  triviaKindLabels?: readonly string[] | undefined
  /** Whether grammar-level trivia was built by `classifiedTrivia()`. */
  rootTriviaClassified?: true | undefined
  /**
   * Whether this compile contains any node() rule. When true, terminals emit a
   * `_ctx._cstLeaves` capture and trivia skips capture trivia tokens — flowing
   * through `_ctx` so capture crosses named-function (ref) boundaries correctly.
   * When false (no node() anywhere) NO capture code is emitted, so non-CST
   * grammars compile byte-identically to before.
   */
  capturing?: boolean | undefined
  /** Inside the trivia-capture fn: terminals emit CSTTrivia tokens, not leaves. */
  capAsTrivia?: boolean | undefined
  /**
   * Set on a transient probe ctx (e.g. scanTo's `capturing: false` sentinel/skip
   * probe) where emitted code must have NO capture side effects. Suppresses
   * shared-combinator hoisting so a probe never defines — nor reuses — a named
   * function compiled in the surrounding capturing context (whose runtime-gated
   * `_cstLeaves` push would fire during the probe).
   */
  noHoist?: boolean | undefined
  /**
   * Inline-expansion cap. See {@link INLINE_MAX_NODES}. `inlineMax` is the per-emitted-
   * function budget in approximate combinator nodes; `inlineLeft` is what remains of it
   * inside the function currently being emitted. Both are plain numbers derived from the
   * grammar and the configured cap — nothing here reads a clock, a map iteration order,
   * or the environment at emit time, so two compiles of one grammar make the same
   * decisions in the same order.
   */
  inlineMax: number
  inlineLeft: number
  /** Name of the emitted function currently being filled — reported when the cap binds. */
  currentFnName?: string | undefined
  /** Trivia parser → name of its capturing variant fn (separate from namedParsers). */
  triviaCaptureNames: Map<Combinator<unknown>, string>
  /**
   * Trivia parser → name of its fast number-returning variant fn (non-capturing
   * mode). Returns the new position directly instead of a {ok,value,span} object,
   * eliminating two object allocations per trivia skip.
   */
  triviaFnNames: Map<Combinator<unknown>, string>
  /** node() build functions captured at compile time (parallel to buildSrcs). */
  buildFns: Array<(children: ReadonlyArray<unknown>, fields: FieldMap | undefined, span: { start: number; end: number }, raw: ReadonlyArray<unknown>, triviaLog: readonly number[], state: unknown) => unknown>
  /** Source text of each build fn (set from def.buildSrc; null when unavailable). */
  buildSrcs: Array<string | null>
  /**
   * When set, `failStmt` emits `break <label>` instead of `return { ok: false }`.
   * Used by emitFallible to let labeled blocks act as the failure boundary.
   */
  failLabel?: string | undefined
  /**
   * Whether a leaf failure should record its payload into `_ctx._fe`/`_ctx._fx`
   * for an enclosing reader (node/choice/ref/withCtx/runtime) to propagate.
   * Swallowers (optional, many/sepBy loop bodies, not) set this false around the
   * sub-parse whose failure they discard, so the hot path pays nothing. Default
   * true (safe: always record). Only meaningful together with `failLabel`.
   */
  recordFail: boolean
  /**
   * sharedPrefix strategy: leading-terminal combinator instance → the once-computed
   * value/end variable names to REPLAY at its emit site (instead of re-scanning).
   * Registered by emitSharedPrefix around the arm-loop emission and cleared after,
   * so it is only active for the arms of a single shared-prefix choice. Undefined on
   * every other path → no interception, byte-identical output.
   */
  replayPrefix?: Map<Combinator<unknown>, { valVar: string; endVar: string }> | undefined
  /**
   * Active dispatch selector for an inlined `routed()` site. Branches that cross
   * generated function boundaries still use `_ctx._routed`; inlined branches can
   * read these locals directly and avoid the object write/read/restore round trip.
   */
  routedLocal?: { valueVar: string; startVar: string; endVar: string } | undefined
  /**
   * Precomputed by analyzeLazyUsage() before codegen starts. emitLazy consults
   * this to inline a single-use, non-recursive ref directly at its call site
   * instead of hoisting it into a named function. Undefined when compile()
   * hasn't run the pre-pass (should not happen in practice — always set in
   * compile() — but kept optional so emitLazy degrades to "always named" if
   * ever invoked without it, e.g. future direct unit tests of emitLazy).
   */
  lazyUsage?: {
    counts: Map<Combinator<unknown>, number>
    recursive: Set<Combinator<unknown>>
    /** Approx subtree node count (lazy refs counted as 1 leaf), memoized. Gates
     * shared-combinator hoisting: only subtrees big enough that de-duplicating
     * them beats the added call cost are hoisted; tiny shared wrappers stay inline. */
    sizes: Map<Combinator<unknown>, number>
  }
}

/**
 * Selected-root retention is an opt-in grammar capability.  Keep it entirely
 * out of generated code for ordinary trivia grammars: their scanner still gets
 * structural fast paths, but they have neither a category table nor a root log
 * to save, restore, or branch on.
 */
function hasSelectedRootTrivia(ctx: Ctx): boolean {
  return ctx.rootTriviaClassified === true
}

function v(ctx: Ctx, prefix = '_v'): string { return `${prefix}${ctx.vars++}` }
function ind(ctx: Ctx): string { return '  '.repeat(ctx.indent) }

/** Namespace prefix for hoisted closure-level names (empty unless linkable). */
function nsp(ctx: Ctx): string { return ctx.ns ?? '' }
/** Hoisted map-fn array name (`_mf`, namespaced in linkable mode). */
function mfRef(ctx: Ctx): string { return `${nsp(ctx)}_mf` }
/** Hoisted build-fn array name (`_build`, namespaced in linkable mode). */
function buildRef(ctx: Ctx): string { return `${nsp(ctx)}_build` }

/** Re-indent emitted lines to an absolute depth while preserving relative nesting. */
function reindentStmts(stmts: string[], targetLevels: number): string[] {
  const nonEmpty = stmts.filter(s => s.trim().length > 0)
  if (nonEmpty.length === 0) return stmts
  const minLeading = Math.min(...nonEmpty.map(s => s.length - s.trimStart().length))
  const targetPrefix = '  '.repeat(targetLevels)
  return stmts.map(s => (s.trim().length === 0 ? '' : targetPrefix + s.slice(minLeading)))
}

function failReturn(ctx: Ctx, expected: string, posExpr: string): string {
  if (ctx.lineTracking) return `return { ok: false, expected: [${expected}], span: ${emitSpanExpr(ctx, posExpr, posExpr)} }`
  return `return { ok: false, expected: [${expected}], span: { start: ${posExpr}, end: ${posExpr} } }`
}

function failReturnArr(ctx: Ctx, expectedArr: string, posExpr: string): string {
  if (ctx.lineTracking) return `return { ok: false, expected: ${expectedArr}, span: ${emitSpanExpr(ctx, posExpr, posExpr)} }`
  return `return { ok: false, expected: ${expectedArr}, span: { start: ${posExpr}, end: ${posExpr} } }`
}

function committedReturnArr(ctx: Ctx, expectedArr: string, posExpr: string): string {
  if (ctx.lineTracking) return `return { ok: false, expected: [...${expectedArr}], span: ${emitSpanExpr(ctx, posExpr, posExpr)}, committed: true }`
  return `return { ok: false, expected: [...${expectedArr}], span: { start: ${posExpr}, end: ${posExpr} }, committed: true }`
}

/**
 * Hoist a COMPILE-TIME-CONSTANT expected-set array to a shared module-level
 * const and return its variable name. Leaf failures (literal, regex, keyword,
 * not, …) have a fixed expected set, so recording it on the hot failure path
 * must NOT allocate a fresh array every time — a choice arm that misses or a
 * many/sepBy loop that terminates hits this on essentially every token. We store
 * a reference to the shared array instead (one pointer write, zero allocation).
 *
 * The shared array is NEVER mutated in place by generated code, and every path
 * that surfaces `_ctx._fx` as a user-facing ParseResult copies it first (see
 * `resultFromRecorded` / the dynamic direct-return in `failArrBody`), so the
 * public `expected` array stays fresh & independent. (We deliberately do NOT
 * `Object.freeze` it: a user grammar may define a rule named `Object`, which —
 * once inlined as a local — would shadow the global and break the freeze call.)
 */
function hoistExpected(ctx: Ctx, constArrSource: string): string {
  let name = ctx.expectedMap.get(constArrSource)
  if (name === undefined) {
    name = `${nsp(ctx)}_fx${ctx.expectedDecls.length}`
    ctx.expectedDecls.push(`const ${name} = ${constArrSource}`)
    ctx.expectedMap.set(constArrSource, name)
  }
  return name
}

/**
 * Compiled mirror of the interpreter's `failAt` (probe.ts): a `_ctx._probe`-gated
 * furthest-failure update emitted at leaf-fail sites when IDE support is compiled in
 * (`ctx.recovery`). A deeper failure replaces the best; a tie MERGES expected arrays
 * (so choice arms aggregate their alternatives). Fires even inside swallowers
 * (`recordFail` off) — a completion's deepest failure is often inside an optional/
 * many. Dormant unless `completionsAt` set `_ctx._probe`, so a normal/tolerant parse
 * pays one property read per leaf fail. Empty (no side effects) when recovery is off.
 */
function probeUpdate(ctx: Ctx, expectedArr: string, posExpr: string, constant = true): string {
  if (!ctx.recovery) return ''
  const fx = constant ? hoistExpected(ctx, expectedArr) : expectedArr
  const pb = v(ctx, '_pb')
  return `if (_ctx._probe !== undefined && ${posExpr} <= _ctx._probe.offset) { const ${pb} = _ctx._probe.best; if (${pb} === null || ${posExpr} > ${pb}.span.start) _ctx._probe.best = { ok: false, expected: [...${fx}], span: { start: ${posExpr}, end: ${posExpr} } }; else if (${posExpr} === ${pb}.span.start) _ctx._probe.best = { ok: false, expected: [...${pb}.expected, ...${fx}], span: { start: ${posExpr}, end: ${posExpr} } } } `
}

function failBody(ctx: Ctx, expected: string, posExpr: string): string {
  // Record the failure payload before breaking so an enclosing composite
  // construct can propagate this (deepest) failure verbatim — parity with the
  // interpreter, which returns the inner failure result. Recording is skipped
  // when no consumer will read it (see `ctx.recordFail`): swallowers like
  // optional/many/sepBy/not never inspect `_ctx._fx`, so a leaf failing inside
  // them just breaks — the hot path (loop terminations, first-arm misses) pays
  // nothing. The direct-return path is the final answer and needs no recording.
  const probe = probeUpdate(ctx, `[${expected}]`, posExpr)
  const trace = ctx.activeCoverageRuleId === undefined ? '' : `_ctx._grammarTrace?.write({ id: ${JSON.stringify(ctx.activeCoverageRuleId)}, phase: 'failure', offset: ${posExpr} }); `
  if (ctx.failLabel) {
    if (!ctx.recordFail) return probe ? `{ ${probe}${trace}break ${ctx.failLabel} }` : trace ? `{ ${trace}break ${ctx.failLabel} }` : `break ${ctx.failLabel}`
    return `{ ${probe}_ctx._fe = ${posExpr}; _ctx._fx = ${hoistExpected(ctx, `[${expected}]`)}; ${trace}break ${ctx.failLabel} }`
  }
  return probe + trace + failReturn(ctx, expected, posExpr)
}

/**
 * Like {@link failBody} but the caller already has an array source. When
 * `constant` (the default), the array is hoisted+frozen (zero-alloc hot path).
 * Pass `constant: false` for dynamic sources (e.g. `_ctx._fx`, a runtime concat)
 * that must be assigned verbatim.
 */
function failArrBody(ctx: Ctx, expectedArr: string, posExpr: string, constant = true): string {
  const probe = probeUpdate(ctx, expectedArr, posExpr, constant)
  const trace = ctx.activeCoverageRuleId === undefined ? '' : `_ctx._grammarTrace?.write({ id: ${JSON.stringify(ctx.activeCoverageRuleId)}, phase: 'failure', offset: ${posExpr} }); `
  if (ctx.failLabel) {
    if (!ctx.recordFail) return probe ? `{ ${probe}${trace}break ${ctx.failLabel} }` : trace ? `{ ${trace}break ${ctx.failLabel} }` : `break ${ctx.failLabel}`
    const fx = constant ? hoistExpected(ctx, expectedArr) : expectedArr
    return `{ ${probe}_ctx._fe = ${posExpr}; _ctx._fx = ${fx}; ${trace}break ${ctx.failLabel} }`
  }
  // Direct-return (no enclosing fail label). A dynamic source may reference the
  // shared frozen `_ctx._fx`; copy it so the (possibly frozen) constant never
  // escapes into a user-facing result. Constant sources are inline literals.
  if (!constant) return `${probe}${trace}return { ok: false, expected: [...${expectedArr}], span: ${ctx.lineTracking ? emitSpanExpr(ctx, posExpr, posExpr) : `{ start: ${posExpr}, end: ${posExpr} }`} }`
  return probe + trace + failReturnArr(ctx, expectedArr, posExpr)
}

/** Build a ParseResult from the recorded deepest failure, copying `_fx` so the
 * shared frozen array never escapes into user-facing results. */
function resultFromRecorded(ctx: Ctx, feExpr = '_ctx._fe', fxExpr = '_ctx._fx'): string {
  const spanExpr = ctx.lineTracking ? emitSpanExpr(ctx, feExpr, feExpr) : `{ start: ${feExpr}, end: ${feExpr} }`
  return `return { ok: false, expected: [...${fxExpr}], span: ${spanExpr}, ...(_ctx._fc ? { committed: true } : {}) }`
}

function committedFailBody(ctx: Ctx, expectedArr = '_ctx._fx', posExpr = '_ctx._fe'): string {
  if (ctx.failLabel) {
    if (!ctx.recordFail) return `{ _ctx._fc = true; break ${ctx.failLabel} }`
    return `{ _ctx._fc = true; _ctx._fe = ${posExpr}; _ctx._fx = ${expectedArr}; break ${ctx.failLabel} }`
  }
  return committedReturnArr(ctx, expectedArr, posExpr)
}

/**
 * Propagate the already-recorded deepest failure (`_ctx._fe`/`_ctx._fx`) rather
 * than synthesizing a coarse `["node"]`-style placeholder. Used by composite
 * constructs whose interpreter counterpart returns the inner failure verbatim
 * (node, ref/lazy, withCtx, runtime fallback). `srcCtx` is the ctx var holding
 * the payload (`_ctx`, or a spread child ctx for withCtx).
 */
function propagateFailBody(ctx: Ctx, srcCtx = '_ctx'): string {
  if (srcCtx !== '_ctx') {
    // withCtx ran on a spread child ctx; copy its recorded failure back (only
    // when a consumer will read it) before propagating.
    if (ctx.failLabel) {
      if (!ctx.recordFail) return `break ${ctx.failLabel}`
      return `{ _ctx._fe = ${srcCtx}._fe; _ctx._fx = ${srcCtx}._fx; _ctx._fc = ${srcCtx}._fc; break ${ctx.failLabel} }`
    }
    return `{ _ctx._fe = ${srcCtx}._fe; _ctx._fx = ${srcCtx}._fx; _ctx._fc = ${srcCtx}._fc; ${resultFromRecorded(ctx)} }`
  }
  // Same-ctx: `_ctx._fx` already holds the deepest failure — just break/return.
  if (ctx.failLabel) return `break ${ctx.failLabel}`
  return resultFromRecorded(ctx)
}

function emitIfFail(ctx: Ctx, cond: string, body: string): string[] {
  return [
    `${ind(ctx)}if (${cond}) {`,
    `${ind(ctx)}  ${body}`,
    `${ind(ctx)}}`,
  ]
}

function emitElseFail(ctx: Ctx, body: string): string[] {
  return [
    `${ind(ctx)}else {`,
    `${ind(ctx)}  ${body}`,
    `${ind(ctx)}}`,
  ]
}

/** Sentinel + end-position slot for compiled `rules()` / `withCtx` named fns. */
const NAMED_FN_FAIL = '_pfFail'
const NAMED_FN_END = '_pfEnd'

function namedFnPrelude(): string[] {
  return [`const ${NAMED_FN_FAIL} = {}`, `let ${NAMED_FN_END}`]
}

function pushNamedFnDecl(
  ctx: Ctx,
  fnName: string,
  bodyStmts: string[],
  valueVar: string,
  endVar: string,
  failureRuleId?: string,
): void {
  // Success path returns the value DIRECTLY (setting the shared end slot first);
  // failure breaks `_pfail` and falls through to the sentinel return. No `_pfok`
  // flag / post-block check — fewer ops on the hot (matched) path, and smaller.
  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx) {`,
    `  _pfail: {`,
    ...reindentStmts(bodyStmts, 2),
    `    ${NAMED_FN_END} = ${endVar}`,
    `    return ${valueVar}`,
    `  }`,
    ...(failureRuleId === undefined
      ? []
      : [`  _ctx._grammarTrace?.write({ id: ${JSON.stringify(failureRuleId)}, phase: 'failure', offset: _ctx._fe ?? _pos })`]),
    `  return ${NAMED_FN_FAIL}`,
    `}`,
  ].join('\n'))
}

function emitNamedFnCall(ctx: Ctx, fnName: string, pos: string): ER {
  const vv = v(ctx, '_pfv')
  const ev = v(ctx, '_pfe')
  return {
    stmts: [
      `${ind(ctx)}const ${vv} = ${fnName}(input, ${pos}, _ctx)`,
      // ref/lazy returns the inner failure verbatim — propagate the recorded
      // deepest failure (shares _ctx with the named fn), not a "parser" label.
      ...emitIfFail(ctx, `${vv} === ${NAMED_FN_FAIL}`, propagateFailBody(ctx)),
      `${ind(ctx)}const ${ev} = ${NAMED_FN_END}`,
    ],
    valueVar: vv,
    endVar: ev,
  }
}

/**
 * Emit a spanned-leaf capture into the active node()'s collectors (via _ctx,
 * matching the interpreter). Emitted only in a capturing compile; the runtime
 * `if (_ctx._cstLeaves)` guard means terminals outside a node() pay one
 * predictable branch and nothing else.
 */
function emitLeafCapture(ctx: Ctx, valExpr: string, startExpr: string, endExpr: string): string[] {
  if (!ctx.capturing) return []
  if (ctx.capAsTrivia) return []
  const i = ind(ctx)
  const lf = v(ctx, '_lf')
  const spanExpr = emitSpanExpr(ctx, startExpr, endExpr)
  // Gate on EITHER collector: a structural node whose host reads only
  // `rawChildren` (see `_parsemanReadsChildren`) elides `_cstLeaves`/`_cstChildren`
  // but still needs its terminals in `_cstRawChildren`. When both are present the
  // single leaf object is shared by both pushes — identical to the prior output.
  return [
    `${i}if (_ctx._cstLeaves || _ctx._cstRawChildren) {`,
    `${i}  const ${lf} = { _tag: 'leaf', value: ${valExpr}, span: ${spanExpr} }`,
    `${i}  if (_ctx._cstLeaves) _ctx._cstLeaves.push(${lf})`,
    `${i}  if (_ctx._cstRawChildren) _ctx._cstRawChildren.push(${lf})`,
    `${i}}`,
  ]
}

function emitSpanExpr(ctx: Ctx, startExpr: string, endExpr: string): string {
  if (!ctx.lineTracking) return `{ start: ${startExpr}, end: ${endExpr} }`
  ctx.needsLineSpan = true
  return `_spanLines(_ctx, ${startExpr}, ${endExpr})`
}

function emitLineTrack(ctx: Ctx, startExpr: string, endExpr: string): string[] {
  if (!ctx.lineTracking) return []
  ctx.needsLineTrack = true
  return [`${ind(ctx)}_trackLines(_ctx, input, ${startExpr}, ${endExpr})`]
}

function emitLiteralLineTrack(ctx: Ctx, startExpr: string, value: string): string[] {
  if (!ctx.lineTracking) return []
  const lineDeltas: number[] = []
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) lineDeltas.push(i + 1)
  }
  if (lineDeltas.length === 0) return []
  const fromV = v(ctx, '_ltFrom')
  const endExpr = value.length === 0 ? startExpr : `${startExpr} + ${value.length}`
  return [
    `${ind(ctx)}const ${fromV} = _ctx._lineScannedTo ?? 0`,
    `${ind(ctx)}if (${endExpr} > ${fromV}) {`,
    `${ind(ctx)}  for (let i = ${fromV}; i < ${startExpr}; i++) if (input.charCodeAt(i) === 10) _ctx._lineStarts.push(i + 1)`,
    ...lineDeltas.map(delta => {
      const lineStart = `${startExpr} + ${delta}`
      return `${ind(ctx)}  if (${lineStart} > ${fromV}) _ctx._lineStarts.push(${lineStart})`
    }),
    `${ind(ctx)}  _ctx._lineScannedTo = ${endExpr}`,
    `${ind(ctx)}}`,
  ]
}

function ensureRegexDecl(ctx: Ctx, source: string, flags: string): string {
  const f = 'y' + flags.replace(/[gy]/g, '')
  const key = `${source}/${f}`
  let rName = ctx.regexMap.get(key)
  if (rName === undefined) {
    rName = `${nsp(ctx)}_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${rName} = /${source}/${f}`)
    ctx.regexMap.set(key, rName)
  }
  return rName
}

function ensurePlainRegexDecl(ctx: Ctx, source: string, flags: string): string {
  const f = flags.replace(/[gy]/g, '')
  const key = `${source}/${f}`
  let rName = ctx.regexMap.get(key)
  if (rName === undefined) {
    rName = `${nsp(ctx)}_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${rName} = ${new RegExp(source, f).toString()}`)
    ctx.regexMap.set(key, rName)
  }
  return rName
}

/**
 * When `cap` is truthy, also records `[start, end]` into `_ctx._triviaLog`, and
 * when `cap === 1` also records the CST insert index into `_ctx._cstTriviaLog`.
 * `cap === 2` is the public root-log-only path used by non-node run() entries.
 * One emitted function serves every skip/capture call site — no duplicate trivia
 * parser tree, no _tc wrapper call.
 */
function ensureTriviaFn(ctx: Ctx): string {
  const trivia = ctx.activeTrivia!
  const existing = ctx.triviaFnNames.get(trivia)
  if (existing) return existing
  // Namespaced like every other hoisted name (`_re`/`_pf`/`_fx`): two fused pieces
  // each define their own `_tf0` (e.g. CSS block-only vs Less block+line trivia),
  // so without the ns prefix they collide in the fused scope and the wrong trivia
  // skipper wins. `nsp(ctx)` is '' for standalone output (byte-identical).
  const fnName = `${nsp(ctx)}_tf${ctx.triviaFnNames.size}`
  ctx.triviaFnNames.set(trivia, fnName)
  ctx.triviaCaptureNames.set(trivia, fnName)

  const labeledSpec = analyzeLabeledTrivia(trivia)

  // UNLABELED trivia: any scannable shape set → char-scan loop with a single
  // whole-run [start,end] capture (no per-arm kinds needed).
  if (!labeledSpec) {
    const fastShapes = analyzeTriviaFastPath(trivia)
    if (fastShapes) {
      ctx.namedFnDecls.push(buildFastTriviaFnDecl(fnName, fastShapes))
      return fnName
    }
  } else {
    // LABELED trivia: if every arm is scannable, the same char-scan loop with
    // per-chunk category capture. Recognition is structural; labels are data.
    // Otherwise fall to the regex/runtime kind-tracking loops.
    const labeledShapes = analyzeLabeledScannableRun(trivia)
    if (labeledShapes) {
      ctx.namedFnDecls.push(buildLabeledScannableTriviaFnDecl(fnName, labeledShapes))
      return fnName
    }

    const regexSpec = labeledTriviaRegexArms(trivia)
    if (regexSpec) {
      const reNames: string[] = []
      for (const arm of regexSpec.arms) {
        const def = arm.parser._def
        if (def.tag !== 'regex') break
        reNames.push(ensureRegexDecl(ctx, def.source, def.flags))
      }
      if (reNames.length === regexSpec.arms.length) {
        ctx.namedFnDecls.push(buildLabeledRegexTriviaFnDecl(fnName, regexSpec, reNames))
        return fnName
      }
    }

    const rpStart = ctx.runtimeParsers.length
    for (const arm of labeledSpec.arms) {
      ctx.runtimeParsers.push(arm.parser)
    }
    ctx.namedFnDecls.push(buildLabeledRuntimeTriviaFnDecl(fnName, labeledSpec, rpStart))
    return fnName
  }

  const savedIndent    = ctx.indent
  const savedFailLabel = ctx.failLabel
  const savedTrivia    = ctx.activeTrivia
  const savedScanSkip  = ctx.activeScanSkip
  const savedCapAsTrivia = ctx.capAsTrivia
  ctx.indent    = 2
  ctx.failLabel = '_triv'
  ctx.capAsTrivia = true  // trivia terminals must not push into _cstLeaves
  ctx.activeTrivia = undefined  // trivia parser must not skip trivia within itself
  ctx.activeScanSkip = undefined  // nor consult ambient scan-skip within trivia
  const r = emit(trivia, ctx, '_pos')
  ctx.indent    = savedIndent
  ctx.failLabel = savedFailLabel
  ctx.capAsTrivia = savedCapAsTrivia
  ctx.activeTrivia = savedTrivia
  ctx.activeScanSkip = savedScanSkip

  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    `  _triv: {`,
    ...reindentStmts(r.stmts, 2),
    `    _e = ${r.endVar}`,
    `  }`,
    `  if (_cap && _e > _pos) {`,
    `    if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_pos, _e)`,
    `    if (_cap === 1 && _ctx._cstTriviaLog !== undefined && _ctx.captureTrivia) _ctx._cstTriviaLog.push(_pos, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0)`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n'))
  return fnName
}

/** Capturing trivia skip — same compiled fn as ensureTriviaFn, pass `_cap = 1`. */
function ensureTriviaCaptureFn(ctx: Ctx): string {
  return ensureTriviaFn(ctx)
}

// ---------------------------------------------------------------------------
// The result every emitter returns.
// After the emitted stmts, `valueVar` holds the parsed value and `endVar`
// holds the new position. On failure the emitter already emitted an early
// `return failResult`.
// ---------------------------------------------------------------------------
type ER = { stmts: string[]; valueVar: string; endVar: string }
type FallibleER = { stmts: string[]; okVar: string; valVar: string; endVar: string; mayCommit: boolean }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function firstSetCond(codeVar: string, fs: FirstSet): string {
  if (fs.kind === 'any') return 'true'
  if (fs.kind === 'empty') return 'false'
  return fs.ranges.map(r =>
    r.lo === r.hi
      ? `${codeVar} === ${r.lo}`
      : `(${codeVar} >= ${r.lo} && ${codeVar} <= ${r.hi})`
  ).join(' || ')
}

// A first code point that keys a switch case is only worth enumerating when the
// arm dispatches on a few DISCRETE points (keyword/operator first chars). A wide
// range (a char-class arm like `[a-z]+`) would explode into dozens of `case`
// labels, so those keep the if/else range-comparison form.
const SWITCH_RANGE_LIMIT = 4
const SWITCH_MAX_CASES = 48
const SWITCH_MIN_CASES = 3

// Benchmark/test-only hook: force the `if/else if` disjoint-dispatch form so it
// can be A/B'd against the `switch` jump table in the same process. Defaults to
// off — production always uses planDisjointDispatch. See bench/codegen-ab.ts.
let _forceDisjointIf = false
export function __setForceDisjointIf(on: boolean): void { _forceDisjointIf = on }

// Test/bench-only: force a `sharedPrefix` choice to compile as ordered `firstMatch`
// (each arm re-scans the shared prefix), so the shared-once form can be A/B'd against
// it in the same process. Defaults to off. See bench/shared-prefix-ab.ts.
let _forceNoSharedPrefix = false
export function __setForceNoSharedPrefix(on: boolean): void { _forceNoSharedPrefix = on }

/**
 * Choose the dispatch form for a *disjoint* choice. Returns per-arm case code
 * points for a `switch` (jump table) when every arm keys off a small discrete
 * set, or `if` to keep the range-comparison `if/else if` chain. The arms are
 * pairwise-disjoint by construction, so each code point maps to exactly one arm.
 */
function planDisjointDispatch(
  parsers: ReadonlyArray<Combinator<unknown>>,
): { kind: 'switch'; cases: number[][] } | { kind: 'if' } {
  const cases: number[][] = []
  let total = 0
  for (const p of parsers) {
    const fs = p._meta.firstSet
    if (fs.kind !== 'ranges') return { kind: 'if' } // any/empty → no discrete keys
    const pts: number[] = []
    for (const r of fs.ranges) {
      if (r.hi - r.lo + 1 > SWITCH_RANGE_LIMIT) return { kind: 'if' }
      for (let cp = r.lo; cp <= r.hi; cp++) pts.push(cp)
    }
    total += pts.length
    if (total > SWITCH_MAX_CASES) return { kind: 'if' }
    cases.push(pts)
  }
  return total >= SWITCH_MIN_CASES ? { kind: 'switch', cases } : { kind: 'if' }
}

// ── CST/trivia capture rollback: cheap when no buffer is active ─────────────
// The four capture buffers (`_cstLeaves`, `_cstRawChildren`, `_cstTriviaLog`,
// `_triviaLog`) are usually all undefined on the hot path (a grammar with any
// node() compiles with ctx.capturing=true, but at runtime most callers don't
// request a CST — they only want the value). Reading `_x?.length ?? 0` four
// times per fallible block — and emitFallible runs for every sequence term,
// repeat item, optional, and choice arm — turned into a measurable de-opt
// (compiled CSS regressed ~2.3×). We gate the whole save/restore on a single
// boolean: when no buffer is live the marks are 0 and the restore is one test.
//
// Every restore below is emitted as `if (sink && sink.length !== mark) sink.length = mark`
// — never the bare `sink.length = mark`. Setting an array's `length` is NOT a
// plain field store: it goes through V8's length setter, which must consider
// trimming the backing store, and it costs the same whether or not the value
// changes. Rollbacks overwhelmingly restore a length that never moved (the
// speculative branch captured nothing), so the compare is the common path and
// the setter call is the rare one. `sink.length !== mark` is an in-object load
// plus an integer compare.
//
// This is not a micro-tuning nicety. `not()`'s rollback (0.34.0, correct and
// required) put six unconditional length stores on a probe that jess's Less
// grammar executes ~600 times per KB: +32% parse time on benchmark.less.
// Guarding the stores took that to +4%, and applying the same guard at ALL
// ~3000 rollback sites made 0.34.0 12% FASTER than 0.33.0 on the same corpus.
// Keep the guard when adding a rollback site.
/** One buffer to rewind: the buffer expression and the mark variable holding its saved length. */
type RestorePair = readonly [buffer: string, mark: string]

/**
 * The single emitter for every capture-restore chain in this file.
 *
 * Returns the guarded rewinds for `pairs`, in order, joined by `'; '` with NO
 * leading or trailing punctuation — each call site supplies its own, because the
 * sites differ (some sit bare inside `{ … }`, some need a trailing `'; '` so a
 * following clause can be concatenated). Keeping the punctuation at the call
 * site is what lets every site share this one emitter without changing a byte
 * of generated output.
 *
 * `ctx` is threaded through because the choice of emission strategy is a
 * whole-grammar property (see the size sweep): it is unused while every site
 * emits inline, and is the hook for hoisting a shared helper later.
 */
function emitRestore(_ctx: Ctx, pairs: readonly RestorePair[]): string {
  let out = ''
  for (let i = 0; i < pairs.length; i++) {
    const [buf, mark] = pairs[i]!
    if (i > 0) out += '; '
    out += `if (${buf} && ${buf}.length !== ${mark}) ${buf}.length = ${mark}`
  }
  return out
}

/** Body of a capture restore — resets each live buffer to its saved length. */
function captureRestoreBody(ctx: Ctx, mL: string, mR: string, mTl: string, mLg: string | null, mF: string | null = null, mRootLg: string | null = null): string {
  const pairs: RestorePair[] = [
    ['_ctx._cstLeaves', mL],
    ['_ctx._cstRawChildren', mR],
    ['_ctx._cstTriviaLog', mTl],
  ]
  if (mF) pairs.push(['_ctx._fields', mF])
  // `_triviaLog` is the standalone diagnostic trivia log. The interpreter only
  // rewinds it on a failed *choice* arm (choice.ts), NOT on a failed sequence
  // term — a sequence returns the failure with earlier trivia still logged. To
  // stay byte-for-byte at parity with the interpreter, only rewind it where the
  // interpreter does (choice arms); sequence-term rollbacks (emitFallible) leave
  // it intact.
  if (mLg) pairs.push(['_ctx._triviaLog', mLg])
  if (hasSelectedRootTrivia(ctx) && mRootLg) pairs.push(['_ctx._rootTriviaLog', mRootLg])
  return emitRestore(ctx, pairs)
}


/**
 * Emit `inner` as a labeled block with flat result variables — no IIFE call,
 * no `{ ok, value, span }` object allocation.  The returned stmts declare:
 *   let ${okVar} = false, ${valVar}, ${endVar} = ${pos}
 *   ${label}: { <inner stmts using break ${label} on failure>; capture success }
 * Callers read ${okVar} to branch on success/failure.
 */
function emitFallible(
  inner: Combinator<unknown>,
  ctx: Ctx,
  pos: string,
  /**
   * When true, the caller DISCARDS this failure (optional/many/sepBy/not) — the
   * inner leaves need not record `_ctx._fx`, since nobody reads it. Suppresses
   * the hot-path failure bookkeeping for the sub-parse.
   */
  swallow = false,
): FallibleER {
  const lbl  = v(ctx, '_lbl')
  const okV  = `${lbl}ok`
  const valV = `${lbl}v`
  const endV = `${lbl}e`

  const savedLabel  = ctx.failLabel
  const savedIndent = ctx.indent
  const savedRecord = ctx.recordFail
  ctx.failLabel = lbl
  ctx.indent    = savedIndent + 1
  if (swallow) ctx.recordFail = false
  const r = emit(inner, ctx, pos)
  ctx.failLabel = savedLabel
  ctx.indent    = savedIndent
  ctx.recordFail = savedRecord

  const ind0 = ind(ctx)
  // In capturing mode, roll back any CST captures made by a FAILED attempt — a
  // sub-parser may match terminals (e.g. a sequence that consumes '[') and then
  // fail on a later term, breaking out with those leaves/trivia still buffered.
  // Without this they leak into the enclosing node()'s children. (The non-disjoint
  // choice path does the same per-arm; a disjoint choice commits to one arm and
  // relies on this boundary to undo a failed commit.)
  //
  // The rollback is only needed when `inner` can push a capture and THEN fail
  // (i.e. leave partial buffered state). Atomic terminals, self-contained nodes,
  // choices/repeats that roll back internally, etc. never leave partial captures
  // — emitting the save/restore around every fallible block (every sequence term)
  // was a ~2.3× compiled-CSS regression. Gate it on the structural predicate so
  // hot grammars compile back to tight code while correctness is preserved.
  // A failed sequence term does NOT rewind `_triviaLog` (the interpreter leaves
  // earlier trivia logged) — only the CST child buffers are restored here.
  const needsRollback = ctx.capturing && mayLeavePartialCapture(inner, new Set(), ctx.activeTrivia !== undefined)
  const mayCommit = mayCommitFailure(inner)
  const needsFieldRollback = needsRollback && parserHasOwnFields(inner)
  const mL  = needsRollback ? v(ctx, '_fcl')  : null
  const mR  = needsRollback ? v(ctx, '_fcr')  : null
  const mTl = needsRollback ? v(ctx, '_fctl') : null
  const mF  = needsFieldRollback ? v(ctx, '_fcf')  : null
  const stmts = [
    `${ind0}let ${okV} = false, ${valV}, ${endV} = ${pos}`,
    ...(mL ? [
      `${ind0}const ${mL} = _ctx._cstLeaves?.length ?? 0`,
      `${ind0}const ${mR} = _ctx._cstRawChildren?.length ?? 0`,
      `${ind0}const ${mTl} = _ctx._cstTriviaLog?.length ?? 0`,
      ...(mF ? [`${ind0}const ${mF} = _ctx._fields?.length ?? 0`] : []),
    ] : []),
    ...(mayCommit ? [`${ind0}_ctx._fc = false`] : []),
    `${ind0}${lbl}: {`,
    ...r.stmts,
    `${ind0}  ${valV} = ${r.valueVar}; ${endV} = ${r.endVar}; ${okV} = true`,
    `${ind0}}`,
    ...(mL ? [
      `${ind0}if (!${okV}) { ${captureRestoreBody(ctx, mL, mR!, mTl!, null, mF)} }`,
    ] : []),
  ]
  return { stmts, okVar: okV, valVar: valV, endVar: endV, mayCommit }
}

// ---------------------------------------------------------------------------
// Per-combinator emitters
// ---------------------------------------------------------------------------

/**
 * Above this length, an unrolled `charCodeAt` chain stops paying for itself:
 * measured crossover where native `startsWith` wins on runtime is ~256–512
 * chars, but the unrolled chain's *generated source* grows ~4–30× faster than
 * `startsWith`'s near-constant call site (see PERF_IDEAS.md). No literal in a
 * real grammar (keywords, punctuation) gets remotely close to this — the
 * longest in this repo's example grammars is `important` (9 chars) — so this
 * threshold exists to cap codegen bloat on a pathological literal, not because
 * `startsWith` is faster there.
 */
const CHARCODE_CHAIN_MAX = 16

function emitLit(def: Extract<ParserDef, { tag: 'literal' }>, ctx: Ctx, pos: string): ER {
  const { value, caseInsensitive } = def
  const len = value.length
  const vv = v(ctx)
  const expectedStr = JSON.stringify(JSON.stringify(value))
  const stmts: string[] = []

  if (caseInsensitive && len > 0) {
    // ASCII case fold, the same `(c | 32) === lower` bit-OR compare that `/i`-flag
    // regex lowering uses (foldEq) — NOT Intl.Collator (measured ~9× slower, and
    // its Unicode accent-folding is the wrong semantic for a parser anyway). Folds
    // ASCII letters, exact-matches everything else. The captured value is the
    // input's own casing (slice), not the pattern's.
    const match = Array.from({ length: len }, (_, i) =>
      `(${foldEq(`input.charCodeAt(${pos}${i > 0 ? ` + ${i}` : ''})`, value.charCodeAt(i))})`
    ).join(' && ')
    stmts.push(
      ...emitIfFail(ctx, `${pos} + ${len} > input.length || !(${match})`, failBody(ctx, expectedStr, pos)),
      `${ind(ctx)}const ${vv} = input.slice(${pos}, ${pos} + ${len})`,
    )
  } else if (len === 0) {
    stmts.push(`${ind(ctx)}const ${vv} = ''`)
  } else if (len === 1) {
    const code = value.codePointAt(0)!
    stmts.push(
      ...emitIfFail(ctx, `${pos} >= input.length || input.charCodeAt(${pos}) !== ${code}`, failBody(ctx, expectedStr, pos)),
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  } else if (len <= CHARCODE_CHAIN_MAX) {
    const checks = Array.from({ length: len }, (_, i) =>
      `input.charCodeAt(${pos}${i > 0 ? ` + ${i}` : ''}) !== ${value.codePointAt(i)!}`
    ).join(' || ')
    stmts.push(
      ...emitIfFail(ctx, `${pos} + ${len} > input.length || ${checks}`, failBody(ctx, expectedStr, pos)),
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  } else {
    // startsWith(str, pos) avoids allocating a slice — it handles the bounds check
    // internally and compares in-place. No first-char guard needed either.
    stmts.push(
      ...emitIfFail(ctx, `!input.startsWith(${JSON.stringify(value)}, ${pos})`, failBody(ctx, expectedStr, pos)),
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  }

  const endVar = len === 0 ? pos : `${pos} + ${len}`
  stmts.push(...emitLiteralLineTrack(ctx, pos, value))
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

function escapeKeywordRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Fast path for `keywords()`/`word()`/`makeWord()`: each word is a FIXED
 * literal (optionally wrapped in the shared boundary lookahead), so this
 * reuses the exact `seq`/`litFold`/`lookahead` `ScanShape` machinery from
 * `scannable-run.ts` (PERF_IDEAS §8b) instead of one `RegExp.exec` alternation
 * per match. Unconditionally ambiguity-safe: `trailingBacktrackClass` treats a
 * single-literal `seq` and `litFold` as fixed-length (no quantifier to
 * backtrack), so wrapping either in a lookahead is safe for ANY boundary class
 * — no `seqIsUnambiguous`-style check is needed here.
 *
 * Declines (returns `null`, caller falls back to the regex alternation) for:
 *   - an empty-string keyword (degenerate; not worth special-casing)
 *   - a keyword containing an astral (surrogate-pair) code point — the `seq`/
 *     `litFold` codegen advances one `charCodeAt` UTF-16 unit per code POINT,
 *     which only holds for the BMP (same reason `scanShapeFromRegex` refuses
 *     the `u` flag entirely); real keyword sets are BMP identifiers, so this
 *     is a defensive, not a practical, limitation
 *   - a boundary class this file can't parse (defensive; `parseClassRanges`
 *     handles every realistic boundary string, e.g. `_0-9A-Za-z`)
 *   - `caseInsensitive` over a keyword containing a non-ASCII code point —
 *     `litFold` folds ASCII letters only, so `ä` would compile to an exact
 *     compare and never match `Ä` (the same hazard `caseFoldLiteralOrAlt`
 *     declines for regex-derived shapes)
 *   - `caseInsensitive` combined with a boundary — the boundary class would
 *     ALSO need ASCII case-folding to match the original regex's `/i` flag
 *     (the general "`/i` on a char class" problem, PERF_IDEAS §8d, not yet
 *     built), so this combination is left on the safe, slower path rather
 *     than risk silently narrowing which chars the boundary excludes.
 */
function emitKeywordsFast(def: Extract<ParserDef, { tag: 'keywords' }>, ctx: Ctx, pos: string): ER | null {
  if (def.words.length === 0 || def.words.some(w => w.length === 0)) return null
  if (def.words.some(w => Array.from(w).length !== w.length)) return null
  if (def.caseInsensitive && def.boundary) return null
  // `litFold` folds ASCII letters ONLY (scannable-run.ts `foldEq`), so a keyword
  // holding a non-ASCII code point with a case pair (ä/Ä, σ/Σ/ς) would compile to
  // an exact compare and silently miss the other case — while the interpreter's
  // `/iy` regex matches it. `caseFoldLiteralOrAlt` already declines exactly this
  // for regex-derived shapes; the keywords path had simply omitted the guard.
  if (def.caseInsensitive && def.words.some(w => w.split('').some(c => c.charCodeAt(0) > 127))) return null

  let boundary: { ranges: Array<[number, number]>; negated: boolean } | null = null
  if (def.boundary) {
    let body = def.boundary
    const negated = body.startsWith('^')
    if (negated) body = body.slice(1)
    const ranges = parseClassRanges(body)
    if (!ranges) return null
    boundary = { ranges, negated }
  }

  const mint: Mint = (prefix = '_v') => v(ctx, prefix)
  const lbl = v(ctx, '_kwLbl')
  const valV = v(ctx, '_kwv')
  const endV = v(ctx, '_kwe')
  const bodyInd = ind(ctx) + '  '

  const tries: string[] = []
  for (const w of def.words) {
    const cps = Array.from(w, ch => ch.codePointAt(0)!)
    let shape: ScanShape = def.caseInsensitive
      ? { kind: 'litFold', open: cps }
      : { kind: 'seq', parts: [{ part: 'lit', cps, optional: false }] }
    if (boundary) {
      shape = { kind: 'lookahead', inner: shape, ranges: boundary.ranges, classNegated: boundary.negated, negative: true }
    }
    const m = emitShapeMatch(shape, pos, mint, bodyInd)
    tries.push(
      ...m.setup,
      // Slice from input rather than reusing the literal word: `caseInsensitive`
      // must return the text as it actually appeared (e.g. "ABC" for keyword
      // "abc"), matching what the original `RegExp.exec()[0]` returned.
      `${bodyInd}if (${m.ok}) { ${valV} = input.slice(${pos}, ${m.end}); ${endV} = ${m.end}; break ${lbl} }`,
    )
  }

  const stmts = [
    `${ind(ctx)}let ${valV} = '', ${endV} = ${pos}`,
    `${ind(ctx)}${lbl}: {`,
    ...tries,
    `${ind(ctx)}}`,
    // Every word has length >= 1 (checked above), so a real match always
    // advances past `pos` — `endV === pos` only happens when no candidate matched.
    ...emitIfFail(ctx, `${endV} === ${pos}`, failBody(ctx, '"keyword"', pos)),
  ]
  stmts.push(...emitLeafCapture(ctx, valV, pos, endV))
  return { stmts, valueVar: valV, endVar: endV }
}

function emitKeywords(def: Extract<ParserDef, { tag: 'keywords' }>, ctx: Ctx, pos: string): ER {
  const fast = emitKeywordsFast(def, ctx, pos)
  if (fast) return fast

  const alt = def.words.map(escapeKeywordRe).join('|')
  const boundary = def.boundary ? `(?![${def.boundary}])` : ''
  // MUST mirror `keywords()`'s own flags exactly (see `src/combinators/keywords.ts`):
  // case-insensitive drops `u` so that matching folds the SAME set the first-set
  // enumerates. Emitting `iuy` here folded by Unicode simple case folding instead,
  // so the COMPILED build matched `ſtroke` against `keywords(['stroke'], …)` while
  // the ASCII first-set gated `ſ` away — the unsound gate, and an interpreter/
  // compiled divergence on top of it.
  const flags = def.caseInsensitive ? 'iy' : 'uy'
  const source = `(?:${alt})${boundary}`
  const key = `${source}/${flags}`
  let rName = ctx.regexMap.get(key)
  if (rName === undefined) {
    rName = `${nsp(ctx)}_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${rName} = /${source}/${flags}`)
    ctx.regexMap.set(key, rName)
  }

  const mv = v(ctx, '_m')
  const vv = v(ctx)
  const stmts = [
    `${ind(ctx)}${rName}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${mv} = ${rName}.exec(input)`,
    ...emitIfFail(ctx, `${mv} === null`, failBody(ctx, '"keyword"', pos)),
    `${ind(ctx)}const ${vv} = ${mv}[0]`,
  ]
  const endVar = `${pos} + ${vv}.length`
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

function emitRegex(def: Extract<ParserDef, { tag: 'regex' }>, ctx: Ctx, pos: string, canMatchNewline = true): ER {
  const expectedStr = JSON.stringify(`/${def.source}/`)
  const shape = scanShapeFromRegex(def.source, def.flags)
  if (shape) {
    const vv = v(ctx)
    const scanned = emitScannableTerminal(shape, {
      ind: ind(ctx),
      pos,
      valueVar: vv,
      failIf: (cond: string) => emitIfFail(ctx, cond, failBody(ctx, expectedStr, pos)),
      fresh: (prefix?: string) => v(ctx, prefix),
    })
    if (scanned) {
      const stmts = [
        ...scanned.stmts,
        ...(canMatchNewline ? emitLineTrack(ctx, pos, scanned.endVar) : []),
        ...emitLeafCapture(ctx, vv, pos, scanned.endVar),
      ]
      return { stmts, valueVar: vv, endVar: scanned.endVar }
    }
  }

  // Didn't lower to the fast charCodeAt scan — record it and fall back to RegExp.
  _loweringSink?.add(`/${def.source}/${def.flags}`)

  const flags = 'y' + def.flags.replace(/[gy]/g, '')
  const key = `${def.source}/${flags}`
  let rName = ctx.regexMap.get(key)
  if (rName === undefined) {
    rName = `${nsp(ctx)}_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${rName} = /${def.source}/${flags}`)
    ctx.regexMap.set(key, rName)
  }

  const mv = v(ctx, '_m')
  const vv = v(ctx)
  const stmts = [
    `${ind(ctx)}${rName}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${mv} = ${rName}.exec(input)`,
    ...emitIfFail(ctx, `${mv} === null`, failBody(ctx, expectedStr, pos)),
    `${ind(ctx)}const ${vv} = ${mv}[0]`,
  ]
  const endVar = `${pos} + ${vv}.length`
  if (canMatchNewline) stmts.push(...emitLineTrack(ctx, pos, endVar))
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

/**
 * A JS expression that builds a zero-width follow-set sync sentinel for `fs` at
 * RUNTIME via `_ctx._rec.sentinel(...)` — never `_rp` — so a recovery-enabled
 * grammar keeps `runtimeParsers` empty and stays macro-inlinable. Returns null when
 * the first-set is `any`/`empty` (no usable sentinel). The build is only reached on
 * the tolerant path (the publish that uses it is `_ctx._tolerant`-gated), so a strict
 * parse of the shipped grammar allocates nothing.
 */
function syncSentinelExpr(fs: FirstSet): string | null {
  if (fs.kind !== 'ranges' || fs.ranges.length === 0) return null
  return `_ctx._rec.sentinel({ kind: 'ranges', ranges: ${JSON.stringify(fs.ranges)} })`
}

function emitSeqValues(def: Extract<ParserDef, { tag: 'sequence' }>, ctx: Ctx, pos: string): ER & { valueVars: string[] } {
  const startV = v(ctx, '_start')
  const curV = v(ctx, '_cur')
  const stmts: string[] = [
    `${ind(ctx)}const ${startV} = ${pos}`,
    `${ind(ctx)}let ${curV} = ${pos}`,
  ]
  const valueVars: string[] = []

  // Recovery sync publish (compile-time gate): save the inherited sync at entry,
  // then before each term set `_ctx._sync` to the inferred follow-set sentinel of
  // the remaining terms (or the inherited sync when none is usable) so a nested
  // list resyncs to the enclosing delimiter. Runtime-gated by `_ctx._tolerant`;
  // strict parses never touch it.
  const syncInV = ctx.recovery ? v(ctx, '_syncIn') : ''
  if (ctx.recovery) stmts.push(`${ind(ctx)}const ${syncInV} = _ctx._sync`)
  const publishSync = (i: number): string => {
    if (!ctx.recovery) return ''
    const fs = def.parsers.slice(i + 1).reduce<FirstSet>((acc, p) => union(acc, firstSetOf(p)), { kind: 'empty' })
    const ref = syncSentinelExpr(fs)
    return `${ind(ctx)}if (_ctx._tolerant) _ctx._sync = ${ref ?? syncInV}`
  }

  for (let i = 0; i < def.parsers.length; i++) {
    const syncPub = publishSync(i)
    if (syncPub) stmts.push(syncPub)
    if (i > 0 && ctx.activeTrivia) {
      if (ctx.capturing) {
        const capFn = ensureTriviaCaptureFn(ctx)
        // The whole mark/restore quartet below exists for ONE case: the term
        // matched EMPTY, so the trivia scanned in front of it is not really
        // inside this sequence and has to come back out of the buffers. A term
        // that cannot match empty never takes that branch — on success it has
        // consumed past `scanEnd` by construction, and on failure control has
        // already broken out to the enclosing boundary. So when `matchesEmpty`
        // says NO (it errs toward `true`, so a `false` is firm), the four marks
        // are dead stores and the `else` is dead code: emit neither.
        const rewindable = !alwaysConsumes(def.parsers[i]!)
        const markV = rewindable ? v(ctx, '_mk') : null
        const markTl = rewindable ? v(ctx, '_mktl') : null
        const markLog = rewindable ? v(ctx, '_mklg') : null
        const markRootLog = rewindable && hasSelectedRootTrivia(ctx) ? v(ctx, '_mkrlg') : null
        const scanEndV = v(ctx, '_sne')
        stmts.push(
          ...(markV ? [
            `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
            `${ind(ctx)}const ${markTl!} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
            `${ind(ctx)}const ${markLog!} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
            ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
          ] : []),
          `${ind(ctx)}const ${scanEndV} = ${capFn}(input, ${curV}, _ctx, 1)`,
          ...emitLineTrack(ctx, curV, scanEndV),
        )
        const r = emit(def.parsers[i]!, ctx, scanEndV)
        stmts.push(...r.stmts)
        if (markV) {
          const endAfterV = v(ctx, '_sea')
          stmts.push(
            `${ind(ctx)}const ${endAfterV} = ${r.endVar}`,
            `${ind(ctx)}if (${endAfterV} > ${scanEndV}) { ${curV} = ${endAfterV} } else { ${emitRestore(ctx, [
              ['_ctx._cstRawChildren', markV],
              ['_ctx._cstTriviaLog', markTl!],
              ['_ctx._triviaLog', markLog!],
              ...(markRootLog ? [['_ctx._rootTriviaLog', markRootLog] as const] : []),
            ])}; }`,
          )
        } else {
          stmts.push(`${ind(ctx)}${curV} = ${r.endVar}`)
        }
        valueVars.push(r.valueVar)
        continue
      } else {
        // Match the interpreter (sequence.ts): scan trivia to a temp position, but
        // only *commit* it (advance cur) if the following term consumes content past
        // it. A term matching empty (optional/many/lookahead) leaves cur pre-trivia,
        // so trailing whitespace stays out of the sequence's span. When run() has
        // installed the public root `_triviaLog`, record that log with `_cap = 2`
        // without enabling per-node CST trivia capture.
        const trivFn = ensureTriviaFn(ctx)
        // Same dead-branch elision as the capturing path above: the rewind is
        // reachable only when the term matches EMPTY, so a term that cannot do
        // so needs neither mark. `logV` still has to be read — it also drives
        // the `_cap` argument below — but the two `.length` snapshots and the
        // whole `else` clause go.
        const rewindable = !alwaysConsumes(def.parsers[i]!)
        const markLog = rewindable ? v(ctx, '_mklg') : null
        const markRootLog = rewindable && hasSelectedRootTrivia(ctx) ? v(ctx, '_mkrlg') : null
        const scanEndV = v(ctx, '_sne')
        // The root trivia log, read ONCE. This site used to load `_ctx._triviaLog`
        // three separate times per sequence-item boundary — to take the mark, to
        // compute the `_cap` argument, and again to decide the rollback — and root
        // trivia is OPT-IN, so a grammar that never asks for it (every `run()` without
        // `rootTrivia`, and every direct `parseWithContext`) paid three property loads
        // per boundary to re-prove the same field undefined. Token-dense grammars with
        // little per-token work pay that most: it is the whole of graphql/document's
        // drift against the pinned v0.35.0 reference in `perf:workloads`.
        //
        // Hoisting is sound only because the load and the rollback bracket ONE sequence
        // item. `_ctx._triviaLog` is reassigned at grammar boundaries (see the
        // save/clear/restore pair emitted for nested grammars), but that pair restores
        // the same reference before control returns here, and the rollback is reached
        // only on the item's success path. A function-wide hoist would NOT be sound.
        const logV = v(ctx, '_tlg')
        const capArg = ctx.noHoist ? '0' : hasSelectedRootTrivia(ctx)
          ? `(${logV} !== undefined || _ctx._rootTriviaLog !== undefined) ? 2 : 0`
          : `${logV} !== undefined ? 2 : 0`
        stmts.push(
          `${ind(ctx)}const ${logV} = _ctx._triviaLog`,
          ...(markLog ? [`${ind(ctx)}const ${markLog} = ${logV} !== undefined ? ${logV}.length : 0`] : []),
          ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
          `${ind(ctx)}const ${scanEndV} = ${trivFn}(input, ${curV}, _ctx, ${capArg})`,
          ...emitLineTrack(ctx, curV, scanEndV),
        )
        const r = emit(def.parsers[i]!, ctx, scanEndV)
        stmts.push(...r.stmts)
        if (markLog) {
          const endAfterV = v(ctx, '_sea')
          stmts.push(
            `${ind(ctx)}const ${endAfterV} = ${r.endVar}`,
            // The first clause does NOT go through `emitRestore`: this non-capturing
            // path rewinds the trivia log through the hoisted local `logV` (see above),
            // whose guard is `!== undefined` rather than a truthiness test, so it is a
            // different predicate — not a restore over a `_ctx` buffer.
            `${ind(ctx)}if (${endAfterV} > ${scanEndV}) ${curV} = ${endAfterV}; else { if (${logV} !== undefined && ${logV}.length !== ${markLog}) ${logV}.length = ${markLog};${markRootLog ? ` ${emitRestore(ctx, [['_ctx._rootTriviaLog', markRootLog]])};` : ''} }`,
          )
        } else {
          stmts.push(`${ind(ctx)}${curV} = ${r.endVar}`)
        }
        valueVars.push(r.valueVar)
        continue
      }
    }
    const r = emit(def.parsers[i]!, ctx, curV)
    stmts.push(...r.stmts, `${ind(ctx)}${curV} = ${r.endVar}`)
    valueVars.push(r.valueVar)
  }

  return { stmts, valueVar: valueVars[valueVars.length - 1] ?? 'null', endVar: curV, valueVars }
}

function emitSeq(def: Extract<ParserDef, { tag: 'sequence' }>, ctx: Ctx, pos: string): ER {
  const { stmts, endVar, valueVars } = emitSeqValues(def, ctx, pos)
  // The tuple is never observed (markUnusedValues) — terms still parse + capture;
  // skip allocating `[v1, v2, …]`.
  if (def.valueUnused) return { stmts, valueVar: 'undefined', endVar }
  const arrV = v(ctx, '_arr')
  stmts.push(`${ind(ctx)}const ${arrV} = [${valueVars.join(', ')}]`)
  return { stmts, valueVar: arrV, endVar }
}

/**
 * Deep-first `expected` labels for a choice's arms — the concatenation of each
 * arm's leftmost-leaf expected set, matching what the interpreter collects when
 * no arm's first-set matches (choice.ts) and what expect()'s deriveExpected()
 * reports. Falls back to the arm's tag only for arms with no static expectation
 * (e.g. runtime-fallback combinators), preserving the previous behaviour there.
 */
function deriveExpectedArr(parsers: Combinator<unknown>[]): string {
  return JSON.stringify(parsers.flatMap(p => {
    const e = deriveExpected(p)
    return e.length > 0 ? e : [p._tag]
  }))
}

/**
 * True when `p` can only fail at its own start position (its failure span is
 * `{pos,pos}` and its expected set is a fixed label). Such disjoint-choice arms
 * can be emitted inline: their leaf failure already matches the interpreter's
 * `{expected: <label>, span: {pos,pos}}`. Composite arms (sequence, node, …) can
 * fail deeper, so they must be wrapped to re-anchor the span at the choice pos.
 */
function failsAtStart(p: Combinator<unknown>): boolean {
  const d = p._def
  switch (d.tag) {
    case 'literal': case 'regex': case 'keywords': case 'guard': case 'not': case 'peek':
      return true
    case 'transform': case 'label': case 'field':
      return failsAtStart(d.parser)
    default:
      return false
  }
}

/** Hoisted module-level const for one arm's static `expected` labels. */
function armStaticExpected(ctx: Ctx, p: Combinator<unknown>): string {
  return hoistExpected(ctx, deriveExpectedArr([p]))
}

/**
 * True when `p` can succeed at `pos` without consuming input (e.g. a starred
 * regex, optional, many). Such arms must still be tried even when the current
 * code point is outside their first-set — skipping them would change semantics.
 */
function canMatchEmptyAtStart(p: Combinator<unknown>): boolean {
  const d = p._def
  switch (d.tag) {
    case 'regex':
      // Precise nullability: does the pattern actually match the empty string?
      // The old crude test (`/(?:[*?]|\{0,|\{\d*,)/.test(source)`) fired on ANY
      // `?`/`*`/`{n,}` in the source — including a `?`/`*` inside a `(?!…)`/`(?=…)`
      // lookahead or applied to a NON-leading term — so a required-prefix recognizer
      // like `/@media(?![-\w])/` (first-set `{@}`, cannot match empty) was wrongly
      // flagged nullable. When such a rule is a compileLinkable rule, that poisoned
      // its `firstSets`/`firstSetRecipes` to `any` (below), so a cross-artifact
      // `g.CssAstSyntax*` reference to it resolved to `any` at fuse time and the
      // referencing choice arm lost first-char dispatch. `regexMatchesEmpty` tests
      // `^(?:source)$` against `''` — the exact "matches empty" question — and falls
      // back to `true` (conservatively nullable → always-try) if the pattern can't be
      // compiled. Tighter AND sound: the first-set stays a superset (firstSetFromRegex
      // is unchanged); we only stop over-declaring nullability. Also fixes a latent
      // UNSOUNDNESS the crude test had — `/a{0}/` matches empty but has no `{n,}`, so
      // the old check returned false (would gate a nullable rule); the precise test
      // returns true.
      return regexMatchesEmpty(d.source, d.flags)
    case 'optional': return true
    case 'many': return true
    case 'transform': case 'label': case 'field':
      return canMatchEmptyAtStart(d.parser)
    case 'literal':
      return d.value.length === 0
    default:
      return false
  }
}

/** Emit a first-set guard when the arm cannot match empty and has a finite first-set. */
function needsFirstSetGuard(p: Combinator<unknown>): boolean {
  const fs = p._meta.firstSet
  return fs.kind !== 'any' && !canMatchEmptyAtStart(p)
}

/**
 * Emit one arm of a disjoint choice, assigning its value/end to `valV`/`endV`.
 * Leaf arms (failsAtStart) are inlined — their leaf failure already matches the
 * interpreter. Composite arms are wrapped so that on failure the choice reports
 * the arm's deep `expected` (via _ctx._fx) but re-anchors the span at the choice
 * position `pos` — exactly what the interpreter's disjoint dispatch returns.
 */
function coverageHit(ctx: Ctx, id: string | undefined, offset = '_pos', end?: string): string[] {
  return id === undefined ? [] : [
    `${ind(ctx)}_ctx._grammarCoverage?.(${JSON.stringify(id)})`,
    `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'selected', offset: ${offset}${end === undefined ? '' : `, end: ${end}`} })`,
    `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'success', offset: ${offset}${end === undefined ? '' : `, end: ${end}`} })`,
  ]
}

function coverageAttempt(ctx: Ctx, id: string | undefined, offset: string): string[] {
  return id === undefined ? [] : [`${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'attempt', offset: ${offset} })`]
}

function coverageFailureBacktrack(ctx: Ctx, id: string | undefined, failureOffset: string, startOffset: string): string[] {
  return id === undefined ? [] : [
    `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'failure', offset: ${failureOffset} })`,
    `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'backtrack', offset: ${startOffset} })`,
  ]
}

function emitDisjointArm(p: Combinator<unknown>, ctx: Ctx, pos: string, valV: string, endV: string, coverageId?: string): string[] {
  // Coverage needs an observable failure/backtrack pair even for an atomic
  // dispatched terminal. Keep the unwrapped hot path only when uninstrumented.
  if (failsAtStart(p) && coverageId === undefined) {
    const r = emit(p, ctx, pos)
    return [...coverageAttempt(ctx, coverageId, pos), ...r.stmts, `${ind(ctx)}${valV} = ${r.valueVar}`, `${ind(ctx)}${endV} = ${r.endVar}`, ...coverageHit(ctx, coverageId, pos, r.endVar)]
  }
  const { stmts, okVar, valVar, endVar } = emitFallible(p, ctx, pos)
  return [
    ...coverageAttempt(ctx, coverageId, pos),
    ...stmts,
    ...emitIfFail(ctx, `!${okVar}`, `${coverageFailureBacktrack(ctx, coverageId, '_ctx._fe', pos).join('; ')}; ${failArrBody(ctx, '_ctx._fx', pos, false)}`),
    `${ind(ctx)}${valV} = ${valVar}`,
    `${ind(ctx)}${endV} = ${endVar}`,
    ...coverageHit(ctx, coverageId, pos, endVar),
  ]
}

/**
 * Register a disjoint-choice arm's gate predicate (if any) into `mapFns` and emit
 * the guarded arm body. Mirrors emitFirstMatch's gate handling: the gate closure
 * is pushed into `mapFns` (with its source into `mapFnSrcs` — `def.gateSrcs[i]`
 * for the macro, null for compile()) BEFORE the arm body is emitted, so the
 * per-arm push order (gate, then arm transforms) stays parallel with the macro's
 * pre-accumulated sources and the emitFirstMatch layout.
 *
 * A gated arm dispatches on its first char, then checks the gate INSIDE that
 * branch: gate true → run the arm; gate false → FAIL the choice at `pos` (sound
 * because disjoint + non-nullable arms guarantee no other arm matches this char).
 */
function emitDisjointArmGated(
  def: Extract<ParserDef, { tag: 'choice' }>,
  i: number,
  ctx: Ctx,
  pos: string,
  valV: string,
  endV: string,
  coverageId?: string,
): string[] {
  const p = def.parsers[i]!
  const gate = def.gates[i]
  if (!gate) return emitDisjointArm(p, ctx, pos, valV, endV, coverageId)

  const gateIdx = ctx.mapFns.length
  ctx.mapFns.push(gate as (v: unknown, span: unknown) => unknown)
  // Macro path inlines the captured gate source; compile() has no source → null.
  // Parallel-length invariant with mapFns preserved either way.
  ctx.mapFnSrcs.push(def.gateSrcs?.[i] ?? null)
  const gateCond = `${mfRef(ctx)}[${gateIdx}](_ctx.state)`

  const stmts = [`${ind(ctx)}if (${gateCond}) {`]
  ctx.indent++
  stmts.push(...emitDisjointArm(p, ctx, pos, valV, endV, coverageId))
  ctx.indent--
  stmts.push(`${ind(ctx)}} else { ${failArrBody(ctx, deriveExpectedArr([p]), pos)} }`)
  return stmts
}

function emitChoice(parser: Combinator<unknown>, def: Extract<ParserDef, { tag: 'choice' }>, ctx: Ctx, pos: string): ER {
  const coverageIds = ctx.coverage?.plan.choices.get(parser)
  const coverageBase = coverageIds?.[0]?.slice(0, -1)
  const allExpected = deriveExpectedArr(def.parsers)

  // ── Disjoint: O(1) first-char dispatch (arms may be gated) ───────────────
  if (def.disjoint) {
    const codeV = v(ctx, '_code')
    const valV = v(ctx, '_chv')
    const endV = v(ctx, '_che')
    const stmts: string[] = [
      `${ind(ctx)}const ${codeV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
      `${ind(ctx)}let ${valV}, ${endV} = ${pos}`,
    ]

    const plan = _forceDisjointIf ? { kind: 'if' as const } : planDisjointDispatch(def.parsers)

    // Switch (jump table) when arms key off a few discrete first code points.
    if (plan.kind === 'switch') {
      stmts.push(`${ind(ctx)}switch (${codeV}) {`)
      ctx.indent++
      for (let i = 0; i < def.parsers.length; i++) {
        for (const cp of plan.cases[i]!) stmts.push(`${ind(ctx)}case ${cp}:`)
        stmts.push(`${ind(ctx)}{`)
        ctx.indent++
        stmts.push(
          ...emitDisjointArmGated(def, i, ctx, pos, valV, endV, coverageIds?.[i]),
          `${ind(ctx)}break`,
        )
        ctx.indent--
        stmts.push(`${ind(ctx)}}`)
      }
      stmts.push(`${ind(ctx)}default: ${failArrBody(ctx, allExpected, pos)}`)
      ctx.indent--
      stmts.push(`${ind(ctx)}}`)
      return { stmts, valueVar: valV, endVar: endV }
    }

    // Otherwise if/else if with range comparisons (cheaper for char-class arms).
    let first = true
    for (let i = 0; i < def.parsers.length; i++) {
      const p = def.parsers[i]!
      const cond = firstSetCond(codeV, p._meta.firstSet)
      const kw = first ? 'if' : 'else if'
      first = false
      stmts.push(`${ind(ctx)}${kw} (${cond}) {`)
      ctx.indent++
      stmts.push(...emitDisjointArmGated(def, i, ctx, pos, valV, endV, coverageIds?.[i]))
      ctx.indent--
      stmts.push(`${ind(ctx)}}`)
    }
    stmts.push(...emitElseFail(ctx, failArrBody(ctx, allExpected, pos)))
    return { stmts, valueVar: valV, endVar: endV }
  }

  return emitNonDisjoint(def, def.strategy, allExpected, ctx, pos, coverageBase)
}

function emitTailFallible(
  parser: Combinator<unknown>,
  ctx: Ctx,
  pos: string,
): FallibleER {
  const savedRecord = ctx.recordFail
  ctx.recordFail = true
  const out = emitFallible(parser, ctx, pos)
  ctx.recordFail = savedRecord
  return out
}

/** True when `p` can append a ParseError to `ctx._errors` before later failure. */
function mayRecordRecoveryError(p: Combinator<unknown>, recovery: boolean, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'expect':
    case 'recover':
      return true
    case 'many':
    case 'oneOrMore':
    case 'sepBy':
      return recovery || mayRecordRecoveryError(d.parser, recovery, seen)
    case 'choice':
    case 'sequence': {
      for (const item of d.parsers) {
        if (mayRecordRecoveryError(item, recovery, seen)) return true
      }
      return false
    }
    case 'dispatch': {
      if (mayRecordRecoveryError(d.selector, recovery, seen)) return true
      for (const item of d.cases) {
        if (mayRecordRecoveryError(item.parser, recovery, seen)) return true
      }
      if (d.matchers?.some(item => mayRecordRecoveryError(item.parser, recovery, seen))) return true
      return d.otherwise ? mayRecordRecoveryError(d.otherwise, recovery, seen) : false
    }
    case 'attempt':
    case 'transform':
    case 'label':
    case 'field':
    case 'grammar':
    case 'node':
    case 'token':
    case 'leaf':
    case 'withCtx':
    case 'optional':
      return mayRecordRecoveryError(d.parser, recovery, seen)
    case 'skip':
      return mayRecordRecoveryError(d.main, recovery, seen) || mayRecordRecoveryError(d.skipped, recovery, seen)
    case 'scanTo':
      if (mayRecordRecoveryError(d.sentinel, recovery, seen)) return true
      for (const item of d.skip) {
        if (mayRecordRecoveryError(item, recovery, seen)) return true
      }
      return false
    case 'lazy': {
      try { return mayRecordRecoveryError(d.thunk(), recovery, seen) } catch { return true }
    }
    case 'unknown':
      return true
    default:
      return false
  }
}

function emitDispatchCombinator(
  parser: Combinator<unknown>,
  def: Extract<ParserDef, { tag: 'dispatch' }>,
  ctx: Ctx,
  pos: string,
  valueMode: 'pair' | 'tail' = 'pair',
): ER {
  if (parserUsesRouted(def.selector)) {
    throw new Error('parseman: routed() can only appear inside a dispatch() branch')
  }
  const coverageIds = ctx.coverage?.plan.dispatches.get(parser) ?? []
  const branchUsesRouted = (entry: { parser: Combinator<unknown>; usesRouted?: boolean | undefined }): boolean =>
    entry.usesRouted === true || parserUsesRouted(entry.parser)
  const hasRoutedBranch = def.cases.some(branchUsesRouted) ||
    (def.matchers ? def.matchers.some(branchUsesRouted) : false) ||
    (def.otherwise ? def.otherwiseUsesRouted === true || parserUsesRouted(def.otherwise) : false)
  const selectorNeedsRollback = hasRoutedBranch && (
    (ctx.capturing === true && capturesLeaf(def.selector)) ||
    (ctx.activeTrivia !== undefined && parserHasTriviaSite(def.selector)) ||
    parserEnablesTriviaCapture(def.selector) ||
    parserHasOwnFields(def.selector) ||
    mayRecordRecoveryError(def.selector, !!ctx.recovery)
  )
  const selectorLeafMark = selectorNeedsRollback ? v(ctx, '_dsl') : null
  const selectorRawMark = selectorNeedsRollback ? v(ctx, '_dsr') : null
  const selectorTriviaMark = selectorNeedsRollback ? v(ctx, '_dst') : null
  const selectorLogMark = selectorNeedsRollback ? v(ctx, '_dsg') : null
  const selectorRootLogMark = selectorNeedsRollback && hasSelectedRootTrivia(ctx) ? v(ctx, '_dsrg') : null
  const selectorFieldMark = selectorNeedsRollback ? v(ctx, '_dsf') : null
  const selectorErrorMark = selectorNeedsRollback ? v(ctx, '_dse') : null
  const selector = emit(def.selector, ctx, pos)
  const outV = v(ctx, '_dval')
  const outE = v(ctx, '_dend')
  const keyV = v(ctx, '_dkey')
  // Token-keyed dispatch: walk the selector's matched span to a small integer
  // case id ONCE, so each case compares an integer instead of re-deriving the
  // key from the string a character at a time. See `token-dispatch.ts`.
  const tokenTrie = emitDispatchTokenTrie(ctx, def, pos, selector.endVar, keyV)
  const stmts: string[] = [
    ...(selectorLeafMark ? [
      `${ind(ctx)}const ${selectorLeafMark} = _ctx._cstLeaves?.length ?? 0`,
      `${ind(ctx)}const ${selectorRawMark} = _ctx._cstRawChildren?.length ?? 0`,
      `${ind(ctx)}const ${selectorTriviaMark} = _ctx._cstTriviaLog?.length ?? 0`,
      `${ind(ctx)}const ${selectorLogMark} = _ctx._triviaLog?.length ?? 0`,
      ...(selectorRootLogMark ? [`${ind(ctx)}const ${selectorRootLogMark} = _ctx._rootTriviaLog?.length ?? 0`] : []),
      `${ind(ctx)}const ${selectorFieldMark} = _ctx._fields?.length ?? 0`,
      `${ind(ctx)}const ${selectorErrorMark} = _ctx._errors?.length ?? 0`,
    ] : []),
    ...selector.stmts,
    `${ind(ctx)}const ${keyV} = ${selector.valueVar}`,
    ...(tokenTrie ? [`${ind(ctx)}const ${tokenTrie.idVar} = ${tokenTrie.walkExpr}`] : []),
    `${ind(ctx)}let ${outV}, ${outE} = ${selector.endVar}`,
  ]

  let wroteBranch = false
  const emitSelectedTail = (entry: { parser: Combinator<unknown>; usesRouted?: boolean | undefined }, keyword: 'if' | 'else if' | 'else' | 'case' | 'default', condition?: string, coverageId?: string): void => {
    const parser = entry.parser
    // `case`/`default` are the token-keyed form: the arm is SELECTED by an
    // integer rather than reached by falling through a comparison chain. Every
    // failure exit inside an arm is a LABELED break (`break _pfail`), so the
    // enclosing switch never captures one; bare breaks only ever appear inside
    // an arm's own emitted loop.
    const head = keyword === 'else'
      ? `${ind(ctx)}else {`
      : keyword === 'default'
      ? `${ind(ctx)}default: {`
      : keyword === 'case'
      ? `${ind(ctx)}case ${condition}: {`
      : `${ind(ctx)}${keyword} (${condition}) {`
    stmts.push(head)
    ctx.indent++
    const usesRouted = branchUsesRouted(entry)
    const needsRoutedContext = usesRouted && routedNeedsContextBridge(parser, ctx)
    const routedV = needsRoutedContext ? v(ctx, '_drt') : null
    const mayError = mayRecordRecoveryError(parser, !!ctx.recovery)
    const errMark = mayError ? v(ctx, '_derr') : null
    const logMark = ctx.activeTrivia ? v(ctx, '_dlog') : null
    const rootLogMark = ctx.activeTrivia && hasSelectedRootTrivia(ctx) ? v(ctx, '_drlog') : null
    if (usesRouted) {
      stmts.push(
        ...(routedV ? [`${ind(ctx)}const ${routedV} = _ctx._routed; _ctx._routed = { value: ${selector.valueVar}, span: { start: ${pos}, end: ${selector.endVar} } }`] : []),
        ...(selectorLeafMark ? [
          `${ind(ctx)}${emitRestore(ctx, [
            ['_ctx._cstLeaves', selectorLeafMark],
            ['_ctx._cstRawChildren', selectorRawMark!],
            ['_ctx._cstTriviaLog', selectorTriviaMark!],
            ['_ctx._triviaLog', selectorLogMark!],
            ...(selectorRootLogMark ? [['_ctx._rootTriviaLog', selectorRootLogMark] as const] : []),
            ['_ctx._fields', selectorFieldMark!],
            ['_ctx._errors', selectorErrorMark!],
          ])}`,
        ] : []),
      )
    }
    if (errMark) stmts.push(`${ind(ctx)}const ${errMark} = _ctx._errors?.length ?? 0`)
    if (logMark) stmts.push(`${ind(ctx)}const ${logMark} = _ctx._triviaLog?.length ?? 0`)
    if (rootLogMark) stmts.push(`${ind(ctx)}const ${rootLogMark} = _ctx._rootTriviaLog?.length ?? 0`)
    const savedRoutedLocal = ctx.routedLocal
    const savedNoHoist = ctx.noHoist
    if (usesRouted && !needsRoutedContext) {
      ctx.routedLocal = { valueVar: selector.valueVar, startVar: pos, endVar: selector.endVar }
      ctx.noHoist = true
    } else if (usesRouted) {
      ctx.routedLocal = undefined
    }
    const tail = emitTailFallible(parser, ctx, usesRouted ? pos : selector.endVar)
    ctx.routedLocal = savedRoutedLocal
    ctx.noHoist = savedNoHoist
    stmts.push(...coverageAttempt(ctx, coverageId, pos))
    const errorRollback = errMark
      ? `${emitRestore(ctx, [['_ctx._errors', errMark]])}; `
      : ''
    const logRollback = logMark
      ? `${emitRestore(ctx, [['_ctx._triviaLog', logMark]])}; `
      : ''
    const rootLogRollback = rootLogMark
      ? `${emitRestore(ctx, [['_ctx._rootTriviaLog', rootLogMark]])}; `
      : ''
    const routedRollback = routedV ? `_ctx._routed = ${routedV}; ` : ''
    const coverageFailure = coverageId === undefined
      ? ''
      : `_ctx._grammarTrace?.write({ id: ${JSON.stringify(coverageId)}, phase: 'failure', offset: _ctx._fe }); `
    stmts.push(
      ...tail.stmts,
      `${ind(ctx)}if (!${tail.okVar}) { ${routedRollback}${errorRollback}${logRollback}${rootLogRollback}${coverageFailure}${committedFailBody(ctx)} }`,
      ...(routedV ? [`${ind(ctx)}_ctx._routed = ${routedV}`] : []),
      `${ind(ctx)}${outV} = ${valueMode === 'tail' ? tail.valVar : `[${selector.valueVar}, ${tail.valVar}]`}`,
      `${ind(ctx)}${outE} = ${tail.endVar}`,
      ...coverageHit(ctx, coverageId, pos, tail.endVar),
    )
    ctx.indent--
    stmts.push(keyword === 'case' || keyword === 'default' ? `${ind(ctx)}} break` : `${ind(ctx)}}`)
  }

  const useSwitch = tokenTrie !== null && dispatchConfigFromEnv(process.env).sel === 'switch'
  // The `case` heads sit at the SAME depth as the chain's `if` heads would.
  // Indenting the switch body costs one byte per emitted line — 21,764 B across
  // the css artifact's three dispatch sites, which swamped the saving it makes.
  if (useSwitch) stmts.push(`${ind(ctx)}switch (${tokenTrie!.idVar}) {`)

  let coverageIndex = 0
  for (const [caseIndex, entry] of def.cases.entries()) {
    if (useSwitch) {
      emitSelectedTail(entry, 'case', String(caseIndex + 1), coverageIds[coverageIndex++])
    } else {
      const condition = tokenTrie
        ? `${tokenTrie.idVar} === ${caseIndex + 1}`
        : entry.keys.map(key => emitDispatchKeyCondition(keyV, key, entry.caseInsensitive)).join(' || ')
      emitSelectedTail(entry, wroteBranch ? 'else if' : 'if', condition, coverageIds[coverageIndex++])
    }
    wroteBranch = true
  }

  const emitMatcherTails = (): void => {
    for (const matcher of def.matchers ?? []) {
      emitSelectedTail(matcher, wroteBranch ? 'else if' : 'if', emitDispatchMatcherCondition(ctx, keyV, matcher), coverageIds[coverageIndex++])
      wroteBranch = true
    }
  }

  if (def.otherwise) {
    emitMatcherTails()
    const otherwiseEntry = { parser: def.otherwise, usesRouted: def.otherwiseUsesRouted }
    if (useSwitch) emitSelectedTail(otherwiseEntry, 'default', undefined, coverageIds[coverageIndex++])
    else if (wroteBranch) emitSelectedTail(otherwiseEntry, 'else', undefined, coverageIds[coverageIndex++])
    else emitSelectedTail(otherwiseEntry, 'if', 'true', coverageIds[coverageIndex++])
  } else {
    emitMatcherTails()
    const expected = JSON.stringify(def.cases.flatMap(entry => entry.keys.map(key => JSON.stringify(key))))
    const fail = failArrBody(ctx, expected, selector.endVar)
    if (useSwitch) stmts.push(`${ind(ctx)}default: { ${fail} }`)
    else stmts.push(wroteBranch ? `${ind(ctx)}else { ${fail} }` : `${ind(ctx)}${fail}`)
  }
  if (useSwitch) stmts.push(`${ind(ctx)}}`)

  return { stmts, valueVar: outV, endVar: outE }
}

/**
 * Hoist this dispatch's id tables and return the per-site call. Returns null
 * when the site must keep the character chain: a key set that cannot share one
 * folded comparison, or one small enough that a shared helper costs more than
 * it saves.
 *
 * The helpers are emitted ONCE per artifact however many sites use them — only
 * the small per-site tables are duplicated, which is what makes this shrink
 * rather than grow the artifact.
 */
function emitDispatchTokenTrie(
  ctx: Ctx,
  def: Extract<ParserDef, { tag: 'dispatch' }>,
  pos: string,
  endVar: string,
  keyV: string,
): { idVar: string; walkExpr: string } | null {
  // Matchers (`startsWith`/`endsWith`/`matches`) still key off the string; a
  // site that has them keeps the chain so both halves read one key form.
  if (def.matchers !== undefined && def.matchers.length > 0) return null
  // Measurement escape hatch: rebuild the pre-token character-chain artifact in
  // place so the strategies are compared against the real baseline, not a
  // remembered number.
  if (process.env.PARSEMAN_DISPATCH_OFF === '1') return null
  const helperName = (h: SharedHelper): string => `${nsp(ctx)}_dt_${h}`
  const prefix = `${nsp(ctx)}_dt${ctx.dispatchTrieCount ?? 0}`
  const site = emitDispatchId(
    def.cases.map(c => ({ keys: c.keys, caseInsensitive: c.caseInsensitive })),
    dispatchConfigFromEnv(process.env),
    prefix,
    helperName,
    pos,
    endVar,
  )
  if (site === null) return null

  // Decide per SITE by measuring both emissions. A key-count rule of thumb got
  // this wrong in both directions: it took sites whose keys are short enough
  // that the tables cost more than the chain they replace (less grew 902 B that
  // way) and declined sites whose keys are long enough to pay at two keys.
  const emittedHelpers = ctx.dispatchHelpers ?? new Set<SharedHelper>()
  const chainBytes = def.cases.reduce((a, c) =>
    a + c.keys.reduce((b, k) => b + emitDispatchKeyCondition(keyV, k, c.caseInsensitive).length + 4, 0), 0)
  const trieBytes = site.decls.reduce((a, d) => a + d.length + 1, 0) +
    site.callExpr.length +
    // one `_dtokN === k` arm condition per case, in place of that case's chain
    def.cases.length * (keyV.length + 8) +
    site.helpers.reduce((a, h) => a + (emittedHelpers.has(h) ? 0 : sharedHelperDecl(h, helperName).length + 1), 0)
  if (trieBytes >= chainBytes) return null

  ctx.dispatchTrieCount = (ctx.dispatchTrieCount ?? 0) + 1

  const emitted = emittedHelpers
  ctx.dispatchHelpers = emitted
  for (const h of site.helpers) {
    if (emitted.has(h)) continue
    emitted.add(h)
    ctx.regexDecls.push(sharedHelperDecl(h, helperName))
  }
  for (const d of site.decls) ctx.regexDecls.push(d)

  return { idVar: v(ctx, '_dtok'), walkExpr: site.callExpr }
}

function emitDispatchKeyCondition(valueVar: string, key: string, caseInsensitive: boolean): string {
  if (!caseInsensitive) return `${valueVar} === ${JSON.stringify(key)}`
  const parts = [`${valueVar}.length === ${key.length}`]
  for (let i = 0; i < key.length; i++) {
    parts.push(foldEq(`${valueVar}.charCodeAt(${i})`, key.charCodeAt(i)))
  }
  return parts.join(' && ')
}

function emitDispatchMatcherCondition(
  ctx: Ctx,
  valueVar: string,
  matcher: NonNullable<Extract<ParserDef, { tag: 'dispatch' }>['matchers']>[number],
): string {
  if (matcher.kind === 'matches') {
    const flags = matcher.caseInsensitive && !matcher.flags?.includes('i')
      ? `${matcher.flags ?? ''}i`
      : matcher.flags ?? ''
    return `${ensurePlainRegexDecl(ctx, matcher.value, flags)}.test(${valueVar})`
  }

  const text = matcher.value
  const parts = [`${valueVar}.length >= ${text.length}`]
  const offset = matcher.kind === 'endsWith' ? `${valueVar}.length - ${text.length}` : '0'
  for (let i = 0; i < text.length; i++) {
    parts.push(matcher.caseInsensitive
      ? foldEq(`${valueVar}.charCodeAt(${offset}${i === 0 ? '' : ` + ${i}`})`, text.charCodeAt(i))
      : `${valueVar}.charCodeAt(${offset}${i === 0 ? '' : ` + ${i}`}) === ${text.charCodeAt(i)}`)
  }
  return parts.join(' && ')
}

// ── greedyClassify: run the super-regex once, classify by string equality ────
// Single regex exec + O(n_literals) string comparisons. Zero backtracking.
function emitGreedyClassify(
  def: Extract<ParserDef, { tag: 'choice' }>,
  superIndex: number,
  ctx: Ctx,
  pos: string,
  coverageBase?: string,
): ER {
  const superParser = def.parsers[superIndex]!
  const regexDef = getCoreRegexDef(superParser)!

  // Hoist the regex (same mechanism as emitRegex, with dedup)
  const cleanFlags = 'y' + regexDef.flags.replace(/[gy]/g, '')
  const reKey = `${regexDef.source}/${cleanFlags}`
  let reVar = ctx.regexMap.get(reKey)
  if (reVar === undefined) {
    reVar = `${nsp(ctx)}_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${reVar} = /${regexDef.source}/${cleanFlags}`)
    ctx.regexMap.set(reKey, reVar)
  }

  const matchV = v(ctx, '_gm')
  const wordV  = v(ctx, '_gw')
  const endV   = v(ctx, '_ge')
  const valV   = v(ctx, '_gcv')

  // On no-match the interpreter returns the super-regex arm's failure verbatim
  // (choice.ts) — report only the regex's expected, not every classified literal.
  const regexExpected = JSON.stringify(deriveExpected(superParser))
  const superCoverageId = coverageBase === undefined ? undefined : `${coverageBase}${superIndex}`
  const stmts: string[] = [
    ...coverageAttempt(ctx, superCoverageId, pos),
    `${ind(ctx)}${reVar}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${matchV} = ${reVar}.exec(input)`,
    ...emitIfFail(ctx, `${matchV} === null`, `${coverageFailureBacktrack(ctx, superCoverageId, pos, pos).join('; ')}; ${failArrBody(ctx, regexExpected, pos)}`),
    `${ind(ctx)}const ${wordV} = ${matchV}[0]`,
    `${ind(ctx)}const ${endV} = ${pos} + ${wordV}.length`,
    `${ind(ctx)}let ${valV}`,
  ]

  // For each literal arm: if word === literal, capture + transform chain
  let first = true
  for (let i = 0; i < def.parsers.length; i++) {
    if (i === superIndex) continue
    const p = def.parsers[i]!
    const litVal = getCoreLiteralValue(p)
    if (litVal === null) continue

    const kw = first ? 'if' : 'else if'
    first = false
    stmts.push(`${ind(ctx)}${kw} (${wordV} === ${JSON.stringify(litVal)}) {`)
    ctx.indent++
    const tR = emitTransformChain(p, JSON.stringify(litVal), endV, pos, ctx)
    stmts.push(...coverageFailureBacktrack(ctx, superCoverageId, pos, pos))
    stmts.push(...emitLeafCapture(ctx, JSON.stringify(litVal), pos, endV))
    stmts.push(...tR.stmts, `${ind(ctx)}${valV} = ${tR.valueVar}`, ...coverageHit(ctx, coverageBase === undefined ? undefined : `${coverageBase}${i}`, pos, endV))
    ctx.indent--
    stmts.push(`${ind(ctx)}}`)
  }

  // Regex arm: capture + transform chain for the matched word
  const rR = emitTransformChain(superParser, wordV, endV, pos, ctx)
  const regexKw = first ? 'if' : 'else'
  stmts.push(`${ind(ctx)}${regexKw} {`)
  ctx.indent++
  stmts.push(...emitLeafCapture(ctx, wordV, pos, endV), ...rR.stmts, `${ind(ctx)}${valV} = ${rR.valueVar}`, ...coverageHit(ctx, coverageBase === undefined ? undefined : `${coverageBase}${superIndex}`, pos, endV))
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)
  return { stmts, valueVar: valV, endVar: endV }
}

// ── literalsLongestFirst: sorted startsWith checks, no backtracking ───────────
function emitLiteralsLongestFirst(
  def: Extract<ParserDef, { tag: 'choice' }>,
  sortedIndices: number[],
  allExpected: string,
  ctx: Ctx,
  pos: string,
  coverageBase?: string,
): ER {
  const valV = v(ctx, '_llv')
  const endV = v(ctx, '_lle')
  const stmts: string[] = [`${ind(ctx)}let ${valV}, ${endV} = ${pos}`]

  let first = true
  for (const idx of sortedIndices) {
    const p = def.parsers[idx]!
    const litVal = getCoreLiteralValue(p)!
    const litLen = litVal.length

    // Emit the literal check as a direct condition (no IIFE/try-catch — literals never throw)
    const litCond = emitLiteralCondition(litVal, pos)
    const kw = first ? 'if' : 'else if'
    first = false

    const litEnd = `${pos} + ${litLen}`
    stmts.push(`${ind(ctx)}${kw} (${litCond}) {`)
    ctx.indent++
    const tR = emitTransformChain(p, JSON.stringify(litVal), litEnd, pos, ctx)
    stmts.push(
      ...coverageAttempt(ctx, coverageBase === undefined ? undefined : `${coverageBase}${idx}`, pos),
      ...emitLeafCapture(ctx, JSON.stringify(litVal), pos, litEnd),
      ...tR.stmts,
      `${ind(ctx)}${valV} = ${tR.valueVar}`,
      `${ind(ctx)}${endV} = ${litEnd}`,
      ...coverageHit(ctx, coverageBase === undefined ? undefined : `${coverageBase}${idx}`, pos, litEnd),
    )
    ctx.indent--
    stmts.push(`${ind(ctx)}}`)
  }
  stmts.push(...emitElseFail(ctx, failArrBody(ctx, allExpected, pos)))

  return { stmts, valueVar: valV, endVar: endV }
}

// ── firstMatch fallback: PEG + auto-not inline rejection + per-arm gates ─────
// Uses labeled blocks (emitFallible) instead of IIFE+try/catch to avoid V8
// deoptimization from exception-based control flow.
function emitFirstMatch(
  def: Extract<ParserDef, { tag: 'choice' }>,
  ctx: Ctx,
  pos: string,
  coverageBase?: string,
  /**
   * `sharedPrefix` support: statements to emit BEFORE the arm loop (the once-only
   * recognition of the shared leading terminal), and a boolean condition ANDed into
   * every arm's first-char guard so no arm is entered when that prefix did not match
   * (the arms REPLAY the prefix rather than re-scanning it — see emitSharedPrefix).
   * Both undefined on the ordinary firstMatch path → byte-identical output.
   */
  preStmts?: string[],
  armGuardPrefix?: string,
): ER {
  const resValV = v(ctx, '_crv')
  const resEndV = v(ctx, '_cre')
  const resOkV  = v(ctx, '_crok')
  const codeV   = v(ctx, '_chcode')
  // For a TOTAL failure we report the concatenation of each tried arm's deep
  // `expected` (interpreter parity). To keep the hot success path allocation-free
  // (a choice that ultimately matches must NOT pay for error bookkeeping), each
  // failed arm snapshots its expected into a scalar slot (a pointer store, no
  // array/spread). Leaf arms that fail-at-start use a hoisted static const;
  // composite arms snapshot `_ctx._fx`. The concat array is materialized only in
  // the rare all-arms-failed branch. Auto-not-rejected arms leave their slot
  // unset — matching choice.ts.
  const slots = def.parsers.map(() => v(ctx, '_cfx'))
  // Auto-not arms parse successfully but are semantically rejected only once a
  // later arm wins. Keep that pending set in coverage mode so emitted trace
  // ordering matches the interpreter wrapper exactly.
  const autoRejectedV = coverageBase === undefined ? undefined : v(ctx, '_carej')
  const ind0 = ind(ctx)
  const stmts: string[] = [
    `${ind0}let ${resValV}, ${resEndV} = ${pos}, ${resOkV} = false`,
    `${ind0}let ${slots.join(', ')}`,
    ...(autoRejectedV === undefined ? [] : [`${ind0}const ${autoRejectedV} = []`]),
    `${ind0}const ${codeV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
  ]
  if (preStmts) stmts.push(...preStmts)

  for (let i = 0; i < def.parsers.length; i++) {
    const p = def.parsers[i]!
    const gate    = def.gates[i]
    const autoNot = def.autoNot[i]
    const atStart = failsAtStart(p)
    const staticFx = armStaticExpected(ctx, p)
    // A named rule REF in linkable mode: defer its first-char guard to fuse time
    // (the rule can be overridden). Emit a placeholder that fusedBody() rewrites
    // with the WINNING rule's first-set — `true` (always-try) if left unresolved.
    const deferRuleName = ctx.deferFirstSetRefs
      ? (p as unknown as { _ruleName?: string })._ruleName
      : undefined
    // Non-defer (monolithic, refs are final): if the arm's CACHED first-set is `any`
    // only because it was built over `ref()`s (which cache `any()` at construction),
    // recover a real guard from the DEEP, ref-resolving first-set. Sound here because
    // refs can't be overridden; the compose path defers instead (above).
    const baseFsGuard = deferRuleName !== undefined
      ? `/*@FS:${deferRuleName}:${codeV}@*/true`
      : needsFirstSetGuard(p)
        ? firstSetCond(codeV, p._meta.firstSet)
        : (() => {
            if (p._meta.firstSet.kind !== 'any' || matchesEmpty(p)) return null
            const deep = firstSetOf(p)
            return deep.kind === 'ranges' ? firstSetCond(codeV, deep) : null
          })()
    // sharedPrefix: every arm additionally requires the once-recognized prefix to
    // have matched (`armGuardPrefix`), so a prefix miss skips ALL arms → each slot
    // takes its `staticFx` (== the prefix expected) exactly as the un-factored
    // firstMatch would, and a prefix hit lets the arm run and REPLAY the prefix.
    const fsGuard = armGuardPrefix === undefined
      ? baseFsGuard
      : baseFsGuard === null ? armGuardPrefix : `${armGuardPrefix} && (${baseFsGuard})`

    // Gate: register predicate in mapFns; condition guards entire arm attempt
    let gateCond: string | null = null
    if (gate) {
      const gateIdx = ctx.mapFns.length
      ctx.mapFns.push(gate as (v: unknown, span: unknown) => unknown)
      // Macro path: inline the captured gate source (def.gateSrcs[i]); runtime
      // compile() has no source → null (closure in mapFns drives it). Parallel-
      // length invariant preserved either way.
      ctx.mapFnSrcs.push(def.gateSrcs?.[i] ?? null)
      gateCond = `${mfRef(ctx)}[${gateIdx}](_ctx.state)`
    }
    const skipCond = gateCond ? `!${resOkV} && ${gateCond}` : `!${resOkV}`

    const armHasAutoNot = !!(autoNot && autoNot.length > 0)
    // No `mayFail(p)` gate here, deliberately. Every mark below is read only
    // from the `else` of this arm's `if (ok)`, so an infallible arm would not
    // need any of them — but MEASURED, the gate changes not one byte of css,
    // less, scss, jess or any size-guard fixture. A `firstMatch` arm is a real
    // grammar production; they are all fallible. The dead-arm case is theory.
    const armNeedsRollback = ctx.capturing &&
      (mayLeavePartialCapture(p, new Set(), ctx.activeTrivia !== undefined) || (armHasAutoNot && capturesLeaf(p)))
    const armNeedsFieldRollback = armNeedsRollback && parserHasOwnFields(p)
    const armMayRecordError = mayRecordRecoveryError(p, !!ctx.recovery)
    const markLeaves = armNeedsRollback ? v(ctx, '_cml') : null
    const markRaw    = armNeedsRollback ? v(ctx, '_cmr') : null
    const markTl     = armNeedsRollback ? v(ctx, '_cmtl') : null
    const markLog    = armNeedsRollback ? v(ctx, '_cmlg') : null
    const markRootLog = ctx.activeTrivia && hasSelectedRootTrivia(ctx) ? v(ctx, '_cmlrg') : null
    const markFields = armNeedsFieldRollback ? v(ctx, '_cmf') : null
    const markErrors = armMayRecordError ? v(ctx, '_cme') : null
    const captureRollback = markLeaves
      ? captureRestoreBody(ctx, markLeaves, markRaw!, markTl!, markLog!, markFields, markRootLog)
      : ''
    const rootRollback = markRootLog && !markLeaves
      ? emitRestore(ctx, [['_ctx._rootTriviaLog', markRootLog]])
      : ''
    const errorRollback = markErrors
      ? emitRestore(ctx, [['_ctx._errors', markErrors]])
      : ''
    const rollback = [captureRollback, rootRollback, errorRollback].filter(Boolean).join('; ')
    const failSlot = atStart ? staticFx : '_ctx._fx'

    stmts.push(`${ind0}if (${skipCond}) {`)
    if (fsGuard) stmts.push(`${ind(ctx)}if (${fsGuard}) {`)
    ctx.indent += fsGuard ? 2 : 1
    if (coverageBase !== undefined) stmts.push(`${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'attempt', offset: ${pos} })`)

    if (markLeaves) {
      stmts.push(
        `${ind(ctx)}const ${markLeaves} = _ctx._cstLeaves?.length ?? 0`,
        `${ind(ctx)}const ${markRaw} = _ctx._cstRawChildren?.length ?? 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog?.length ?? 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog?.length ?? 0`,
        ...(markFields ? [`${ind(ctx)}const ${markFields} = _ctx._fields?.length ?? 0`] : []),
      )
    }
    if (markRootLog) stmts.push(`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog?.length ?? 0`)
    if (markErrors) stmts.push(`${ind(ctx)}const ${markErrors} = _ctx._errors?.length ?? 0`)
    const arm = emitFallible(p, ctx, pos, atStart)
    const { stmts: armStmts, okVar, valVar, endVar } = arm
    stmts.push(...armStmts)

    if (autoNot && autoNot.length > 0) {
      const anCode = v(ctx, '_anc')
      const rejectCond = autoNot.map(check =>
        check.kind === 'firstSet'
          ? firstSetCond(anCode, check.set)
          : `input.startsWith(${JSON.stringify(check.value)}, ${endVar})`
      ).join(' || ')
      stmts.push(`${ind(ctx)}if (${okVar}) {`)
      stmts.push(`${ind(ctx)}  const ${anCode} = ${endVar} < input.length ? input.charCodeAt(${endVar}) : -1`)
      stmts.push(`${ind(ctx)}  if (!(${rejectCond})) {`)
      stmts.push(`${ind(ctx)}    ${resValV} = ${valVar}`)
      stmts.push(`${ind(ctx)}    ${resEndV} = ${endVar}`)
      stmts.push(`${ind(ctx)}    ${resOkV} = true`)
      if (autoRejectedV !== undefined) {
        stmts.push(`${ind(ctx)}    for (const _rejectedId of ${autoRejectedV}) { _ctx._grammarTrace?.write({ id: _rejectedId, phase: 'failure', offset: ${pos} }); _ctx._grammarTrace?.write({ id: _rejectedId, phase: 'backtrack', offset: ${pos} }) }`)
      }
      stmts.push(...coverageHit(ctx, coverageBase === undefined ? undefined : `${coverageBase}${i}`, pos, endVar))
      stmts.push(`${ind(ctx)}  }`)
      if (autoRejectedV !== undefined) {
        stmts.push(`${ind(ctx)}  else { ${autoRejectedV}.push(${JSON.stringify(`${coverageBase}${i}`)}) }`)
      }
      stmts.push(`${ind(ctx)}}`)
      stmts.push(`${ind(ctx)}else { ${slots[i]} = ${failSlot}; ${coverageBase === undefined ? '' : `_ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'failure', offset: ${atStart ? pos : '_ctx._fe'} }); _ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'backtrack', offset: ${pos} });`} }`)
      if (rollback) stmts.push(`${ind(ctx)}if (!${resOkV}) { ${rollback} }`)
      if (arm.mayCommit) stmts.push(`${ind(ctx)}if (!${resOkV} && _ctx._fc) ${committedFailBody(ctx)}`)
    } else {
      const rejectedFlush = autoRejectedV === undefined
        ? ''
        : `; for (const _rejectedId of ${autoRejectedV}) { _ctx._grammarTrace?.write({ id: _rejectedId, phase: 'failure', offset: ${pos} }); _ctx._grammarTrace?.write({ id: _rejectedId, phase: 'backtrack', offset: ${pos} }) }`
      stmts.push(`${ind(ctx)}if (${okVar}) { ${resValV} = ${valVar}; ${resEndV} = ${endVar}; ${resOkV} = true${coverageBase === undefined ? '' : `${rejectedFlush}; _ctx._grammarCoverage?.(${JSON.stringify(`${coverageBase}${i}`)}); _ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'selected', offset: ${pos}, end: ${endVar} }); _ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'success', offset: ${pos}, end: ${endVar} })`} }`)
      stmts.push(`${ind(ctx)}else { ${slots[i]} = ${failSlot}${rollback ? `; ${rollback}` : ''}${coverageBase === undefined ? '' : `; _ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'failure', offset: ${atStart ? pos : '_ctx._fe'} }); _ctx._grammarTrace?.write({ id: ${JSON.stringify(`${coverageBase}${i}`)}, phase: 'backtrack', offset: ${pos} })`} }`)
      if (arm.mayCommit) stmts.push(`${ind(ctx)}if (!${resOkV} && _ctx._fc) ${committedFailBody(ctx)}`)
    }

    ctx.indent -= fsGuard ? 2 : 1
    if (fsGuard) stmts.push(`${ind(ctx)}} else { ${slots[i]} = ${staticFx} }`)
    stmts.push(`${ind0}}`)
  }
  const concatExpr = `[${slots.map(s => `...(${s} || [])`).join(', ')}]`
  stmts.push(...emitIfFail(ctx, `!${resOkV}`, failArrBody(ctx, concatExpr, pos, false)))
  return { stmts, valueVar: resValV, endVar: resEndV }
}

/**
 * True when `p` would be emitted as a CALL into a separate function body rather than
 * inline — a lazy/ref, a named rule (linkable/fused form), an already-hoisted parser,
 * or a shared subtree that the lazy-usage pre-pass will hoist to a `_pf` function.
 * Mirrors the hoist decision in emit() (the top-level `_pf` gate + emitLazy).
 */
function emitsAsNamedFn(p: Combinator<unknown>, ctx: Ctx): boolean {
  if (p._def.tag === 'lazy') return true
  if (ctx.ruleNames?.has(p)) return true
  if (ctx.namedParsers.has(p)) return true
  const usage = ctx.lazyUsage
  return !!usage && !ctx.noHoist && !ctx.capAsTrivia && isHoistableTag(p._def.tag)
    && (usage.counts.get(p) ?? 0) > 1 && (usage.sizes.get(p) ?? 0) >= HOIST_MIN_SUBTREE
}

/**
 * True when a routed-bearing branch must cross a generated function boundary.
 *
 * emitDispatchCombinator suppresses ordinary shared-subtree hoisting while
 * emitting routed branch tails, so same-body `routed()` sites can use locals.
 * Private single-use non-recursive lazy refs mirror emitLazy and inline through
 * this analysis. Named rules, recursive/multi-use refs, and already-generated
 * private functions still cross function bodies; those need the `_ctx._routed`
 * bridge.
 */
function routedNeedsContextBridge(p: Combinator<unknown>, ctx: Ctx, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  if (p._def.tag === 'lazy') {
    if (ctx.ruleNames?.has(p) || ctx.namedParsers.has(p)) return parserUsesRouted(p)
    const usage = ctx.lazyUsage
    if (usage && (usage.counts.get(p) ?? 0) <= 1 && !usage.recursive.has(p)) {
      try { return routedNeedsContextBridge(p._def.thunk(), ctx, seen) }
      catch { return parserUsesRouted(p) }
    }
    return parserUsesRouted(p)
  }
  if (ctx.ruleNames?.has(p)) return parserUsesRouted(p)
  if (ctx.namedParsers.has(p)) return parserUsesRouted(p)
  const d = p._def
  if (d.tag === 'dispatch') return false
  if (d.tag === 'withCtx') return parserUsesRouted(d.parser)
  return childrenOf(d).some(child => routedNeedsContextBridge(child, ctx, seen))
}

/**
 * sharedPrefix same-scope guard. The strategy recognizes the shared prefix once into
 * a variable declared in the CHOICE's function, then replays it at each arm's leading
 * term. That only works when the choice and every grouped arm — through its
 * node/parser/transform/label wrappers down to the shared sequence — compile into the
 * SAME function body. On the linkable/fused path (and with shared-subtree hoisting) an
 * arm can be emitted into a separate `_pf`/`_r_<Name>` function, which would reference
 * the pre-scan variable out of scope → a runtime ReferenceError. Return false there so
 * the choice conservatively falls back to the byte-identical firstMatch.
 */
function armReplayInScope(arm: Combinator<unknown>, ctx: Ctx): boolean {
  let p = arm
  for (;;) {
    if (emitsAsNamedFn(p, ctx)) return false
    const d = p._def
    if (d.tag === 'node' || d.tag === 'grammar' || d.tag === 'transform' || d.tag === 'label') {
      p = (d as { parser: Combinator<unknown> }).parser
      continue
    }
    return d.tag === 'sequence'
  }
}

// ── sharedPrefix: recognize a common leading literal/regex ONCE, then REPLAY ──
// Every arm shares the same concrete leading terminal `prefix` (reached by peeling
// node/parser(grammar)/transform/label wrappers down to the core sequence). We
// recognize `prefix` a SINGLE time up front (recognition-only — no leaf capture),
// then emit each arm through the ordinary emitFirstMatch: an intercept in emit()
// makes each arm's own leading-terminal instance REPLAY the once-recognized end +
// value (and push its leaf into whatever capture scope the arm is in — e.g. the
// arm's own node() buffer) instead of re-scanning. Because the whole arm (node,
// parser-trivia, sequence tail, reducer, capture rollback) is emitted by the
// unchanged emitFirstMatch machinery, the reducer's children[0], spans, trivia
// logs, and failure `expected` sets stay byte-identical; only the prefix SCAN is
// shared. The per-arm first-char guard is ANDed with the prefix-matched flag so a
// prefix miss skips all arms and yields firstMatch's prefix-expected-per-arm set.
function emitSharedPrefix(
  def: Extract<ParserDef, { tag: 'choice' }>,
  strategy: Extract<ChoiceStrategy, { tag: 'sharedPrefix' }>,
  ctx: Ctx,
  pos: string,
): ER {
  const { prefix, members } = strategy

  // Recognize the shared prefix ONCE, recognition-only (capturing suppressed so no
  // leaf reaches the enclosing scope — each arm replays the leaf into its OWN scope).
  // `swallow=false` keeps recordFail on, so a prefix miss records `_ctx._fx` = the
  // prefix expected, exactly as an un-factored arm's leading term would.
  const savedCapturing = ctx.capturing
  ctx.capturing = false
  const pfx = emitFallible(prefix, ctx, pos, false)
  ctx.capturing = savedCapturing

  // Register the replay for EACH arm's own leading-terminal instance (all members'
  // leading terms are structurally identical to `prefix`; each is a distinct object
  // reached during that arm's emission).
  const map = (ctx.replayPrefix ??= new Map())
  const keys: Combinator<unknown>[] = []
  for (const i of members) {
    // Shared with the detector (choice.ts) so codegen groups exactly what detection
    // grouped — peel node/parser/transform/label to the core sequence's first term.
    const term0 = leadingTermOfArm(def.parsers[i]!)
    if (term0 === null) continue
    map.set(term0, { valVar: pfx.valVar, endVar: pfx.endVar })
    keys.push(term0)
  }

  const r = emitFirstMatch(def, ctx, pos, undefined, pfx.stmts, pfx.okVar)

  for (const k of keys) map.delete(k)
  return r
}

/**
 * Replay a shared prefix's already-recognized leaf: emit no scan, reuse the
 * once-computed value + end, and push the leaf into the active capture scope. This
 * reproduces the leading terminal's SUCCESS path byte-for-byte (same value string,
 * same {pos,end} span, same leaf object) — the arms are only ever reached when the
 * prefix matched, so the scan/failure path is never needed here.
 */
function emitReplayPrefixLeaf(ctx: Ctx, pos: string, replay: { valVar: string; endVar: string }): ER {
  const vv = v(ctx)
  return {
    stmts: [
      `${ind(ctx)}const ${vv} = ${replay.valVar}`,
      ...emitLeafCapture(ctx, vv, pos, replay.endVar),
    ],
    valueVar: vv,
    endVar: replay.endVar,
  }
}

function emitNonDisjoint(
  def: Extract<ParserDef, { tag: 'choice' }>,
  strategy: ChoiceStrategy,
  allExpected: string,
  ctx: Ctx,
  pos: string,
  coverageBase?: string,
): ER {
  if (strategy.tag === 'greedyClassify')
    return emitGreedyClassify(def, strategy.superIndex, ctx, pos, coverageBase)
  if (strategy.tag === 'literalsLongestFirst')
    return emitLiteralsLongestFirst(def, strategy.sortedIndices, allExpected, ctx, pos, coverageBase)
  if (strategy.tag === 'sharedPrefix') {
    // The shared prefix is always a CONCRETE literal/regex (the detector never
    // groups arms whose leading term is — or reaches through — a ref), so it is
    // never overridable and safe to scan once even on the linkable/fused
    // (`deferFirstSetRefs`) path: only the once-recognized prefix SCAN is shared,
    // while each arm's residual terms (which MAY contain deferred refs) continue
    // through the ordinary emitFirstMatch/emitFallible emission that already
    // resolves ref first-sets at fuse time. This is the mode jess actually compiles
    // in, so gating it off here made the whole strategy inert for real grammars.
    // Coverage tracing and tolerant-recovery still carry extra per-arm bookkeeping
    // the rewrite doesn't reproduce, so fall back to the byte-identical firstMatch
    // there (sharedPrefix IS a firstMatch specialization, so the fallback is a
    // semantic no-op). And it only fires when every grouped arm compiles into the
    // SAME function scope as the choice — otherwise the once-recognized prefix's
    // replay variable would be referenced out of scope from an arm hoisted into its
    // own function (a ReferenceError on the fused/linkable path).
    if (!_forceNoSharedPrefix && coverageBase === undefined && !ctx.recovery
      && strategy.members.every(i => armReplayInScope(def.parsers[i]!, ctx)))
      return emitSharedPrefix(def, strategy, ctx, pos)
    return emitFirstMatch(def, ctx, pos, coverageBase)
  }
  return emitFirstMatch(def, ctx, pos, coverageBase)
}

// ── helpers for emitGreedyClassify / emitLiteralsLongestFirst ────────────────

/** Apply transform chain only — no parsing, value already known. */
/** Register a map fn, INTERNING by source so identical callbacks (e.g. every
 * balanced()'s merge closure) share one `_mf` slot. Relies on `mapFns` and
 * `mapFnSrcs` staying parallel — gate/guard/withCtx push a `null` source alongside
 * their `mapFns` entry to preserve that invariant, so interning keeps firing after
 * one of them (a `null` never matches a real source, so their slots are never
 * aliased). */
function pushMapFn(ctx: Ctx, fn: Ctx['mapFns'][number], src: string | null): number {
  if (src !== null && ctx.mapFns.length === ctx.mapFnSrcs.length) {
    const hit = ctx.mapFnSrcs.indexOf(src)
    if (hit !== -1) return hit
  }
  const idx = ctx.mapFns.length
  ctx.mapFns.push(fn)
  ctx.mapFnSrcs.push(src)
  return idx
}

function emitTransformChain(p: Combinator<unknown>, baseValue: string, endV: string, startPos: string, ctx: Ctx): ER {
  const def = p._def
  if (def.tag === 'transform') {
    const innerR = emitTransformChain(def.parser, baseValue, endV, startPos, ctx)
    const fnIdx = pushMapFn(ctx, def.fn, def.fnSrc ?? null)
    const vv = v(ctx)
    return {
      stmts: [...innerR.stmts, `${ind(ctx)}const ${vv} = ${mfRef(ctx)}[${fnIdx}](${innerR.valueVar}, { start: ${startPos}, end: ${endV} })`],
      valueVar: vv,
      endVar: endV,
    }
  }
  return { stmts: [], valueVar: baseValue, endVar: endV }
}

/** Emit a condition that is true iff input matches `litVal` at `pos`. No side effects. */
function emitLiteralCondition(litVal: string, pos: string): string {
  const len = litVal.length
  if (len === 0) return 'true'
  if (len > CHARCODE_CHAIN_MAX) return `input.startsWith(${JSON.stringify(litVal)}, ${pos})`
  // Short string: charCodeAt checks (same as emitLit)
  const checks = [`${pos} + ${len} <= input.length`]
  for (let i = 0; i < len; i++) {
    const code = litVal.codePointAt(i)!
    checks.push(`input.charCodeAt(${pos}${i > 0 ? ` + ${i}` : ''}) === ${code}`)
  }
  return checks.join(' && ')
}

function emitMany(def: Extract<ParserDef, { tag: 'many' | 'oneOrMore' }>, ctx: Ctx, pos: string): ER {
  // `valueUnused` (markUnusedValues): the array is never observed (this many sits
  // under a node() that builds from captured children). Skip building it — the
  // loop still runs and items self-capture. Value is `undefined` (unread).
  const wantValue = !def.valueUnused
  const arrV = v(ctx, '_arr')
  const curV = v(ctx, '_cur')
  const stmts: string[] = [
    ...(wantValue ? [`${ind(ctx)}const ${arrV} = []`] : []),
    `${ind(ctx)}let ${curV} = ${pos}`,
  ]
  // Capture this list's recovery sync at ENTRY: a nested element sequence will
  // clobber `_ctx._sync` (and doesn't restore it, unlike the interpreter's
  // finally), so the loop must read its own saved sync, not the live one.
  const mySyncV = ctx.recovery ? v(ctx, '_mysy') : ''
  if (ctx.recovery) stmts.push(`${ind(ctx)}const ${mySyncV} = _ctx._sync`)

  // `min` MANDATORY matches, inlined with early-return on failure. min 0/1 is the
  // whole world today, so the loop runs 0 or 1 times and the output is unchanged;
  // `many(x, { min: n })` simply inlines n of them.
  for (let i = 0; i < def.min; i++) {
    const firstR = emit(def.parser, ctx, curV)
    stmts.push(...firstR.stmts)
    if (wantValue) stmts.push(`${ind(ctx)}${arrV}.push(${firstR.valueVar})`)
    stmts.push(`${ind(ctx)}${curV} = ${firstR.endVar}`)
  }

  // `max` — a bounded repeat needs a live item count. `wantValue` lists can read
  // `arr.length`; a value-elided one needs its own counter. Emitted ONLY when a
  // finite max was asked for, so the unbounded default stays byte-identical.
  const maxV = def.max === undefined ? null : (wantValue ? `${arrV}.length` : v(ctx, '_cnt'))
  if (maxV !== null && !wantValue) stmts.push(`${ind(ctx)}let ${maxV} = ${def.min}`)

  stmts.push(`${ind(ctx)}while (${curV} < input.length) {`)
  ctx.indent++
  if (maxV !== null) stmts.push(`${ind(ctx)}if (${maxV} >= ${def.max}) break`)

  // Mirror interpreter repeat.ts — skip trivia before each iteration. In capture
  // mode the trivia is committed to rawChildren immediately and rolled back
  // (array truncation) if the following item doesn't materialize.
  let itemPos = curV
  let rollback = ''
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const markV = v(ctx, '_ml')
      const markTl = v(ctx, '_mltl')
      const markLog = v(ctx, '_mllg')
      const markRootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_mlrlg') : null
      const npV = v(ctx, '_np')
      stmts.push(
        `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
        ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${npV} = ${capFn}(input, ${curV}, _ctx, 1)`,
        ...emitLineTrack(ctx, curV, npV),
      )
      itemPos = npV
      rollback = `${emitRestore(ctx, [
        ['_ctx._cstRawChildren', markV],
        ['_ctx._cstTriviaLog', markTl],
        ['_ctx._triviaLog', markLog],
        ...(markRootLog ? [['_ctx._rootTriviaLog', markRootLog] as const] : []),
      ])}; `
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const markRootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_mlrlg') : null
      const npV = v(ctx, '_np')
      stmts.push(
        ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${npV} = ${trivFn}(input, ${curV}, _ctx, ${hasSelectedRootTrivia(ctx) ? '_ctx._rootTriviaLog !== undefined ? 2 : 0' : '0'})`,
        ...emitLineTrack(ctx, curV, npV),
      )
      itemPos = npV
      rollback = markRootLog ? `${emitRestore(ctx, [['_ctx._rootTriviaLog', markRootLog]])}; ` : ''
    }
  }

  // First-set body fast-path: if the next code point can't start the loop body,
  // this iteration can only fail — stop the loop with a single code-point
  // comparison instead of a full body attempt-then-fail. Sound exactly when the
  // body has a discrete (non-`any`) first set and can't match empty
  // (`needsFirstSetGuard`), so a first-set miss is a guaranteed non-match; it
  // mirrors the first-set arm guard the choice codegen already emits. Skipped
  // under `ctx.recovery`: there a swallowed body failure still feeds the
  // completions probe (`probeUpdate` fires inside swallowers), so the IDE build
  // keeps recording the body as a candidate at a non-matching char. A normal
  // parse records nothing on a swallowed body failure (`recordFail` off for many),
  // so skipping the attempt is behavior-identical there — pure speedup.
  //
  // Skipped when the body already `failsAtStart` (a bare literal/regex/keywords
  // leaf): its own generated code leads with the identical first-char check, so
  // the guard would be pure redundancy and would perturb byte-identical leaf-body
  // output. The win is for COMPOSITE bodies (sequence/node) that do setup before
  // discovering a first-char mismatch — e.g. `many(sequence(op, atom))`.
  if (!ctx.recovery && !ctx.coverage && !failsAtStart(def.parser) && needsFirstSetGuard(def.parser)) {
    const lcV = v(ctx, '_lc')
    stmts.push(
      `${ind(ctx)}const ${lcV} = ${itemPos} < input.length ? (input.codePointAt(${itemPos}) ?? -1) : -1`,
      `${ind(ctx)}if (!(${firstSetCond(lcV, def.parser._meta.firstSet)})) { ${rollback}break }`,
    )
  }

  const iter = emitFallible(def.parser, ctx, itemPos, true)
  const { stmts: iterStmts, okVar: iterOk, valVar: iterVal, endVar: iterEnd } = iter
  stmts.push(...iterStmts)
  if (ctx.recovery) {
    // Tolerant recovery (dormant unless `_ctx._tolerant`): an element that fails —
    // and isn't sitting on the inferred sync token — is skipped to that token via
    // the SAME interpreter recoverScan (parity), emitted as a ParseError; the loop
    // continues. Zero-width progress is still a clean stop.
    const rrV = v(ctx, '_rr')
    const exp = hoistExpected(ctx, deriveExpectedArr([def.parser]))
    stmts.push(
      `${ind(ctx)}if (!${iterOk}) {`,
      `${ind(ctx)}  ${rollback}if (_ctx._tolerant && ${mySyncV} !== undefined && !_ctx._rec.at(${mySyncV}, input, ${itemPos}, _ctx)) {`,
      `${ind(ctx)}    const ${rrV} = _ctx._rec.scan(input, ${itemPos}, _ctx, ${mySyncV}, ${exp})`,
      ...(wantValue ? [`${ind(ctx)}    ${arrV}.push(${rrV}.error)`] : maxV !== null ? [`${ind(ctx)}    ${maxV}++`] : []),
      `${ind(ctx)}    _ctx._rec.capture(_ctx, ${rrV}.error)`,
      `${ind(ctx)}    ${curV} = ${rrV}.end`,
      `${ind(ctx)}    continue`,
      `${ind(ctx)}  }`,
      `${ind(ctx)}  break`,
      `${ind(ctx)}}`,
      `${ind(ctx)}if (${iterEnd} <= ${itemPos}) { ${rollback}break }`,
    )
  } else {
    stmts.push(`${ind(ctx)}if (!${iterOk}) { ${rollback}${iter.mayCommit ? `if (_ctx._fc) ${committedFailBody(ctx)}; ` : ''}break }`)
    stmts.push(`${ind(ctx)}if (${iterEnd} <= ${itemPos}) { ${rollback}break }`)
  }
  if (wantValue) stmts.push(`${ind(ctx)}${arrV}.push(${iterVal})`)
  else if (maxV !== null) stmts.push(`${ind(ctx)}${maxV}++`)
  stmts.push(`${ind(ctx)}${curV} = ${iterEnd}`)
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  return { stmts, valueVar: wantValue ? arrV : 'undefined', endVar: curV }
}

function emitOptional(def: Extract<ParserDef, { tag: 'optional' }>, ctx: Ctx, pos: string): ER {
  const valV = v(ctx, '_opt')
  const endV = v(ctx, '_opte')

  const inner = emitFallible(def.parser, ctx, pos, true)
  const { stmts: lblStmts, okVar, valVar, endVar } = inner

  const ind0 = ind(ctx)
  const stmts = [
    ...lblStmts,
    ...(inner.mayCommit ? [`${ind0}if (!${okVar} && _ctx._fc) ${committedFailBody(ctx)}`] : []),
    `${ind0}const ${valV} = ${okVar} ? ${valVar} : null`,
    `${ind0}const ${endV} = ${okVar} ? ${endVar} : ${pos}`,
  ]
  return { stmts, valueVar: valV, endVar: endV }
}

/** Transactional parser arm: emitFallible owns the private failure label and
 * structural rollback; Attempt only re-anchors the diagnostic at its entry. */
function emitAttempt(p: Combinator<unknown>, def: Extract<ParserDef, { tag: 'attempt' }>, ctx: Ctx, pos: string): ER {
  const inner = emitFallible(def.parser, ctx, pos)
  // Unlike an ordinary fallible sub-parser, attempt is a semantic transaction:
  // every framework-owned side effect from its rejected branch disappears.  Keep
  // this boundary here (rather than teaching emitFallible different semantics),
  // because ordinary sequences deliberately retain their diagnostic trivia.
  const leaves = v(ctx, '_atl')
  const raw = v(ctx, '_atr')
  const trivia = v(ctx, '_att')
  const log = v(ctx, '_atg')
  const rootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_atrg') : null
  const fields = v(ctx, '_atf')
  const errors = v(ctx, '_ate')
  const rollback = emitRestore(ctx, [
    ['_ctx._cstLeaves', leaves],
    ['_ctx._cstRawChildren', raw],
    ['_ctx._cstTriviaLog', trivia],
    ['_ctx._triviaLog', log],
    ...(rootLog ? [['_ctx._rootTriviaLog', rootLog] as const] : []),
    ['_ctx._fields', fields],
    ['_ctx._errors', errors],
  ])
  const traceId = ctx.coverage?.plan.attempts.get(p)
  const traceRollback = traceId === undefined ? '' : ` _ctx._grammarTrace?.write({ id: ${JSON.stringify(traceId)}, phase: 'rollback', offset: ${pos} });`
  // First-set fail-fast before the transaction marks. `attempt(inner)` reads six
  // rollback marks before `inner` recognizes anything; a non-dispatching caller
  // (e.g. `choice(attempt(MixinReference), …)` on the non-disjoint majority) enters
  // it at every position and rejects on the first byte. Bail on a first-set miss
  // before the marks, re-anchoring the failure at `pos` like the transaction's own
  // reject, and recording the same static `expected` the inner start-fail would.
  // Skipped under recovery (the completions probe still wants the swallowed failure).
  const preGuard: string[] = []
  if (!ctx.recovery && !ctx.coverage && needsFirstSetGuard(def.parser)) {
    const gcV = v(ctx, '_agc')
    const gExp = armStaticExpected(ctx, def.parser)
    const gFail = ctx.failLabel
      ? `{ _ctx._fe = ${pos};${ctx.recordFail ? ` _ctx._fx = ${gExp};` : ''} break ${ctx.failLabel} }`
      : `{ _ctx._fe = ${pos}; ${failReturnArr(ctx, gExp, pos)} }`
    preGuard.push(
      `${ind(ctx)}const ${gcV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
      `${ind(ctx)}if (!(${firstSetCond(gcV, def.parser._meta.firstSet)})) ${gFail}`,
    )
  }
  return {
    stmts: [
      ...preGuard,
      `${ind(ctx)}const ${leaves} = _ctx._cstLeaves?.length ?? 0, ${raw} = _ctx._cstRawChildren?.length ?? 0, ${trivia} = _ctx._cstTriviaLog?.length ?? 0, ${log} = _ctx._triviaLog?.length ?? 0${rootLog ? `, ${rootLog} = _ctx._rootTriviaLog?.length ?? 0` : ''}, ${fields} = _ctx._fields?.length ?? 0, ${errors} = _ctx._errors?.length ?? 0`,
      ...inner.stmts,
      ...emitIfFail(ctx, `!${inner.okVar}`, `{ ${rollback};${traceRollback}${inner.mayCommit ? ` if (_ctx._fc) ${committedFailBody(ctx)};` : ''} _ctx._fe = ${pos}; ${propagateFailBody(ctx)} }`),
    ],
    valueVar: inner.valVar,
    endVar: inner.endVar,
  }
}

function emitSepBy(_p: Combinator<unknown>, def: Extract<ParserDef, { tag: 'sepBy' }>, ctx: Ctx, pos: string): ER {
  const arrV = v(ctx, '_arr')
  const curV = v(ctx, '_cur')
  const rec = !!ctx.recovery
  // Recovery sync = the separator's own follow (resync to the next separator) OR the
  // enclosing delimiter published as _ctx._sync — captured at ENTRY (element parses
  // clobber _ctx._sync). The separator sentinel is exact for single-char separators.
  const mySyncV = rec ? v(ctx, '_mysy') : ''
  const exp = rec ? hoistExpected(ctx, deriveExpectedArr([def.parser])) : ''
  const sepSent = rec ? syncSentinelExpr(firstSetOf(def.separator)) : null
  const scanSync = sepSent ? `_ctx._rec.or(${sepSent}, ${mySyncV})` : mySyncV

  const first = emitFallible(def.parser, ctx, pos, true)
  const { stmts: firstStmts, okVar: firstOk, valVar: firstVal, endVar: firstEnd } = first

  const stmts: string[] = [
    `${ind(ctx)}const ${arrV} = []`,
    `${ind(ctx)}let ${curV} = ${pos}`,
    ...(rec ? [`${ind(ctx)}const ${mySyncV} = _ctx._sync`] : []),
    ...firstStmts,
  ]

  // A failed element after a real separator. Strict → the exact original break
  // (byte-identical). Tolerant → skip to the sync, emit a ParseError, and continue
  // (unless already sitting on the enclosing sync). `originalFail` is that site's
  // exact strict string (the three sites differ — braces / rollback).
  const failItem = (nextOkVar: string, nextMayCommit: boolean, itemPosVar: string, breakStmt: string): string[] => {
    // A bare `break` stays brace-less — the emitted source is byte-identical to
    // the pre-options output for every default-option sepBy.
    const commit = nextMayCommit ? `if (_ctx._fc) ${committedFailBody(ctx)}; ` : ''
    if (!rec) return [`${ind(ctx)}if (!${nextOkVar}) { ${commit}${breakStmt} }`]
    const rr = v(ctx, '_rr')
    return [
      `${ind(ctx)}if (!${nextOkVar}) {`,
      ...(nextMayCommit ? [`${ind(ctx)}  if (_ctx._fc) ${committedFailBody(ctx)}`] : []),
      `${ind(ctx)}  if (_ctx._tolerant && ${mySyncV} !== undefined && !_ctx._rec.at(${mySyncV}, input, ${itemPosVar}, _ctx)) {`,
      `${ind(ctx)}    const ${rr} = _ctx._rec.scan(input, ${itemPosVar}, _ctx, ${scanSync}, ${exp})`,
      `${ind(ctx)}    ${arrV}.push(${rr}.error); _ctx._rec.capture(_ctx, ${rr}.error); ${curV} = ${rr}.end; continue`,
      `${ind(ctx)}  }`,
      `${ind(ctx)}  ${breakStmt}`,
      `${ind(ctx)}}`,
    ]
  }

  /**
   * The break taken when the item AFTER a separator fails.
   *
   * 'forbid' (default) unwinds the separator with it — the list ends before it.
   * 'allow' keeps the separator CONSUMED: only what was captured PAST it unwinds
   * (`postSepRb`), and `cur` advances to the separator's end.
   */
  const itemFailBreak = (sepEndVar: string, sepRb: string, postSepRb: string): string =>
    def.trailing === undefined
      ? `${sepRb}break`
      : `${postSepRb}${curV} = ${sepEndVar}; break`

  /** Marks taken AFTER the separator, so `trailing` can unwind only past it. */
  const postSepMarks = (): { decl: string[]; rb: string } => {
    if (def.trailing === undefined || !ctx.capturing) return { decl: [], rb: '' }
    const lv = v(ctx, '_tlv'), rw = v(ctx, '_trw'), tl = v(ctx, '_ttl'), lg = v(ctx, '_tlg'), rlg = hasSelectedRootTrivia(ctx) ? v(ctx, '_trlg') : null, fl = v(ctx, '_tlf')
    return {
      decl: [
        `${ind(ctx)}const ${lv} = _ctx._cstLeaves ? _ctx._cstLeaves.length : 0`,
        `${ind(ctx)}const ${rw} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${tl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${lg} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
        ...(rlg ? [`${ind(ctx)}const ${rlg} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${fl} = _ctx._fields ? _ctx._fields.length : 0`,
      ],
      rb: `${emitRestore(ctx, [
        ['_ctx._cstLeaves', lv],
        ['_ctx._cstRawChildren', rw],
        ['_ctx._cstTriviaLog', tl],
        ['_ctx._triviaLog', lg],
        ...(rlg ? [['_ctx._rootTriviaLog', rlg] as const] : []),
        ['_ctx._fields', fl],
      ])}; `,
    }
  }

  // First element + loop entry. Strict keeps the exact `if (firstOk) { … while }`
  // shape (byte-identical). Tolerant recovers a junk first element (unless sitting
  // on the enclosing sync) and still enters the loop via a `did` flag.
  if (rec) {
    const rr0 = v(ctx, '_rr0')
    const didV = v(ctx, '_did')
    stmts.push(
      `${ind(ctx)}let ${didV} = false`,
      `${ind(ctx)}if (${firstOk}) { ${arrV}.push(${firstVal}); ${curV} = ${firstEnd}; ${didV} = true }`,
      ...(first.mayCommit ? [`${ind(ctx)}else if (_ctx._fc) ${committedFailBody(ctx)}`] : []),
      `${ind(ctx)}else if (_ctx._tolerant && ${mySyncV} !== undefined && !_ctx._rec.at(${mySyncV}, input, ${pos}, _ctx)) {`,
      `${ind(ctx)}  const ${rr0} = _ctx._rec.scan(input, ${pos}, _ctx, ${scanSync}, ${exp})`,
      `${ind(ctx)}  ${arrV}.push(${rr0}.error); _ctx._rec.capture(_ctx, ${rr0}.error); ${curV} = ${rr0}.end; ${didV} = true`,
      `${ind(ctx)}}`,
      `${ind(ctx)}if (${didV}) {`,
    )
    ctx.indent++
    stmts.push(`${ind(ctx)}while (${curV} < input.length) {`)
    ctx.indent++
  } else {
    if (first.mayCommit) stmts.push(`${ind(ctx)}if (!${firstOk} && _ctx._fc) ${committedFailBody(ctx)}`)
    stmts.push(`${ind(ctx)}if (${firstOk}) {`)
    ctx.indent++
    stmts.push(
      `${ind(ctx)}${arrV}.push(${firstVal})`,
      `${ind(ctx)}${curV} = ${firstEnd}`,
      `${ind(ctx)}while (${curV} < input.length) {`,
    )
    ctx.indent++
  }

  if (def.max !== undefined) stmts.push(`${ind(ctx)}if (${arrV}.length >= ${def.max}) break`)

  // Mirror interpreter sepBy — separate rollback marks for pre-sep and post-sep trivia.
  let sepAtPos = curV
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const markV = v(ctx, '_ml')
      const markTl = v(ctx, '_mltl')
      const markLog = v(ctx, '_mllg')
      const markRootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_mlrlg') : null
      const markLv = v(ctx, '_mllv')
      const markFld = v(ctx, '_mlf')
      const spV = v(ctx, '_sp')
      // Marks taken BEFORE the separator. If either the separator OR the following
      // item fails, the whole iteration unwinds to here — crucially undoing the
      // separator's own captured leaves/fields when the item after it fails.
      stmts.push(
        `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
        ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${markLv} = _ctx._cstLeaves ? _ctx._cstLeaves.length : 0`,
        `${ind(ctx)}const ${markFld} = _ctx._fields ? _ctx._fields.length : 0`,
        `${ind(ctx)}const ${spV} = ${capFn}(input, ${curV}, _ctx, 1)`,
        ...emitLineTrack(ctx, curV, spV),
      )
      sepAtPos = spV
      const rollbackToSep = `${emitRestore(ctx, [
        ['_ctx._cstLeaves', markLv],
        ['_ctx._cstRawChildren', markV],
        ['_ctx._cstTriviaLog', markTl],
        ['_ctx._triviaLog', markLog],
        ...(markRootLog ? [['_ctx._rootTriviaLog', markRootLog] as const] : []),
        ['_ctx._fields', markFld],
      ])}; `
      const sep = emitFallible(def.separator, ctx, sepAtPos, true)
      const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = sep
      stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) { ${rollbackToSep}${sep.mayCommit ? `if (_ctx._fc) ${committedFailBody(ctx)}; ` : ''}break }`)

      const post = postSepMarks()
      stmts.push(...post.decl)
      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${capFn}(input, ${sepEnd}, _ctx, 1)`, ...emitLineTrack(ctx, sepEnd, npV))
      const next = emitFallible(def.parser, ctx, npV, true)
      const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } = next
      stmts.push(
        ...nextStmts,
        // item failed → unwind the separator too, back to the end of the last item
        ...failItem(nextOk, next.mayCommit, npV, itemFailBreak(sepEnd, rollbackToSep, post.rb)),
        `${ind(ctx)}${arrV}.push(${nextVal})`,
        `${ind(ctx)}${curV} = ${nextEnd}`,
      )
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const markRootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_mlrlg') : null
      const spV = v(ctx, '_sp')
      stmts.push(
        ...(markRootLog ? [`${ind(ctx)}const ${markRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${spV} = ${trivFn}(input, ${curV}, _ctx, ${hasSelectedRootTrivia(ctx) ? '_ctx._rootTriviaLog !== undefined ? 2 : 0' : '0'})`,
        ...emitLineTrack(ctx, curV, spV),
      )
      sepAtPos = spV
      const sep = emitFallible(def.separator, ctx, sepAtPos, true)
      const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = sep
      const rollbackToSep = markRootLog ? `${emitRestore(ctx, [['_ctx._rootTriviaLog', markRootLog]])}; ` : ''
      stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) { ${rollbackToSep}${sep.mayCommit ? `if (_ctx._fc) ${committedFailBody(ctx)}; ` : ''}break }`)

      const postRootLog = hasSelectedRootTrivia(ctx) ? v(ctx, '_psrlg') : null
      const npV = v(ctx, '_np')
      stmts.push(
        ...(postRootLog ? [`${ind(ctx)}const ${postRootLog} = _ctx._rootTriviaLog ? _ctx._rootTriviaLog.length : 0`] : []),
        `${ind(ctx)}const ${npV} = ${trivFn}(input, ${sepEnd}, _ctx, ${hasSelectedRootTrivia(ctx) ? '_ctx._rootTriviaLog !== undefined ? 2 : 0' : '0'})`,
        ...emitLineTrack(ctx, sepEnd, npV),
      )
      const next = emitFallible(def.parser, ctx, npV, true)
      const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } = next
      stmts.push(
        ...nextStmts,
        ...failItem(nextOk, next.mayCommit, npV, itemFailBreak(sepEnd, rollbackToSep, postRootLog ? `${emitRestore(ctx, [['_ctx._rootTriviaLog', postRootLog]])}; ` : '')),
        `${ind(ctx)}${arrV}.push(${nextVal})`,
        `${ind(ctx)}${curV} = ${nextEnd}`,
      )
    }
  } else {
    // No trivia. Still mark the leaf buffers before the separator so that an item
    // failing after the separator unwinds the separator's captured leaves too.
    const markLv = ctx.capturing ? v(ctx, '_mllv') : null
    const markRw = ctx.capturing ? v(ctx, '_mlrw') : null
    const markFld = ctx.capturing ? v(ctx, '_mlf') : null
    if (markLv) {
      stmts.push(
        `${ind(ctx)}const ${markLv} = _ctx._cstLeaves ? _ctx._cstLeaves.length : 0`,
        `${ind(ctx)}const ${markRw} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markFld} = _ctx._fields ? _ctx._fields.length : 0`,
      )
    }
    const sep = emitFallible(def.separator, ctx, sepAtPos, true)
    const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = sep
    stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) { ${sep.mayCommit ? `if (_ctx._fc) ${committedFailBody(ctx)}; ` : ''}break }`)
    const nextRb = markLv
      ? `${emitRestore(ctx, [
        ['_ctx._cstLeaves', markLv],
        ['_ctx._cstRawChildren', markRw!],
        ['_ctx._fields', markFld!],
      ])}; `
      : ''
    const post = postSepMarks()
    stmts.push(...post.decl)
    const next = emitFallible(def.parser, ctx, sepEnd, true)
    const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } = next
    stmts.push(
      ...nextStmts,
      ...failItem(nextOk, next.mayCommit, sepEnd, itemFailBreak(sepEnd, nextRb, post.rb)),
      `${ind(ctx)}${arrV}.push(${nextVal})`,
      `${ind(ctx)}${curV} = ${nextEnd}`,
    )
  }
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  // `min >= 1`: too few items ⇒ the whole list FAILS. (The min-0 default's empty
  // alternative is exactly what makes plain sepBy nullable and un-gateable.)
  // Anchored at `curV`, not `pos`: a list failure reports what would have let it
  // CONTINUE, at the furthest position it reached. See the `failAt` comment in
  // `sepBy()` (repeat.ts) for why, and `test/parity/repeat-options-parity.test.ts`
  // for the check that keeps the two engines on the same rule.
  if (def.min >= 1) {
    stmts.push(...emitIfFail(ctx, `${arrV}.length < ${def.min}`, failArrBody(ctx, deriveExpectedArr([def.parser]), curV)))
  }

  return { stmts, valueVar: arrV, endVar: curV }
}

function emitScanTo(
  def: Extract<ParserDef, { tag: 'scanTo' }>,
  ctx: Ctx,
  pos: string,
): ER {
  const curV   = v(ctx, '_stcur')
  const foundV = v(ctx, '_stfnd')
  const stmts: string[] = [
    `${ind(ctx)}let ${curV} = ${pos}`,
    `${ind(ctx)}let ${foundV} = false`,
    `${ind(ctx)}while (${curV} < input.length) {`,
  ]
  ctx.indent++

  // Sentinel check and skippers must not emit CST leaves — they are pure position
  // probes. Use a non-capturing ctx so their literal()/regex() don't push leaves.
  const probeCtx: Ctx = { ...ctx, capturing: false, noHoist: true }

  // Sentinel check — labeled block, no IIFE
  const { stmts: sentStmts, okVar: sentOk } = emitFallible(def.sentinel, probeCtx, curV)
  stmts.push(...sentStmts, `${ind(ctx)}if (${sentOk}) { ${foundV} = true; break }`)

  // Fold grammar-level ambient trivia + scanSkip in FRONT of the per-call skip
  // list (explicit skip EXTENDS the ambient default) — mirrors the interpreter's
  // resolveScanSkip so compiled and interpreted scans stay byte-identical. `raw`
  // opts out of everything ambient.
  const effectiveSkip: Combinator<unknown>[] = def.raw
    ? def.skip
    : [
        ...(ctx.activeTrivia ? [ctx.activeTrivia] : []),
        ...(ctx.activeScanSkip ?? []),
        ...def.skip,
      ]

  // Skippers — labeled block per skipper; a failure just means "not this one"
  if (effectiveSkip.length > 0) {
    const advV = v(ctx, '_stadv')
    stmts.push(`${ind(ctx)}let ${advV} = false`)
    for (const skipper of effectiveSkip) {
      const { stmts: skStmts, okVar: skOk, endVar: skEnd } = emitFallible(skipper, probeCtx, curV)
      stmts.push(
        `${ind(ctx)}if (!${advV}) {`,
        ...skStmts,
        `${ind(ctx)}  if (${skOk} && ${skEnd} > ${curV}) { ${curV} = ${skEnd}; ${advV} = true }`,
        `${ind(ctx)}}`,
      )
    }
    stmts.push(`${ind(ctx)}if (!${advV}) ${curV}++`)
  } else {
    stmts.push(`${ind(ctx)}${curV}++`)
  }

  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  // Fail if sentinel was never found (unless orEOF)
  if (!def.orEOF) {
    const sentDef = def.sentinel._def
    const expectedStr = sentDef.tag === 'literal'
      ? JSON.stringify([JSON.stringify(sentDef.value)])
      : `["sentinel"]`
    stmts.push(...emitIfFail(ctx, `!${foundV}`, failArrBody(ctx, expectedStr, pos)))
  }

  const valV = v(ctx)
  stmts.push(`${ind(ctx)}const ${valV} = input.slice(${pos}, ${curV})`)
  stmts.push(...emitLineTrack(ctx, pos, curV))
  // scanTo records its scanned span as one leaf (matching the interpreter), but
  // only when it actually consumed something.
  if (ctx.capturing) {
    const cap = reindentStmts(emitLeafCapture(ctx, valV, pos, curV), ctx.indent + 1)
    stmts.push(`${ind(ctx)}if (${curV} > ${pos}) {`, ...cap, `${ind(ctx)}}`)
  }
  return { stmts, valueVar: valV, endVar: curV }
}

/**
 * Negative lookahead. Run the inner parser in a labeled block; if it succeeds,
 * fail; if it fails, succeed consuming nothing (value null, end === pos).
 */
function emitNot(def: Extract<ParserDef, { tag: 'not' }>, ctx: Ctx, pos: string): ER {
  // not() discards the inner failure (inner failing = not succeeding), so the
  // inner sub-parse need not record — swallow it.
  //
  // Speculative rollback (mirrors the interpreter's not.ts): a zero-width predicate
  // must leave NO observable trace on EITHER outcome. emitFallible's own restore is
  // not enough on its own — it fires only `if (!ok)`, and both `mayLeavePartialCapture`
  // and `capturesLeaf` classify `'not'` as non-capturing, so nothing upstream cleans
  // up after it either. Two distinct leaks followed:
  //   - inner SUCCESS (not fails): the probe's leaves/rawChildren survive, and an
  //     enclosing optional/many that swallows the failure absorbs them — the compiled
  //     engine returned a duplicated leaf where the interpreter returned one.
  //   - EITHER outcome: the probe's inter-term trivia skips stay in the GLOBAL
  //     `_triviaLog`, which `captureRestoreBody` deliberately never rewinds (see its
  //     comment: sequence-term rollbacks stay byte-for-byte with the interpreter).
  //     `not` is zero-width, so the enclosing rule re-parses the probed region for
  //     real and the span is logged twice. Both engines leaked this one identically,
  //     which is why interpreted/compiled parity never flagged it.
  // The emitted rollback restores the same six sinks as `emitAttempt`, unconditionally
  // (not `if (!ok)`), because not() is zero-width on both outcomes.
  //
  // NOT emitted as a `capturing: false` probe ctx the way emitScanTo lowers its
  // sentinel: `emitLazy` does not honour `noHoist`, so a `not(namedRule)` that is the
  // FIRST emission of that rule would compile the SHARED `_r_<Name>`/`_pf` body
  // non-capturing and silently drop real captures at every other call site. Truncating
  // by length is correct regardless of hoisting or sharing.
  const sinksLive = !!ctx.capturing || !!ctx.recovery || !!ctx.activeTrivia
  const leaves = sinksLive ? v(ctx, '_ntl') : null
  const raw    = sinksLive ? v(ctx, '_ntr') : null
  const tl     = sinksLive ? v(ctx, '_ntt') : null
  const log    = sinksLive ? v(ctx, '_ntg') : null
  const rootLog = sinksLive && hasSelectedRootTrivia(ctx) ? v(ctx, '_ntrg') : null
  const fields = sinksLive ? v(ctx, '_ntf') : null
  const errors = sinksLive ? v(ctx, '_nte') : null
  const { stmts, okVar } = emitFallible(def.parser, ctx, pos, true)
  // not() fails (at its own pos) when the inner parser SUCCEEDS; the interpreter
  // reports `not(<innerTag>)` as the expected token — match that label exactly.
  const label = JSON.stringify(`not(${def.parser._tag})`)
  return {
    stmts: [
      ...(sinksLive ? [
        `${ind(ctx)}const ${leaves} = _ctx._cstLeaves?.length ?? 0, ${raw} = _ctx._cstRawChildren?.length ?? 0, ${tl} = _ctx._cstTriviaLog?.length ?? 0, ${log} = _ctx._triviaLog?.length ?? 0${rootLog ? `, ${rootLog} = _ctx._rootTriviaLog?.length ?? 0` : ''}, ${fields} = _ctx._fields?.length ?? 0, ${errors} = _ctx._errors?.length ?? 0`,
      ] : []),
      ...stmts,
      ...(sinksLive ? [
        `${ind(ctx)}${emitRestore(ctx, [
          ['_ctx._cstLeaves', leaves!],
          ['_ctx._cstRawChildren', raw!],
          ['_ctx._cstTriviaLog', tl!],
          ['_ctx._triviaLog', log!],
          ...(rootLog ? [['_ctx._rootTriviaLog', rootLog] as const] : []),
          ['_ctx._fields', fields!],
          ['_ctx._errors', errors!],
        ])}`,
      ] : []),
      ...emitIfFail(ctx, okVar, failBody(ctx, label, pos)),
    ],
    valueVar: 'null',
    endVar: pos,
  }
}

/**
 * Positive lookahead. Zero-width on BOTH outcomes, so the body is emitted under a
 * NON-CAPTURING ctx (the same probe treatment `emitScanTo` gives its sentinel):
 * a lookahead that leaves CST leaves behind would double-capture whatever the
 * following term then consumes for real.
 */
function emitPeek(def: Extract<ParserDef, { tag: 'peek' }>, ctx: Ctx, pos: string): ER {
  const probeCtx: Ctx = { ...ctx, capturing: false, noHoist: true }
  // The inner failure is discarded (inner failing = peek failing, reported at
  // peek's own pos with its own label) — swallow the sub-parse bookkeeping.
  const { stmts, okVar } = emitFallible(def.parser, probeCtx, pos, true)
  ctx.vars = probeCtx.vars
  const label = JSON.stringify(`peek(${def.parser._tag})`)
  return {
    stmts: [
      ...stmts,
      ...emitIfFail(ctx, `!${okVar}`, failBody(ctx, label, pos)),
    ],
    valueVar: 'null',
    endVar: pos,
  }
}

function emitRouted(ctx: Ctx, pos: string, def: Extract<ParserDef, { tag: 'routed' }>): ER {
  const local = ctx.routedLocal
  const fallback = def.fallback
  if (local !== undefined) {
    // Same-body dispatch branch. When the routed site sits at the branch's entry
    // position the guard is textually `X !== X` — the routed token is provably
    // there, so a fallback is dead code and is not emitted at all.
    if (fallback !== undefined && local.startVar !== pos) {
      return emitRoutedWithFallback(ctx, pos, fallback, {
        test: `${local.startVar} === ${pos}`,
        valExpr: local.valueVar, startExpr: local.startVar, endExpr: local.endVar,
      })
    }
    return {
      stmts: [
        ...emitIfFail(ctx, `${local.startVar} !== ${pos}`, failBody(ctx, '"routed()"', pos)),
        ...emitLeafCapture(ctx, local.valueVar, local.startVar, local.endVar),
      ],
      valueVar: local.valueVar,
      endVar: local.endVar,
    }
  }
  const item = v(ctx, '_rt')
  const read = `${ind(ctx)}const ${item} = _ctx._routed`
  if (fallback !== undefined) {
    const r = emitRoutedWithFallback(ctx, pos, fallback, {
      test: `${item} !== undefined && ${item}.span.start === ${pos}`,
      valExpr: `${item}.value`, startExpr: `${item}.span.start`, endExpr: `${item}.span.end`,
    })
    return { ...r, stmts: [read, ...r.stmts] }
  }
  return {
    stmts: [
      read,
      ...emitIfFail(ctx, `${item} === undefined || ${item}.span.start !== ${pos}`, failBody(ctx, '"routed()"', pos)),
      ...emitLeafCapture(ctx, `${item}.value`, `${item}.span.start`, `${item}.span.end`),
    ],
    valueVar: `${item}.value`,
    endVar: `${item}.span.end`,
  }
}

/**
 * `routed(fallback)`: reuse the dispatch-consumed token when it is at `pos`, else
 * parse `fallback` IN PLACE.
 *
 * The fallback goes through the ordinary `emit()` — not `emitFallible` — so its
 * failure propagates verbatim (same `expected`, same committed-ness, same trivia
 * state) exactly as if the grammar had spelled the fallback at this position, which
 * is what the interpreter does (`return fallback.parse(input, pos, ctx)`).
 */
function emitRoutedWithFallback(
  ctx: Ctx,
  pos: string,
  fallback: Combinator<unknown>,
  routed: { test: string; valExpr: string; startExpr: string; endExpr: string },
): ER {
  const valV = v(ctx, '_rtv')
  const endV = v(ctx, '_rte')
  const i = ind(ctx)
  ctx.indent++
  const capture = emitLeafCapture(ctx, routed.valExpr, routed.startExpr, routed.endExpr)
  const fb = emit(fallback, ctx, pos)
  const inner = ind(ctx)
  ctx.indent--
  return {
    stmts: [
      `${i}let ${valV}, ${endV}`,
      `${i}if (${routed.test}) {`,
      ...capture,
      `${inner}${valV} = ${routed.valExpr}; ${endV} = ${routed.endExpr}`,
      `${i}} else {`,
      ...fb.stmts,
      `${inner}${valV} = ${fb.valueVar}; ${endV} = ${fb.endVar}`,
      `${i}}`,
    ],
    valueVar: valV,
    endVar: endV,
  }
}

function escapeTokenLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function regexMatchesEmpty(source: string, flags: string): boolean {
  try { return new RegExp(`^(?:${source})$`, flags).test('') }
  catch { return true }
}

function tokenTerminalSource(p: Combinator<unknown>): { source: string; caseInsensitive: boolean; rawCaseSensitive: string } | null {
  const def = p._def
  switch (def.tag) {
    case 'literal':
      if (def.value.length === 0) return null
      return {
        source: escapeTokenLiteral(def.value),
        caseInsensitive: def.caseInsensitive,
        rawCaseSensitive: def.caseInsensitive ? '' : def.value,
      }
    case 'regex': {
      if (def.flags.replace(/i/g, '') !== '') return null
      if (regexMatchesEmpty(def.source, def.flags)) return null
      return {
        source: `(?:${def.source})`,
        caseInsensitive: def.flags.includes('i'),
        rawCaseSensitive: def.flags.includes('i') ? '' : def.source,
      }
    }
    default:
      return null
  }
}

function tokenSequenceSource(p: Combinator<unknown>): { source: string; flags: string; hasCaseSensitiveLetters: boolean } | null {
  const def = p._def
  const parts = def.tag === 'sequence'
    ? def.parsers.map(tokenTerminalSource)
    : [tokenTerminalSource(p)]
  if (parts.some(part => part === null)) return null
  const typed = parts as Array<{ source: string; caseInsensitive: boolean; rawCaseSensitive: string }>
  const flags = typed.some(part => part.caseInsensitive) ? 'i' : ''
  if (flags.includes('i') && typed.some(part => /[A-Za-z]/.test(part.rawCaseSensitive))) return null
  return {
    source: typed.map(part => part.source).join(''),
    flags,
    hasCaseSensitiveLetters: typed.some(part => /[A-Za-z]/.test(part.rawCaseSensitive)),
  }
}

function combineTokenRegexSources(parts: Array<{ source: string; flags: string; hasCaseSensitiveLetters: boolean }>): { source: string; flags: string } | null {
  const flags = parts.some(part => part.flags.includes('i')) ? 'i' : ''
  if (flags.includes('i') && parts.some(part => part.flags === '' && part.hasCaseSensitiveLetters)) return null
  return { source: parts.map(part => part.source).join(''), flags }
}

function tokenNullableRegex(def: Extract<ParserDef, { tag: 'token' }>): Extract<ParserDef, { tag: 'regex' }> | null {
  const inner = def.parser._def
  if (inner.tag === 'many') {
    const seq = tokenSequenceSource(inner.parser)
    if (!seq) return null
    return { tag: 'regex', source: `(?:${seq.source})*`, flags: seq.flags }
  }
  if (inner.tag === 'optional') {
    const seq = tokenSequenceSource(inner.parser)
    if (!seq) return null
    return { tag: 'regex', source: `(?:${seq.source})?`, flags: seq.flags }
  }
  if (inner.tag === 'sepBy') {
    const item = tokenSequenceSource(inner.parser)
    const sep = tokenSequenceSource(inner.separator)
    if (!item || !sep) return null
    const combined = combineTokenRegexSources([item, sep])
    if (!combined) return null
    return { tag: 'regex', source: `(?:${item.source}(?:${sep.source}${item.source})*)?`, flags: combined.flags }
  }
  return null
}

function emitToken(def: Extract<ParserDef, { tag: 'token' }>, ctx: Ctx, pos: string): ER {
  const lowered = tokenNullableRegex(def)
  if (lowered) return emitRegex(lowered, ctx, pos, def.parser._meta.canMatchNewline)

  const savedTrivia = ctx.activeTrivia
  const savedKindLabels = ctx.triviaKindLabels
  ctx.activeTrivia = undefined
  ctx.triviaKindLabels = undefined
  const inner = emitFallible(def.parser, ctx, pos)
  ctx.activeTrivia = savedTrivia
  ctx.triviaKindLabels = savedKindLabels

  const i = ind(ctx)
  const sc = v(ctx, '_tokCh')
  const sl = v(ctx, '_tokLv')
  const sr = v(ctx, '_tokRaw')
  const sv = v(ctx, '_tokTr')
  const sk = v(ctx, '_tokKinds')
  const stl = v(ctx, '_tokTl')
  const sol = v(ctx, '_tokLog')
  const srl = hasSelectedRootTrivia(ctx) ? v(ctx, '_tokRootLog') : null
  const sb = v(ctx, '_tokBuf')
  const valV = v(ctx, '_tok')

  return {
    stmts: [
      `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren, ${sv} = _ctx.trivia, ${sk} = _ctx.triviaKindLabels, ${stl} = _ctx._cstTriviaLog, ${sol} = _ctx._triviaLog${srl ? `, ${srl} = _ctx._rootTriviaLog` : ''}, ${sb} = _ctx._cstBuf`,
      `${i}_ctx.trivia = undefined; _ctx.triviaKindLabels = undefined; _ctx._cstChildren = undefined; _ctx._cstLeaves = undefined; _ctx._cstRawChildren = undefined; _ctx._cstTriviaLog = undefined; _ctx._triviaLog = undefined;${srl ? ' _ctx._rootTriviaLog = undefined;' : ''} _ctx._cstBuf = undefined`,
      `${i}try {`,
      ...reindentStmts(inner.stmts, ctx.indent + 1).map(stmt => stmt.replace(/^(\s*)(?:const|let)\s+/, '$1var ')),
      `${i}} finally {`,
      `${i}  _ctx.trivia = ${sv}; _ctx.triviaKindLabels = ${sk}; _ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}; _ctx._cstTriviaLog = ${stl}; _ctx._triviaLog = ${sol};${srl ? ` _ctx._rootTriviaLog = ${srl};` : ''} _ctx._cstBuf = ${sb}`,
      `${i}}`,
      ...emitIfFail(ctx, `!${inner.okVar}`, propagateFailBody(ctx)),
      `${i}const ${valV} = input.slice(${pos}, ${inner.endVar})`,
      ...emitLeafCapture(ctx, valV, pos, inner.endVar),
    ],
    valueVar: valV,
    endVar: inner.endVar,
  }
}

/** Semantic-leaf wrapper: preserve the inner grammar's trivia policy, hide its
 * captures, and expose one callback-reduced leaf at the enclosing level. */
function emitLeaf(def: Extract<ParserDef, { tag: 'leaf' }>, ctx: Ctx, pos: string): ER {
  const inner = emitFallible(def.parser, ctx, pos)
  const i = ind(ctx)
  const sc = v(ctx, '_leafCh')
  const sl = v(ctx, '_leafLv')
  const sr = v(ctx, '_leafRaw')
  const stl = v(ctx, '_leafTl')
  const sol = v(ctx, '_leafLog')
  const sb = v(ctx, '_leafBuf')
  const rawV = v(ctx, '_leafRawValue')
  const valV = v(ctx, '_leaf')
  const fnIdx = pushMapFn(ctx, def.fn, def.fnSrc ?? null)
  return {
    stmts: [
      `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren, ${stl} = _ctx._cstTriviaLog, ${sol} = _ctx._triviaLog, ${sb} = _ctx._cstBuf`,
      `${i}_ctx._cstChildren = undefined; _ctx._cstLeaves = undefined; _ctx._cstRawChildren = undefined; _ctx._cstTriviaLog = undefined; _ctx._triviaLog = undefined; _ctx._cstBuf = undefined`,
      `${i}try {`,
      ...reindentStmts(inner.stmts, ctx.indent + 1).map(stmt => stmt.replace(/^(\s*)(?:const|let)\s+/, '$1var ')),
      `${i}} finally {`,
      `${i}  _ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}; _ctx._cstTriviaLog = ${stl}; _ctx._triviaLog = ${sol}; _ctx._cstBuf = ${sb}`,
      `${i}}`,
      ...emitIfFail(ctx, `!${inner.okVar}`, propagateFailBody(ctx)),
      `${i}const ${rawV} = ${inner.valVar}`,
      `${i}const ${valV} = ${mfRef(ctx)}[${fnIdx}](${rawV}, { start: ${pos}, end: ${inner.endVar} })`,
      ...emitLeafCapture(ctx, valV, pos, inner.endVar),
    ],
    valueVar: valV,
    endVar: inner.endVar,
  }
}

function emitNodeProjectExpr(type: string, project: NonNullable<Extract<ParserDef, { tag: 'node' }>['project']>, chV: string): string {
  const child = `${chV}[${project}]`
  const missing = `(() => { throw new Error(${JSON.stringify(`node(${JSON.stringify(type)}) project child ${project} was not captured`)}) })()`
  const value = `(${child} !== null && typeof ${child} === 'object' && ${child}._tag === 'leaf' ? ${child}.value : ${child})`
  return `(${project} in ${chV} ? ${value} : ${missing})`
}

/**
 * CST node rule. Collects the inner parse's terminals/trivia into fresh local
 * arrays (capture is emitted inline by the terminals while capChildren is set),
 * calls the build fn, then records the node in the enclosing node()'s collectors.
 */
function emitNode(def: Extract<ParserDef, { tag: 'node' }>, ctx: Ctx, pos: string): ER {
  if (def.type === undefined) {
    throw new Error('node(): inferred node type requires a rules() key; pass node("Type", parser) outside rules()')
  }
  // A STRUCTURAL node has no own build — it builds via the `ctx.build` host at
  // parse time, else a default positioned CST. No build fn is captured.
  const structural = def.build === undefined && def.project === undefined
  const mkType = structural || def.project !== undefined ? null : analyzeMkInlineBuild(def)
  let buildIdx: number | null = null
  if (!mkType && !structural && def.project === undefined) {
    buildIdx = ctx.buildFns.length
    ctx.buildFns.push(def.build!)
    ctx.buildSrcs.push(def.buildSrc ?? null)
  }
  const i = ind(ctx)

  // Arity-gated elision: direct AST builders frequently use only children,
  // fields, and span. Do not allocate their otherwise-unobservable raw CST
  // collector (or children for a zero-argument builder). Structural/CST output
  // retains the full collector contract, and an explicit cstBuildHost switches
  // the direct node back to full capture at runtime. The mk-inline path reads
  // both `rawV.length` and `tlV.length`, so it always keeps those collectors.
  //
  // A STRUCTURAL node builds via the injected `_ctx.build` host, whose arity is
  // only known at parse time — so instead of defensively capturing both (the old
  // behaviour), gate on what the host reads via the `_hostReads` helper (memoized
  // once per parse on `_ctx._pmCapTL`/`_pmCapST`). Host sig is
  // `(type, children, fields, span, rawChildren, triviaLog, state)`: not reading arg 5
  // (index) means no trivia log, arg 6 means no state (when no host, the default
  // CST embeds `state` → keep the clone). `_hostReads` is conservative — a
  // rest/default param or `arguments` forces full capture, so a spread host never
  // silently loses data. jess hosts can ask for fields with arity 3 while trivia/state stay dead
  // (the cstTriviaLog per-token push dominates — ~28% of a real jess parse).
  // COMPILE-TIME HOST MODE. In `'cst'` every non-structural node builds through the
  // positioned-CST host instead of its own `build`, so capture must follow that HOST,
  // not the builder's arity — and since the mode is a compile-time constant, "follow the
  // host" is simply "capture", with no per-node probe. This is the whole point of moving
  // the decision to build time: in `'ast'` the host branch does not exist, and in `'cst'`
  // there is nothing to decide.
  const cstOut = ctx.hostMode === 'cst' && !structural
  // Did this artifact actually DROP a positioned-CST branch? Only a node with its own
  // build has one to drop. A purely STRUCTURAL grammar builds through `ctx.build` at
  // runtime by design — that is the documented `node(parser)` contract, unchanged here —
  // so an 'ast' compilation of it remains perfectly usable with a CST host, and the
  // compatibility check below must not fire for it. This flag is what keeps the check
  // precise instead of merely conservative.
  if (!structural && !cstOut) ctx.hostBranchElided = true
  const hasProject = def.project !== undefined
  const capturesTrivia = cstOut || mkType !== null || def.captureTrivia === true || def.trailingTrivia === true || (!structural && !hasProject && buildReadsTrivia(def))
  const clonesState = !structural && (cstOut || (!hasProject && buildReadsState(def)))
  const capturesChildren = !structural && (cstOut || mkType !== null || def.unwrap || def.collapse || def.project !== undefined || buildReadsChildren(def))
  const capturesRaw = !structural && (cstOut || mkType !== null || (def.project === undefined && buildReadsRaw(def)))
  const hasFields = parserHasOwnFields(def.parser)
  const capturesFields = hasFields && !structural && (cstOut || (!hasProject && buildReadsFields(def)))
  // A nested parser({ captureTrivia: true }) needs this node's collector, but
  // must not activate it until that parser scope is entered. Keep the collector
  // decision separate from the active capture flag below.
  const innerEnablesTriviaCapture = parserEnablesTriviaCapture(def.parser)

  const chV = v(ctx, '_ch')
  const rawV = v(ctx, '_raw')
  const capTLv = (structural || capturesTrivia) ? v(ctx, '_ctl') : null
  const capSTv = structural ? v(ctx, '_cst') : null
  const capFv = structural && hasFields ? v(ctx, '_cf') : null
  const tlV = capturesTrivia || structural ? v(ctx, '_tl') : '_EMPTY_TL'
  // Direct builders that declare trivia retain the established eager collector.
  // `_EMPTY_TL` remains necessary for elided direct builders and host-gated
  // structural nodes only.
  if (!capturesTrivia || structural) ctx.needsEmptyTl = true
  const sc = v(ctx, '_sc'), sl = v(ctx, '_sl'), sr = v(ctx, '_sr'), st = v(ctx, '_st'), stl = v(ctx, '_stl')
  // Per-node-type trivia-kind mask (structural/host nodes only): a host may want
  // one node type captured comments-only and another whitespace-and-all. Scoped
  // here and restored after the inner parse, exactly like captureTrivia/_cstTriviaLog.
  const smk = structural ? v(ctx, '_smk') : null
  if (structural) ctx.needsHostReads = true
  const hostTriviaGate = `_ctx.build !== undefined && (_ctx.build._parsemanCaptureTrivia !== undefined ? _ctx.build._parsemanCaptureTrivia(${JSON.stringify(def.type)}) : (_ctx._pmCapTL ??= _hostReads(_ctx.build, 5)))`
  // Profiling is INTERPRETED-MODE ONLY and is deliberately not compiled in.
  //
  // `run({ profile })` drives its recognizer/capture/host phases through
  // `_ctx._pmProfile`. Emitting those phase gates into the artifact cost a
  // `_ctx._pmProfile` read plus two locals on EVERY node, and threaded a ternary
  // through ~15 further per-node expressions — machinery a normal parse never
  // executes. The commit that hoisted the reads to two locals recorded the cost it
  // was walking back: "~+10–15% on 2–3µs cases".
  //
  // These stay as string GATES rather than being deleted inline so the emission
  // sites keep one shape; `tern`/`notGate`/`orGate` fold them away, so the literal
  // `'false'` here means the dead branch never reaches the artifact at all.
  // A compiled artifact is stamped un-profilable (see `FUSED_NO_PROFILE`) and
  // `run()` refuses `profile` on it rather than silently reporting zeros.
  const profileRecognizer = 'false'
  const profileCapture = 'false'
  // Direct builders normally produce their own AST and never inspect CST
  // children/rawChildren. Keep cstBuildHost and profile({ capture: true })
  // truthful by dynamically restoring those collectors only for those explicit
  // modes. The normal AST route pays a boolean/property read instead of a fresh
  // array for every elided collector.
  // In `'cst'` mode a direct builder ALWAYS routes to the host, so its children/raw
  // collectors are always live — no gate, no probe. In `'ast'` mode the host branch is
  // not emitted at all, so the only thing that can still want those collectors is the
  // profiling capture pass, which is already a hoisted LOCAL (`_cap`) rather than a
  // property chain on `_ctx.build`. Either way the per-node `_parsemanCstOutput` read
  // that used to sit on every direct node is gone.
  // The `_dcst` binding that used to live here is GONE, not folded. Its only gate
  // was `profileCapture`, which is the literal `'false'` above, so it could never
  // reach the artifact — but reserving its name still advanced `ctx.vars`, which
  // renumbered every subsequent `_NN` in the file. That renumbering was the bulk of
  // the measured ast-vs-cst byte delta and made two otherwise-identical lowerings
  // diff. Nothing downstream reads it; `dcstAlloc` below is unconditionally
  // `'undefined'` because that is what it always constant-folded to.
  // A structural node can make its CST-trivia contract grammar-owned. That is
  // stronger than a host preference: `node(..., undefined, { captureTrivia:
  // true })` must keep its log even when the injected host explicitly opts out.
  // This mirrors the interpreter's `capturesTrivia` decision above.
  const structuralCapturesTrivia = structural && (def.captureTrivia === true || def.trailingTrivia === true)
  // Children-array (chV) elision for structural nodes. chV is a byte-for-byte
  // duplicate of rawV for a structural grammar (every captured item is a CST
  // child, so the rawEntry synthesis never diverges), and a host that builds from
  // `rawChildren` never reads it. `_hostReads` can't detect this — the host
  // declares `children` positionally to reach later args — so consult the explicit
  // `_parsemanReadsChildren === false` opt-out. Keep chV whenever it is actually
  // read: a default CST (no host), a collapse host (`_parsemanCstCollapse` inspects
  // it), unwrap/collapse rules (compile-time), or the profiling capture pass.
  const chNeededExpr = (def.unwrap || def.collapse)
    ? 'true'
    : `(_ctx._pmReadsCh ??= (_ctx.build === undefined || _ctx.build._parsemanReadsChildren !== false || _ctx.build._parsemanCstCollapse !== undefined))`
  const chAlloc = (def.unwrap || def.collapse)
    ? tern(profileRecognizer, 'undefined', '[]')
    : tern(profileRecognizer, 'undefined', `${tern(orGate(profileCapture, chNeededExpr), '[]', 'undefined')}`)
  // An elided collector allocates nothing. (Was a `_dcst ? [] : undefined` whose
  // gate constant-folded to `false`; see the note at the removed binding.)
  const dcstAlloc = 'undefined'
  const allocStmt = structural
    ? `${i}const ${capTLv} = ${andGate(notGate(profileRecognizer), orGate(profileCapture, structuralCapturesTrivia ? 'true' : hostTriviaGate))}, ${capSTv} = ${andGate(notGate(orGate(profileRecognizer, profileCapture)), '(_ctx._pmCapST ??= (_ctx.build === undefined || _hostReads(_ctx.build, 6)))')}${capFv ? `, ${capFv} = ${andGate(notGate(profileRecognizer), orGate(profileCapture, '(_ctx.build !== undefined && _hostReads(_ctx.build, 2))'))}` : ''}\n`
      + `${i}const ${chV} = ${chAlloc}, ${rawV} = ${tern(profileRecognizer, 'undefined', '[]')}, ${tlV} = ${tern(profileRecognizer, 'undefined', innerEnablesTriviaCapture ? '[]' : `${capTLv} ? [] : _EMPTY_TL`)}`
    : capturesTrivia
      ? `${i}const ${capTLv} = ${notGate(profileRecognizer)}, ${chV} = ${tern(profileRecognizer, 'undefined', capturesChildren ? '[]' : dcstAlloc)}, ${rawV} = ${tern(profileRecognizer, 'undefined', capturesRaw ? '[]' : dcstAlloc)}, ${tlV} = ${tern(profileRecognizer, 'undefined', '[]')}`
      : `${i}const ${chV} = ${tern(profileRecognizer, 'undefined', capturesChildren ? '[]' : dcstAlloc)}, ${rawV} = ${tern(profileRecognizer, 'undefined', capturesRaw ? '[]' : dcstAlloc)}`
  // The collector stays installed when a nested grammar can opt in; generated
  // trivia scanners gate their push on `captureTrivia`, so this remains inert
  // until that nested scope activates it.
  const innerTl = structural || capturesTrivia
    ? structural && !innerEnablesTriviaCapture ? `${capTLv} ? ${tlV} : undefined` : tlV
    : 'undefined'
  const fieldsOn = structural ? (capFv ?? 'false') : tern(profileRecognizer, 'false', capturesFields ? 'true' : 'false')
  const sf = hasFields ? v(ctx, '_sf') : null
  const fArr = hasFields ? v(ctx, '_fa') : null
  const fObj = hasFields ? v(ctx, '_fields') : 'undefined'
  // Per-node trivia-frame elision: a node whose parser subtree has NO trivia-skip
  // site (a bare terminal) can never log trivia into its own `_cstTriviaLog`, so
  // its `captureTrivia`/`_cstTriviaLog`/`_triviaCaptureMask` save+install+restore is
  // dead work — skip it. The parent's values stay untouched (nothing inside writes
  // them) and the node's trivia is empty (build reads `tlV`, which is `_EMPTY_TL` /
  // an unpopulated `_tl`). Sound because `parserHasTriviaSite` is conservative
  // (only `false` when provably no site). Halves the per-node scope frame on the
  // many bare value/token leaf nodes (Num, Color, Quoted, …). See emitNode notes.
  const needsTriviaFrame = def.trailingTrivia === true || parserHasTriviaSite(def.parser)
  const saveTrivia = needsTriviaFrame
    ? `, ${st} = _ctx.captureTrivia, ${stl} = _ctx._cstTriviaLog${smk ? `, ${smk} = _ctx._triviaCaptureMask` : ''}`
    : ''
  const installTrivia = needsTriviaFrame
    ? `; _ctx.captureTrivia = ${capTLv ?? 'false'}; _ctx._cstTriviaLog = ${innerTl}${smk ? `; _ctx._triviaCaptureMask = ${capTLv} && _ctx.build !== undefined && _ctx.build._parsemanTriviaKinds !== undefined ? _ctx.build._parsemanTriviaKinds(${JSON.stringify(def.type)}) : ${smk}` : ''}`
    : ''
  const restoreTrivia = needsTriviaFrame
    ? `; _ctx.captureTrivia = ${st}; _ctx._cstTriviaLog = ${stl}${smk ? `; _ctx._triviaCaptureMask = ${smk}` : ''}`
    : ''
  // First-set fail-fast (before the capture frame is allocated). A node whose
  // body has a discrete (non-`any`) first set and can't match empty is often
  // invoked speculatively at many positions by non-dispatching callers — e.g.
  // Less `@{…}` interpolation, an early arm of a non-disjoint choice, is entered
  // at every position and rejected on its first byte. The `allocStmt` below
  // allocates the children/raw/trivia arrays and swaps the CST context BEFORE the
  // body recognizes anything, so each such miss allocates then immediately fails.
  // Reject a first-set miss here instead: sound because a miss cannot match, and
  // nothing has been captured yet to roll back. Records the same static `expected`
  // a body start-fail would (named-rule bodies run with recordFail), so diagnostics
  // are unchanged. Skipped under compiled recovery (a swallowed failure still feeds
  // the completions probe there). Mirrors the choice/`many`/`attempt` first-set guards.
  //
  // The gate is `needsFirstSetGuard` ALONE. It used to also require
  // `capturesChildren || structural`, on the theory that a node capturing nothing has
  // "no frame to save" and so nothing to protect. That was wrong twice over. Factually:
  // a non-capturing node still allocates `chV`/`rawV` bindings,
  // and still saves + installs + restores `_cstChildren`/`_cstLeaves`/`_cstRawChildren`
  // (and the trivia frame) before the body recognizes a byte. Structurally: capture is a
  // COST question and the guard is a CORRECTNESS-neutral speedup, so using one as a proxy
  // for the other coupled the largest measured parse lever to an unrelated decision — a
  // confirmed zero-arity `() =>` reducer sets `capturesChildren = false` and thereby
  // DELETED that node's first-set gate. CST mode forces the flag true, so the loss showed
  // up only in 'ast' artifacts, which is why it went unnoticed. Sound to drop: the guard
  // is emitted strictly before every statement this node contributes, `needsFirstSetGuard`
  // guarantees a first-set miss cannot match, and the recorded `expected`/`_fe` are the
  // ones a body start-fail would record — `emitAttempt` already gates on
  // `needsFirstSetGuard` with no capture precondition, for exactly these reasons.
  const preGuard: string[] = []
  if (!ctx.recovery && !ctx.coverage && needsFirstSetGuard(def.parser)) {
    const gcV = v(ctx, '_ngc')
    const gExp = armStaticExpected(ctx, def.parser)
    const gFail = ctx.failLabel
      ? (ctx.recordFail ? `{ _ctx._fe = ${pos}; _ctx._fx = ${gExp}; break ${ctx.failLabel} }` : `break ${ctx.failLabel}`)
      : failReturnArr(ctx, gExp, pos)
    preGuard.push(
      `${i}const ${gcV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
      `${i}if (!(${firstSetCond(gcV, def.parser._meta.firstSet)})) ${gFail}`,
    )
  }
  const stmts: string[] = [
    ...preGuard,
    allocStmt,
    `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren${saveTrivia}${sf ? `, ${sf} = _ctx._fields` : ''}`,
    `${i}_ctx._cstChildren = ${chV}; _ctx._cstLeaves = ${chV}; _ctx._cstRawChildren = ${rawV}${installTrivia}${sf ? `; _ctx._fields = ${fieldsOn} ? [] : undefined` : ''}`,
  ]
  const { stmts: innerStmts, okVar, endVar: innerEndVar } = emitFallible(def.parser, ctx, pos)
  const endVar = def.trailingTrivia === true && ctx.activeTrivia ? v(ctx, '_trailend') : innerEndVar
  stmts.push(...innerStmts)
  if (def.trailingTrivia === true && ctx.activeTrivia) {
    const triviaFn = ensureTriviaFn(ctx)
    stmts.push(`${i}const ${endVar} = ${okVar} ? ${triviaFn}(input, ${innerEndVar}, _ctx, 1) : ${innerEndVar}`, ...emitLineTrack(ctx, innerEndVar, endVar))
  }
  if (sf && fArr) {
    stmts.push(`${i}const ${fArr} = _ctx._fields`)
  }
  stmts.push(`${i}_ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}${restoreTrivia}${sf ? `; _ctx._fields = ${sf}` : ''}`)
  // node() returns the inner failure verbatim (interpreter parity) — propagate
  // the recorded deepest failure, not a coarse ["node"] at the node's start.
  stmts.push(...emitIfFail(ctx, `!${okVar}`, propagateFailBody(ctx)))

  // (profiling counters intentionally not emitted — interpreted mode only)

  let stV = 'undefined'
  if (structural) {
    stV = v(ctx, '_nst')
    stmts.push(`${i}const ${stV} = ${capSTv} && _ctx.state !== undefined ? Object.assign({}, _ctx.state) : undefined`)
  } else if (clonesState) {
    stV = v(ctx, '_nst')
    stmts.push(`${i}const ${stV} = ${andGate(notGate(orGate(profileRecognizer, profileCapture)), '_ctx.state !== undefined')} ? Object.assign({}, _ctx.state) : undefined`)
  }
  if (sf && fArr) {
    const fe = v(ctx, '_fe')
    const cur = v(ctx, '_fc')
    stmts.push(
      `${i}let ${fObj} = undefined`,
      `${i}if (${fArr} && ${fArr}.length) {`,
      `${i}  ${fObj} = {}`,
      `${i}  for (const ${fe} of ${fArr}) {`,
      `${i}    const ${cur} = ${fObj}[${fe}.name], _entry = { value: ${fe}.value, span: ${fe}.span }`,
      `${i}    if (${cur} === undefined) ${fObj}[${fe}.name] = _entry`,
      `${i}    else if (Array.isArray(${cur})) ${cur}.push(_entry)`,
      `${i}    else ${fObj}[${fe}.name] = [${cur}, _entry]`,
      `${i}  }`,
      `${i}}`,
    )
  }
  const ndV = v(ctx, '_nd')
  const nodeSpanExpr = emitSpanExpr(ctx, pos, endVar)
  const nodeSpanV = ctx.lineTracking ? v(ctx, '_nspan') : nodeSpanExpr
  if (ctx.lineTracking) stmts.push(`${i}const ${nodeSpanV} = ${nodeSpanExpr}`)
  // A structural node's own "builder" is a default positioned CST; a built node's
  // is its inline-mk expr or captured build fn.
  const buildExpr = structural
    ? `{ _tag: 'node', type: ${JSON.stringify(def.type)}, span: ${nodeSpanV}, state: ${stV} ?? null, children: ${chV} }`
    : mkType
      ? emitInlineMkNodeExpr(mkType, chV, rawV, nodeSpanV, tlV)
      : def.project !== undefined
        ? emitNodeProjectExpr(def.type, def.project, chV)
        : `${buildRef(ctx)}[${buildIdx!}](${chV}, ${fObj}, ${nodeSpanV}, ${rawV}, ${tlV}, ${stV})`
  // A structural node builds through the per-parse host. A direct builder owns
  // its semantic result in every lowering mode; the positioned-CST host is the
  // sole exception, so a direct object never becomes a CST child. Linkability
  // must not change that ownership rule.
  const hostBuildArgs = `${JSON.stringify(def.type)}, ${chV}, ${fObj}, ${nodeSpanV}, ${rawV}, ${tlV}, ${stV}${def.tags !== undefined && def.tags.length > 0 ? `, ${JSON.stringify(def.tags)}` : ''}`
  // No profiling comma-expression: `run({ profile })` counts host calls in
  // interpreted mode, so the compiled host branch is the bare call.
  const hostBuildExpr = `_ctx.build(${hostBuildArgs})`
  // A direct builder's consumer is fixed at COMPILE time, so this is a constant choice,
  // not a per-node `_ctx.build?._parsemanCstOutput === true` read. `'cst'` builds through
  // the host (so a direct semantic object can never become a CST child); `'ast'` never
  // emits the host branch at all. Structural nodes are unchanged: their host is the
  // documented `node(parser)` contract and is genuinely a per-parse choice.
  const ndExpr = structural
    ? `_ctx.build !== undefined ? (${hostBuildExpr}) : (${buildExpr})`
    : cstOut
      ? hostBuildExpr
      : buildExpr
  // unwrap/collapse: a single captured child IS the value; unwrap turns a leaf
  // into its string, collapse returns the child exactly. Mirrors node.ts.
  // `cstBuildHost({ collapse })` applies wherever the node's VALUE comes from the host —
  // that is the only situation in which the produced thing is a CST node the host owns.
  // It used to be emitted for `structural` alone, which silently made the documented
  // option a no-op for every `hostMode: 'cst'` grammar whose nodes carry a build reducer
  // (measured in jess: `predicateCalls === 0` across four dialects, and zero occurrences
  // of `_parsemanCstCollapse` in the built artifacts). In `'cst'` mode a direct builder is
  // BYPASSED — `ndExpr` is `hostBuildExpr` — so the node is host-built exactly like a
  // structural one, and there is no reason for the policy to skip it.
  const hostCollapses = structural || cstOut
  const hostCollapseExpr = hostCollapses
    ? `_ctx.build !== undefined && _ctx.build._parsemanCstCollapse !== undefined && ${chV}.length === 1 && ${rawV}.length === 1 && _ctx.build._parsemanCstCollapse(${JSON.stringify(def.type)}, ${chV}[0], ${chV}, ${rawV}) ? ${chV}[0] : (${ndExpr})`
    : ndExpr
  const unwrapExpr = `${chV}.length === 1 ? (${chV}[0] !== null && typeof ${chV}[0] === 'object' && ${chV}[0]._tag === 'leaf' ? ${chV}[0].value : ${chV}[0]) : (${ndExpr})`
  const collapseExpr = `${chV}.length === 1 ? ${chV}[0] : (${ndExpr})`
  const finalExpr = def.unwrap
    ? unwrapExpr
    : def.collapse
      ? collapseExpr
    : hostCollapseExpr
  const ndGate = orGate(profileRecognizer, profileCapture)
  const recGate = notGate(profileRecognizer)
  // With profiling out of the compiled path `recGate` is statically true, so the
  // two pushes are emitted unwrapped instead of inside a dead `if (true) { … }`.
  const pushIndent = recGate === 'true' ? i : `${i}  `
  const pushCh = `${pushIndent}if (${sc}) ${sc}.push(${ndV})`
  // See RAW_ENTRY_DECL: the span argument is passed ONLY when it is already a local
  // (line tracking), so the untracked fast path still allocates no span.
  ctx.needsRawEntry = true
  const pushRaw = `${pushIndent}if (${sr}) ${sr}.push(_rawEntry(${ndV}, input, ${pos}, ${endVar}${ctx.lineTracking ? `, ${nodeSpanV}` : ''}))`
  stmts.push(`${i}const ${ndV} = ${tern(ndGate, 'undefined', `(${finalExpr})`)}`)
  if (recGate === 'true') stmts.push(pushCh, pushRaw)
  else stmts.push(`${i}if (${recGate}) {`, pushCh, pushRaw, `${i}}`)

  return { stmts, valueVar: ndV, endVar }
}

function emitRuntimeFallback(parser: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  const idx = ctx.runtimeParsers.length
  ctx.runtimeParsers.push(parser)
  const rv = v(ctx, '_rt')
  const vv = v(ctx, '_rtv')
  const ev = v(ctx, '_rte')
  // The runtime parser IS the real combinator, so its result is exactly the
  // interpreter's — record its failure payload and propagate it verbatim (only
  // when a consumer will read it).
  const failStmt = ctx.failLabel
    ? (ctx.recordFail
        ? `{ _ctx._fe = ${rv}.span.start; _ctx._fx = ${rv}.expected; _ctx._fc = ${rv}.committed === true; break ${ctx.failLabel} }`
        : `{ _ctx._fc = ${rv}.committed === true; break ${ctx.failLabel} }`)
    : `return { ok: false, expected: ${rv}.expected, span: ${rv}.span, ...(${rv}.committed ? { committed: true } : {}) }`
  const stmts = [
    `${ind(ctx)}const ${rv} = _rp[${idx}].parse(input, ${pos}, _ctx)`,
    ...emitIfFail(ctx, `!${rv}.ok`, failStmt),
    `${ind(ctx)}const ${vv} = ${rv}.value`,
    `${ind(ctx)}const ${ev} = ${rv}.span.end`,
    ...(parser._meta.canMatchNewline ? emitLineTrack(ctx, pos, ev) : []),
  ]
  return { stmts, valueVar: vv, endVar: ev }
}

/**
 * Compile a lazy/ref parser into a named function declaration.
 *
 * The named function is registered in ctx.namedParsers BEFORE its body is
 * emitted. This breaks the recursion cycle: when the body emitter encounters
 * the same ref again it finds it already registered and emits a call instead
 * of recursing infinitely.
 *
 * All named functions share the parent function's scope (via closure), so they
 * can read _rp, _mf, and all hoisted regex consts without extra args.
 *
 * JavaScript hoists function declarations within a function body, so the order
 * we push to namedFnDecls doesn't affect correctness.
 */
function emitLazy(p: Combinator<unknown>, def: Extract<ParserDef, { tag: 'lazy' }>, ctx: Ctx, pos: string): ER {
  // Single-use, non-recursive ref: inline its body at this call site instead
  // of hoisting a named function nobody else calls. Uses the CURRENT ctx
  // indent/failLabel (unlike the named-function path below, which resets
  // both for a fresh function scope) — the resolved combinator is emitted
  // exactly as if the grammar author had written it inline directly.
  // A named rule (in the rule map) is NEVER inlined: it must stay a standalone
  // `_r_<Name>` function so it's addressable and overridable by name (the
  // linkable/fusable form). Only private (non-map) single-use refs inline.
  const canonical = ctx.ruleNames?.get(p)
  const usage = ctx.lazyUsage
  if (!canonical && usage && (usage.counts.get(p) ?? 0) <= 1 && !usage.recursive.has(p)) {
    let resolved: Combinator<unknown>
    try {
      resolved = def.thunk()
    } catch {
      return emitRuntimeFallback(p, ctx, pos)
    }
    // INLINE EXPANSION CAP (see INLINE_MAX_NODES). Charge this paste against the
    // enclosing function's budget. When it does not fit, fall through to the named-
    // function path below: the ref becomes a `_pfN` and is CALLED. Correctness is
    // unaffected — that path is the established shape for every multi-use ref — so the
    // only thing the cap trades is one call for the pasted bytes, and it only ever
    // binds on functions that have already absorbed a full budget's worth of inlining.
    const cost = usage.sizes.get(resolved) ?? 1
    if (cost <= ctx.inlineLeft) {
      ctx.inlineLeft -= cost
      return emit(resolved, ctx, pos)
    }
    _inlineCapSink?.push({ fn: ctx.currentFnName ?? '<root>', nodes: cost })
  }

  if (!ctx.namedParsers.has(p)) {
    const fnName = canonical ?? `${nsp(ctx)}_pf${ctx.namedParsers.size}`
    ctx.namedParsers.set(p, fnName)   // register FIRST so recursive refs see it

    let resolved: Combinator<unknown>
    try {
      resolved = def.thunk()
    } catch {
      // ref.define() not called yet — fall back to runtime
      ctx.namedParsers.delete(p)
      return emitRuntimeFallback(p, ctx, pos)
    }

    const savedIndent    = ctx.indent
    const savedFailLabel = ctx.failLabel
    const savedRecord    = ctx.recordFail
    // Fresh function body → fresh inline budget (see INLINE_MAX_NODES).
    const savedInlineLeft = ctx.inlineLeft, savedFnName = ctx.currentFnName
    ctx.inlineLeft = ctx.inlineMax; ctx.currentFnName = fnName
    const failureRuleId = p === ctx.coverage?.entry
      ? undefined
      : (ctx.coverage?.plan.rules.get(p) ?? ctx.coverage?.plan.rules.get(resolved))
    const savedActiveRule = ctx.activeCoverageRuleId
    const savedSuppressFailure = ctx.suppressCoverageFailure
    ctx.indent    = 1
    ctx.failLabel = '_pfail'  // failures break _pfail (labeled block in fn body)
    // A named fn is compiled ONCE but shared across every call site, so its body
    // must always record `_ctx._fx` — the caller (emitNamedFnCall) decides via
    // its own recordFail whether to propagate. Baking the first caller's
    // (possibly swallowed) recordFail into the shared body would leave `_ctx._fx`
    // unset for other callers that DO read it.
    ctx.recordFail = true
    // The generated named-rule wrapper owns this event. Do not also emit it at
    // each terminal failure in the named body.
    if (failureRuleId !== undefined) {
      ctx.activeCoverageRuleId = undefined
      ctx.suppressCoverageFailure = true
    }
    const r = emit(resolved, ctx, '_pos')
    ctx.indent    = savedIndent
    ctx.failLabel = savedFailLabel
    ctx.recordFail = savedRecord
    ctx.inlineLeft = savedInlineLeft
    ctx.currentFnName = savedFnName
    ctx.activeCoverageRuleId = savedActiveRule
    ctx.suppressCoverageFailure = savedSuppressFailure

    pushNamedFnDecl(ctx, fnName, r.stmts, r.valueVar, r.endVar, failureRuleId)
  }

  const fnName = ctx.namedParsers.get(p)!
  return emitNamedFnCall(ctx, fnName, pos)
}

// ── recover: try inner; on failure scan to sentinel, emit ParseError node ────
function emitRecover(def: Extract<ParserDef, { tag: 'recover' }>, ctx: Ctx, pos: string): ER {
  const { stmts: innerStmts, okVar, valVar, endVar } = emitFallible(def.parser, ctx, pos)

  const ind0  = ind(ctx)
  const scanV = v(ctx, '_sc')
  const errV  = v(ctx, '_err')

  // Sentinel check runs inside the while loop.
  const whileBodyLevels = ctx.indent + 2
  const { stmts: sentStmts, okVar: sentOk } = emitFallible(def.sentinel, ctx, scanV)

  const stmts: string[] = [
    ...innerStmts,
    `${ind0}if (!${okVar}) {`,
    `${ind0}  let ${scanV} = ${pos}`,
    `${ind0}  while (${scanV} < input.length) {`,
    ...reindentStmts(sentStmts, whileBodyLevels),
    `${ind0}    if (${sentOk}) break`,
    `${ind0}    ${scanV}++`,
    `${ind0}  }`,
    ...emitLineTrack(ctx, pos, scanV).map(s => `${ind0}  ${s.trim()}`),
    `${ind0}  const ${errV} = { _tag: 'parseError', span: ${emitSpanExpr(ctx, pos, scanV)}, expected: ${JSON.stringify(deriveExpected(def.parser))} }`,
    `${ind0}  if (_ctx._errors) _ctx._errors.push(${errV})`,
    `${ind0}  ${valVar} = ${errV}`,
    `${ind0}  ${endVar} = ${scanV}`,
    `${ind0}  ${okVar} = true`,
    `${ind0}}`,
  ]
  return { stmts, valueVar: valVar, endVar }
}

// ── expect: try inner; on failure record a ParseError + recover in place ─────
function emitExpect(def: Extract<ParserDef, { tag: 'expect' }>, ctx: Ctx, pos: string): ER {
  const { stmts: innerStmts, okVar, valVar, endVar, mayCommit } = emitFallible(def.parser, ctx, pos)
  const ind0 = ind(ctx)
  const errV = v(ctx, '_err')
  const stmts: string[] = [
    ...innerStmts,
    `${ind0}if (!${okVar}) {`,
    `${ind0}  const ${errV} = { _tag: 'parseError', span: ${emitSpanExpr(ctx, pos, pos)}, expected: ${JSON.stringify(def.expected)} }`,
    `${ind0}  if (_ctx._errors) _ctx._errors.push(${errV})`,
    // Embed the missing-token error as a `parseError` CST child, mirroring the
    // interpreter (expect.ts) and the list-recovery emit sites — guarded on
    // `_ctx._tolerant`, under which the driver always installs `_ctx._rec`.
    `${ind0}  if (_ctx._tolerant) _ctx._rec.capture(_ctx, ${errV})`,
    ...(mayCommit ? [`${ind0}  _ctx._fc = false`] : []),
    `${ind0}  ${valVar} = ${errV}`,
    `${ind0}  ${endVar} = ${pos}`,
    `${ind0}  ${okVar} = true`,
    `${ind0}}`,
  ]
  return { stmts, valueVar: valVar, endVar }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Object-identity de-duplication wrapper around `emitDispatch`. A COMPOUND
 * combinator referenced from more than one place (a shared `const value =
 * choice(...)`, or a sub-parser reached from two positions within one rule) is
 * emitted ONCE as a private named function and CALLED at every reference —
 * instead of pasting its full lowered body at each site, which multiplies
 * combinatorially through nested `many`/`sepBy`/`sequence`. Mirrors emitLazy's
 * named-function path (same `_pf` naming, same recordFail/scope reset). Leaf
 * terminals and `lazy` refs are handled elsewhere; named rules keep their own
 * `_r_<Name>` path; probe/ trivia-capture contexts opt out (see `noHoist`).
 */
function emit(p: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  // sharedPrefix: a registered leading terminal replays the once-recognized prefix
  // instead of re-scanning (see emitSharedPrefix). Checked before coverage/hoisting
  // — the replay is a plain leaf emission with no rule/label identity of its own.
  const replay = ctx.replayPrefix?.get(p)
  if (replay !== undefined) return emitReplayPrefixLeaf(ctx, pos, replay)
  const dispatch = (emissionPos = pos): ER => {
    const savedRule = ctx.activeCoverageRuleId
    const rule = ctx.coverage?.plan.rules.get(p)
    // The outer coverage IIFE owns the entry rule's failure event, because its
    // generated body may return directly from any depth.
    if (rule && p !== ctx.coverage?.entry && !ctx.suppressCoverageFailure) ctx.activeCoverageRuleId = rule
    const result = emitDispatch(p, ctx, emissionPos)
    ctx.activeCoverageRuleId = savedRule
    return result
  }
  const instrument = (r: ER): ER => {
    const ruleId = ctx.coverage?.plan.rules.get(p)
    const labelIds = ctx.coverage?.plan.labels.get(p)
    if (!ruleId && !labelIds) return r
    return {
      ...r,
      stmts: [
        ...(ruleId ? [`${ind(ctx)}_ctx._grammarCoverage?.(${JSON.stringify(ruleId)})`] : []),
        ...(ruleId ? [`${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(ruleId)}, phase: 'enter', offset: ${pos} })`] : []),
        ...r.stmts,
        ...(ruleId ? [`${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(ruleId)}, phase: 'success', offset: ${pos}, end: ${r.endVar} })`] : []),
        ...(labelIds?.flatMap(id => [`${ind(ctx)}_ctx._grammarCoverage?.(${JSON.stringify(id)})`]) ?? []),
        ...(labelIds?.flatMap(id => [`${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(id)}, phase: 'success', offset: ${pos}, end: ${r.endVar} })`]) ?? []),
      ],
    }
  }
  const usage = ctx.lazyUsage
  if (
    usage &&
    !ctx.noHoist &&
    !ctx.capAsTrivia &&
    !ctx.ruleNames?.has(p) &&
    isHoistableTag(p._def.tag) &&
    (usage.counts.get(p) ?? 0) > 1 &&
    // Only hoist subtrees big enough that de-duplicating them beats the call
    // overhead. A tiny shared wrapper (e.g. `optional(literal(';'))`) inlines
    // faster than it calls and barely moves the byte count; the size explosion
    // is all in LARGE choices/sequences referenced from many positions.
    (usage.sizes.get(p) ?? 0) >= HOIST_MIN_SUBTREE
  ) {
    const existing = ctx.namedParsers.get(p)
    if (existing !== undefined) return emitNamedFnCall(ctx, existing, pos)
    const fnName = `${nsp(ctx)}_pf${ctx.namedParsers.size}`
    ctx.namedParsers.set(p, fnName)   // register FIRST (defensive; a compound ref never self-recurses)
    const savedIndent    = ctx.indent
    const savedFailLabel = ctx.failLabel
    const savedRecord    = ctx.recordFail
    const savedInlineLeft = ctx.inlineLeft, savedFnName = ctx.currentFnName
    ctx.inlineLeft = ctx.inlineMax; ctx.currentFnName = fnName
    ctx.indent    = 1
    ctx.failLabel = '_pfail'  // failures break _pfail (labeled block in the fn body)
    ctx.recordFail = true     // shared body always records; each caller decides propagation
    const r = dispatch('_pos')
    ctx.indent    = savedIndent
    ctx.failLabel = savedFailLabel
    ctx.recordFail = savedRecord
    ctx.inlineLeft = savedInlineLeft
    ctx.currentFnName = savedFnName
    pushNamedFnDecl(ctx, fnName, r.stmts, r.valueVar, r.endVar)
    return instrument(emitNamedFnCall(ctx, fnName, pos))
  }
  return instrument(dispatch())
}

function emitDispatch(p: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  // A balanced() under a grammar-level ambient scanSkip must re-resolve that set
  // into its INTERIOR at emit time — the compiled mirror of the interpreter
  // wrapper. Without this the eager `_def` (per-call skip only) would let a
  // delimiter hidden inside a declared opaque region (string) close the balance
  // early. Rebuild the interior with [ambient scanSkip, ...ownSkip] and emit it.
  const bal = (p as BalancedAmbient)._balancedAmbient
  // Precise, identity-keyed cycle guard (`balancedRebuildStack`): break the SECOND
  // recursion class WITHOUT over-suppressing. When a `balanced()` is a MEMBER of its
  // own `activeScanSkip`, the rebuilt interior contains that same skipper — re-entering
  // here with the unchanged set would rebuild forever (distinct from a balanced's own
  // `self` back-edge, handled below via the lazy-usage merge). Suppress the rebuild
  // ONLY when re-entering a balanced ALREADY on the stack (the true self-cycle); it
  // then emits its eager `_def`. A NESTED DIFFERENT balanced (not on the stack) STILL
  // gets its own ambient rebuild, so it keeps skipping ambient opaque units — matching
  // the interpreter (a blanket flag would emit it eager and diverge).
  if (bal && ctx.activeScanSkip && ctx.activeScanSkip.length > 0 && !ctx.balancedRebuildStack?.has(p)) {
    const interior = buildBalancedInterior(bal.open, bal.close, [...ctx.activeScanSkip, ...bal.ownSkip])
    markUnusedValues(interior)
    // The interior is created HERE, so it is absent from ctx.lazyUsage — which
    // `emitLazy` reads to tell a recursive `self` back-edge (name it) from a
    // single-use ref (inline it). Without merging, its `self` would be treated as
    // single-use and inlined forever. Merge the fresh subtree's analysis in (its
    // nodes have unique identities, so no collision) so `self` is named + recursive.
    if (ctx.lazyUsage) {
      const u = analyzeLazyUsage(interior)
      for (const [k, n] of u.counts) ctx.lazyUsage.counts.set(k, (ctx.lazyUsage.counts.get(k) ?? 0) + n)
      for (const k of u.recursive) ctx.lazyUsage.recursive.add(k)
      for (const [k, s] of u.sizes) ctx.lazyUsage.sizes.set(k, s)
    }
    const stack = ctx.balancedRebuildStack ?? (ctx.balancedRebuildStack = new Set())
    stack.add(p)
    try {
      return emit(interior, ctx, pos)
    } finally {
      stack.delete(p)
    }
  }
  const def = p._def
  switch (def.tag) {
    case 'literal':   return emitLit(def, ctx, pos)
    case 'regex':     return emitRegex(def, ctx, pos, p._meta.canMatchNewline)
    case 'keywords':  return emitKeywords(def, ctx, pos)
    case 'sequence':  return emitSeq(def, ctx, pos)
    case 'choice':    return emitChoice(p, def, ctx, pos)
    case 'dispatch':  return emitDispatchCombinator(p, def, ctx, pos)
    case 'attempt':   return emitAttempt(p, def, ctx, pos)
    case 'many':
    case 'oneOrMore': return emitMany(def, ctx, pos)
    case 'optional':  return emitOptional(def, ctx, pos)
    case 'sepBy':     return emitSepBy(p, def, ctx, pos)
    case 'transform': {
      const fnSrc = transformFnSource(def.fn, def.fnSrc)
      if (fnSrc && def.parser._def.tag === 'dispatch' && isDispatchTailOnlyTransform(fnSrc)) {
        return emitDispatchCombinator(def.parser, def.parser._def, ctx, pos, 'tail')
      }
      if (fnSrc && def.parser._def.tag === 'sequence') {
        const seqR = emitSeqValues(def.parser._def, ctx, pos)
        const inlined = tryInlineDestructureTransform(fnSrc, seqR.valueVars)
        if (inlined) {
          const mv = v(ctx, '_mapped')
          return {
            stmts: [...seqR.stmts, `${ind(ctx)}const ${mv} = ${inlined}`],
            valueVar: mv,
            endVar: seqR.endVar,
          }
        }
      }
      const inner = emit(def.parser, ctx, pos)
      if (fnSrc) {
        const unary = tryInlineUnaryTransform(fnSrc, inner.valueVar)
        if (unary) {
          const mv = v(ctx, '_mapped')
          return {
            stmts: [...inner.stmts, `${ind(ctx)}const ${mv} = ${unary}`],
            valueVar: mv,
            endVar: inner.endVar,
          }
        }
      }
      const fnIdx = pushMapFn(ctx, def.fn, def.fnSrc ?? null)
      const mv = v(ctx, '_mapped')
      return {
        stmts: [
          ...inner.stmts,
          `${ind(ctx)}const ${mv} = ${mfRef(ctx)}[${fnIdx}](${inner.valueVar}, { start: ${pos}, end: ${inner.endVar} })`,
        ],
        valueVar: mv,
        endVar: inner.endVar,
      }
    }
    case 'skip': {
      const mainR = emit(def.main, ctx, pos)
      const skipR = emit(def.skipped, ctx, mainR.endVar)
      // skipped is optional — if it fails we just keep main's end
      const endV = v(ctx, '_skipe')
      return {
        stmts: [
          ...mainR.stmts,
          // try skipped; if fails, keep main end
          `${ind(ctx)}let ${endV} = ${mainR.endVar}`,
          `${ind(ctx)}try {`,
          ...reindentStmts(skipR.stmts, ctx.indent + 1),
          `${ind(ctx)}  ${endV} = ${skipR.endVar}`,
          `${ind(ctx)}} catch {}`,
        ],
        valueVar: mainR.valueVar,
        endVar: endV,
      }
    }
    case 'lazy':     return emitLazy(p, def, ctx, pos)
    case 'trivia':   return emit(def.parser, ctx, pos)
    case 'token':    return emitToken(def, ctx, pos)
    case 'leaf':     return emitLeaf(def, ctx, pos)
    case 'label': {
      const inner = emitFallible(def.parser, ctx, pos)
      return {
        stmts: [
          ...inner.stmts,
          ...emitIfFail(ctx, `!${inner.okVar}`, failBody(ctx, JSON.stringify(def.label), '_ctx._fe')),
        ],
        valueVar: inner.valVar,
        endVar: inner.endVar,
      }
    }
    case 'field': {
      const inner = emit(def.parser, ctx, pos)
      return {
        stmts: [
          ...inner.stmts,
          `${ind(ctx)}if (_ctx._fields) _ctx._fields.push({ name: ${JSON.stringify(def.name)}, value: ${inner.valueVar}, span: { start: ${pos}, end: ${inner.endVar} } })`,
        ],
        valueVar: inner.valueVar,
        endVar: inner.endVar,
      }
    }
    case 'grammar': {
      const savedTrivia = ctx.activeTrivia
      const savedKindLabels = ctx.triviaKindLabels
      const opaqueRootCapture = hasSelectedRootTrivia(ctx) && def.rootCapture === 'opaque'
      const strictScopeCheck = hasSelectedRootTrivia(ctx) && def.triviaParser !== undefined
        && !def.triviaParser._meta.rootTriviaClassified
        && !opaqueRootCapture
        ? `${ind(ctx)}if (_ctx._rootTriviaStrictScopes) throw new TypeError(${JSON.stringify('parser(): selected root trivia requires classifiedTrivia() for every local trivia scope, or rootCapture: \'opaque\'.')})`
        : undefined
      if (def.clearTrivia) {
        // noTrivia / parser({ trivia: null }): contiguous terms, no trivia skipped.
        ctx.activeTrivia = undefined
        ctx.triviaKindLabels = undefined
      } else if (def.triviaParser) {
        ctx.activeTrivia = def.triviaParser
        if (def.triviaParser._meta.triviaKindLabels) {
          ctx.triviaKindLabels = def.triviaParser._meta.triviaKindLabels
        }
      }
      const savedCapture = def.captureTrivia ? v(ctx, '_gcap') : null
      const savedRootCapture = opaqueRootCapture ? v(ctx, '_grtc') : null
      const opaqueValue = opaqueRootCapture ? v(ctx, '_grtv') : null
      const opaqueEnd = opaqueRootCapture ? v(ctx, '_grte') : null
      if (opaqueRootCapture) ctx.indent++
      const r = emit(def.parser, ctx, pos)
      if (opaqueRootCapture) ctx.indent--
      ctx.activeTrivia = savedTrivia
      ctx.triviaKindLabels = savedKindLabels
      if (!savedCapture && !opaqueRootCapture) return strictScopeCheck === undefined ? r : {
        ...r,
        stmts: [strictScopeCheck, ...r.stmts],
      }
      if (opaqueRootCapture) {
        return {
          stmts: [
            ...(strictScopeCheck === undefined ? [] : [strictScopeCheck]),
            `${ind(ctx)}let ${opaqueValue}, ${opaqueEnd}`,
            `${ind(ctx)}${savedCapture ? `const ${savedCapture} = _ctx.captureTrivia; ` : ''}const ${savedRootCapture} = _ctx._rootTriviaCapture; _ctx._rootTriviaCapture = false`,
            `${ind(ctx)}try {`,
            ...(savedCapture ? [`${ind(ctx)}  _ctx.captureTrivia = true`] : []),
            ...r.stmts,
            `${ind(ctx)}  ${opaqueValue} = ${r.valueVar}; ${opaqueEnd} = ${r.endVar}`,
            `${ind(ctx)}} finally { ${savedCapture ? `_ctx.captureTrivia = ${savedCapture}; ` : ''}_ctx._rootTriviaCapture = ${savedRootCapture} }`,
          ],
          valueVar: opaqueValue!,
          endVar: opaqueEnd!,
        }
      }
      return {
        ...r,
        stmts: [
          ...(strictScopeCheck === undefined ? [] : [strictScopeCheck]),
          `${ind(ctx)}const ${savedCapture} = _ctx.captureTrivia; _ctx.captureTrivia = true`,
          ...r.stmts,
          `${ind(ctx)}_ctx.captureTrivia = ${savedCapture}`,
        ],
      }
    }
    case 'not':     return emitNot(def, ctx, pos)
    case 'peek':    return emitPeek(def, ctx, pos)
    case 'routed':  return emitRouted(ctx, pos, def)
    case 'node':    return emitNode(def, ctx, pos)
    case 'scanTo':  return emitScanTo(def, ctx, pos)
    case 'recover': return emitRecover(def, ctx, pos)
    case 'expect':  return emitExpect(def, ctx, pos)
    case 'guard': {
      const fnIdx = ctx.mapFns.length
      ctx.mapFns.push(def.predicate as (v: unknown, span: unknown) => unknown)
      // Macro path: inline the captured predicate source; runtime compile() → null.
      ctx.mapFnSrcs.push(def.predSrc ?? null)
      const vv = v(ctx)
      return {
        stmts: [
          ...emitIfFail(ctx, `!${mfRef(ctx)}[${fnIdx}](_ctx.state)`, failBody(ctx, '"gate"', pos)),
          `${ind(ctx)}const ${vv} = null`,
        ],
        valueVar: vv,
        endVar: pos,
      }
    }
    case 'withCtx': {
      // Store getter for extra value — _mf[N]() returns the captured value.
      const evIdx = ctx.mapFns.length
      const extra = def.extra
      ctx.mapFns.push((() => extra) as (v: unknown, span: unknown) => unknown)
      // Macro path: inline the captured `extra` as a getter `() => (extra)` so
      // `_mf[evIdx]()` returns the value; runtime compile() → null (closure above).
      ctx.mapFnSrcs.push(def.extraSrc !== undefined ? `() => (${def.extraSrc})` : null)

      // Wrap inner parser as a named function so it receives _ctx as a parameter.
      // That lets us call it with a modified ctx (user changed) without polluting
      // the outer _ctx variable for subsequent emits.
      const innerParser = def.parser as Combinator<unknown>
      if (!ctx.namedParsers.has(innerParser)) {
        const fnName = `_wcf${ctx.namedParsers.size}`
        ctx.namedParsers.set(innerParser, fnName)
        const savedIndent    = ctx.indent
        const savedFailLabel = ctx.failLabel
        const savedRecord    = ctx.recordFail
        const savedInlineLeft = ctx.inlineLeft, savedFnName = ctx.currentFnName
        ctx.inlineLeft = ctx.inlineMax; ctx.currentFnName = fnName
        ctx.indent    = 1
        ctx.failLabel = '_pfail'  // failures break _pfail (same as emitLazy)
        ctx.recordFail = true     // shared body always records (see emitLazy)
        // Emit the inner BODY directly (emitDispatch), not through the hoist
        // wrapper `emit()`. We just pre-registered `innerParser → _wcf` above so
        // OTHER references reuse this named fn; re-entering `emit()` here would
        // re-find that same registration and emit a SELF-CALL (`_wcf` calls
        // `_wcf`) whenever the inner is multiply-reachable (`counts > 1`) and big
        // enough to hoist — infinite recursion at parse time. Mirrors `emit()`'s
        // own register-then-emitDispatch pattern (never emit-on-self).
        const innerR = emitDispatch(innerParser, ctx, '_pos')
        ctx.indent    = savedIndent
        ctx.failLabel = savedFailLabel
        ctx.recordFail = savedRecord
        ctx.inlineLeft = savedInlineLeft
        ctx.currentFnName = savedFnName
        pushNamedFnDecl(ctx, fnName, innerR.stmts, innerR.valueVar, innerR.endVar)
      }
      const fn = ctx.namedParsers.get(innerParser)!

      const rv = v(ctx, '_wcr')
      const vv = v(ctx, '_wcv')
      const ev = v(ctx, '_wce')
      return {
        stmts: [
          `${ind(ctx)}const ${rv} = { ..._ctx, state: ${mfRef(ctx)}[${evIdx}]() }`,
          `${ind(ctx)}const ${vv} = ${fn}(input, ${pos}, ${rv})`,
          // withCtx runs on a spread child ctx — copy its recorded failure back
          // and propagate the inner failure verbatim (interpreter parity).
          ...emitIfFail(ctx, `${vv} === ${NAMED_FN_FAIL}`, propagateFailBody(ctx, rv)),
          `${ind(ctx)}const ${ev} = ${NAMED_FN_END}`,
        ],
        valueVar: vv,
        endVar: ev,
      }
    }
    default:         return emitRuntimeFallback(p, ctx, pos)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/*
 * Host mode, its fused-map symbols, and the artifact/host compatibility check now live
 * in `src/cst/host-mode.ts` — the DRIVER (`parseman/run`) has to enforce the same
 * contract and cannot import the compiler to reach it. Re-exported here so every
 * existing `from './compiler/codegen.ts'` import keeps working unchanged.
 */
export { assertHostModeCompatible, FUSED_HOST_MODE, FUSED_HOST_ELIDED } from '../cst/host-mode.ts'
export type { HostMode } from '../cst/host-mode.ts'

export type CompiledParser<T> = {
  parse(input: string, pos?: number): ParseResult<T>
  /** Like parse(), but with a caller-supplied ParseContext (e.g. `_triviaLog` for CST grammars). */
  parseWithContext(input: string, ctx: ParseContext, pos?: number): ParseResult<T>
  /**
   * Like parse(), but activates the error-collection channel. Recovery points
   * (expect()) collect their ParseErrors into result.errors instead of only
   * embedding them as values. Always returns ParseOk — top-level failures are
   * still ParseFail.
   */
  parseWithErrors(input: string, pos?: number): ParseResult<T> & { errors: ParseError[] }
  /** The generated source (for inspection / future source maps) */
  source: string
  /**
   * A self-contained JS expression (IIFE) that evaluates to a parse function.
   * Safe to inline directly into transformed source — no external references
   * except for runtime-fallback parsers embedded via closures.
   * Returns null if the parser cannot be fully inlined (e.g. contains user
   * closures that can't be serialized).
   */
  inlineExpression: string | null
  /** Present only when compiled with `{ coverage: true }`. */
  coverageDefinitions?: readonly import('./grammar-coverage-ids.ts').GrammarCoverageDefinition[]
}

function hasLineTrackingDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  if (p._meta.grammarTrackLines) return true
  if (d.tag === 'grammar' && d.trackLines) return true
  if (d.tag === 'lazy') {
    try { return hasLineTrackingDef(d.thunk(), seen) } catch { return false }
  }
  return childrenOf(d).some(child => hasLineTrackingDef(child, seen))
}

function parserUsesRouted(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'routed':    return true
    case 'lazy':      { try { return parserUsesRouted(d.thunk(), seen) } catch { return false } }
    case 'dispatch':  return false
    default:          return childrenOf(d).some(child => parserUsesRouted(child, seen))
  }
}

/** Whether a grammar tree owns a direct semantic node reduction. */
function hasDirectBuildDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  if (d.tag === 'node' && d.build !== undefined) return true
  if (d.tag === 'lazy') {
    try { return hasDirectBuildDef(d.thunk(), seen) } catch { return false }
  }
  return childrenOf(d).some(child => hasDirectBuildDef(child, seen))
}

/** Immediate child combinators of a def, for generic tree walks (childrenOf). */
function childrenOf(def: ParserDef): Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':    return def.parsers
    case 'dispatch':  return [def.selector, ...def.cases.map(entry => entry.parser), ...(def.matchers ? def.matchers.map(entry => entry.parser) : []), ...(def.otherwise ? [def.otherwise] : [])]
    case 'many':
    case 'attempt':
    case 'optional':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'grammar':
    case 'not':
    case 'peek':
    case 'node':
    case 'withCtx':
    case 'expect':    return [def.parser]
    // emitMany's min>=1 branch and emitSepBy both codegen `def.parser` more than
    // once (`min` mandatory matches, then again inside the repeat loop) — each is a
    // real emit() call site, so the usage analysis must see one edge per site or it
    // undercounts a single-use `parser` ref as inline-safe when it's actually
    // referenced from several positions within this one compiled function.
    case 'oneOrMore': return Array.from({ length: def.min + 1 }, () => def.parser)
    case 'sepBy':     return [def.parser, def.parser, def.separator]
    case 'skip':      return [def.main, def.skipped]
    case 'recover':   return [def.parser, def.sentinel]
    case 'scanTo':    return [def.sentinel, ...def.skip]
    // A `routed()` fallback IS emitted at this site (emitRouted), so the usage
    // analysis must see the edge — otherwise a fallback shared by several routed()
    // sites is miscounted as single-use and inlined at each.
    case 'routed':    return def.fallback ? [def.fallback] : []
    case 'lazy':
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'unknown':   return []
  }
}

/**
 * Compound combinators worth hoisting into a shared named function when the SAME
 * object is referenced more than once. Leaf terminals (`literal`/`regex`/
 * `keywords`/`guard`) aren't worth a call; `lazy` is owned by emitLazy; the
 * context-bearing wrappers (`grammar`/`trivia`/`label`/`withCtx`/`expect`/`skip`/
 * `recover`/`scanTo`) are excluded so no per-site context (active trivia, capture
 * mode) can be baked into a shared body.
 */
const HOISTABLE_TAGS: ReadonlySet<ParserDef['tag']> = new Set<ParserDef['tag']>([
  'sequence', 'choice', 'dispatch', 'many', 'oneOrMore', 'optional', 'sepBy', 'transform', 'node', 'not',
])
function isHoistableTag(tag: ParserDef['tag']): boolean {
  return HOISTABLE_TAGS.has(tag)
}

/** Minimum approximate subtree size (see `subtreeSizes`) for a shared combinator
 * to be hoisted into a named function rather than inlined at each reference.
 * Small enough to catch every real explosion (a value `choice` is ~12+), large
 * enough that trivial shared wrappers stay inline and keep the hot path fast. */
const HOIST_MIN_SUBTREE = 3

/**
 * INLINE EXPANSION CAP — a bound on how much one emitted function may grow by pasting
 * single-use ref bodies into it.
 *
 * The decision procedure, in one sentence: **each emitted function gets a budget of
 * `INLINE_MAX_NODES` combinator nodes of inlined single-use refs; once it is spent, the
 * remaining single-use refs in that function become named functions and are called.**
 *
 * What this limits, precisely. `emitLazy` inlines a ref that is used ONCE and is not
 * recursive, because hoisting a function nobody else calls is pure overhead. That is
 * correct per ref and unbounded in aggregate: a rule whose body is a chain of
 * single-use helpers expands transitively, and the expansion has no ceiling that a
 * grammar author can see or predict. This is NOT the identity-keyed hoisting of a
 * MULTIPLY-referenced subtree (`HOIST_MIN_SUBTREE` above) — that already works, and a
 * shared object referenced 1 or 38 times emits flat. Conflating the two is what made
 * the size problem look like a duplication problem.
 *
 * Why a per-function budget rather than a per-ref size limit or a whole-artifact budget:
 *  - a per-ref limit bounds each paste but not the transitive total, which is the
 *    quantity that actually grows;
 *  - a whole-artifact budget needs an eviction order, and any order that depends on
 *    which function was compiled first is a decision the author cannot predict;
 *  - a per-function budget needs no eviction order at all. Emission order within one
 *    function is the grammar's own left-to-right order, so "the refs after the budget
 *    runs out" is stable and explainable.
 *
 * Charge unit is `subtreeSizes` — the same approximate node count `HOIST_MIN_SUBTREE`
 * uses, so the two policies are denominated in one currency.
 *
 * The default is measured, not chosen by taste: see `bench/size/inline-cap.md` for the
 * size/speed sweep this number came from.
 */
export const INLINE_MAX_NODES = 1000

/**
 * Resolve the cap: explicit option wins, then `PARSEMAN_MAX_INLINE`, then the default.
 * The escape hatch is deliberately explicit and OFF by default — a grammar that really
 * wants unbounded inlining sets `Infinity` and says so, rather than discovering that a
 * silent policy took it away. Read ONCE per compile and stored on the ctx, so a single
 * compile can never observe two different values.
 */
export function resolveInlineMax(explicit?: number): number {
  if (explicit !== undefined) return explicit
  const env = typeof process !== 'undefined' ? process.env?.PARSEMAN_MAX_INLINE : undefined
  if (env !== undefined && env !== '') {
    if (env === 'off' || env === 'infinity') return Infinity
    const n = Number(env)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return INLINE_MAX_NODES
}

/**
 * Static-occurrence analysis for `lazy` (ref()) combinators, ahead of codegen.
 * `emitLazy` currently hoists EVERY lazy ref into its own named function
 * (_pfN), even when it's referenced from exactly one place — necessary for
 * genuinely recursive/shared rules, wasteful for the common case of a `g.foo`
 * helper rule used for grammar readability but only ever called once. On a
 * large mutually-referential grammar (many `g.xxx` helper rules, each used
 * from ~1 call site) this multiplies function count far past the number of
 * rules a grammar author actually wrote — observed on the Less grammar:
 * ~1700 compiled functions from ~150 source rules, vs a roughly 1:3 ratio on
 * a comparably-sized but flatter grammar.
 *
 * Returns, for every reachable `lazy` combinator: how many static call sites
 * reference it (`counts`), and whether it participates in a reference cycle
 * (`recursive` — must stay a named function; inlining a cycle would recurse
 * forever). A ref with count <= 1 and no cycle membership is safe to inline
 * directly at its single call site instead of becoming a named function.
 *
 * Traversal cost: each `lazy` ref's body is descended into at most once
 * (subsequent occurrences just bump the counter) — polynomial in the number
 * of distinct reachable combinators, matching emitLazy's own memoized
 * codegen cost. Non-lazy nodes are walked without memoization, same as
 * `emit()` itself (a directly-shared non-ref subtree — discouraged by the
 * `g.xxx` convention but not disallowed — is revisited per occurrence, same
 * cost class as compilation already pays for it today).
 */
type LazyUsage = {
  counts: Map<Combinator<unknown>, number>
  recursive: Set<Combinator<unknown>>
  sizes: Map<Combinator<unknown>, number>
}

function analyzeLazyUsage(root: Combinator<unknown>): LazyUsage {
  return analyzeLazyUsageMulti([root])
}

/**
 * Memoized approximate subtree size: number of combinator nodes reachable from
 * `p` WITHOUT crossing a `lazy` boundary (a ref counts as 1 leaf — it lowers to a
 * call, not an inline expansion). This is the size that would be DUPLICATED if the
 * subtree were pasted at another reference, so it's the right quantity to gate
 * hoisting on. Cycles (only possible through a `lazy`, which is a leaf here) can't
 * recur. */
function subtreeSizes(roots: Iterable<Combinator<unknown>>): Map<Combinator<unknown>, number> {
  const sizes = new Map<Combinator<unknown>, number>()
  // A node's inline-expansion size: itself + each child's size, but a `lazy` child
  // counts as 1 (it lowers to a call, so it isn't part of the duplicated bytes).
  // Never crosses a lazy, so it can't cycle (compound nodes don't cycle alone).
  const sz = (p: Combinator<unknown>): number => {
    const cached = sizes.get(p)
    if (cached !== undefined) return cached
    const def = p._def
    let s = 1
    if (def.tag !== 'lazy') {
      for (const child of childrenOf(def)) s += child._def.tag === 'lazy' ? 1 : sz(child)
    }
    sizes.set(p, s)
    return s
  }
  // Visit crosses lazy boundaries (the roots ARE lazy rule-refs) so every reachable
  // compound node gets a size entry; sz() then fills the whole non-lazy subtree.
  const visitedLazy = new Set<Combinator<unknown>>()
  const visit = (p: Combinator<unknown>): void => {
    const def = p._def
    if (def.tag === 'lazy') {
      if (visitedLazy.has(p)) return
      visitedLazy.add(p)
      let resolved: Combinator<unknown>
      try { resolved = def.thunk() } catch { return }
      visit(resolved)
      return
    }
    sz(p)
    for (const child of childrenOf(def)) visit(child)
  }
  for (const root of roots) visit(root)
  return sizes
}

/**
 * Multi-root variant, for compileRuleMap(): a `rules()` factory's returned
 * map has many top-level entries that legitimately share reachable sub-rules
 * (e.g. `Stylesheet` and `Declaration` both reach `g.valueList`). Walking each
 * entry as its own root into ONE shared counts/descended/active state means a
 * ref's count correctly reflects total usage across the WHOLE rule map — used
 * once as its own top-level entry AND referenced once internally elsewhere is
 * count 2 (stays a named function, shared correctly), not two independent 1s
 * from two unrelated single-root analyses.
 */
function analyzeLazyUsageMulti(roots: Iterable<Combinator<unknown>>): LazyUsage {
  const counts = new Map<Combinator<unknown>, number>()
  const recursive = new Set<Combinator<unknown>>()
  const descended = new Set<Combinator<unknown>>()
  const active = new Set<Combinator<unknown>>()

  function walk(p: Combinator<unknown>): void {
    const def = p._def
    if (def.tag === 'lazy') {
      counts.set(p, (counts.get(p) ?? 0) + 1)
      if (active.has(p)) {
        recursive.add(p)
        return
      }
      if (descended.has(p)) return
      descended.add(p)
      let resolved: Combinator<unknown>
      try {
        resolved = def.thunk()
      } catch {
        return // ref.define() not called yet — emitLazy's own try/catch handles this at codegen time
      }
      active.add(p)
      walk(resolved)
      active.delete(p)
      return
    }
    // A non-lazy COMPOUND combinator shared by object identity (e.g. a
    // `const value = choice(...)` referenced from several rules, or a sub-parser
    // reached through nested `many`/`sepBy`) is counted per reference edge, so
    // codegen can hoist a multiply-referenced subtree into ONE named function
    // instead of pasting its full lowered body at every reference — the
    // multiplication that makes nested value grammars explode. We intentionally do
    // NOT memoize the descent here: cycle detection for `lazy` relies on fully
    // traversing every active path (a compound `descended` short-circuit would let
    // the walker return before re-reaching an active `self` ref and marking it
    // recursive → emitLazy would then inline a recursive ref forever). Non-lazy
    // nodes never form a cycle without passing through a `lazy` (which has its own
    // active/descended guards), so the re-walk stays finite — same cost as before.
    if (isHoistableTag(def.tag)) {
      counts.set(p, (counts.get(p) ?? 0) + 1)
    }
    for (const child of childrenOf(def)) walk(child)
  }

  const rootsArr = [...roots]
  for (const root of rootsArr) walk(root)
  return { counts, recursive, sizes: subtreeSizes(rootsArr) }
}

/**
 * Dependency manifest for the linkable form: for each rule in the map, the set
 * of OTHER rule names its body references (by name). A referenced rule is a
 * boundary — we record the edge and do NOT descend into it (its own deps are its
 * own entry). Used by the linker for à la carte dep-closure selection and the
 * compose-time name-closure check (every referenced name must resolve in the
 * final set). Self-references are included (a recursive rule depends on itself).
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
      // A named `ref` (local OR external) is a rule boundary: record the edge and
      // don't descend. `_ruleName` (set by rules()) also catches EXTERNAL refs —
      // rules referenced by name but defined in another artifact.
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

/**
 * Compile a combinator tree into an optimized parse function at runtime.
 *
 * Uses `new Function` internally, so it will fail in environments with a strict
 * Content Security Policy that omits `'unsafe-eval'`. Prefer the interpreter or
 * macro build plugin in those cases.
 *
 * @see https://www.greadme.com/blog/security/what-is-content-security-policy-complete-guide
 */
/**
 * The `duplication` compile option. A bare level is shorthand for `{ level }`; the
 * object form adds the `accept` allowlist (finding ids acknowledged as intentional)
 * and the ranking knobs.
 *
 * DEFAULT IS `'off'`, unlike gating. An ungated hot choice is a cliff with no other
 * symptom; a duplicated subtree is a maintenance cost the author may have chosen.
 * More to the point, most findings here are CANDIDATES that need an AST check
 * before they are applied — a diagnostic that prints "candidate, verify" on every
 * build teaches people to stop reading it. Run it deliberately (a lint script, a
 * review pass, `PARSEMAN_DUPLICATION=warn`), not on every compile.
 */
export type DuplicationOption =
  | DuplicationWarnLevel
  | { level?: DuplicationWarnLevel; accept?: Iterable<string>; minSize?: number; maxFindings?: number; entryName?: string }

function resolveDuplicationLevel(opt: DuplicationOption | undefined): DuplicationWarnLevel {
  const explicit = typeof opt === 'string' ? opt : opt?.level
  if (explicit !== undefined) return explicit
  const env = typeof process !== 'undefined' ? (process.env?.PARSEMAN_DUPLICATION as DuplicationWarnLevel | undefined) : undefined
  if (env === 'off' || env === 'warn' || env === 'error') return env
  return 'off'
}

/**
 * Run the duplication diagnostic and surface it per the resolved level. Never
 * throws from the analysis itself — only `'error'` deliberately throws on a real
 * finding. Shared by ALL THREE lowering paths (`compile`, `compileRuleMap`,
 * `compileLinkable`): the macro build never calls `compile()`, and a diagnostic
 * wired only there is a diagnostic that reports zero findings forever — which is
 * exactly what happened to the gating diagnostic for two minor versions.
 */
function reportDuplication(
  opt: DuplicationOption | undefined,
  analyze: (o: { accept?: Iterable<string>; minSize?: number; maxFindings?: number; entryName?: string } | undefined) => DuplicationReport,
): DuplicationReport | undefined {
  const level = resolveDuplicationLevel(opt)
  if (level === 'off') return undefined
  const obj = opt !== null && typeof opt === 'object' ? opt : undefined
  const analyzeOpts = obj === undefined ? undefined : {
    ...(obj.accept !== undefined ? { accept: obj.accept } : {}),
    ...(obj.minSize !== undefined ? { minSize: obj.minSize } : {}),
    ...(obj.maxFindings !== undefined ? { maxFindings: obj.maxFindings } : {}),
    ...(obj.entryName !== undefined ? { entryName: obj.entryName } : {}),
  }
  let report: DuplicationReport
  try { report = analyze(analyzeOpts) }
  catch (err) {
    // The analysis is ADVISORY — it must never break a compile that is otherwise
    // correct, so this does not rethrow even at `'error'`. But it must not be
    // SILENT either: `assertAnalyzable` throws a deliberately actionable TypeError
    // when handed a composed (already-fused) map, and swallowing that reported the
    // same "no findings" as a genuinely clean grammar. That is the exact failure
    // the gating diagnostic shipped for two minor versions.
    console.warn(
      `parseman: the duplication diagnostic could not run, so NOTHING was checked — `
      + `this is not a clean result.\n  ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
  const lines = formatDuplicationFindings(report)
  if (lines.length > 0) {
    if (level === 'error') throw new Error(`parseman: ${duplicationFindingCount(report)} duplication/overlap finding(s)\n${lines.join('\n')}`)
    for (const l of lines) console.warn(l)
  }
  return report
}

function runDuplicationDiagnostic<T>(combinator: Combinator<T>, opt: DuplicationOption | undefined): DuplicationReport | undefined {
  return reportDuplication(opt, o => analyzeDuplication(combinator as Combinator<unknown>, o))
}

function runDuplicationDiagnosticRules(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opt: DuplicationOption | undefined,
): DuplicationReport | undefined {
  return reportDuplication(opt, o => analyzeDuplicationRules(ruleMap, o))
}

export function compile<T>(combinator: Combinator<T>, mapFnSources?: string[], opts?: { recovery?: boolean; hostMode?: HostMode; coverage?: boolean; duplication?: DuplicationOption; trackLines?: boolean; maxInline?: number }): CompiledParser<T> {
  // Degradations found while compiling THIS grammar are drained as one aggregated block
  // rather than printed one wall-of-text line at a time as they are discovered. A no-op
  // inside a macro transform, whose own sink owns the module's findings.
  const drain = beginCompileDegradationDrain()
  let completed = false
  try {
    const compiled = compileImpl(combinator, mapFnSources, opts)
    completed = true
    return compiled
  }
  finally { drain(completed) }
}

function compileImpl<T>(combinator: Combinator<T>, mapFnSources?: string[], opts?: { recovery?: boolean; hostMode?: HostMode; coverage?: boolean; duplication?: DuplicationOption; trackLines?: boolean; maxInline?: number }): CompiledParser<T> {
  runDuplicationDiagnostic(combinator, opts?.duplication)
  markUnusedValues(combinator)
  // Grammar-level ambient trivia declared via rules({ trivia }, factory): seed it
  // as the default activeTrivia so every rule bakes it (unless a local
  // parser({trivia}) / noTrivia overrides). This is the compiled mirror of the
  // interpreter installing it as ctx.trivia at the entry.
  const grammarTrivia = (combinator._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia
  const rootTriviaClassified = grammarTrivia?._meta.rootTriviaClassified === true
    || combinator._meta.rootTriviaClassified === true
  const grammarScanSkip = (combinator._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip
  const grammarHostMode = (combinator._meta as { grammarHostMode?: HostMode }).grammarHostMode
  const grammarTrackLines = combinator._meta.grammarTrackLines
  const _inlineMax = resolveInlineMax(opts?.maxInline)
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
    inlineMax: _inlineMax,
    inlineLeft: _inlineMax,
    regexDecls: [],
    regexMap: new Map(),
    expectedDecls: [],
    expectedMap: new Map(),
    recordFail: true,
    mapFns: [],
    mapFnSrcs: [],
    buildFns: [],
    buildSrcs: [],
    runtimeParsers: [],
    namedParsers: new Map(),
    triviaCaptureNames: new Map(),
    triviaFnNames: new Map(),
    namedFnDecls: [],
    capturing: hasNodeDef(combinator as Combinator<unknown>),
    recovery: opts?.recovery ?? false,
    hostMode: opts?.hostMode ?? grammarHostMode ?? 'ast',
    lineTracking: opts?.trackLines === true || grammarTrackLines === true || hasLineTrackingDef(combinator as Combinator<unknown>),
    ...(opts?.coverage ? { coverage: { plan: buildGrammarPlan(combinator as Combinator<unknown>), entry: combinator as Combinator<unknown> } } : {}),
    lazyUsage: analyzeLazyUsage(combinator as Combinator<unknown>),
    ...(rootTriviaClassified ? { rootTriviaClassified: true as const } : {}),
    ...(grammarTrivia ? {
      activeTrivia: grammarTrivia,
      triviaKindLabels: grammarTrivia._meta.triviaKindLabels,
    } : {}),
    ...(grammarScanSkip ? { activeScanSkip: grammarScanSkip } : {}),
  }

  const r = emit(combinator as Combinator<unknown>, ctx, '_pos')
  const coverageRootRuleId = ctx.coverage?.plan.rules.get(combinator as Combinator<unknown>)
  const resultBody = coverageRootRuleId === undefined
    ? [
        `  let pos = _pos`,
        ...r.stmts,
        `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
      ]
    : [
        `  const _coverageResult = (() => {`,
        `    let pos = _pos`,
        ...r.stmts,
        `    return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
        `  })()`,
        `  if (!_coverageResult.ok) _ctx._grammarTrace?.write({ id: ${JSON.stringify(coverageRootRuleId)}, phase: 'failure', offset: _coverageResult.span.start })`,
        `  return _coverageResult`,
      ]

  const namedPrelude = ctx.namedFnDecls.length > 0 ? [...namedFnPrelude(), ''] : []
  const emptyTlDecls = ctx.needsEmptyTl ? ['const _EMPTY_TL = Object.freeze([])'] : []
  const hostReadsDecls = ctx.needsHostReads ? [HOST_READS_DECL] : []
  const rawEntryDecls = ctx.needsRawEntry ? [RAW_ENTRY_DECL] : []
  const lineTrackDecls = ctx.needsLineTrack ? [LINE_TRACK_DECL] : []
  const lineSpanDecls = ctx.needsLineSpan ? [LINE_SPAN_DECL] : []

  const source = [
    ...emptyTlDecls,
    ...hostReadsDecls,
    ...rawEntryDecls,
    ...lineTrackDecls,
    ...lineSpanDecls,
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    '',
    ...namedPrelude,
    ctx.namedFnDecls.join('\n\n'),
    `function _parse(input, _pos, _rp, _mf, _build, _ctx) {`,
    ...resultBody,
    `}`,
  ].join('\n')

  const fn = new Function('input', '_pos', '_rp', '_mf', '_build', '_ctx', [
    ...emptyTlDecls,
    ...hostReadsDecls,
    ...rawEntryDecls,
    ...lineTrackDecls,
    ...lineSpanDecls,
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    ...namedPrelude,
    ...ctx.namedFnDecls.flatMap((decl, i) => (i > 0 ? ['', decl] : [decl])),
    ...(coverageRootRuleId === undefined
      ? [`let pos = _pos`, ...r.stmts, `return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`]
      : [
          `const _coverageResult = (() => {`,
          `  let pos = _pos`,
          ...r.stmts,
          `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
          `})()`,
          `if (!_coverageResult.ok) _ctx._grammarTrace?.write({ id: ${JSON.stringify(coverageRootRuleId)}, phase: 'failure', offset: _coverageResult.span.start })`,
          `return _coverageResult`,
        ]),
  ].join('\n')) as (
    input: string,
    pos: number,
    rp: Array<Combinator<unknown>>,
    mf: Array<(v: unknown, span: { start: number; end: number }) => unknown>,
    build: Ctx['buildFns'],
    ctx: ParseContext,
  ) => ParseResult<T>

  const defaultCtx: ParseContext = {
    trackLines: false,
    ...(ctx.triviaKindLabels ? { triviaKindLabels: ctx.triviaKindLabels } : {}),
  }

  const annotateWithTrackedLines = <R extends ParseResult<T>>(result: R, lineStarts: number[]): R => {
    const index = normalizeLineIndex({ lineStarts })
    const annotated = { ...result, span: annotateSpan(result.span, index) } as R
    const errors = (annotated as { errors?: ParseError[] }).errors
    if (errors) {
      ;(annotated as { errors: ParseError[] }).errors = errors.map(error => ({
        ...error,
        span: annotateSpan(error.span, index),
      }))
    }
    return annotated
  }

  const trackedCtx = (base: ParseContext, input: string, pos: number): ParseContext => {
    if (!ctx.lineTracking) return base
    const lineIndex = { lineStarts: [0] }
    if (pos > 0) recordLineRange(lineIndex, input, 0, pos)
    return { ...base, trackLines: true, _lineStarts: lineIndex.lineStarts, _lineScannedTo: pos }
  }

  // Prefer per-def sources captured in codegen-traversal order (set by the
  // macro via def.fnSrc). Fall back to a caller-provided positional array.
  // The derived array is only usable when every traversed transform carried a
  // source — otherwise we can't inline the closures.
  const derivedSrcs = ctx.mapFnSrcs.length === ctx.mapFns.length && ctx.mapFnSrcs.every((s): s is string => s !== null)
    ? ctx.mapFnSrcs as string[]
    : undefined
  const effectiveSources = mapFnSources ?? derivedSrcs

  // node() build fns inline the same way: every traversed node must carry its
  // build source (set by the macro via def.buildSrc) or we can't inline.
  const buildCovered = ctx.buildFns.length === 0 || ctx.buildSrcs.every((s): s is string => s !== null)
  const buildSources = ctx.buildFns.length === 0 ? undefined : (ctx.buildSrcs as string[])

  // Build an inline expression when there are no runtime fallbacks, and either
  // no map-function closures or their source text has been provided for injection.
  const mfCovered = ctx.mapFns.length === 0 || (effectiveSources !== undefined && effectiveSources.length === ctx.mapFns.length)
  const canInline = ctx.runtimeParsers.length === 0 && mfCovered && buildCovered
  const inlineExpression: string | null = canInline ? buildInlineExpression(ctx, r, effectiveSources, buildSources, coverageRootRuleId) : null

  const compiledMeta = {
    source,
    inlineExpression,
    ...(ctx.coverage === undefined ? {} : { coverageDefinitions: ctx.coverage.plan.definitions }),
  }

  if (!ctx.lineTracking) {
    return {
      ...compiledMeta,
      parse(input: string, pos = 0): ParseResult<T> {
        return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, defaultCtx)
      },
      parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {
        // ONE check per parse, in TypeScript — not per node, and not in generated code.
        // That is the point of deciding the mode at compile time: the artifact knows what
        // it was built for, so the mismatch is caught here for free instead of by a
        // property read on every node of every parse.
        assertHostModeCompatible(ctx.hostMode ?? 'ast', parseCtx.build, !!ctx.hostBranchElided)
        return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, parseCtx)
      },
      // Note: collects expect() errors via _errors. Unlike interpreter
      // parse({recover:true}) it does NOT populate furthestFail — the compiled path
      // inlines failures for throughput and deliberately skips _probe bookkeeping.
      // Callers wanting a furthest-position diagnostic detect unconsumed input
      // (span.end < input.length) instead, which is mode-agnostic.
      parseWithErrors(input: string, pos = 0): ParseResult<T> & { errors: ParseError[] } {
        const errors: ParseError[] = []
        const result = fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, { ...defaultCtx, _errors: errors })
        return { ...result, errors } as ParseResult<T> & { errors: ParseError[] }
      },
    }
  }

  return {
    ...compiledMeta,
    parse(input: string, pos = 0): ParseResult<T> {
      const parseCtx = trackedCtx(defaultCtx, input, pos)
      const result = fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, parseCtx)
      return annotateWithTrackedLines(result, parseCtx._lineStarts!)
    },
    parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {
      // ONE check per parse, in TypeScript — not per node, and not in generated code.
      // That is the point of deciding the mode at compile time: the artifact knows what
      // it was built for, so the mismatch is caught here for free instead of by a
      // property read on every node of every parse.
      assertHostModeCompatible(ctx.hostMode ?? 'ast', parseCtx.build, !!ctx.hostBranchElided)
      const activeCtx = trackedCtx(parseCtx, input, pos)
      const result = fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, activeCtx)
      return activeCtx.trackLines ? annotateWithTrackedLines(result, activeCtx._lineStarts!) : result
    },
    // Note: collects expect() errors via _errors. Unlike interpreter
    // parse({recover:true}) it does NOT populate furthestFail — the compiled path
    // inlines failures for throughput and deliberately skips _probe bookkeeping.
    // Callers wanting a furthest-position diagnostic detect unconsumed input
    // (span.end < input.length) instead, which is mode-agnostic.
    parseWithErrors(input: string, pos = 0): ParseResult<T> & { errors: ParseError[] } {
      const errors: ParseError[] = []
      const parseCtx = trackedCtx({ ...defaultCtx, _errors: errors }, input, pos)
      const result = { ...fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, parseCtx), errors } as ParseResult<T> & { errors: ParseError[] }
      return annotateWithTrackedLines(result, parseCtx._lineStarts!) as ParseResult<T> & { errors: ParseError[] }
    },
  }
}

/**
 * Compile every entry of a `rules(factory)` map's returned object using ONE
 * shared codegen Ctx (regexes, named functions, map/build-fn arrays) instead
 * of running `compile()` independently per entry.
 *
 * Why this exists: `compile()` per entry gives each entry its own namedParsers
 * cache, so a sub-rule reachable from N different top-level entries (e.g.
 * `valueList` reachable from `Declaration`, `CustomDeclaration`, `Guard`, …)
 * gets fully re-compiled N times — on a richly cross-referential grammar
 * (Less: ~125 rule-map entries, deep mutual reference) this multiplies total
 * compiled size far past what the source grammar actually needs, independent
 * of the per-ref single-use inlining `analyzeLazyUsage` already handles
 * within one compile() call. Sharing one Ctx here means a sub-rule compiles
 * exactly once for the WHOLE rule map, however many entries reach it.
 *
 * Returns a single `replacement` — ONE shared IIFE, evaluated once, whose
 * result is the `{ key: fn, ... }` map — meant to replace the entire
 * `rules(factory)` call-expression (not one expression per key; splicing a
 * separate self-contained expression per key would either re-run the shared
 * prelude once per entry or duplicate its text per entry, undoing the win).
 * `keys` lists every entry compileRuleMap() saw, for the caller to validate
 * against the source's own key list.
 *
 * Returns null (same all-or-nothing contract the per-entry `compile()` +
 * `inlineExpression === null` check gave the plugin before) when the map
 * contains anything that can't be inlined — a runtime-fallback parser, or an
 * uncaptured transform/build closure source. The plugin's existing "warn and
 * leave this rules() call interpreted" fallback covers this case unchanged.
 */
/**
 * Grammar rule names compile to `_r_<Name>` functions and `@FS:<name>` dispatch
 * placeholders, so they MUST be valid JS identifiers. A non-identifier name (e.g.
 * `'my-rule'`) is a grammar-authoring error — throw rather than silently mangle it
 * to `_r_my_rule`, which could collide with a real `my_rule` rule.
 */
const RULE_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function assertRuleName(name: string): void {
  if (!RULE_NAME_RE.test(name)) {
    throw new Error(
      `parseman: grammar rule name ${JSON.stringify(name)} is not a valid JS identifier. ` +
      `Rule names compile to _r_<Name> functions and dispatch guards — use letters, digits, ` +
      `_ or $ (and don't start with a digit).`,
    )
  }
}

function publicRuleWrapperSource(
  rule: Combinator<unknown>,
  fnSource: string,
  ambientTriviaKindLabels?: readonly string[],
  ambientRootTriviaClassified?: true,
): string {
  // A rules({ trivia }) declaration owns the document-root category table. A
  // nested parser({ trivia }) can use a different local table, but must not
  // replace the root labels advertised by the public compiled entry.
  const labels = ambientTriviaKindLabels ?? rule._meta.triviaKindLabels
  const classified = ambientRootTriviaClassified ?? rule._meta.rootTriviaClassified
  if (labels === undefined && classified === undefined) return fnSource
  return `Object.assign(${fnSource}, { _meta: {${labels === undefined ? '' : ` triviaKindLabels: ${JSON.stringify(labels)},`}${classified === undefined ? '' : ' rootTriviaClassified: true,'} } })`
}

export function compileRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  opts?: { trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[]; recovery?: boolean; hostMode?: HostMode; trackLines?: boolean; coverage?: boolean; duplication?: DuplicationOption; maxInline?: number },
): { keys: string[]; replacement: string; hostMode: HostMode; hostBranchElided: boolean; reflection: GrammarReflection; coverageDefinitions?: readonly import('./grammar-coverage-ids.ts').GrammarCoverageDefinition[] } | null {
  runDuplicationDiagnosticRules(ruleMap, opts?.duplication)
  for (const [, rule] of ruleMap) markUnusedValues(rule)
  // Named lazy proxies already carry their stable rule identity and redirect
  // their children through the final winner graph. Register only ordinary
  // unannotated roots here: giving a lazy proxy its own winner makes a lazy
  // reference point back to itself, so its body never enters the coverage plan.
  const coverageWinners = opts?.coverage
    ? Object.fromEntries(ruleMap.filter(([, rule]) => rule._def.tag !== 'lazy')) as Record<string, Combinator<unknown>>
    : undefined
  // Grammar-level ambient trivia declared via rules({ trivia }, factory): seed it
  // as the default activeTrivia so every rule in the map bakes it (unless a local
  // parser({trivia}) / noTrivia overrides). Mirrors the interpreter installing it
  // as ctx.trivia at the entry, and compile()'s single-entry seed.
  const grammarTrivia = opts?.trivia
  const rootTriviaClassified = grammarTrivia?._meta.rootTriviaClassified === true
    || ruleMap.some(([, rule]) => rule._meta.rootTriviaClassified === true)
  // Grammar-level ambient scan-skip: explicit opt, else the first rule that carries
  // a `grammarScanSkip` stamp (from `rules({ scanSkip })`). Mirrors grammarTrivia.
  const grammarScanSkip = opts?.scanSkip
    ?? ruleMap.map(([, r]) => (r._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip).find(Boolean)
  // Grammar-level host mode, same fallback shape as the two above: explicit opt, else a
  // `grammarHostMode` stamp from `rules({ hostMode }, factory)`. The stamp is what lets
  // ONE grammar source be compiled twice (two `rules()` call sites over one factory)
  // under the MACRO, which has no other way to pass a compile option.
  const grammarHostMode = opts?.hostMode
    ?? ruleMap.map(([, r]) => (r._meta as { grammarHostMode?: HostMode }).grammarHostMode).find(Boolean)
  const grammarTrackLines = opts?.trackLines === true
    || ruleMap.some(([, r]) => r._meta.grammarTrackLines === true)
  const _inlineMax = resolveInlineMax(opts?.maxInline)
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
    inlineMax: _inlineMax,
    inlineLeft: _inlineMax,
    regexDecls: [],
    regexMap: new Map(),
    expectedDecls: [],
    expectedMap: new Map(),
    recordFail: true,
    mapFns: [],
    mapFnSrcs: [],
    buildFns: [],
    buildSrcs: [],
    runtimeParsers: [],
    namedParsers: new Map(),
    triviaCaptureNames: new Map(),
    triviaFnNames: new Map(),
    namedFnDecls: [],
    capturing: ruleMap.some(([, rule]) => hasNodeDef(rule)),
    recovery: opts?.recovery ?? false,
    hostMode: grammarHostMode ?? 'ast',
    lineTracking: grammarTrackLines,
    ...(opts?.coverage ? { coverage: { plan: buildGrammarPlan(ruleMap.map(([, rule]) => rule), coverageWinners) } } : {}),
    lazyUsage: analyzeLazyUsageMulti(ruleMap.map(([, rule]) => rule)),
    ...(rootTriviaClassified ? { rootTriviaClassified: true as const } : {}),
    ...(grammarTrivia ? {
      activeTrivia: grammarTrivia,
      triviaKindLabels: grammarTrivia._meta.triviaKindLabels,
    } : {}),
    ...(grammarScanSkip ? { activeScanSkip: grammarScanSkip } : {}),
  }

  // Reverse map: each rule's `ref` placeholder → its canonical `_r_<Name>` fn
  // name. `emitLazy` uses this so every reference to a named rule (sibling call
  // OR the map entry itself) resolves to one shared `_r_<Name>` function — the
  // linkable form that fuses into a single scope with direct local calls.
  const seenNames = new Map<string, number>()
  const ruleNames = new Map<Combinator<unknown>, string>()
  for (const [key, rule] of ruleMap) {
    assertRuleName(key)
    const base = `_r_${key}`
    const n = seenNames.get(base) ?? 0
    seenNames.set(base, n + 1)
    ruleNames.set(rule, n === 0 ? base : `${base}$${n}`)
  }
  ctx.ruleNames = ruleNames

  // A trivia rule (e.g. the grammar's `rw`, returned from the factory so the
  // driver can reach it as `g.rw`) must NOT bake the grammar-level ambient trivia
  // into itself — it would recursively skip trivia between its own terms and stop
  // short. Emit it with activeTrivia cleared, matching the inline-trivia guard.
  const perEntry = ruleMap.map(([key, rule]) => {
    const savedTrivia = ctx.activeTrivia
    const savedScanSkip = ctx.activeScanSkip
    if (rule._meta.isTrivia) { ctx.activeTrivia = undefined; ctx.activeScanSkip = undefined }
    const r = emit(rule, ctx, '_pos')
    ctx.activeTrivia = savedTrivia
    ctx.activeScanSkip = savedScanSkip
    return { key, rule, r }
  })

  const derivedSrcs = ctx.mapFnSrcs.length === ctx.mapFns.length && ctx.mapFnSrcs.every((s): s is string => s !== null)
    ? ctx.mapFnSrcs as string[]
    : undefined
  const buildCovered = ctx.buildFns.length === 0 || ctx.buildSrcs.every((s): s is string => s !== null)
  const buildSources = ctx.buildFns.length === 0 ? undefined : (ctx.buildSrcs as string[])
  const mfCovered = ctx.mapFns.length === 0 || derivedSrcs !== undefined
  const canInline = ctx.runtimeParsers.length === 0 && mfCovered && buildCovered
  if (!canInline) return null
  if (ctx.lineTracking) {
    ctx.needsLineTrack = true
    ctx.needsLineSpan = true
  }

  const mfDecl = derivedSrcs?.length ? `  const ${mfRef(ctx)} = [${derivedSrcs.join(', ')}]` : ''
  const buildDecl = buildSources?.length ? `  const ${buildRef(ctx)} = [${buildSources.join(', ')}]` : ''
  const namedPrelude = ctx.namedFnDecls.length > 0 ? namedFnPrelude() : []
  const hoistedDecls = [
    ctx.needsEmptyTl ? `  const _EMPTY_TL = Object.freeze([])` : '',
    ctx.needsHostReads ? `  ${HOST_READS_DECL}` : '',
    ctx.needsRawEntry ? `  ${RAW_ENTRY_DECL}` : '',
    ctx.needsLineTrack ? `  ${LINE_TRACK_DECL}` : '',
    ctx.needsLineSpan ? `  ${LINE_SPAN_DECL}` : '',
    ...ctx.regexDecls.map(d => `  ${d}`),
    ...ctx.expectedDecls.map(d => `  ${d}`),
    mfDecl,
    buildDecl,
    ...namedPrelude.map(l => `  ${l}`),
    ...ctx.namedFnDecls.flatMap((decl, i) => {
      const lines = decl.split('\n').map(l => `  ${l}`)
      return i > 0 ? ['', ...lines] : lines
    }),
  ].filter(Boolean)

  const entryRuleId = (rule: Combinator<unknown>): string | undefined => {
    const direct = ctx.coverage?.plan.rules.get(rule)
    if (direct !== undefined || rule._def.tag !== 'lazy') return direct
    try { return ctx.coverage?.plan.rules.get(rule._def.thunk()) } catch { return undefined }
  }
  const entryFnText = (r: ER, rule: Combinator<unknown>): string => {
    const ruleId = entryRuleId(rule)
    const linePreamble = ctx.lineTracking
      ? [
          `  if (_ctx._lineStarts === undefined) _ctx = { ..._ctx, trackLines: true, _lineStarts: [0], _lineScannedTo: 0 }`,
          `  else _ctx.trackLines = true`,
          `  if (_pos > (_ctx._lineScannedTo ?? 0)) _trackLines(_ctx, input, 0, _pos)`,
        ]
      : []
    const resultSpan = ctx.lineTracking ? `_spanLines(_ctx, _pos, ${r.endVar})` : `{ start: _pos, end: ${r.endVar} }`
    const body = ruleId === undefined
      ? [
          ...linePreamble,
          `  let pos = _pos`,
          ...r.stmts,
          `  return { ok: true, value: ${r.valueVar}, span: ${resultSpan} }`,
        ]
      : [
          ...linePreamble,
          `  const _coverageResult = (() => {`,
          `    let pos = _pos`,
          ...r.stmts,
          `    return { ok: true, value: ${r.valueVar}, span: ${resultSpan} }`,
          `  })()`,
          `  if (!_coverageResult.ok) _ctx._grammarTrace?.write({ id: ${JSON.stringify(ruleId)}, phase: 'failure', offset: _coverageResult.span.start })`,
          `  return _coverageResult`,
        ]
    return [`function(input, _pos, _ctx) {`, ...body, `}`].join('\n')
  }

  // One shared IIFE, evaluated ONCE, returning the whole `{ key: fn, ... }`
  // map — this whole string is the caller's replacement for the entire
  // `rules(factory)` call-expression (NOT one expression per key spliced into
  // a separately-built object literal, which would either re-run the shared
  // prelude per entry or duplicate its text per entry — both defeat the point).
  const objBody = perEntry
    .map(({ key, rule, r }) => {
      const src = publicRuleWrapperSource(rule, entryFnText(r, rule), ctx.triviaKindLabels, ctx.rootTriviaClassified)
      return `    ${JSON.stringify(key)}: ${src.split('\n').join('\n    ')}`
    })
    .join(',\n')
  const replacement = [
    `/* @__PURE__ */ (() => {`,
    ...hoistedDecls,
    `  return {`,
    objBody,
    `  }`,
    `})()`,
  ].join('\n')

  return {
    keys: perEntry.map(e => e.key),
    replacement,
    // Reported so the MACRO can stamp the emitted map, exactly as `fusedBody` stamps a
    // fused one. Without it a `rules()` artifact carries no mode and every driver-side
    // host check passes vacuously — see `withHostMode` in the plugin.
    hostMode: ctx.hostMode ?? 'ast',
    hostBranchElided: !!ctx.hostBranchElided,
    reflection: collectGrammarReflection(ruleMap),
    ...(ctx.coverage === undefined ? {} : { coverageDefinitions: ctx.coverage.plan.definitions }),
  }
}

/**
 * The linkable form of a rule map (RULE_ABI_PLAN §3): the same compiled rule
 * bodies as `compileRuleMap`, but returned as **splice-able pieces** under a
 * namespace `ns` so multiple independently-compiled maps fuse into one scope
 * (see `fuseRules`). `ns` MUST be non-empty and unique per artifact (the caller
 * derives it — module identity in the macro, a counter in `compile()`).
 *
 *   prelude  — namespaced hoisted decls (regexes, expected, `_mf`/`_build`, and
 *              private `_pf` helper fns). Sentinels / `_EMPTY_TL`
 *              are NOT here — they are SHARED, emitted once by the linker.
 *   ruleFns  — name → `function _r_<Name>(…) { … }` source (the composition
 *              surface; siblings call these by name).
 *   wrappers — name → public `(input,pos,ctx) => ParseResult` wrapper source.
 *   deps     — name → referenced rule names (from `ruleDependencies`).
 *
 * Returns null on the same "can't inline" conditions as `compileRuleMap`.
 */
export type LinkablePieces = {
  /**
   * The parseman version that produced this artifact (the ARTIFACT VERSION LOCK; see
   * `src/version.ts`). REQUIRED — `compileLinkable` always stamps it. `fusedBody`
   * refuses to link a piece whose stamp differs from the linking parseman OR is absent
   * (a stale pre-invariant artifact, whose recipe/pieces shape is unsupported).
   * Artifacts are version-locked; the format carries no cross-version back-compat.
   */
  v: string
  ns: string
  keys: string[]
  prelude: string[]
  ruleFns: Map<string, string>
  wrappers: Map<string, string>
  /**
   * Per-rule first-set (this artifact's own rules). fusedBody() uses the WINNING
   * artifact's entry to resolve `/*@FS:rule:codevar@*​/true` dispatch placeholders
   * emitted for rule-ref choice arms — sound under compose override.
   */
  firstSets: Map<string, FirstSet>
  /**
   * Per-rule nullability (does the rule match the empty string?). `fusedBody()`
   * reads it when resolving an ordered-chain recipe segment that REFERENCES this
   * rule: a non-nullable ref terminates the leading chain (stop unioning the tail),
   * a nullable one lets it continue. Optional/absent → treated as nullable (the safe
   * default: keep unioning, never drop a valid first char).
   */
  nullable?: Map<string, boolean>
  /**
   * Per-rule LEADING first-set recipe — a union of ordered leading-term chains.
   * `fusedBody()` fixpoint-resolves the leading ref names over the WINNING rules so a
   * `sequence(ref, …)`-led arm/node dispatches on the ref's real first char —
   * matching a monolithic compile — instead of degrading to always-try because the
   * ref baked `any`. Optional (absent for hand-built pieces → `any`, always try).
   */
  firstSetRecipes?: Map<string, FirstSetRecipe>
  deps: Map<string, string[]>
  needsEmptyTl: boolean
  needsHostReads: boolean
  needsRawEntry: boolean
  /** Compile-time host mode this piece was lowered for ('ast' when absent). */
  hostMode?: HostMode
  /** Set when a direct builder's positioned-CST branch was omitted. */
  hostBranchElided?: boolean
  /** True when this piece contains any direct `node(..., build)` reduction. */
  hasDirectBuilders?: boolean
  /** True only when this piece has no direct builder or callback-based semantics. */
  isRecognitionOnly?: boolean
  /** Per-rule CST node reflection for grammar-aware visitors. */
  nodeMeta: Map<string, GrammarReflection>
  /**
   * Transform (`_mf`) / build (`_build`) callback FUNCTIONS, injected into the
   * fused scope via `_env` when their SOURCE isn't available (runtime `compile()`
   * mode). Empty when the callbacks were inlined from source (macro mode). Keyed
   * for `_env` as `<ns>mf` / `<ns>build`.
   */
  mfFns: ReadonlyArray<(...args: unknown[]) => unknown>
  buildFns: ReadonlyArray<(...args: unknown[]) => unknown>
}


export function compileLinkable(
  ruleMapArg: ReadonlyArray<readonly [string, Combinator<unknown>]>,
  ns: string,
  opts?: { trivia?: Combinator<unknown>; scanSkip?: Combinator<unknown>[]; recovery?: boolean; hostMode?: HostMode; trackLines?: boolean; captureTerminals?: boolean; coverage?: GrammarCoveragePlan; duplication?: DuplicationOption; maxInline?: number },
): LinkablePieces | null {
  if (!ns) throw new Error('compileLinkable: ns must be a non-empty namespace')
  // Opt-IN only. Duplication defaults to
  // `'off'`, but the level ALSO resolves from `PARSEMAN_DUPLICATION` — so without
  // this guard, setting that env var printed every structural finding twice on the
  // macro path, which lowers the same map through `compileRuleMap`/`compile` and
  // then again here. Structural findings do not depend on fuse-time binding, so the
  // owning site's run is the complete one; this one would only ever be a duplicate.
  if (opts?.duplication !== undefined) runDuplicationDiagnosticRules(ruleMapArg, opts.duplication)
  for (const [, rule] of ruleMapArg) markUnusedValues(rule)
  // Grammar-level ambient trivia through compose(): a piece from rules({ trivia },
  // …) tags `grammarTrivia` on its rules (runtime path), or the macro threads it via
  // `opts.trivia`. Seed it as the default activeTrivia so every fused rule bakes it —
  // the compose mirror of compileRuleMap's seed. `parser`/`noTrivia` still override.
  const grammarTrivia = opts?.trivia
    ?? ruleMapArg.map(([, r]) => (r._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia).find(Boolean)
  const rootTriviaClassified = grammarTrivia?._meta.rootTriviaClassified === true
    || ruleMapArg.some(([, rule]) => rule._meta.rootTriviaClassified === true)
  // Grammar-level ambient scan-skip through compose(), mirroring grammarTrivia.
  const grammarScanSkip = opts?.scanSkip
    ?? ruleMapArg.map(([, r]) => (r._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip).find(Boolean)
  // Grammar-level host mode through compose()/linkable(), mirroring the two above.
  const grammarHostMode = opts?.hostMode
    ?? ruleMapArg.map(([, r]) => (r._meta as { grammarHostMode?: HostMode }).grammarHostMode).find(Boolean)
  const grammarTrackLines = opts?.trackLines === true
    || ruleMapArg.some(([, r]) => r._meta.grammarTrackLines === true)
  // Drop EXTERNAL entries: `rules(g => …)` returns a cache that also holds every
  // `g.X` that was ACCESSED, so an accessed-but-not-defined rule (defined in
  // another artifact) leaks into `Object.entries` as an undefined `ref`. Those
  // are not local rules — they're by-name references resolved at fuse time (the
  // pre-scan below emits their calls). A rule is local iff its value is non-lazy
  // or a `ref` that resolves.
  const ruleMap = ruleMapArg.filter(([, val]) => {
    const d = val._def
    if (d.tag !== 'lazy') return true
    try { d.thunk(); return true } catch { return false }
  })
  const nodeMeta = new Map(ruleMap.map(([name, rule]) => [name, collectGrammarReflection([[name, rule]], { followLazy: false })]))
  const _inlineMax = resolveInlineMax(opts?.maxInline)
  const ctx: Ctx = {
    vars: 0, indent: 1, inlineMax: _inlineMax, inlineLeft: _inlineMax, regexDecls: [], regexMap: new Map(),
    expectedDecls: [], expectedMap: new Map(), recordFail: true,
    mapFns: [], mapFnSrcs: [], buildFns: [], buildSrcs: [], runtimeParsers: [],
    namedParsers: new Map(), triviaCaptureNames: new Map(),
    triviaFnNames: new Map(), namedFnDecls: [],
    // A recognition-only fragment normally has no node collector of its own.
    // Leaf composition can re-lower it beneath a local semantic node, though;
    // in that case its terminals must feed the caller's collector rather than
    // merely returning their scalar parse values.
    capturing: opts?.captureTerminals === true || ruleMap.some(([, rule]) => hasNodeDef(rule)),
    recovery: opts?.recovery ?? false,
    hostMode: grammarHostMode ?? 'ast',
    lineTracking: grammarTrackLines,
    ...(opts?.coverage ? { coverage: { plan: opts.coverage } } : {}),
    lazyUsage: analyzeLazyUsageMulti(ruleMap.map(([, rule]) => rule)),
    ns,
    deferFirstSetRefs: true,
    ...(rootTriviaClassified ? { rootTriviaClassified: true as const } : {}),
    ...(grammarTrivia ? {
      activeTrivia: grammarTrivia,
      triviaKindLabels: grammarTrivia._meta.triviaKindLabels,
    } : {}),
    ...(grammarScanSkip ? { activeScanSkip: grammarScanSkip } : {}),
  }
  // Canonical name per rule. Register in BOTH ruleNames (so sibling `emitLazy`
  // refs resolve by name) AND namedParsers up-front (so a rule emitted before a
  // recursive back-edge still finds itself). Unlike `compileRuleMap`, EVERY rule
  // is force-emitted as a named fn — even one referenced by nobody but its own
  // entry (its map value is the bare combinator, not a `ref`, so it would
  // otherwise inline and never get a name).
  const seen = new Map<string, number>()
  const ruleNames = new Map<Combinator<unknown>, string>()
  const fnNameToKey = new Map<string, string>()
  for (const [key, rule] of ruleMap) {
    assertRuleName(key)
    const base = `_r_${key}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const fn = n === 0 ? base : `${base}$${n}`
    ruleNames.set(rule, fn)
    fnNameToKey.set(fn, key)
  }
  ctx.ruleNames = ruleNames

  // Pre-register EXTERNAL rule references: a named `ref` placeholder that doesn't
  // resolve locally (defined in ANOTHER artifact). Emit a by-name `_r_<Name>`
  // call for it — no body here; it's provided at fuse time. This is what lets a
  // fragment reference a consumer/base rule (`g.value`, `g.Digits`) without its
  // source. `externalRefs` collects what the pass CLASSIFIED — the refs that will be
  // bound by name at fuse time — which `hasSemanticReduction` reads (see there).
  const externalRefs = new Set<Combinator<unknown>>()
  {
    const scanned = new Set<Combinator<unknown>>()
    const scanExternal = (p: Combinator<unknown>): void => {
      if (scanned.has(p)) return
      scanned.add(p)
      const def = p._def
      if (def.tag === 'lazy') {
        let resolved: Combinator<unknown> | undefined
        try { resolved = def.thunk() } catch { resolved = undefined }
        if (resolved === undefined) {
          const name = (p as unknown as { _ruleName?: string })._ruleName
          if (name) {
            externalRefs.add(p)
            if (!ctx.namedParsers.has(p)) {
              assertRuleName(name)
              const fn = `_r_${name}`
              ruleNames.set(p, fn)
              ctx.namedParsers.set(p, fn)
            }
          }
          return
        }
        scanExternal(resolved)
        return
      }
      for (const child of childrenOf(def)) scanExternal(child)
    }
    for (const [, rule] of ruleMap) scanExternal(rule)
  }

  // Emit each rule's body as its `_r_<Name>` fn (resolving a `ref` placeholder to
  // its target), then build a public wrapper that calls it.
  const perEntry: Array<{ key: string; rule: Combinator<unknown>; r: ER }> = []
  for (const [key, rule] of ruleMap) {
    const fn = ruleNames.get(rule)!
    if (!ctx.namedParsers.has(rule)) {
      ctx.namedParsers.set(rule, fn)
      let resolved: Combinator<unknown> = rule
      const def = rule._def
      if (def.tag === 'lazy') {
        try { resolved = def.thunk() } catch { return null }
      }
      const savedIndent = ctx.indent, savedFail = ctx.failLabel, savedRec = ctx.recordFail
      const savedInlineLeft = ctx.inlineLeft, savedFnName = ctx.currentFnName
      ctx.inlineLeft = ctx.inlineMax; ctx.currentFnName = fn
      ctx.indent = 1; ctx.failLabel = '_pfail'; ctx.recordFail = true
      // A trivia rule must never carry the ambient trivia (it would recursively
      // skip trivia within itself). Mirrors compileRuleMap's guard.
      const savedTrivia = ctx.activeTrivia
      const savedScanSkip = ctx.activeScanSkip
      if (rule._meta.isTrivia) { ctx.activeTrivia = undefined; ctx.activeScanSkip = undefined }
      const body = emit(resolved, ctx, '_pos')
      ctx.activeTrivia = savedTrivia
      ctx.activeScanSkip = savedScanSkip
      ctx.indent = savedIndent; ctx.failLabel = savedFail; ctx.recordFail = savedRec
      ctx.inlineLeft = savedInlineLeft; ctx.currentFnName = savedFnName
      // Linkable entries run through their named rule body rather than the
      // public compileRuleMap wrapper. Instrument the named boundary itself so
      // a final compose winner remains observable even when its resolved body
      // is emitted under a different identity.
      const ruleId = ctx.coverage?.plan.rules.get(rule)
      const stmts = ruleId === undefined ? body.stmts : [
        `${ind(ctx)}_ctx._grammarCoverage?.(${JSON.stringify(ruleId)})`,
        `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(ruleId)}, phase: 'enter', offset: _pos })`,
        ...body.stmts,
        `${ind(ctx)}_ctx._grammarTrace?.write({ id: ${JSON.stringify(ruleId)}, phase: 'success', offset: _pos, end: ${body.endVar} })`,
      ]
      pushNamedFnDecl(ctx, fn, stmts, body.valueVar, body.endVar)
    }
    // Public wrapper: call the named fn, adapt sentinel → ParseResult.
    perEntry.push({ key, rule, r: emitNamedFnCall(ctx, fn, '_pos') })
  }

  // A runtime-parser fallback can't be fused (no source AND no stable identity to
  // inject). Callback fns, by contrast, ARE fusable — inline their source when
  // available (macro), else inject the fn objects via `_env` (runtime).
  if (ctx.runtimeParsers.length !== 0) return null
  if (ctx.lineTracking) {
    ctx.needsLineTrack = true
    ctx.needsLineSpan = true
  }
  const mfSrcs = ctx.mapFns.length > 0 && ctx.mapFnSrcs.every((s): s is string => s !== null)
    ? ctx.mapFnSrcs as string[] : null
  const buildSrcs = ctx.buildFns.length > 0 && ctx.buildSrcs.every((s): s is string => s !== null)
    ? ctx.buildSrcs as string[] : null

  // Split named fns: `_r_<Name>` are the composition surface (ruleFns), everything
  // else (`_ns_pf…` private helpers) is private prelude bundled with the artifact.
  const ruleFns = new Map<string, string>()
  const privateFns: string[] = []
  for (const decl of ctx.namedFnDecls) {
    const fnName = decl.match(/^function (\S+?)\(/)?.[1]
    const key = fnName ? fnNameToKey.get(fnName) : undefined
    if (key !== undefined) ruleFns.set(key, decl)
    else privateFns.push(decl)
  }

  const mfDecl = ctx.mapFns.length === 0 ? ''
    : mfSrcs ? `const ${mfRef(ctx)} = [${mfSrcs.join(', ')}]`
    : `const ${mfRef(ctx)} = _env[${JSON.stringify(nsp(ctx) + 'mf')}]`
  const buildDecl = ctx.buildFns.length === 0 ? ''
    : buildSrcs ? `const ${buildRef(ctx)} = [${buildSrcs.join(', ')}]`
    : `const ${buildRef(ctx)} = _env[${JSON.stringify(nsp(ctx) + 'build')}]`
  const prelude = [
    ctx.needsLineTrack ? LINE_TRACK_DECL : '',
    ctx.needsLineSpan ? LINE_SPAN_DECL : '',
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    mfDecl,
    buildDecl,
    ...privateFns,
  ].filter(Boolean)

  const wrappers = new Map<string, string>()
  for (const { key, rule, r } of perEntry) {
    const linePreamble = ctx.lineTracking
      ? [
          `  if (_ctx._lineStarts === undefined) _ctx = { ..._ctx, trackLines: true, _lineStarts: [0], _lineScannedTo: 0 }`,
          `  else _ctx.trackLines = true`,
          `  if (_pos > (_ctx._lineScannedTo ?? 0)) _trackLines(_ctx, input, 0, _pos)`,
        ]
      : []
    const resultSpan = ctx.lineTracking ? `_spanLines(_ctx, _pos, ${r.endVar})` : `{ start: _pos, end: ${r.endVar} }`
    wrappers.set(key, publicRuleWrapperSource(rule, [
      `function(input, _pos, _ctx) {`,
      ...linePreamble,
      `  let pos = _pos`,
      ...r.stmts,
      `  return { ok: true, value: ${r.valueVar}, span: ${resultSpan} }`,
      `}`,
    ].join('\n'), ctx.triviaKindLabels, ctx.rootTriviaClassified))
  }

  // Per-rule first-set table for fuse-time dispatch: fusedBody() substitutes each
  // `/*@FS:rule:codevar@*​/true` placeholder (emitted for rule-ref choice arms)
  // with the WINNING rule's condition. Resolve each rule to its real first-set;
  // a rule that can match empty at start gets `any` (→ no guard, always try).
  const firstSets = new Map<string, FirstSet>()
  const firstSetRecipes = new Map<string, FirstSetRecipe>()
  // Per-rule nullability (does the whole rule match empty?) — fusedBody reads it to
  // decide whether an ordered-chain segment that is a REF to this rule terminates the
  // chain (non-nullable → stop unioning the tail) or lets it continue (nullable).
  const nullable = new Map<string, boolean>()
  for (const [key, rule] of ruleMap) {
    let resolved: Combinator<unknown> = rule
    const d = rule._def
    if (d.tag === 'lazy') { try { resolved = d.thunk() } catch { resolved = rule } }
    firstSets.set(key, canMatchEmptyAtStart(resolved) ? { kind: 'any' } : resolved._meta.firstSet)
    nullable.set(key, matchesEmpty(resolved))
    // Recipe drives fuse-time dispatch: keep leading ref names unresolved so the
    // WINNING rule (post-override) supplies their first char. An empty-at-start
    // rule stays `any` (always try).
    firstSetRecipes.set(key, canMatchEmptyAtStart(resolved) ? { alts: [[{ set: any(), nullable: false }]] } : leadingFirstSetRecipe(resolved))
  }

  return {
    v: PARSEMAN_VERSION,
    ns,
    keys: perEntry.map(e => e.key),
    prelude,
    ruleFns,
    wrappers,
    firstSets,
    nullable,
    firstSetRecipes,
    deps: ruleDependencies(ruleMap),
    needsEmptyTl: !!ctx.needsEmptyTl,
    needsHostReads: !!ctx.needsHostReads,
    needsRawEntry: !!ctx.needsRawEntry,
    hostMode: ctx.hostMode ?? 'ast',
    hostBranchElided: !!ctx.hostBranchElided,
    hasDirectBuilders: ruleMap.some(([, rule]) => hasDirectBuildDef(rule)),
    isRecognitionOnly: !hasSemanticReduction(ruleMap.map(([, rule]) => rule), externalRefs),
    nodeMeta,
    mfFns: mfSrcs ? [] : (ctx.mapFns as ReadonlyArray<(...a: unknown[]) => unknown>),
    buildFns: buildSrcs ? [] : (ctx.buildFns as ReadonlyArray<(...a: unknown[]) => unknown>),
  }
}

/**
 * Does this rule map reference a rule it doesn't define — a NAMED `ref` (`g.Foo`)
 * that never got `.define()`d? That is the SHARED-SHAPE signature: the grammar is a
 * shape with a hole, so it can't be inlined as a standalone parser, but it IS
 * linkable (`compileLinkable` emits a by-name `_r_Foo` call for the hole, bound at
 * fuse time). Callers use this to tell that case apart from a genuine
 * "couldn't compile, fall back to the interpreter".
 *
 * A `rules()` map's own `Object.entries` also leaks accessed-but-undefined names as
 * top-level entries, so both the entry values AND their bodies are scanned.
 */
export function hasExternalRuleRef(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): boolean {
  const seen = new Set<Combinator<unknown>>()
  const visit = (p: Combinator<unknown>): boolean => {
    if (seen.has(p)) return false
    seen.add(p)
    const def = p._def
    if (def.tag === 'lazy') {
      let resolved: Combinator<unknown> | undefined
      try { resolved = def.thunk() } catch { resolved = undefined }
      if (resolved === undefined) return (p as unknown as { _ruleName?: string })._ruleName !== undefined
      return visit(resolved)
    }
    return childrenOf(def).some(visit)
  }
  return ruleMap.some(([, rule]) => visit(rule))
}

/** A leaf-composed imported piece may carry Parseman's own structural balanced
 * text reconstruction, but never a grammar-authored semantic callback.
 *
 * `externalRefs` are the unresolved NAMED refs `compileLinkable`'s pre-pass already
 * classified as external (`g.Value` naming a rule this artifact doesn't define). They
 * are the one case that fails OPEN: the ref is a HOLE, it holds no callback of its
 * own, and codegen emits it as a by-name `_r_<Name>` call bound at fuse time by
 * whichever piece supplies the name — either another pre-final piece (itself put
 * through this same gate) or the local leaf (allowed to be semantic by design). So
 * an artifact whose only "unknown" is a hole is genuinely recognition-only.
 *
 * EVERY other lazy failure still fails CLOSED. In particular an UNNAMED `ref()` that
 * was never `.define()`d is NOT external — nobody can bind it by name — so it stays
 * an opaque subtree of unknown semantics and the answer is "semantic". Catching all
 * errors here instead would let that (and any future thunk failure) pass the
 * recognition-only gate. */
function hasSemanticReduction(
  roots: readonly Combinator<unknown>[],
  externalRefs?: ReadonlySet<Combinator<unknown>>,
): boolean {
  const seen = new Set<Combinator<unknown>>()
  const visit = (parser: Combinator<unknown>): boolean => {
    if (seen.has(parser)) return false
    seen.add(parser)
    const def = parser._def
    if (def.tag === 'transform' && !def.recognitionOnly) return true
    if (def.tag === 'choice' && def.gates.some(Boolean)) return true
    if (def.tag === 'guard' || def.tag === 'withCtx') return true
    if (def.tag === 'node' && def.build !== undefined) return true
    if (def.tag === 'lazy') {
      if (externalRefs?.has(parser)) return false
      try { return visit(def.thunk()) } catch { return true }
    }
    return childrenOf(def).some(visit)
  }
  return roots.some(visit)
}

function buildInlineExpression(
  ctx: Ctx,
  r: ER,
  mapFnSources?: string[],
  buildSources?: string[],
  coverageRootRuleId?: string,
): string {
  const bodyLines = coverageRootRuleId === undefined
    ? [
        `  let pos = _pos`,
        ...r.stmts,
        `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
      ]
    : [
        `  const _coverageResult = (() => {`,
        `    let pos = _pos`,
        ...r.stmts,
        `    return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
        `  })()`,
        `  if (!_coverageResult.ok) _ctx._grammarTrace?.write({ id: ${JSON.stringify(coverageRootRuleId)}, phase: 'failure', offset: _coverageResult.span.start })`,
        `  return _coverageResult`,
      ]

  const innerFn = [
    `function(input, _pos, _ctx) {`,
    ...bodyLines,
    `}`,
  ].join('\n')

  // Declare _mf / _build inline so the emitted _mf[i] / _build[i] references
  // resolve without runtime closure arrays.
  const mfDecl = mapFnSources?.length ? `  const _mf = [${mapFnSources.join(', ')}]` : ''
  const buildDecl = buildSources?.length ? `  const _build = [${buildSources.join(', ')}]` : ''

  const emptyTlDecl = ctx.needsEmptyTl ? `  const _EMPTY_TL = Object.freeze([])` : ''
  const hostReadsDecl = ctx.needsHostReads ? `  ${HOST_READS_DECL}` : ''
  const rawEntryDecl = ctx.needsRawEntry ? `  ${RAW_ENTRY_DECL}` : ''
  const lineTrackDecl = ctx.needsLineTrack ? `  ${LINE_TRACK_DECL}` : ''
  const lineSpanDecl = ctx.needsLineSpan ? `  ${LINE_SPAN_DECL}` : ''
  const needsWrapper = ctx.regexDecls.length > 0 || ctx.expectedDecls.length > 0 || ctx.namedFnDecls.length > 0 || !!mfDecl || !!buildDecl || !!emptyTlDecl || !!hostReadsDecl || !!rawEntryDecl || !!lineTrackDecl || !!lineSpanDecl
  if (!needsWrapper) return innerFn

  const namedPrelude = ctx.namedFnDecls.length > 0 ? namedFnPrelude() : []
  const hoistedDecls = [
    emptyTlDecl,
    hostReadsDecl,
    rawEntryDecl,
    lineTrackDecl,
    lineSpanDecl,
    ...ctx.regexDecls.map(d => `  ${d}`),
    ...ctx.expectedDecls.map(d => `  ${d}`),
    mfDecl,
    buildDecl,
    ...namedPrelude.map(l => `  ${l}`),
    ...ctx.namedFnDecls.flatMap((decl, i) => {
      const lines = decl.split('\n').map(l => `  ${l}`)
      return i > 0 ? ['', ...lines] : lines
    }),
  ].filter(Boolean)
  return [
    `/* @__PURE__ */ (() => {`,
    ...hoistedDecls,
    `  return ${innerFn}`,
    `})()`,
  ].join('\n')
}
