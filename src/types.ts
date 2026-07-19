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
  | { tag: 'many';      parser: Combinator<unknown>; min: 0; valueUnused?: boolean }
  | { tag: 'oneOrMore'; parser: Combinator<unknown>; min: 1; valueUnused?: boolean }
  | { tag: 'optional';  parser: Combinator<unknown> }
  | { tag: 'sepBy';     parser: Combinator<unknown>; separator: Combinator<unknown> }
  | { tag: 'transform'; parser: Combinator<unknown>; fn: (v: unknown, span: { start: number; end: number }) => unknown; fnSrc?: string }
  | { tag: 'skip';      main: Combinator<unknown>; skipped: Combinator<unknown> }
  | { tag: 'trivia';    parser: Combinator<unknown> }
  | { tag: 'token';     parser: Combinator<unknown> }
  | { tag: 'label';     label: string; parser: Combinator<unknown> }
  | { tag: 'field';     name: string; parser: Combinator<unknown> }
  | { tag: 'grammar';   parser: Combinator<unknown>; triviaParser: Combinator<unknown> | undefined; clearTrivia?: boolean; captureTrivia?: boolean; trackLines: boolean }
  | { tag: 'lazy';     thunk: () => Combinator<unknown> }
  | { tag: 'not';      parser: Combinator<unknown> }
  // `buildStaticValidated` is set only by the macro after its Oxc binding check;
  // carried IR must present `true` before its direct build source is re-lowered.
  | { tag: 'node';     type?: string; parser: Combinator<unknown>; build?: ((children: ReadonlyArray<unknown>, fields: FieldMap | undefined, span: { start: number; end: number }, rawChildren: ReadonlyArray<unknown>, triviaLog: readonly number[], state: unknown) => unknown) | undefined; buildSrc?: string; buildStaticError?: readonly string[]; buildStaticValidated?: boolean; unwrap?: boolean; collapse?: boolean; captureTrivia?: boolean }
  // `predSrc`/`extraSrc` (set by the macro evaluator): SOURCE TEXT of the guard
  // predicate / the withCtx `extra` value, so codegen inlines them into `_mf`
  // rather than pushing a `null` source. Absent under runtime compile() (the real
  // closures/values live in `predicate`/`extra`).
  | { tag: 'guard';    predicate: (state: unknown) => boolean; predSrc?: string }
  | { tag: 'withCtx';  extra: unknown; parser: Combinator<unknown>; extraSrc?: string }
  | { tag: 'recover';  parser: Combinator<unknown>; sentinel: Combinator<unknown> }
  | { tag: 'expect';   parser: Combinator<unknown>; label: string | undefined; expected: string[] }
  | { tag: 'scanTo';   sentinel: Combinator<unknown>; skip: Combinator<unknown>[]; orEOF: boolean }
  | { tag: 'keywords'; words: readonly string[]; caseInsensitive: boolean; boundary: string | undefined }
  | { tag: 'unknown' }

export type Combinator<T> = {
  readonly _tag: string
  readonly _meta: ParserMeta
  readonly _def: ParserDef
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>
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
  children: ReadonlyArray<unknown>,
  fields: FieldMap | undefined,
  span: { start: number; end: number },
  rawChildren: ReadonlyArray<unknown>,
  triviaLog: readonly number[],
  state: unknown,
) => unknown) & {
  /** Framework-internal: optional syntax-CST wrapper collapse policy. */
  _parsemanCstCollapse?: CstCollapsePredicate | undefined
  /** Framework-internal: node types whose structural host wants triviaLog. */
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
  _fe?: number
  _fx?: string[]
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
  /**
   * Framework-internal: opt-in `run({ profile: true })` pass state. This is
   * deliberately not a parser mode: codegen reads it only while the profiling
   * driver is comparing its recognizer, capture-only, and normal-host passes.
   */
  _pmProfile?: {
    phase: 'recognizer' | 'capture' | 'host'
    nodes: number
    childSlots: number
    rawSlots: number
    triviaSlots: number
    fieldSlots: number
    hostCalls: number
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
 */
export type ChoiceStrategy =
  | { tag: 'greedyClassify';       superIndex: number }
  | { tag: 'literalsLongestFirst'; sortedIndices: number[] }
  | { tag: 'firstMatch' }

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
