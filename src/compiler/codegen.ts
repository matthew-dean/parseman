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
  /** Whether any case-insensitive lit was emitted (needs collator) */
  needsCollator: boolean
  /** Lazy/ref parsers and trivia helpers: parser identity → generated function name */
  namedParsers: Map<Combinator<unknown>, string>
  /** Generated function declaration strings, prepended before the main body */
  namedFnDecls: string[]
  /** Active trivia parser (set by grammar() wrappers, cleared on exit) */
  activeTrivia?: Combinator<unknown>
  /**
   * Whether this compile contains any node() rule. When true, terminals emit a
   * `_ctx._cstLeaves` capture and trivia skips capture trivia tokens — flowing
   * through `_ctx` so capture crosses named-function (ref) boundaries correctly.
   * When false (no node() anywhere) NO capture code is emitted, so non-CST
   * grammars compile byte-identically to before.
   */
  capturing?: boolean
  /** Inside the trivia-capture fn: terminals emit CSTTrivia tokens, not leaves. */
  capAsTrivia?: boolean
  /** Trivia parser → name of its capturing variant fn (separate from namedParsers). */
  triviaCaptureNames: Map<Combinator<unknown>, string>
  /**
   * Trivia parser → name of its fast number-returning variant fn (non-capturing
   * mode). Returns the new position directly instead of a {ok,value,span} object,
   * eliminating two object allocations per trivia skip.
   */
  triviaFnNames: Map<Combinator<unknown>, string>
  /** node() build functions captured at compile time (parallel to buildSrcs). */
  buildFns: Array<(children: ReadonlyArray<unknown>, raw: ReadonlyArray<unknown>, span: { start: number; end: number }, triviaLog: readonly number[]) => unknown>
  /** Source text of each build fn (set from def.buildSrc; null when unavailable). */
  buildSrcs: Array<string | null>
  /**
   * When set, `failStmt` emits `break <label>` instead of `return { ok: false }`.
   * Used by emitFallible to let labeled blocks act as the failure boundary.
   */
  failLabel?: string
}

function v(ctx: Ctx, prefix = '_v'): string { return `${prefix}${ctx.vars++}` }
function ind(ctx: Ctx): string { return '  '.repeat(ctx.indent) }

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
  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx) {`,
    `  let _pfok = false, _pfv, _pfe = _pos`,
    `  _pfail: {`,
    ...bodyStmts,
    `  _pfv = ${valueVar}; _pfe = ${endVar}; _pfok = true`,
    `  }`,
    `  if (!_pfok) return ${NAMED_FN_FAIL}`,
    `  ${NAMED_FN_END} = _pfe`,
    `  return _pfv`,
    `}`,
  ].join('\n'))
}

function emitNamedFnCall(ctx: Ctx, fnName: string, pos: string, failExpected: string): ER {
  const vv = v(ctx, '_pfv')
  const ev = v(ctx, '_pfe')
  return {
    stmts: [
      `${ind(ctx)}const ${vv} = ${fnName}(input, ${pos}, _ctx)`,
      `${ind(ctx)}if (${vv} === ${NAMED_FN_FAIL}) ${failStmt({ ...ctx, indent: 0 }, failExpected, pos).trim()}`,
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
  // Inside the trivia-capture fn, suppress leaf capture — the whole trivia run
  // is recorded as a flat [start, end, insertIdx] triple by ensureTriviaCaptureFn.
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

/**
 * Compile a capturing variant of the active trivia parser: `_tcN(input, pos, _ctx)`
 * records each trivia run as a flat [start, end, insertIdx] triple in
 * `_ctx._cstTriviaLog` (zero object allocations) and returns the new position.
 * Built at most once per trivia parser.
 */
function ensureTriviaCaptureFn(ctx: Ctx): string {
  const trivia = ctx.activeTrivia!
  const existing = ctx.triviaCaptureNames.get(trivia)
  if (existing) return existing
  const fnName = `_tc${ctx.triviaCaptureNames.size}`
  ctx.triviaCaptureNames.set(trivia, fnName)

  const saved = { indent: ctx.indent, failLabel: ctx.failLabel, asTrivia: ctx.capAsTrivia, trivia: ctx.activeTrivia }
  ctx.indent = 2
  ctx.failLabel = '_cap'
  ctx.capAsTrivia = true
  delete ctx.activeTrivia  // trivia parser must not skip trivia within itself
  const r = emit(trivia, ctx, '_pos')
  ctx.indent = saved.indent; ctx.failLabel = saved.failLabel
  ctx.capAsTrivia = saved.asTrivia
  if (saved.trivia) ctx.activeTrivia = saved.trivia

  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx) {`,
    `  let _e = _pos`,
    `  _cap: {`,
    ...r.stmts,
    `    _e = ${r.endVar}`,
    `  }`,
    `  if (_e > _pos) {`,
    `    if (_ctx._triviaLog !== undefined) _ctx._triviaLog.push(_pos, _e)`,
    `    if (_ctx._cstTriviaLog !== undefined) _ctx._cstTriviaLog.push(_pos, _e, _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0)`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n'))
  return fnName
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
function failStmt(ctx: Ctx, expected: string, posExpr: string): string {
  if (ctx.failLabel) return `${ind(ctx)}break ${ctx.failLabel}`
  return `${ind(ctx)}return { ok: false, expected: [${expected}], span: { start: ${posExpr}, end: ${posExpr} } }`
}

/** Like failStmt but `expectedArr` is already a full JS array expression e.g. `["a","b"]`. */
function failArr(ctx: Ctx, expectedArr: string, posExpr: string): string {
  if (ctx.failLabel) return `${ind(ctx)}break ${ctx.failLabel}`
  return `${ind(ctx)}return { ok: false, expected: ${expectedArr}, span: { start: ${posExpr}, end: ${posExpr} } }`
}

function firstSetCond(codeVar: string, fs: FirstSet): string {
  if (fs.kind === 'any') return 'true'
  if (fs.kind === 'empty') return 'false'
  return fs.ranges.map(r =>
    r.lo === r.hi
      ? `${codeVar} === ${r.lo}`
      : `(${codeVar} >= ${r.lo} && ${codeVar} <= ${r.hi})`
  ).join(' || ')
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
): { stmts: string[]; okVar: string; valVar: string; endVar: string } {
  const lbl  = v(ctx, '_lbl')
  const okV  = `${lbl}ok`
  const valV = `${lbl}v`
  const endV = `${lbl}e`

  const savedLabel  = ctx.failLabel
  const savedIndent = ctx.indent
  ctx.failLabel = lbl
  ctx.indent    = 0
  const r = emit(inner, ctx, pos)
  ctx.failLabel = savedLabel
  ctx.indent    = savedIndent

  const ind0 = ind(ctx)
  const stmts = [
    `${ind0}let ${okV} = false, ${valV}, ${endV} = ${pos}`,
    `${ind0}${lbl}: {`,
    ...r.stmts,
    `${ind0}  ${valV} = ${r.valueVar}`,
    `${ind0}  ${endV} = ${r.endVar}`,
    `${ind0}  ${okV} = true`,
    `${ind0}}`,
  ]
  return { stmts, okVar: okV, valVar: valV, endVar: endV }
}


// ---------------------------------------------------------------------------
// Per-combinator emitters
// ---------------------------------------------------------------------------

function emitLit(def: Extract<ParserDef, { tag: 'literal' }>, ctx: Ctx, pos: string): ER {
  const { value, caseInsensitive } = def
  const len = value.length
  const vv = v(ctx)
  const expectedStr = JSON.stringify(JSON.stringify(value))
  const stmts: string[] = []

  if (caseInsensitive) {
    ctx.needsCollator = true
    stmts.push(
      `${ind(ctx)}if (${pos} + ${len} > input.length) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
      `${ind(ctx)}const ${vv}_s = input.slice(${pos}, ${pos} + ${len})`,
      `${ind(ctx)}if (_collator.compare(${vv}_s, ${JSON.stringify(value)}) !== 0) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
      `${ind(ctx)}const ${vv} = ${vv}_s`,
    )
  } else if (len === 0) {
    stmts.push(`${ind(ctx)}const ${vv} = ''`)
  } else if (len === 1) {
    const code = value.codePointAt(0)!
    stmts.push(
      `${ind(ctx)}if (${pos} >= input.length || input.charCodeAt(${pos}) !== ${code}) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  } else if (len <= 4) {
    const checks = Array.from({ length: len }, (_, i) =>
      `input.charCodeAt(${pos}${i > 0 ? ` + ${i}` : ''}) !== ${value.codePointAt(i)!}`
    ).join(' || ')
    stmts.push(
      `${ind(ctx)}if (${pos} + ${len} > input.length || ${checks}) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  } else {
    // startsWith(str, pos) avoids allocating a slice — it handles the bounds check
    // internally and compares in-place. No first-char guard needed either.
    stmts.push(
      `${ind(ctx)}if (!input.startsWith(${JSON.stringify(value)}, ${pos})) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
      `${ind(ctx)}const ${vv} = ${JSON.stringify(value)}`,
    )
  }

  const endVar = len === 0 ? pos : `${pos} + ${len}`
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

function emitRegex(def: Extract<ParserDef, { tag: 'regex' }>, ctx: Ctx, pos: string): ER {
  const flags = 'y' + def.flags.replace(/[gy]/g, '')
  const key = `${def.optimizedSource}/${flags}`
  let rName = ctx.regexMap.get(key)
  if (rName === undefined) {
    rName = `_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${rName} = /${def.optimizedSource}/${flags}`)
    ctx.regexMap.set(key, rName)
  }

  const mv = v(ctx, '_m')
  const vv = v(ctx)
  const expectedStr = JSON.stringify(`/${def.source}/`)
  const stmts = [
    `${ind(ctx)}${rName}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${mv} = ${rName}.exec(input)`,
    `${ind(ctx)}if (${mv} === null) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
    `${ind(ctx)}const ${vv} = ${mv}[0]`,
  ]
  const endVar = `${pos} + ${vv}.length`
  stmts.push(...emitLeafCapture(ctx, vv, pos, endVar))
  return { stmts, valueVar: vv, endVar }
}

/**
 * Ensure the active trivia parser has a fast number-returning compiled function,
 * then return its name. Kept separate from namedParsers (which return {ok,value,span})
 * so the two registries don't conflict if the same combinator appears in both roles.
 *
 * The generated function returns the new position as a number (or _pos unchanged on
 * failure) — eliminating two object allocations per trivia skip vs. the old pattern.
 */
function ensureTriviaFn(ctx: Ctx): string {
  const trivia = ctx.activeTrivia!
  const existing = ctx.triviaFnNames.get(trivia)
  if (existing) return existing
  const fnName = `_tf${ctx.triviaFnNames.size}`
  ctx.triviaFnNames.set(trivia, fnName)

  const savedIndent    = ctx.indent
  const savedFailLabel = ctx.failLabel
  const savedTrivia    = ctx.activeTrivia
  ctx.indent    = 2
  ctx.failLabel = '_triv'
  delete ctx.activeTrivia  // trivia parser must not skip trivia within itself
  const r = emit(trivia, ctx, '_pos')
  ctx.indent    = savedIndent
  ctx.failLabel = savedFailLabel
  if (savedTrivia) ctx.activeTrivia = savedTrivia

  ctx.namedFnDecls.push([
    `function ${fnName}(input, _pos, _ctx) {`,
    `  let _e = _pos`,
    `  _triv: {`,
    ...r.stmts,
    `    _e = ${r.endVar}`,
    `  }`,
    `  return _e`,
    `}`,
  ].join('\n'))
  return fnName
}

function emitSeq(def: Extract<ParserDef, { tag: 'sequence' }>, ctx: Ctx, pos: string): ER {
  const startV = v(ctx, '_start')
  const curV = v(ctx, '_cur')
  const stmts: string[] = [
    `${ind(ctx)}const ${startV} = ${pos}`,
    `${ind(ctx)}let ${curV} = ${pos}`,
  ]
  const valueVars: string[] = []

  for (let i = 0; i < def.parsers.length; i++) {
    // Mirror interpreter sequence.ts:27 — skip trivia before each item except the first.
    if (i > 0 && ctx.activeTrivia) {
      if (ctx.capturing) {
        // Capture trivia into _ctx._cstRawChildren. A sequence commits all terms,
        // so no rollback is needed (a later failure discards the node's collectors).
        const capFn = ensureTriviaCaptureFn(ctx)
        stmts.push(`${ind(ctx)}${curV} = ${capFn}(input, ${curV}, _ctx)`)
      } else {
        const trivFn = ensureTriviaFn(ctx)
        stmts.push(`${ind(ctx)}${curV} = ${trivFn}(input, ${curV}, _ctx)`)
      }
    }
    const r = emit(def.parsers[i]!, ctx, curV)
    stmts.push(...r.stmts, `${ind(ctx)}${curV} = ${r.endVar}`)
    valueVars.push(r.valueVar)
  }

  const arrV = v(ctx, '_arr')
  stmts.push(`${ind(ctx)}const ${arrV} = [${valueVars.join(', ')}]`)
  return { stmts, valueVar: arrV, endVar: curV }
}

function emitChoice(def: Extract<ParserDef, { tag: 'choice' }>, ctx: Ctx, pos: string): ER {
  const allExpected = JSON.stringify(
    def.parsers.map(p => {
      const d = p._def
      if (d.tag === 'literal') return JSON.stringify(d.value)
      if (d.tag === 'regex') return `/${d.source}/`
      return p._tag
    })
  )

  // ── Disjoint: O(1) first-char dispatch ──────────────────────────────────
  if (def.disjoint) {
    const codeV = v(ctx, '_code')
    const valV = v(ctx, '_chv')
    const endV = v(ctx, '_che')
    const stmts: string[] = [
      `${ind(ctx)}const ${codeV} = ${pos} < input.length ? (input.codePointAt(${pos}) ?? -1) : -1`,
      `${ind(ctx)}let ${valV}, ${endV} = ${pos}`,
    ]

    let first = true
    for (const p of def.parsers) {
      const cond = firstSetCond(codeV, p._meta.firstSet)
      const kw = first ? 'if' : 'else if'
      first = false
      stmts.push(`${ind(ctx)}${kw} (${cond}) {`)
      ctx.indent++
      const r = emit(p, ctx, pos)
      stmts.push(...r.stmts)
      stmts.push(`${ind(ctx)}${valV} = ${r.valueVar}; ${endV} = ${r.endVar}`)
      ctx.indent--
      stmts.push(`${ind(ctx)}}`)
    }
    stmts.push(`${ind(ctx)}else ${failArr({ ...ctx, indent: 0 }, allExpected, pos)}`)
    return { stmts, valueVar: valV, endVar: endV }
  }

  return emitNonDisjoint(def, def.strategy, allExpected, ctx, pos)
}

// ── greedyClassify: run the super-regex once, classify by string equality ────
// Single regex exec + O(n_literals) string comparisons. Zero backtracking.
function emitGreedyClassify(
  def: Extract<ParserDef, { tag: 'choice' }>,
  superIndex: number,
  allExpected: string,
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
    reVar = `_re${ctx.regexDecls.length}`
    ctx.regexDecls.push(`const ${reVar} = /${regexDef.source}/${cleanFlags}`)
    ctx.regexMap.set(reKey, reVar)
  }

  const matchV = v(ctx, '_gm')
  const wordV  = v(ctx, '_gw')
  const endV   = v(ctx, '_ge')

  const stmts: string[] = [
    `${ind(ctx)}${reVar}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${matchV} = ${reVar}.exec(input)`,
    `${ind(ctx)}if (${matchV} === null) ${failArr({ ...ctx, indent: 0 }, allExpected, pos)}`,
    `${ind(ctx)}const ${wordV} = ${matchV}[0]`,
    `${ind(ctx)}const ${endV} = ${pos} + ${wordV}.length`,
  ]

  // For each literal arm: if word === literal, apply its transform chain and return
  for (let i = 0; i < def.parsers.length; i++) {
    if (i === superIndex) continue
    const p = def.parsers[i]!
    const litVal = getCoreLiteralValue(p)
    if (litVal === null) continue

    stmts.push(`${ind(ctx)}if (${wordV} === ${JSON.stringify(litVal)}) {`)
    ctx.indent++
    const tR = emitTransformChain(p, JSON.stringify(litVal), endV, pos, ctx)
    stmts.push(...tR.stmts)
    stmts.push(`${ind(ctx)}return { ok: true, value: ${tR.valueVar}, span: { start: ${pos}, end: ${endV} } }`)
    ctx.indent--
    stmts.push(`${ind(ctx)}}`)
  }

  // Regex arm: apply its transform chain to the matched word
  const rR = emitTransformChain(superParser, wordV, endV, pos, ctx)
  stmts.push(...rR.stmts)
  return { stmts, valueVar: rR.valueVar, endVar: endV }
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

    stmts.push(`${ind(ctx)}${kw} (${litCond}) {`)
    ctx.indent++
    const tR = emitTransformChain(p, JSON.stringify(litVal), `${pos} + ${litLen}`, pos, ctx)
    stmts.push(...tR.stmts, `${ind(ctx)}${valV} = ${tR.valueVar}; ${endV} = ${pos} + ${litLen}`)
    ctx.indent--
    stmts.push(`${ind(ctx)}}`)
  }
  stmts.push(`${ind(ctx)}else ${failArr({ ...ctx, indent: 0 }, allExpected, pos)}`)

  return { stmts, valueVar: valV, endVar: endV }
}

// ── firstMatch fallback: PEG + auto-not inline rejection + per-arm gates ─────
// Uses labeled blocks (emitFallible) instead of IIFE+try/catch to avoid V8
// deoptimization from exception-based control flow.
function emitFirstMatch(
  def: Extract<ParserDef, { tag: 'choice' }>,
  allExpected: string,
  ctx: Ctx,
  pos: string,
): ER {
  const resValV = v(ctx, '_crv')
  const resEndV = v(ctx, '_cre')
  const resOkV  = v(ctx, '_crok')
  const ind0 = ind(ctx)
  const stmts: string[] = [
    `${ind0}let ${resValV}, ${resEndV} = ${pos}, ${resOkV} = false`,
  ]

  for (let i = 0; i < def.parsers.length; i++) {
    const p = def.parsers[i]!
    const gate    = def.gates[i]
    const autoNot = def.autoNot[i]

    // Gate: register predicate in mapFns; condition guards entire arm attempt
    let gateCond: string | null = null
    if (gate) {
      const gateIdx = ctx.mapFns.length
      ctx.mapFns.push(gate as (v: unknown, span: unknown) => unknown)
      gateCond = `_mf[${gateIdx}](_ctx.state)`
    }
    const skipCond = gateCond ? `!${resOkV} && ${gateCond}` : `!${resOkV}`

    // In capturing mode, save leaf-array lengths before the arm so we can roll
    // back any leaves pushed by a failed or auto-not-rejected arm.
    const markLeaves = ctx.capturing ? v(ctx, '_cml') : null
    const markRaw    = ctx.capturing ? v(ctx, '_cmr') : null
    const rollback   = markLeaves
      ? `if (_ctx._cstLeaves) _ctx._cstLeaves.length = ${markLeaves}; if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markRaw}`
      : ''

    stmts.push(`${ind0}if (${skipCond}) {`)

    // Bump indent so emitFallible's labeled block sits inside the `if` body
    ctx.indent++
    const ind1 = ind(ctx)
    if (markLeaves) {
      stmts.push(
        `${ind1}const ${markLeaves} = _ctx._cstLeaves?.length ?? 0`,
        `${ind1}const ${markRaw} = _ctx._cstRawChildren?.length ?? 0`,
      )
    }
    const { stmts: armStmts, okVar, valVar, endVar } = emitFallible(p, ctx, pos)
    stmts.push(...armStmts)
    ctx.indent--

    if (autoNot && autoNot.length > 0) {
      const anCode = v(ctx, '_anc')
      const rejectCond = autoNot.map(check =>
        check.kind === 'firstSet'
          ? firstSetCond(anCode, check.set)
          : `input.startsWith(${JSON.stringify(check.value)}, ${endVar})`
      ).join(' || ')
      stmts.push(
        `${ind0}  if (${okVar}) { const ${anCode} = ${endVar} < input.length ? input.charCodeAt(${endVar}) : -1; if (!(${rejectCond})) { ${resValV} = ${valVar}; ${resEndV} = ${endVar}; ${resOkV} = true } }`,
      )
      if (rollback) stmts.push(`${ind0}  if (!${resOkV}) { ${rollback} }`)
    } else {
      stmts.push(`${ind0}  if (${okVar}) { ${resValV} = ${valVar}; ${resEndV} = ${endVar}; ${resOkV} = true }`)
      if (rollback) stmts.push(`${ind0}  else { ${rollback} }`)
    }
    stmts.push(`${ind0}}`)
  }
  stmts.push(`${ind0}if (!${resOkV}) ${failArr({ ...ctx, indent: 0 }, allExpected, pos)}`)
  return { stmts, valueVar: resValV, endVar: resEndV }
}

function emitNonDisjoint(
  def: Extract<ParserDef, { tag: 'choice' }>,
  strategy: ChoiceStrategy,
  allExpected: string,
  ctx: Ctx,
  pos: string,
): ER {
  // greedyClassify / literalsLongestFirst match literals via a super-regex or
  // direct charCode checks and skip emitLit — so they DON'T emit leaf capture.
  // In a capturing compile, fall back to firstMatch (which emits each arm via
  // emit() and captures correctly). Non-CST grammars keep the optimizations.
  if (!ctx.capturing) {
    if (strategy.tag === 'greedyClassify')
      return emitGreedyClassify(def, strategy.superIndex, allExpected, ctx, pos)
    if (strategy.tag === 'literalsLongestFirst')
      return emitLiteralsLongestFirst(def, strategy.sortedIndices, allExpected, ctx, pos)
  }
  return emitFirstMatch(def, allExpected, ctx, pos)
}

// ── helpers for emitGreedyClassify / emitLiteralsLongestFirst ────────────────

/** Apply transform chain only — no parsing, value already known. */
function emitTransformChain(p: Combinator<unknown>, baseValue: string, endV: string, startPos: string, ctx: Ctx): ER {
  const def = p._def
  if (def.tag === 'transform') {
    const innerR = emitTransformChain(def.parser, baseValue, endV, startPos, ctx)
    const fnIdx = ctx.mapFns.length
    ctx.mapFns.push(def.fn)
    ctx.mapFnSrcs.push(def.fnSrc ?? null)
    const vv = v(ctx)
    return {
      stmts: [...innerR.stmts, `${ind(ctx)}const ${vv} = _mf[${fnIdx}](${innerR.valueVar}, { start: ${startPos}, end: ${endV} })`],
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
  if (len > 4) return `input.startsWith(${JSON.stringify(litVal)}, ${pos})`
  // Short string: charCodeAt checks (same as emitLit)
  const checks = [`${pos} + ${len} <= input.length`]
  for (let i = 0; i < len; i++) {
    const code = litVal.codePointAt(i)!
    checks.push(`input.charCodeAt(${pos}${i > 0 ? ` + ${i}` : ''}) === ${code}`)
  }
  return checks.join(' && ')
}

function emitMany(def: Extract<ParserDef, { tag: 'many' | 'oneOrMore' }>, ctx: Ctx, pos: string): ER {
  const arrV = v(ctx, '_arr')
  const curV = v(ctx, '_cur')
  const stmts: string[] = [
    `${ind(ctx)}const ${arrV} = []`,
    `${ind(ctx)}let ${curV} = ${pos}`,
  ]

  if (def.min === 1) {
    // Inline first mandatory match with early-return on failure
    const firstR = emit(def.parser, ctx, curV)
    stmts.push(...firstR.stmts)
    stmts.push(
      `${ind(ctx)}${arrV}.push(${firstR.valueVar})`,
      `${ind(ctx)}${curV} = ${firstR.endVar}`,
    )
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
      const npV = v(ctx, '_np')
      stmts.push(
        `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
        `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
        `${ind(ctx)}const ${npV} = ${capFn}(input, ${curV}, _ctx)`,
      )
      itemPos = npV
      rollback = `if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markV}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${markTl}; `
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${trivFn}(input, ${curV}, _ctx)`)
      itemPos = npV
    }
  }

  const { stmts: iterStmts, okVar: iterOk, valVar: iterVal, endVar: iterEnd } = emitFallible(def.parser, ctx, itemPos)
  stmts.push(
    ...iterStmts,
    `${ind(ctx)}if (!${iterOk} || ${iterEnd} === ${curV}) { ${rollback}break }`,
    `${ind(ctx)}${arrV}.push(${iterVal})`,
    `${ind(ctx)}${curV} = ${iterEnd}`,
  )
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  return { stmts, valueVar: arrV, endVar: curV }
}

function emitOptional(def: Extract<ParserDef, { tag: 'optional' }>, ctx: Ctx, pos: string): ER {
  const valV = v(ctx, '_opt')
  const endV = v(ctx, '_opte')

  const { stmts: lblStmts, okVar, valVar, endVar } = emitFallible(def.parser, ctx, pos)

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
    emitFallible(def.parser, ctx, pos)

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

  // Mirror interpreter repeat.ts — skip trivia before and after separator. In
  // capture mode, mark rawChildren before the separator's trivia and roll back
  // if neither the separator nor the next item materializes (trailing trivia).
  let rollback = ''
  if (ctx.capturing) {
    const markV = v(ctx, '_mk')
    const markTl = v(ctx, '_mktl')
    stmts.push(
      `${ind(ctx)}const ${markV} = _ctx._cstRawChildren ? _ctx._cstRawChildren.length : 0`,
      `${ind(ctx)}const ${markTl} = _ctx._cstTriviaLog ? _ctx._cstTriviaLog.length : 0`,
    )
    rollback = `if (_ctx._cstRawChildren) _ctx._cstRawChildren.length = ${markV}; if (_ctx._cstTriviaLog) _ctx._cstTriviaLog.length = ${markTl}; `
  }

  let sepAtPos = curV
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const spV = v(ctx, '_sp')
      stmts.push(`${ind(ctx)}const ${spV} = ${capFn}(input, ${curV}, _ctx)`)
      sepAtPos = spV
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const spV = v(ctx, '_sp')
      stmts.push(`${ind(ctx)}const ${spV} = ${trivFn}(input, ${curV}, _ctx)`)
      sepAtPos = spV
    }
  }

  const { stmts: sepStmts, okVar: sepOk, endVar: sepEnd } = emitFallible(def.separator, ctx, sepAtPos)
  stmts.push(...sepStmts, `${ind(ctx)}if (!${sepOk}) { ${rollback}break }`)

  let nextAtPos = sepEnd
  if (ctx.activeTrivia) {
    if (ctx.capturing) {
      const capFn = ensureTriviaCaptureFn(ctx)
      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${capFn}(input, ${sepEnd}, _ctx)`)
      nextAtPos = npV
    } else {
      const trivFn = ensureTriviaFn(ctx)
      const npV = v(ctx, '_np')
      stmts.push(`${ind(ctx)}const ${npV} = ${trivFn}(input, ${sepEnd}, _ctx)`)
      nextAtPos = npV
    }
  }

  const { stmts: nextStmts, okVar: nextOk, valVar: nextVal, endVar: nextEnd } =
    emitFallible(def.parser, ctx, nextAtPos)
  stmts.push(
    ...nextStmts,
    `${ind(ctx)}if (!${nextOk}) { ${rollback}break }`,
    `${ind(ctx)}${arrV}.push(${nextVal})`,
    `${ind(ctx)}${curV} = ${nextEnd}`,
  )
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
  const probeCtx: Ctx = { ...ctx, capturing: false }

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
    stmts.push(`${ind(ctx)}if (!${foundV}) ${failArr({ ...ctx, indent: 0 }, expectedStr, pos)}`)
  }

  const valV = v(ctx)
  stmts.push(`${ind(ctx)}const ${valV} = input.slice(${pos}, ${curV})`)
  // scanTo records its scanned span as one leaf (matching the interpreter), but
  // only when it actually consumed something.
  if (ctx.capturing) {
    const cap = emitLeafCapture(ctx, valV, pos, curV).map(s => '  ' + s)
    stmts.push(`${ind(ctx)}if (${curV} > ${pos}) {`, ...cap, `${ind(ctx)}}`)
  }
  return { stmts, valueVar: valV, endVar: curV }
}

/**
 * Negative lookahead. Run the inner parser in a labeled block; if it succeeds,
 * fail; if it fails, succeed consuming nothing (value null, end === pos).
 */
function emitNot(def: Extract<ParserDef, { tag: 'not' }>, ctx: Ctx, pos: string): ER {
  const { stmts, okVar } = emitFallible(def.parser, ctx, pos)
  return {
    stmts: [
      ...stmts,
      `${ind(ctx)}if (${okVar}) ${failStmt({ ...ctx, indent: 0 }, '"not"', pos).trim()}`,
    ],
    valueVar: 'null',
    endVar: pos,
  }
}

/**
 * CST node rule. Collects the inner parse's terminals/trivia into fresh local
 * arrays (capture is emitted inline by the terminals while capChildren is set),
 * calls the build fn, then records the node in the enclosing node()'s collectors.
 */
function emitNode(def: Extract<ParserDef, { tag: 'node' }>, ctx: Ctx, pos: string): ER {
  const fnIdx = ctx.buildFns.length
  ctx.buildFns.push(def.build)
  ctx.buildSrcs.push(def.buildSrc ?? null)
  const i = ind(ctx)

  const chV = v(ctx, '_ch')
  const rawV = v(ctx, '_raw')
  const tlV = v(ctx, '_tl')
  // Save the caller's collectors, install this node's, parse, then restore —
  // capture flows through _ctx so it crosses ref/named-fn boundaries. The inner
  // runs inside a labeled block (emitFallible) so the collectors are restored on
  // BOTH success and failure — otherwise a failed alternative in a choice would
  // leave _ctx pointing at its discarded array and the next alternative would
  // capture into the wrong place.
  const sc = v(ctx, '_sc'), sl = v(ctx, '_sl'), sr = v(ctx, '_sr'), st = v(ctx, '_st'), stl = v(ctx, '_stl')
  const stmts: string[] = [
    `${i}const ${chV} = [], ${rawV} = [], ${tlV} = []`,
    `${i}const ${sc} = _ctx._cstChildren, ${sl} = _ctx._cstLeaves, ${sr} = _ctx._cstRawChildren, ${st} = _ctx.captureTrivia, ${stl} = _ctx._cstTriviaLog`,
    `${i}_ctx._cstChildren = ${chV}; _ctx._cstLeaves = ${chV}; _ctx._cstRawChildren = ${rawV}; _ctx.captureTrivia = true; _ctx._cstTriviaLog = ${tlV}`,
  ]
  const { stmts: innerStmts, okVar, endVar } = emitFallible(def.parser, ctx, pos)
  stmts.push(...innerStmts)
  stmts.push(`${i}_ctx._cstChildren = ${sc}; _ctx._cstLeaves = ${sl}; _ctx._cstRawChildren = ${sr}; _ctx.captureTrivia = ${st}; _ctx._cstTriviaLog = ${stl}`)
  stmts.push(`${i}if (!${okVar}) ${failStmt({ ...ctx, indent: 0 }, '"node"', pos).trim()}`)

  const ndV = v(ctx, '_nd')
  stmts.push(
    `${i}const ${ndV} = _build[${fnIdx}](${chV}, ${rawV}, { start: ${pos}, end: ${endVar} }, ${tlV})`,
    // Record into the caller's collectors (the node in children; the node, or a
    // spanned leaf if build collapsed to a non-node value, in rawChildren).
    `${i}if (${sc}) ${sc}.push(${ndV})`,
    `${i}if (${sr}) ${sr}.push((typeof ${ndV} === 'object' && ${ndV} !== null && ${ndV}._tag === 'node') ? ${ndV} : { _tag: 'leaf', value: typeof ${ndV} === 'string' ? ${ndV} : '', span: { start: ${pos}, end: ${endVar} } })`,
  )

  return { stmts, valueVar: ndV, endVar }
}

function emitRuntimeFallback(parser: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  const idx = ctx.runtimeParsers.length
  ctx.runtimeParsers.push(parser)
  const rv = v(ctx, '_rt')
  const vv = v(ctx, '_rtv')
  const ev = v(ctx, '_rte')
  const stmts = [
    `${ind(ctx)}const ${rv} = _rp[${idx}].parse(input, ${pos}, _ctx)`,
    `${ind(ctx)}if (!${rv}.ok) ${failStmt({ ...ctx, indent: 0 }, '"runtime"', pos).trim()}`,
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
  if (!ctx.namedParsers.has(p)) {
    const fnName = `_pf${ctx.namedParsers.size}`
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
    ctx.indent    = 1
    ctx.failLabel = '_pfail'  // failures break _pfail (labeled block in fn body)
    const r = emit(resolved, ctx, '_pos')
    ctx.indent    = savedIndent
    ctx.failLabel = savedFailLabel

    pushNamedFnDecl(ctx, fnName, r.stmts, r.valueVar, r.endVar)
  }

  const fnName = ctx.namedParsers.get(p)!
  return emitNamedFnCall(ctx, fnName, pos, '"parser"')
}

// ── recover: try inner; on failure scan to sentinel, emit ParseError node ────
function emitRecover(def: Extract<ParserDef, { tag: 'recover' }>, ctx: Ctx, pos: string): ER {
  const { stmts: innerStmts, okVar, valVar, endVar } = emitFallible(def.parser, ctx, pos)

  const ind0  = ind(ctx)
  const scanV = v(ctx, '_sc')
  const errV  = v(ctx, '_err')

  // Sentinel check runs inside the while loop — indent 2 extra levels (if + while)
  const savedIndent = ctx.indent
  ctx.indent += 2
  const { stmts: sentStmts, okVar: sentOk } = emitFallible(def.sentinel, ctx, scanV)
  ctx.indent = savedIndent

  const stmts: string[] = [
    ...innerStmts,
    `${ind0}if (!${okVar}) {`,
    `${ind0}  let ${scanV} = ${pos}`,
    `${ind0}  while (${scanV} < input.length) {`,
    ...sentStmts,
    `${ind0}    if (${sentOk}) break`,
    `${ind0}    ${scanV}++`,
    `${ind0}  }`,
    `${ind0}  const ${errV} = { _tag: 'parseError', span: { start: ${pos}, end: ${scanV} }, expected: [] }`,
    `${ind0}  if (_ctx._errors) _ctx._errors.push(${errV})`,
    `${ind0}  ${valVar} = ${errV}`,
    `${ind0}  ${endVar} = ${scanV}`,
    `${ind0}  ${okVar} = true`,
    `${ind0}}`,
  ]
  return { stmts, valueVar: valVar, endVar }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
function emit(p: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  const def = p._def
  switch (def.tag) {
    case 'literal':   return emitLit(def, ctx, pos)
    case 'regex':     return emitRegex(def, ctx, pos)
    case 'sequence':  return emitSeq(def, ctx, pos)
    case 'choice':    return emitChoice(def, ctx, pos)
    case 'many':
    case 'oneOrMore': return emitMany(def, ctx, pos)
    case 'optional':  return emitOptional(def, ctx, pos)
    case 'sepBy':     return emitSepBy(p, def, ctx, pos)
    case 'transform': {
      const inner = emit(def.parser, ctx, pos)
      const fnIdx = ctx.mapFns.length
      ctx.mapFns.push(def.fn)
      ctx.mapFnSrcs.push(def.fnSrc ?? null)
      const mv = v(ctx, '_mapped')
      return {
        stmts: [
          ...inner.stmts,
          `${ind(ctx)}const ${mv} = _mf[${fnIdx}](${inner.valueVar}, { start: ${pos}, end: ${inner.endVar} })`,
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
          ...skipR.stmts.map(s => '  ' + s),
          `${ind(ctx)}  ${endV} = ${skipR.endVar}`,
          `${ind(ctx)}} catch {}`,
        ],
        valueVar: mainR.valueVar,
        endVar: endV,
      }
    }
    case 'lazy':     return emitLazy(p, def, ctx, pos)
    case 'trivia':   return emit(def.parser, ctx, pos)
    case 'grammar': {
      // Propagate trivia from the grammar opts into ctx so emitSeq can skip it.
      const savedTrivia = ctx.activeTrivia
      if (def.triviaParser) ctx.activeTrivia = def.triviaParser
      const r = emit(def.parser, ctx, pos)
      if (savedTrivia === undefined) delete ctx.activeTrivia
      else ctx.activeTrivia = savedTrivia
      return r
    }
    case 'not':     return emitNot(def, ctx, pos)
    case 'node':    return emitNode(def, ctx, pos)
    case 'scanTo':  return emitScanTo(def, ctx, pos)
    case 'recover': return emitRecover(def, ctx, pos)
    case 'guard': {
      const fnIdx = ctx.mapFns.length
      ctx.mapFns.push(def.predicate as (v: unknown, span: unknown) => unknown)
      const vv = v(ctx)
      return {
        stmts: [
          `${ind(ctx)}if (!_mf[${fnIdx}](_ctx.state)) ${failStmt({ ...ctx, indent: 0 }, '"gate"', pos).trim()}`,
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

      // Wrap inner parser as a named function so it receives _ctx as a parameter.
      // That lets us call it with a modified ctx (user changed) without polluting
      // the outer _ctx variable for subsequent emits.
      const innerParser = def.parser as Combinator<unknown>
      if (!ctx.namedParsers.has(innerParser)) {
        const fnName = `_wcf${ctx.namedParsers.size}`
        ctx.namedParsers.set(innerParser, fnName)
        const savedIndent    = ctx.indent
        const savedFailLabel = ctx.failLabel
        ctx.indent    = 1
        ctx.failLabel = '_pfail'  // failures break _pfail (same as emitLazy)
        const innerR = emit(innerParser, ctx, '_pos')
        ctx.indent    = savedIndent
        ctx.failLabel = savedFailLabel
        pushNamedFnDecl(ctx, fnName, innerR.stmts, innerR.valueVar, innerR.endVar)
      }
      const fn = ctx.namedParsers.get(innerParser)!

      const rv = v(ctx, '_wcr')
      const vv = v(ctx, '_wcv')
      const ev = v(ctx, '_wce')
      return {
        stmts: [
          `${ind(ctx)}const ${rv} = { ..._ctx, state: _mf[${evIdx}]() }`,
          `${ind(ctx)}const ${vv} = ${fn}(input, ${pos}, ${rv})`,
          `${ind(ctx)}if (${vv} === ${NAMED_FN_FAIL}) ${failStmt({ ...ctx, indent: 0 }, '"withCtx"', pos).trim()}`,
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
    case 'withCtx':   return hasNodeDef(d.parser, seen)
    default:          return false
  }
}

export function compile<T>(parser: Combinator<T>, mapFnSources?: string[]): CompiledParser<T> {
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
    regexDecls: [],
    regexMap: new Map(),
    mapFns: [],
    mapFnSrcs: [],
    buildFns: [],
    buildSrcs: [],
    runtimeParsers: [],
    needsCollator: false,
    namedParsers: new Map(),
    triviaCaptureNames: new Map(),
    triviaFnNames: new Map(),
    namedFnDecls: [],
    capturing: hasNodeDef(parser as Combinator<unknown>),
  }

  const r = emit(parser as Combinator<unknown>, ctx, '_pos')

  const collatorDecl = ctx.needsCollator
    ? `const _collator = new Intl.Collator(undefined, { sensitivity: 'accent' })\n`
    : ''

  const namedPrelude = ctx.namedFnDecls.length > 0 ? [...namedFnPrelude(), ''] : []

  const source = [
    ...ctx.regexDecls,
    '',
    ...namedPrelude,
    ...ctx.namedFnDecls,
    `${collatorDecl}function _parse(input, _pos, _rp, _mf, _build, _ctx) {`,
    `  let pos = _pos`,
    ...r.stmts,
    `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
    `}`,
  ].join('\n')

  const fn = new Function('input', '_pos', '_rp', '_mf', '_build', '_ctx', [
    ...ctx.regexDecls,
    collatorDecl,
    ...namedPrelude,
    ...ctx.namedFnDecls,
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

  const defaultCtx: ParseContext = { trackLines: false }

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
  const inlineExpression: string | null = canInline ? buildInlineExpression(ctx, r, collatorDecl, effectiveSources, buildSources) : null

  return {
    source,
    inlineExpression,
    parse(input: string, pos = 0): ParseResult<T> {
      return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, defaultCtx)
    },
    parseWithErrors(input: string, pos = 0): ParseResult<T> & { errors: ParseError[] } {
      const errors: ParseError[] = []
      const result = fn(input, pos, ctx.runtimeParsers, ctx.mapFns, ctx.buildFns, { ...defaultCtx, _errors: errors })
      return { ...result, errors } as ParseResult<T> & { errors: ParseError[] }
    },
  }
}

function buildInlineExpression(
  ctx: Ctx,
  r: ER,
  collatorDecl: string,
  mapFnSources?: string[],
  buildSources?: string[],
): string {
  const bodyLines = [
    `  let pos = _pos`,
    ...r.stmts.map(s => `  ${s}`),
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

  const needsWrapper = ctx.regexDecls.length > 0 || !!collatorDecl || ctx.namedFnDecls.length > 0 || !!mfDecl || !!buildDecl
  if (!needsWrapper) return innerFn

  // Wrap in IIFE to hoist regex/collator/mf/build declarations and named recursive functions.
  const namedPrelude = ctx.namedFnDecls.length > 0 ? namedFnPrelude() : []
  return [
    `/* @__PURE__ */ (() => {`,
    ...ctx.regexDecls.map(d => `  ${d}`),
    collatorDecl ? `  ${collatorDecl.trim()}` : '',
    mfDecl,
    buildDecl,
    ...namedPrelude.map(l => `  ${l}`),
    ...ctx.namedFnDecls.flatMap(f => f.split('\n').map(l => `  ${l}`)),
    `  return ${innerFn}`,
    `})()`,
  ].filter(Boolean).join('\n')
}
