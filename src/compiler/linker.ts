/**
 * The linker (RULE_ABI_PLAN §4): fuse independently-compiled linkable artifacts
 * (`compileLinkable`) into ONE closure of parse functions.
 *
 * Every rule is a canonical `_r_<Name>` function and every sibling reference is a
 * call to that name; because fusion drops them all into one scope, those calls
 * are **direct local calls** (0% dispatch). Composition is by name:
 *   - **override** — later artifact wins per rule name; because references resolve
 *     by name in the shared scope, overriding a rule reroutes EVERY call to it,
 *     including calls inside a base artifact's own rules (open recursion).
 *   - **à la carte** — `pick(artifact, names)` keeps only those rules + their
 *     transitive dependency closure.
 * Private per-artifact state (`_ns_re`, `_ns_pf`, …) is namespaced so it can't
 * collide; the sentinel protocol / `_EMPTY_TL` are shared and
 * emitted once.
 *
 * Uses `new Function` (like `compile()`), so it needs `'unsafe-eval'` under a
 * strict CSP; a build-time variant that emits fused source instead is a later
 * addition. Fusion runs ONCE at parser construction — parsing is then full speed.
 */
import { compileLinkable, firstSetCond, HOST_READS_DECL } from './codegen.ts'
import { evalRuleMapIR, serializeRuleMap } from './ir-serialize.ts'
import type { LinkablePieces, FirstSetRecipe } from './codegen.ts'
import { union } from '../combinators/first-set.ts'
import { PARSEMAN_VERSION } from '../version.ts'
import type { BuildHost, Combinator, CstCollapsePredicate, FirstSet, ParseContext, ParseResult } from '../types.ts'

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
): LinkablePieces {
  const pieces = compileLinkable(Object.entries(rulesMap), ns ?? `_lk${_nsCounter++}_`, trivia ? { trivia } : undefined)
  if (!pieces) throw new Error('linkable(): this grammar cannot be compiled to a linkable artifact (contains a runtime-only parser fallback)')
  return pieces
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
): unknown {
  // Carry the grammar's `ctx.state` snapshot onto the node (null when unset) — the
  // CST contract includes `state` and incremental re-parse replays it on edit.
  return { _tag: 'node', type, span: { start: span.start, end: span.end }, state: state ?? null, children: [...children] }
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
): unknown
export function cstBuildHost(
  typeOrOptions?: string | CstBuildHostOptions,
  children?: ReadonlyArray<unknown>,
  _fields?: unknown,
  span?: { start: number; end: number },
  rawChildren?: ReadonlyArray<unknown>,
  triviaLog?: readonly number[],
  state?: unknown,
): unknown {
  if (typeof typeOrOptions === 'string') {
    return buildCstNode(typeOrOptions, children ?? [], _fields, span ?? { start: 0, end: 0 }, rawChildren, triviaLog, state)
  }
  const collapse = normalizeCstCollapse(typeOrOptions?.collapse)
  const host: BuildHost = (
    type: string,
    children: ReadonlyArray<unknown> | undefined,
    fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
    triviaLog: readonly number[],
    state: unknown,
    // A CST/collapse host always keeps `children` (chV) — the opt-out never
    // applies — so `?? []` is unreachable defensive modeling for the widened type.
  ) => buildCstNode(type, children ?? [], fields, span, rawChildren, triviaLog, state)
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
  grammar: LinkablePieces | Record<string, Combinator<unknown>>,
  names: string[],
): LinkablePieces {
  // A COMPOSED grammar (`compose([...])` result): it has no single rule map — its rules
  // live across several carried pieces. Materialize them under the composing trivia it
  // was built with (so the selection keeps composing-wins trivia), then filter across
  // pieces to `names` + their transitive dep closure, keeping each rule in the piece
  // that WINS it (compose override order = last wins). Return a composed-like value so a
  // downstream `compose([pick(composed, …)])` flattens it the same way.
  const carried = (grammar as Record<symbol, unknown>)[COMPOSED_PIECES]
  if (Array.isArray(carried)) {
    const trivia = (grammar as Record<symbol, unknown>)[COMPOSED_TRIVIA] as Combinator<unknown> | undefined
    const pieces = (carried as Array<LinkablePieces | IRPiece>).map(pc => materializePiece(pc, trivia))
    const filtered = pickPieces(pieces, names)
    // A composed-like value (carries COMPOSED_PIECES, no single rule map). It is only
    // ever consumed through compose()'s COMPOSED_PIECES branch — which is checked before
    // any LinkablePieces field — so this masquerades as LinkablePieces for the signature.
    const out: Record<string, unknown> = {}
    Object.defineProperty(out, COMPOSED_PIECES, { value: filtered, enumerable: false })
    if (trivia) Object.defineProperty(out, COMPOSED_TRIVIA, { value: trivia, enumerable: false })
    return out as unknown as LinkablePieces
  }

  const p = (grammar as LinkablePieces).ruleFns instanceof Map
    ? (grammar as LinkablePieces)
    : linkable(grammar as Record<string, Combinator<unknown>>)
  return pickPieces([p], names)[0] ?? { ...p, keys: [], ruleFns: new Map(), wrappers: new Map(), deps: new Map() }
}

/** Restrict a set of linkable pieces to `names` + their transitive dep closure,
 * keeping each surviving rule in the piece that WINS it (later piece wins, matching
 * compose override order). Shared by `pick()` (runtime) and the macro's build-time
 * `pick(...)` handling, so à-la-carte selection is identical on both paths. */
export function pickPieces(pieces: LinkablePieces[], names: string[]): LinkablePieces[] {
  const winner = new Map<string, LinkablePieces>()
  for (const pc of pieces) for (const k of pc.keys) winner.set(k, pc)
  // A requested name that isn't in the grammar is a typo — fail here, not later with a
  // confusing name-closure error at compose() time.
  for (const n of names) {
    if (!winner.has(n)) throw new Error(`pick: rule "${n}" is not in this grammar (available: ${[...winner.keys()].join(', ')})`)
  }
  const keep = new Set<string>()
  const visit = (n: string): void => {
    // A missing winner is an EXTERNAL dep (a base-grammar rule) — it resolves at
    // compose() time, not here. Top-level `names` were already validated above.
    const w = winner.get(n)
    if (keep.has(n) || !w) return
    keep.add(n)
    for (const d of w.deps.get(n) ?? []) visit(d)
  }
  for (const n of names) visit(n)
  const filt = <V>(m: Map<string, V>, pc: LinkablePieces): Map<string, V> =>
    new Map([...m].filter(([k]) => keep.has(k) && winner.get(k) === pc))
  return pieces
    .map(pc => ({ ...pc, keys: pc.keys.filter(k => keep.has(k) && winner.get(k) === pc), ruleFns: filt(pc.ruleFns, pc), wrappers: filt(pc.wrappers, pc), deps: filt(pc.deps, pc) }))
    .filter(pc => pc.keys.length > 0)
}

/**
 * Build the fused-closure body (shared by the runtime `fuseRules` and the
 * build-time `emitFusedSource`). Returns the closure body (which reads `_env`
 * for any non-inlined callbacks) and the `_env` to bind. In macro mode callbacks
 * are inlined from source, so `_env` is empty and the body is fully static.
 */
export function fusedBody(pieces: LinkablePieces[]): { body: string; env: Record<string, unknown> } {
  // ARTIFACT VERSION LOCK (see src/version.ts): a compiled artifact is fused by the
  // SAME parseman version that produced it — the artifact format carries no
  // cross-version back-compat. A serialized piece stamped with a different version is
  // stale; fail LOUDLY rather than silently mis-reading its recipe/pieces shape.
  // (Pieces with no stamp are hand-built test fixtures / same-version by construction.)
  for (const p of pieces) {
    if (p.v !== undefined && p.v !== PARSEMAN_VERSION) {
      throw new Error(
        `parseman: artifact "${p.ns}" was compiled with parseman ${p.v}, but is being fused with parseman ${PARSEMAN_VERSION}. ` +
        `Compiled grammar artifacts are version-locked — recompile the grammar with parseman ${PARSEMAN_VERSION}; parseman does not fuse across versions.`,
      )
    }
  }
  // Winner per rule name — later pieces override earlier ones.
  const winner = new Map<string, LinkablePieces>()
  for (const p of pieces) for (const k of p.keys) winner.set(k, p)

  // Name-closure check: every referenced rule must resolve in the fused set.
  for (const [k, p] of winner) {
    for (const d of p.deps.get(k) ?? []) {
      if (!winner.has(d)) throw new Error(`compose: rule "${k}" references missing rule "${d}"`)
    }
  }

  const contributing = new Set(winner.values())
  const contributingPieces = [...contributing]
  const needsEmptyTl = contributingPieces.some(p => p.needsEmptyTl)
  const needsHostReads = contributingPieces.some(p => p.needsHostReads)

  const lines: string[] = [
    // Shared sentinel protocol (must match NAMED_FN_FAIL / NAMED_FN_END in codegen).
    'const _pfFail = {}',
    'let _pfEnd',
    ...(needsEmptyTl ? ['const _EMPTY_TL = Object.freeze([])'] : []),
    ...(needsHostReads ? [HOST_READS_DECL] : []),
    // Each contributing artifact's namespaced private prelude (regexes, _pf, …).
    ...new Set(contributingPieces.flatMap(p => p.prelude)),
    // The winning `_r_<Name>` function for each rule (one per name → no redeclare).
    ...[...winner].map(([k, p]) => p.ruleFns.get(k)!),
  ]
  const wrapperEntries = [...winner].map(([k, p]) => `${JSON.stringify(k)}: ${p.wrappers.get(k)!}`)
  const rawBody = [...lines, 'return {', wrapperEntries.join(',\n'), '}'].join('\n')

  // Fuse-time first-set dispatch: a rule-ref choice arm was emitted (in linkable
  // mode) as `/*@FS:rule:codevar@*​/true`. Resolve it now against the WINNING rule's
  // LEADING first-set recipe — sound under override, since we use the final rule, not
  // the one visible when the referencing rule was compiled. Each rule's recipe is a
  // union of ordered leading-term chains; resolving them over the WINNING rules to a
  // fixpoint makes a `sequence(ref, …)`-led arm/node dispatch on the ref's real first
  // char (parity with a monolithic compile) instead of degrading to always-try
  // because the ref baked `any`. A genuinely unknown ref → `any` (always try).
  const ANY: FirstSet = { kind: 'any' }
  const EMPTY: FirstSet = { kind: 'empty' }
  const recipes = new Map<string, FirstSetRecipe>()
  const shallow = new Map<string, FirstSet>()
  const nullable = new Map<string, boolean>()
  for (const [k, p] of winner) {
    const r = p.firstSetRecipes?.get(k); if (r) recipes.set(k, r)
    const fs = p.firstSets?.get(k); if (fs) shallow.set(k, fs)
    const nu = p.nullable?.get(k); if (nu !== undefined) nullable.set(k, nu)
  }
  const knownRef = (ref: string): boolean => recipes.has(ref) || shallow.has(ref)
  // A referenced rule's resolved first-set (or `any` for a genuinely unknown ref —
  // always try). A ref whose nullability is unknown defaults to nullable (keep
  // unioning the chain tail — never drops a valid first char).
  const refFS = (ref: string): FirstSet => (knownRef(ref) ? (finalFS.get(ref) ?? ANY) : ANY)
  const refNullable = (ref: string): boolean => (knownRef(ref) ? (nullable.get(ref) ?? true) : true)
  // Resolve a recipe: union each ordered chain, and within a chain union each
  // segment's first-set left-to-right STOPPING after the first non-nullable segment
  // (its tail can't start the rule). A ref segment is skippable if it was forced so
  // at build (a wrapping optional/many → `seg.nullable`) OR the resolved rule is
  // itself nullable; only a definitely-consuming ref stops the chain.
  const resolveRecipe = (r: FirstSetRecipe): FirstSet => {
    let out: FirstSet = EMPTY
    for (const chain of r.alts) {
      for (const seg of chain) {
        out = union(out, seg.ref !== undefined ? refFS(seg.ref) : seg.set)
        const skippable = seg.ref !== undefined ? (seg.nullable || refNullable(seg.ref)) : seg.nullable
        if (!skippable) break
      }
    }
    return out
  }
  // Least-fixpoint: recipe-bearing rules start EMPTY and grow monotonically via
  // `resolveRecipe` (union of refs is monotone; the chain stop is static), so a
  // recursive rule converges to its tightest sound first-set. Rules with no recipe
  // keep their static shallow set.
  const finalFS = new Map<string, FirstSet>()
  for (const [k] of winner) finalFS.set(k, recipes.has(k) ? EMPTY : (shallow.get(k) ?? ANY))
  for (let iter = 0; iter <= recipes.size; iter++) {
    let changed = false
    for (const [k, r] of recipes) {
      const fs = resolveRecipe(r)
      if (JSON.stringify(finalFS.get(k)) !== JSON.stringify(fs)) { finalFS.set(k, fs); changed = true }
    }
    if (!changed) break
  }
  const body = rawBody.replace(
    // Rule name + code-point var are both JS identifiers (rule names are validated
    // at compile time — see assertRuleName in codegen), so an identifier class
    // matches every well-formed placeholder.
    /\/\*@FS:([A-Za-z0-9_$]+):([A-Za-z0-9_$]+)@\*\/true/g,
    (_m, name: string, codevar: string) => {
      const fs = finalFS.get(name)
      if (!fs || fs.kind === 'any' || fs.kind === 'empty') return 'true'
      return `(${firstSetCond(codevar, fs)})`
    },
  )

  // Non-inlined callbacks (runtime compile() mode), keyed `<ns>mf` / `<ns>build`.
  const env: Record<string, unknown> = {}
  for (const p of contributingPieces) {
    if (p.mfFns.length) env[`${p.ns}mf`] = p.mfFns
    if (p.buildFns.length) env[`${p.ns}build`] = p.buildFns
  }
  return { body, env }
}

/** Fuse at RUNTIME (via `new Function`) — used by `compose()` when not compiled
 * by the macro (like `compile()`). The macro path uses `emitFusedSource` instead. */
export function fuseRules(pieces: LinkablePieces[]): Record<string, FusedRule> {
  const { body, env } = fusedBody(pieces)
  // eslint-disable-next-line no-new-func
  return new Function('_env', body)(env) as Record<string, FusedRule>
}

/**
 * Fuse at BUILD time — emit the fused closure as a self-contained SOURCE
 * expression (`(() => { … })()`), with **no `new Function`**. This is what the
 * macro splices in for a `compose([...])` call, so macro output stays eval-free.
 * Requires every callback to be inlined from source (macro mode); throws if any
 * artifact carries runtime-only callback functions.
 */
export function emitFusedSource(pieces: LinkablePieces[]): string {
  const { body, env } = fusedBody(pieces)
  if (Object.keys(env).length > 0) {
    throw new Error('emitFusedSource: artifact carries non-static callbacks (runtime-only); cannot emit static source')
  }
  return `/* @__PURE__ */ (() => {\n${body}\n})()`
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
export type IRPiece = { ns: string; ir: string }

function isIRPiece(p: unknown): p is IRPiece {
  return !!p && typeof p === 'object'
    && typeof (p as IRPiece).ir === 'string' && typeof (p as IRPiece).ns === 'string'
    && !('ruleFns' in (p as object))
}

function coverageRulesOf(carried: Array<LinkablePieces | IRPiece>): Record<string, Combinator<unknown>> | undefined {
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

/** Materialize a carried item to full `LinkablePieces`: an IR piece is evaluated
 * back to a rule map and re-lowered; a full piece passes through. */
export function materializePiece(
  p: LinkablePieces | IRPiece,
  trivia?: Combinator<unknown>,
  captureTerminals = false,
): LinkablePieces {
  if (!isIRPiece(p)) return p
  const pieces = compileLinkable(evalRuleMapIR(p.ir), p.ns, {
    ...(trivia ? { trivia } : {}),
    ...(captureTerminals ? { captureTerminals: true } : {}),
  })
  if (!pieces) throw new Error(`compose: carried IR for ns "${p.ns}" could not be re-lowered`)
  return pieces
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
  item: LinkablePieces | Record<string, unknown>,
  used: Set<string>,
  trivia?: Combinator<unknown>,
): Array<LinkablePieces | IRPiece> {
  const carried = (item as Record<symbol, unknown>)[COMPOSED_PIECES]
  // A prior composed result (runtime or macro-compiled): its carried list is already
  // re-lowerable (IR pieces, plus any pre-compiled artifacts). Pass it through so THIS
  // compose re-lowers it under its own composing trivia. Reserve its namespaces so a
  // sibling grammar map can't collide with them.
  if (Array.isArray(carried)) {
    const items = carried as Array<LinkablePieces | IRPiece>
    for (const p of items) used.add(p.ns)
    return items
  }
  // A pre-compiled artifact (`linkable()`/`pick()`): no source to re-lower — its trivia
  // was baked when it was compiled. Keep it as-is.
  if ((item as LinkablePieces).ruleFns instanceof Map) {
    const p = item as LinkablePieces
    used.add(p.ns)
    return [p]
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
  const ir = serializeRuleMap(entries)
  return ir ? [{ ns, ir }] : [linkable(map, ns, trivia)]
}

/** The composed grammar's ambient trivia = the LAST composed item that declares a
 * grammar-level trivia (via `rules({ trivia }, …)`, which tags `grammarTrivia` on its
 * rules). Outermost wins: the composing grammar's trivia applies to every fused rule,
 * including those inherited from a base — so e.g. an SCSS `rw` (which extends Less's)
 * governs the inherited Less/CSS rules too. `parser`/`noTrivia` still override locally. */
function composingTriviaOf(items: Array<LinkablePieces | Record<string, unknown>>): Combinator<unknown> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Record<string, unknown> | undefined
    if (!item || (item as LinkablePieces).ruleFns instanceof Map || (item as Record<symbol, unknown>)[COMPOSED_PIECES]) continue
    for (const v of Object.values(item)) {
      const t = (v as Combinator<unknown> | undefined)?._meta?.grammarTrivia
      if (t) return t
    }
  }
  return undefined
}

export function compose(
  items: Array<LinkablePieces | Record<string, unknown>>,
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
  const carried = items.flatMap(item => itemCarried(item, used, trivia))
  const pieces = carried.map(p => materializePiece(p, trivia))
  const map = fuseRules(pieces)
  Object.defineProperty(map, COMPOSED_PIECES, { value: carried, enumerable: false })
  if (trivia) Object.defineProperty(map, COMPOSED_TRIVIA, { value: trivia, enumerable: false })
  const coverageRules = coverageRulesOf(carried)
  if (coverageRules) Object.defineProperty(map, COMPOSED_COVERAGE_RULES, { value: coverageRules, enumerable: false })
  return map
}

/**
 * Compose a terminal grammar. This is for a leaf parser that overlays local
 * semantic reductions on reusable recognition rules. It is macro-only: without
 * macro lowering there is no safe way to keep lexical builders out of carried
 * IR, so it fails rather than falling back to runtime composition.
 */
export function composeLeaf(
  _items: Array<LinkablePieces | Record<string, unknown>>,
): Record<string, FusedRule> {
  throw new Error('composeLeaf(): requires Parseman macro lowering; runtime composition is forbidden')
}
