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
import { firstSetOf, intersects, matchesEmpty } from '../combinators/first-set.ts'
import { branchUsesRouted } from '../combinators/dispatch.ts'
import type { BalancedSpec } from '../combinators/scanTo.ts'
import { deriveExpected } from '../combinators/expect.ts'
import { assertionFailureExpected, directTerminalFailureExpected } from '../combinators/expected.ts'

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
  | {
    readonly kind: 'balanced'
    readonly open: string
    readonly close: string
    readonly strict: boolean
    readonly raw: boolean
    /** Ordered explicit skippers; ambient trivia/scanSkip precede them unless raw. */
    readonly skip: readonly LexicalIr[]
  }

/** One canonical recognizer spec, shared by every family with equal lexical IR. */
export type LexicalRecognizer = {
  readonly id: number
  readonly key: string
  readonly ir: LexicalIr
  /** Crosswalk into the compiler-wide canonical recognition-family interner. */
  readonly capabilityFamilyId: number
}

/**
 * Spelling-specific failure/probe contract. Families may share recognition IR
 * without sharing where a structured spelling fails or what it expects.
 */
export type LexicalDiagnosticPlan = {
  readonly id: number
  readonly body: Combinator<unknown>
}

/** Pointer-free, compiler-only checkpoints inside one authored token body. */
export type LexicalDiagnosticEvent =
  | { readonly op: 'FAIL'; readonly state: number; readonly expectedId: number }
  | {
    readonly op: 'ASSERT'
    readonly state: number
    readonly innerStart: number
    readonly innerEnd: number
    readonly positive: boolean
    readonly expectedId: number
    readonly snapshotPolicy: 'saveLookaheadMark'
    readonly execution: 'deferred'
  }
  | {
    readonly op: 'REQUIRE'
    readonly state: number
    readonly childStart: number
    readonly childEnd: number
    readonly expectedId: number
    readonly when: 'mandatory-iteration-2-to-min'
    readonly committedChild: 'propagate'
    readonly probe: 'child-only'
    readonly anchor: 'repeat-position'
  }
  | {
    readonly op: 'BAL_CLOSE_STRICT'
    readonly state: number
    readonly expectedId: number
    readonly probe: true
    readonly committed: false
    readonly when: 'close-miss-after-open-body-success'
  }
  | {
    readonly op: 'BAL_CLOSE_RECOVER'
    readonly state: number
    readonly expectedId: number
    readonly probe: true
    readonly committed: false
    readonly when: 'close-miss-after-open-body-success'
    readonly result: 'parseError'
    readonly errorSpan: 'close-position'
    readonly lineAnnotation: 'when-active'
    readonly errorSink: 'when-active'
    readonly cstErrorCapture: 'when-active'
  }

/**
 * Stage-B2 diagnostic metadata. It is intentionally absent from TableProgram:
 * assertion execution and every token-boundary effect remain capability GAPs.
 */
export type LexicalTransitionDiagnosticPlan = {
  readonly id: number
  readonly stateCount: number
  readonly expected: readonly (readonly string[])[]
  readonly events: readonly LexicalDiagnosticEvent[]
}

export type LexicalControlNode = {
  readonly id: number
  readonly parentControlId?: number
  /** Authored parser kind, or the conditional/repeated balanced skipper role. */
  readonly kind: ParserDef['tag'] | 'balanced' | 'balanced-skip'
  readonly stateStart: number
  readonly stateEnd: number
}

export type LexicalControlPlan = {
  readonly id: number
  /** Pointer-free source-control index over the one normalization session. */
  readonly controls: readonly LexicalControlNode[]
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

export type LexicalCapabilityStatus =
  | { readonly kind: 'complete' }
  | { readonly kind: 'gap'; readonly reason: string }
  | { readonly kind: 'impossible'; readonly proof: string }

export type LexicalCapabilityPhase = {
  readonly representation: LexicalCapabilityStatus
  /** A complete body is constructible for every required reader/variant before selection. */
  readonly executableLowering: LexicalCapabilityStatus
}

export type LexicalCapabilityObligations = {
  readonly recognition: LexicalCapabilityPhase
  readonly diagnostics: LexicalCapabilityPhase
  readonly boundaryPlan: LexicalCapabilityPhase
  readonly materializationPlan: LexicalCapabilityPhase
  readonly supportedVariants: LexicalCapabilityPhase
  readonly bindingAndReachability: LexicalCapabilityPhase
}

/** Built-in authored token() context transaction. Compiler-only in this tranche. */
export type LexicalBoundaryPlan = {
  readonly id: 0
  readonly kind: 'token-context-transaction'
}

/** Built-in authored token() source-range value/CST materialization. */
export type LexicalMaterializationPlan = {
  readonly id: 0
  readonly kind: 'token-source-range'
}

/** Exact construction-time grammar wrapper policy, not merely its effective context. */
export type LexicalGrammarWrapperSpec = {
  readonly id: number
  readonly sourceOperationId: number
  readonly clearTrivia: boolean
  readonly triviaBindingId?: number
  readonly trackLines: 'on' | 'off' | 'inherit'
  readonly captureTrivia: boolean
  readonly captureTriviaKindsId?: number
  readonly rootCapture: 'opaque' | 'inherit'
  readonly clonePolicy: 'spread-existing-or-create-canonical'
  readonly postChildPolicy: 'line-propagate-then-annotate-or-return'
}

/** Well-nested overlay over the sole LexicalIr/B2 control/state authority. */
export type LexicalWrapperFrame =
  | {
    readonly id: number
    readonly parentFrameId?: number
    readonly controlId: number
    readonly stateStart: number
    readonly stateEnd: number
    readonly kind: 'token'
    readonly boundaryPlanId: 0
    readonly materializationPlanId: 0
  }
  | {
    readonly id: number
    readonly parentFrameId?: number
    readonly controlId: number
    readonly stateStart: number
    readonly stateEnd: number
    readonly kind: 'grammar'
    readonly wrapperSpecId: number
  }

export type LexicalBoundaryTopology = {
  readonly id: number
  /** Source-order outer-before-inner frames; recognition/control is not duplicated. */
  readonly frames: readonly LexicalWrapperFrame[]
}

export type LexicalCapabilityContext = {
  readonly trivia: Combinator<unknown> | undefined
  readonly scanSkip: readonly Combinator<unknown>[]
  readonly trackLines: boolean
  readonly captureTrivia: boolean
  readonly opaqueRootCapture: boolean
  readonly dynamicState: boolean
}

/**
 * Compiler-only phase-A census record. These ids are deliberately not family
 * ids: two authored sites can share one future language while remaining two
 * independently auditable capability obligations.
 */
export type LexicalCapabilitySite = {
  readonly id: number
  /** Interned recognition-language summary; never used as a completeness id. */
  readonly languageId: number
  readonly path: string
  /** Effective lexical scope at this occurrence; compiler-only, never a family id. */
  readonly contextKey: string
  /** Context seen by recognition after token() clears trivia/capture sinks. */
  readonly recognitionContextKey: string
  readonly context: LexicalCapabilityContext
  readonly recognitionContext: LexicalCapabilityContext
  readonly semanticKey: string
  readonly atom: 'terminal' | 'token' | 'choice' | 'dispatch'
  readonly parser: Combinator<unknown>
  readonly obligations: LexicalCapabilityObligations
  /** Internal body metadata only; never claims the boundary effects obligation. */
  readonly diagnosticPlanId?: number
  /** Compiler-only boundary overlay; absent when exact representation declined. */
  readonly boundaryTopologyId?: number
  /** Control ancestry authority used by the boundary overlay. */
  readonly controlPlanId?: number
  /** Derived from `obligations`; callers cannot independently set it. */
  readonly status: LexicalCapabilityStatus
}

export type LexicalCapabilityLanguage = {
  readonly id: number
  readonly atom: LexicalCapabilitySite['atom']
  readonly semanticKey: string
}

/**
 * One compiler-wide canonical source-range language. IDs use the lexical
 * family namespace even while phase B is disabled; decision plans and the
 * legacy token collector cross-reference this one IR interner.
 */
export type LexicalDecisionFamily = {
  readonly id: number
  readonly semanticKey: string
  readonly ir: LexicalIr
}

/**
 * A compatible view of one family range. `prefix` owns its own shorter end;
 * consumers must never substitute the full family end (the `a | ab` rule).
 */
export type LexicalDecisionOutcomeView =
  | { readonly kind: 'whole'; readonly relation: 'equal' }
  | {
    readonly kind: 'predicate'
    readonly relation: 'equal'
    readonly match: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>
  }
  | {
    readonly kind: 'language'
    readonly relation: 'equal' | 'prefix'
    readonly ir: LexicalIr
  }

/** Global, family-qualified atomic outcome/view identity. */
export type LexicalDecisionOutcome = {
  readonly id: number
  readonly familyId: number
  readonly semanticKey: string
  readonly view: LexicalDecisionOutcomeView
}

export type LexicalDecisionAcceptance =
  | { readonly kind: 'outcomes'; readonly outcomeIds: readonly number[] }
  | { readonly kind: 'otherwise'; readonly excludingOutcomeIds: readonly number[] }
  | { readonly kind: 'unrestricted' }
  | { readonly kind: 'impossible' }
  | { readonly kind: 'gap'; readonly reason: string }

/** One source-ordered arm/route for one candidate family at one occurrence. */
export type LexicalDecisionArm = {
  readonly armId: number
  readonly acceptance: LexicalDecisionAcceptance
  readonly usesRouted: boolean
  readonly dynamicGate: boolean
}

export type LexicalDecisionFamilyPlan = {
  readonly familyId: number
  readonly arms: readonly LexicalDecisionArm[]
}

/** Occurrence-local ordered decision proof; never serialized in this tranche. */
export type LexicalDecisionSite = {
  readonly siteId: number
  readonly atom: 'choice' | 'dispatch'
  readonly path: string
  readonly contextKey: string
  readonly families: readonly LexicalDecisionFamilyPlan[]
  /** Families not proven at this occurrence remain admitted through this
   * conservative relation. It is an explicit TOKEN-body route, never a request
   * to replay the character parser. */
  readonly fallback: 'unrestricted'
  /** Missing inclusion/partition proofs reduce pruning precision only. Every
   * authored arm still runs its own exact replacement recognizer in PEG order. */
  readonly precisionNotes: readonly string[]
}

/** One fixed incoming/root edge whose direct linked-body candidates remain owed. */
export type LexicalBindingEdge = {
  readonly id: number
  readonly path: string
  readonly contextKey: string
  readonly parentTag: ParserDef['tag'] | 'root'
  readonly childTag: ParserDef['tag']
  readonly status: LexicalCapabilityStatus
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
  /** Whole-final-grammar, ownership-aware phase-A capability census. */
  readonly capabilities: readonly LexicalCapabilitySite[]
  /** Interned language view only; completeness is always occurrence-based. */
  readonly capabilityLanguages: readonly LexicalCapabilityLanguage[]
  /** Every distinct fixed parent/root edge, independently GAP until linked. */
  readonly bindingEdges: readonly LexicalBindingEdge[]
  /** Phase-A compatible range/arm algebra; compiler-only and occurrence-local. */
  readonly decisionFamilies: readonly LexicalDecisionFamily[]
  readonly decisionOutcomes: readonly LexicalDecisionOutcome[]
  readonly decisions: readonly LexicalDecisionSite[]
  readonly transitionDiagnostics: readonly LexicalTransitionDiagnosticPlan[]
  readonly boundaryPlans: readonly LexicalBoundaryPlan[]
  readonly materializationPlans: readonly LexicalMaterializationPlan[]
  readonly grammarWrapperSpecs: readonly LexicalGrammarWrapperSpec[]
  readonly grammarCaptureTriviaKinds: readonly (readonly string[])[]
  readonly boundaryTopologies: readonly LexicalBoundaryTopology[]
  readonly controlPlans: readonly LexicalControlPlan[]
  /** False means phase B is forbidden for the entire program. */
  readonly capabilityComplete: boolean
}

export type LexicalCapabilityInventory = Pick<
  LexicalAlphabet,
  'capabilities' | 'capabilityLanguages' | 'bindingEdges'
  | 'decisionFamilies' | 'decisionOutcomes' | 'decisions' | 'transitionDiagnostics'
  | 'boundaryPlans' | 'materializationPlans' | 'grammarWrapperSpecs'
  | 'grammarCaptureTriviaKinds' | 'boundaryTopologies'
  | 'controlPlans'
  | 'capabilityComplete'
>

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

/** Does a final rule-map winner bottom out at the reference being resolved? */
export function winnerWrapsReference(
  winner: Combinator<unknown>,
  reference: Combinator<unknown>,
): boolean {
  let current = winner
  const seen = new Set<Combinator<unknown>>()
  // Only wrappers introduced by rules()/parser() are transparent here. Walking
  // into a sequence or choice would mistake ordinary recursive use for an alias.
  while (!seen.has(current)) {
    if (current === reference) return true
    seen.add(current)
    const def = current._def
    if (def.tag !== 'grammar' && def.tag !== 'trivia') return false
    current = def.parser
  }
  return false
}

/** Final winner resolution is authoritative; a stale construction thunk is fallback only. */
function resolvedLazyTarget(
  parser: Combinator<unknown>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): Combinator<unknown> | undefined {
  const def = parser._def
  if (def.tag !== 'lazy') return undefined
  const name = (parser as unknown as { _ruleName?: string })._ruleName
  if (name !== undefined && resolve !== undefined) {
    const winner = resolve(name)
    // A named rule whose whole definition is itself a lazy alias is stamped
    // with its OWN name. Resolving that name returns the same object, not the
    // referenced winner; only a distinct winner supersedes the construction
    // thunk.
    if (winner !== undefined && !winnerWrapsReference(winner, parser)) return winner
  }
  try { return def.thunk() } catch { return undefined }
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
    push(resolvedLazyTarget(p, resolve))
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

type PendingLexicalWrapperFrame =
  | {
    readonly id: number
    readonly parentFrameId?: number
    readonly controlId: number
    readonly kind: 'token'
    stateStart: number
    stateEnd: number
  }
  | {
    readonly id: number
    readonly parentFrameId?: number
    readonly controlId: number
    readonly kind: 'grammar'
    readonly parser: Combinator<unknown>
    stateStart: number
    stateEnd: number
  }

type LexicalNormalizeSession = {
  nextState: number
  readonly expected: string[][]
  readonly expectedIds: Map<string, number>
  readonly events: LexicalDiagnosticEvent[]
  readonly wrapperFrames: PendingLexicalWrapperFrame[]
  readonly wrapperStack: number[]
  readonly controls: LexicalControlNode[]
  readonly controlStack: number[]
}

function newNormalizeSession(): LexicalNormalizeSession {
  return {
    nextState: 0, expected: [], expectedIds: new Map(), events: [],
    wrapperFrames: [], wrapperStack: [], controls: [], controlStack: [],
  }
}

function withLexicalControl(
  session: LexicalNormalizeSession | undefined,
  kind: LexicalControlNode['kind'],
  body: () => Normalized,
): Normalized {
  if (session === undefined) return body()
  const id = session.controls.length
  const parentControlId = session.controlStack[session.controlStack.length - 1]
  const node: LexicalControlNode = {
    id, ...(parentControlId === undefined ? {} : { parentControlId }), kind,
    stateStart: session.nextState, stateEnd: -1,
  }
  session.controls.push(node)
  session.controlStack.push(id)
  try {
    const result = body()
    ;(node as { stateEnd: number }).stateEnd = session.nextState
    return result
  } finally {
    const popped = session.controlStack.pop()
    if (popped !== id) throw new Error('parseman: lexical control stack is not well nested')
  }
}

function withLexicalWrapper(
  session: LexicalNormalizeSession | undefined,
  kind: 'token' | 'grammar',
  parser: Combinator<unknown>,
  body: () => Normalized,
): Normalized {
  if (session === undefined) return body()
  const controlId = session.controlStack[session.controlStack.length - 1]
  if (controlId === undefined) throw new Error('parseman: lexical wrapper lacks a control anchor')
  const id = session.wrapperFrames.length
  const parentFrameId = session.wrapperStack[session.wrapperStack.length - 1]
  const common = {
    id, ...(parentFrameId === undefined ? {} : { parentFrameId }), controlId,
    stateStart: session.nextState, stateEnd: -1,
  }
  const frame: PendingLexicalWrapperFrame = kind === 'token'
    ? { ...common, kind }
    : { ...common, kind, parser }
  session.wrapperFrames.push(frame)
  session.wrapperStack.push(id)
  try {
    const result = body()
    frame.stateEnd = session.nextState
    return result
  } finally {
    const popped = session.wrapperStack.pop()
    if (popped !== id) throw new Error('parseman: lexical wrapper stack is not well nested')
  }
}

function lexicalState(session?: LexicalNormalizeSession): number {
  return session === undefined ? -1 : session.nextState++
}

function lexicalExpected(session: LexicalNormalizeSession, expected: readonly string[]): number {
  const key = JSON.stringify(expected)
  const prior = session.expectedIds.get(key)
  if (prior !== undefined) return prior
  const id = session.expected.length
  session.expectedIds.set(key, id)
  session.expected.push([...expected])
  return id
}

function lexicalFail(session: LexicalNormalizeSession | undefined, state: number, expected: readonly string[]): void {
  if (session !== undefined) {
    session.events.push({ op: 'FAIL', state, expectedId: lexicalExpected(session, expected) })
  }
}

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

function normalizeRegex(source: string, flags: string, session?: LexicalNormalizeSession): LexicalIr {
  const failure = directTerminalFailureExpected({ tag: 'regex', source, flags })
  const proof = provenOptionalLiteralSuffix(source, flags)
  if (proof === undefined) {
    const state = lexicalState(session)
    lexicalFail(session, state, failure)
    return { kind: 'regex', source, flags }
  }
  lexicalState(session) // synthetic sequence
  const baseState = lexicalState(session)
  lexicalFail(session, baseState, failure)
  lexicalState(session) // synthetic optional repeat
  lexicalState(session) // synthetic optional literal; no invented FAIL event
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
  session?: LexicalNormalizeSession,
): Normalized {
  if (stack.has(parser)) return { refusal: 'recursive token body' }
  stack.add(parser)
  try {
    return withLexicalControl(session, parser._def.tag, () =>
      normalizeLexicalBody(parser, resolve, stack, session))
  } finally {
    stack.delete(parser)
  }
}

function normalizeLexicalBody(
  parser: Combinator<unknown>,
  resolve: ((name: string) => Combinator<unknown> | undefined) | undefined,
  stack: Set<Combinator<unknown>>,
  session?: LexicalNormalizeSession,
): Normalized {
  const done = (result: Normalized): Normalized => result
  const child = (value: Combinator<unknown>): Normalized => normalizeLexical(value, resolve, stack, session)
  const def = parser._def

  switch (def.tag) {
    case 'literal': {
      const state = lexicalState(session)
      lexicalFail(session, state, directTerminalFailureExpected(def))
      return done({ ir: {
        kind: 'literal',
        value: def.caseInsensitive ? def.value.replace(/[A-Z]/g, c => c.toLowerCase()) : def.value,
        caseInsensitive: def.caseInsensitive,
      } })
    }
    case 'keywords': {
      const state = lexicalState(session)
      lexicalFail(session, state, directTerminalFailureExpected(def))
      const words = [...new Set(def.words.map(word => def.caseInsensitive
        ? word.replace(/[A-Z]/g, c => c.toLowerCase())
        : word))].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      return done({ ir: {
        kind: 'keywords', words, caseInsensitive: def.caseInsensitive, boundary: def.boundary,
      } })
    }
    case 'regex':
      return done({ ir: normalizeRegex(def.source, regexFlags(def.flags), session) })
    case 'sequence': {
      lexicalState(session)
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
      lexicalState(session)
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
      lexicalState(session)
      const normalized = child(def.parser)
      return done('refusal' in normalized ? normalized : {
        ir: { kind: 'repeat', body: normalized.ir, min: 0, max: 1, greedy: true, mode: 'possessive' },
      })
    }
    case 'many':
    case 'oneOrMore': {
      const state = lexicalState(session)
      if (matchesEmpty(def.parser)) return done({ refusal: 'repeat body may not make progress' })
      const childStart = session?.nextState ?? -1
      const normalized = child(def.parser)
      if ('refusal' in normalized) return done(normalized)
      if (session !== undefined && def.min > 1) {
        const expected = deriveExpected(def.parser)
        session.events.push({
          op: 'REQUIRE', state, childStart, childEnd: session.nextState,
          expectedId: lexicalExpected(session, expected.length > 0 ? expected : [def.parser._tag]),
          when: 'mandatory-iteration-2-to-min', committedChild: 'propagate',
          probe: 'child-only', anchor: 'repeat-position',
        })
      }
      return done({
        ir: { kind: 'repeat', body: normalized.ir, min: def.min, max: def.max ?? null, greedy: true, mode: 'possessive' },
      })
    }
    case 'not':
    case 'peek': {
      const state = lexicalState(session)
      const innerStart = session?.nextState ?? -1
      const normalized = child(def.parser)
      if ('refusal' in normalized) return done(normalized)
      if (session !== undefined) session.events.push({
        op: 'ASSERT', state, innerStart, innerEnd: session.nextState,
        positive: def.tag === 'peek',
        expectedId: lexicalExpected(session, assertionFailureExpected(def.tag === 'peek', def.parser._tag)),
        snapshotPolicy: 'saveLookaheadMark', execution: 'deferred',
      })
      return done({
        ir: { kind: 'assert', positive: def.tag === 'peek', body: normalized.ir },
      })
    }
    case 'lazy': {
      const target = resolvedLazyTarget(parser, resolve)
      return done(target === undefined ? { refusal: 'unresolved lazy token body' } : child(target))
    }
    case 'token':
      return done(withLexicalWrapper(session, 'token', parser, () => child(def.parser)))
    case 'trivia':
      return done(child(def.parser))
    case 'grammar':
      // A direct token child installs its own contiguous lexical context before
      // its body runs. The enclosing scope's trivia/capture/line policy is
      // therefore recognition-inert (its observable effects remain a separate
      // capability obligation). Keep every other trivia-bearing scope distinct:
      // trivia between ordinary child terms changes the accepted language.
      if (def.parser._def.tag === 'token') {
        return done(withLexicalWrapper(session, 'grammar', parser, () => child(def.parser)))
      }
      if (def.trackLines) return done({ refusal: 'token body has line-tracking effects' })
      if (def.triviaParser !== undefined || def.captureTrivia === true || def.rootCapture !== undefined) {
        return done({ refusal: 'token body has a trivia-bearing scope' })
      }
      return done(withLexicalWrapper(session, 'grammar', parser, () => child(def.parser)))
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

/**
 * `balanced()` deliberately overrides its eager structural `_def`; the
 * constructor marker is the only authoritative recognition language. Model it
 * directly instead of rediscovering a recursive transform/expect expansion.
 */
function normalizeBalancedLexical(
  parser: Combinator<unknown>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
  ambientScanSkip: readonly Combinator<unknown>[] = [],
  session?: LexicalNormalizeSession,
): Normalized | undefined {
  // `token(balanced(...))` is legal and appears in Jess. The outer token owns
  // the public leaf, while the inner balanced token owns the constructor marker.
  let marked = parser
  let spec = (marked as BalancedSpec)._balancedSpec
  const tokenWrappers: Combinator<unknown>[] = []
  while (marked._def.tag === 'token') {
    tokenWrappers.push(marked)
    marked = marked._def.parser
    spec ??= (marked as BalancedSpec)._balancedSpec
  }
  if (spec === undefined) return undefined
  const machine = (): Normalized => withLexicalControl(session, 'balanced', () => {
    lexicalState(session) // balanced machine
    const openState = lexicalState(session)
    if (session !== undefined) lexicalFail(session, openState, directTerminalFailureExpected({
      tag: 'literal', value: spec.open, caseInsensitive: false,
    }))
    lexicalState(session) // balanced body scan
    const skip: LexicalIr[] = []
    // balanced() intentionally ignores ambient trivia. Non-raw instances do
    // consult grammar scanSkip before their own ordered skip list; raw instances
    // exclude the ambient list entirely.
    for (const entry of spec.raw ? spec.ownSkip : [...ambientScanSkip, ...spec.ownSkip]) {
      const normalized = withLexicalControl(session, 'balanced-skip', () =>
        normalizeLexical(entry, resolve, new Set(), session))
      if ('refusal' in normalized) return {
        refusal: `balanced skipper is not represented: ${normalized.refusal}`,
      }
      skip.push(normalized.ir)
    }
    const closeState = lexicalState(session)
    if (session !== undefined) {
      const expectedId = lexicalExpected(session, directTerminalFailureExpected({
        tag: 'literal', value: spec.close, caseInsensitive: false,
      }))
      session.events.push(spec.strict
        ? {
            op: 'BAL_CLOSE_STRICT', state: closeState, expectedId, probe: true, committed: false,
            when: 'close-miss-after-open-body-success',
          }
        : {
            op: 'BAL_CLOSE_RECOVER', state: closeState, expectedId,
            probe: true, committed: false, when: 'close-miss-after-open-body-success',
            result: 'parseError', errorSpan: 'close-position',
            lineAnnotation: 'when-active', errorSink: 'when-active', cstErrorCapture: 'when-active',
          })
    }
    return {
      ir: {
        kind: 'balanced', open: spec.open, close: spec.close,
        strict: spec.strict, raw: spec.raw, skip,
      },
    }
  })
  const wrap = (index: number): Normalized => {
    const tokenParser = tokenWrappers[index]
    return tokenParser === undefined ? machine()
      : withLexicalControl(session, 'token', () =>
        withLexicalWrapper(session, 'token', tokenParser, () => wrap(index + 1)))
  }
  return wrap(0)
}

const CAPABILITY_VARIANT_GAP =
  'total token replacement body is not implemented for every supported assembly variant'
const FIXED_TUPLE_BINDING_GAP =
  'binding candidate set is incomplete: shared, direct captured, and statically named fixed-tuple bodies have not all been built before pricing; fixed children and routes may not be rediscovered from arrays'
const COMPLETE_CAPABILITY = { kind: 'complete' } as const
const gap = (reason: string): LexicalCapabilityStatus => ({ kind: 'gap', reason })
const COMPLETE_PHASE: LexicalCapabilityPhase = {
  representation: COMPLETE_CAPABILITY,
  executableLowering: COMPLETE_CAPABILITY,
}
const phaseGap = (representation: LexicalCapabilityStatus, loweringReason: string): LexicalCapabilityPhase => ({
  representation,
  executableLowering: representation.kind === 'impossible'
    ? representation : gap(loweringReason),
})

function derivedCapabilityStatus(obligations: LexicalCapabilityObligations): LexicalCapabilityStatus {
  const phases = [
    obligations.recognition,
    obligations.diagnostics,
    obligations.boundaryPlan,
    obligations.materializationPlan,
    obligations.supportedVariants,
    obligations.bindingAndReachability,
  ]
  const ordered = phases.flatMap(entry => [entry.representation, entry.executableLowering])
  const impossible = ordered.find((entry): entry is Extract<LexicalCapabilityStatus, { kind: 'impossible' }> =>
    entry.kind === 'impossible')
  if (impossible !== undefined) return impossible
  // Capability is availability before selection: only executable lowering can
  // close it. Actual execution is test evidence, not a third status dimension.
  const gaps = phases.map(entry => entry.executableLowering)
    .filter((entry): entry is Extract<LexicalCapabilityStatus, { kind: 'gap' }> =>
    entry.kind === 'gap')
  if (gaps.length > 0) return gap([...new Set(gaps.map(entry => entry.reason))].join('; '))
  return COMPLETE_CAPABILITY
}

function tokenObligations(
  recognition: LexicalCapabilityStatus,
  represented: {
    readonly diagnostics: boolean
    readonly boundaryPlan: LexicalCapabilityStatus
    readonly materializationPlan: LexicalCapabilityStatus
  } = {
    diagnostics: false,
    boundaryPlan: gap('token boundary transaction is not represented'),
    materializationPlan: gap('token range/value/CST materialization is not represented'),
  },
): LexicalCapabilityObligations {
  const representedOrGap = (yes: boolean, reason: string): LexicalCapabilityStatus =>
    yes ? COMPLETE_CAPABILITY : gap(reason)
  return {
    recognition: phaseGap(recognition, 'token recognizer lowering is not implemented for every supported variant'),
    diagnostics: phaseGap(
      representedOrGap(represented.diagnostics, 'token diagnostic plan is not represented'),
      'token diagnostic event lowering is deferred'),
    boundaryPlan: phaseGap(
      represented.boundaryPlan,
      'token boundary transaction lowering is deferred'),
    materializationPlan: phaseGap(
      represented.materializationPlan,
      'token range/value/CST materialization lowering is deferred'),
    supportedVariants: phaseGap(gap(CAPABILITY_VARIANT_GAP), CAPABILITY_VARIANT_GAP),
    bindingAndReachability: phaseGap(gap(FIXED_TUPLE_BINDING_GAP), FIXED_TUPLE_BINDING_GAP),
  }
}

function terminalObligations(): LexicalCapabilityObligations {
  return {
    recognition: COMPLETE_PHASE,
    diagnostics: COMPLETE_PHASE,
    boundaryPlan: COMPLETE_PHASE,
    materializationPlan: COMPLETE_PHASE,
    supportedVariants: COMPLETE_PHASE,
    bindingAndReachability: phaseGap(gap(FIXED_TUPLE_BINDING_GAP), FIXED_TUPLE_BINDING_GAP),
  }
}

function decisionObligations(recognition: LexicalCapabilityStatus): LexicalCapabilityObligations {
  return tokenObligations(recognition)
}

type DecisionLead = {
  readonly parser: Combinator<unknown>
  readonly ir: LexicalIr
  readonly key: string
  readonly dispatch?: Extract<ParserDef, { tag: 'dispatch' }>
}

type DecisionLeadResult = { readonly lead: DecisionLead } | { readonly gap: string }

/**
 * Find the one atomic range whose recognition starts this arm. This is only a
 * language proof: wrappers still owe diagnostics/effects and remain in the
 * eventual replacement body. Nullable prefixes and context-changing wrappers
 * deliberately decline the pruning proof rather than being guessed through.
 * The authored arm remains an explicit unrestricted TOKEN-body candidate; a
 * declined relation is not a missing recognizer and never licenses replay.
 */
function decisionLead(
  parser: Combinator<unknown>,
  context: CapabilityContext,
  resolve: ((name: string) => Combinator<unknown> | undefined) | undefined,
  seen = new Set<Combinator<unknown>>(),
): DecisionLeadResult {
  if (seen.has(parser)) return { gap: 'recursive leading decision language' }
  seen.add(parser)
  const finish = (result: DecisionLeadResult): DecisionLeadResult => { seen.delete(parser); return result }
  const def = parser._def
  if (keyOf(def) !== undefined || def.tag === 'token' || (parser as BalancedSpec)._balancedSpec !== undefined) {
    const normalized = normalizeBalancedLexical(parser, resolve, context.scanSkip)
      ?? normalizeLexical(def.tag === 'token' ? def.parser : parser, resolve, new Set())
    if ('refusal' in normalized) return finish({ gap: `leading recognizer: ${normalized.refusal}` })
    return finish({ lead: {
      parser,
      ir: normalized.ir,
      key: JSON.stringify(normalized.ir),
    } })
  }
  switch (def.tag) {
    case 'dispatch': {
      const selected = decisionLead(def.selector, context, resolve, seen)
      if ('gap' in selected) return finish(selected)
      return finish({ lead: { ...selected.lead, dispatch: def } })
    }
    case 'lazy': {
      const target = resolvedLazyTarget(parser, resolve)
      return finish(target === undefined
        ? { gap: 'unresolved leading rule reference' }
        : decisionLead(target, context, resolve, seen))
    }
    case 'sequence':
      if (def.parsers.length === 0) return finish({ gap: 'empty leading sequence' })
      if (matchesEmpty(def.parsers[0]!, new Set(), resolve)) {
        return finish({ gap: 'nullable leading sequence needs a total same-position union proof' })
      }
      return finish(decisionLead(def.parsers[0]!, context, resolve, seen))
    case 'attempt': case 'transform': case 'leaf': case 'node': case 'field': case 'label': case 'expect':
    case 'trivia':
      return finish(decisionLead(def.parser, context, resolve, seen))
    case 'grammar':
      if (def.triviaParser !== undefined || def.clearTrivia === true || def.trackLines
        || def.captureTrivia === true || def.rootCapture !== undefined) {
        return finish({ gap: 'leading grammar wrapper changes lexical context' })
      }
      return finish(decisionLead(def.parser, context, resolve, seen))
    case 'choice': return finish({ gap: 'nested leading choice needs a compatible range union proof' })
    case 'optional': case 'many': case 'oneOrMore': case 'sepBy':
      return finish({ gap: 'repeated or nullable leading language needs a range-partition proof' })
    case 'peek': return finish({ gap: 'positive lookahead needs an exact effect-free compatible view' })
    case 'not': return finish({ gap: 'negative lookahead needs a decidable complement' })
    case 'withCtx': case 'guard': case 'adjacency': case 'recover': case 'scanTo': case 'routed': case 'unknown':
      return finish({ gap: `leading ${def.tag} language is not represented` })
    case 'literal': case 'keywords': case 'regex':
      throw new Error('parseman: decision lead terminal escaped its direct case')
  }
}

function finiteLexicalValues(ir: LexicalIr): readonly string[] | undefined {
  if (ir.kind === 'literal') return [ir.value]
  if (ir.kind === 'keywords') return ir.words
  return undefined
}

function lexicalIrEnd(ir: LexicalIr, input: string, start = 0): number | undefined {
  switch (ir.kind) {
    case 'literal': {
      const actual = input.slice(start, start + ir.value.length)
      return (ir.caseInsensitive ? foldAscii(actual) === foldAscii(ir.value) : actual === ir.value)
        ? start + ir.value.length : undefined
    }
    case 'keywords': {
      for (const word of ir.words) {
        const actual = input.slice(start, start + word.length)
        if (ir.caseInsensitive ? foldAscii(actual) === foldAscii(word) : actual === word) {
          const next = input[start + word.length]
          if (next === undefined || ir.boundary === undefined) return start + word.length
          try {
            if (!new RegExp(`[${ir.boundary}]`).test(next)) return start + word.length
          } catch { return undefined }
        }
      }
      return undefined
    }
    case 'regex': {
      try {
        // regex() performs one authored sticky match. Anchoring the source in a
        // wrapper changes both alternation backtracking (`a|ab`) and multiline
        // `$` semantics, so proof must inspect the actual chosen end.
        const matcher = new RegExp(ir.source, `${regexFlags(ir.flags)}y`)
        matcher.lastIndex = start
        const match = matcher.exec(input)
        return match === null ? undefined : matcher.lastIndex
      } catch { return undefined }
    }
    case 'choice': {
      for (const arm of ir.arms) {
        const end = lexicalIrEnd(arm, input, start)
        if (end !== undefined) return end
      }
      return undefined
    }
    case 'sequence': {
      let end = start
      for (const part of ir.parts) {
        const next = lexicalIrEnd(part, input, end)
        if (next === undefined) return undefined
        end = next
      }
      return end
    }
    case 'repeat': {
      let end = start
      let count = 0
      while (ir.max === null || count < ir.max) {
        const next = lexicalIrEnd(ir.body, input, end)
        if (next === undefined || next === end) break
        end = next
        count++
      }
      return count >= ir.min ? end : undefined
    }
    case 'assert': {
      const matched = lexicalIrEnd(ir.body, input, start) !== undefined
      return matched === ir.positive ? start : undefined
    }
    case 'balanced': return undefined
  }
}

function lexicalIrAcceptsExact(ir: LexicalIr, value: string): boolean {
  return lexicalIrEnd(ir, value) === value.length
}

function asciiCaseVariants(value: string, caseInsensitive: boolean): readonly string[] | undefined {
  if (caseInsensitive && /[^\x00-\x7f]/.test(value)) return undefined
  if (!caseInsensitive || !/[A-Za-z]/.test(value)) return [value]
  let variants = ['']
  for (const char of value) {
    const lower = char >= 'A' && char <= 'Z' ? char.toLowerCase() : char
    const upper = char >= 'a' && char <= 'z' ? char.toUpperCase() : char
    if (lower !== upper && variants.length > 2048) return undefined
    variants = lower === upper
      ? variants.map(prefix => prefix + char)
      : variants.flatMap(prefix => [prefix + lower, prefix + upper])
  }
  return variants
}

function regexAsciiCaseStable(source: string): boolean {
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '\\') {
      const kind = source[index + 1]
      if (kind === 'x') {
        const value = Number.parseInt(source.slice(index + 2, index + 4), 16)
        if (Number.isFinite(value) && /[A-Za-z]/.test(String.fromCharCode(value))) return false
        index += 4
        continue
      }
      if (kind === 'u') {
        const brace = source[index + 2] === '{'
        const end = brace ? source.indexOf('}', index + 3) : index + 6
        const digits = brace ? source.slice(index + 3, end) : source.slice(index + 2, end)
        const value = Number.parseInt(digits, 16)
        if (Number.isFinite(value) && value <= 0xffff
          && /[A-Za-z]/.test(String.fromCharCode(value))) return false
        index = brace ? (end + 1 || source.length) : end
        continue
      }
      if (kind !== undefined && 'dDsSwWpP'.includes(kind)) { index += 2; continue }
      if (kind !== undefined && /[A-Za-z]/.test(kind)) return false
      index += 2
      continue
    }
    if (char === '[') {
      let end = index + 1
      for (; end < source.length; end++) {
        if (source[end] === '\\') { end++; continue }
        if (source[end] === ']') break
      }
      if (end >= source.length) return false
      const body = source.slice(index + 1, end)
      const lowerRange = body.includes('a-z')
      const upperRange = body.includes('A-Z')
      if (lowerRange !== upperRange) return false
      const withoutRanges = body.replace(/a-z|A-Z/g, '')
      const literals = new Set<string>()
      for (let at = 0; at < withoutRanges.length; at++) {
        if (withoutRanges[at] === '\\') {
          const kind = withoutRanges[++at]
          if (kind === 'x') {
            const value = Number.parseInt(withoutRanges.slice(at + 1, at + 3), 16)
            if (Number.isFinite(value) && /[A-Za-z]/.test(String.fromCharCode(value))) {
              literals.add(String.fromCharCode(value))
            }
            at += 2
          }
          else if (kind === 'u') {
            let digits: string
            if (withoutRanges[at + 1] === '{') {
              const end = withoutRanges.indexOf('}', at + 2)
              if (end < 0) return false
              digits = withoutRanges.slice(at + 2, end)
              at = end
            } else {
              digits = withoutRanges.slice(at + 1, at + 5)
              at += 4
            }
            const value = Number.parseInt(digits, 16)
            if (Number.isFinite(value) && value <= 0xffff
              && /[A-Za-z]/.test(String.fromCharCode(value))) {
              literals.add(String.fromCharCode(value))
            }
          } else if (kind !== undefined && /[A-Za-z]/.test(kind)
            && !'dDsSwWpP'.includes(kind)) return false
          continue
        }
        if (/[A-Za-z]/.test(withoutRanges[at]!)) literals.add(withoutRanges[at]!)
      }
      for (const letter of literals) {
        const peer = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
        if (!literals.has(peer)) return false
      }
      index = end + 1
      continue
    }
    if (/[A-Za-z]/.test(char)) return false
    index++
  }
  return true
}

function lexicalIrAsciiCaseStable(ir: LexicalIr): boolean {
  switch (ir.kind) {
    case 'literal': return ir.caseInsensitive || !/[A-Za-z]/.test(ir.value)
    case 'keywords': return ir.caseInsensitive
      || ir.words.every(word => !/[A-Za-z]/.test(word))
    case 'regex': return ir.flags.includes('i') || regexAsciiCaseStable(ir.source)
    case 'sequence': return ir.parts.every(lexicalIrAsciiCaseStable)
    case 'choice': return ir.arms.every(lexicalIrAsciiCaseStable)
    case 'repeat': case 'assert': return lexicalIrAsciiCaseStable(ir.body)
    case 'balanced': return !/[A-Za-z]/.test(ir.open + ir.close)
      && ir.skip.every(lexicalIrAsciiCaseStable)
  }
}

type ContinuationClass = { readonly source: string; readonly flags: string }

function lexicalContinuationClasses(ir: LexicalIr): readonly ContinuationClass[] | undefined {
  if (ir.kind === 'regex') {
    const classesRemoved = ir.source.replace(/\[(?:\\.|[^\]\\])*\]/g, '[]')
    if (/[|()$^]/.test(classesRemoved) || /\\[bB]/.test(classesRemoved)) return undefined
    const tail = /(\[(?:\\.|[^\]\\])+\])(?:\*|\+)$/.exec(ir.source)
    if (tail === null || /[uv]/.test(ir.flags) || /\\[pP]|\\u\{/.test(tail[1]!)) return undefined
    return [{ source: tail[1]!, flags: ir.flags }]
  }
  if (ir.kind === 'sequence' && ir.parts.length === 2) {
    const [head, tail] = ir.parts
    if (tail?.kind !== 'repeat' || tail.min !== 0 || tail.max !== 1
      || tail.body.kind !== 'literal' || [...tail.body.value].length !== 1) return undefined
    const headClasses = lexicalContinuationClasses(head!)
    if (headClasses === undefined) return undefined
    const escaped = tail.body.value.replace(/[\\\]\-^]/g, '\\$&')
    return [...headClasses, {
      source: `[${escaped}]`, flags: tail.body.caseInsensitive ? 'i' : '',
    }]
  }
  return undefined
}

function boundaryCoversContinuation(family: LexicalIr, boundary: string): boolean {
  const classes = lexicalContinuationClasses(family)
  if (classes === undefined) return false
  let boundaryMatcher: RegExp
  const matchers: RegExp[] = []
  try {
    boundaryMatcher = new RegExp(`^[${boundary}]$`)
    for (const entry of classes) {
      matchers.push(new RegExp(`^${entry.source}$`, regexFlags(entry.flags)))
    }
  } catch { return false }
  for (let code = 0; code <= 0xffff; code++) {
    const char = String.fromCharCode(code)
    if (matchers.some(matcher => matcher.test(char)) && !boundaryMatcher.test(char)) return false
  }
  return true
}

function fixedRegexLiteral(source: string): string | undefined {
  let value = ''
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char !== '\\') {
      if (/[.[\]{}()*+?|^$]/.test(char)) return undefined
      value += char
      continue
    }
    const kind = source[++index]
    if (kind === undefined || 'dDsSwWpPbB'.includes(kind)) return undefined
    if (kind === 'x') {
      const code = Number.parseInt(source.slice(index + 1, index + 3), 16)
      if (!Number.isFinite(code)) return undefined
      value += String.fromCharCode(code)
      index += 2
      continue
    }
    if (kind === 'u') {
      if (source[index + 1] === '{') return undefined
      const code = Number.parseInt(source.slice(index + 1, index + 5), 16)
      if (!Number.isFinite(code)) return undefined
      value += String.fromCharCode(code)
      index += 4
      continue
    }
    value += kind
  }
  return value
}

function familyHasContextFreeFiniteEnd(
  ir: LexicalIr,
  spellings: readonly string[],
): boolean {
  if (ir.kind === 'literal') return true
  if (ir.kind === 'regex') return fixedRegexLiteral(ir.source) !== undefined
  if (ir.kind !== 'keywords' || ir.boundary !== undefined) return false
  return spellings.every(spelling => !ir.words.some(word => {
    const actual = ir.caseInsensitive ? foldAscii(spelling) : spelling
    const candidate = ir.caseInsensitive ? foldAscii(word) : word
    return candidate.length > actual.length && candidate.startsWith(actual)
  }))
}

function compatibleLanguageViews(
  arm: LexicalIr,
  family: LexicalIr,
): ReadonlyArray<{ readonly ir: LexicalIr; readonly relation: 'equal' | 'prefix' }> | undefined {
  if (JSON.stringify(arm) === JSON.stringify(family)) return [{ ir: arm, relation: 'equal' }]
  const values = finiteLexicalValues(arm)
  if (values === undefined || values.length === 0) return undefined
  const familyValues = finiteLexicalValues(family)
  const foldedArm = arm.kind === 'literal' ? arm.caseInsensitive : arm.kind === 'keywords' && arm.caseInsensitive
  const foldedFamily = family.kind === 'literal'
    ? family.caseInsensitive : family.kind === 'keywords' && family.caseInsensitive
  const armBoundary = arm.kind === 'keywords' ? arm.boundary : undefined
  const views: Array<{ ir: LexicalIr; relation: 'equal' | 'prefix' }> = []
  for (const value of values) {
    let relation: 'equal' | 'prefix' | undefined
    const armCaseInsensitive = arm.kind === 'literal'
      ? arm.caseInsensitive : arm.kind === 'keywords' && arm.caseInsensitive
    const spellings = armCaseInsensitive && !/[^\x00-\x7f]/.test(value)
      && lexicalIrAsciiCaseStable(family)
      ? [value] : asciiCaseVariants(value, armCaseInsensitive)
    const endIsTotal = spellings !== undefined
      && (familyHasContextFreeFiniteEnd(family, spellings)
        || armBoundary !== undefined && boundaryCoversContinuation(family, armBoundary))
    if (endIsTotal && spellings !== undefined
      && spellings.every(spelling => lexicalIrAcceptsExact(family, spelling))) {
      relation = 'equal'
    }
    else if (familyValues !== undefined
      && (family.kind === 'literal' || family.kind === 'keywords' && family.boundary === undefined)
      && foldedArm === foldedFamily && familyValues.some(full => {
      const a = foldedArm ? foldAscii(value) : value
      const f = foldedFamily ? foldAscii(full) : full
      if (!f.startsWith(a) || f.length === a.length) return false
      if (arm.kind !== 'keywords' || arm.boundary === undefined) return true
      try { return !new RegExp(`[${arm.boundary}]`).test(full[a.length]!) } catch { return false }
    })) relation = 'prefix'
    if (relation === undefined) return undefined
    const ir: LexicalIr = arm.kind === 'keywords'
      ? { ...arm, words: [value] }
      : arm.kind === 'literal'
        ? { ...arm, value }
        : (() => { throw new Error('parseman: finite decision view lost its language') })()
    views.push({ ir, relation })
  }
  return views
}

type PendingDecisionView = {
  readonly familyKey: string
  readonly key: string
  readonly view: LexicalDecisionOutcomeView
}

type PendingAcceptance =
  | { readonly kind: 'outcomes'; readonly keys: readonly string[] }
  | { readonly kind: 'otherwise'; readonly excludingKeys: readonly string[] }
  | Exclude<LexicalDecisionAcceptance, { kind: 'outcomes' | 'otherwise' }>

type PendingDecisionSite = {
  readonly siteId: number
  readonly atom: 'choice' | 'dispatch'
  readonly path: string
  readonly contextKey: string
  readonly families: ReadonlyArray<{
    readonly familyKey: string
    readonly arms: ReadonlyArray<Omit<LexicalDecisionArm, 'acceptance'> & { readonly acceptance: PendingAcceptance }>
  }>
  readonly precisionNotes: readonly string[]
}

function predicateViews(def: Extract<ParserDef, { tag: 'dispatch' }>): Array<{
  readonly match: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>
  readonly armId: number
  readonly parser: Combinator<unknown>
  readonly usesRouted: boolean
}> {
  const out: Array<{
    match: Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>
    armId: number
    parser: Combinator<unknown>
    usesRouted: boolean
  }> = []
  let armId = 0
  for (const entry of def.cases) {
    for (const value of entry.keys) out.push({
      match: { kind: 'exact', values: [value], caseInsensitive: entry.caseInsensitive },
      armId, parser: entry.parser, usesRouted: branchUsesRouted(entry),
    })
    armId++
  }
  for (const entry of def.matchers ?? []) {
    out.push({
      match: entry.kind === 'matches'
        ? { kind: 'matches', value: entry.value, flags: entry.flags ?? '', caseInsensitive: entry.caseInsensitive }
        : { kind: entry.kind, value: entry.value, caseInsensitive: entry.caseInsensitive },
      armId, parser: entry.parser, usesRouted: branchUsesRouted(entry),
    })
    armId++
  }
  return out
}

function predicatePartitionStableFor(
  ir: LexicalIr,
  predicates: readonly Exclude<LexicalOutcomeMatch, { kind: 'otherwise' }>[],
): boolean {
  const folded = ir.kind === 'literal' ? ir.caseInsensitive : ir.kind === 'keywords' && ir.caseInsensitive
  const values = finiteLexicalValues(ir) ?? []
  if (!folded) return true
  if (values.some(value => /[^\x00-\x7f]/.test(value))) return false
  if (!values.some(value => /[A-Za-z]/.test(value))) return true
  return predicates.every(match => {
    if (match.kind === 'matches') return match.caseInsensitive || match.flags.includes('i')
    if (match.kind === 'exact') return match.caseInsensitive
      || match.values.every(value => !/[A-Za-z]/.test(value))
    return match.caseInsensitive || !/[A-Za-z]/.test(match.value)
  })
}

type CapabilityCandidate = {
  readonly parser: Combinator<unknown>
  readonly atom: 'terminal' | 'token' | 'choice' | 'dispatch'
  readonly path: string
  readonly context: CapabilityContext
  readonly contextKey: string
  readonly recognitionContextKey: string
}

type BindingEdgeCandidate = Omit<LexicalBindingEdge, 'id' | 'status'>

type CapabilityContext = LexicalCapabilityContext

/**
 * Enumerate atomic lexical ownership boundaries over the final graph. A token
 * owns its interior, so its private terminals are not separate obligations;
 * the same terminal reached independently outside that token remains one.
 */
function lexicalCapabilityCandidates(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): { candidates: CapabilityCandidate[]; bindingEdges: BindingEdgeCandidate[] } {
  const parserIds = new Map<Combinator<unknown>, number>()
  const parserId = (parser: Combinator<unknown>): number => {
    const prior = parserIds.get(parser)
    if (prior !== undefined) return prior
    const id = parserIds.size
    parserIds.set(parser, id)
    return id
  }
  const contextKeyOf = (context: CapabilityContext): string =>
    `t${context.trivia === undefined ? -1 : parserId(context.trivia)}`
    + `/s${context.scanSkip.map(parserId).join(',')}`
    + `/l${context.trackLines ? 1 : 0}`
    + `/c${context.captureTrivia ? 1 : 0}`
    + `/r${context.opaqueRootCapture ? 1 : 0}`
    + `/d${context.dynamicState ? 1 : 0}`
  const topPath = new Map<Combinator<unknown>, Map<string, string>>()
  const ownedPath = new Map<Combinator<unknown>, Map<string, string>>()
  const candidates = new Map<string, CapabilityCandidate>()
  const bindingEdges = new Map<string, BindingEdgeCandidate>()
  const visit = (parser: Combinator<unknown>, path: string, owned: boolean, context: CapabilityContext): void => {
    const contextKey = contextKeyOf(context)
    const seen = owned ? ownedPath : topPath
    let paths = seen.get(parser)
    if (paths === undefined) { paths = new Map(); seen.set(parser, paths) }
    const prior = paths.get(contextKey)
    if (prior !== undefined && prior <= path) return
    paths.set(contextKey, path)

    const def = parser._def
    const recognitionContext = def.tag === 'token'
      ? { ...context, trivia: undefined, captureTrivia: false }
      : context
    const recognitionContextKey = contextKeyOf(recognitionContext)
    if (!owned && keyOf(def) !== undefined) {
      const key = `terminal\u0000${parserId(parser)}\u0000${contextKey}`
      const priorCandidate = candidates.get(key)
      if (priorCandidate === undefined || path < priorCandidate.path) {
        candidates.set(key, {
          parser, atom: 'terminal', path, context, contextKey, recognitionContextKey,
        })
      }
    } else if (!owned && (def.tag === 'token' || def.tag === 'choice' || def.tag === 'dispatch')) {
      const atom = def.tag
      const key = `${atom}\u0000${parserId(parser)}\u0000${contextKey}`
      const priorCandidate = candidates.get(key)
      if (priorCandidate === undefined || path < priorCandidate.path) {
        candidates.set(key, { parser, atom, path, context, contextKey, recognitionContextKey })
      }
    }
    // Exact atomic ownership: the token's child is recognition machinery, not
    // a separately linked parser site or fixed parent-edge obligation.
    if (!owned && def.tag === 'token') return
    const childOwned = owned || def.tag === 'token'
    const children = tokenChildren(parser, resolve)
    let childContext = context
    if (def.tag === 'grammar') {
      childContext = {
        trivia: def.clearTrivia ? undefined : (def.triviaParser ?? context.trivia),
        scanSkip: context.scanSkip,
        trackLines: context.trackLines || def.trackLines,
        captureTrivia: context.captureTrivia || def.captureTrivia === true,
        opaqueRootCapture: context.opaqueRootCapture || def.rootCapture === 'opaque',
        dynamicState: context.dynamicState,
      }
    } else if (def.tag === 'withCtx') {
      childContext = { ...context, dynamicState: true }
    } else if (def.tag === 'token') {
      childContext = { ...context, trivia: undefined }
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      const childPath = `${path}/${String(i).padStart(4, '0')}`
      const edgeKey = `${parserId(parser)}\u0000${i}\u0000${contextKey}`
      if (!bindingEdges.has(edgeKey)) bindingEdges.set(edgeKey, {
        path: childPath,
        contextKey,
        parentTag: def.tag,
        childTag: child._def.tag,
      })
      visit(child, childPath, childOwned, childContext)
    }
  }
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!
    const rootPath = String(i).padStart(4, '0')
    const rootContext: CapabilityContext = {
      trivia: root._meta.grammarTrivia,
      scanSkip: root._meta.grammarScanSkip ?? [],
      trackLines: root._meta.grammarTrackLines === true,
      captureTrivia: false,
      opaqueRootCapture: false,
      dynamicState: false,
    }
    const contextKey = contextKeyOf(rootContext)
    bindingEdges.set(`root\u0000${i}\u0000${contextKey}`, {
      path: rootPath, contextKey, parentTag: 'root', childTag: root._def.tag,
    })
    visit(root, rootPath, false, rootContext)
  }
  return {
    candidates: [...candidates.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : a.atom < b.atom ? -1 : a.atom > b.atom ? 1 : 0),
    bindingEdges: [...bindingEdges.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  }
}

function decisionViewKey(view: LexicalDecisionOutcomeView): string {
  if (view.kind === 'whole') return 'whole'
  if (view.kind === 'predicate') return `predicate\u0000${canonicalLexicalOutcomeKey(view.match)}`
  return `language\u0000${view.relation}\u0000${JSON.stringify(view.ir)}`
}

function lexicalDecisionInventory(
  candidates: readonly CapabilityCandidate[],
  resolve?: (name: string) => Combinator<unknown> | undefined,
): {
  families: LexicalDecisionFamily[]
  outcomes: LexicalDecisionOutcome[]
  decisions: LexicalDecisionSite[]
  recognitionBySite: ReadonlyMap<number, LexicalCapabilityStatus>
} {
  const familyIrByKey = new Map<string, LexicalIr>()
  const viewsByKey = new Map<string, PendingDecisionView>()
  const pending: PendingDecisionSite[] = []
  const addFamily = (lead: DecisionLead): string => {
    if (!familyIrByKey.has(lead.key)) familyIrByKey.set(lead.key, lead.ir)
    return lead.key
  }
  const addView = (familyKey: string, view: LexicalDecisionOutcomeView): string => {
    const key = `${familyKey}\u0000${decisionViewKey(view)}`
    if (!viewsByKey.has(key)) viewsByKey.set(key, { familyKey, key, view })
    return key
  }

  // The interner is grammar-wide, not derived from whichever decisions happen
  // to consume a language. This keeps family identity independent of cost/site
  // selection and gives the legacy token inventory an explicit relocation.
  for (const candidate of candidates) {
    const def = candidate.parser._def
    if (candidate.atom !== 'terminal' && candidate.atom !== 'token') continue
    const normalized = normalizeBalancedLexical(candidate.parser, resolve, candidate.context.scanSkip)
      ?? normalizeLexical(def.tag === 'token' ? def.parser : candidate.parser, resolve, new Set())
    if (!('refusal' in normalized)) familyIrByKey.set(JSON.stringify(normalized.ir), normalized.ir)
  }

  for (let siteId = 0; siteId < candidates.length; siteId++) {
    const candidate = candidates[siteId]!
    if (candidate.atom !== 'choice' && candidate.atom !== 'dispatch') continue
    const def = candidate.parser._def
    const precisionNotes: string[] = []
    if (candidate.atom === 'dispatch') {
      if (def.tag !== 'dispatch') throw new Error('parseman: decision occurrence lost its dispatch')
      const result = decisionLead(def.selector, candidate.context, resolve)
      if ('gap' in result) {
        precisionNotes.push(`selector: ${result.gap}`)
        pending.push({
          siteId, atom: candidate.atom, path: candidate.path, contextKey: candidate.contextKey,
          families: [], precisionNotes,
        })
        continue
      }
      const familyKey = addFamily(result.lead)
      const predicates = predicateViews(def)
      const predicateKeys = predicates.map(({ match }) => addView(familyKey, {
        kind: 'predicate', relation: 'equal', match,
      }))
      const arms: Array<Omit<LexicalDecisionArm, 'acceptance'> & { acceptance: PendingAcceptance }> = []
      let offset = 0
      for (let armId = 0; armId < def.cases.length; armId++) {
        const entry = def.cases[armId]!
        const keys = predicateKeys.slice(offset, offset + entry.keys.length)
        offset += entry.keys.length
        arms.push({
          armId, acceptance: { kind: 'outcomes', keys },
          usesRouted: branchUsesRouted(entry), dynamicGate: false,
        })
      }
      for (let i = 0; i < (def.matchers?.length ?? 0); i++) {
        const entry = def.matchers![i]!
        arms.push({
          armId: arms.length, acceptance: { kind: 'outcomes', keys: [predicateKeys[offset++]!] },
          usesRouted: branchUsesRouted(entry), dynamicGate: false,
        })
      }
      if (def.otherwise !== undefined) arms.push({
        armId: arms.length,
        acceptance: { kind: 'otherwise', excludingKeys: predicateKeys },
        usesRouted: branchUsesRouted({ parser: def.otherwise, usesRouted: def.otherwiseUsesRouted }),
        dynamicGate: false,
      })
      pending.push({
        siteId, atom: candidate.atom, path: candidate.path, contextKey: candidate.contextKey,
        families: [{ familyKey, arms }], precisionNotes,
      })
      continue
    }

    if (def.tag !== 'choice') throw new Error('parseman: decision occurrence lost its choice')
    const leads = def.parsers.map((arm, armId) => {
      const result = decisionLead(arm, candidate.context, resolve)
      if ('gap' in result) precisionNotes.push(`arm ${armId}: ${result.gap}`)
      return result
    })
    const familyKeys = [...new Set(leads.flatMap(result => 'lead' in result
      ? [addFamily(result.lead)] : []))].sort()
    if (familyKeys.length === 0 && precisionNotes.length === 0) {
      precisionNotes.push('choice has no predecision range family; all arms remain unrestricted')
    }
    const families = familyKeys.map(familyKey => {
      const familyIr = familyIrByKey.get(familyKey)!
      const wholeKey = addView(familyKey, { kind: 'whole', relation: 'equal' })
      const familyDispatches = [...new Set(leads.flatMap(result =>
        'lead' in result && result.lead.key === familyKey && result.lead.dispatch !== undefined
          ? [result.lead.dispatch] : []))]
      const ambiguousPartition = familyDispatches.length > 1
      if (ambiguousPartition) precisionNotes.push(
        `family ${familyKey}: multiple dispatches need distinct site-local outcome partitions`)
      const familyPredicates = ambiguousPartition ? []
        : familyDispatches.flatMap(dispatch => predicateViews(dispatch).map(entry => entry.match))
      const predicateKeys = familyPredicates.map(match => addView(familyKey, {
        kind: 'predicate', relation: 'equal', match,
      }))
      const arms = def.parsers.map((arm, armId): Omit<LexicalDecisionArm, 'acceptance'> & {
        acceptance: PendingAcceptance
      } => {
        const dynamicGate = def.gates[armId] !== null || def.autoNot[armId] !== null
        const result = leads[armId]!
        if ('gap' in result) return {
          armId, acceptance: { kind: 'unrestricted' }, usesRouted: false, dynamicGate,
        }
        const lead = result.lead
        if (lead.key === familyKey) {
          if (ambiguousPartition) return {
            armId, acceptance: { kind: 'unrestricted' }, usesRouted: false, dynamicGate,
          }
          if (lead.dispatch !== undefined) {
            const predicates = predicateViews(lead.dispatch)
            const keys = predicates.map(({ match }) => addView(familyKey, {
              kind: 'predicate', relation: 'equal', match,
            }))
            return {
              armId,
              acceptance: lead.dispatch.otherwise === undefined
                ? { kind: 'outcomes', keys }
                : { kind: 'unrestricted' },
              usesRouted: false,
              dynamicGate,
            }
          }
          return {
            armId, acceptance: { kind: 'outcomes', keys: [wholeKey] },
            usesRouted: false, dynamicGate,
          }
        }
        const familyLead = leads.find((entry): entry is { lead: DecisionLead } =>
          'lead' in entry && entry.lead.key === familyKey)!.lead
        const armFirst = firstSetOf(arm, new Set(), resolve)
        const familyFirst = firstSetOf(familyLead.parser, new Set(), resolve)
        if (armFirst.kind === 'ranges' && familyFirst.kind === 'ranges'
          && !intersects(armFirst, familyFirst)) {
          return { armId, acceptance: { kind: 'impossible' }, usesRouted: false, dynamicGate }
        }
        const compatible = compatibleLanguageViews(lead.ir, familyIr)
        if (compatible !== undefined) {
          if (compatible.every(view => view.relation === 'equal')
            && familyPredicates.length > 0
            && predicatePartitionStableFor(lead.ir, familyPredicates)) {
            const values = finiteLexicalValues(lead.ir)!
            const accepted = new Set<string>()
            let hasOtherwise = false
            for (const value of values) {
              const matching = familyPredicates.flatMap((match, index) =>
                lexicalOutcomeMatches(match, value, 0, value.length) ? [predicateKeys[index]!] : [])
              if (matching.length === 0) hasOtherwise = true
              else for (const key of matching) accepted.add(key)
            }
            if (hasOtherwise && accepted.size === 0) return {
              armId,
              acceptance: { kind: 'otherwise', excludingKeys: predicateKeys },
              usesRouted: false,
              dynamicGate,
            }
            if (!hasOtherwise && accepted.size > 0) return {
              armId,
              acceptance: { kind: 'outcomes', keys: [...accepted] },
              usesRouted: false,
              dynamicGate,
            }
            // A finite arm split across direct predicates and the local
            // complement is conservatively retained; neither half is dropped.
            return { armId, acceptance: { kind: 'unrestricted' }, usesRouted: false, dynamicGate }
          }
          const keys = compatible.map(view => addView(familyKey, {
            kind: 'language', relation: view.relation, ir: view.ir,
          }))
          return {
            armId, acceptance: { kind: 'outcomes', keys },
            usesRouted: false, dynamicGate,
          }
        }
        return { armId, acceptance: { kind: 'unrestricted' }, usesRouted: false, dynamicGate }
      })
      return { familyKey, arms }
    })
    pending.push({
      siteId, atom: candidate.atom, path: candidate.path, contextKey: candidate.contextKey,
      families, precisionNotes: [...new Set(precisionNotes)].sort(),
    })
  }

  const familyKeys = [...familyIrByKey.keys()].sort()
  const familyIdByKey = new Map(familyKeys.map((key, index) => [key, FIRST_LEXICAL_FAMILY_ID + index]))
  const families = familyKeys.map((semanticKey, index): LexicalDecisionFamily => ({
    id: FIRST_LEXICAL_FAMILY_ID + index, semanticKey, ir: familyIrByKey.get(semanticKey)!,
  }))
  const viewKeys = [...viewsByKey.keys()].sort()
  const firstOutcomeId = FIRST_LEXICAL_FAMILY_ID + familyKeys.length
  const outcomeIdByKey = new Map(viewKeys.map((key, index) => [key, firstOutcomeId + index]))
  const outcomes = viewKeys.map((key, index): LexicalDecisionOutcome => {
    const pendingView = viewsByKey.get(key)!
    return {
      id: firstOutcomeId + index,
      familyId: familyIdByKey.get(pendingView.familyKey)!,
      semanticKey: decisionViewKey(pendingView.view),
      view: pendingView.view,
    }
  })
  const decisions = pending.map((site): LexicalDecisionSite => ({
    siteId: site.siteId, atom: site.atom, path: site.path, contextKey: site.contextKey,
    fallback: 'unrestricted', precisionNotes: site.precisionNotes,
    families: site.families.map(family => ({
      familyId: familyIdByKey.get(family.familyKey)!,
      arms: family.arms.map(arm => ({
        ...arm,
        acceptance: arm.acceptance.kind === 'outcomes'
          ? { kind: 'outcomes', outcomeIds: [...new Set(arm.acceptance.keys.map(key => outcomeIdByKey.get(key)!))].sort((a, b) => a - b) }
          : arm.acceptance.kind === 'otherwise'
            ? { kind: 'otherwise', excludingOutcomeIds: [...new Set(arm.acceptance.excludingKeys.map(key => outcomeIdByKey.get(key)!))].sort((a, b) => a - b) }
            : arm.acceptance,
      })),
    })),
  }))
  const recognitionBySite = new Map<number, LexicalCapabilityStatus>(decisions.map(site => [
    site.siteId, COMPLETE_CAPABILITY,
  ]))
  return { families, outcomes, decisions, recognitionBySite }
}

function lexicalCapabilityInventory(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): {
  capabilities: LexicalCapabilitySite[]
  languages: LexicalCapabilityLanguage[]
  bindingEdges: LexicalBindingEdge[]
  decisionFamilies: LexicalDecisionFamily[]
  decisionOutcomes: LexicalDecisionOutcome[]
  decisions: LexicalDecisionSite[]
  transitionDiagnostics: LexicalTransitionDiagnosticPlan[]
  controlPlans: LexicalControlPlan[]
  boundaryPlans: LexicalBoundaryPlan[]
  materializationPlans: LexicalMaterializationPlan[]
  grammarWrapperSpecs: LexicalGrammarWrapperSpec[]
  grammarCaptureTriviaKinds: string[][]
  boundaryTopologies: LexicalBoundaryTopology[]
} {
  const inventory = lexicalCapabilityCandidates(roots, resolve)
  const decisionInventory = lexicalDecisionInventory(inventory.candidates, resolve)
  const transitionDiagnostics: LexicalTransitionDiagnosticPlan[] = []
  const transitionDiagnosticIdByKey = new Map<string, number>()
  const internTransitionDiagnostics = (
    recognizerKey: string,
    session: LexicalNormalizeSession,
  ): number => {
    const body = {
      stateCount: session.nextState, expected: session.expected, events: session.events,
    }
    // State ids are local to the canonical recognizer transition graph. Equal
    // event rows over a different graph are not one plan merely by coincidence.
    const key = `${recognizerKey}\u0000${JSON.stringify(body)}`
    const prior = transitionDiagnosticIdByKey.get(key)
    if (prior !== undefined) return prior
    const id = transitionDiagnostics.length
    transitionDiagnosticIdByKey.set(key, id)
    transitionDiagnostics.push({ id, ...body })
    return id
  }
  const controlPlans: LexicalControlPlan[] = []
  const controlPlanIdByKey = new Map<string, number>()
  const internControlPlan = (session: LexicalNormalizeSession): number => {
    const key = JSON.stringify(session.controls)
    const prior = controlPlanIdByKey.get(key)
    if (prior !== undefined) return prior
    const id = controlPlans.length
    controlPlanIdByKey.set(key, id)
    controlPlans.push({ id, controls: session.controls })
    return id
  }
  const grammarWrapperSpecs: LexicalGrammarWrapperSpec[] = []
  const grammarSpecIdByKey = new Map<string, number>()
  const grammarSourceOperationIds = new Map<Combinator<unknown>, number>()
  const triviaBindingIds = new Map<Combinator<unknown>, number>()
  const grammarCaptureTriviaKinds: string[][] = []
  const captureKindsIdByKey = new Map<string, number>()
  const boundaryTopologies: LexicalBoundaryTopology[] = []
  const topologyIdByKey = new Map<string, number>()
  const identityId = (map: Map<Combinator<unknown>, number>, parser: Combinator<unknown>): number => {
    const prior = map.get(parser)
    if (prior !== undefined) return prior
    const id = map.size
    map.set(parser, id)
    return id
  }
  const captureKindsId = (values: readonly string[] | undefined): number | undefined => {
    if (values === undefined) return undefined
    const key = JSON.stringify(values)
    const prior = captureKindsIdByKey.get(key)
    if (prior !== undefined) return prior
    const id = grammarCaptureTriviaKinds.length
    captureKindsIdByKey.set(key, id)
    grammarCaptureTriviaKinds.push([...values])
    return id
  }
  const internGrammarWrapper = (
    parser: Combinator<unknown>,
    captureTriviaKinds: readonly string[] | undefined,
  ): number | undefined => {
    const def = parser._def
    if (def.tag !== 'grammar') return undefined
    if (def.constructionTrackLines === undefined) return undefined
    const sourceOperationId = identityId(grammarSourceOperationIds, parser)
    const triviaBindingId = def.triviaParser === undefined
      ? undefined : identityId(triviaBindingIds, def.triviaParser)
    const captureTriviaKindsId = captureKindsId(captureTriviaKinds)
    const body = {
      sourceOperationId,
      clearTrivia: def.clearTrivia === true,
      ...(triviaBindingId === undefined ? {} : { triviaBindingId }),
      trackLines: def.constructionTrackLines,
      captureTrivia: def.captureTrivia === true,
      ...(captureTriviaKindsId === undefined ? {} : { captureTriviaKindsId }),
      rootCapture: def.rootCapture === 'opaque' ? 'opaque' as const : 'inherit' as const,
      clonePolicy: 'spread-existing-or-create-canonical' as const,
      postChildPolicy: 'line-propagate-then-annotate-or-return' as const,
    }
    const key = JSON.stringify(body)
    const prior = grammarSpecIdByKey.get(key)
    if (prior !== undefined) return prior
    const id = grammarWrapperSpecs.length
    grammarSpecIdByKey.set(key, id)
    grammarWrapperSpecs.push({ id, ...body })
    return id
  }
  const internBoundaryTopology = (
    session: LexicalNormalizeSession,
  ): { readonly id: number } | { readonly gap: string } => {
    // Validate the entire overlay before interning any source-operation spec.
    // A declined late frame must not leave unreachable compiler metadata behind.
    const grammarCaptureKindsByFrame = new Map<number, readonly string[] | undefined>()
    for (let frameIndex = 0; frameIndex < session.wrapperFrames.length; frameIndex++) {
      const pending = session.wrapperFrames[frameIndex]!
      const control = session.controls[pending.controlId]
      if (pending.stateStart < 0 || pending.stateEnd < pending.stateStart
        || pending.stateEnd > session.nextState
        || pending.id !== frameIndex || control === undefined
        || control.id !== pending.controlId
        || control.kind !== pending.kind
        || control.stateStart !== pending.stateStart
        || control.stateEnd !== pending.stateEnd) {
        return { gap: 'token boundary overlay has an invalid state interval' }
      }
      if (pending.parentFrameId !== undefined) {
        const parent = session.wrapperFrames[pending.parentFrameId]
        if (parent === undefined || pending.parentFrameId >= pending.id
          || pending.stateStart < parent.stateStart || pending.stateEnd > parent.stateEnd) {
          return { gap: 'token boundary overlay is not well nested' }
        }
      }
      if (pending.kind === 'grammar') {
        const def = pending.parser._def
        if (def.tag !== 'grammar' || def.constructionTrackLines === undefined) {
          return { gap: 'grammar wrapper lacks exact construction-time source-operation metadata' }
        }
        try {
          grammarCaptureKindsByFrame.set(
            pending.id,
            def.constructionCaptureTriviaKinds === undefined
              ? undefined : [...def.constructionCaptureTriviaKinds],
          )
        } catch {
          return { gap: 'grammar wrapper capture-trivia policy cannot be snapshotted safely' }
        }
      }
    }
    for (let i = 0; i < session.wrapperFrames.length; i++) {
      for (let j = i + 1; j < session.wrapperFrames.length; j++) {
        const a = session.wrapperFrames[i]!
        const b = session.wrapperFrames[j]!
        const overlap = a.stateStart < b.stateEnd && b.stateStart < a.stateEnd
        const nested = (a.stateStart <= b.stateStart && b.stateEnd <= a.stateEnd)
          || (b.stateStart <= a.stateStart && a.stateEnd <= b.stateEnd)
        if (overlap && !nested) return { gap: 'token boundary overlay has crossed state intervals' }
      }
    }
    const outer = session.wrapperFrames[0]
    if (outer?.kind !== 'token' || outer.parentFrameId !== undefined
      || outer.stateStart !== 0 || outer.stateEnd !== session.nextState) {
      return { gap: 'token boundary overlay lost its outer authored token frame' }
    }

    const frames: LexicalWrapperFrame[] = []
    for (const pending of session.wrapperFrames) {
      if (pending.kind === 'token') frames.push({
        id: pending.id,
        ...(pending.parentFrameId === undefined ? {} : { parentFrameId: pending.parentFrameId }),
        controlId: pending.controlId,
        stateStart: pending.stateStart,
        stateEnd: pending.stateEnd,
        kind: 'token', boundaryPlanId: 0, materializationPlanId: 0,
      })
      else {
        const wrapperSpecId = internGrammarWrapper(
          pending.parser, grammarCaptureKindsByFrame.get(pending.id),
        )
        if (wrapperSpecId === undefined) throw new Error('parseman: validated grammar policy disappeared')
        frames.push({
          id: pending.id,
          ...(pending.parentFrameId === undefined ? {} : { parentFrameId: pending.parentFrameId }),
          controlId: pending.controlId,
          stateStart: pending.stateStart,
          stateEnd: pending.stateEnd,
          kind: 'grammar', wrapperSpecId,
        })
      }
    }
    const key = JSON.stringify(frames)
    const prior = topologyIdByKey.get(key)
    if (prior !== undefined) return { id: prior }
    const id = boundaryTopologies.length
    topologyIdByKey.set(key, id)
    boundaryTopologies.push({ id, frames })
    return { id }
  }
  const pending = inventory.candidates.map((candidate, id) => {
    if (candidate.atom === 'terminal') {
      const key = keyOf(candidate.parser._def)
      if (key === undefined) throw new Error('parseman: lexical terminal capability lost its semantic key')
      const obligations = terminalObligations()
      return {
        id, path: candidate.path, contextKey: candidate.contextKey,
        recognitionContextKey: candidate.recognitionContextKey,
        context: candidate.context,
        recognitionContext: candidate.parser._def.tag === 'token'
          ? { ...candidate.context, trivia: undefined, captureTrivia: false }
          : candidate.context,
        semanticKey: key, atom: candidate.atom,
        parser: candidate.parser, obligations, status: derivedCapabilityStatus(obligations),
      }
    }
    const def = candidate.parser._def
    if (candidate.atom === 'choice') {
      if (def.tag !== 'choice') throw new Error('parseman: lexical choice capability lost its boundary')
      const obligations = decisionObligations(decisionInventory.recognitionBySite.get(id)
        ?? gap('choice outcome recognition record is missing'))
      return {
        id, path: candidate.path,
        contextKey: candidate.contextKey,
        recognitionContextKey: candidate.recognitionContextKey,
        context: candidate.context,
        recognitionContext: candidate.context,
        semanticKey: `C\u0000${def.parsers.length}\u0000${def.strategy.tag}`,
        atom: candidate.atom, parser: candidate.parser, obligations,
        status: derivedCapabilityStatus(obligations),
      }
    }
    if (candidate.atom === 'dispatch') {
      if (def.tag !== 'dispatch') throw new Error('parseman: lexical dispatch capability lost its boundary')
      const obligations = decisionObligations(decisionInventory.recognitionBySite.get(id)
        ?? gap('dispatch outcome recognition record is missing'))
      return {
        id, path: candidate.path,
        contextKey: candidate.contextKey,
        recognitionContextKey: candidate.recognitionContextKey,
        context: candidate.context,
        recognitionContext: candidate.context,
        semanticKey: `D\u0000${def.cases.length}\u0000${def.matchers?.length ?? 0}\u0000${def.otherwise === undefined ? 0 : 1}`,
        atom: candidate.atom, parser: candidate.parser, obligations,
        status: derivedCapabilityStatus(obligations),
      }
    }
    if (def.tag !== 'token') throw new Error('parseman: lexical token capability lost its boundary')
    const session = newNormalizeSession()
    const normalized = normalizeBalancedLexical(
      candidate.parser, resolve, candidate.context.scanSkip, session,
    ) ?? normalizeLexical(candidate.parser, resolve, new Set(), session)
    if ('refusal' in normalized) {
      const obligations = tokenObligations(gap(`token normalization: ${normalized.refusal}`))
      return {
        id, path: candidate.path, contextKey: candidate.contextKey,
        recognitionContextKey: candidate.recognitionContextKey,
        context: candidate.context,
        recognitionContext: { ...candidate.context, trivia: undefined, captureTrivia: false },
        semanticKey: `T\u0000GAP\u0000${normalized.refusal}`,
        atom: candidate.atom, parser: candidate.parser, obligations,
        status: derivedCapabilityStatus(obligations),
      }
    }
    const semanticKey = `T\u0000${JSON.stringify(normalized.ir)}`
    if (matchesEmpty(def.parser)) {
      const obligations = tokenObligations({
        kind: 'impossible',
        proof: 'an atomic source token must consume positive width but this token body is nullable',
      })
      return {
        id, path: candidate.path, contextKey: candidate.contextKey,
        recognitionContextKey: candidate.recognitionContextKey,
        context: candidate.context,
        recognitionContext: { ...candidate.context, trivia: undefined, captureTrivia: false },
        semanticKey, atom: candidate.atom, parser: candidate.parser,
        obligations, status: derivedCapabilityStatus(obligations),
      }
    }
    const diagnosticPlanId = internTransitionDiagnostics(semanticKey, session)
    const controlPlanId = internControlPlan(session)
    const topology = internBoundaryTopology(session)
    const topologyRepresentation = 'id' in topology
      ? COMPLETE_CAPABILITY : gap(topology.gap)
    const obligations = tokenObligations(COMPLETE_CAPABILITY, {
      diagnostics: true,
      boundaryPlan: topologyRepresentation,
      materializationPlan: topologyRepresentation,
    })
    return {
      id, path: candidate.path, contextKey: candidate.contextKey,
      recognitionContextKey: candidate.recognitionContextKey,
      context: candidate.context,
      recognitionContext: { ...candidate.context, trivia: undefined, captureTrivia: false },
      semanticKey, atom: candidate.atom, parser: candidate.parser, diagnosticPlanId,
      controlPlanId,
      ...('id' in topology ? { boundaryTopologyId: topology.id } : {}),
      obligations, status: derivedCapabilityStatus(obligations),
    }
  })
  const languageKeys = [...new Set(pending.map(site => `${site.atom}\u0000${site.semanticKey}`))].sort()
  const languageIdByKey = new Map(languageKeys.map((key, id) => [key, id]))
  const languages = languageKeys.map((key, id): LexicalCapabilityLanguage => {
    const split = key.indexOf('\u0000')
    return {
      id,
      atom: key.slice(0, split) as LexicalCapabilitySite['atom'],
      semanticKey: key.slice(split + 1),
    }
  })
  const capabilities = pending.map(site => ({
    ...site,
    languageId: languageIdByKey.get(`${site.atom}\u0000${site.semanticKey}`)!,
  }))
  const bindingEdges = inventory.bindingEdges.map((edge, id): LexicalBindingEdge => ({
    id, ...edge, status: gap(FIXED_TUPLE_BINDING_GAP),
  }))
  return {
    capabilities, languages, bindingEdges,
    decisionFamilies: decisionInventory.families,
    decisionOutcomes: decisionInventory.outcomes,
    decisions: decisionInventory.decisions,
    transitionDiagnostics,
    controlPlans,
    boundaryPlans: boundaryTopologies.length === 0
      ? [] : [{ id: 0, kind: 'token-context-transaction' }],
    materializationPlans: boundaryTopologies.length === 0
      ? [] : [{ id: 0, kind: 'token-source-range' }],
    grammarWrapperSpecs,
    grammarCaptureTriviaKinds,
    boundaryTopologies,
  }
}

/** Re-enumerate the final graph so a dropped/filtered candidate fails closed. */
export function assertLexicalCapabilityClosure(
  roots: ReadonlyArray<Combinator<unknown>>,
  alphabet: Pick<LexicalCapabilityInventory,
  'capabilities' | 'capabilityLanguages' | 'bindingEdges' | 'decisionFamilies'
  | 'decisionOutcomes' | 'decisions'> & Partial<Pick<LexicalCapabilityInventory,
  'transitionDiagnostics' | 'boundaryPlans' | 'materializationPlans'
  | 'grammarWrapperSpecs' | 'grammarCaptureTriviaKinds' | 'boundaryTopologies'
  | 'controlPlans'>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): void {
  const actual = lexicalCapabilityInventory(roots, resolve)
  const signature = (site: LexicalCapabilitySite): string =>
    `${site.id}\u0000${site.languageId}\u0000${site.path}\u0000${site.contextKey}\u0000${site.recognitionContextKey}\u0000${site.atom}\u0000${site.semanticKey}\u0000${site.diagnosticPlanId ?? -1}\u0000${site.controlPlanId ?? -1}\u0000${site.boundaryTopologyId ?? -1}\u0000${JSON.stringify(site.obligations)}`
  const expectedKeys = actual.capabilities.map(signature)
  const suppliedKeys = alphabet.capabilities.map(signature)
  const expectedLanguages = actual.languages.map(language =>
    `${language.id}\u0000${language.atom}\u0000${language.semanticKey}`)
  const suppliedLanguages = alphabet.capabilityLanguages.map(language =>
    `${language.id}\u0000${language.atom}\u0000${language.semanticKey}`)
  const edgeSignature = (edge: LexicalBindingEdge): string =>
    `${edge.id}\u0000${edge.path}\u0000${edge.contextKey}\u0000${edge.parentTag}\u0000${edge.childTag}\u0000${JSON.stringify(edge.status)}`
  const expectedEdges = actual.bindingEdges.map(edgeSignature)
  const suppliedEdges = alphabet.bindingEdges.map(edgeSignature)
  const familySignature = (family: LexicalDecisionFamily): string =>
    `${family.id}\u0000${family.semanticKey}\u0000${JSON.stringify(family.ir)}`
  const expectedFamilies = actual.decisionFamilies.map(familySignature)
  const suppliedFamilies = alphabet.decisionFamilies.map(familySignature)
  const outcomeSignature = (outcome: LexicalDecisionOutcome): string =>
    `${outcome.id}\u0000${outcome.familyId}\u0000${outcome.semanticKey}\u0000${JSON.stringify(outcome.view)}`
  const expectedOutcomes = actual.decisionOutcomes.map(outcomeSignature)
  const suppliedOutcomes = alphabet.decisionOutcomes.map(outcomeSignature)
  const decisionSignature = (decision: LexicalDecisionSite): string => JSON.stringify(decision)
  const expectedDecisions = actual.decisions.map(decisionSignature)
  const suppliedDecisions = alphabet.decisions.map(decisionSignature)
  const planSignature = (plan: LexicalTransitionDiagnosticPlan): string => JSON.stringify(plan)
  const expectedPlans = actual.transitionDiagnostics.map(planSignature)
  const suppliedPlans = (alphabet.transitionDiagnostics ?? []).map(planSignature)
  const expectedControlPlans = actual.controlPlans.map(plan => JSON.stringify(plan))
  const suppliedControlPlans = (alphabet.controlPlans ?? []).map(plan => JSON.stringify(plan))
  const expectedBoundaryPlans = actual.boundaryPlans.map(plan => JSON.stringify(plan))
  const suppliedBoundaryPlans = (alphabet.boundaryPlans ?? []).map(plan => JSON.stringify(plan))
  const expectedMaterializationPlans = actual.materializationPlans.map(plan => JSON.stringify(plan))
  const suppliedMaterializationPlans = (alphabet.materializationPlans ?? []).map(plan => JSON.stringify(plan))
  const expectedGrammarSpecs = actual.grammarWrapperSpecs.map(plan => JSON.stringify(plan))
  const suppliedGrammarSpecs = (alphabet.grammarWrapperSpecs ?? []).map(plan => JSON.stringify(plan))
  const expectedCaptureKinds = actual.grammarCaptureTriviaKinds.map(plan => JSON.stringify(plan))
  const suppliedCaptureKinds = (alphabet.grammarCaptureTriviaKinds ?? []).map(plan => JSON.stringify(plan))
  const expectedTopologies = actual.boundaryTopologies.map(plan => JSON.stringify(plan))
  const suppliedTopologies = (alphabet.boundaryTopologies ?? []).map(plan => JSON.stringify(plan))
  if (expectedKeys.length !== suppliedKeys.length
    || expectedKeys.some((key, index) => key !== suppliedKeys[index])
    || expectedLanguages.length !== suppliedLanguages.length
    || expectedLanguages.some((key, index) => key !== suppliedLanguages[index])
    || expectedEdges.length !== suppliedEdges.length
    || expectedEdges.some((key, index) => key !== suppliedEdges[index])
    || expectedFamilies.length !== suppliedFamilies.length
    || expectedFamilies.some((key, index) => key !== suppliedFamilies[index])
    || expectedOutcomes.length !== suppliedOutcomes.length
    || expectedOutcomes.some((key, index) => key !== suppliedOutcomes[index])
    || expectedDecisions.length !== suppliedDecisions.length
    || expectedDecisions.some((key, index) => key !== suppliedDecisions[index])
    || expectedPlans.length !== suppliedPlans.length
    || expectedPlans.some((key, index) => key !== suppliedPlans[index])
    || expectedControlPlans.length !== suppliedControlPlans.length
    || expectedControlPlans.some((key, index) => key !== suppliedControlPlans[index])
    || expectedBoundaryPlans.length !== suppliedBoundaryPlans.length
    || expectedBoundaryPlans.some((key, index) => key !== suppliedBoundaryPlans[index])
    || expectedMaterializationPlans.length !== suppliedMaterializationPlans.length
    || expectedMaterializationPlans.some((key, index) => key !== suppliedMaterializationPlans[index])
    || expectedGrammarSpecs.length !== suppliedGrammarSpecs.length
    || expectedGrammarSpecs.some((key, index) => key !== suppliedGrammarSpecs[index])
    || expectedCaptureKinds.length !== suppliedCaptureKinds.length
    || expectedCaptureKinds.some((key, index) => key !== suppliedCaptureKinds[index])
    || expectedTopologies.length !== suppliedTopologies.length
    || expectedTopologies.some((key, index) => key !== suppliedTopologies[index])) {
    throw new Error('parseman: lexical capability census is incomplete after final grammar resolution')
  }
}

/** Phase-A only: inventory obligations without constructing unused runtime families/sites. */
export function collectLexicalCapabilities(
  roots: ReadonlyArray<Combinator<unknown>>,
  resolve?: (name: string) => Combinator<unknown> | undefined,
): LexicalCapabilityInventory {
  const inventory = lexicalCapabilityInventory(roots, resolve)
  return {
    capabilities: inventory.capabilities,
    capabilityLanguages: inventory.languages,
    bindingEdges: inventory.bindingEdges,
    decisionFamilies: inventory.decisionFamilies,
    decisionOutcomes: inventory.decisionOutcomes,
    decisions: inventory.decisions,
    transitionDiagnostics: inventory.transitionDiagnostics,
    controlPlans: inventory.controlPlans,
    boundaryPlans: inventory.boundaryPlans,
    materializationPlans: inventory.materializationPlans,
    grammarWrapperSpecs: inventory.grammarWrapperSpecs,
    grammarCaptureTriviaKinds: inventory.grammarCaptureTriviaKinds,
    boundaryTopologies: inventory.boundaryTopologies,
    capabilityComplete: inventory.capabilities.every(site => site.status.kind !== 'gap')
      && inventory.bindingEdges.every(edge => edge.status.kind !== 'gap'),
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
    const target = resolvedLazyTarget(parser, resolve)
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
  const capabilityInventory = collectLexicalCapabilities(roots, resolve)
  const { capabilities, bindingEdges } = capabilityInventory
  const capabilityFamilyIdByKey = new Map(capabilityInventory.decisionFamilies.map(family =>
    [family.semanticKey, family.id]))
  const capabilityTokenFamilies = new Map<Combinator<unknown>, Map<number, LexicalDecisionFamily>>()
  for (const site of capabilities) {
    if (site.atom !== 'token' || site.obligations.recognition.representation.kind !== 'complete') continue
    const semanticKey = site.semanticKey.slice(2)
    const familyId = capabilityFamilyIdByKey.get(semanticKey)
    const family = familyId === undefined ? undefined
      : capabilityInventory.decisionFamilies.find(entry => entry.id === familyId)
    if (family === undefined) {
      throw new Error('parseman: completed token occurrence has no canonical capability family')
    }
    let byId = capabilityTokenFamilies.get(site.parser)
    if (byId === undefined) capabilityTokenFamilies.set(site.parser, byId = new Map())
    byId.set(family.id, family)
  }
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
    const candidateFamilies = capabilityTokenFamilies.get(parser)
    if (candidateFamilies === undefined) {
      const refused = normalizeBalancedLexical(parser, resolve)
        ?? normalizeLexical(def.parser, resolve, new Set())
      if ('refusal' in refused) {
        sites.push({ parser, body: def.parser, refusal: refused.refusal })
        continue
      }
      if (matchesEmpty(def.parser)) {
        sites.push({ parser, body: def.parser, refusal: 'token body may match empty' })
        continue
      }
      throw new Error('parseman: successful legacy recognizer has no canonical capability family')
    }
    if (candidateFamilies.size !== 1) {
      sites.push({
        parser, body: def.parser,
        refusal: 'token parser is reused in incompatible lexical contexts',
      })
      continue
    }
    if (matchesEmpty(def.parser)) {
      sites.push({ parser, body: def.parser, refusal: 'token body may match empty' })
      continue
    }
    const diagnosticId = diagnostics.length
    diagnostics.push({ id: diagnosticId, body: def.parser })
    const canonicalFamily = [...candidateFamilies.values()][0]!
    const ir = canonicalFamily.ir
    const key = JSON.stringify(ir)
    let recognizerId = recognizerByKey.get(key)
    if (recognizerId === undefined) {
      recognizerId = recognizers.length
      recognizerByKey.set(key, recognizerId)
      recognizers.push({
        id: recognizerId, key, ir, capabilityFamilyId: canonicalFamily.id,
      })
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
    capabilities,
    capabilityLanguages: capabilityInventory.capabilityLanguages,
    bindingEdges,
    decisionFamilies: capabilityInventory.decisionFamilies,
    decisionOutcomes: capabilityInventory.decisionOutcomes,
    decisions: capabilityInventory.decisions,
    transitionDiagnostics: capabilityInventory.transitionDiagnostics,
    controlPlans: capabilityInventory.controlPlans,
    boundaryPlans: capabilityInventory.boundaryPlans,
    materializationPlans: capabilityInventory.materializationPlans,
    grammarWrapperSpecs: capabilityInventory.grammarWrapperSpecs,
    grammarCaptureTriviaKinds: capabilityInventory.grammarCaptureTriviaKinds,
    boundaryTopologies: capabilityInventory.boundaryTopologies,
    capabilityComplete: capabilityInventory.capabilityComplete,
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
    case 'balanced':
      begin(7)
      out.push(constant(ir.open), constant(ir.close), ir.strict ? 1 : 0, ir.raw ? 1 : 0, ir.skip.length)
      for (const entry of ir.skip) serializeLexicalIr(entry, out, constant)
      break
  }
  out[start + 1] = out.length - start
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
): NumericLexicalPlan | undefined {
  // Phase B is globally disabled until phase A has a total replacement body
  // for every reachable token-capable atom in every supported variant. A
  // partially supported graph is never serialized as a cheaper token plan.
  if (!alphabet.capabilityComplete) return undefined
  if (tokenSites.length === 0) return undefined
  const recognizerOffsets: number[] = []
  const recognizerData: number[] = []
  for (const recognizer of alphabet.recognizers) {
    if (recognizer.id !== recognizerOffsets.length) throw new Error('parseman: lexical recognizer ids are not dense')
    recognizerOffsets.push(recognizerData.length)
    serializeLexicalIr(recognizer.ir, recognizerData, constant)
  }

  const outcomeOffsets: number[] = []
  const outcomeData: number[] = []
  for (const outcome of alphabet.outcomes) {
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
  for (const { dsp, classifier } of [...dispatchSites].sort((a, b) => a.dsp - b.dsp)) {
    const routeOffset = routes.length
    for (const route of classifier.routes) {
      const acceptedOffset = accepted.length
      accepted.push(...route.acceptedIds)
      const kind = route.kind === 'exact' ? 0 : route.kind === 'matcher' ? 1 : 2
      routes.push(route.index, kind | (route.usesRouted ? 4 : 0), acceptedOffset, route.acceptedIds.length)
    }
    sites.push(dsp, classifier.familyId, routeOffset, classifier.routes.length)
  }
  for (let i = 0; i < tokenSites.length; i += 2) {
    if (tokenSites[i + 1]! < FIRST_LEXICAL_FAMILY_ID) {
      throw new Error('parseman: lexical token site used a primitive-terminal id')
    }
  }
  return {
    recognizerOffsets, recognizerData, outcomeOffsets, outcomeData,
    tokenSites: [...tokenSites], sites, routes, accepted,
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
