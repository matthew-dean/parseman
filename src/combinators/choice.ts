import type {
  Combinator, ParseContext, ParseResult, ParserMeta, FirstSet,
  AutoNotCheck, CharRange, ChoiceStrategy, GatedArm,
} from '../types.ts'
import { union, intersects } from './first-set.ts'
import { saveCstMark, rollbackCstCapture } from '../cst/capture-buffer.ts'

type ArmParser<T> = T extends GatedArm<infer U> ? Combinator<U> : T extends Combinator<infer U> ? Combinator<U> : never
type UnionArms<T extends (Combinator<unknown> | GatedArm<unknown>)[]> = {
  [K in keyof T]: ArmParser<T[K]>
}[number] extends Combinator<infer U> ? U : never

export function choice<T extends [Combinator<unknown> | GatedArm<unknown>, ...(Combinator<unknown> | GatedArm<unknown>)[]]>(
  ...args: T
): Combinator<UnionArms<T>> {
  // Unwrap gated arms into (parser, gate) pairs
  const parsers = args.map(a => ('gate' in a ? a.parser : a)) as Combinator<unknown>[]
  const gates   = args.map(a => ('gate' in a ? a.gate   : null)) as (((state: unknown) => boolean) | null)[]

  const hasGates = gates.some(g => g !== null)

  const disjoint = !hasGates && areDisjoint(parsers.map(p => p._meta.firstSet))

  let combined: FirstSet = { kind: 'empty' }
  for (const p of parsers) combined = union(combined, p._meta.firstSet)

  const meta: ParserMeta = {
    firstSet: combined,
    canMatchNewline: parsers.some(p => p._meta.canMatchNewline),
    isTrivia: false,
    disjoint,
  }

  // Gates force firstMatch — predicate dispatch is incompatible with first-set strategies.
  const strategy = (disjoint || hasGates) ? null : detectStrategy(parsers)
  const autoNot = (!disjoint && !hasGates && strategy?.tag === 'firstMatch')
    ? computeAutoNot(parsers)
    : parsers.map(() => null)

  // Runtime state for each strategy (built once, reused on every parse call):
  let greedyRe: RegExp | null = null
  let greedyLitMap: Map<string, number> | null = null
  let sortedParsers: Combinator<unknown>[] | null = null

  if (strategy?.tag === 'greedyClassify') {
    const regexDef = getCoreRegexDef(parsers[strategy.superIndex]!)!
    const flags = 'y' + regexDef.flags.replace(/[gy]/g, '')
    greedyRe = new RegExp(regexDef.source, flags)
    greedyLitMap = new Map()
    for (let i = 0; i < parsers.length; i++) {
      if (i === strategy.superIndex) continue
      const litVal = getCoreLiteralValue(parsers[i]!)
      if (litVal !== null) greedyLitMap.set(litVal, i)
    }
  } else if (strategy?.tag === 'literalsLongestFirst') {
    sortedParsers = strategy.sortedIndices.map(i => parsers[i]!)
  }

  return {
    _tag: 'choice',
    _meta: meta,
    _def: {
      tag: 'choice',
      parsers,
      gates,
      disjoint,
      strategy: strategy ?? { tag: 'firstMatch' },
      autoNot,
    },
    parse(input: string, pos: number, ctx: ParseContext): ParseResult<UnionArms<T>> {
      const expected: string[] = []

      // ── Disjoint: O(1) first-char dispatch (never has gates) ──────────────
      if (disjoint && pos < input.length) {
        const code = input.codePointAt(pos)!
        for (const parser of parsers) {
          if (inFirstSet(code, parser._meta.firstSet)) {
            const result = parser.parse(input, pos, ctx)
            if (result.ok) return result as ParseResult<UnionArms<T>>
            expected.push(...result.expected)
            return { ok: false, expected, span: { start: pos, end: pos } }
          }
        }
        return {
          ok: false,
          expected: parsers.flatMap(p => {
            const r = p.parse(input, pos, ctx)
            return r.ok ? [] : r.expected
          }),
          span: { start: pos, end: pos },
        }
      }

      // ── greedyClassify: run one regex, classify by string equality ─────────
      //    One parse call total. No backtracking.
      if (strategy?.tag === 'greedyClassify') {
        const superResult = parsers[strategy.superIndex]!.parse(input, pos, ctx)
        if (!superResult.ok) return superResult as ParseResult<UnionArms<T>>

        const end = superResult.span.end
        const litIdx = greedyLitMap!.get(input.slice(pos, end))
        if (litIdx !== undefined) {
          const litVal = getCoreLiteralValue(parsers[litIdx]!)!
          const value = applyTransforms(parsers[litIdx]!, litVal, { start: pos, end })
          return { ok: true, value: value as UnionArms<T>, span: { start: pos, end } }
        }
        return superResult as ParseResult<UnionArms<T>>
      }

      // ── literalsLongestFirst: sorted descending by length, no backtracking ─
      if (strategy?.tag === 'literalsLongestFirst') {
        for (const p of sortedParsers!) {
          const r = p.parse(input, pos, ctx)
          if (r.ok) return r as ParseResult<UnionArms<T>>
          expected.push(...r.expected)
        }
        return { ok: false, expected, span: { start: pos, end: pos } }
      }

      // ── firstMatch (+ gated arms): try each arm in order, skipping gated-off arms ──
      for (let i = 0; i < parsers.length; i++) {
        if (gates[i] && !gates[i]!(ctx.state)) continue   // gate blocks this arm
        // Save leaf-array lengths so a failed/rejected arm can be rolled back.
        const mark = saveCstMark(ctx)
        const logLen = ctx._triviaLog?.length
        const result = parsers[i]!.parse(input, pos, ctx)
        if (!result.ok) {
          rollbackCstCapture(ctx, mark)
          if (logLen !== undefined && ctx._triviaLog) ctx._triviaLog.length = logLen
          expected.push(...result.expected)
          continue
        }
        const checks = autoNot[i]
        if (checks && autoNotFires(input, result.span.end, checks)) {
          rollbackCstCapture(ctx, mark)
          if (logLen !== undefined && ctx._triviaLog) ctx._triviaLog.length = logLen
          continue
        }
        return result as ParseResult<UnionArms<T>>
      }
      return { ok: false, expected, span: { start: pos, end: pos } }
    },
  }
}

// ---------------------------------------------------------------------------
// Strategy detection
// ---------------------------------------------------------------------------

function detectStrategy(parsers: Combinator<unknown>[]): ChoiceStrategy {
  // greedyClassify: exactly one regex arm whose regex matches every literal arm's
  // value exactly (and can potentially match more). All other arms must be literals.
  const regexIndices: number[] = []
  const literalIndices: number[] = []
  for (let i = 0; i < parsers.length; i++) {
    if (getCoreRegexDef(parsers[i]!) !== null) regexIndices.push(i)
    else if (getCoreLiteralValue(parsers[i]!) !== null) literalIndices.push(i)
  }

  if (
    regexIndices.length === 1 &&
    literalIndices.length === parsers.length - 1 &&
    literalIndices.length > 0
  ) {
    const superIndex = regexIndices[0]!
    const regexDef = getCoreRegexDef(parsers[superIndex]!)!
    const flags = 'y' + regexDef.flags.replace(/[gy]/g, '')
    const re = new RegExp(regexDef.source, flags)
    const allSubsumed = literalIndices.every(i => {
      const litVal = getCoreLiteralValue(parsers[i]!)!
      re.lastIndex = 0
      const m = re.exec(litVal)
      return m !== null && m[0] === litVal
    })
    if (allSubsumed) return { tag: 'greedyClassify', superIndex }
  }

  // literalsLongestFirst: every arm is a literal — try longest first, no backtracking
  if (parsers.length === literalIndices.length) {
    const sortedIndices = [...literalIndices].sort((a, b) =>
      getCoreLiteralValue(parsers[b]!)!.length - getCoreLiteralValue(parsers[a]!)!.length
    )
    return { tag: 'literalsLongestFirst', sortedIndices }
  }

  return { tag: 'firstMatch' }
}

// ---------------------------------------------------------------------------
// Auto-not analysis (firstMatch fallback only)
// ---------------------------------------------------------------------------

function computeAutoNot(parsers: Combinator<unknown>[]): (AutoNotCheck[] | null)[] {
  return parsers.map((p, i) => {
    const litVal = getCoreLiteralValue(p)
    if (litVal === null) return null

    const checks: AutoNotCheck[] = []
    for (let j = i + 1; j < parsers.length; j++) {
      const other = parsers[j]!
      const otherLit = getCoreLiteralValue(other)
      if (otherLit !== null && otherLit.startsWith(litVal) && otherLit.length > litVal.length) {
        checks.push({ kind: 'startsWith', value: otherLit.slice(litVal.length) })
        continue
      }
      const regexDef = getCoreRegexDef(other)
      if (regexDef !== null) {
        const contSet = continuationFirstSet(litVal, regexDef.source, regexDef.flags)
        if (contSet !== null) checks.push({ kind: 'firstSet', set: contSet })
      }
    }
    return checks.length > 0 ? checks : null
  })
}

function autoNotFires(input: string, end: number, checks: AutoNotCheck[]): boolean {
  for (const check of checks) {
    if (check.kind === 'firstSet') {
      const code = end < input.length ? (input.codePointAt(end) ?? -1) : -1
      if (inFirstSet(code, check.set)) return true
    } else {
      if (input.startsWith(check.value, end)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Helpers: unwrap transform/sequence wrappers
// ---------------------------------------------------------------------------

/** Walk transform wrappers to find an inner literal's string value. */
export function getCoreLiteralValue(p: Combinator<unknown>): string | null {
  const def = p._def
  if (def.tag === 'literal' && !def.caseInsensitive) return def.value
  if (def.tag === 'transform') return getCoreLiteralValue(def.parser)
  return null
}

/** Walk transform wrappers to find an inner regex's source/flags. */
export function getCoreRegexDef(p: Combinator<unknown>): { source: string; flags: string } | null {
  const def = p._def
  if (def.tag === 'regex') return { source: def.source, flags: def.flags }
  if (def.tag === 'transform') return getCoreRegexDef(def.parser)
  if (def.tag === 'label') return getCoreRegexDef(def.parser)
  return null
}

/**
 * Apply a parser's transform chain to an already-known value, without re-parsing.
 * Used by greedyClassify to avoid a second parse call for the winning literal arm.
 */
function applyTransforms(p: Combinator<unknown>, value: unknown, span: { start: number; end: number }): unknown {
  const def = p._def
  if (def.tag === 'transform') {
    const inner = applyTransforms(def.parser, value, span)
    return def.fn(inner, span)
  }
  return value
}

// ---------------------------------------------------------------------------
// Continuation first-set (for firstMatch auto-not analysis)
// ---------------------------------------------------------------------------

function continuationFirstSet(lit: string, source: string, flags: string): FirstSet | null {
  const re = new RegExp(source, 'y' + flags.replace(/[gy]/g, ''))
  re.lastIndex = 0
  const base = re.exec(lit)
  if (!base || base[0] !== lit) return null

  const contCodes: number[] = []
  for (let code = 1; code < 128; code++) {
    re.lastIndex = 0
    const m = re.exec(lit + String.fromCharCode(code))
    if (m && m[0].length > lit.length) contCodes.push(code)
  }
  if (contCodes.length === 0) return null
  return codesToFirstSet(contCodes)
}

function codesToFirstSet(codes: number[]): FirstSet {
  codes.sort((a, b) => a - b)
  const ranges: CharRange[] = []
  let lo = codes[0]!, hi = codes[0]!
  for (let i = 1; i < codes.length; i++) {
    if (codes[i] === hi + 1) { hi = codes[i]! }
    else { ranges.push({ lo, hi }); lo = hi = codes[i]! }
  }
  ranges.push({ lo, hi })
  return { kind: 'ranges', ranges }
}

function inFirstSet(code: number, fs: FirstSet): boolean {
  if (fs.kind === 'any') return true
  if (fs.kind === 'empty') return false
  for (const r of fs.ranges) if (code >= r.lo && code <= r.hi) return true
  return false
}

function areDisjoint(sets: FirstSet[]): boolean {
  if (sets.some(s => s.kind === 'any')) return false
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++)
      if (intersects(sets[i]!, sets[j]!)) return false
  return true
}
