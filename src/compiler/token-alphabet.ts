/**
 * Derived tokenization groundwork: primitive kernels and lexical-token families.
 *
 * `collectAlphabet()` is the preserved primitive-terminal scanner groundwork:
 * it knows every `literal`, `keywords`, and `regex` in the composed grammar and
 * assigns each one a small integer KERNEL id. Those ids are implementation
 * details, not parser tokens. In particular, unwrapping
 * `token(sequence(identifier, optional(literal('('))))` must never publish an
 * identifier id followed by a `(` id: `token()` defines ONE contiguous source
 * token and ONE CST leaf for the complete range.
 *
 * `collectLexicalAlphabet()` is the production-facing boundary. It assigns ids
 * to authored `token()` families, normalizes effect-free bodies into canonical
 * lexical IR, interns equivalent recognizers, and records the downstream
 * `dispatch()` outcome classifiers over the same range. Primitive terminals
 * stay private recognizer machinery.
 *
 * Two things are deliberately separated, because conflating them is what makes
 * a naive derived scanner useless:
 *
 *  - The token ID SPACE is GLOBAL. One id per distinct terminal across the whole
 *    grammar, so an id can be compared, switched on, and indexed with.
 *  - The CANDIDATE SET is LOCAL, per decision point. Global maximal munch over
 *    the whole alphabet is wrong: a css alphabet contains construct-local
 *    long-run terminals (`[^()]+`, `[^{}/]+`, the `scanTo` raw-prelude runs)
 *    that swallow the document. Measured: global munch yields SEVEN tokens for a
 *    123 KB stylesheet. A decision point consults only the terminals that can
 *    actually start one of its arms.
 *
 * Nothing here decides HOW a token is recognized (see `token-scanner.ts`); this
 * module only decides WHAT the tokens are and WHICH ones each site may see.
 */
import type { Combinator, ParserDef } from '../types.ts'
import { firstSetOf, intersects, matchesEmpty, type RefResolver } from '../combinators/first-set.ts'
import { branchUsesRouted } from '../combinators/dispatch.ts'
import { runtimeRangeOutcomeKind } from '../table/token-outcome.ts'

/** A terminal in the derived alphabet, with its globally assigned id. */
export type TokenTerminal =
  | { kind: 'literal'; id: number; value: string; caseInsensitive: boolean }
  | { kind: 'keywords'; id: number; words: readonly string[]; caseInsensitive: boolean; boundary: string | undefined }
  | { kind: 'regex'; id: number; source: string; flags: string }

/** Reserved ids. Real terminals start at `FIRST_TERMINAL_ID`. */
export const TOK_EOF = 0
export const TOK_UNKNOWN = 1
export const TOK_WS = 2
export const FIRST_TERMINAL_ID = 3

export type Alphabet = {
  terminals: TokenTerminal[]
  /** Dedup key → id, so the same terminal spelled twice gets ONE id. */
  byKey: Map<string, number>
  /** The combinator that contributed each id (first one wins), for candidate sets. */
  originOf: Map<number, Combinator<unknown>>
}

/** Effect-free recognition IR underneath one authored `token()` boundary. */
export type LexicalIr =
  | { readonly kind: 'literal'; readonly value: string; readonly caseInsensitive: boolean }
  | { readonly kind: 'keywords'; readonly words: readonly string[]; readonly caseInsensitive: boolean; readonly boundary: string | undefined }
  | { readonly kind: 'regex'; readonly source: string; readonly flags: string }
  | { readonly kind: 'sequence'; readonly parts: readonly LexicalIr[] }
  | { readonly kind: 'choice'; readonly arms: readonly LexicalIr[] }
  | { readonly kind: 'repeat'; readonly body: LexicalIr; readonly min: number; readonly max: number | null; readonly greedy: boolean; readonly mode: 'possessive' | 'backtracking' }
  | { readonly kind: 'assert'; readonly positive: boolean; readonly body: LexicalIr }

/** One canonical recognizer spec, shared by every family with equal lexical IR. */
export type LexicalRecognizer = {
  readonly id: number
  readonly key: string
  readonly ir: LexicalIr
}

/**
 * Spelling-specific failure/probe contract. Families may share recognition IR
 * without sharing where a structured spelling fails or what it expects.
 */
export type LexicalDiagnosticPlan = {
  readonly id: number
  readonly body: Combinator<unknown>
}

/** One globally interned lexical family/base-token id. */
export type LexicalTokenFamily = {
  readonly id: number
  readonly recognizerId: number
}

/** One authored `token()` site, with spelling-specific diagnostics/effects. */
export type LexicalTokenSite = {
  readonly parser: Combinator<unknown>
  readonly body: Combinator<unknown>
  /** Absent on a refused site; refused metadata allocates no diagnostic plan. */
  readonly diagnosticId?: number
  /** All three are absent when normalization declined. */
  readonly familyId?: number
  readonly recognizerId?: number
  readonly refusal?: string
}

export type LexicalOutcomeMatch =
  | { readonly kind: 'exact'; readonly values: readonly string[]; readonly caseInsensitive: boolean }
  | { readonly kind: 'startsWith' | 'endsWith'; readonly value: string; readonly caseInsensitive: boolean }
  | { readonly kind: 'matches'; readonly value: string; readonly flags: string; readonly caseInsensitive: boolean }
  | { readonly kind: 'otherwise'; readonly excluding: readonly Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>[] }

/** A globally reusable classification id for one family/range predicate. */
export type LexicalOutcomeSpec = {
  readonly id: number
  readonly familyId: number
  readonly match: LexicalOutcomeMatch
}

/** One compatible view over a family range at a particular dispatch site. */
export type LexicalTokenOutcome = {
  readonly id: number
  readonly match: LexicalOutcomeMatch
}

/** One ordered dispatch arm. IDs classify; this route owns the branch/cut. */
export type LexicalTokenRoute = {
  readonly index: number
  readonly kind: 'exact' | 'matcher' | 'otherwise'
  readonly acceptedIds: readonly number[]
  readonly matches: readonly LexicalOutcomeMatch[]
  readonly parser: Combinator<unknown>
  readonly usesRouted: boolean
}

/** Dispatch outcomes stay site-local; ordered dispatch semantics are unchanged. */
export type LexicalTokenClassifier = {
  readonly dispatch: Combinator<unknown>
  readonly familyId: number
  /** True when reaching token() crossed a wrapper whose effects must still run. */
  readonly selectorEffects: boolean
  /** Compatible range views, flattened and allowed to repeat an id by route. */
  readonly outcomes: readonly LexicalTokenOutcome[]
  /** Authoritative ordered route/cut identity. */
  readonly routes: readonly LexicalTokenRoute[]
}

export type LexicalAlphabet = {
  /**
   * Compiler-only graph metadata. `diagnostics`, `sites`, `classifiers`, and
   * `familyIdOf` contain live combinators/Maps and are NOT TableProgram data.
   * A serializer must project the numeric/IR specs and relocate site references.
   */
  readonly recognizers: readonly LexicalRecognizer[]
  readonly diagnostics: readonly LexicalDiagnosticPlan[]
  readonly families: readonly LexicalTokenFamily[]
  readonly sites: readonly LexicalTokenSite[]
  readonly outcomes: readonly LexicalOutcomeSpec[]
  readonly classifiers: readonly LexicalTokenClassifier[]
  readonly familyIdOf: ReadonlyMap<Combinator<unknown>, number>
}

/** Numeric-only artifact projection; `TableProgram` aliases this contract. */
export type NumericLexicalPlan = {
  readonly recognizerOffsets: readonly number[]
  readonly recognizerData: readonly number[]
  readonly outcomeOffsets: readonly number[]
  readonly outcomeData: readonly number[]
  readonly tokenSites: readonly number[]
  readonly sites: readonly number[]
  readonly routes: readonly number[]
  readonly accepted: readonly number[]
  /** Sparse `[OP_CHOICE ip,armIndex,dispatchSiteIndex]` outer admissions. */
  readonly choiceSites?: readonly number[]
  /**
   * Strict-only outcome masks for ordered choices. Records are self-sized:
   * `[words,choiceIp,dispatchSiteIndex,flags,outcomeCount,armCount,
   *   ...globalOutcomeIds,...armOutcomeMasks]`.
   *
   * Bit 0 of an arm mask means unrestricted/legacy. Bits 1..29 correspond to
   * the record's outcome ids. A runtime classifier ORs every compatible bit;
   * no authored route or outcome is selected by this metadata.
   */
  readonly choiceMasks?: readonly number[]
}

/** Compiler-only source relation. No combinator crosses the numeric wire. */
export type LexicalChoiceMaskCandidate = {
  readonly choice: number
  readonly dsp: number
  readonly arms: readonly Combinator<unknown>[]
  /** Existing resolved OP_CHOICE classes (`-1` = open). */
  readonly classes: readonly number[]
}

/** Lexical-family ids occupy their own published namespace. */
export const FIRST_LEXICAL_FAMILY_ID = 3

const foldAscii = (value: string): string => value.replace(/[A-Z]/g, c => c.toLowerCase())

/** Canonical, parser-free identity for one range predicate. */
export function canonicalLexicalOutcomeKey(match: LexicalOutcomeMatch): string {
  if (match.kind === 'exact') {
    const values = [...new Set(match.values
      .map(value => match.caseInsensitive ? foldAscii(value) : value))].sort()
    return JSON.stringify({ kind: match.kind, values, caseInsensitive: match.caseInsensitive })
  }
  if (match.kind === 'startsWith' || match.kind === 'endsWith') {
    return JSON.stringify({
      kind: match.kind,
      value: match.caseInsensitive ? foldAscii(match.value) : match.value,
      caseInsensitive: match.caseInsensitive,
    })
  }
  if (match.kind === 'matches') {
    const rawFlags = match.caseInsensitive && !match.flags.includes('i') ? `${match.flags}i` : match.flags
    const flags = new RegExp('', rawFlags.replace(/g/g, '')).flags
    return JSON.stringify({ kind: match.kind, value: match.value, flags })
  }
  if (match.kind !== 'otherwise') throw new Error('parseman: unknown lexical outcome predicate')
  const excluding = match.excluding
  const fixed = excluding.filter((entry): entry is Extract<LexicalOutcomeMatch, { kind: 'startsWith' | 'endsWith' }> =>
    entry.kind === 'startsWith' || entry.kind === 'endsWith')
  const fixedContainsExact = (
    exact: Extract<LexicalOutcomeMatch, { kind: 'exact' }>,
    candidate: Extract<LexicalOutcomeMatch, { kind: 'startsWith' | 'endsWith' }>,
  ): boolean => {
    if (exact.caseInsensitive && !candidate.caseInsensitive && /[A-Za-z]/.test(candidate.value)) return false
    const needle = candidate.caseInsensitive ? foldAscii(candidate.value) : candidate.value
    return exact.values.every(raw => {
      const value = candidate.caseInsensitive ? foldAscii(raw) : raw
      return candidate.kind === 'startsWith' ? value.startsWith(needle) : value.endsWith(needle)
    })
  }
  const reduced: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>[] = []
  for (const entry of excluding) {
    if (entry.kind !== 'exact') { reduced.push(entry); continue }
    const values = entry.values.filter(value => !fixed.some(candidate =>
      fixedContainsExact({ ...entry, values: [value] }, candidate)))
    if (values.length > 0) reduced.push({ ...entry, values })
  }
  return JSON.stringify({
    kind: match.kind,
    excluding: [...new Set(reduced.map(canonicalLexicalOutcomeKey))].sort(),
  })
}

function keyOf(def: ParserDef): string | undefined {
  switch (def.tag) {
    case 'literal': return `L\u0000${def.value}\u0000${def.caseInsensitive ? 'i' : ''}`
    case 'keywords': return `K\u0000${def.words.join('\u0001')}\u0000${def.caseInsensitive ? 'i' : ''}\u0000${def.boundary ?? ''}`
    case 'regex': return `R\u0000${def.source}\u0000${def.flags}`
    default: return undefined
  }
}

function terminalOf(def: ParserDef, id: number): TokenTerminal | undefined {
  switch (def.tag) {
    case 'literal': return { kind: 'literal', id, value: def.value, caseInsensitive: def.caseInsensitive }
    case 'keywords': return { kind: 'keywords', id, words: def.words, caseInsensitive: def.caseInsensitive, boundary: def.boundary }
    case 'regex': return { kind: 'regex', id, source: def.source, flags: def.flags }
    default: return undefined
  }
}

/** Direct sub-parsers of a def, resolving a lazy through `resolve` when its own thunk is a hole. */
export function tokenChildren(
  p: Combinator<unknown>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): Combinator<unknown>[] {
  const d = p._def
  const out: Combinator<unknown>[] = []
  const push = (v: Combinator<unknown> | undefined): void => { if (v !== undefined) out.push(v) }
  const rec = d as unknown as Record<string, unknown>
  for (const k of ['parser', 'main', 'skipped', 'separator', 'selector', 'sentinel', 'fallback', 'otherwise', 'triviaParser']) {
    const v = rec[k]
    if (v !== null && typeof v === 'object' && '_def' in (v as object)) push(v as Combinator<unknown>)
  }
  if (Array.isArray(rec.parsers)) for (const c of rec.parsers as Combinator<unknown>[]) push(c)
  if (Array.isArray(rec.skip)) for (const c of rec.skip as Combinator<unknown>[]) push(c)
  if (Array.isArray(rec.cases)) for (const c of rec.cases as Array<{ parser: Combinator<unknown> }>) push(c.parser)
  if (Array.isArray(rec.matchers)) for (const c of rec.matchers as Array<{ parser: Combinator<unknown> }>) push(c.parser)
  if (d.tag === 'lazy') {
    let target: Combinator<unknown> | undefined
    try { target = d.thunk() } catch { target = undefined }
    if (target === undefined && resolve !== undefined) {
      const name = (p as unknown as { _ruleName?: string })._ruleName
      if (name !== undefined) target = resolve(name)
    }
    push(target)
  }
  return out
}

/**
 * Collect the alphabet over `roots`. Ids are assigned in first-encounter order,
 * which is stable for a given grammar and therefore safe to switch on.
 */
export function collectAlphabet(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): Alphabet {
  const terminals: TokenTerminal[] = []
  const byKey = new Map<string, number>()
  const originOf = new Map<number, Combinator<unknown>>()
  const seen = new Set<Combinator<unknown>>()

  const walk = (p: Combinator<unknown>): void => {
    if (seen.has(p)) return
    seen.add(p)
    const key = keyOf(p._def)
    if (key !== undefined && !byKey.has(key)) {
      const id = FIRST_TERMINAL_ID + terminals.length
      const t = terminalOf(p._def, id)
      if (t !== undefined) {
        byKey.set(key, id)
        terminals.push(t)
        originOf.set(id, p)
      }
    }
    for (const c of tokenChildren(p, resolve)) walk(c)
  }
  for (const r of roots) walk(r)
  return { terminals, byKey, originOf }
}

type Normalized = { ir: LexicalIr } | { refusal: string }

function regexFlags(flags: string): string {
  // regex() itself owns stickiness and ignores authored global/sticky state.
  return new RegExp('', flags.replace(/[gy]/g, '')).flags
}

function sequenceIr(parts: LexicalIr[]): LexicalIr {
  const flat: LexicalIr[] = []
  for (const part of parts) {
    if (part.kind === 'sequence') flat.push(...part.parts)
    else flat.push(part)
  }
  return flat.length === 1 ? flat[0]! : { kind: 'sequence', parts: flat }
}

/**
 * The first production normalization is deliberately proof-bounded: a single
 * repeated positive character class followed by one optional escaped literal.
 * This covers the identifier + optional '(' family while keeping regex
 * backtracking distinct from PEG possessive repetition everywhere else.
 */
function provenOptionalLiteralSuffix(
  source: string,
  flags: string,
): { base: string; suffix: string } | undefined {
  const match = /^(\[(?:\\.|[^\]\\])+\]\+)(\\[.*+?^$(){}|[\]\\/])\?$/.exec(source)
  if (match === null) return undefined
  const base = match[1]!
  const suffix = match[2]!.slice(1)
  // A one-character oracle is exact for this bounded base shape: the base is one
  // positive character class repeated with '+'. If the class cannot consume the
  // suffix character, the regex quantifier cannot backtrack across the suffix.
  const baseFlags = regexFlags(flags)
  if (new RegExp(`^(?:${base})$`, baseFlags).test(suffix)) return undefined
  return { base, suffix }
}

function normalizeRegex(source: string, flags: string): LexicalIr {
  const proof = provenOptionalLiteralSuffix(source, flags)
  if (proof === undefined) return { kind: 'regex', source, flags }
  return {
    kind: 'sequence',
    parts: [
      { kind: 'regex', source: proof.base, flags },
      {
        kind: 'repeat',
        body: {
          kind: 'literal',
          value: proof.suffix,
          caseInsensitive: flags.includes('i') && /[A-Za-z]/.test(proof.suffix),
        },
        min: 0,
        max: 1,
        greedy: true,
        mode: 'possessive',
      },
    ],
  }
}

function normalizeLexical(
  parser: Combinator<unknown>,
  resolve: ((name: string) => Combinator<unknown> | undefined) | undefined,
  stack: Set<Combinator<unknown>>,
): Normalized {
  if (stack.has(parser)) return { refusal: 'recursive token body' }
  stack.add(parser)
  const done = (result: Normalized): Normalized => { stack.delete(parser); return result }
  const child = (value: Combinator<unknown>): Normalized => normalizeLexical(value, resolve, stack)
  const def = parser._def

  switch (def.tag) {
    case 'literal':
      return done({ ir: {
        kind: 'literal',
        value: def.caseInsensitive ? def.value.replace(/[A-Z]/g, c => c.toLowerCase()) : def.value,
        caseInsensitive: def.caseInsensitive,
      } })
    case 'keywords':
      { const words = [...new Set(def.words.map(word => def.caseInsensitive
        ? word.replace(/[A-Z]/g, c => c.toLowerCase())
        : word))].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      return done({ ir: {
        kind: 'keywords', words, caseInsensitive: def.caseInsensitive, boundary: def.boundary,
      } }) }
    case 'regex':
      return done({ ir: normalizeRegex(def.source, regexFlags(def.flags)) })
    case 'sequence': {
      const parts: LexicalIr[] = []
      for (const entry of def.parsers) {
        const normalized = child(entry)
        if ('refusal' in normalized) return done(normalized)
        if (normalized.ir.kind === 'sequence') parts.push(...normalized.ir.parts)
        else parts.push(normalized.ir)
      }
      return done({ ir: sequenceIr(parts) })
    }
    case 'choice': {
      if (def.gates.some(gate => gate !== null)) return done({ refusal: 'choice has a dynamic gate' })
      if (def.autoNot.some(check => check !== null)) return done({ refusal: 'choice has contextual prefix rejection' })
      if (!def.disjoint && def.strategy.tag !== 'firstMatch') {
        return done({ refusal: `choice strategy ${def.strategy.tag} is not canonical lexical order` })
      }
      const arms: LexicalIr[] = []
      for (const entry of def.parsers) {
        const normalized = child(entry)
        if ('refusal' in normalized) return done(normalized)
        arms.push(normalized.ir)
      }
      return done({ ir: arms.length === 1 ? arms[0]! : { kind: 'choice', arms } })
    }
    case 'optional': {
      const normalized = child(def.parser)
      return done('refusal' in normalized ? normalized : {
        ir: { kind: 'repeat', body: normalized.ir, min: 0, max: 1, greedy: true, mode: 'possessive' },
      })
    }
    case 'many':
    case 'oneOrMore': {
      if (matchesEmpty(def.parser)) return done({ refusal: 'repeat body may not make progress' })
      const normalized = child(def.parser)
      return done('refusal' in normalized ? normalized : {
        ir: { kind: 'repeat', body: normalized.ir, min: def.min, max: def.max ?? null, greedy: true, mode: 'possessive' },
      })
    }
    case 'not':
    case 'peek': {
      const normalized = child(def.parser)
      return done('refusal' in normalized ? normalized : {
        ir: { kind: 'assert', positive: def.tag === 'peek', body: normalized.ir },
      })
    }
    case 'lazy': {
      let target: Combinator<unknown> | undefined
      try { target = def.thunk() } catch { target = undefined }
      if (target === undefined && resolve !== undefined) {
        const name = (parser as unknown as { _ruleName?: string })._ruleName
        if (name !== undefined) target = resolve(name)
      }
      return done(target === undefined ? { refusal: 'unresolved lazy token body' } : child(target))
    }
    case 'token':
    case 'trivia':
      return done(child(def.parser))
    case 'grammar':
      if (def.trackLines) return done({ refusal: 'token body has line-tracking effects' })
      if (def.triviaParser !== undefined || def.captureTrivia === true || def.rootCapture !== undefined) {
        return done({ refusal: 'token body has a trivia-bearing scope' })
      }
      return done(child(def.parser))
    case 'transform': return done({ refusal: 'transform is effectful' })
    case 'leaf': return done({ refusal: 'leaf is effectful' })
    case 'node': return done({ refusal: 'node is effectful' })
    case 'field': return done({ refusal: 'field is effectful' })
    case 'label': return done({ refusal: 'label changes diagnostics' })
    case 'expect': return done({ refusal: 'expect changes diagnostics' })
    case 'attempt': return done({ refusal: 'attempt changes commitment' })
    case 'withCtx': return done({ refusal: 'withCtx is dynamic' })
    case 'guard': return done({ refusal: 'guard is dynamic' })
    case 'adjacency': return done({ refusal: 'adjacency depends on parser state' })
    case 'recover': return done({ refusal: 'recover is effectful' })
    case 'scanTo': return done({ refusal: 'scanTo is not a lexical run' })
    case 'sepBy': return done({ refusal: 'separated repetition is not a lexical run' })
    case 'dispatch': return done({ refusal: 'nested dispatch has semantic outcomes' })
    case 'routed': return done({ refusal: 'routed depends on an outer dispatch' })
    case 'unknown': return done({ refusal: 'unknown parser body' })
  }
}

function tokenBoundary(
  parser: Combinator<unknown>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
  seen: Set<Combinator<unknown>> = new Set(),
  selectorEffects = false,
): { token: Combinator<unknown>; selectorEffects: boolean } | undefined {
  if (seen.has(parser)) return undefined
  seen.add(parser)
  const def = parser._def
  if (def.tag === 'token') return { token: parser, selectorEffects }
  if (def.tag === 'lazy') {
    let target: Combinator<unknown> | undefined
    try { target = def.thunk() } catch { target = undefined }
    if (target === undefined && resolve !== undefined) {
      const name = (parser as unknown as { _ruleName?: string })._ruleName
      if (name !== undefined) target = resolve(name)
    }
    return target === undefined ? undefined : tokenBoundary(target, resolve, seen, true)
  }
  // Value-preserving does NOT mean effect-free: label/field/expect/attempt and
  // scopes carry diagnostics, capture, commitment, or state. Do not inspect
  // through them until a consumer proves those effects still execute.
  return undefined
}

/**
 * Catalog authored lexical tokens and their dispatch views without confusing
 * private child terminals for source tokens. This is metadata only: consumers
 * still have to lower the canonical IR in every shipping engine before enabling
 * an admission path.
 */
export function collectLexicalAlphabet(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): LexicalAlphabet {
  const tokenParsers: Combinator<unknown>[] = []
  const dispatchParsers: Combinator<unknown>[] = []
  const seenTop = new Set<Combinator<unknown>>()
  const seenOwned = new Set<Combinator<unknown>>()

  const walk = (parser: Combinator<unknown>, owner?: Combinator<unknown>): void => {
    const seen = owner === undefined ? seenTop : seenOwned
    if (seen.has(parser)) return
    seen.add(parser)
    if (owner === undefined && parser._def.tag === 'token') tokenParsers.push(parser)
    if (owner === undefined && parser._def.tag === 'dispatch') dispatchParsers.push(parser)
    const nextOwner = owner ?? (parser._def.tag === 'token' ? parser : undefined)
    for (const entry of tokenChildren(parser, resolve)) walk(entry, nextOwner)
  }
  for (const root of roots) walk(root)

  const familyIdOf = new Map<Combinator<unknown>, number>()
  const recognizers: LexicalRecognizer[] = []
  const diagnostics: LexicalDiagnosticPlan[] = []
  const recognizerByKey = new Map<string, number>()
  const sites: LexicalTokenSite[] = []
  for (const parser of tokenParsers) {
    const def = parser._def
    if (def.tag !== 'token') continue
    const normalized = normalizeLexical(def.parser, resolve, new Set())
    if ('refusal' in normalized) {
      sites.push({ parser, body: def.parser, refusal: normalized.refusal })
      continue
    }
    if (matchesEmpty(def.parser)) {
      sites.push({ parser, body: def.parser, refusal: 'token body may match empty' })
      continue
    }
    const diagnosticId = diagnostics.length
    diagnostics.push({ id: diagnosticId, body: def.parser })
    const ir = normalized.ir
    const key = JSON.stringify(ir)
    let recognizerId = recognizerByKey.get(key)
    if (recognizerId === undefined) {
      recognizerId = recognizers.length
      recognizerByKey.set(key, recognizerId)
      recognizers.push({ id: recognizerId, key, ir })
    }
    const familyId = FIRST_LEXICAL_FAMILY_ID + recognizerId
    familyIdOf.set(parser, familyId)
    sites.push({ parser, body: def.parser, diagnosticId, recognizerId, familyId })
  }
  const families: LexicalTokenFamily[] = recognizers.map(recognizer => ({
    id: FIRST_LEXICAL_FAMILY_ID + recognizer.id,
    recognizerId: recognizer.id,
  }))

  let nextOutcomeId = FIRST_LEXICAL_FAMILY_ID + families.length
  const outcomes: LexicalOutcomeSpec[] = []
  const outcomeIdByKey = new Map<string, number>()
  const internOutcome = (familyId: number, match: LexicalOutcomeMatch): number => {
    if (match.kind === 'exact' && match.values.length !== 1) {
      throw new Error('parseman: global exact lexical outcomes must be atomic')
    }
    const key = `${familyId}\u0000${canonicalLexicalOutcomeKey(match)}`
    const prior = outcomeIdByKey.get(key)
    if (prior !== undefined) return prior
    const id = nextOutcomeId++
    outcomeIdByKey.set(key, id)
    outcomes.push({ id, familyId, match })
    return id
  }
  const classifiers: LexicalTokenClassifier[] = []
  for (const parser of dispatchParsers) {
    const def = parser._def
    if (def.tag !== 'dispatch') continue
    const boundary = tokenBoundary(def.selector, resolve)
    const familyId = boundary === undefined ? undefined : familyIdOf.get(boundary.token)
    if (familyId === undefined) continue
    const outcomes: LexicalTokenOutcome[] = []
    const routes: LexicalTokenRoute[] = []
    const exclusions: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>[] = []
    for (const entry of def.cases) {
      // Exact subtype ids are ATOMIC even when one dispatch arm groups keys.
      // The site route is represented by multiple outcomes pointing at the same
      // parser, so URL_OPEN keeps one global id whether another site groups it
      // with VAR_OPEN/CALC_OPEN or routes it alone.
      const matches: LexicalOutcomeMatch[] = []
      const acceptedIds: number[] = []
      for (const key of entry.keys) {
        const match: LexicalOutcomeMatch = {
          kind: 'exact', values: [key], caseInsensitive: entry.caseInsensitive,
        }
        const id = internOutcome(familyId, match)
        exclusions.push(match)
        matches.push(match)
        acceptedIds.push(id)
        outcomes.push({ id, match })
      }
      routes.push({
        index: routes.length, kind: 'exact', acceptedIds, matches,
        parser: entry.parser, usesRouted: branchUsesRouted(entry),
      })
    }
    for (const entry of def.matchers ?? []) {
      const match: LexicalOutcomeMatch = entry.kind === 'matches'
        ? { kind: 'matches', value: entry.value, flags: entry.flags ?? '', caseInsensitive: entry.caseInsensitive }
        : { kind: entry.kind, value: entry.value, caseInsensitive: entry.caseInsensitive }
      exclusions.push(match)
      const id = internOutcome(familyId, match)
      outcomes.push({ id, match })
      routes.push({
        index: routes.length, kind: 'matcher', acceptedIds: [id], matches: [match],
        parser: entry.parser, usesRouted: branchUsesRouted(entry),
      })
    }
    if (def.otherwise !== undefined) {
      const match: LexicalOutcomeMatch = { kind: 'otherwise', excluding: exclusions }
      const id = internOutcome(familyId, match)
      outcomes.push({ id, match })
      routes.push({
        index: routes.length, kind: 'otherwise', acceptedIds: [id], matches: [match],
        parser: def.otherwise,
        usesRouted: branchUsesRouted({ parser: def.otherwise, usesRouted: def.otherwiseUsesRouted }),
      })
    }
    for (const route of routes) {
      if (route.matches.length !== route.acceptedIds.length) {
        throw new Error('parseman: lexical route match/id arity mismatch')
      }
    }
    classifiers.push({
      dispatch: parser, familyId, selectorEffects: boundary?.selectorEffects ?? false, outcomes, routes,
    })
  }

  /*
   * IDs ARE CONTENT-ORDERED, not discovery-ordered. The collector walks the
   * final winner graph once, but compose(), a rule-map literal, and the macro
   * evaluator are allowed to present equal roots in different insertion order.
   * Sorting the already-canonical recognizer keys and family-qualified outcome
   * keys makes those routes agree without publishing a hash or an authored
   * token-instance identity in the artifact.
   */
  const recognizerOrder = [...recognizers].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const recognizerId = new Map(recognizerOrder.map((entry, index) => [entry.id, index]))
  const stableRecognizers = recognizerOrder.map((entry, id) => ({ ...entry, id }))
  const stableFamilies = stableRecognizers.map(entry => ({
    id: FIRST_LEXICAL_FAMILY_ID + entry.id,
    recognizerId: entry.id,
  }))
  const stableFamilyId = (oldFamilyId: number): number => {
    const oldRecognizerId = oldFamilyId - FIRST_LEXICAL_FAMILY_ID
    const id = recognizerId.get(oldRecognizerId)
    if (id === undefined) throw new Error('parseman: lexical family has no recognizer')
    return FIRST_LEXICAL_FAMILY_ID + id
  }
  const stableFamilyIdOf = new Map<Combinator<unknown>, number>()
  for (const [parser, familyId] of familyIdOf) stableFamilyIdOf.set(parser, stableFamilyId(familyId))
  const stableSites = sites.map(site => site.familyId === undefined ? site : ({
    ...site,
    familyId: stableFamilyId(site.familyId),
    recognizerId: recognizerId.get(site.recognizerId!)!,
  }))

  const orderedOutcomes = [...outcomes].sort((a, b) => {
    const ak = `${stableFamilyId(a.familyId)}\u0000${canonicalLexicalOutcomeKey(a.match)}`
    const bk = `${stableFamilyId(b.familyId)}\u0000${canonicalLexicalOutcomeKey(b.match)}`
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
  const oldOutcomeToStable = new Map<number, number>()
  const firstOutcomeId = FIRST_LEXICAL_FAMILY_ID + stableFamilies.length
  const stableOutcomes = orderedOutcomes.map((entry, index) => {
    const id = firstOutcomeId + index
    oldOutcomeToStable.set(entry.id, id)
    return { ...entry, id, familyId: stableFamilyId(entry.familyId) }
  })
  const stableClassifiers = classifiers.map(classifier => ({
    ...classifier,
    familyId: stableFamilyId(classifier.familyId),
    outcomes: classifier.outcomes.map(outcome => ({
      ...outcome,
      id: oldOutcomeToStable.get(outcome.id)!,
    })),
    routes: classifier.routes.map(route => ({
      ...route,
      acceptedIds: route.acceptedIds.map(id => oldOutcomeToStable.get(id)!),
    })),
  }))

  // Deliberately do not return `primitiveKernels`: collectAlphabet() remains a
  // separate historical/kernel API, while this is the only family/site seam.
  // A choice-admission consumer therefore cannot accidentally publish a child
  // literal/regex id by reading a field from LexicalAlphabet.
  return {
    recognizers: stableRecognizers,
    diagnostics,
    families: stableFamilies,
    sites: stableSites,
    outcomes: stableOutcomes,
    classifiers: stableClassifiers,
    familyIdOf: stableFamilyIdOf,
  }
}

function serializeLexicalIr(ir: LexicalIr, out: number[], constant: (value: unknown) => number): void {
  const start = out.length
  const begin = (kind: number): void => { out.push(kind, 0) }
  switch (ir.kind) {
    case 'literal':
      begin(0); out.push(constant(ir.value), ir.caseInsensitive ? 1 : 0)
      break
    case 'keywords':
      begin(1)
      out.push(ir.caseInsensitive ? 1 : 0, ir.boundary === undefined ? -1 : constant(ir.boundary), ir.words.length)
      for (const word of ir.words) out.push(constant(word))
      break
    case 'regex':
      begin(2); out.push(constant(new RegExp(ir.source, ir.flags)))
      break
    case 'sequence':
      begin(3); out.push(ir.parts.length)
      for (const part of ir.parts) serializeLexicalIr(part, out, constant)
      break
    case 'choice':
      begin(4); out.push(ir.arms.length)
      for (const arm of ir.arms) serializeLexicalIr(arm, out, constant)
      break
    case 'repeat':
      begin(5)
      out.push(ir.min, ir.max ?? -1, ir.greedy ? 1 : 0, ir.mode === 'possessive' ? 0 : 1)
      serializeLexicalIr(ir.body, out, constant)
      break
    case 'assert':
      begin(6); out.push(ir.positive ? 1 : 0)
      serializeLexicalIr(ir.body, out, constant)
      break
  }
  out[start + 1] = out.length - start
}

const CHOICE_MASK_STRICT = 1
const MAX_CHOICE_MASK_OUTCOMES = 29

type ChoiceMaskAnalysis = {
  readonly choice: number
  readonly dsp: number
  readonly outcomeIds: readonly number[]
  readonly armMasks: readonly number[]
}

function optionalSuffixRegex(ir: LexicalIr): { source: string; flags: string; suffix: string } | undefined {
  if (ir.kind !== 'sequence' || ir.parts.length !== 2) return undefined
  const [base, tail] = ir.parts
  if (base?.kind !== 'regex' || tail?.kind !== 'repeat'
    || tail.min !== 0 || tail.max !== 1 || tail.mode !== 'possessive'
    || tail.body.kind !== 'literal' || tail.body.value.length !== 1) return undefined
  return { source: base.source, flags: base.flags, suffix: tail.body.value }
}

function leadingKeywords(
  parser: Combinator<unknown>,
  resolve: RefResolver | undefined,
  seen = new Set<Combinator<unknown>>(),
): Extract<ParserDef, { tag: 'keywords' }> | undefined {
  if (seen.has(parser)) return undefined
  seen.add(parser)
  try {
    const d = parser._def
    switch (d.tag) {
      case 'keywords': return d
      case 'lazy': {
        let target: Combinator<unknown> | undefined
        try { target = d.thunk() } catch {
          const name = (parser as unknown as { _ruleName?: string })._ruleName
          target = name === undefined ? undefined : resolve?.(name)
        }
        return target === undefined ? undefined : leadingKeywords(target, resolve, seen)
      }
      case 'attempt': case 'transform': case 'label': case 'token': case 'leaf': case 'node':
        return leadingKeywords(d.parser, resolve, seen)
      case 'grammar': return d.triviaParser === undefined
        ? leadingKeywords(d.parser, resolve, seen) : undefined
      case 'sequence': return d.parsers.length > 0 && !matchesEmpty(d.parsers[0]!, new Set(), resolve)
        ? leadingKeywords(d.parsers[0]!, resolve, seen) : undefined
      default: return undefined
    }
  } finally {
    seen.delete(parser)
  }
}

function keywordOtherwiseId(
  parser: Combinator<unknown>,
  recognizer: LexicalRecognizer,
  outcomes: readonly LexicalOutcomeSpec[],
  resolve: RefResolver | undefined,
): number | undefined {
  const keyword = leadingKeywords(parser, resolve)
  const shape = optionalSuffixRegex(recognizer.ir)
  if (keyword === undefined || shape === undefined || keyword.boundary === undefined) return undefined
  let excludesSuffix = false
  try { excludesSuffix = new RegExp(`[${keyword.boundary}]`).test(shape.suffix) } catch { return undefined }
  const baseFlags = shape.flags.replace(/[gy]/g, '')
  if (!excludesSuffix || !keyword.words.every(word => {
    try {
      const base = new RegExp(`^(?:${shape.source})$`, baseFlags)
      return base.test(word) && (!keyword.caseInsensitive || base.test(word.toUpperCase()))
    } catch { return false }
  })) return undefined
  const otherwise = outcomes.filter((outcome): outcome is LexicalOutcomeSpec & {
    match: Extract<LexicalOutcomeMatch, { kind: 'otherwise' }>
  } => outcome.match.kind === 'otherwise')
  const direct = outcomes.filter((outcome): outcome is LexicalOutcomeSpec & {
    match: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>
  } => outcome.match.kind !== 'otherwise')
  if (otherwise.length !== 1 || !direct.every(({ match }) => {
    if (match.kind === 'matches') return match.caseInsensitive || match.flags.includes('i')
    const values = match.kind === 'exact' ? match.values : [match.value]
    return match.caseInsensitive || values.every(value => !/[A-Za-z]/.test(value))
  })) return undefined
  const exclusions = otherwise[0]!.match.excluding
  if (!exclusions.every(excluded => direct.some(outcome =>
    canonicalLexicalOutcomeKey(outcome.match) === canonicalLexicalOutcomeKey(excluded)))
    || !direct.every(({ match }) => exclusions.some(excluded =>
      canonicalLexicalOutcomeKey(match) === canonicalLexicalOutcomeKey(excluded)
      || match.kind === 'exact' && match.values.every(value =>
        lexicalOutcomeMatches(excluded, value, 0, value.length))
      || match.kind === 'matches' && excluded.kind === 'endsWith' && excluded.value === '('
        && runtimeRangeOutcomeKind(match.kind, match.value, match.flags, match.caseInsensitive)
          === 'function-open-excluding-url-calc'))) return undefined
  return keyword.words.every(word => direct.every(outcome =>
    !lexicalOutcomeMatches(outcome.match, word, 0, word.length))) ? otherwise[0]!.id : undefined
}

function analyzeChoiceMask(
  alphabet: LexicalAlphabet,
  candidate: LexicalChoiceMaskCandidate,
  supportedByDsp: ReadonlyMap<number, LexicalTokenClassifier>,
  resolve: RefResolver | undefined,
): ChoiceMaskAnalysis | undefined {
  const classifier = supportedByDsp.get(candidate.dsp)
  if (classifier === undefined || classifier.selectorEffects
    || candidate.classes.length !== candidate.arms.length) return undefined
  const dispatchArm = candidate.arms.findIndex(arm => arm === classifier.dispatch)
  if (dispatchArm < 0 || !classifier.routes.some(route => route.kind === 'otherwise')) return undefined
  const outcomes = alphabet.outcomes.filter(outcome => outcome.familyId === classifier!.familyId)
  if (outcomes.length === 0 || outcomes.length > MAX_CHOICE_MASK_OUTCOMES || outcomes.some(outcome => {
    const match = outcome.match
    return runtimeRangeOutcomeKind(
      match.kind,
      match.kind === 'matches' ? match.value : '',
      match.kind === 'matches' ? match.flags : '',
      match.kind === 'matches' && match.caseInsensitive,
    ) === undefined
  })) return undefined
  const recognizer = alphabet.recognizers[classifier.familyId - FIRST_LEXICAL_FAMILY_ID]
  const familyBody = alphabet.sites.find(site => site.familyId === classifier.familyId)?.body
  if (recognizer === undefined || familyBody === undefined || matchesEmpty(familyBody, new Set(), resolve)) return undefined
  const familyFirst = firstSetOf(familyBody, new Set(), resolve)
  if (familyFirst.kind !== 'ranges') return undefined
  const overlaps = candidate.arms.map((arm, i) => {
    const fs = firstSetOf(arm, new Set(), resolve)
    if (candidate.classes[i]! >= 0 && fs.kind === 'ranges') return intersects(fs, familyFirst)
    const d = arm._def
    if (candidate.classes[i]! < 0 && d.tag === 'attempt'
      && !matchesEmpty(d.parser, new Set(), resolve)) {
      const child = firstSetOf(d.parser, new Set(), resolve)
      if (child.kind === 'ranges') return intersects(child, familyFirst)
    }
    return true
  })
  if (!overlaps.some((overlap, i) => !overlap && candidate.classes[i]! < 0)) return undefined

  const allOutcomes = ((1 << (outcomes.length + 1)) - 2) >>> 0
  const armMasks = candidate.arms.map((arm, index) => {
    if (index === dispatchArm) return allOutcomes
    const keywordId = keywordOtherwiseId(arm, recognizer, outcomes, resolve)
    if (keywordId !== undefined) return (1 << (outcomes.findIndex(outcome => outcome.id === keywordId) + 1)) >>> 0
    return overlaps[index] ? 1 : 0
  })
  // Publish only a real selective site: at least one impossible arm and at
  // least one outcome-restricted compatible arm besides the dispatch itself.
  if (!armMasks.includes(0) || !armMasks.some((mask, arm) => arm !== dispatchArm && mask > 1)) return undefined
  return { choice: candidate.choice, dsp: candidate.dsp, outcomeIds: outcomes.map(outcome => outcome.id), armMasks }
}

/**
 * Project the compiler graph into compact numeric pools. The caller supplies
 * only already-relocated table-site numbers and its existing const-pool intern;
 * no combinator or identity map crosses this boundary.
 */
export function serializeLexicalPlan(
  alphabet: LexicalAlphabet,
  constant: (value: unknown) => number,
  tokenSites: readonly number[],
  dispatchSites: ReadonlyArray<{ readonly dsp: number; readonly classifier: LexicalTokenClassifier }>,
  choiceCandidates: ReadonlyArray<{ readonly choice: number; readonly arm: number; readonly dsp: number }>,
  choiceMaskCandidates: readonly LexicalChoiceMaskCandidate[] = [],
  resolve?: RefResolver,
): NumericLexicalPlan | undefined {
  if (tokenSites.length === 0) return undefined

  const outcomeById = new Map(alphabet.outcomes.map(outcome => [outcome.id, outcome]))
  const supportedDispatchSites = new Map<number, LexicalTokenClassifier>()
  for (const { dsp, classifier } of dispatchSites) {
    if (classifier.selectorEffects || !classifier.routes.every(route =>
      route.acceptedIds.every(id => {
        const outcome = outcomeById.get(id)
        if (outcome === undefined) return false
        const match = outcome.match
        return runtimeRangeOutcomeKind(
          match.kind,
          match.kind === 'matches' ? match.value : '',
          match.kind === 'matches' ? match.flags : '',
          match.kind === 'matches' && match.caseInsensitive,
        ) !== undefined
      }))) continue
    supportedDispatchSites.set(dsp, classifier)
  }
  const activeCandidates = [...choiceCandidates]
    .filter(candidate => supportedDispatchSites.has(candidate.dsp))
    .sort((a, b) => a.choice - b.choice || a.arm - b.arm)
  const choiceOwned = new Set(activeCandidates.map(candidate => candidate.choice))
  const maskAnalyses = choiceMaskCandidates
    .filter(candidate => !choiceOwned.has(candidate.choice))
    .map(candidate => analyzeChoiceMask(alphabet, candidate, supportedDispatchSites, resolve))
    .filter((analysis): analysis is ChoiceMaskAnalysis => analysis !== undefined)
    .sort((a, b) => a.choice - b.choice)
  // Token streaming is activated by an outer ordered decision that can reuse
  // the range after rollback. A stand-alone dispatch already parses its
  // selector once, so serialising its whole lexical universe only adds artifact
  // and runtime shape without removing a boundary.
  if (activeCandidates.length === 0 && maskAnalyses.length === 0) return undefined
  const activeDsp = new Set(activeCandidates.map(candidate => candidate.dsp))
  for (const analysis of maskAnalyses) activeDsp.add(analysis.dsp)
  const activeFamilies = new Set<number>()
  const activeOutcomeIds = new Set<number>()
  for (const dsp of activeDsp) {
    const classifier = supportedDispatchSites.get(dsp)!
    activeFamilies.add(classifier.familyId)
    for (const route of classifier.routes) for (const id of route.acceptedIds) activeOutcomeIds.add(id)
  }
  for (const analysis of maskAnalyses) for (const id of analysis.outcomeIds) activeOutcomeIds.add(id)

  const recognizerOffsets: number[] = []
  const recognizerData: number[] = []
  for (const recognizer of alphabet.recognizers) {
    if (recognizer.id !== recognizerOffsets.length) throw new Error('parseman: lexical recognizer ids are not dense')
    if (!activeFamilies.has(FIRST_LEXICAL_FAMILY_ID + recognizer.id)) {
      // Preserve the canonical global id as the array index without packing
      // dead recognizers into a choice-anchored artifact.
      recognizerOffsets.push(-1)
      continue
    }
    recognizerOffsets.push(recognizerData.length)
    serializeLexicalIr(recognizer.ir, recognizerData, constant)
  }

  const outcomeOffsets: number[] = []
  const outcomeData: number[] = []
  for (const outcome of alphabet.outcomes) {
    if (!activeOutcomeIds.has(outcome.id)) continue
    outcomeOffsets.push(outcomeData.length)
    const match = outcome.match
    switch (match.kind) {
      case 'exact':
        if (match.values.length !== 1) throw new Error('parseman: lexical exact outcome is not atomic')
        outcomeData.push(outcome.id, outcome.familyId, 0, constant(match.values[0]!), match.caseInsensitive ? 1 : 0)
        break
      case 'startsWith':
        outcomeData.push(outcome.id, outcome.familyId, 1, constant(match.value), match.caseInsensitive ? 1 : 0)
        break
      case 'endsWith':
        outcomeData.push(outcome.id, outcome.familyId, 2, constant(match.value), match.caseInsensitive ? 1 : 0)
        break
      case 'matches': {
        const rawFlags = match.caseInsensitive && !match.flags.includes('i') ? `${match.flags}i` : match.flags
        const flags = new RegExp('', rawFlags.replace(/g/g, '')).flags
        outcomeData.push(outcome.id, outcome.familyId, 3, constant(new RegExp(match.value, flags)))
        break
      }
      case 'otherwise':
        outcomeData.push(outcome.id, outcome.familyId, 4)
        break
    }
  }

  const sites: number[] = []
  const routes: number[] = []
  const accepted: number[] = []
  // `dsp` is a SITE identity, not an interned route-shape identity: encode.ts
  // appends one DispatchSpec at the same moment it emits each memoized
  // OP_DISPATCH. Equal route data in two different selectors therefore gets two
  // indices, while a shared dispatch combinator has one row and one family.
  const dispatchSiteIndex = new Map<number, number>()
  for (const [dsp, classifier] of [...supportedDispatchSites]
    .filter(([dsp]) => activeDsp.has(dsp))
    .sort((a, b) => a[0] - b[0])) {
    dispatchSiteIndex.set(dsp, sites.length / 4)
    const routeOffset = routes.length
    for (const route of classifier.routes) {
      const acceptedOffset = accepted.length
      accepted.push(...route.acceptedIds)
      const kind = route.kind === 'exact' ? 0 : route.kind === 'matcher' ? 1 : 2
      routes.push(route.index, kind | (route.usesRouted ? 4 : 0), acceptedOffset, route.acceptedIds.length)
    }
    sites.push(dsp, classifier.familyId, routeOffset, classifier.routes.length)
  }
  const choiceSites: number[] = []
  for (const candidate of activeCandidates) {
    const site = dispatchSiteIndex.get(candidate.dsp)
    if (site !== undefined) choiceSites.push(candidate.choice, candidate.arm, site)
  }
  const choiceMasks: number[] = []
  for (const analysis of maskAnalyses) {
    const site = dispatchSiteIndex.get(analysis.dsp)
    if (site === undefined) continue
    const words = 6 + analysis.outcomeIds.length + analysis.armMasks.length
    choiceMasks.push(
      words, analysis.choice, site, CHOICE_MASK_STRICT,
      analysis.outcomeIds.length, analysis.armMasks.length,
      ...analysis.outcomeIds, ...analysis.armMasks,
    )
  }
  const activeTokenSites: number[] = []
  for (let i = 0; i < tokenSites.length; i += 2) {
    const family = tokenSites[i + 1]!
    if (family < FIRST_LEXICAL_FAMILY_ID) {
      throw new Error('parseman: lexical token site used a primitive-terminal id')
    }
    if (activeFamilies.has(family)) activeTokenSites.push(tokenSites[i]!, family)
  }
  return {
    recognizerOffsets, recognizerData, outcomeOffsets, outcomeData,
    tokenSites: activeTokenSites, sites, routes, accepted,
    ...(choiceSites.length === 0 ? {} : { choiceSites }),
    ...(choiceMasks.length === 0 ? {} : { choiceMasks }),
  }
}

function foldAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function rangeEquals(input: string, start: number, end: number, value: string, folded: boolean): boolean {
  if (end - start !== value.length) return false
  for (let i = 0; i < value.length; i++) {
    const actual = input.charCodeAt(start + i)
    const expected = value.charCodeAt(i)
    if ((folded ? foldAsciiCode(actual) : actual) !== (folded ? foldAsciiCode(expected) : expected)) return false
  }
  return true
}

function rangeStartsWith(input: string, start: number, end: number, value: string, folded: boolean): boolean {
  return start + value.length <= end && rangeEquals(input, start, start + value.length, value, folded)
}

function rangeEndsWith(input: string, start: number, end: number, value: string, folded: boolean): boolean {
  return end - value.length >= start && rangeEquals(input, end - value.length, end, value, folded)
}

function lexicalOutcomeMatches(
  match: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>,
  input: string,
  start: number,
  end: number,
): boolean {
  if (match.kind === 'exact') {
    return match.values.some(value => rangeEquals(input, start, end, value, match.caseInsensitive))
  }
  if (match.kind === 'startsWith') return rangeStartsWith(input, start, end, match.value, match.caseInsensitive)
  if (match.kind === 'endsWith') return rangeEndsWith(input, start, end, match.value, match.caseInsensitive)
  if ('flags' in match) {
    const flags = match.caseInsensitive && !match.flags.includes('i') ? `${match.flags}i` : match.flags
    return new RegExp(match.value, flags).test(input.slice(start, end))
  }
  return false
}

/**
 * Metadata/reference oracle for compatible same-range views. Exact/prefix/suffix
 * checks read char codes directly; regex matcher views slice only in this cold
 * oracle. Production token cursors must lower matcher plans without treating
 * this helper as their allocation contract.
 */
export function compatibleLexicalOutcomes(
  classifier: LexicalTokenClassifier,
  input: string,
  start: number,
  end: number,
): number[] {
  const ids: number[] = []
  let otherwise: number | undefined
  for (const outcome of classifier.outcomes) {
    const match = outcome.match
    if (match.kind === 'otherwise') { otherwise = outcome.id; continue }
    if (lexicalOutcomeMatches(match, input, start, end) && !ids.includes(outcome.id)) ids.push(outcome.id)
  }
  if (ids.length === 0 && otherwise !== undefined) ids.push(otherwise)
  return ids
}

/**
 * Cold oracle for dispatch selection precedence. Compatible views are a set;
 * selected routing is still exact cases first, then matcher source order, then
 * otherwise, and a selected branch failure remains committed.
 */
export function selectedLexicalOutcome(
  classifier: LexicalTokenClassifier,
  input: string,
  start: number,
  end: number,
): { route: LexicalTokenRoute; outcomeId: number } | undefined {
  for (const route of classifier.routes) {
    for (let i = 0; i < route.matches.length; i++) {
      const match = route.matches[i]!
      if (match.kind === 'otherwise' || lexicalOutcomeMatches(match, input, start, end)) {
        return { route, outcomeId: route.acceptedIds[i]! }
      }
    }
  }
  return undefined
}

/** The id already assigned to this terminal, if it is one. */
export function terminalId(alphabet: Alphabet, p: Combinator<unknown>): number | undefined {
  const key = keyOf(p._def)
  return key === undefined ? undefined : alphabet.byKey.get(key)
}

/**
 * The LEADING terminal of an arm — the one a decision point would consult. Walks
 * through the wrappers that do not consume input, and through a sequence's
 * nullable/zero-width prefix. Returns undefined when the lead is not a single
 * derived terminal, which is the signal to stay scannerless at that site.
 */
export function leadTerminal(
  p: Combinator<unknown>,
  alphabet: Alphabet,
  resolve?: (name: string) => Combinator<unknown> | undefined,
  depth = 0,
): number | undefined {
  if (depth > 24) return undefined
  const direct = terminalId(alphabet, p)
  if (direct !== undefined) return direct
  const d = p._def
  switch (d.tag) {
    case 'sequence': {
      for (const c of d.parsers) {
        // CLASSIFY FIRST. The old order asked for the inner terminal and returned
        // it before checking whether the term could consume anything, so:
        //
        //   sequence(optional(X), Y)  yielded X's terminal as THE lead -- but the
        //                             input may legally start with Y's instead
        //   sequence(not(X), Y)       yielded X's terminal -- from a NEGATIVE
        //                             lookahead, which never consumes
        //
        // A single lead terminal cannot express "X's first set OR Y's", so a
        // nullable prefix has no direct lead and the site must be REJECTED --
        // scannerless gating handles it correctly. Zero-width prefixes are
        // different: they consume nothing, so the next term genuinely leads.
        const cd = c._def.tag
        if (cd === 'not' || cd === 'peek' || cd === 'guard') continue
        if (cd === 'optional' || cd === 'many') return undefined
        return leadTerminal(c, alphabet, resolve, depth + 1)
      }
      return undefined
    }
    case 'sepBy':
      return leadTerminal(d.parser, alphabet, resolve, depth + 1)
    case 'lazy': {
      let target: Combinator<unknown> | undefined
      try { target = d.thunk() } catch { target = undefined }
      if (target === undefined && resolve !== undefined) {
        const name = (p as unknown as { _ruleName?: string })._ruleName
        if (name !== undefined) target = resolve(name)
      }
      return target === undefined ? undefined : leadTerminal(target, alphabet, resolve, depth + 1)
    }
    case 'node': case 'field': case 'label': case 'transform': case 'leaf':
    case 'token': case 'grammar': case 'attempt': case 'expect': case 'withCtx':
    case 'oneOrMore': case 'trivia': case 'recover':
      return leadTerminal(d.parser, alphabet, resolve, depth + 1)
    default:
      return undefined
  }
}

/**
 * The CANDIDATE SET for one decision point: the leading terminals of its arms.
 * `complete` is false when any arm's lead is not a derived terminal — that site
 * must stay scannerless, per-construct, exactly as `scanSkip` and first-set
 * gating already apply per region rather than globally.
 */
export type CandidateSet = { ids: number[]; complete: boolean }

export function candidateSet(
  arms: ReadonlyArray<Combinator<unknown>>,
  alphabet: Alphabet,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): CandidateSet {
  const ids: number[] = []
  let complete = true
  for (const a of arms) {
    const t = leadTerminal(a, alphabet, resolve)
    if (t === undefined) { complete = false; continue }
    if (!ids.includes(t)) ids.push(t)
  }
  return { ids, complete }
}
