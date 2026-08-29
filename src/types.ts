export type Span = {
  start: number
  end: number
  startLine?: number
  startColumn?: number
  endLine?: number
  endColumn?: number
}

export type ParseOk<T> = {
  ok: true
  value: T
  span: Span
  trivia?: Span[]
  /** Populated when parse() is called with { recover: true }. Lists all ParseErrors collected via recover() nodes. */
  errors?: ParseError[]
  /**
   * Populated when parse() is called with { recover: true }. The furthest-position
   * failure seen during the parse (with expected-sets merged across ties) — the
   * standard "this is where it actually got stuck" diagnostic, meaningful even when
   * the parse otherwise succeeds with unconsumed trailing input.
   */
  furthestFail?: ParseFail | null
}

export type ParseFail = {
  ok: false
  expected: string[]
  span: Span
  /**
   * Framework-internal cut/commit signal. A committed failure means an outer
   * backtracking construct must propagate the failure instead of trying a later
   * alternative or swallowing it as an optional/repeat miss.
   */
  committed?: boolean
}

export type ParseResult<T> = ParseOk<T> | ParseFail

// ---------------------------------------------------------------------------
// Combinator definition tree — carried on every Combinator so the compiler can
// traverse the full combinator structure without re-parsing source.
// ---------------------------------------------------------------------------
export type ParserDef =
  | { tag: 'literal';   value: string; caseInsensitive: boolean }
  | { tag: 'regex';     source: string; flags: string }
  // `valueUnused` (set by markUnusedValues): the container's aggregate value is
  // consumed by nothing but capture (it sits directly under a node() that reads
  // children, not this value). When true, the interpreter and codegen skip
  // building the array/tuple — the elements still parse + self-capture.
  | { tag: 'sequence';  parsers: Combinator<unknown>[]; valueUnused?: boolean }
  // `gateSrcs` (set by the macro evaluator): per-arm gate predicate SOURCE TEXT,
  // aligned by arm index (null for an ungated arm). Lets codegen inline the gate
  // into the macro's `_mf` array instead of pushing a `null` source (which would
  // force interpreter fallback). Absent under runtime compile() — the real gate
  // closures live in `gates`.
  | { tag: 'choice';    parsers: Combinator<unknown>[]; gates: (((state: unknown) => boolean) | null)[]; gateSrcs?: (string | null)[]; disjoint: boolean; strategy: ChoiceStrategy; autoNot: (AutoNotCheck[] | null)[] }
  | { tag: 'dispatch';  selector: Combinator<string>; cases: readonly DispatchCase[]; matchers?: readonly DispatchMatcherCase[] | undefined; otherwise?: Combinator<unknown> | undefined; otherwiseUsesRouted?: boolean | undefined }
  | { tag: 'attempt';   parser: Combinator<unknown> }
  // The TAG carries NULLABILITY (what every downstream switch keys on): `many` is
  // the nullable min-0 repeat, `oneOrMore` the non-nullable min>=1 one. `min`/`max`
  // carry the actual ITEM bounds (`many(x, { min: 3, max: 8 })` is a `oneOrMore`
  // def with `min: 3, max: 8`). `max` absent = unbounded.
  | { tag: 'many';      parser: Combinator<unknown>; min: 0; max?: number; valueUnused?: boolean }
  | { tag: 'oneOrMore'; parser: Combinator<unknown>; min: number; max?: number; valueUnused?: boolean }
  | { tag: 'optional';  parser: Combinator<unknown> }
  // `min`/`max` count ITEMS, not separators. `min: 0` (the default) is
  // `(item (sep item)*)?` — NULLABLE, matches the empty string. `min >= 1` is
  // non-nullable with first-set = the item's, so it gates as a choice arm.
  // `trailing` governs a separator with no item after it: 'forbid' (default) leaves
  // it unconsumed, 'allow' consumes it. There is no "one after every item" mode —
  // that is a terminated list, spelled `many(sequence(item, term))`.
  | { tag: 'sepBy';     parser: Combinator<unknown>; separator: Combinator<unknown>; min: number; max?: number; trailing?: 'allow'; /** Author opted in via `keepSeparator()`: separators stay in `children`. Absent = items only. */ keepSeparators?: true }
  | { tag: 'transform'; parser: Combinator<unknown>; fn: (v: unknown, span: { start: number; end: number }) => unknown; fnSrc?: string; recognitionOnly?: boolean }
  | { tag: 'trivia';    parser: Combinator<unknown> }
  | { tag: 'token';     parser: Combinator<unknown> }
  // `fallback` is what `routed()` parses IN PLACE when there is no dispatch-consumed
  // token to reuse (outside a dispatch branch, or at a position other than the one the
  // selector matched). It exists so ONE production can serve both contexts instead of
  // being spelled twice — a `routed()` twin and a concrete-lead original.
  | { tag: 'routed';    fallback?: Combinator<unknown> }
  | { tag: 'leaf';      parser: Combinator<unknown>; fn: (v: unknown, span: { start: number; end: number }) => unknown; fnSrc?: string }
  | { tag: 'label';     label: string; parser: Combinator<unknown> }
  | { tag: 'field';     name: string; parser: Combinator<unknown> }
  | { tag: 'grammar';   parser: Combinator<unknown>; triviaParser: Combinator<unknown> | undefined; clearTrivia?: boolean; captureTrivia?: boolean; rootCapture?: 'opaque'; trackLines: boolean; constructionTrackLines?: 'on' | 'off' | 'inherit'; constructionCaptureTriviaKinds?: readonly string[] }
  | { tag: 'lazy';     thunk: () => Combinator<unknown> }
  | { tag: 'not';      parser: Combinator<unknown> }
  // Positive lookahead. Zero-width like `not`, but — unlike `not` — it KNOWS what
  // it requires, so it carries `parser`'s first-set and a leading `peek()` gates
  // its choice arm (see `isPositiveLookahead` / `sequenceFirstSet`).
  | { tag: 'peek';    parser: Combinator<unknown> }
  | { tag: 'node';     type?: string; parser: Combinator<unknown>; build?: ((children: ReadonlyArray<unknown>, fields: FieldMap | undefined, span: { start: number; end: number }, rawChildren: ReadonlyArray<unknown>, triviaLog: readonly number[], state: unknown) => unknown) | undefined; buildSrc?: string; /** The IDENTIFIER the type argument was written as at the `node()` call site, when it was a plain identifier rather than a literal — ANALYSIS ONLY, never emitted. Lets the inline-`mk` matcher recognise `node(t, …, (…) => mk(t, …))` from a factory, where the two `t`s are provably one binding. */ typeSrc?: string; /** Resolved source of a NAMED `buildSrc` — ANALYSIS ONLY, never emitted. See `buildAnalysisSrc`. */ buildSigSrc?: string; /** Macro analysis proved the fourth formal (`rawChildren`) unreferenced. Never inferred from an author-declared `buildArity`; carried through composed IR. */ buildRawUnused?: true; /** Declared positional arity of `build`: author-declared via `node(..., { buildArity })`, or resolved from the reducer's declaration. Wins over source inspection. */ buildArity?: number; /** Why arity could not be resolved, for the diagnostic. */ buildArityUnresolved?: string; buildStaticError?: readonly string[]; /** Import provenance for a direct builder's free names — each `{ local, source, imported }` lets a downstream compose() re-emit `import { imported as local } from source` so the inlined builder source can bind. Carried through the IR round-trip. */ buildImports?: ReadonlyArray<{ local: string; source: string; imported: string }>; unwrap?: boolean; collapse?: boolean; project?: number; captureTrivia?: boolean; trailingTrivia?: boolean; tags?: readonly string[] }
  // `predSrc`/`extraSrc` (set by the macro evaluator): SOURCE TEXT of the guard
  // predicate / the withCtx `extra` value, so codegen inlines them into `_mf`
  // rather than pushing a `null` source. Absent under runtime compile() (the real
  // closures/values live in `predicate`/`extra`).
  | { tag: 'guard';    predicate: (state: unknown) => boolean; predSrc?: string }
  // ADJACENCY assertion — zero-width, zero-children. `polarity: 'adjacent'` asserts
  // that NOTHING sat between the previous term and this position; `'notAdjacent'`
  // asserts that something did. `kinds` (notAdjacent only) narrows the assertion to
  // trivia CATEGORIES from `classifiedTrivia({...})`. See combinators/adjacency.ts.
  | { tag: 'adjacency'; polarity: 'adjacent' | 'notAdjacent'; kinds?: readonly string[] }
  | { tag: 'withCtx';  extra: unknown; parser: Combinator<unknown>; extraSrc?: string }
  | { tag: 'recover';  parser: Combinator<unknown>; sentinel: Combinator<unknown> }
  | { tag: 'expect';   parser: Combinator<unknown>; label: string | undefined; expected: string[] }
  // `skip` is the per-call opaque-unit list; ambient trivia + grammar-level
  // `scanSkip` are PREPENDED at parse/compile time (explicit skip EXTENDS the
  // ambient default). `raw`: hard opt-out — skip nothing ambiently, restoring the
  // pre-ambient raw byte-walk.
  | { tag: 'scanTo';   sentinel: Combinator<unknown>; skip: Combinator<unknown>[]; raw: boolean; orEOF: boolean }
  | { tag: 'keywords'; words: readonly string[]; caseInsensitive: boolean; boundary: string | undefined }
  | { tag: 'unknown' }

export type Combinator<T> = {
  readonly _tag: string
  readonly _meta: ParserMeta
  readonly _def: ParserDef
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>
}

export type DispatchCase = {
  keys: readonly string[]
  parser: Combinator<unknown>
  caseInsensitive: boolean
  usesRouted?: boolean | undefined
}

export type DispatchMatcherKind = 'startsWith' | 'endsWith' | 'matches'

export type DispatchMatcherCase = {
  kind: DispatchMatcherKind
  value: string
  flags?: string | undefined
  parser: Combinator<unknown>
  caseInsensitive: boolean
  usesRouted?: boolean | undefined
}

import type { CstCaptureBuf } from './cst/capture-buffer.ts'

export type CstCollapsePredicate = (
  type: string,
  child: unknown,
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
) => boolean

export type BuildHost = ((
  type: string,
  // Always an array by public contract. When a structural host opts out of the
  // duplicate children collector via `_parsemanReadsChildren === false`, it
  // receives the shared empty array while `rawChildren` retains the full source
  // view. Keeping this non-optional preserves assignability for existing hosts.
  children: ReadonlyArray<unknown>,
  fields: FieldMap | undefined,
  span: { start: number; end: number },
  rawChildren: ReadonlyArray<unknown>,
  triviaLog: readonly number[],
  state: unknown,
  tags?: readonly string[] | undefined,
) => unknown) & {
  /** Framework-internal: optional syntax-CST wrapper collapse policy. */
  _parsemanCstCollapse?: CstCollapsePredicate | undefined
  /**
   * Framework-internal: `false` when this host builds its node purely from
   * `rawChildren` (arg 4) and never reads the structural `children` (arg 1).
   * Arity-based elision (`_hostReads`) cannot see this: a host that reads a LATER
   * positional arg (`span`/`rawChildren`/`state`) must still DECLARE `children`
   * positionally, so `Function.length` stays high and every arg-gate reports
   * "read". This explicit opt-out lets a structural node skip allocating its
   * per-node `children` array entirely — a pure duplicate of `rawChildren` for a
   * structural grammar. Default (`undefined`) keeps the array (output-neutral).
   * A host that sets this MUST NOT also read `children`, and must not rely on
   * `_parsemanCstCollapse` (which inspects `children`).
   */
  _parsemanReadsChildren?: boolean | undefined
  /**
   * Framework-internal: node types whose structural host wants triviaLog.
   * This predicate is assembly-specialisation configuration: both its identity
   * and behaviour must remain stable after the host is first used. To change
   * the selection, assign a NEW predicate function; replacing its identity
   * invalidates the host's cached specialisation.
   */
  _parsemanCaptureTrivia?: ((type: string) => boolean) | undefined
  /**
   * Framework-internal: per-node-type trivia-kind filter for the captured
   * `triviaLog`. Returns a bitmask over the trivia's `triviaKindLabels` (bit `k`
   * = keep kind `k`); `undefined` = keep every kind (default). Lets a host ask
   * one node type for comments-only while another still gets whitespace — e.g.
   * `Ruleset`/`Stylesheet` want comment runs, `CompoundSelector` needs the
   * whitespace that marks a descendant combinator. Scoped to the node and
   * restored on exit. Build a mask with `triviaKindMask(labels, keep)`.
   */
  _parsemanTriviaKinds?: ((type: string) => number | undefined) | undefined
}

export type FieldCapture<T = unknown> = {
  value: T
  span: Span
}

export type FieldMap = Record<string, FieldCapture | FieldCapture[]>

/**
 * Recovery helpers the runtime driver injects into a COMPILED parse's ctx (`_rec`)
 * when tolerant, so the compiled output reuses the exact interpreter recovery
 * functions (`recoverScan`/`matchesAt`/`orSentinel`) — guaranteeing parity without
 * the emitted `new Function` needing module-scope access.
 */
export type RecoveryHelpers = {
  scan: (input: string, from: number, ctx: ParseContext, sync: Combinator<unknown>, expected: string[]) => { error: ParseError; end: number }
  at: (sentinel: Combinator<unknown>, input: string, pos: number, ctx: ParseContext) => boolean
  or: (a: Combinator<unknown>, b: Combinator<unknown> | undefined) => Combinator<unknown>
  /** Build a zero-width follow-set sentinel from a first-set. Called from compiled
   * code (via `_ctx`, never `_rp`) so recovery grammars stay macro-inlinable. */
  sentinel: (fs: FirstSet) => Combinator<unknown> | null
  /** Embed a recovered error as a `parseError` CST child at the recovery point
   * (no-op when CST capture is off). Called from both paths so the error lives in
   * the tree — riding reused subtrees across incremental edits — not just the flat
   * `_errors` channel. */
  capture: (ctx: ParseContext, error: ParseError) => void
}

export type ParseContext = {
  // `| undefined` (matching captureTrivia/_cst* below): a nested scope may
  // intentionally CLEAR inherited trivia by setting these to undefined (noTrivia).
  trivia?: Combinator<unknown> | undefined
  /**
   * Grammar-level ambient opaque-unit skippers (strings, balanced brackets, …),
   * declared once via `rules({ scanSkip }, factory)` and threaded here at the
   * parse entry — the scan-skip analogue of `trivia`. A `scanTo`/`balanced` with
   * no explicit per-call `skip` (and not `raw`) consults these so a sentinel
   * hidden inside a string/bracket run is never matched. Separate category from
   * `trivia`: trivia is insignificant everywhere; scanSkip is significant but
   * atomic during a scan. Undefined when the grammar declares none.
   */
  scanSkip?: Combinator<unknown>[] | undefined
  /**
   * Label table for the active trivia parser (`label(name, arm)` strings in
   * choice order). When set, trivia logs include a kind index per entry.
   */
  triviaKindLabels?: readonly string[] | undefined
  /**
   * When true (and a CST node is collecting children), trivia consumed between
   * terms is recorded into _cstRawChildren as separate CSTTrivia tokens — one
   * per maximal sub-match of the trivia parser (e.g. a whitespace run or a
   * comment). When false/unset, trivia is skipped silently. Default: skip.
   */
  captureTrivia?: boolean | undefined
  /**
   * Kind-filter for PER-NODE CST trivia capture (`triviaLog` handed to a node's
   * builder). A bitmask over the active `triviaKindLabels` indices: bit `k` set
   * means "record kind `k`"; `undefined` means record every kind (default). Only
   * the per-node CST log is filtered — the global `_triviaLog` stays complete, so
   * a downstream trivia map is unaffected. Lets a host that only consumes, say,
   * comments enable per-node capture WITHOUT paying to log every whitespace run.
   * Requires labeled trivia (indices align with `triviaKindLabels`); with no
   * labels the mask can't apply and all trivia is captured. Build a mask with
   * `triviaKindMask(labels, keep)`.
   */
  _triviaCaptureMask?: number | undefined
  trackLines: boolean
  /** Grammar-author-provided state, scoped with withCtx() and read in guard(). */
  state?: unknown
  /**
   * Mode host (RULE_ABI_PLAN §7): when set, a linkable/fused grammar's `node()`
   * rules build via `build(type, children, fields, span, rawChildren, triviaLog, state)`
   * instead of their own builder — so ONE grammar serves eval-AST (unset) vs
   * positioned-CST / language-service (set) modes. Ignored by non-linkable output.
   */
  build?: BuildHost | undefined
  /** When set, recovery (tolerant lists / expect()) pushes each ParseError here in addition to embedding it in the tree. */
  _errors?: ParseError[] | undefined
  /**
   * Framework-internal: layered "C+B" list recovery gate. When true, tolerant
   * `many`/`oneOrMore`/`sepBy` recover from a failed element (skip to a sync point,
   * emit a ParseError, keep parsing) instead of stopping the list. Unset (the
   * default / strict path) ⇒ the list combinators behave byte-identically to before;
   * the only residue is a single cold branch on the element-failure edge.
   */
  _tolerant?: boolean | undefined
  /**
   * Framework-internal: the recovery sync sentinel in effect for the current
   * subtree, published DOWN by an enclosing `sequence` in tolerant mode. It is a
   * zero-width combinator that matches when the input could start any of the
   * sequence's remaining terms — i.e. the enclosing delimiter/close a nested list
   * should resync to. A nested `many`/`oneOrMore`/`sepBy` reads it as its recovery
   * terminator on element failure. Inferred automatically from grammar structure
   * (the grammar carries no recovery config); `undefined` when nothing is locally
   * inferable. Dynamic scoping through rule refs gives cross-rule inheritance for
   * free (a list at a rule's tail resyncs to whatever delimiter followed the call).
   */
  _sync?: Combinator<unknown> | undefined
  /**
   * Framework-internal (compiled output only): recovery helpers injected by the
   * runtime driver (`run`) when tolerant, so the compiled parser reuses the EXACT
   * interpreter recovery functions — guaranteeing byte-for-byte parity without the
   * emitted `new Function` needing module-scope access. Unset (strict) ⇒ compiled
   * lists never enter the recovery branch. The interpreter ignores this field.
   */
  _rec?: RecoveryHelpers | undefined
  /**
   * Framework-internal (compiled/macro output only): the deepest failure recorded
   * while a fallible sub-parser was running — position (`_fe`) and expected set
   * (`_fx`). Composite constructs (node, ref, withCtx, …) read these to propagate
   * the inner failure verbatim instead of a coarse structural placeholder, keeping
   * failure diagnostics at parity with the interpreter. Overwritten on each leaf
   * failure; only meaningful immediately after a sub-parse reports failure.
   */
  _fe?: number | undefined
  _fx?: string[] | undefined
  /** Framework-internal compiled-output committed-failure flag. */
  _fc?: boolean | undefined
  /**
   * When set by completionsAt(), tracks the highest-position ParseFail seen
   * during parsing up to _probe.offset. Used to return completions at the cursor
   * even when sepBy/many backtracked past the cursor position.
   */
  _probe?: { offset: number; best: ParseFail | null } | undefined
  /**
   * Framework-internal: current CSTNode rule's child collector.
   * Set by node() during capture; undefined outside an active node parse.
   * CSTNode parsers append themselves here after a successful parse.
   */
  _cstChildren?: unknown[] | undefined
  /**
   * Framework-internal: collector for CSTLeaf terminals.
   * Usually points to the same array as _cstChildren (both live together).
   * literal() and regex() append a CSTLeaf here when set.
   */
  _cstLeaves?: unknown[] | undefined
  /**
   * Framework-internal: collector for ALL children including trivia.
   * Set alongside _cstChildren/_cstLeaves. Receives CSTLeaf + CSTNode entries
   * (same as _cstChildren) PLUS CSTTrivia entries for trivia consumed between terms.
   * Passed to buildNode() as rawChildren so grammars can inspect trivia.
   */
  _cstRawChildren?: unknown[] | undefined
  /**
   * Framework-internal: flat trivia log. When set, scanTrivia records each
   * consumed trivia entry as two numbers [start, end] appended to this
   * array instead of (or in addition to) rawChildren capture. Zero object
   * allocations — just number pushes.
   */
  _triviaLog?: number[] | undefined
  /**
   * Framework-internal: selected root-trivia rows. Each row is
   * `[gapStart, gapEnd, markerStart, markerEnd, kindIndex]`. Unlike
   * `_triviaLog`, this never records an ordinary whitespace chunk: a row exists
   * only for a selected labeled trivia kind, while its first pair preserves the
   * complete committed gap that owns that marker. The fixed-width numeric log
   * keeps compiler rollback as cheap as the legacy root sink.
   */
  _rootTriviaLog?: number[] | undefined
  /** Grammar-label → selected-root-table index. Each trivia scope maps its local
   * label through this once-built table, so composed grammars may use different
   * label orders without a per-chunk linear selected-label search. */
  _rootTriviaKindIndex?: Readonly<Record<string, number>> | undefined
  /** Selected-root capture checks local trivia classification once per scope. */
  _rootTriviaStrictScopes?: boolean | undefined
  /**
   * Scoped selected-root capture switch. `parser({ rootCapture: 'opaque' })`
   * turns this off for its explicit trivia region so that region cannot leak
   * selected markers into the document-root capture.
   */
  _rootTriviaCapture?: boolean | undefined
  /**
   * Framework-internal: flat per-node trivia log for CST capture mode.
   * When set alongside _cstRawChildren, each trivia entry is recorded as three
   * numbers [start, end, insertIdx] appended here (one entry = three numbers) instead of allocating a
   * CSTTrivia object. `insertIdx` is the _cstRawChildren.length at the moment
   * the trivia was consumed, so consumers know where in rawChildren to insert it.
   * Zero object allocations — replaces the CSTTrivia object path entirely.
   */
  _cstTriviaLog?: number[] | undefined
  /** Framework-internal: active node() field captures, enabled only when needed. */
  _fields?: Array<{ name: string; value: unknown; span: Span }> | undefined
  /** Framework-internal: lazy capture buffer for active node() parse. */
  _cstBuf?: CstCaptureBuf | undefined
  /** Framework-internal: value/span already consumed by an enclosing dispatch(). */
  _routed?: { value: unknown; span: Span } | undefined
  /**
   * Framework-internal optional line-start collector. Compiled parsers emitted
   * with line tracking append newline-derived line starts here while matching
   * terminals; the driver normalizes/dedupes once before annotating spans.
   */
  _lineStarts?: number[] | undefined
  /** Framework-internal shared line index for interpreter-side line annotation. */
  _lineIndex?: { lineStarts: number[] } | undefined
  /** Framework-internal high-water mark for optional line tracking range scans. */
  _lineScannedTo?: number | undefined
  /**
   * Framework-internal coverage hook. Previously reached `ctx` only via a
   * conditional spread of `RunOptions.instrumentation`, so an instrumented parse
   * gave `ctx` a DIFFERENT hidden class from an ordinary one. Declared here so
   * every `ctx` has one shape; `undefined` when not instrumented.
   */
  _grammarCoverage?: ((id: string) => void) | undefined
  /** Framework-internal trace sink — same shape rationale as `_grammarCoverage`. */
  _grammarTrace?: {
    write(event: {
      id: string
      phase: 'enter' | 'attempt' | 'selected' | 'success' | 'failure' | 'backtrack' | 'rollback'
      offset: number
      end?: number
    }): void
  } | undefined
}

/**
 * The recovery value produced when a parse fails at a recoverable point (tolerant
 * list recovery, or expect()). The span covers the skipped/missing input; expected
 * lists what the parser wanted there.
 */
export type ParseError = {
  readonly _tag: 'parseError'
  readonly span: Span
  readonly expected: string[]
}

export type ParserMeta = {
  /** Character codes / ranges that can start this parser (for choice dispatch) */
  firstSet: FirstSet
  /** Whether this parser can consume a newline character */
  canMatchNewline: boolean
  /** Whether this parser is marked as trivia (auto-skip) */
  isTrivia: boolean
  /** User-defined labels for labeled trivia arms (`label(name, parser)`). */
  triviaKindLabels?: readonly string[]
  /** Preclassified lightweight trivia scanner for the ordinary skip path. */
  triviaScanner?: ((input: string, cur: number) => number) | null
  /** Set only by `classifiedTrivia()`: each root-visible category is a separate
   * grammar arm rather than an arbitrary label on a broad recognizer. */
  rootTriviaClassified?: true
  /** choice(): true when all alternative first sets are pairwise disjoint */
  disjoint?: boolean
  /**
   * Grammar-level ambient trivia declared via `rules({ trivia }, factory)`. When
   * a rule carrying this is parsed as an ENTRY (run()/parse()/compile with no
   * more-local trivia already active), the framework installs it as `ctx.trivia`
   * so it is ambient for the whole parse — "set once, inherited everywhere",
   * including incremental parsing of a single rule. `parser({ trivia })` /
   * `noTrivia` still override it locally. The compiled path bakes it as the
   * seed `activeTrivia` for every rule in the map.
   */
  grammarTrivia?: Combinator<unknown> | undefined
  /**
   * Grammar-level ambient scan-skip declared via `rules({ scanSkip }, factory)`.
   * Mirrors `grammarTrivia`: stamped on every non-trivia rule, installed as
   * `ctx.scanSkip` at the parse entry (and baked as the compiled seed) so a
   * `scanTo`/`balanced` with no explicit `skip` consults it ambiently.
   */
  grammarScanSkip?: Combinator<unknown>[] | undefined
  /**
   * Grammar-level host mode declared via `rules({ hostMode }, factory)`. Stamped on
   * every rule, mirroring the two above. The macro reads it statically to choose what
   * to EMIT; the interpreter routes dynamically and only reads it so `run()` can refuse
   * a mismatched host once per parse. `'ast'` is the default and is never stamped.
   */
  grammarHostMode?: 'ast' | 'cst' | undefined
  /**
   * Grammar-level line tracking declared via `rules({ trackLines: true }, factory)`.
   * Stamped on every non-trivia rule so runtime compile and macro compile can emit
   * a separate line-aware artifact from the same authored grammar source.
   */
  grammarTrackLines?: true | undefined
}

/** A first set is either "any" (unknown/unbounded) or a list of char code ranges */
export type FirstSet =
  | { kind: 'any' }
  | { kind: 'ranges'; ranges: CharRange[] }
  | { kind: 'empty' }

export type CharRange = { lo: number; hi: number }

/**
 * Determines how a non-disjoint choice dispatches at runtime/compile-time.
 *
 * greedyClassify: one regex arm subsumes all literal arms — run the regex once,
 *                 classify the result with string equality. Single parse call, no backtracking.
 * literalsLongestFirst: all arms are literals — try from longest to shortest, no regex,
 *                       no ambiguity, no backtracking.
 * firstMatch: PEG fallback — try each arm in order; arms with autoNot[] get an inline
 *             rejection check so a later arm can "win" without explicit not().
 * sharedPrefix: EVERY arm is a bare `sequence(...)` beginning with the SAME concrete
 *               leading literal/regex (a "left factor"). The compiler parses that
 *               prefix ONCE, then tries each arm's residual terms in PEG order from
 *               the shared end position — no re-parse of the prefix per arm. PEG
 *               priority and byte-identical value/CST/diagnostics are preserved; the
 *               interpreter treats it exactly as `firstMatch`. Opt-in like
 *               greedyClassify (auto-detected only for the narrow shape it can prove).
 */
export type ChoiceStrategy =
  | { tag: 'greedyClassify';       superIndex: number }
  | { tag: 'literalsLongestFirst'; sortedIndices: number[] }
  | { tag: 'firstMatch' }
  | { tag: 'sharedPrefix';         prefix: Combinator<unknown>; members: number[] }

/**
 * Used only by the 'firstMatch' fallback strategy. Describes what char/string at
 * the END of an arm's match should cause that arm to be rejected so the next arm
 * is tried. Auto-derived from sibling alternatives at construction time.
 */
export type AutoNotCheck =
  | { kind: 'firstSet';   set: FirstSet }
  | { kind: 'startsWith'; value: string }

/**
 * A choice arm with an optional gate predicate. When a gate is provided,
 * it is evaluated (cheaply, without parsing) before the arm is attempted.
 * If the gate returns false the arm is skipped entirely.
 *
 * Usage: choice({ gate: s => (s as Ctx).inFn, combinator: returnKw }, ident)
 */
export type GatedArm<T = unknown> = {
  gate: (state: unknown) => boolean
  combinator: Combinator<T>
}

/**
 * WHAT `compile()` HANDS BACK — the contract, not one engine's return type.
 *
 * This lives with the rest of the library's types rather than inside a lowering
 * because it is the shape BOTH lowerings answer to: `table/compile.ts` returns it
 * today and is what `src/index.ts` exports as `compile`. It started in
 * `compiler/codegen.ts`, which made the table import its own public contract from
 * the engine the table replaced — backwards, and a reason the engine could not be
 * deleted.
 */
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
  /**
   * WHY `inlineExpression` IS NULL — one named reason per cause, present only
   * when the artifact could not be PRINTED. A null with no reason is the failure
   * this field exists to make impossible: the caller's fallback is "leave the
   * grammar interpreted", which is a ~5x silent perf regression, so the reason
   * has to reach a warning rather than being inferred from a null.
   *
   * Empty/absent means printable. Set by the table lowering; the source lowering's
   * own unprintable cases predate this channel and still return a bare null.
   */
  runtimeOnly?: readonly string[]
  /** Present only when compiled with `{ coverage: true }`. */
  coverageDefinitions?: readonly import('./compiler/grammar-coverage-ids.ts').GrammarCoverageDefinition[]
}
