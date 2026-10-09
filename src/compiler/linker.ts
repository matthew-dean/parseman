/**
 * The linker: compose grammar pieces into ONE rule map.
 *
 * At RUNTIME, composition is linking and nothing else. Every piece's `rules()`
 * factory runs again against one shared namespace (`linkRules`), a later piece's
 * name winning, so an override reroutes every call to it — a base piece's own calls
 * included (open recursion) — and the result is the interpreter grammar one `rules()`
 * over all the pieces would build. No table, no source text, no `eval`, and no piece
 * is mutated (docs/design/runtime-and-size-contract.md, rules 1 and 2).
 *
 * At BUILD time the macro plugin composes instead: it re-lowers each piece's carried
 * IR and encodes the merged map once into a static table.
 */
import { ruleDependencies } from '../analysis/gating.ts'
import { FUSED_HOST_MODE, FUSED_HOST_ELIDED, type HostMode } from '../cst/host-mode.ts'
import { compileLinkableTable, type LinkableTable } from './compile-linkable-table.ts'
import { GRAMMAR_REFLECTION } from '../cst/reflection.ts'
import { linkRules, RULE_ORDER, RULES_RECIPE, type LinkOptions, type RulesRecipe } from '../combinators/parser.ts'
import type { BuildHost, Combinator, CstCollapsePredicate, ParseContext, ParseResult } from '../types.ts'
import type { Runnable } from '../functional/run.ts'

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
  // A runtime artifact of a `rules()` grammar keeps its recipe, so a runtime
  // `compose()` links it like the grammar itself.
  const recipes = (rulesMap as Record<symbol, unknown>)[RULES_RECIPE]
  if (Array.isArray(recipes)) Object.defineProperty(piece, RULES_RECIPE, { value: recipes, enumerable: false })
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

/** The carried pieces a BUILD-compiled (`compose()` under the macro) grammar
 * holds: its pieces as serialized IR, re-lowered by the macro plugin at build
 * time. A runtime composition carries recipes instead (`RULES_RECIPE`). */
export const COMPOSED_PIECES = Symbol.for('parseman.composedPieces')

/** The carried pieces a build-compiled composed grammar holds, or `undefined`
 * when the value is not one. */
export function composedPiecesOf(
  grammar: Record<string, unknown>,
): ReadonlyArray<LinkableTable | IRPiece> | undefined {
  const pieces = (grammar as unknown as Record<symbol, unknown>)[COMPOSED_PIECES]
  return Array.isArray(pieces) ? pieces as ReadonlyArray<LinkableTable | IRPiece> : undefined
}

/**
 * A terminal composed grammar may be used to run a parser, but not as an input to
 * another composition. Macro `composeLeaf()` uses this for a local semantic
 * reduction over imported recognition-only IR: the local reductions stay in
 * their lexical module and therefore never become carried IR.
 */
const LEAF_COMPOSED = Symbol.for('parseman.leafComposed')

/** The composing trivia a runtime `compose()` applied, so a LATER composition
 * that declares none of its own keeps it (composing-wins survives re-composition). */
const COMPOSED_TRIVIA = Symbol.for('parseman.composedTrivia')

/** Marks a runtime composition: a lazily linked interpreter map over recipes. */
const LINKED = Symbol.for('parseman.linkedComposition')

/** The compact IR form a build-compiled grammar carries: the combinator-construction
 * expression, re-lowered by the macro plugin at build time. */
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

/**
 * The live combinator map behind a carried piece, or `undefined` when it has none.
 *
 * NEVER FROM IR. Carried IR is JavaScript source — reducers, gates and builders
 * included — and rebuilding it means `eval`, which runs nowhere at runtime outside
 * `compile()` (docs/design/runtime-and-size-contract.md, rule 1). The macro plugin
 * re-lowers IR at build time, in the bundler. At runtime an IR-only piece is opaque,
 * and every caller reports it as such.
 */
function ruleMapOfCarried(p: LinkableTable | IRPiece): Array<[string, Combinator<unknown>]> | undefined {
  if (isIRPiece(p)) return undefined
  return p.ruleMap.length > 0 ? p.ruleMap.map(([k, v]) => [k, v] as [string, Combinator<unknown>]) : undefined
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

/** `carriedRuleMaps` plus the pieces it could NOT recover, named by namespace and
 * rule count, so a caller can report exactly how much of the grammar went unseen. */
export function carriedRuleMapsDetailed(
  carried: ReadonlyArray<LinkableTable | IRPiece>,
): { maps: Array<Array<[string, Combinator<unknown>]>>; opaque: Array<{ ns: string; ruleNames: string[] }> } {
  const maps: Array<Array<[string, Combinator<unknown>]>> = []
  const opaque: Array<{ ns: string; ruleNames: string[] }> = []
  for (const p of carried) {
    const rules = ruleMapOfCarried(p)
    if (rules !== undefined) { maps.push(rules); continue }
    opaque.push({ ns: p.ns, ruleNames: isIRPiece(p) ? [] : [...p.keys] })
  }
  return { maps, opaque }
}

/**
 * Recover the override-winner COMBINATOR map behind a BUILD-compiled composed
 * grammar, plus the pieces that could not be recovered. A runtime composition is
 * already a combinator map, so this returns `undefined` for it, exactly as for a
 * plain `rules()` map: walk it directly.
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

/** The final override-winner combinator map of a runtime composition, or
 * `undefined` for anything else. INTERNAL: coverage tooling only. */
export function composedCoverageRules(grammar: Record<string, unknown>): Record<string, Combinator<unknown>> | undefined {
  const link = (grammar as Record<symbol, unknown>)[LINKED] as (() => Record<string, Combinator<unknown>>) | undefined
  return link?.()
}

/** Each runtime composition's rules, mapped to the linked map they belong to. */
const LINKED_WINNERS = new WeakMap<Combinator<unknown>, Record<string, Combinator<unknown>>>()

/** The linked winner map a runtime composition's rule belongs to, or `undefined`.
 * Lets a coverage run over ONE composed rule name its choices exactly as
 * `composedGrammarCoverageDefinitions` does. INTERNAL: coverage tooling only. */
export function linkedWinnersOf(rule: Combinator<unknown>): Record<string, Combinator<unknown>> | undefined {
  return LINKED_WINNERS.get(rule)
}

/** The recipes one `compose()` item contributes, in order. */
function recipesOf(item: LinkableTable | Record<string, unknown>): readonly RulesRecipe[] {
  const recipes = (item as Record<symbol, unknown>)[RULES_RECIPE]
  if (Array.isArray(recipes)) return recipes as RulesRecipe[]
  const what = isLinkableTable(item) ? `the table artifact "${item.ns}"`
    : composedPiecesOf(item as Record<string, unknown>) !== undefined ? 'a build-compiled compose() result'
      : 'a value that is not a rules() grammar'
  throw new Error(
    `compose: ${what} has no live rules to link. At runtime compose() links interpreter grammars — `
    + 'rules() maps and runtime compose() results — and never evaluates carried IR or source text. '
    + 'Compose compiled grammars at build time (the parseman macro does), or compose the interpreter builds of both.',
  )
}

/** The composed grammar's ambient trivia = the LAST item that declares one: a
 * `rules({ trivia }, …)` map's own, or a runtime composition's composing trivia.
 * Outermost wins over every linked rule, inherited ones included; `parser` /
 * `noTrivia` still override locally. */
function composingTriviaOf(items: Array<LinkableTable | Record<string, unknown>>): Combinator<unknown> | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as Record<symbol, unknown>
    if (item[LINKED] !== undefined) {
      const stamped = item[COMPOSED_TRIVIA] as Combinator<unknown> | undefined
      if (stamped) return stamped
      continue
    }
    const recipes = item[RULES_RECIPE] as readonly RulesRecipe[] | undefined
    const trivia = recipes?.[recipes.length - 1]?.options?.trivia
    if (trivia != null) return trivia
  }
  return undefined
}

/** The rule names a linked composition defines, in first-declaration order —
 * known WITHOUT linking, from each item's own declaration order. */
function declaredNamesOf(items: Array<LinkableTable | Record<string, unknown>>): string[] {
  const names = new Set<string>()
  for (const item of items) {
    const linked = (item as Record<symbol, unknown>)[LINKED] !== undefined
    // A `linkable()` artifact names its rules in `keys`; its own fields are not rules.
    const order = linked ? Object.keys(item)
      : isLinkableTable(item) ? item.keys
        : (item as Record<string, unknown>)[RULE_ORDER] as readonly string[] | undefined
    for (const name of order ?? Object.keys(item)) names.add(name)
  }
  return [...names]
}

/** Link recipes into one interpreter map, refusing a name nobody defines. */
function linkComposition(
  recipes: readonly RulesRecipe[],
  link: LinkOptions,
): Record<string, Combinator<unknown>> {
  const map = linkRules(recipes, link)
  const missing: string[] = []
  for (const [name, rule] of Object.entries(map)) {
    if (rule._def.tag !== 'lazy') continue
    try { rule._def.thunk() } catch { missing.push(name) }
  }
  if (missing.length > 0) {
    const holes = new Set(missing)
    for (const [name, deps] of ruleDependencies(Object.entries(map).filter(([n]) => !holes.has(n)))) {
      for (const dep of deps) if (holes.has(dep)) throw new Error(`compose: rule "${name}" references missing rule "${dep}"`)
    }
    throw new Error(`compose: rule(s) ${missing.map(n => `"${n}"`).join(', ')} are referenced but defined by no composed grammar`)
  }
  for (const rule of Object.values(map)) LINKED_WINNERS.set(rule, map)
  // The linked map is itself a composition: it composes again, and says so.
  Object.defineProperty(map, RULES_RECIPE, { value: recipes, enumerable: false })
  Object.defineProperty(map, LINKED, { value: () => map, enumerable: false })
  if (link.trivia) Object.defineProperty(map, COMPOSED_TRIVIA, { value: link.trivia, enumerable: false })
  return map
}

/**
 * Compose grammars into ONE parser map — the only public composition entry point.
 * `compose([base, ext, …])`: a later entry's rule WINS by name, and because every
 * piece is linked against one namespace, an override reroutes the base's OWN calls
 * too (open recursion).
 *
 * UNDER THE MACRO, `compose([...])` is lowered at BUILD time to a static table.
 *
 * AT RUNTIME it only links (docs/design/runtime-and-size-contract.md, rule 2):
 * every piece's `rules()` factory runs again against one shared namespace, so the
 * result is exactly the interpreter grammar one `rules()` over all the pieces would
 * build. It builds no table, evaluates no source and mutates no piece. Linking is
 * LAZY — the first read of a rule links the whole map once — so `compose()` itself
 * costs a walk of the items' declared names. For speed, `compile()` a rule of it;
 * `compile()` specialises when the environment allows and falls back under CSP.
 */
export function compose(
  items: Array<LinkableTable | Record<string, unknown>>,
  /**
   * Host mode for the composed grammar, same meaning as `compile(g, { hostMode })`.
   * The interpreter routes by host at parse time; this records `'cst'` on every rule
   * so `run()` can refuse a mismatched host instead of building the wrong tree.
   */
  opts?: { hostMode?: HostMode },
): Record<string, Runnable> {
  if (items.some(item => (item as Record<symbol, unknown>)[LEAF_COMPOSED] === true)) {
    throw new Error('compose: a composeLeaf() result is terminal and cannot be composed again')
  }
  return linkedMap(items, opts, false)
}

function linkedMap(
  items: Array<LinkableTable | Record<string, unknown>>,
  opts: { hostMode?: HostMode } | undefined,
  leaf: boolean,
): Record<string, Runnable> {
  const recipes = items.flatMap(recipesOf)
  const trivia = composingTriviaOf(items)
  const names = declaredNamesOf(items)
  let linked: Record<string, Combinator<unknown>> | undefined
  const link = (): Record<string, Combinator<unknown>> =>
    (linked ??= linkComposition(recipes, { trivia, ...(opts?.hostMode === undefined ? {} : { hostMode: opts.hostMode }) }))
  // One accessor per rule, installed once here and never per parse: the first read
  // links the whole map, every later read is a cached lookup. (Invariant allowlist:
  // INV-1:src/compiler/linker.ts:linkedMap.)
  const map: Record<string, unknown> = {}
  for (const name of names) {
    Object.defineProperty(map, name, { enumerable: true, configurable: true, get: () => link()[name] })
  }
  Object.defineProperty(map, RULES_RECIPE, { value: recipes, enumerable: false })
  Object.defineProperty(map, RULE_ORDER, { value: names, enumerable: false })
  Object.defineProperty(map, LINKED, { value: link, enumerable: false })
  Object.defineProperty(map, GRAMMAR_REFLECTION, { enumerable: false, configurable: true, get: () => link()[GRAMMAR_REFLECTION as never] })
  if (trivia) Object.defineProperty(map, COMPOSED_TRIVIA, { value: trivia, enumerable: false })
  if (leaf) Object.defineProperty(map, LEAF_COMPOSED, { value: true, enumerable: false })
  return map as Record<string, Runnable>
}

/**
 * Compose a TERMINAL grammar: a leaf parser that overlays local semantic reductions
 * on reusable recognition rules. Under the macro it lowers to a static table exactly
 * like `compose()` and must: there is no runtime codegen fallback.
 *
 * At runtime it is the same lazy link as `compose()`, marked terminal. The bench and
 * differential harnesses import un-macro'd grammar modules and run this path.
 */
export function composeLeaf(
  items: Array<LinkableTable | Record<string, unknown>>,
): Record<string, Runnable> {
  return linkedMap(items, undefined, true)
}

/** Whether `map` is a runtime composition (a combinator map) rather than a
 * build-compiled one (a table). INTERNAL — diagnostics only. */
export function isInterpretedFuse(map: object): boolean {
  return (map as Record<symbol, unknown>)[LINKED] !== undefined
}

/**
 * The linked interpreter map for a composition, as plain combinators — what
 * diagnostics and profiling walk. The same link `compose()` makes, forced now.
 * INTERNAL: not re-exported from `src/index.ts`.
 */
export function fuseInterpreted(
  items: Array<LinkableTable | Record<string, unknown>>,
  opts?: { hostMode?: HostMode },
): Record<string, Combinator<unknown>> {
  const map = linkedMap(items, opts, false)
  return (map as unknown as Record<symbol, () => Record<string, Combinator<unknown>>>)[LINKED]!()
}
