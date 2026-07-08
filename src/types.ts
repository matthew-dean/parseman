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
  | { tag: 'choice';    parsers: Combinator<unknown>[]; gates: (((state: unknown) => boolean) | null)[]; disjoint: boolean; strategy: ChoiceStrategy; autoNot: (AutoNotCheck[] | null)[] }
  | { tag: 'many';      parser: Combinator<unknown>; min: 0; valueUnused?: boolean }
  | { tag: 'oneOrMore'; parser: Combinator<unknown>; min: 1; valueUnused?: boolean }
  | { tag: 'optional';  parser: Combinator<unknown> }
  | { tag: 'sepBy';     parser: Combinator<unknown>; separator: Combinator<unknown> }
  | { tag: 'transform'; parser: Combinator<unknown>; fn: (v: unknown, span: { start: number; end: number }) => unknown; fnSrc?: string }
  | { tag: 'skip';      main: Combinator<unknown>; skipped: Combinator<unknown> }
  | { tag: 'trivia';    parser: Combinator<unknown> }
  | { tag: 'token';     parser: Combinator<unknown> }
  | { tag: 'label';     label: string; parser: Combinator<unknown> }
  | { tag: 'grammar';   parser: Combinator<unknown>; triviaParser: Combinator<unknown> | undefined; clearTrivia?: boolean; trackLines: boolean }
  | { tag: 'lazy';     thunk: () => Combinator<unknown> }
  | { tag: 'not';      parser: Combinator<unknown> }
  | { tag: 'node';     type?: string; parser: Combinator<unknown>; build?: ((children: ReadonlyArray<unknown>, rawChildren: ReadonlyArray<unknown>, span: { start: number; end: number }, triviaLog: readonly number[], state: unknown) => unknown) | undefined; buildSrc?: string; unwrap?: boolean; collapse?: boolean }
  | { tag: 'guard';    predicate: (state: unknown) => boolean }
  | { tag: 'withCtx';  extra: unknown; parser: Combinator<unknown> }
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
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
  state: unknown,
) => unknown) & {
  /** Framework-internal: optional syntax-CST wrapper collapse policy. */
  _parsemanCstCollapse?: CstCollapsePredicate | undefined
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
  trackLines: boolean
  /** Grammar-author-provided state, scoped with withCtx() and read in guard(). */
  state?: unknown
  /**
   * Mode host (RULE_ABI_PLAN §7): when set, a linkable/fused grammar's `node()`
   * rules build via `build(type, children, rawChildren, span, triviaLog, state)`
   * instead of their own builder — so ONE grammar serves eval-AST (unset) vs
   * positioned-CST / language-service (set) modes. Ignored by non-linkable output.
   */
  build?: BuildHost | undefined
  /** When set, recover() nodes push their ParseError here instead of (only) embedding it in the tree. */
  _errors?: ParseError[]
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
  _probe?: { offset: number; best: ParseFail | null }
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
  _triviaLog?: number[]
  /**
   * Framework-internal: flat per-node trivia log for CST capture mode.
   * When set alongside _cstRawChildren, each trivia entry is recorded as three
   * numbers [start, end, insertIdx] appended here (one entry = three numbers) instead of allocating a
   * CSTTrivia object. `insertIdx` is the _cstRawChildren.length at the moment
   * the trivia was consumed, so consumers know where in rawChildren to insert it.
   * Zero object allocations — replaces the CSTTrivia object path entirely.
   */
  _cstTriviaLog?: number[] | undefined
  /** Framework-internal: lazy capture buffer for active node() parse. */
  _cstBuf?: CstCaptureBuf | undefined
}

/**
 * Sentinel value returned by recover() when its inner parser fails.
 * The span covers the skipped input; expected lists what the inner parser wanted.
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
