/**
 * Compile a Combinator<T> definition tree into an optimized JavaScript function.
 *
 * Design: every sub-emitter uses early-return on failure. Fallible contexts
 * (optional, sepBy loops, many loops) use labeled blocks so early-exit is a
 * `break <label>` rather than an IIFE return — no function call, no result
 * object allocation per node.
 */
import type { Combinator, ParserDef, FirstSet, ParseResult, ParseContext, ParseError, ChoiceStrategy } from '../types.ts'
import { getCoreLiteralValue, getCoreRegexDef } from '../combinators/choice.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { firstSetOf, matchesEmpty } from '../combinators/first-set.ts'
import { markUnusedValues } from './value-usage.ts'
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
import { buildReadsTrivia, buildReadsState } from './build-arity.ts'
import {
  transformFnSource,
  tryInlineUnaryTransform,
  tryInlineDestructureTransform,
} from './inline-callback.ts'

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
// Codegen context
// ---------------------------------------------------------------------------
type Ctx = {
  vars: number
  indent: number
  /** Regex declarations hoisted to module scope */
  regexDecls: string[]
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
  /** Label table from grammar trivia for default ParseContext. */
  triviaKindLabels?: readonly string[] | undefined
  /**
   * Whether this compile contains any node() rule. When true, terminals emit a
   * `_ctx._cstLeaves` capture and trivia skips capture trivia tokens — flowing
   * through `_ctx` so capture crosses named-function (ref) boundaries correctly.
   * When false (no node() anywhere) NO capture code is emitted, so non-CST
   * grammars compile byte-identically to before.
   */
  capturing?: boolean
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
  /** Trivia parser → name of its capturing variant fn (separate from namedParsers). */
  triviaCaptureNames: Map<Combinator<unknown>, string>
  /**
   * Trivia parser → name of its fast number-returning variant fn (non-capturing
   * mode). Returns the new position directly instead of a {ok,value,span} object,
   * eliminating two object allocations per trivia skip.
   */
  triviaFnNames: Map<Combinator<unknown>, string>
  /** node() build functions captured at compile time (parallel to buildSrcs). */
  buildFns: Array<(children: ReadonlyArray<unknown>, raw: ReadonlyArray<unknown>, span: { start: number; end: number }, triviaLog: readonly number[], state: unknown) => unknown>
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

function failReturn(expected: string, posExpr: string): string {
  return `return { ok: false, expected: [${expected}], span: { start: ${posExpr}, end: ${posExpr} } }`
}

function failReturnArr(expectedArr: string, posExpr: string): string {
  return `return { ok: false, expected: ${expectedArr}, span: { start: ${posExpr}, end: ${posExpr} } }`
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

function failBody(ctx: Ctx, expected: string, posExpr: string): string {
  // Record the failure payload before breaking so an enclosing composite
  // construct can propagate this (deepest) failure verbatim — parity with the
  // interpreter, which returns the inner failure result. Recording is skipped
  // when no consumer will read it (see `ctx.recordFail`): swallowers like
  // optional/many/sepBy/not never inspect `_ctx._fx`, so a leaf failing inside
  // them just breaks — the hot path (loop terminations, first-arm misses) pays
  // nothing. The direct-return path is the final answer and needs no recording.
  if (ctx.failLabel) {
    if (!ctx.recordFail) return `break ${ctx.failLabel}`
    return `{ _ctx._fe = ${posExpr}; _ctx._fx = ${hoistExpected(ctx, `[${expected}]`)}; break ${ctx.failLabel} }`
  }
  return failReturn(expected, posExpr)
}

/**
 * Like {@link failBody} but the caller already has an array source. When
 * `constant` (the default), the array is hoisted+frozen (zero-alloc hot path).
 * Pass `constant: false` for dynamic sources (e.g. `_ctx._fx`, a runtime concat)
 * that must be assigned verbatim.
 */
function failArrBody(ctx: Ctx, expectedArr: string, posExpr: string, constant = true): string {
  if (ctx.failLabel) {
    if (!ctx.recordFail) return `break ${ctx.failLabel}`
    const fx = constant ? hoistExpected(ctx, expectedArr) : expectedArr
    return `{ _ctx._fe = ${posExpr}; _ctx._fx = ${fx}; break ${ctx.failLabel} }`
  }
  // Direct-return (no enclosing fail label). A dynamic source may reference the
  // shared frozen `_ctx._fx`; copy it so the (possibly frozen) constant never
  // escapes into a user-facing result. Constant sources are inline literals.
  if (!constant) return `return { ok: false, expected: [...${expectedArr}], span: { start: ${posExpr}, end: ${posExpr} } }`
  return failReturnArr(expectedArr, posExpr)
}

/** Build a ParseResult from the recorded deepest failure, copying `_fx` so the
 * shared frozen array never escapes into user-facing results. */
function resultFromRecorded(feExpr = '_ctx._fe', fxExpr = '_ctx._fx'): string {
  return `return { ok: false, expected: [...${fxExpr}], span: { start: ${feExpr}, end: ${feExpr} } }`
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
      return `{ _ctx._fe = ${srcCtx}._fe; _ctx._fx = ${srcCtx}._fx; break ${ctx.failLabel} }`
    }
    return `{ _ctx._fe = ${srcCtx}._fe; _ctx._fx = ${srcCtx}._fx; ${resultFromRecorded()} }`
  }
  // Same-ctx: `_ctx._fx` already holds the deepest failure — just break/return.
  if (ctx.failLabel) return `break ${ctx.failLabel}`
  return resultFromRecorded()
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
  return [
    `${i}if (_ctx._cstLeaves) {`,
    `${i}  const ${lf} = { _tag: 'leaf', value: ${valExpr}, span: { start: ${startExpr}, end: ${endExpr} } }`,
    `${i}  _ctx._cstLeaves.push(${lf})`,
    `${i}  if (_ctx._cstRawChildren) _ctx._cstRawChildren.push(${lf})`,
    `${i}}`,
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

/**
 * When `cap` is truthy, also records `[start, end]` (and optional insertIdx) into
 * `_ctx._triviaLog` / `_ctx._cstTriviaLog`. One emitted function serves both skip
 * and capture call sites — no duplicate trivia parser tree, no _tc wrapper call.
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
    // LABELED trivia: if every arm is scannable, the same char-scan loop but with
    // per-chunk kind capture (generalizes the old hardcoded ws-run + block-comment
    // case to any shape set / arm count). Otherwise fall to the regex/runtime
    // kind-tracking loops, which handle non-scannable arms.
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
  const savedCapAsTrivia = ctx.capAsTrivia
  ctx.indent    = 2
  ctx.failLabel = '_triv'
  ctx.capAsTrivia = true  // trivia terminals must not push into _cstLeaves
  ctx.activeTrivia = undefined  // trivia parser must not skip trivia within itself
  const r = emit(trivia, ctx, '_pos')
  ctx.indent    = savedIndent
  ctx.failLabel = savedFailLabel
  ctx.capAsTrivia = savedCapAsTrivia
  ctx.activeTrivia = savedTrivia

  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx, _cap) {`,
    `  let _e = _pos`,
    `  _triv: {`,
    ...reindentStmts(r.stmts, 2),
    `    _e = ${r.endVar}`,
    `  }`,
    `  if (_cap && _e > _pos) {`,
    `    if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_pos, _e)`,
    `    if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_pos, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0)`,
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
/** Body of a capture restore — resets each live buffer to its saved length. */
function captureRestoreBody(mL: string, mR: string, mTl: string, mLg: string | null): string {
  const base = `if (_ctx._cstLeaves) _ctx._cstLeaves.length = ${mL}; if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${mR}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${mTl}`
  // `_triviaLog` is the standalone diagnostic trivia log. The interpreter only
  // rewinds it on a failed *choice* arm (choice.ts), NOT on a failed sequence
  // term — a sequence returns the failure with earlier trivia still logged. To
  // stay byte-for-byte at parity with the interpreter, only rewind it where the
  // interpreter does (choice arms); sequence-term rollbacks (emitFallible) leave
  // it intact.
  return mLg ? `${base}; if (_ctx._triviaLog) _ctx._triviaLog.length = ${mLg}` : base
}

/**
 * True when parsing `p` may push a capture (leaf/child/trivia) into the active
 * buffers and THEN fail, leaving partial state that an enclosing node() would
 * wrongly absorb. Used to decide whether a fallible block needs CST-rollback.
 *
 * Sound over-approximation: the ONLY constructs that capture-then-fail are
 *   - a sequence whose non-final term captures before a later term can fail
 *   - a sepBy/oneOrMore item-then-separator partial (handled by their own
 *     dedicated rollback, so still covered conservatively here)
 * Atomic terminals (literal/regex/keywords/charClass/guard/not) fail without
 * having captured. node() buffers into a private sub-scope and discards it on
 * failure, so it never leaks. choice/firstMatch roll back each failed arm
 * internally. optional/many never "fail" with partial output. Delegating
 * wrappers (transform/label/grammar/withCtx/expect/skip) pass through to inner.
 */
function mayLeavePartialCapture(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    // Atomic / non-capturing-then-failing: a failure happens before any push.
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'not':
    case 'trivia':
    case 'token':
    case 'scanTo':
    case 'unknown':
      return false
    // node() captures into its own private buffers and rolls them back on
    // failure (emitNode restores _ctx.* and never pushes on the !ok path).
    case 'node':
      return false
    // choice/firstMatch already roll back each failed arm; on overall failure
    // nothing committed remains.
    case 'choice':
      return false
    // optional never fails; many/oneOrMore only "fail" with zero captured items.
    case 'optional':
    case 'many':
    case 'oneOrMore':
      return false
    // sepBy emits its own per-iteration rollback in emitSepBy.
    case 'sepBy':
      return false
    // A sequence is the real case: an earlier capturing term followed by a term
    // that can fail leaves the earlier captures buffered.
    case 'sequence': {
      const parts = d.parsers
      // Only risky if >=2 terms and some non-final term can capture.
      if (parts.length < 2) return parts.some(x => mayLeavePartialCapture(x, seen))
      for (let i = 0; i < parts.length - 1; i++) {
        if (hasNodeDef(parts[i]!) || capturesLeaf(parts[i]!)) return true
      }
      return false
    }
    // Delegating wrappers: defer to the wrapped parser.
    case 'transform':
    case 'label':
    case 'expect':
    case 'withCtx':
    case 'grammar':
      return mayLeavePartialCapture(d.parser, seen)
    case 'skip':
      return mayLeavePartialCapture(d.main, seen)
    case 'recover':
      return mayLeavePartialCapture(d.parser, seen)
    case 'lazy': {
      try { return mayLeavePartialCapture(d.thunk(), seen) } catch { return true }
    }
    // Unknown shapes: be safe and keep the rollback.
    default:
      return true
  }
}

/** True when `p` can push a leaf/node into the capture buffers on success. */
function capturesLeaf(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'node':
    case 'token':
      return true
    case 'not':
    case 'guard':
    case 'trivia':
    case 'unknown':
      return false
    case 'sequence':
    case 'choice':
      return d.parsers.some(x => capturesLeaf(x, seen))
    case 'sepBy':
      return capturesLeaf(d.parser, seen) || capturesLeaf(d.separator, seen)
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'transform':
    case 'label':
    case 'expect':
    case 'withCtx':
    case 'grammar':
    case 'recover':
      return capturesLeaf(d.parser, seen)
    case 'skip':
      return capturesLeaf(d.main, seen)
    case 'scanTo':
      return true
    case 'lazy': {
      try { return capturesLeaf(d.thunk(), seen) } catch { return true }
    }
    default:
      return true
  }
}

/** Wrap stmts + success return in an IIFE. Returns the IIFE expression string. */
function asIIFE(stmts: string[], valueVar: string, endVar: string, startPos: string, indent: string): string {
  return [
    `(() => {`,
    ...stmts,
    `${indent}  return { ok: true, value: ${valueVar}, span: { start: ${startPos}, end: ${endVar} } }`,
    `${indent}})()`,
  ].join('\n')
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
): { stmts: string[]; okVar: string; valVar: string; endVar: string } {
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
  const needsRollback = ctx.capturing && mayLeavePartialCapture(inner)
  const mL  = needsRollback ? v(ctx, '_fcl')  : null
  const mR  = needsRollback ? v(ctx, '_fcr')  : null
  const mTl = needsRollback ? v(ctx, '_fctl') : null
  const stmts = [
    `${ind0}let ${okV} = false, ${valV}, ${endV} = ${pos}`,
    ...(mL ? [
      `${ind0}const ${mL} = _ctx._cstLeaves?.length ?? 0`,
      `${ind0}const ${mR} = _ctx._cstRawChildren?.length ?? 0`,
      `${ind0}const ${mTl} = _ctx._cstTriviaLog?.length ?? 0`,
    ] : []),
    `${ind0}${lbl}: {`,
    ...r.stmts,
    `${ind0}  ${valV} = ${r.valueVar}; ${endV} = ${r.endVar}; ${okV} = true`,
    `${ind0}}`,
    ...(mL ? [
      `${ind0}if (!${okV}) { ${captureRestoreBody(mL, mR!, mTl!, null)} }`,
    ] : []),
  ]
  return { stmts, okVar: okV, valVar: valV, endVar: endV }
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
  const flags = def.caseInsensitive ? 'iuy' : 'uy'
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

function emitRegex(def: Extract<ParserDef, { tag: 'regex' }>, ctx: Ctx, pos: string): ER {
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
      const stmts = [...scanned.stmts, ...emitLeafCapture(ctx, vv, pos, scanned.endVar)]
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
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

function emitSeqValues(def: Extract<ParserDef, { tag: 'sequence' }>, ctx: Ctx, pos: string): ER & { valueVars: string[] } {
  const startV = v(ctx, '_start')
  const curV = v(ctx, '_cur')
  const stmts: string[] = [
    `${ind(ctx)}const ${startV} = ${pos}`,
    `${ind(ctx)}let ${curV} = ${pos}`,
  ]
  const valueVars: string[] = []

  for (let i = 0; i < def.parsers.length; i++) {
    if (i > 0 && ctx.activeTrivia) {
      if (ctx.capturing) {
        const capFn = ensureTriviaCaptureFn(ctx)
        const markV = v(ctx, '_mk')
        const markTl = v(ctx, '_mktl')
        const markLog = v(ctx, '_mklg')
        const scanEndV = v(ctx, '_sne')
        stmts.push(
          `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
          `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
          `${ind(ctx)}const ${markLog} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
          `${ind(ctx)}const ${scanEndV} = ${capFn}(input, ${curV}, _ctx, 1)`,
        )
        const r = emit(def.parsers[i]!, ctx, scanEndV)
        stmts.push(...r.stmts)
        const endAfterV = v(ctx, '_sea')
        stmts.push(
          `${ind(ctx)}const ${endAfterV} = ${r.endVar}`,
          `${ind(ctx)}if (${endAfterV} > ${scanEndV}) { ${curV} = ${endAfterV} } else { if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markV}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${markTl}; if (_ctx._triviaLog) _ctx._triviaLog.length = ${markLog}; }`,
        )
        valueVars.push(r.valueVar)
        continue
      } else {
        const trivFn = ensureTriviaFn(ctx)
        stmts.push(`${ind(ctx)}${curV} = ${trivFn}(input, ${curV}, _ctx)`)
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
    case 'literal': case 'regex': case 'keywords': case 'guard': case 'not':
      return true
    case 'transform': case 'label':
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
      return /(?:[*?]|\{0,|\{\d*,)/.test(d.source)
    case 'optional': return true
    case 'many': return true
    case 'transform': case 'label':
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
function emitDisjointArm(p: Combinator<unknown>, ctx: Ctx, pos: string, valV: string, endV: string): string[] {
  if (failsAtStart(p)) {
    const r = emit(p, ctx, pos)
    return [...r.stmts, `${ind(ctx)}${valV} = ${r.valueVar}`, `${ind(ctx)}${endV} = ${r.endVar}`]
  }
  const { stmts, okVar, valVar, endVar } = emitFallible(p, ctx, pos)
  return [
    ...stmts,
    ...emitIfFail(ctx, `!${okVar}`, failArrBody(ctx, '_ctx._fx', pos, false)),
    `${ind(ctx)}${valV} = ${valVar}`,
    `${ind(ctx)}${endV} = ${endVar}`,
  ]
}

function emitChoice(def: Extract<ParserDef, { tag: 'choice' }>, ctx: Ctx, pos: string): ER {
  const allExpected = deriveExpectedArr(def.parsers)

  // ── Disjoint: O(1) first-char dispatch ──────────────────────────────────
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
        const p = def.parsers[i]!
        for (const cp of plan.cases[i]!) stmts.push(`${ind(ctx)}case ${cp}:`)
        stmts.push(`${ind(ctx)}{`)
        ctx.indent++
        stmts.push(
          ...emitDisjointArm(p, ctx, pos, valV, endV),
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
    for (const p of def.parsers) {
      const cond = firstSetCond(codeV, p._meta.firstSet)
      const kw = first ? 'if' : 'else if'
      first = false
      stmts.push(`${ind(ctx)}${kw} (${cond}) {`)
      ctx.indent++
      stmts.push(...emitDisjointArm(p, ctx, pos, valV, endV))
      ctx.indent--
      stmts.push(`${ind(ctx)}}`)
    }
    stmts.push(...emitElseFail(ctx, failArrBody(ctx, allExpected, pos)))
    return { stmts, valueVar: valV, endVar: endV }
  }

  return emitNonDisjoint(def, def.strategy, allExpected, ctx, pos)
}

// ── greedyClassify: run the super-regex once, classify by string equality ────
// Single regex exec + O(n_literals) string comparisons. Zero backtracking.
function emitGreedyClassify(
  def: Extract<ParserDef, { tag: 'choice' }>,
  superIndex: number,
  ctx: Ctx,
  pos: string,
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
  const stmts: string[] = [
    `${ind(ctx)}${reVar}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${matchV} = ${reVar}.exec(input)`,
    ...emitIfFail(ctx, `${matchV} === null`, failArrBody(ctx, regexExpected, pos)),
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
    stmts.push(...emitLeafCapture(ctx, JSON.stringify(litVal), pos, endV))
    stmts.push(...tR.stmts, `${ind(ctx)}${valV} = ${tR.valueVar}`)
    ctx.indent--
    stmts.push(`${ind(ctx)}}`)
  }

  // Regex arm: capture + transform chain for the matched word
  const rR = emitTransformChain(superParser, wordV, endV, pos, ctx)
  const regexKw = first ? 'if' : 'else'
  stmts.push(`${ind(ctx)}${regexKw} {`)
  ctx.indent++
  stmts.push(...emitLeafCapture(ctx, wordV, pos, endV), ...rR.stmts, `${ind(ctx)}${valV} = ${rR.valueVar}`)
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
      ...emitLeafCapture(ctx, JSON.stringify(litVal), pos, litEnd),
      ...tR.stmts,
      `${ind(ctx)}${valV} = ${tR.valueVar}`,
      `${ind(ctx)}${endV} = ${litEnd}`,
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
  const ind0 = ind(ctx)
  const stmts: string[] = [
    `${ind0}let ${resValV}, ${resEndV} = ${pos}, ${resOkV} = false`,
    `${ind0}let ${slots.join(', ')}`,
    `${ind0}const ${codeV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
  ]

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
    const fsGuard = deferRuleName !== undefined
      ? `/*@FS:${deferRuleName}:${codeV}@*/true`
      : needsFirstSetGuard(p)
        ? firstSetCond(codeV, p._meta.firstSet)
        : (() => {
            if (p._meta.firstSet.kind !== 'any' || matchesEmpty(p)) return null
            const deep = firstSetOf(p)
            return deep.kind === 'ranges' ? firstSetCond(codeV, deep) : null
          })()

    // Gate: register predicate in mapFns; condition guards entire arm attempt
    let gateCond: string | null = null
    if (gate) {
      const gateIdx = ctx.mapFns.length
      ctx.mapFns.push(gate as (v: unknown, span: unknown) => unknown)
      ctx.mapFnSrcs.push(null) // keep parallel with mapFns (a gate predicate has no captured source)
      gateCond = `${mfRef(ctx)}[${gateIdx}](_ctx.state)`
    }
    const skipCond = gateCond ? `!${resOkV} && ${gateCond}` : `!${resOkV}`

    const armHasAutoNot = !!(autoNot && autoNot.length > 0)
    const armNeedsRollback = ctx.capturing &&
      (mayLeavePartialCapture(p) || (armHasAutoNot && capturesLeaf(p)))
    const markLeaves = armNeedsRollback ? v(ctx, '_cml') : null
    const markRaw    = armNeedsRollback ? v(ctx, '_cmr') : null
    const markTl     = armNeedsRollback ? v(ctx, '_cmtl') : null
    const markLog    = armNeedsRollback ? v(ctx, '_cmlg') : null
    const rollback   = markLeaves
      ? captureRestoreBody(markLeaves, markRaw!, markTl!, markLog!)
      : ''
    const failSlot = atStart ? staticFx : '_ctx._fx'

    stmts.push(`${ind0}if (${skipCond}) {`)
    if (fsGuard) stmts.push(`${ind(ctx)}if (${fsGuard}) {`)
    ctx.indent += fsGuard ? 2 : 1

    if (markLeaves) {
      stmts.push(
        `${ind(ctx)}const ${markLeaves} = _ctx._cstLeaves?.length ?? 0`,
        `${ind(ctx)}const ${markRaw} = _ctx._cstRawChildren?.length ?? 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog?.length ?? 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog?.length ?? 0`,
      )
    }
    const { stmts: armStmts, okVar, valVar, endVar } = emitFallible(p, ctx, pos, atStart)
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
      stmts.push(`${ind(ctx)}  }`)
      stmts.push(`${ind(ctx)}}`)
      stmts.push(`${ind(ctx)}else { ${slots[i]} = ${failSlot} }`)
      if (rollback) stmts.push(`${ind(ctx)}if (!${resOkV}) { ${rollback} }`)
    } else {
      stmts.push(`${ind(ctx)}if (${okVar}) { ${resValV} = ${valVar}; ${resEndV} = ${endVar}; ${resOkV} = true }`)
      stmts.push(`${ind(ctx)}else { ${slots[i]} = ${failSlot}${rollback ? `; ${rollback}` : ''} }`)
    }

    ctx.indent -= fsGuard ? 2 : 1
    if (fsGuard) stmts.push(`${ind(ctx)}} else { ${slots[i]} = ${staticFx} }`)
    stmts.push(`${ind0}}`)
  }
  const concatExpr = `[${slots.map(s => `...(${s} || [])`).join(', ')}]`
  stmts.push(...emitIfFail(ctx, `!${resOkV}`, failArrBody(ctx, concatExpr, pos, false)))
  return { stmts, valueVar: resValV, endVar: resEndV }
}

function emitNonDisjoint(
  def: Extract<ParserDef, { tag: 'choice' }>,
  strategy: ChoiceStrategy,
  allExpected: string,
  ctx: Ctx,
  pos: string,
): ER {
  if (strategy.tag === 'greedyClassify')
    return emitGreedyClassify(def, strategy.superIndex, ctx, pos)
  if (strategy.tag === 'literalsLongestFirst')
    return emitLiteralsLongestFirst(def, strategy.sortedIndices, allExpected, ctx, pos)
  return emitFirstMatch(def, ctx, pos)
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

  if (def.min === 1) {
    // Inline first mandatory match with early-return on failure
    const firstR = emit(def.parser, ctx, curV)
    stmts.push(...firstR.stmts)
    if (wantValue) stmts.push(`${ind(ctx)}${arrV}.push(${firstR.valueVar})`)
    stmts.push(`${ind(ctx)}${curV} = ${firstR.endVar}`)
  }

  stmts.push(`${ind(ctx)}while (${curV} < input.length) {`)
  ctx.indent++

  // Mirror interpreter repeat.ts — skip trivia before each iteration. In capture
  // mode the trivia is committed to rawChildren immediately and rolled back
  // (array truncation) if the following item doesn't materialize.
  let itemPos = curV
  let rollback = ''
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const markV = v(ctx, '_mk')
      const markTl = v(ctx, '_mktl')
      const markLog = v(ctx, '_mklg')
      const npV = v(ctx, '_np')
      stmts.push(
        `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
        `${ind(ctx)}const ${npV} = ${capFn}(input, ${curV}, _ctx, 1)`,
      )
      itemPos = npV
      rollback = `if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markV}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${markTl}; if (_ctx._triviaLog) _ctx._triviaLog.length = ${markLog}; `
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${trivFn}(input, ${curV}, _ctx)`)
      itemPos = npV
    }
  }

  const { stmts: iterStmts, okVar: iterOk, valVar: iterVal, endVar: iterEnd } = emitFallible(def.parser, ctx, itemPos, true)
  stmts.push(
    ...iterStmts,
    `${ind(ctx)}if (!${iterOk} || ${iterEnd} <= ${itemPos}) { ${rollback}break }`,
  )
  if (wantValue) stmts.push(`${ind(ctx)}${arrV}.push(${iterVal})`)
  stmts.push(`${ind(ctx)}${curV} = ${iterEnd}`)
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  return { stmts, valueVar: wantValue ? arrV : 'undefined', endVar: curV }
}

function emitOptional(def: Extract<ParserDef, { tag: 'optional' }>, ctx: Ctx, pos: string): ER {
  const valV = v(ctx, '_opt')
  const endV = v(ctx, '_opte')

  const { stmts: lblStmts, okVar, valVar, endVar } = emitFallible(def.parser, ctx, pos, true)

  const ind0 = ind(ctx)
  const stmts = [
    ...lblStmts,
    `${ind0}const ${valV} = ${okVar} ? ${valVar} : null`,
    `${ind0}const ${endV} = ${okVar} ? ${endVar} : ${pos}`,
  ]
  return { stmts, valueVar: valV, endVar: endV }
}

function emitSepBy(_p: Combinator<unknown>, def: Extract<ParserDef, { tag: 'sepBy' }>, ctx: Ctx, pos: string): ER {
  const arrV = v(ctx, '_arr')
  const curV = v(ctx, '_cur')

  const { stmts: firstStmts, okVar: firstOk, valVar: firstVal, endVar: firstEnd } =
    emitFallible(def.parser, ctx, pos, true)

  const stmts: string[] = [
    `${ind(ctx)}const ${arrV} = []`,
    `${ind(ctx)}let ${curV} = ${pos}`,
    ...firstStmts,
    `${ind(ctx)}if (${firstOk}) {`,
  ]
  ctx.indent++
  stmts.push(
    `${ind(ctx)}${arrV}.push(${firstVal})`,
    `${ind(ctx)}${curV} = ${firstEnd}`,
    `${ind(ctx)}while (${curV} < input.length) {`,
  )
  ctx.indent++

  // Mirror interpreter sepBy — separate rollback marks for pre-sep and post-sep trivia.
  let sepAtPos = curV
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const markV = v(ctx, '_mk')
      const markTl = v(ctx, '_mktl')
      const markLog = v(ctx, '_mklg')
      const markLv = v(ctx, '_mklv')
      const spV = v(ctx, '_sp')
      // Marks taken BEFORE the separator. If either the separator OR the following
      // item fails, the whole iteration unwinds to here — crucially undoing the
      // separator's own captured leaves (markLv) when the item after it fails.
      stmts.push(
        `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${markLog} = _ctx._triviaLog ? _ctx._triviaLog.length : 0`,
        `${ind(ctx)}const ${markLv} = _ctx._cstLeaves ? _ctx._cstLeaves.length : 0`,
        `${ind(ctx)}const ${spV} = ${capFn}(input, ${curV}, _ctx, 1)`,
      )
      sepAtPos = spV
      const rollbackToSep = `if (_ctx._cstLeaves) _ctx._cstLeaves.length = ${markLv}; if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markV}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${markTl}; if (_ctx._triviaLog) _ctx._triviaLog.length = ${markLog}; `
      const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = emitFallible(def.separator, ctx, sepAtPos, true)
      stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) { ${rollbackToSep}break }`)

      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${capFn}(input, ${sepEnd}, _ctx, 1)`)
      const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } =
        emitFallible(def.parser, ctx, npV, true)
      stmts.push(
        ...nextStmts,
        // item failed → unwind the separator too, back to the end of the last item
        `${ind(ctx)}if (!${nextOk}) { ${rollbackToSep}break }`,
        `${ind(ctx)}${arrV}.push(${nextVal})`,
        `${ind(ctx)}${curV} = ${nextEnd}`,
      )
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const spV = v(ctx, '_sp')
      stmts.push(`${ind(ctx)}const ${spV} = ${trivFn}(input, ${curV}, _ctx)`)
      sepAtPos = spV
      const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = emitFallible(def.separator, ctx, sepAtPos, true)
      stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) break`)

      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${trivFn}(input, ${sepEnd}, _ctx)`)
      const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } =
        emitFallible(def.parser, ctx, npV, true)
      stmts.push(
        ...nextStmts,
        `${ind(ctx)}if (!${nextOk}) break`,
        `${ind(ctx)}${arrV}.push(${nextVal})`,
        `${ind(ctx)}${curV} = ${nextEnd}`,
      )
    }
  } else {
    // No trivia. Still mark the leaf buffers before the separator so that an item
    // failing after the separator unwinds the separator's captured leaves too.
    const markLv = ctx.capturing ? v(ctx, '_mklv') : null
    const markRw = ctx.capturing ? v(ctx, '_mkrw') : null
    if (markLv) {
      stmts.push(
        `${ind(ctx)}const ${markLv} = _ctx._cstLeaves ? _ctx._cstLeaves.length : 0`,
        `${ind(ctx)}const ${markRw} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
      )
    }
    const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = emitFallible(def.separator, ctx, sepAtPos, true)
    stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) break`)
    const nextRb = markLv
      ? `if (_ctx._cstLeaves) _ctx._cstLeaves.length = ${markLv}; if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markRw}; `
      : ''
    const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } =
      emitFallible(def.parser, ctx, sepEnd, true)
    stmts.push(
      ...nextStmts,
      `${ind(ctx)}if (!${nextOk}) { ${nextRb}break }`,
      `${ind(ctx)}${arrV}.push(${nextVal})`,
      `${ind(ctx)}${curV} = ${nextEnd}`,
    )
  }
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

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

  // Skippers — labeled block per skipper; a failure just means "not this one"
  if (def.skip.length > 0) {
    const advV = v(ctx, '_stadv')
    stmts.push(`${ind(ctx)}let ${advV} = false`)
    for (const skipper of def.skip) {
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
  const { stmts, okVar } = emitFallible(def.parser, ctx, pos, true)
  // not() fails (at its own pos) when the inner parser SUCCEEDS; the interpreter
  // reports `not(<innerTag>)` as the expected token — match that label exactly.
  const label = JSON.stringify(`not(${def.parser._tag})`)
  return {
    stmts: [
      ...stmts,
      ...emitIfFail(ctx, okVar, failBody(ctx, label, pos)),
    ],
    valueVar: 'null',
    endVar: pos,
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
  if (lowered) return emitRegex(lowered, ctx, pos)

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
  const sb = v(ctx, '_tokBuf')
  const valV = v(ctx, '_tok')

  return {
    stmts: [
      `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren, ${sv} = _ctx.trivia, ${sk} = _ctx.triviaKindLabels, ${stl} = _ctx._cstTriviaLog, ${sol} = _ctx._triviaLog, ${sb} = _ctx._cstBuf`,
      `${i}_ctx.trivia = undefined; _ctx.triviaKindLabels = undefined; _ctx._cstChildren = undefined; _ctx._cstLeaves = undefined; _ctx._cstRawChildren = undefined; _ctx._cstTriviaLog = undefined; _ctx._triviaLog = undefined; _ctx._cstBuf = undefined`,
      `${i}try {`,
      ...reindentStmts(inner.stmts, ctx.indent + 1).map(stmt => stmt.replace(/^(\s*)(?:const|let)\s+/, '$1var ')),
      `${i}} finally {`,
      `${i}  _ctx.trivia = ${sv}; _ctx.triviaKindLabels = ${sk}; _ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}; _ctx._cstTriviaLog = ${stl}; _ctx._triviaLog = ${sol}; _ctx._cstBuf = ${sb}`,
      `${i}}`,
      ...emitIfFail(ctx, `!${inner.okVar}`, propagateFailBody(ctx)),
      `${i}const ${valV} = input.slice(${pos}, ${inner.endVar})`,
      ...emitLeafCapture(ctx, valV, pos, inner.endVar),
    ],
    valueVar: valV,
    endVar: inner.endVar,
  }
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
  const structural = def.build === undefined
  const mkType = structural ? null : analyzeMkInlineBuild(def)
  let buildIdx: number | null = null
  if (!mkType && !structural) {
    buildIdx = ctx.buildFns.length
    ctx.buildFns.push(def.build!)
    ctx.buildSrcs.push(def.buildSrc ?? null)
  }
  const i = ind(ctx)

  // Arity-gated elision: when the build provably never reads the trivia (4th) or
  // state (5th) arg, skip that capture entirely. The mk-inline path reads
  // `tlV.length` for `localTriviaLen`, so it always keeps trivia capture.
  //
  // A STRUCTURAL node builds via the injected `_ctx.build` host, whose arity is
  // only known at parse time — so instead of defensively capturing both (the old
  // behaviour), gate on what the host reads via the `_hostReads` helper (memoized
  // once per parse on `_ctx._pmCapTL`/`_pmCapST`). Host sig is
  // `(type, children, rawChildren, span, triviaLog, state)`: not reading arg 4
  // (index) means no trivia log, arg 5 means no state (when no host, the default
  // CST embeds `state` → keep the clone). `_hostReads` is conservative — a
  // rest/default param or `arguments` forces full capture, so a spread host never
  // silently loses data. jess hosts are all plain arity-4 → both captures are dead
  // (the cstTriviaLog per-token push dominates — ~28% of a real jess parse).
  const capturesTrivia = mkType !== null || (!structural && buildReadsTrivia(def))
  const clonesState = !structural && buildReadsState(def)

  const chV = v(ctx, '_ch')
  const rawV = v(ctx, '_raw')
  const capTLv = structural ? v(ctx, '_ctl') : null
  const capSTv = structural ? v(ctx, '_cst') : null
  const tlV = capturesTrivia || structural ? v(ctx, '_tl') : '_EMPTY_TL'
  if (!capturesTrivia) ctx.needsEmptyTl = true
  const sc = v(ctx, '_sc'), sl = v(ctx, '_sl'), sr = v(ctx, '_sr'), st = v(ctx, '_st'), stl = v(ctx, '_stl')
  if (structural) ctx.needsHostReads = true
  const allocStmt = structural
    ? `${i}const ${capTLv} = _ctx._pmCapTL ??= _hostReads(_ctx.build, 4), ${capSTv} = _ctx._pmCapST ??= (_ctx.build === undefined || _hostReads(_ctx.build, 5))\n`
      + `${i}const ${chV} = [], ${rawV} = [], ${tlV} = ${capTLv} ? [] : _EMPTY_TL`
    : capturesTrivia
      ? `${i}const ${chV} = [], ${rawV} = [], ${tlV} = []`
      : `${i}const ${chV} = [], ${rawV} = []`
  // When not capturing, set _ctx._cstTriviaLog = undefined so inner trivia terminals'
  // `if (_ctx._cstTriviaLog !== undefined)` guard short-circuits (no per-token push).
  const innerTl = structural ? `${capTLv} ? ${tlV} : undefined` : capturesTrivia ? tlV : 'undefined'
  const stmts: string[] = [
    allocStmt,
    `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren, ${st} = _ctx.captureTrivia, ${stl} = _ctx._cstTriviaLog`,
    `${i}_ctx._cstChildren = ${chV}; _ctx._cstLeaves = ${chV}; _ctx._cstRawChildren = ${rawV}; _ctx.captureTrivia = true; _ctx._cstTriviaLog = ${innerTl}`,
  ]
  const { stmts: innerStmts, okVar, endVar } = emitFallible(def.parser, ctx, pos)
  stmts.push(...innerStmts)
  stmts.push(`${i}_ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}; _ctx.captureTrivia = ${st}; _ctx._cstTriviaLog = ${stl}`)
  // node() returns the inner failure verbatim (interpreter parity) — propagate
  // the recorded deepest failure, not a coarse ["node"] at the node's start.
  stmts.push(...emitIfFail(ctx, `!${okVar}`, propagateFailBody(ctx)))

  let stV = 'undefined'
  if (structural) {
    stV = v(ctx, '_nst')
    stmts.push(`${i}const ${stV} = ${capSTv} && _ctx.state !== undefined ? Object.assign({}, _ctx.state) : undefined`)
  } else if (clonesState) {
    stV = v(ctx, '_nst')
    stmts.push(`${i}const ${stV} = _ctx.state !== undefined ? Object.assign({}, _ctx.state) : undefined`)
  }
  const ndV = v(ctx, '_nd')
  // A structural node's own "builder" is a default positioned CST; a built node's
  // is its inline-mk expr or captured build fn.
  const buildExpr = structural
    ? `{ _tag: 'node', type: ${JSON.stringify(def.type)}, span: { start: ${pos}, end: ${endVar} }, state: ${stV} ?? null, children: ${chV} }`
    : mkType
      ? emitInlineMkNodeExpr(mkType, chV, rawV, pos, endVar, tlV)
      : `${buildRef(ctx)}[${buildIdx!}](${chV}, ${rawV}, { start: ${pos}, end: ${endVar} }, ${tlV}, ${stV})`
  // Modes (RULE_ABI_PLAN §7): a per-parse `_ctx.build` host (keyed by node type)
  // may override construction — so ONE fused grammar serves eval-AST vs
  // positioned-CST modes. Emitted when `ctx.ns` (linkable) OR for a structural
  // node (whose whole point is the injected host). A built standalone node stays
  // byte-identical (no `_ctx.build` branch).
  const ndExpr = ctx.ns || structural
    ? `_ctx.build !== undefined ? _ctx.build(${JSON.stringify(def.type)}, ${chV}, ${rawV}, { start: ${pos}, end: ${endVar} }, ${tlV}, ${stV}) : (${buildExpr})`
    : buildExpr
  // unwrap/collapse: a single captured child IS the value; unwrap turns a leaf
  // into its string, collapse returns the child exactly. Mirrors node.ts.
  const hostCollapseExpr = (ctx.ns || structural)
    ? `_ctx.build !== undefined && _ctx.build._parsemanCstCollapse !== undefined && ${chV}.length === 1 && ${rawV}.length === 1 && _ctx.build._parsemanCstCollapse(${JSON.stringify(def.type)}, ${chV}[0], ${chV}, ${rawV}) ? ${chV}[0] : (${ndExpr})`
    : ndExpr
  const unwrapExpr = `${chV}.length === 1 ? (${chV}[0] !== null && typeof ${chV}[0] === 'object' && ${chV}[0]._tag === 'leaf' ? ${chV}[0].value : ${chV}[0]) : (${ndExpr})`
  const collapseExpr = `${chV}.length === 1 ? ${chV}[0] : (${ndExpr})`
  const finalExpr = def.unwrap
    ? unwrapExpr
    : def.collapse
      ? collapseExpr
    : hostCollapseExpr
  stmts.push(
    `${i}const ${ndV} = ${finalExpr}`,
    `${i}if (${sc}) ${sc}.push(${ndV})`,
    `${i}if (${sr}) ${sr}.push((typeof ${ndV} === 'object' && ${ndV} !== null && (${ndV}._tag === 'node' || ${ndV}._tag === 'leaf' || ${ndV}._tag === 'error')) ? ${ndV} : { _tag: 'leaf', value: typeof ${ndV} === 'string' ? ${ndV} : '', span: { start: ${pos}, end: ${endVar} } })`,
  )

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
        ? `{ _ctx._fe = ${rv}.span.start; _ctx._fx = ${rv}.expected; break ${ctx.failLabel} }`
        : `break ${ctx.failLabel}`)
    : `return { ok: false, expected: ${rv}.expected, span: ${rv}.span }`
  const stmts = [
    `${ind(ctx)}const ${rv} = _rp[${idx}].parse(input, ${pos}, _ctx)`,
    ...emitIfFail(ctx, `!${rv}.ok`, failStmt),
    `${ind(ctx)}const ${vv} = ${rv}.value`,
    `${ind(ctx)}const ${ev} = ${rv}.span.end`,
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
    return emit(resolved, ctx, pos)
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
    ctx.indent    = 1
    ctx.failLabel = '_pfail'  // failures break _pfail (labeled block in fn body)
    // A named fn is compiled ONCE but shared across every call site, so its body
    // must always record `_ctx._fx` — the caller (emitNamedFnCall) decides via
    // its own recordFail whether to propagate. Baking the first caller's
    // (possibly swallowed) recordFail into the shared body would leave `_ctx._fx`
    // unset for other callers that DO read it.
    ctx.recordFail = true
    const r = emit(resolved, ctx, '_pos')
    ctx.indent    = savedIndent
    ctx.failLabel = savedFailLabel
    ctx.recordFail = savedRecord

    pushNamedFnDecl(ctx, fnName, r.stmts, r.valueVar, r.endVar)
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
    `${ind0}  const ${errV} = { _tag: 'parseError', span: { start: ${pos}, end: ${scanV} }, expected: ${JSON.stringify(deriveExpected(def.parser))} }`,
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
  const { stmts: innerStmts, okVar, valVar, endVar } = emitFallible(def.parser, ctx, pos)
  const ind0 = ind(ctx)
  const errV = v(ctx, '_err')
  const stmts: string[] = [
    ...innerStmts,
    `${ind0}if (!${okVar}) {`,
    `${ind0}  const ${errV} = { _tag: 'parseError', span: { start: ${pos}, end: ${pos} }, expected: ${JSON.stringify(def.expected)} }`,
    `${ind0}  if (_ctx._errors) _ctx._errors.push(${errV})`,
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
    ctx.indent    = 1
    ctx.failLabel = '_pfail'  // failures break _pfail (labeled block in the fn body)
    ctx.recordFail = true     // shared body always records; each caller decides propagation
    const r = emitDispatch(p, ctx, '_pos')
    ctx.indent    = savedIndent
    ctx.failLabel = savedFailLabel
    ctx.recordFail = savedRecord
    pushNamedFnDecl(ctx, fnName, r.stmts, r.valueVar, r.endVar)
    return emitNamedFnCall(ctx, fnName, pos)
  }
  return emitDispatch(p, ctx, pos)
}

function emitDispatch(p: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  const def = p._def
  switch (def.tag) {
    case 'literal':   return emitLit(def, ctx, pos)
    case 'regex':     return emitRegex(def, ctx, pos)
    case 'keywords':  return emitKeywords(def, ctx, pos)
    case 'sequence':  return emitSeq(def, ctx, pos)
    case 'choice':    return emitChoice(def, ctx, pos)
    case 'many':
    case 'oneOrMore': return emitMany(def, ctx, pos)
    case 'optional':  return emitOptional(def, ctx, pos)
    case 'sepBy':     return emitSepBy(p, def, ctx, pos)
    case 'transform': {
      const fnSrc = transformFnSource(def.fn, def.fnSrc)
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
    case 'grammar': {
      const savedTrivia = ctx.activeTrivia
      const savedKindLabels = ctx.triviaKindLabels
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
      const r = emit(def.parser, ctx, pos)
      ctx.activeTrivia = savedTrivia
      ctx.triviaKindLabels = savedKindLabels
      return r
    }
    case 'not':     return emitNot(def, ctx, pos)
    case 'node':    return emitNode(def, ctx, pos)
    case 'scanTo':  return emitScanTo(def, ctx, pos)
    case 'recover': return emitRecover(def, ctx, pos)
    case 'expect':  return emitExpect(def, ctx, pos)
    case 'guard': {
      const fnIdx = ctx.mapFns.length
      ctx.mapFns.push(def.predicate as (v: unknown, span: unknown) => unknown)
      ctx.mapFnSrcs.push(null) // keep parallel with mapFns (a guard predicate has no captured source)
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
      ctx.mapFnSrcs.push(null) // keep parallel with mapFns (a withCtx value getter has no captured source)

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
        ctx.indent    = 1
        ctx.failLabel = '_pfail'  // failures break _pfail (same as emitLazy)
        ctx.recordFail = true     // shared body always records (see emitLazy)
        const innerR = emit(innerParser, ctx, '_pos')
        ctx.indent    = savedIndent
        ctx.failLabel = savedFailLabel
        ctx.recordFail = savedRecord
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
export type CompiledParser<T> = {
  parse(input: string, pos?: number): ParseResult<T>
  /** Like parse(), but with a caller-supplied ParseContext (e.g. `_triviaLog` for CST grammars). */
  parseWithContext(input: string, ctx: ParseContext, pos?: number): ParseResult<T>
  /**
   * Like parse(), but activates error recovery. recover() nodes collect their
   * ParseErrors into result.errors instead of (only) embedding them as values.
   * Always returns ParseOk — top-level failures are still ParseFail.
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
}

/**
 * Does this combinator tree contain a node() anywhere (following ref/lazy
 * thunks)? Determines whether the compile emits CST capture — so non-node
 * grammars stay byte-identical. `seen` guards against recursion cycles.
 */
function hasNodeDef(p: Combinator<unknown>, seen: Set<Combinator<unknown>> = new Set()): boolean {
  if (seen.has(p)) return false
  seen.add(p)
  const d = p._def
  switch (d.tag) {
    case 'node':      return true
    case 'lazy':      { try { return hasNodeDef(d.thunk(), seen) } catch { return false } }
    case 'grammar':
    case 'trivia':
    case 'token':
    case 'label':
    case 'optional':
    case 'many':
    case 'oneOrMore':
    case 'not':
    case 'transform': return hasNodeDef(d.parser, seen)
    case 'skip':      return hasNodeDef(d.main, seen) || hasNodeDef(d.skipped, seen)
    case 'sequence':
    case 'choice':    return d.parsers.some(x => hasNodeDef(x, seen))
    case 'sepBy':     return hasNodeDef(d.parser, seen) || hasNodeDef(d.separator, seen)
    case 'scanTo':    return hasNodeDef(d.sentinel, seen) || d.skip.some(x => hasNodeDef(x, seen))
    case 'recover':   return hasNodeDef(d.parser, seen) || hasNodeDef(d.sentinel, seen)
    case 'expect':    return hasNodeDef(d.parser, seen)
    case 'withCtx':   return hasNodeDef(d.parser, seen)
    default:          return false
  }
}

/** Immediate child combinators of a def, for generic tree walks (childrenOf). */
function childrenOf(def: ParserDef): Combinator<unknown>[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':    return def.parsers
    case 'many':
    case 'optional':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'label':
    case 'grammar':
    case 'not':
    case 'node':
    case 'withCtx':
    case 'expect':    return [def.parser]
    // emitMany's oneOrMore branch and emitSepBy both codegen `def.parser` TWICE
    // (a mandatory first match, then again inside the repeat loop) — two real
    // emit() call sites, so the usage analysis must see two edges here or it
    // undercounts a single-use `parser` ref as inline-safe when it's actually
    // referenced from two positions within this one compiled function.
    case 'oneOrMore': return [def.parser, def.parser]
    case 'sepBy':     return [def.parser, def.parser, def.separator]
    case 'skip':      return [def.main, def.skipped]
    case 'recover':   return [def.parser, def.sentinel]
    case 'scanTo':    return [def.sentinel, ...def.skip]
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
  'sequence', 'choice', 'many', 'oneOrMore', 'optional', 'sepBy', 'transform', 'node', 'not',
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
        ? ((p as unknown as { _ruleName?: string })._ruleName ?? nameOf.get(p))
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
export function compile<T>(combinator: Combinator<T>, mapFnSources?: string[]): CompiledParser<T> {
  markUnusedValues(combinator)
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
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
    lazyUsage: analyzeLazyUsage(combinator as Combinator<unknown>),
  }

  const r = emit(combinator as Combinator<unknown>, ctx, '_pos')

  const namedPrelude = ctx.namedFnDecls.length > 0 ? [...namedFnPrelude(), ''] : []
  const emptyTlDecls = ctx.needsEmptyTl ? ['const _EMPTY_TL = Object.freeze([])'] : []
  const hostReadsDecls = ctx.needsHostReads ? [HOST_READS_DECL] : []

  const source = [
    ...emptyTlDecls,
    ...hostReadsDecls,
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    '',
    ...namedPrelude,
    ctx.namedFnDecls.join('\n\n'),
    `function _parse(input, _pos, _rp, _mf, _build, _ctx) {`,
    `  let pos = _pos`,
    ...r.stmts,
    `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
    `}`,
  ].join('\n')

  const fn = new Function('input', '_pos', '_rp', '_mf', '_build', '_ctx', [
    ...emptyTlDecls,
    ...hostReadsDecls,
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    ...namedPrelude,
    ...ctx.namedFnDecls.flatMap((decl, i) => (i > 0 ? ['', decl] : [decl])),
    `let pos = _pos`,
    ...r.stmts,
    `return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
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
  const inlineExpression: string | null = canInline ? buildInlineExpression(ctx, r, effectiveSources, buildSources) : null

  return {
    source,
    inlineExpression,
    parse(input: string, pos = 0): ParseResult<T> {
      return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, defaultCtx)
    },
    parseWithContext(input: string, parseCtx: ParseContext, pos = 0): ParseResult<T> {
      return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, parseCtx)
    },
    // Note: collects recover()/expect() errors via _errors. Unlike interpreter
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

export function compileRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Combinator<unknown>]>,
): { keys: string[]; replacement: string } | null {
  for (const [, rule] of ruleMap) markUnusedValues(rule)
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
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
    lazyUsage: analyzeLazyUsageMulti(ruleMap.map(([, rule]) => rule)),
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

  const perEntry = ruleMap.map(([key, rule]) => ({ key, r: emit(rule, ctx, '_pos') }))

  const derivedSrcs = ctx.mapFnSrcs.length === ctx.mapFns.length && ctx.mapFnSrcs.every((s): s is string => s !== null)
    ? ctx.mapFnSrcs as string[]
    : undefined
  const buildCovered = ctx.buildFns.length === 0 || ctx.buildSrcs.every((s): s is string => s !== null)
  const buildSources = ctx.buildFns.length === 0 ? undefined : (ctx.buildSrcs as string[])
  const mfCovered = ctx.mapFns.length === 0 || derivedSrcs !== undefined
  const canInline = ctx.runtimeParsers.length === 0 && mfCovered && buildCovered
  if (!canInline) return null

  const mfDecl = derivedSrcs?.length ? `  const ${mfRef(ctx)} = [${derivedSrcs.join(', ')}]` : ''
  const buildDecl = buildSources?.length ? `  const ${buildRef(ctx)} = [${buildSources.join(', ')}]` : ''
  const namedPrelude = ctx.namedFnDecls.length > 0 ? namedFnPrelude() : []
  const hoistedDecls = [
    ctx.needsEmptyTl ? `  const _EMPTY_TL = Object.freeze([])` : '',
    ctx.needsHostReads ? `  ${HOST_READS_DECL}` : '',
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

  const entryFnText = (r: ER): string => [
    `function(input, _pos, _ctx) {`,
    `  let pos = _pos`,
    ...r.stmts,
    `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
    `}`,
  ].join('\n')

  // One shared IIFE, evaluated ONCE, returning the whole `{ key: fn, ... }`
  // map — this whole string is the caller's replacement for the entire
  // `rules(factory)` call-expression (NOT one expression per key spliced into
  // a separately-built object literal, which would either re-run the shared
  // prelude per entry or duplicate its text per entry — both defeat the point).
  const objBody = perEntry
    .map(({ key, r }) => `    ${JSON.stringify(key)}: ${entryFnText(r).split('\n').join('\n    ')}`)
    .join(',\n')
  const replacement = [
    `/* @__PURE__ */ (() => {`,
    ...hoistedDecls,
    `  return {`,
    objBody,
    `  }`,
    `})()`,
  ].join('\n')

  return { keys: perEntry.map(e => e.key), replacement }
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
  deps: Map<string, string[]>
  needsEmptyTl: boolean
  needsHostReads: boolean
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
): LinkablePieces | null {
  if (!ns) throw new Error('compileLinkable: ns must be a non-empty namespace')
  for (const [, rule] of ruleMapArg) markUnusedValues(rule)
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
  const ctx: Ctx = {
    vars: 0, indent: 1, regexDecls: [], regexMap: new Map(),
    expectedDecls: [], expectedMap: new Map(), recordFail: true,
    mapFns: [], mapFnSrcs: [], buildFns: [], buildSrcs: [], runtimeParsers: [],
    namedParsers: new Map(), triviaCaptureNames: new Map(),
    triviaFnNames: new Map(), namedFnDecls: [],
    capturing: ruleMap.some(([, rule]) => hasNodeDef(rule)),
    lazyUsage: analyzeLazyUsageMulti(ruleMap.map(([, rule]) => rule)),
    ns,
    deferFirstSetRefs: true,
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
  // source.
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
          if (name && !ctx.namedParsers.has(p)) {
            assertRuleName(name)
            const fn = `_r_${name}`
            ruleNames.set(p, fn)
            ctx.namedParsers.set(p, fn)
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
  const perEntry: Array<{ key: string; r: ER }> = []
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
      ctx.indent = 1; ctx.failLabel = '_pfail'; ctx.recordFail = true
      const body = emit(resolved, ctx, '_pos')
      ctx.indent = savedIndent; ctx.failLabel = savedFail; ctx.recordFail = savedRec
      pushNamedFnDecl(ctx, fn, body.stmts, body.valueVar, body.endVar)
    }
    // Public wrapper: call the named fn, adapt sentinel → ParseResult.
    perEntry.push({ key, r: emitNamedFnCall(ctx, fn, '_pos') })
  }

  // A runtime-parser fallback can't be fused (no source AND no stable identity to
  // inject). Callback fns, by contrast, ARE fusable — inline their source when
  // available (macro), else inject the fn objects via `_env` (runtime).
  if (ctx.runtimeParsers.length !== 0) return null
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
    ...ctx.regexDecls,
    ...ctx.expectedDecls,
    mfDecl,
    buildDecl,
    ...privateFns,
  ].filter(Boolean)

  const wrappers = new Map<string, string>()
  for (const { key, r } of perEntry) {
    wrappers.set(key, [
      `function(input, _pos, _ctx) {`,
      `  let pos = _pos`,
      ...r.stmts,
      `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
      `}`,
    ].join('\n'))
  }

  // Per-rule first-set table for fuse-time dispatch: fusedBody() substitutes each
  // `/*@FS:rule:codevar@*​/true` placeholder (emitted for rule-ref choice arms)
  // with the WINNING rule's condition. Resolve each rule to its real first-set;
  // a rule that can match empty at start gets `any` (→ no guard, always try).
  const firstSets = new Map<string, FirstSet>()
  for (const [key, rule] of ruleMap) {
    let resolved: Combinator<unknown> = rule
    const d = rule._def
    if (d.tag === 'lazy') { try { resolved = d.thunk() } catch { resolved = rule } }
    firstSets.set(key, canMatchEmptyAtStart(resolved) ? { kind: 'any' } : resolved._meta.firstSet)
  }

  return {
    ns,
    keys: perEntry.map(e => e.key),
    prelude,
    ruleFns,
    wrappers,
    firstSets,
    deps: ruleDependencies(ruleMap),
    needsEmptyTl: !!ctx.needsEmptyTl,
    needsHostReads: !!ctx.needsHostReads,
    mfFns: mfSrcs ? [] : (ctx.mapFns as ReadonlyArray<(...a: unknown[]) => unknown>),
    buildFns: buildSrcs ? [] : (ctx.buildFns as ReadonlyArray<(...a: unknown[]) => unknown>),
  }
}

function buildInlineExpression(
  ctx: Ctx,
  r: ER,
  mapFnSources?: string[],
  buildSources?: string[],
): string {
  const bodyLines = [
    `  let pos = _pos`,
    ...r.stmts,
    `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
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
  const needsWrapper = ctx.regexDecls.length > 0 || ctx.expectedDecls.length > 0 || ctx.namedFnDecls.length > 0 || !!mfDecl || !!buildDecl || !!emptyTlDecl || !!hostReadsDecl
  if (!needsWrapper) return innerFn

  const namedPrelude = ctx.namedFnDecls.length > 0 ? namedFnPrelude() : []
  const hoistedDecls = [
    emptyTlDecl,
    hostReadsDecl,
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
