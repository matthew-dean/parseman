import type {
  Combinator, ParseContext, ParseResult, ParserMeta, FirstSet,
  AutoNotCheck, CharRange, ChoiceStrategy, GatedArm,
} from '../types.ts'
import { union, intersects, matchesEmpty } from './first-set.ts'
import { deriveExpected } from './expect.ts'
import { saveCstMark, rollbackCstCapture } from '../cst/capture-buffer.ts'

type ArmParser<T> = T extends GatedArm<infer U> ? Combinator<U> : T extends Combinator<infer U> ? Combinator<U> : never
type UnionArms<T extends (Combinator<unknown> | GatedArm<unknown>)[]> = {
  [K in keyof T]: ArmParser<T[K]>
}[number] extends Combinator<infer U> ? U : never

export function choice<T extends [Combinator<unknown> | GatedArm<unknown>, ...(Combinator<unknown> | GatedArm<unknown>)[]]>(
  ...args: T
): Combinator<UnionArms<T>> {
  // Unwrap gated arms into (parser, gate) pairs
  const parsers = args.map(a => ('gate' in a ? a.combinator : a)) as Combinator<unknown>[]
  const gates   = args.map(a => ('gate' in a ? a.gate   : null)) as (((state: unknown) => boolean) | null)[]

  const hasGates = gates.some(g => g !== null)

  // O(1) first-char dispatch is sound when arms are pairwise-disjoint in their
  // first char AND no arm can match empty. Non-nullability is what makes a GATED
  // arm keep its dispatch slot: a gated arm is normally *skipped* so a later arm
  // can retry the same position — but if every arm is non-nullable and first-sets
  // are disjoint, no later arm can match this first char, so "skip the gate then
  // retry" is exactly "dispatch to this arm, check its gate, and fail the choice
  // if the gate is false". Every OTHER first char dispatches as before and never
  // touches the gate. A nullable arm matches at ANY position (zero-width), so
  // first-char dispatch can't represent it → such choices stay on firstMatch.
  // (Requiring non-nullability universally also tightens the ungated path, which
  // was already unsound for a nullable-but-first-set-disjoint arm; in practice no
  // ungated disjoint choice has a nullable arm, so codegen output is unchanged.)
  const disjoint = areDisjoint(parsers.map(p => p._meta.firstSet))
    && parsers.every(p => !matchesEmpty(p))

  let combined: FirstSet = { kind: 'empty' }
  for (const p of parsers) combined = union(combined, p._meta.firstSet)

  const meta: ParserMeta = {
    firstSet: combined,
    canMatchNewline: parsers.some(p => p._meta.canMatchNewline),
    isTrivia: false,
    disjoint,
  }

  // A disjoint choice dispatches by first char (gated arms check their gate inside
  // the dispatched branch); a NON-disjoint gated choice falls to firstMatch — the
  // greedy/longest-first strategies are incompatible with per-arm predicates.
  const strategy = (disjoint || hasGates) ? null : detectStrategy(parsers)
  const autoNot = (!disjoint && !hasGates && strategy?.tag === 'firstMatch')
    ? computeAutoNot(parsers)
    : parsers.map(() => null)

  // Runtime state for each strategy (built once, reused on every parse call):
  let greedyLitMap: Map<string, number> | null = null
  let sortedParsers: Combinator<unknown>[] | null = null
  const asciiDispatch = disjoint ? buildAsciiDispatch(parsers) : null

  if (strategy?.tag === 'greedyClassify') {
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

      // ── Disjoint: O(1) first-char dispatch (arms may be gated) ────────────
      if (disjoint && pos < input.length) {
        const code = input.codePointAt(pos)!
        let idx = code < 128 ? asciiDispatch![code]! : -1
        if (idx < 0) {
          for (let i = 0; i < parsers.length; i++) {
            if (inFirstSet(code, parsers[i]!._meta.firstSet)) { idx = i; break }
          }
        }
        if (idx >= 0) {
          const gate = gates[idx]
          if (gate && !gate(ctx.state)) {
            // Gate blocks this arm. Disjointness + non-nullable arms guarantee no
            // OTHER arm can match this first char, so skip-and-retry is exactly
            // fail-the-choice — we must not fall through to another arm.
            return { ok: false, expected: deriveExpected(parsers[idx]!), span: { start: pos, end: pos } }
          }
          const result = parsers[idx]!.parse(input, pos, ctx)
          if (result.ok) return result as ParseResult<UnionArms<T>>
          expected.push(...result.expected)
          return { ok: false, expected, span: { start: pos, end: pos } }
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

// ASCII first-char → arm INDEX (not the parser) so a gated arm's gate can be
// looked up (gates[idx]) at dispatch time. -1 means "no arm keys off this char".
function buildAsciiDispatch(parsers: Combinator<unknown>[]): number[] {
  const table = Array<number>(128).fill(-1)
  for (let i = 0; i < parsers.length; i++) {
    const fs = parsers[i]!._meta.firstSet
    if (fs.kind !== 'ranges') continue
    for (const { lo, hi } of fs.ranges) {
      for (let code = Math.max(0, lo); code <= Math.min(127, hi); code++) {
        table[code] = i
      }
    }
  }
  return table
}
