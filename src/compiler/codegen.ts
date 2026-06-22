/**
 * Compile a Combinator<T> definition tree into an optimized JavaScript function.
 *
 * Design: every sub-emitter uses early-return on failure. Fallible contexts
 * (many loops, non-disjoint choice arms) wrap inner code in IIFEs so
 * early-return keeps working uniformly throughout.
 */
import type { Combinator, ParserDef, FirstSet, ParseResult, ParseContext, ChoiceStrategy } from '../types.ts'
import { getCoreLiteralValue, getCoreRegexDef } from '../combinators/choice.ts'

// ---------------------------------------------------------------------------
// Codegen context
// ---------------------------------------------------------------------------
type Ctx = {
  vars: number
  indent: number
  /** Regex declarations hoisted to module scope */
  regexDecls: string[]
  /** Map functions that need to be captured at compile time */
  mapFns: Array<(v: unknown, span: { start: number; end: number }) => unknown>
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
}

function v(ctx: Ctx, prefix = '_v'): string { return `${prefix}${ctx.vars++}` }
function ind(ctx: Ctx): string { return '  '.repeat(ctx.indent) }

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
  return `${ind(ctx)}return { ok: false, expected: [${expected}], span: { start: ${posExpr}, end: ${posExpr} } }`
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

  return { stmts, valueVar: vv, endVar: len === 0 ? pos : `${pos} + ${len}` }
}

function emitRegex(def: Extract<ParserDef, { tag: 'regex' }>, ctx: Ctx, pos: string): ER {
  const flags = 'y' + def.flags.replace(/[gy]/g, '')
  const rName = `_re${ctx.regexDecls.length}`
  ctx.regexDecls.push(`const ${rName} = /${def.optimizedSource}/${flags}`)

  const mv = v(ctx, '_m')
  const vv = v(ctx)
  const expectedStr = JSON.stringify(`/${def.source}/`)
  const stmts = [
    `${ind(ctx)}${rName}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${mv} = ${rName}.exec(input)`,
    `${ind(ctx)}if (${mv} === null) ${failStmt({ ...ctx, indent: 0 }, expectedStr, pos).trim()}`,
    `${ind(ctx)}const ${vv} = ${mv}[0]`,
  ]
  return { stmts, valueVar: vv, endVar: `${pos} + ${vv}.length` }
}

/**
 * Ensure the active trivia parser has a compiled named function, then return its name.
 * Uses namedParsers so the trivia function is compiled at most once per compile() call.
 * Mirrors the registration pattern in emitLazy.
 */
function ensureTriviaFn(ctx: Ctx): string {
  const trivia = ctx.activeTrivia!
  if (!ctx.namedParsers.has(trivia)) {
    const fnName = `_pf${ctx.namedParsers.size}`
    ctx.namedParsers.set(trivia, fnName)   // register FIRST to break any cycles
    const savedIndent = ctx.indent
    ctx.indent = 1
    const r = emit(trivia, ctx, '_pos')
    ctx.indent = savedIndent
    ctx.namedFnDecls.push([
      `function ${fnName}(input, _pos, _ctx) {`,
      ...r.stmts,
      `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
      `}`,
    ].join('\n'))
  }
  return ctx.namedParsers.get(trivia)!
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
      const trivFn = ensureTriviaFn(ctx)
      const tmp = v(ctx, '_trv')
      stmts.push(
        `${ind(ctx)}const ${tmp} = ${trivFn}(input, ${curV}, _ctx)`,
        `${ind(ctx)}if (${tmp}.ok) ${curV} = ${tmp}.span.end`,
      )
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
    stmts.push(
      `${ind(ctx)}else return { ok: false, expected: ${allExpected}, span: { start: ${pos}, end: ${pos} } }`,
    )
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

  // Hoist the regex (same mechanism as emitRegex)
  const reIdx = ctx.regexDecls.length
  const reVar = `_re${reIdx}`
  const cleanFlags = 'y' + regexDef.flags.replace(/[gy]/g, '')
  ctx.regexDecls.push(`const ${reVar} = /${regexDef.source}/${cleanFlags}`)

  const matchV = v(ctx, '_gm')
  const wordV  = v(ctx, '_gw')
  const endV   = v(ctx, '_ge')

  const stmts: string[] = [
    `${ind(ctx)}${reVar}.lastIndex = ${pos}`,
    `${ind(ctx)}const ${matchV} = ${reVar}.exec(input)`,
    `${ind(ctx)}if (${matchV} === null) return { ok: false, expected: ${allExpected}, span: { start: ${pos}, end: ${pos} } }`,
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
  stmts.push(`${ind(ctx)}else return { ok: false, expected: ${allExpected}, span: { start: ${pos}, end: ${pos} } }`)

  return { stmts, valueVar: valV, endVar: endV }
}

// ── firstMatch fallback: PEG + auto-not inline rejection + per-arm gates ─────
function emitFirstMatch(
  def: Extract<ParserDef, { tag: 'choice' }>,
  allExpected: string,
  ctx: Ctx,
  pos: string,
): ER {
  const resV = v(ctx, '_cr')
  const stmts: string[] = [`${ind(ctx)}let ${resV}`]

  for (let i = 0; i < def.parsers.length; i++) {
    const p = def.parsers[i]!
    const gate    = def.gates[i]
    const autoNot = def.autoNot[i]

    const savedIndent = ctx.indent
    ctx.indent = 0
    const r = emit(p, ctx, pos)
    ctx.indent = savedIndent
    const iife = asIIFE(r.stmts, r.valueVar, r.endVar, pos, ind(ctx))

    // Gate: register predicate in mapFns; condition guards entire arm attempt
    let gateCond: string | null = null
    if (gate) {
      const gateIdx = ctx.mapFns.length
      ctx.mapFns.push(gate as (v: unknown, span: unknown) => unknown)
      gateCond = `_mf[${gateIdx}](_ctx.user)`
    }
    const skipCond = gateCond ? `!${resV}?.ok && ${gateCond}` : `!${resV}?.ok`

    if (autoNot && autoNot.length > 0) {
      const tmp = v(ctx, '_ct')
      const anCode = v(ctx, '_anc')
      const rejectCond = autoNot.map(check =>
        check.kind === 'firstSet'
          ? firstSetCond(anCode, check.set)
          : `input.startsWith(${JSON.stringify(check.value)}, ${tmp}.span.end)`
      ).join(' || ')
      stmts.push(
        `${ind(ctx)}if (${skipCond}) { const ${tmp} = (() => { try { return ${iife} } catch {} })(); if (${tmp}?.ok) { const ${anCode} = ${tmp}.span.end < input.length ? input.charCodeAt(${tmp}.span.end) : -1; if (!(${rejectCond})) ${resV} = ${tmp} } }`,
      )
    } else {
      stmts.push(`${ind(ctx)}if (${skipCond}) { try { ${resV} = ${iife} } catch {} }`)
    }
  }
  stmts.push(
    `${ind(ctx)}if (!${resV}?.ok) return { ok: false, expected: ${allExpected}, span: { start: ${pos}, end: ${pos} } }`,
  )
  return { stmts, valueVar: `${resV}.value`, endVar: `${resV}.span.end` }
}

function emitNonDisjoint(
  def: Extract<ParserDef, { tag: 'choice' }>,
  strategy: ChoiceStrategy,
  allExpected: string,
  ctx: Ctx,
  pos: string,
): ER {
  if (strategy.tag === 'greedyClassify')
    return emitGreedyClassify(def, strategy.superIndex, allExpected, ctx, pos)
  if (strategy.tag === 'literalsLongestFirst')
    return emitLiteralsLongestFirst(def, strategy.sortedIndices, allExpected, ctx, pos)
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

  const emitInnerIIFE = (): string => {
    const savedIndent = ctx.indent
    ctx.indent = 0
    const r = emit(def.parser, ctx, curV)
    ctx.indent = savedIndent
    return asIIFE(r.stmts, r.valueVar, r.endVar, curV, ind(ctx) + '  ')
  }

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
  stmts.push(
    `${ind(ctx)}const _iter = (() => { try { return ${emitInnerIIFE()} } catch { return null } })()`,
    `${ind(ctx)}if (!_iter?.ok || _iter.span.end === ${curV}) break`,
    `${ind(ctx)}${arrV}.push(_iter.value)`,
    `${ind(ctx)}${curV} = _iter.span.end`,
  )
  ctx.indent--
  stmts.push(`${ind(ctx)}}`)

  return { stmts, valueVar: arrV, endVar: curV }
}

function emitOptional(def: Extract<ParserDef, { tag: 'optional' }>, ctx: Ctx, pos: string): ER {
  const valV = v(ctx, '_opt')
  const endV = v(ctx, '_opte')

  const savedIndent = ctx.indent
  ctx.indent = 0
  const r = emit(def.parser, ctx, pos)
  ctx.indent = savedIndent

  const iife = asIIFE(r.stmts, r.valueVar, r.endVar, pos, ind(ctx))
  const resV = v(ctx, '_optr')
  const stmts = [
    `${ind(ctx)}const ${resV} = (() => { try { return ${iife} } catch { return null } })()`,
    `${ind(ctx)}const ${valV} = ${resV}?.ok ? ${resV}.value : null`,
    `${ind(ctx)}const ${endV} = ${resV}?.ok ? ${resV}.span.end : ${pos}`,
  ]
  return { stmts, valueVar: valV, endVar: endV }
}

function emitSepBy(_p: Combinator<unknown>, def: Extract<ParserDef, { tag: 'sepBy' }>, ctx: Ctx, pos: string): ER {
  const arrV = v(ctx, '_arr')
  const curV = v(ctx, '_cur')

  // IIFE helpers — inner emit at indent 0 to avoid nested indentation noise
  const iife = (inner: Combinator<unknown>, posExpr: string): string => {
    const saved = ctx.indent
    ctx.indent = 0
    const r = emit(inner, ctx, posExpr)
    ctx.indent = saved
    return asIIFE(r.stmts, r.valueVar, r.endVar, posExpr, ind(ctx))
  }

  const firstR_saved = ctx.indent
  ctx.indent = 0
  const firstR = emit(def.parser, ctx, pos)
  ctx.indent = firstR_saved

  const firstV = v(ctx, '_sb0')
  const sepV = v(ctx, '_sbs')
  const nextV = v(ctx, '_sbn')

  const stmts: string[] = [
    `${ind(ctx)}const ${arrV} = []`,
    `${ind(ctx)}let ${curV} = ${pos}`,
    `${ind(ctx)}const ${firstV} = (() => { try { return ${asIIFE(firstR.stmts, firstR.valueVar, firstR.endVar, pos, ind(ctx))} } catch { return null } })()`,
    `${ind(ctx)}if (${firstV}?.ok) {`,
  ]
  ctx.indent++
  stmts.push(
    `${ind(ctx)}${arrV}.push(${firstV}.value)`,
    `${ind(ctx)}${curV} = ${firstV}.span.end`,
    `${ind(ctx)}while (${curV} < input.length) {`,
  )
  ctx.indent++
  stmts.push(
    `${ind(ctx)}const ${sepV} = (() => { try { return ${iife(def.separator, curV)} } catch { return null } })()`,
    `${ind(ctx)}if (!${sepV}?.ok) break`,
    `${ind(ctx)}const ${nextV} = (() => { try { return ${iife(def.parser, `${sepV}.span.end`)} } catch { return null } })()`,
    `${ind(ctx)}if (!${nextV}?.ok) break`,
    `${ind(ctx)}${arrV}.push(${nextV}.value)`,
    `${ind(ctx)}${curV} = ${nextV}.span.end`,
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
  // Helper: emit parser as a safe IIFE expression that returns result|null
  const safeIIFE = (inner: Combinator<unknown>, posExpr: string): string => {
    const saved = ctx.indent
    ctx.indent = 0
    const r = emit(inner, ctx, posExpr)
    ctx.indent = saved
    return `(() => { try { return ${asIIFE(r.stmts, r.valueVar, r.endVar, posExpr, ind(ctx))} } catch { return null } })()`
  }

  const curV   = v(ctx, '_stcur')
  const foundV = v(ctx, '_stfnd')
  const stmts: string[] = [
    `${ind(ctx)}let ${curV} = ${pos}`,
    `${ind(ctx)}let ${foundV} = false`,
    `${ind(ctx)}while (${curV} < input.length) {`,
  ]
  ctx.indent++

  // Sentinel check
  const sentV = v(ctx, '_sts')
  stmts.push(
    `${ind(ctx)}const ${sentV} = ${safeIIFE(def.sentinel, curV)}`,
    `${ind(ctx)}if (${sentV}?.ok) { ${foundV} = true; break }`,
  )

  // Skippers — each wrapped so a failed/throwing skip just means "not this one"
  if (def.skip.length > 0) {
    const advV = v(ctx, '_stadv')
    stmts.push(`${ind(ctx)}let ${advV} = false`)
    for (const skipper of def.skip) {
      const skV = v(ctx, '_sk')
      stmts.push(
        `${ind(ctx)}if (!${advV}) { const ${skV} = ${safeIIFE(skipper, curV)}; if (${skV}?.ok && ${skV}.span.end > ${curV}) { ${curV} = ${skV}.span.end; ${advV} = true } }`,
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
    stmts.push(
      `${ind(ctx)}if (!${foundV}) return { ok: false, expected: ${expectedStr}, span: { start: ${pos}, end: ${curV} } }`,
    )
  }

  const valV = v(ctx)
  stmts.push(`${ind(ctx)}const ${valV} = input.slice(${pos}, ${curV})`)
  return { stmts, valueVar: valV, endVar: curV }
}

function emitRuntimeFallback(parser: Combinator<unknown>, ctx: Ctx, pos: string): ER {
  const idx = ctx.runtimeParsers.length
  ctx.runtimeParsers.push(parser)
  const rv = v(ctx, '_rt')
  const vv = v(ctx, '_rtv')
  const ev = v(ctx, '_rte')
  const stmts = [
    `${ind(ctx)}const ${rv} = _rp[${idx}].parse(input, ${pos}, _ctx)`,
    `${ind(ctx)}if (!${rv}.ok) return ${rv}`,
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

    const savedIndent = ctx.indent
    ctx.indent = 1
    const r = emit(resolved, ctx, '_pos')
    ctx.indent = savedIndent

    ctx.namedFnDecls.push([
      `function ${fnName}(input, _pos, _ctx) {`,
      ...r.stmts,
      `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
      `}`,
    ].join('\n'))
  }

  const fnName = ctx.namedParsers.get(p)!
  const rv = v(ctx, '_pfr')
  const vv = v(ctx, '_pfv')
  const ev = v(ctx, '_pfe')
  return {
    stmts: [
      `${ind(ctx)}const ${rv} = ${fnName}(input, ${pos}, _ctx)`,
      `${ind(ctx)}if (!${rv}.ok) return ${rv}`,
      `${ind(ctx)}const ${vv} = ${rv}.value`,
      `${ind(ctx)}const ${ev} = ${rv}.span.end`,
    ],
    valueVar: vv,
    endVar: ev,
  }
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
    case 'scanTo': return emitScanTo(def, ctx, pos)
    case 'guard': {
      const fnIdx = ctx.mapFns.length
      ctx.mapFns.push(def.predicate as (v: unknown, span: unknown) => unknown)
      const vv = v(ctx)
      return {
        stmts: [
          `${ind(ctx)}if (!_mf[${fnIdx}](_ctx.user)) ${failStmt({ ...ctx, indent: 0 }, '"gate"', pos).trim()}`,
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
        const savedIndent = ctx.indent
        ctx.indent = 1
        const innerR = emit(innerParser, ctx, '_pos')
        ctx.indent = savedIndent
        ctx.namedFnDecls.push([
          `function ${fnName}(input, _pos, _ctx) {`,
          ...innerR.stmts,
          `  return { ok: true, value: ${innerR.valueVar}, span: { start: _pos, end: ${innerR.endVar} } }`,
          `}`,
        ].join('\n'))
      }
      const fn = ctx.namedParsers.get(innerParser)!

      const rv = v(ctx, '_wcr')
      const vv = v(ctx)
      const ev = v(ctx, '_wce')
      return {
        stmts: [
          `${ind(ctx)}const ${rv} = ${fn}(input, ${pos}, { ..._ctx, user: _mf[${evIdx}]() })`,
          `${ind(ctx)}if (!${rv}.ok) return ${rv}`,
          `${ind(ctx)}const ${vv} = ${rv}.value`,
          `${ind(ctx)}const ${ev} = ${rv}.span.end`,
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

export function compile<T>(parser: Combinator<T>, mapFnSources?: string[]): CompiledParser<T> {
  const ctx: Ctx = {
    vars: 0,
    indent: 1,
    regexDecls: [],
    mapFns: [],
    runtimeParsers: [],
    needsCollator: false,
    namedParsers: new Map(),
    namedFnDecls: [],
  }

  const r = emit(parser as Combinator<unknown>, ctx, '_pos')

  const collatorDecl = ctx.needsCollator
    ? `const _collator = new Intl.Collator(undefined, { sensitivity: 'accent' })\n`
    : ''

  const source = [
    ...ctx.regexDecls,
    '',
    ...ctx.namedFnDecls,
    `${collatorDecl}function _parse(input, _pos, _rp, _mf, _ctx) {`,
    `  let pos = _pos`,
    ...r.stmts,
    `  return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
    `}`,
  ].join('\n')

  const fn = new Function('input', '_pos', '_rp', '_mf', '_ctx', [
    ...ctx.regexDecls,
    collatorDecl,
    ...ctx.namedFnDecls,
    `let pos = _pos`,
    ...r.stmts,
    `return { ok: true, value: ${r.valueVar}, span: { start: _pos, end: ${r.endVar} } }`,
  ].join('\n')) as (
    input: string,
    pos: number,
    rp: Array<Combinator<unknown>>,
    mf: Array<(v: unknown, span: { start: number; end: number }) => unknown>,
    ctx: ParseContext,
  ) => ParseResult<T>

  const defaultCtx: ParseContext = { trackLines: false }

  // Build an inline expression when there are no runtime fallbacks, and either
  // no map-function closures or their source text has been provided for injection.
  const mfCovered = ctx.mapFns.length === 0 || (mapFnSources !== undefined && mapFnSources.length === ctx.mapFns.length)
  const canInline = ctx.runtimeParsers.length === 0 && mfCovered
  const inlineExpression: string | null = canInline ? buildInlineExpression(ctx, r, collatorDecl, mapFnSources) : null

  return {
    source,
    inlineExpression,
    parse(input: string, pos = 0): ParseResult<T> {
      return fn(input, pos, ctx.runtimeParsers, ctx.mapFns, defaultCtx)
    },
  }
}

function buildInlineExpression(
  ctx: Ctx,
  r: ER,
  collatorDecl: string,
  mapFnSources?: string[],
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

  // When map-function source texts are provided, declare _mf inline so the
  // emitted _mf[i] references resolve without a runtime closure array.
  const mfDecl = mapFnSources?.length ? `  const _mf = [${mapFnSources.join(', ')}]` : ''

  const needsWrapper = ctx.regexDecls.length > 0 || !!collatorDecl || ctx.namedFnDecls.length > 0 || !!mfDecl
  if (!needsWrapper) return innerFn

  // Wrap in IIFE to hoist regex/collator/mf declarations and named recursive functions.
  return [
    `/* @__PURE__ */ (() => {`,
    ...ctx.regexDecls.map(d => `  ${d}`),
    collatorDecl ? `  ${collatorDecl.trim()}` : '',
    mfDecl,
    ...ctx.namedFnDecls.flatMap(f => f.split('\n').map(l => `  ${l}`)),
    `  return ${innerFn}`,
    `})()`,
  ].filter(Boolean).join('\n')
}
