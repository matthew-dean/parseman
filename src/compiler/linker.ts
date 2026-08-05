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
import { compileLinkable, firstSetCond, ruleDependencies, HOST_READS_DECL, RAW_ENTRY_DECL } from './codegen.ts'
import { FUSED_HOST_MODE, FUSED_HOST_ELIDED, type HostMode } from '../cst/host-mode.ts'
import { evalRuleMapIR, serializeRuleMap } from './ir-serialize.ts'
import type { LinkablePieces, FirstSetRecipe } from './codegen.ts'
import { union } from '../combinators/first-set.ts'
import { PARSEMAN_VERSION } from '../version.ts'
import type { BuildHost, Combinator, CstCollapsePredicate, FirstSet, ParseContext, ParseResult } from '../types.ts'
import { grammarReflectionSource, mergeGrammarReflections } from '../cst/reflection.ts'
import type { ModuleHoist } from './module-hoist.ts'

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
): LinkablePieces {
  const pieces = compileLinkable(
    Object.entries(rulesMap),
    ns ?? `_lk${_nsCounter++}_`,
    { ...(trivia ? { trivia } : {}), ...(hostMode ? { hostMode } : {}) },
  )
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
    .map(pc => ({ ...pc, keys: pc.keys.filter(k => keep.has(k) && winner.get(k) === pc), ruleFns: filt(pc.ruleFns, pc), wrappers: filt(pc.wrappers, pc), deps: filt(pc.deps, pc), nodeMeta: filt(pc.nodeMeta, pc) }))
    .filter(pc => pc.keys.length > 0)
}

/**
 * Build the fused-closure body (shared by the runtime `fuseRules` and the
 * build-time `emitFusedSource`). Returns the closure body (which reads `_env`
 * for any non-inlined callbacks) and the `_env` to bind. In macro mode callbacks
 * are inlined from source, so `_env` is empty and the body is fully static.
 */
export function fusedBody(pieces: LinkablePieces[], hoist?: ModuleHoist): { body: string; env: Record<string, unknown> } {
  // ARTIFACT VERSION LOCK (see src/version.ts): a compiled artifact is fused by the
  // SAME parseman version that produced it — the artifact format carries no
  // cross-version back-compat. Reject BOTH a version MISMATCH and an UNSTAMPED piece
  // (a pre-0.32 artifact predates the invariant → its recipe/pieces shape is
  // unsupported): fail LOUDLY rather than silently mis-reading a stale shape. Every
  // artifact `compileLinkable` produces is stamped, so an absent stamp means a stale
  // serialized artifact, not a current one.
  for (const p of pieces) {
    if (p.v === undefined) {
      throw new Error(
        `parseman: artifact "${p.ns}" is UNSTAMPED (compiled before the version-lock invariant). ` +
        `Recompile the grammar with parseman ${PARSEMAN_VERSION}; parseman does not fuse unversioned or cross-version artifacts.`,
      )
    }
    if (p.v !== PARSEMAN_VERSION) {
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
  const needsRawEntry = contributingPieces.some(p => p.needsRawEntry)

  const lines: string[] = [
    // Shared sentinel protocol (must match NAMED_FN_FAIL / NAMED_FN_END in codegen).
    'const _pfFail = {}',
    'let _pfEnd',
    ...(needsEmptyTl ? ['const _EMPTY_TL = Object.freeze([])'] : []),
    ...(needsHostReads ? [HOST_READS_DECL] : []),
    ...(needsRawEntry ? [RAW_ENTRY_DECL] : []),
    // Each contributing artifact's namespaced private prelude (regexes, _pf, …).
    ...new Set(contributingPieces.flatMap(p => p.prelude)),
    // The winning `_r_<Name>` function for each rule (one per name → no redeclare).
    ...[...winner].map(([k, p]) => p.ruleFns.get(k)!),
  ]
  const wrapperEntries = [...winner].map(([k, p]) => `${JSON.stringify(k)}: ${p.wrappers.get(k)!}`)
  const reflection = mergeGrammarReflections([...winner].map(([k, p]) => p.nodeMeta.get(k) ?? { nodes: [] }))
  // The host-mode stamp is emitted INTO the body rather than applied afterwards by the
  // caller, so the runtime fuse (`fuseRules`) and the build-time fuse
  // (`emitFusedSource`) cannot disagree about it. They have drifted on exactly this
  // kind of change before, and an unstamped macro artifact is invisible to
  // `assertHostModeCompatible` — it reads `elided: false` and passes, which is the
  // silent wrong output the whole mechanism exists to prevent.
  const { mode, elided } = hostModeOfPieces(pieces)
  const tailSrc = [
    'const _map = {',
    wrapperEntries.join(',\n'),
    '}',
    `Object.defineProperty(_map, Symbol.for(${JSON.stringify(FUSED_HOST_MODE.description!)}), { value: ${JSON.stringify(mode)}, enumerable: false })`,
    `Object.defineProperty(_map, Symbol.for(${JSON.stringify(FUSED_HOST_ELIDED.description!)}), { value: ${JSON.stringify(elided)}, enumerable: false })`,
    `Object.defineProperty(_map, Symbol.for('parseman.grammarReflection'), { value: ${grammarReflectionSource(reflection)}, enumerable: false })`,
    // …and on each rule FUNCTION, because `run(map.Rule, …)` is handed the rule, not the
    // map, and would otherwise have nothing to check against. Done once at fuse time,
    // before any rule has been called, so it costs nothing per parse.
    'for (const _k of Object.keys(_map)) {',
    `  Object.defineProperty(_map[_k], Symbol.for(${JSON.stringify(FUSED_HOST_MODE.description!)}), { value: ${JSON.stringify(mode)}, enumerable: false })`,
    `  Object.defineProperty(_map[_k], Symbol.for(${JSON.stringify(FUSED_HOST_ELIDED.description!)}), { value: ${JSON.stringify(elided)}, enumerable: false })`,
    '}',
    'return _map',
  ].join('\n')
  const rawBody = [...lines, tailSrc].join('\n')

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
  const resolveFS = (src: string): string => src.replace(
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
  // Placeholders never span a line, so resolving the declarations one at a time is
  // identical to resolving the joined body — and it has to happen BEFORE the hoist
  // claims them, or two variants whose dispatch conditions resolve the same way
  // would still be compared as different text.
  const body = hoist === undefined
    ? resolveFS(rawBody)
    : [...hoist.claim(lines.map(resolveFS)), resolveFS(tailSrc)].join('\n')

  // Non-inlined callbacks (runtime compile() mode), keyed `<ns>mf` / `<ns>build`.
  const env: Record<string, unknown> = {}
  for (const p of contributingPieces) {
    if (p.mfFns.length) env[`${p.ns}mf`] = p.mfFns
    if (p.buildFns.length) env[`${p.ns}build`] = p.buildFns
  }
  return { body, env }
}

/**
 * The host mode a fusion of these pieces lowers to, and whether any of them dropped a
 * direct builder's positioned-CST branch. Shared by BOTH fuses via `fusedBody`, so the
 * runtime and build-time engines cannot label the same artifact differently.
 *
 * A MIXED fusion is the one way the per-parse host check could be defeated. Carried IR
 * re-lowers under this compose's mode, but a piece that arrived ALREADY COMPILED
 * (`linkable()` / `pick()` / a macro artifact) keeps the mode it was built with — so a
 * 'cst' fusion can contain an 'ast' piece whose direct builders dropped their host
 * branch. The map would be labeled 'cst', `assertHostModeCompatible` would pass, and
 * that piece would hand AST-shaped objects into a positioned CST: precisely the silent
 * wrong output this whole mechanism exists to prevent. Reject it here, where both facts
 * are still in hand.
 */
function hostModeOfPieces(pieces: LinkablePieces[]): { mode: HostMode; elided: boolean } {
  const mode = pieces.find(p => p.hostMode !== undefined && p.hostMode !== 'ast')?.hostMode ?? 'ast'
  const elided = pieces.filter(p => p.hostBranchElided === true)
  if (mode === 'cst' && elided.length > 0) {
    throw new Error(
      `compose: cannot build a positioned-CST artifact from pieces that were `
        + `compiled for host mode "ast" — ${elided.map(p => `"${p.ns}"`).join(', ')} `
        + `${elided.length === 1 ? 'dropped its' : 'dropped their'} direct builders' CST branch, `
        + `so ${elided.length === 1 ? 'it' : 'they'} would return AST objects inside the CST. `
        + `An already-compiled piece keeps the mode it was built with; only pieces carried as `
        + `IR are re-lowered by this compose. Re-compile ${elided.length === 1 ? 'it' : 'them'} `
        + `with hostMode: 'cst', or pass the source grammar so it can be re-lowered.`,
    )
  }
  return { mode, elided: elided.length > 0 }
}

/** Fuse at RUNTIME (via `new Function`) — used by `compose()` when not compiled
 * by the macro (like `compile()`). The macro path uses `emitFusedSource` instead.
 * Both stamp the host mode from inside `fusedBody`; see `hostModeOfPieces`. */
export function fuseRules(pieces: LinkablePieces[]): Record<string, FusedRule> {
  const { body, env } = fusedBody(pieces)
  // eslint-disable-next-line no-new-func
  return new Function('_env', body)(env) as Record<string, FusedRule>
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
 * Fuse at BUILD time — emit the fused closure as a self-contained SOURCE
 * expression (`(() => { … })()`), with **no `new Function`**. This is what the
 * macro splices in for a `compose([...])` call, so macro output stays eval-free.
 * Requires every callback to be inlined from source (macro mode); throws if any
 * artifact carries runtime-only callback functions.
 */
export function emitFusedSource(pieces: LinkablePieces[], hoist?: ModuleHoist): string {
  const { body, env } = fusedBody(pieces, hoist)
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

/** The carried pieces a `compose()`/`composeLeaf()` result holds, or `undefined` when
 * the value is not a composed grammar. This is what makes a fused grammar analysable:
 * the pieces are re-lowerable IR even though the fused map itself is only functions. */
export function composedPiecesOf(
  grammar: Record<string, unknown>,
): ReadonlyArray<LinkablePieces | IRPiece> | undefined {
  const pieces = (grammar as unknown as Record<symbol, unknown>)[COMPOSED_PIECES]
  return Array.isArray(pieces) ? pieces as ReadonlyArray<LinkablePieces | IRPiece> : undefined
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
    && !('ruleFns' in (p as object))
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
export function carriedRuleMaps(carried: ReadonlyArray<LinkablePieces | IRPiece>): Array<Array<[string, Combinator<unknown>]>> {
  return carriedRuleMapsDetailed(carried).maps
}

/** `carriedRuleMaps` plus the pieces it could NOT re-lower, named by namespace and
 * rule count, so a caller can report exactly how much of the grammar went unseen. */
export function carriedRuleMapsDetailed(
  carried: ReadonlyArray<LinkablePieces | IRPiece>,
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
  hostMode?: HostMode,
): LinkablePieces {
  // A piece carried as IR is RE-LOWERED here, which is what lets `compose()` choose the
  // host mode: the same carried grammar can be fused into an eval-AST artifact and into
  // a positioned-CST one. An already-lowered piece keeps whatever mode it was built
  // with — that is why `compose({ hostMode: 'cst' })` only works on carried IR.
  if (!isIRPiece(p)) return p
  const pieces = compileLinkable(evalRuleMapIR(p.ir), p.ns, {
    ...(trivia ? { trivia } : {}),
    ...(captureTerminals ? { captureTerminals: true } : {}),
    ...(hostMode ? { hostMode } : {}),
    ...(p.trackLines ? { trackLines: true } : {}),
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
  // Only reaches the non-serializable fallback below, where the grammar is baked
  // immediately instead of carried as re-lowerable IR. The IR path gets the mode later,
  // in `materializePiece`.
  hostMode?: HostMode,
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
  const pieces = carried.map(p => materializePiece(p, trivia, false, opts?.hostMode))
  const map = fuseRules(pieces)
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
  items: Array<LinkablePieces | Record<string, unknown>>,
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
function interpretedPieces(item: LinkablePieces | Record<string, unknown>): FusePiece[] {
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
  if ((item as LinkablePieces).ruleFns instanceof Map) {
    throw new Error('fuseInterpreted: a precompiled linkable artifact has no combinator graph to interpret; pass the source grammar (a rules() map) instead')
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
  items: Array<LinkablePieces | Record<string, unknown>>,
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
