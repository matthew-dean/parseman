/**
 * The linker: compose independently-carried grammar pieces into ONE runnable rule map.
 *
 * Composition is a RULE-MAP MERGE plus a single encode. Each piece carries its
 * combinator graph as IR; `compose()` evaluates every piece's IR back to a rule map,
 * lets a later piece's name override an earlier one, and encodes the merged map ONCE.
 * `enc.winners` binds every by-name reference against that merged map, so overriding a
 * rule reroutes EVERY call to it — including calls inside a base piece's own rules
 * (open recursion) — with no shared scope and no relocation.
 *   - **override** — later piece wins per rule name.
 *   - **à la carte** — `pick(grammar, names)` keeps only those rules + their transitive
 *     dependency closure.
 *
 * This replaced a textual splice. The source lowering compiled each piece to namespaced
 * `_r_<Name>` function sources and concatenated them into one `new Function` scope,
 * patching `@FS:` first-set placeholders per winner. That is why the linker needed
 * `'unsafe-eval'`; the merge is now data, so it does not.
 */
import { ruleDependencies } from '../analysis/gating.ts'
import { FUSED_HOST_MODE, FUSED_HOST_ELIDED, type HostMode } from '../cst/host-mode.ts'
import { evalRuleMapIR, serializeRuleMap } from './ir-serialize.ts'
import { compileLinkableTable, type LinkableTable } from './compile-linkable-table.ts'
import { compileRuleMapTable } from '../table/compile-rule-map.ts'
import { tableRules } from '../table/exec.ts'
import { PARSEMAN_VERSION } from '../version.ts'
import type { BuildHost, Combinator, CstCollapsePredicate, ParseContext, ParseResult } from '../types.ts'

/**
 * Compile a `rules()` map to a **linkable artifact** — the composable, shippable
 * form (RULE_ABI_PLAN §4). A package exports `linkable(rules(g => …))`; consumers
 * import that artifact and `fuse([...])` it — **no source of the base grammar is
 * ever read**. Under the macro this is precompiled to static pieces; in the
 * interpreter it compiles here at load (like `compile()`).
 *
 * `ns` is a per-artifact namespace; omit it to auto-assign a process-unique one
 * (fine at runtime — the macro supplies a stable module-derived ns instead).
 */
let _nsCounter = 0
export function linkable(
  rulesMap: Record<string, Combinator<unknown>>,
  ns?: string,
  trivia?: Combinator<unknown>,
  // Compile-time host mode, same meaning as `compile(g, { hostMode })`: 'ast' (default)
  // emits the grammar's own builders and NO positioned-CST branch; 'cst' builds every
  // node through the host. A linked/fused artifact is version- and mode-locked, so a
  // language service links its own 'cst' artifact rather than switching at parse time.
  hostMode?: HostMode,
): LinkableTable {
  const piece = compileLinkableTable(
    Object.entries(rulesMap),
    ns ?? `_lk${_nsCounter++}_`,
    { ...(trivia ? { trivia } : {}), ...(hostMode ? { hostMode } : {}) },
  )
  if (!piece) throw new Error('linkable(): this grammar cannot be compiled to a linkable artifact (contains a runtime-only parser fallback)')
  return piece
}

export type CstBuildHostOptions = {
  /**
   * Collapse transparent one-child CST wrapper nodes at build time.
   * - `true`: collapse any one-child node whose rawChildren also has exactly one
   *   entry, so trivia/error boundaries are not silently dropped.
   * - `string[]`: collapse only these grammar node types.
   * - predicate: final policy hook for language-specific public CSTs.
   */
  collapse?: boolean | readonly string[] | CstCollapsePredicate
  /**
   * Materialize `node(..., { tags })` grammar metadata onto produced CST nodes.
   * When omitted, tags stay in grammar reflection for zero per-node tree cost.
   */
  tags?: boolean
}

function normalizeCstCollapse(collapse: CstBuildHostOptions['collapse']): CstCollapsePredicate | undefined {
  if (collapse === true) return () => true
  if (Array.isArray(collapse)) {
    const types = new Set(collapse)
    return type => types.has(type)
  }
  return typeof collapse === 'function' ? collapse : undefined
}

function buildCstNode(
  type: string,
  children: ReadonlyArray<unknown>,
  _fields: unknown,
  span: { start: number; end: number },
  _rawChildren?: ReadonlyArray<unknown>,
  _triviaLog?: readonly number[],
  state?: unknown,
  tags?: readonly string[] | undefined,
): unknown {
  // Carry the grammar's `ctx.state` snapshot onto the node (null when unset) — the
  // CST contract includes `state` and incremental re-parse replays it on edit.
  return tags !== undefined && tags.length > 0
    ? { _tag: 'node', type, tags, span: { ...span }, state: state ?? null, children: [...children] }
    : { _tag: 'node', type, span: { ...span }, state: state ?? null, children: [...children] }
}

/**
 * A generic positioned-CST build host (RULE_ABI_PLAN §7). Pass as `ctx.build`
 * (or `parseDoc(..., { build: cstBuildHost })`) to make ANY linkable/fused
 * grammar produce a uniform CST — `{ _tag:'node', type, span, state, children }`
 * — instead of its own eval-AST builders. This is the host the linter and IDE
 * drivers use; the eval driver leaves `ctx.build` unset (grammar's own builders).
 *
 * For public syntax trees, call `cstBuildHost({ collapse })`: Parseman will skip
 * allocating wrapper CST nodes whose single child should stand in for the rule.
 */
export function cstBuildHost(options?: CstBuildHostOptions): BuildHost
export function cstBuildHost(
  type: string,
  children: ReadonlyArray<unknown>,
  fields: unknown,
  span: { start: number; end: number },
  rawChildren?: ReadonlyArray<unknown>,
  triviaLog?: readonly number[],
  state?: unknown,
  tags?: readonly string[] | undefined,
): unknown
export function cstBuildHost(
  typeOrOptions?: string | CstBuildHostOptions,
  children?: ReadonlyArray<unknown>,
  _fields?: unknown,
  span?: { start: number; end: number },
  rawChildren?: ReadonlyArray<unknown>,
  triviaLog?: readonly number[],
  state?: unknown,
  _tags?: readonly string[] | undefined,
): unknown {
  if (typeof typeOrOptions === 'string') {
    return buildCstNode(typeOrOptions, children ?? [], _fields, span ?? { start: 0, end: 0 }, rawChildren, triviaLog, state)
  }
  const collapse = normalizeCstCollapse(typeOrOptions?.collapse)
  const materializeTags = typeOrOptions?.tags === true
  const host: BuildHost = (
    type: string,
    children: ReadonlyArray<unknown> | undefined,
    fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
    triviaLog: readonly number[],
    state: unknown,
    tags?: readonly string[] | undefined,
    // A CST/collapse host always keeps `children` (chV) — the opt-out never
    // applies — so `?? []` is unreachable defensive modeling for the widened type.
  ) => buildCstNode(type, children ?? [], fields, span, rawChildren, triviaLog, state, materializeTags ? tags : undefined)
  ;(host as typeof host & { _parsemanCstOutput?: true })._parsemanCstOutput = true
  if (collapse) host._parsemanCstCollapse = collapse
  return host
}

// `cstBuildHost` itself is also accepted as a BuildHost (without options).
;(cstBuildHost as unknown as { _parsemanCstOutput?: true })._parsemanCstOutput = true

/**
 * A fused function receives the full ParseContext through `run()`. Direct
 * callers historically supplied a plain context object, so keep that usage
 * valid while making the function assignable to the public `Runnable` type.
 * Generated code treats optional framework fields as absent when they are not
 * provided, matching the interpreter's normal defaults.
 */
export type FusedRule = (
  input: string,
  pos: number,
  ctx: ParseContext | Record<string, unknown>,
) => ParseResult<unknown> & { readonly value?: unknown }

/**
 * Restrict a grammar/artifact to `names` plus their transitive rule-dependency
 * closure (à la carte selection) — e.g. Jess taking parts of Less and parts of
 * Sass: `compose([pick(less, ['MixinCall']), pick(sass, ['EachFor']), css])`. A
 * picked rule pulls in every rule name it references, so the result is always
 * self-consistent within the artifact. Accepts a grammar (`rules()` result) or a
 * compiled artifact; returns an artifact for `compose()`.
 */
export function pick(
  grammar: Record<string, Combinator<unknown>>,
  names: string[],
): Record<string, unknown> {
  // Selection happens on RULE MAPS, not on lowered pieces. The source lowering had to
  // filter compiled artifacts (`keys`/`ruleFns`/`wrappers`/`deps` in parallel, each a
  // separate Map that had to stay in sync); the table has one representation — the
  // combinator map — so the filter is applied once, to that, and the result is carried
  // as IR like any other piece.
  const trivia = (grammar as Record<symbol, unknown>)[COMPOSED_TRIVIA] as Combinator<unknown> | undefined
  const carried = (grammar as Record<symbol, unknown>)[COMPOSED_PIECES]
  // A COMPOSED grammar has no single rule map — its rules live across carried pieces,
  // and the selection must keep each rule in the piece that WINS it.
  const sources: Array<{ ns: string; rules: Array<[string, Combinator<unknown>]> }> = Array.isArray(carried)
    ? (carried as Array<LinkableTable | IRPiece>).flatMap(pc => {
        const rules = ruleMapOfCarried(pc)
        return rules === undefined ? [] : [{ ns: pc.ns, rules }]
      })
    : [{ ns: `_lk${_nsCounter++}_`, rules: Object.entries(grammar) }]

  const filtered = pickRuleMaps(sources, names)
  // Always a COMPOSED-LIKE value, for both inputs. `pick` used to return a bare artifact
  // for a plain grammar and a composed-like object for a composed one, so a downstream
  // `compose([pick(x, …)])` took a different flattening path depending on which kind of
  // grammar it was handed. One shape, one path.
  const out: Record<string, unknown> = {}
  const pieces: IRPiece[] = filtered.flatMap(s => {
    const ir = serializeRuleMap(s.rules, undefined)
    return ir === null ? [] : [{ ns: s.ns, ir }]
  })
  Object.defineProperty(out, COMPOSED_PIECES, { value: pieces, enumerable: false })
  if (trivia) Object.defineProperty(out, COMPOSED_TRIVIA, { value: trivia, enumerable: false })
  return out
}

/** Restrict ordered rule maps to `names` + their transitive dep closure, keeping each
 * surviving rule in the map that WINS it (later map wins, matching compose override
 * order). Shared by `pick()` (runtime) and the macro's build-time `pick(...)`, so
 * à-la-carte selection is identical on both paths. */
export function pickRuleMaps(
  sources: ReadonlyArray<{ ns: string; rules: Array<[string, Combinator<unknown>]> }>,
  names: string[],
): Array<{ ns: string; rules: Array<[string, Combinator<unknown>]> }> {
  const winner = new Map<string, { ns: string; rules: Array<[string, Combinator<unknown>]> }>()
  const deps = new Map<string, string[]>()
  for (const s of sources) {
    const d = ruleDependencies(s.rules)
    for (const [k, v] of d) deps.set(k, v)
    // A REFERENCE IS NOT A DEFINITION: a `rules(g => …)` cache also holds every `g.X`
    // that was merely accessed, as an unresolvable lazy. Left in, such an entry claims
    // to define a name it only mentions, and `pick` would hand back a hole where the
    // real definition was. Same guard as the compose merge.
    for (const [k, rule] of s.rules) {
      if (rule._def.tag === 'lazy') { try { rule._def.thunk() } catch { continue } }
      winner.set(k, s)
    }
  }
  // A requested name that isn't in the grammar is a typo — fail here, not later with a
  // confusing name-closure error at compose() time.
  for (const n of names) {
    if (!winner.has(n)) throw new Error(`pick: rule "${n}" is not in this grammar (available: ${[...winner.keys()].join(', ')})`)
  }
  const keep = new Set<string>()
  const visit = (n: string): void => {
    // A missing winner is an EXTERNAL dep (a base-grammar rule) — it resolves at
    // compose() time, not here. Top-level `names` were already validated above.
    if (keep.has(n) || !winner.has(n)) return
    keep.add(n)
    for (const d of deps.get(n) ?? []) visit(d)
  }
  for (const n of names) visit(n)
  return sources
    .map(s => ({ ns: s.ns, rules: s.rules.filter(([k]) => keep.has(k) && winner.get(k) === s) }))
    .filter(s => s.rules.length > 0)
}

/**
 * Fuse carried pieces into a runnable rule map — the TABLE equivalent of the
 * textual splice this file used to perform.
 *
 * `fusedBody()` concatenated namespaced `_r_<Name>` function sources, picked a winning
 * function per name, and patched `@FS:` dispatch placeholders with the winner's
 * first-set condition — roughly 200 lines whose entire job was to make separately
 * lowered SOURCE agree about names. A table has no text to splice, so the merge moves
 * up one level onto the combinators: merge the rule maps (later piece wins), then
 * `encodeTable` ONCE over the merged map. `enc.winners` binds every by-name reference,
 * including a base piece's internal `g.Atom` that an override replaced, so open
 * recursion across pieces resolves without relocating a single encoded offset.
 *
 * One encode, no pools to merge, and the result is the table the merged grammar would
 * have produced had it been written as a single `rules()` call.
 */
function fuseCarried(
  carried: ReadonlyArray<LinkableTable | IRPiece>,
  trivia?: Combinator<unknown>,
  hostMode?: HostMode,
): Record<string, FusedRule> {
  const maps: Array<Array<[string, Combinator<unknown>]>> = []
  for (const p of carried) {
    // ARTIFACT VERSION LOCK. `fusedBody` enforced this and would have taken it with it:
    // artifacts are version-locked and there is no cross-version read path, so an
    // UNSTAMPED piece and a MISMATCHED one are both refused — a stale artifact that
    // merely happens to still encode is exactly what this stops.
    if (!isIRPiece(p)) {
      if (typeof p.v !== 'string') {
        throw new Error(
          `parseman: artifact "${p.ns}" is UNSTAMPED (compiled before the version-lock invariant). `
          + `Recompile the grammar with parseman ${PARSEMAN_VERSION}; parseman does not fuse unversioned or cross-version artifacts.`,
        )
      }
      if (p.v !== PARSEMAN_VERSION) {
        throw new Error(
          `parseman: artifact "${p.ns}" was compiled with parseman ${p.v}, but is being fused with parseman ${PARSEMAN_VERSION}. `
          + `Compiled grammar artifacts are version-locked — recompile the grammar with parseman ${PARSEMAN_VERSION}; parseman does not fuse across versions.`,
        )
      }
    }
    const rules = ruleMapOfCarried(p)
    if (rules === undefined) {
      throw new Error(`compose: carried piece "${p.ns}" has no re-lowerable IR and cannot be fused`)
    }
    maps.push(rules)
  }
  const merged = mergeCarriedRuleMaps(maps)
  // COMPOSING-WINS is an OVERRIDE, not a gap-fill: the composing grammar's trivia
  // governs every fused rule INCLUDING inherited ones. `applyAmbient` inside
  // `compileRuleMapTable` only fills a rule that declares none, which would leave an
  // inherited rule still skipping its own base's whitespace after a delta re-declared
  // it. Safe to mutate — `evalRuleMapIR` builds fresh combinators per fuse.
  if (trivia) {
    for (const [, rule] of merged) {
      if (rule._meta.isTrivia) continue
      ;(rule._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia = trivia
    }
  }
  const compiled = compileRuleMapTable(merged, {
    ...(trivia ? { trivia } : {}),
    ...(hostMode ? { hostMode } : {}),
  })
  if (compiled === null) throw new Error('compose: the merged grammar could not be encoded to a table')
  const map = tableRules(compiled.prog) as unknown as Record<string, FusedRule>
  // The host-mode stamp went on the fused closure before; a table carries nothing until
  // it is stamped, and an UNSTAMPED map reads as `{ ast, false }` so every driver
  // compatibility check passes vacuously. Stamped on the rule functions too, because
  // `run(map.Rule, …)` is handed the rule and never sees the map.
  for (const k of Object.keys(map)) {
    Object.defineProperty(map[k]!, FUSED_HOST_MODE, { value: compiled.hostMode, enumerable: false })
    Object.defineProperty(map[k]!, FUSED_HOST_ELIDED, { value: compiled.hostBranchElided, enumerable: false })
  }
  Object.defineProperty(map, FUSED_HOST_MODE, { value: compiled.hostMode, enumerable: false })
  Object.defineProperty(map, FUSED_HOST_ELIDED, { value: compiled.hostBranchElided, enumerable: false })
  return map
}

/** The combinator map behind a carried piece: IR is evaluated back, a table piece
 * uses the IR it always carries. `undefined` only for a piece with neither. */
function ruleMapOfCarried(p: LinkableTable | IRPiece): Array<[string, Combinator<unknown>]> | undefined {
  if (isIRPiece(p)) return evalRuleMapIR(p.ir)
  return p.ir === null ? undefined : evalRuleMapIR(p.ir)
}

/** Fold ordered rule maps into the composed map: a later piece's name WINS.
 *
 * A REFERENCE IS NOT A DEFINITION. A `rules(g => …)` cache also holds every `g.X` that
 * was merely ACCESSED, as an unresolvable lazy. Merged in order, such an entry lands
 * last and SHADOWS the piece that actually defines the name — the encoder then finds a
 * hole where the winner should be and refuses the whole grammar. The reference is not
 * lost: it stays inside the referring piece's rule bodies, where `enc.winners` binds it
 * by name to whichever piece supplies the definition.
 */
function mergeCarriedRuleMaps(
  maps: ReadonlyArray<ReadonlyArray<readonly [string, Combinator<unknown>]>>,
): Array<[string, Combinator<unknown>]> {
  const winners = new Map<string, Combinator<unknown>>()
  for (const map of maps) {
    for (const [name, rule] of map) {
      if (rule._def.tag === 'lazy') {
        try { rule._def.thunk() } catch { continue }
      }
      winners.set(name, rule)
    }
  }
  return [...winners]
}


export { FUSED_HOST_MODE, FUSED_HOST_ELIDED } from '../cst/host-mode.ts'

/** The host mode a fused/composed rule map was built for. Defaults to 'ast'. */
export function fusedHostModeOf(registry: object): HostMode {
  const m = (registry as Record<symbol, unknown>)[FUSED_HOST_MODE]
  return m === 'cst' ? 'cst' : 'ast'
}

/** Whether a fused/composed rule map dropped any direct builder's CST branch. */
export function fusedHostElidedOf(registry: object): boolean {
  return (registry as Record<symbol, unknown>)[FUSED_HOST_ELIDED] === true
}

/**
 * Compose grammars/artifacts into a runnable parser map — the ONLY public
 * composition entry point. `compose([base, ext, …])`: later entries override
 * earlier ones by rule name, and because fusion re-binds every reference in one
 * shared scope, an override reroutes the base's OWN calls too (open recursion).
 *
 * Each entry may be a **grammar** (a `rules()` result — a map of combinators,
 * linkable-ified here) OR an already-compiled **linkable artifact** (what the
 * macro emits and a package ships). So a package needs no opt-in wrapper to be
 * composable — `compose([importedGrammar, myRules])` just works.
 *
 * The macro compiles `compose([...])` to STATIC fused source (no `new Function`).
 * Called at runtime (no macro, like `compile()`) it fuses via `new Function`.
 */
/** A composed parser carries its flattened source pieces (non-enumerable) so it
 * can be composed AGAIN — `compose([lessGrammar, delta])` where `lessGrammar` is
 * itself a `compose([...])` result. */
const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

/** The carried pieces a `compose()`/`composeLeaf()` result holds, or `undefined` when
 * the value is not a composed grammar. This is what makes a fused grammar analysable:
 * the pieces are re-lowerable IR even though the fused map itself is only functions. */
export function composedPiecesOf(
  grammar: Record<string, unknown>,
): ReadonlyArray<LinkableTable | IRPiece> | undefined {
  const pieces = (grammar as unknown as Record<symbol, unknown>)[COMPOSED_PIECES]
  return Array.isArray(pieces) ? pieces as ReadonlyArray<LinkableTable | IRPiece> : undefined
}

/**
 * A terminal fused grammar may be used to run a parser, but not as an input to
 * another composition. Macro `composeLeaf()` uses this for a local semantic
 * reduction over imported recognition-only IR: the local reductions stay in
 * their lexical module and therefore never become carried IR.
 */
const LEAF_COMPOSED = Symbol.for('parseman.leafComposed')

/** The composing (outermost) trivia a runtime `compose()` applied — stored so a
 * later `pick(composedGrammar, …)` can re-lower the selected rules under the SAME
 * trivia (composing-wins survives à-la-carte selection). The carried IR pieces hold
 * no trivia of their own, so it must be remembered separately. Not serialized by the
 * macro (which delegates pick to the runtime linker). */
const COMPOSED_TRIVIA = Symbol.for('parseman.composedTrivia')

/** Final winner map for semantic-coverage tooling. It exists only when every
 * carried compose piece is re-lowerable IR; opaque precompiled artifacts have no
 * combinator graph to inspect and therefore deliberately expose no fake map. */
const COMPOSED_COVERAGE_RULES = Symbol.for('parseman.composedCoverageRules')

/** The compact IR form a grammar carries instead of its lowered rule source: the
 * combinator-construction expression, re-lowered here at fuse time. */
export type IRPiece = { ns: string; ir: string; trackLines?: true }

function isIRPiece(p: unknown): p is IRPiece {
  return !!p && typeof p === 'object'
    && typeof (p as IRPiece).ir === 'string' && typeof (p as IRPiece).ns === 'string'
    && !('keys' in (p as object))
}

/** A `linkable()` artifact — a TABLE piece. Distinguished from a bare IR piece by the
 * fields only a compiled artifact has (`keys`/`external`), and from a plain `rules()`
 * map by carrying `ns` at all. */
function isLinkableTable(p: unknown): p is LinkableTable {
  return !!p && typeof p === 'object'
    && typeof (p as LinkableTable).ns === 'string'
    && Array.isArray((p as LinkableTable).keys)
}

/** Memoize a zero-arg thunk, keeping it LAZY. Used where two diagnostic thunks want
 * the same carried-IR hydration: the work must not happen when the diagnostic is off,
 * and must not happen twice when it is on. */
export function once<T>(fn: () => T): () => T {
  let done = false
  let value: T
  return () => {
    if (!done) { value = fn(); done = true }
    return value
  }
}

/** The re-lowerable carried pieces' rule maps, in compose order — the input to the
 * gating analysis (`diagnoseGrammar`). An opaque precompiled artifact contributes no
 * combinator graph, so it is skipped: a hole it would have bound stays unresolved
 * and its choice stays deferred, never falsely warned.
 *
 * Skipping is not the same as having nothing to say. Use `carriedRuleMapsDetailed`
 * where the skip must be REPORTED — a diagnostic that drops part of the grammar and
 * then returns a clean result is indistinguishable from one that verified it. */
export function carriedRuleMaps(carried: ReadonlyArray<LinkableTable | IRPiece>): Array<Array<[string, Combinator<unknown>]>> {
  return carriedRuleMapsDetailed(carried).maps
}

/** `carriedRuleMaps` plus the pieces it could NOT re-lower, named by namespace and
 * rule count, so a caller can report exactly how much of the grammar went unseen. */
export function carriedRuleMapsDetailed(
  carried: ReadonlyArray<LinkableTable | IRPiece>,
): { maps: Array<Array<[string, Combinator<unknown>]>>; opaque: Array<{ ns: string; ruleNames: string[] }> } {
  const maps: Array<Array<[string, Combinator<unknown>]>> = []
  const opaque: Array<{ ns: string; ruleNames: string[] }> = []
  for (const p of carried) {
    if (isIRPiece(p)) { maps.push(evalRuleMapIR(p.ir)); continue }
    // `ruleFns` is a Map, not a plain object — `Object.keys` on it silently yields []
    // and every opaque piece would degrade to an anonymous `<artifact _lkN_>`, which is
    // exactly the "reported, but uselessly" failure this whole change is against.
    const ruleFns = (p as { ruleFns?: Map<string, string> }).ruleFns
    opaque.push({ ns: p.ns, ruleNames: ruleFns instanceof Map ? [...ruleFns.keys()] : [] })
  }
  return { maps, opaque }
}

/**
 * Recover the override-winner COMBINATOR map behind a `compose()` result, plus the
 * pieces that could not be recovered.
 *
 * A fused map holds rule functions, so any consumer that walks a combinator graph
 * (gating analysis, the spec/EBNF/railroad model) cannot read it directly. The graph
 * is not lost, though — `compose()` retains re-lowerable IR — so this is the single
 * shared recovery both consumers use. Sharing it is the point: two copies of this
 * logic is how one walker gets fixed and the other silently keeps failing.
 *
 * Returns `undefined` when `grammar` is not a composed result.
 */
export function recoverComposedRules(
  grammar: Record<string, unknown>,
): { rules: Map<string, Combinator<unknown>>; opaque: Array<{ ns: string; ruleNames: string[] }> } | undefined {
  const carried = composedPiecesOf(grammar)
  if (carried === undefined) return undefined
  const { maps, opaque } = carriedRuleMapsDetailed(carried)
  const rules = new Map<string, Combinator<unknown>>()
  // Later wins, matching the linker's own fuse semantics. An accessed-but-undefined
  // `g.X` leaks in as an unresolved lazy — a REFERENCE, not a definition — and must
  // never shadow the artifact that really defines X.
  for (const map of maps) for (const [name, rule] of map) {
    if (rule._def.tag === 'lazy') { try { rule._def.thunk() } catch { continue } }
    rules.set(name, rule)
  }
  return { rules, opaque }
}

function coverageRulesOf(carried: Array<LinkableTable | IRPiece>): Record<string, Combinator<unknown>> | undefined {
  const winners: Record<string, Combinator<unknown>> = {}
  for (const piece of carried) {
    if (!isIRPiece(piece)) return undefined
    const map = evalRuleMapIR(piece.ir)
    for (const [name, rule] of map) {
      // An accessed-but-undefined `g.Name` is an external reference, never a
      // rule definition. Match compose's IR filtering rule exactly.
      if (rule._def.tag === 'lazy') {
        try { rule._def.thunk() } catch { continue }
      }
      winners[name] = rule
    }
  }
  return winners
}

/** Return the final override-winner combinator map carried by runtime
 * `compose()`, or `undefined` when a precompiled opaque artifact participated.
 * This is intentionally internal: callers must not treat it as a parser API. */
export function composedCoverageRules(grammar: Record<string, unknown>): Record<string, Combinator<unknown>> | undefined {
  return (grammar as Record<symbol, unknown>)[COMPOSED_COVERAGE_RULES] as Record<string, Combinator<unknown>> | undefined
}

/** Flatten one `compose()` item to its pieces: a prior composed result → its
 * carried list; an artifact → itself; a grammar (`rules()` map) → linkable-ified. */
function nextComposeNs(used: Set<string>): string {
  let ns: string
  do { ns = `_lk${_nsCounter++}_` } while (used.has(ns))
  used.add(ns)
  return ns
}

/** Flatten one `compose()` item to its RE-LOWERABLE carried items — the form stored
 * on the composed result so it can be composed AGAIN under a NEW composing trivia.
 * A grammar (`rules()` map) is carried as compact IR (`{ns, ir}`), NOT baked source,
 * so a later `compose([thisResult, delta])` re-lowers it with the delta's trivia
 * (multi-level composing-wins). A prior composed result contributes its OWN carried
 * items (already IR); a pre-compiled artifact has no source, so it stays baked. */
function itemCarried(
  item: LinkableTable | Record<string, unknown>,
  used: Set<string>,
  trivia?: Combinator<unknown>,
  // Only reaches the non-serializable fallback below, where the grammar is baked
  // immediately instead of carried as re-lowerable IR.
  hostMode?: HostMode,
): Array<LinkableTable | IRPiece> {
  const carried = (item as Record<symbol, unknown>)[COMPOSED_PIECES]
  // A prior composed result (runtime or macro-compiled): its carried list is already
  // re-lowerable (IR pieces, plus any pre-compiled artifacts). Pass it through so THIS
  // compose re-lowers it under its own composing trivia. Reserve its namespaces so a
  // sibling grammar map can't collide with them.
  if (Array.isArray(carried)) {
    const items = carried as Array<LinkableTable | IRPiece>
    for (const p of items) used.add(p.ns)
    return items
  }
  // A pre-compiled artifact (`linkable()`): a table piece. It ALWAYS carries its IR,
  // which is what makes table-to-table composition a rule-map merge rather than a
  // relocation of two encoded programs — so unlike a source artifact it stays
  // re-lowerable under a new composing trivia.
  if (isLinkableTable(item)) {
    used.add(item.ns)
    return [item]
  }
  // A grammar (`rules()` map): carry it as compact IR so a later compose re-lowers it
  // under ITS trivia. Unserializable → bake now with this compose's trivia (can't
  // re-lower later; acceptable fallback, mirrors the macro's full-pieces fallback).
  const map = item as Record<string, Combinator<unknown>>
  const ns = nextComposeNs(used)
  // Drop EXTERNAL entries first (same filter as compileLinkable): a `rules()` cache
  // also holds every ACCESSED-but-undefined `g.X` as an unresolved-lazy entry. Left in,
  // serializeRuleMap would emit `X: g["X"]` — a self-referential rule that shadows the
  // sibling artifact defining X and recurses forever. They resolve by name at fuse time.
  const entries = Object.entries(map).filter(([, val]) => {
    const d = val._def
    if (d.tag !== 'lazy') return true
    try { d.thunk(); return true } catch { return false }
  })
  // Carry this grammar's ambient `scanSkip` (per-piece — opaque units are
  // dialect-specific, NOT composing-wins) into the IR so a re-lower stamps
  // `grammarScanSkip` back on. `linkable()`'s fallback reads it off `_meta` directly.
  const scanSkip = entries
    .map(([, val]) => (val._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip)
    .find(Boolean)
  const ir = serializeRuleMap(entries, scanSkip)
  return ir ? [{ ns, ir }] : [linkable(map, ns, trivia, hostMode)]
}

/** The composed grammar's ambient trivia = the LAST composed item that declares a
 * grammar-level trivia (via `rules({ trivia }, …)`, which tags `grammarTrivia` on its
 * rules). Outermost wins: the composing grammar's trivia applies to every fused rule,
 * including those inherited from a base — so e.g. an SCSS `rw` (which extends Less's)
 * governs the inherited Less/CSS rules too. `parser`/`noTrivia` still override locally. */
function composingTriviaOf(items: Array<LinkableTable | Record<string, unknown>>): Combinator<unknown> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Record<string, unknown> | undefined
    if (!item || isLinkableTable(item) || (item as Record<symbol, unknown>)[COMPOSED_PIECES]) continue
    for (const v of Object.values(item)) {
      const t = (v as Combinator<unknown> | undefined)?._meta?.grammarTrivia
      if (t) return t
    }
  }
  return undefined
}

export function compose(
  items: Array<LinkableTable | Record<string, unknown>>,
  /**
   * Compile-time host mode for the fused artifact, same meaning as
   * `compile(g, { hostMode })`. Omit (or `'ast'`) for the eval driver — the fused rules
   * build through the grammar's own `build` callbacks and carry no positioned-CST
   * branch. Pass `'cst'` to fuse a SECOND artifact from the same pieces for the linter /
   * IDE / language-service driver. Two compilations of one grammar, decided here, rather
   * than one artifact deciding per node on every parse.
   */
  opts?: { hostMode?: HostMode },
): Record<string, FusedRule> {
  if (items.some(item => (item as Record<symbol, unknown>)[LEAF_COMPOSED] === true)) {
    throw new Error('compose: a composeLeaf() result is terminal and cannot be composed again')
  }
  const used = new Set<string>()
  // The composed grammar's ambient trivia comes from the composing grammar itself —
  // whatever the last piece declared via rules({ trivia }, …). No separate option:
  // the trivia rides with the grammar that declared it.
  const trivia = composingTriviaOf(items)
  // Carried items are RE-LOWERABLE (IR); materialize them ONCE with this compose's
  // trivia for the now-fuse, but STORE the un-materialized carried list so a later
  // compose can re-lower it under a different trivia (multi-level composing-wins).
  const carried = items.flatMap(item => itemCarried(item, used, trivia, opts?.hostMode))
  const map = fuseCarried(carried, trivia, opts?.hostMode)
  Object.defineProperty(map, COMPOSED_PIECES, { value: carried, enumerable: false })
  if (trivia) Object.defineProperty(map, COMPOSED_TRIVIA, { value: trivia, enumerable: false })
  const coverageRules = coverageRulesOf(carried)
  if (coverageRules) Object.defineProperty(map, COMPOSED_COVERAGE_RULES, { value: coverageRules, enumerable: false })
  return map
}

/**
 * Compose a terminal grammar. This is for a leaf parser that overlays local
 * semantic reductions on reusable recognition rules.
 *
 * Under the macro this lowers to STATIC fused source (functions), exactly like
 * `compose()`. It is still macro-only as a *compiled* artifact: without macro
 * lowering there is no safe way to keep lexical builders out of carried IR, so it
 * never falls back to runtime CODEGEN composition.
 *
 * Called at runtime (no macro) it returns the INTERPRETED fuse of the same items
 * — a combinator map, not a map of compiled functions (`fuseInterpreted`). That is
 * the supported way to run/inspect a leaf grammar without a build step: drive it
 * with `run()` / `parseDoc()`, which accept either shape. The declared return type
 * is the MACRO-path type (a leaf grammar is shipped compiled); use
 * `isInterpretedFuse(map)` when a caller must tell the two apart.
 */
export function composeLeaf(
  items: Array<LinkableTable | Record<string, unknown>>,
): Record<string, FusedRule> {
  const pieces = items.flatMap(interpretedPieces)
  let fused: Record<string, Combinator<unknown>> | undefined
  const map: Record<string, unknown> = {}
  // LAZY on purpose. A grammar module typically builds SEVERAL leaf grammars over
  // one shared recognition piece (`cssGrammar`, `cssLineGrammar`, `cssCstGrammar`,
  // …). An interpreted fuse binds that shared piece IN PLACE, so only one of them
  // can exist at a time — fusing all of them at import would make merely importing
  // the module throw. Fusing on first ACCESS means the grammar you actually use
  // works, and reaching for a second, conflicting one fails loudly at that point.
  // (`trackLines`/`hostMode` are compile-time distinctions; the interpreter decides
  // both per parse, so those variants are the same interpreted grammar anyway.)
  for (const name of ruleNamesOf(pieces)) {
    Object.defineProperty(map, name, {
      enumerable: true,
      configurable: true,
      get: () => (fused ??= fusePieces(pieces))[name],
    })
  }
  Object.defineProperty(map, LEAF_COMPOSED, { value: true, enumerable: false })
  Object.defineProperty(map, INTERPRETED_PIECES, {
    value: pieces.filter(p => p.plain).map(p => p.entries),
    enumerable: false,
  })
  return map as unknown as Record<string, FusedRule>
}

/* ── Interpreted fuse ─────────────────────────────────────────────────────────
 *
 * `compose()` fuses by CODEGEN: every piece is compiled to `_r_<Name>` functions
 * dropped into one scope, so a reference resolves by NAME and an override reroutes
 * the base piece's own calls (open recursion). None of that exists interpreted —
 * the interpreter runs the combinator graph, and a cross-piece reference is an
 * ordinary `ref()` placeholder that nobody ever `.define()`d. That is why a
 * composed grammar could not be run interpreted at all, and why every diagnostic
 * that must NOT reach codegen (profiling, gating analysis, coverage) had to be
 * hand-fused in throwaway scripts.
 *
 * The interpreted fuse binds those placeholders directly, with the SAME semantics
 * the compiled fuse gets from name resolution:
 *   - later piece wins per rule name (matching `fuseRules`/`pickPieces`);
 *   - an override REPOINTS the slot every call site already holds, so a base
 *     piece's internal calls reroute too (open recursion);
 *   - the composing grammar's trivia governs every fused rule (`composingTriviaOf`);
 *   - a referenced-but-undefined rule is a fuse-time error, not a parse-time one.
 *
 * It is MUTATING by construction: a hole is a shared object, and binding it is the
 * only way its call sites can see the answer. `repointRef` therefore records what
 * it changed and refuses a CONFLICTING second bind, so two different fusions over
 * one shared piece fail loudly instead of silently rewriting each other's parser.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * A rule slot produced by `ref()` — what `rules()` stores for every rule that is
 * referenced by name, and for every `g.X` hole a piece leaves for another piece to
 * fill. `parse`/`_def.thunk` are OWN properties of that object, which is what lets
 * the interpreted fuse repoint it in place.
 */
type RefSlot = Combinator<unknown> & {
  _def: { tag: 'lazy'; thunk: () => Combinator<unknown> }
  define(p: Combinator<unknown>): void
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<unknown>
}

function isRefSlot(c: Combinator<unknown>): c is RefSlot {
  return c._def.tag === 'lazy' && typeof (c as unknown as { define?: unknown }).define === 'function'
}

/** What a slot resolved to BEFORE any interpreted fuse touched it (`null` = it was
 * an unbound cross-piece hole). Recorded on first repoint so a LATER fuse computes
 * its winner from the grammar as authored, never from another fusion's binding. */
const FUSE_ORIGINAL = Symbol.for('parseman.interpretedFuseOriginal')
/** What an interpreted fuse repointed this slot at. */
const FUSE_TARGET = Symbol.for('parseman.interpretedFuseTarget')
/** The source rule maps behind a `fuseInterpreted()` result, so it can be fused
 * again — the interpreted mirror of `COMPOSED_PIECES`. */
const INTERPRETED_PIECES = Symbol.for('parseman.interpretedPieces')

/** Whether `map` is an interpreted fuse (a combinator map) rather than a compiled
 * `compose()` result (a map of fused functions). */
export function isInterpretedFuse(map: object): boolean {
  return Array.isArray((map as Record<symbol, unknown>)[INTERPRETED_PIECES])
}

type NamedEntries = ReadonlyArray<[string, Combinator<unknown>]>
/** `plain` = the item was an authored `rules()` map. Only plain maps declare the
 * composing trivia, mirroring `composingTriviaOf`, which skips artifacts and prior
 * composed results for exactly the same reason: their trivia was already applied. */
type FusePiece = { entries: NamedEntries; plain: boolean }

/** The rule a map entry DEFINES, or `undefined` when it is an external reference
 * (an accessed-but-undefined `g.X`). Same local-vs-external test `compileLinkable`
 * and `itemCarried` apply, so the two fuses agree on what a piece contributes. */
function definitionOf(entry: Combinator<unknown>): Combinator<unknown> | undefined {
  if (isRefSlot(entry)) {
    const original = (entry as unknown as Record<symbol, unknown>)[FUSE_ORIGINAL]
    if (original !== undefined) return (original as Combinator<unknown> | null) ?? undefined
    try { return entry._def.thunk() } catch { return undefined }
  }
  if (entry._def.tag === 'lazy') {
    try { (entry._def as { thunk: () => Combinator<unknown> }).thunk() } catch { return undefined }
  }
  return entry
}

/** Point `slot` at `target`, updating every call site that holds it. Mirrors
 * `ref().define()`'s metadata propagation; refuses to overwrite a binding a
 * DIFFERENT fusion already made (see the mutation note above). */
function repointRef(slot: RefSlot, target: Combinator<unknown>, name: string): void {
  const tagged = slot as unknown as Record<symbol, unknown>
  const bound = tagged[FUSE_TARGET] as Combinator<unknown> | undefined
  const original = FUSE_ORIGINAL in tagged
    ? tagged[FUSE_ORIGINAL] as Combinator<unknown> | null
    : (() => { try { return slot._def.thunk() } catch { return null } })()
  if ((bound ?? original) === target) return
  if (bound !== undefined) {
    throw new Error(
      `fuseInterpreted: rule "${name}" is already bound by a DIFFERENT interpreted fusion of the same grammar piece. `
      + `An interpreted fuse binds the shared placeholder objects in place, so two fusions cannot share a piece — `
      + `build a fresh instance of the piece (call its rules() factory again, or import the module under a distinct specifier) for the second fusion.`,
    )
  }
  if (!(FUSE_ORIGINAL in tagged)) Object.defineProperty(slot, FUSE_ORIGINAL, { value: original, enumerable: false })
  Object.defineProperty(slot, FUSE_TARGET, { value: target, enumerable: false })
  slot._def.thunk = () => target
  slot.parse = (input, pos, ctx) => target.parse(input, pos, ctx)
  const meta = slot._meta
  meta.firstSet = target._meta.firstSet
  meta.canMatchNewline = target._meta.canMatchNewline
  meta.isTrivia = target._meta.isTrivia
  if (target._meta.triviaKindLabels !== undefined) meta.triviaKindLabels = target._meta.triviaKindLabels
  else delete meta.triviaKindLabels
  if (target._meta.disjoint !== undefined) meta.disjoint = target._meta.disjoint
  else delete meta.disjoint
}

/** Flatten one `fuseInterpreted()` item to the rule maps it contributes, in order. */
function interpretedPieces(item: LinkableTable | Record<string, unknown>): FusePiece[] {
  const fused = (item as Record<symbol, unknown>)[INTERPRETED_PIECES]
  if (Array.isArray(fused)) return (fused as NamedEntries[]).map(entries => ({ entries, plain: false }))
  const carried = composedPiecesOf(item as Record<string, unknown>)
  if (carried !== undefined) {
    // A compiled `compose()` result. Its carried IR re-lowers to combinators, but a
    // piece that arrived already COMPILED has no combinator graph at all — fusing
    // around it would silently drop its rules, which is the one failure mode a
    // diagnostic must never have.
    const { maps, opaque } = carriedRuleMapsDetailed(carried)
    if (opaque.length > 0) {
      throw new Error(
        `fuseInterpreted: cannot interpret a composed grammar containing precompiled artifact(s) `
        + `${opaque.map(o => `"${o.ns}" (${o.ruleNames.length} rules)`).join(', ')} — they carry compiled functions, not a combinator graph. `
        + `Pass the source grammars (the same items you passed to compose()) instead.`,
      )
    }
    return maps.map(entries => ({ entries, plain: false }))
  }
  if (isLinkableTable(item)) {
    // A table piece DOES carry its IR, so this is recoverable rather than fatal: hydrate
    // the combinator graph back out of it and interpret that.
    const rules = ruleMapOfCarried(item)
    if (rules === undefined) {
      throw new Error('fuseInterpreted: a precompiled linkable artifact with no carried IR has no combinator graph to interpret; pass the source grammar (a rules() map) instead')
    }
    return [{ entries: rules, plain: false }]
  }
  return [{ entries: Object.entries(item as Record<string, Combinator<unknown>>), plain: true }]
}

/**
 * Materialize a composition as a RUNNABLE INTERPRETED rule map — the interpreted
 * counterpart of `compose()`, with identical fuse semantics (later piece wins,
 * override reroutes the base's own calls, composing trivia governs every rule).
 * No codegen, no `new Function`, no macro build step: the result is a plain map of
 * combinators that `run()` / `parseDoc()` accept exactly like a fused map.
 *
 * This is what diagnostics and profiling run against — they must stay in
 * interpreted mode, and before this they could not see a composed grammar at all.
 *
 * Items are the SAME items `compose()`/`composeLeaf()` take: `rules()` maps
 * (the intended input), a prior `fuseInterpreted()` result, or a runtime
 * `compose()` result (re-lowered from its carried IR — note that carried IR cannot
 * materialize direct `node()` builders, so prefer the source maps). A precompiled
 * `linkable()` artifact is rejected: it has no combinator graph.
 *
 * MUTATION: binding a cross-piece hole rewrites the shared placeholder object every
 * call site already holds — that IS how an override reaches a base piece's own
 * calls. A second, DIFFERENT fusion over the same piece objects therefore throws
 * rather than silently rewriting the first one's parser.
 */
export function fuseInterpreted(
  items: Array<LinkableTable | Record<string, unknown>>,
  opts?: { hostMode?: HostMode },
): Record<string, Combinator<unknown>> {
  return fusePieces(items.flatMap(interpretedPieces), opts)
}

/** The rule names a fusion of these pieces defines, in winner order — computable
 * WITHOUT binding anything, which is what lets `composeLeaf()` expose its key set
 * before it fuses. */
function ruleNamesOf(pieces: FusePiece[]): string[] {
  const names = new Set<string>()
  for (const piece of pieces) {
    for (const [name, value] of piece.entries) if (definitionOf(value) !== undefined) names.add(name)
  }
  return [...names]
}

function fusePieces(
  pieces: FusePiece[],
  opts?: { hostMode?: HostMode },
): Record<string, Combinator<unknown>> {
  // Composing-wins trivia, read exactly as `composingTriviaOf` reads it for compose():
  // the LAST authored grammar that declared `rules({ trivia }, …)`.
  let trivia: Combinator<unknown> | undefined
  for (let i = pieces.length - 1; i >= 0 && trivia === undefined; i--) {
    if (!pieces[i]!.plain) continue
    for (const [, rule] of pieces[i]!.entries) {
      const t = rule._meta.grammarTrivia
      if (t) { trivia = t; break }
    }
  }

  // Winner per rule name — later piece wins, matching `fuseRules`. The winner is the
  // DEFINITION, never the slot holding it: a slot can be repointed, and a chain
  // through one would make an override of X reroute into itself.
  const winner = new Map<string, Combinator<unknown>>()
  const entry = new Map<string, Combinator<unknown>>()
  for (const piece of pieces) {
    for (const [name, value] of piece.entries) {
      const def = definitionOf(value)
      if (def === undefined) continue
      winner.set(name, def)
      entry.set(name, value)
    }
  }

  // Bind every hole (and repoint every overridden slot) before anything runs.
  const missing = new Set<string>()
  for (const piece of pieces) {
    for (const [name, value] of piece.entries) {
      if (!isRefSlot(value)) continue
      const target = winner.get(name)
      if (target === undefined) { missing.add(name); continue }
      repointRef(value, target, name)
    }
  }
  if (missing.size > 0) throw new Error(missingRuleMessage(pieces, missing))

  const out: Record<string, Combinator<unknown>> = {}
  for (const [name, value] of entry) {
    out[name] = value
    const meta = value._meta as {
      isTrivia: boolean
      grammarTrivia?: Combinator<unknown>
      grammarHostMode?: HostMode
    }
    // A trivia rule must never carry the ambient trivia (it would recursively skip
    // trivia within itself) — the same guard `compileLinkable` applies per rule.
    if (trivia !== undefined && !meta.isTrivia) meta.grammarTrivia = trivia
    // Host mode is PER PIECE, exactly as `compileLinkable` resolves it: an explicit
    // option wins, otherwise the owning piece's own `rules({ hostMode })` stamp.
    if (opts?.hostMode !== undefined && !meta.isTrivia) {
      if (opts.hostMode === 'cst') meta.grammarHostMode = 'cst'
      else delete meta.grammarHostMode
    }
  }
  Object.defineProperty(out, INTERPRETED_PIECES, {
    value: pieces.filter(p => p.plain).map(p => p.entries),
    enumerable: false,
  })
  return out
}

/** Name-closure failure, reported the way the compiled fuse reports it: which rule
 * referenced the missing name. Computed only on the error path. */
function missingRuleMessage(pieces: FusePiece[], missing: Set<string>): string {
  for (const piece of pieces) {
    const deps = ruleDependencies(piece.entries.filter(([, v]) => definitionOf(v) !== undefined))
    for (const [name, ds] of deps) {
      for (const d of ds) if (missing.has(d)) return `fuseInterpreted: rule "${name}" references missing rule "${d}"`
    }
  }
  return `fuseInterpreted: missing rule(s) ${[...missing].map(n => `"${n}"`).join(', ')}`
}
