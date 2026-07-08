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
import { evalRuleMapIR } from './ir-serialize.ts'
import type { LinkablePieces } from './codegen.ts'
import type { BuildHost, Combinator, CstCollapsePredicate, FirstSet } from '../types.ts'

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
): LinkablePieces {
  const pieces = compileLinkable([...Object.entries(rulesMap)], ns ?? `_lk${_nsCounter++}_`)
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
  _rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
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
    return buildCstNode(typeOrOptions, children ?? [], rawChildren ?? [], span ?? { start: 0, end: 0 }, triviaLog, state)
  }
  const collapse = normalizeCstCollapse(typeOrOptions?.collapse)
  if (!collapse) return buildCstNode
  const host: BuildHost = (
    type: string,
    children: ReadonlyArray<unknown>,
    _fields: unknown,
    span: { start: number; end: number },
    rawChildren: ReadonlyArray<unknown>,
    triviaLog: readonly number[],
    state: unknown,
  ) => buildCstNode(type, children, rawChildren, span, triviaLog, state)
  if (collapse) host._parsemanCstCollapse = collapse
  return host
}

export type FusedRule = (
  input: string,
  pos: number,
  ctx: Record<string, unknown>,
) => { ok: boolean; value?: unknown; span: { start: number; end: number } }

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
  const p = (grammar as LinkablePieces).ruleFns instanceof Map
    ? (grammar as LinkablePieces)
    : linkable(grammar as Record<string, Combinator<unknown>>)
  const keep = new Set<string>()
  const has = new Set(p.keys)
  // A requested name that isn't in the grammar is a typo — fail here, not later
  // with a confusing name-closure error at compose() time.
  for (const n of names) {
    if (!has.has(n)) throw new Error(`pick: rule "${n}" is not in this grammar (available: ${p.keys.join(', ')})`)
  }
  const visit = (n: string): void => {
    // `!has.has(n)` skips EXTERNAL deps (rules from a base grammar) — they resolve
    // at compose() time, not here. Top-level `names` were already validated above.
    if (keep.has(n) || !has.has(n)) return
    keep.add(n)
    for (const d of p.deps.get(n) ?? []) visit(d)
  }
  for (const n of names) visit(n)
  const filt = <V>(m: Map<string, V>): Map<string, V> => new Map([...m].filter(([k]) => keep.has(k)))
  return {
    ...p,
    keys: [...keep],
    ruleFns: filt(p.ruleFns),
    wrappers: filt(p.wrappers),
    deps: filt(p.deps),
  }
}

/**
 * Build the fused-closure body (shared by the runtime `fuseRules` and the
 * build-time `emitFusedSource`). Returns the closure body (which reads `_env`
 * for any non-inlined callbacks) and the `_env` to bind. In macro mode callbacks
 * are inlined from source, so `_env` is empty and the body is fully static.
 */
function fusedBody(pieces: LinkablePieces[]): { body: string; env: Record<string, unknown> } {
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
    ...[...new Set(contributingPieces.flatMap(p => p.prelude))],
    // The winning `_r_<Name>` function for each rule (one per name → no redeclare).
    ...[...winner].map(([k, p]) => p.ruleFns.get(k)!),
  ]
  const wrapperEntries = [...winner].map(([k, p]) => `${JSON.stringify(k)}: ${p.wrappers.get(k)!}`)
  const rawBody = [...lines, 'return {', wrapperEntries.join(',\n'), '}'].join('\n')

  // Fuse-time first-set dispatch: a rule-ref choice arm was emitted (in linkable
  // mode) as `/*@FS:rule:codevar@*​/true`. Resolve it now against the WINNING
  // rule's first-set — sound under override, since we use the final rule, not the
  // one visible when the referencing rule was compiled. Unknown / `any` /
  // empty-matching rule → leave `true` (always try the arm; correctness over
  // pruning). Non-composed callers with no `firstSets` table also fall through.
  const finalFS = new Map<string, FirstSet>()
  for (const [k, p] of winner) { const fs = p.firstSets?.get(k); if (fs) finalFS.set(k, fs) }
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

/** The compact IR form a grammar carries instead of its lowered rule source: the
 * combinator-construction expression, re-lowered here at fuse time. */
export type IRPiece = { ns: string; ir: string }

function isIRPiece(p: unknown): p is IRPiece {
  return !!p && typeof p === 'object'
    && typeof (p as IRPiece).ir === 'string' && typeof (p as IRPiece).ns === 'string'
    && !('ruleFns' in (p as object))
}

/** Materialize a carried item to full `LinkablePieces`: an IR piece is evaluated
 * back to a rule map and re-lowered; a full piece passes through. */
export function materializePiece(p: LinkablePieces | IRPiece): LinkablePieces {
  if (!isIRPiece(p)) return p
  const pieces = compileLinkable(evalRuleMapIR(p.ir), p.ns)
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

function itemPieces(item: LinkablePieces | Record<string, unknown>, used: Set<string>): LinkablePieces[] {
  const carried = (item as Record<symbol, unknown>)[COMPOSED_PIECES]
  // A macro-compiled grammar carries its ancestors as live spreads off the imported
  // bindings and its own rules as compact IR — `[...cssGrammar[COMPOSED_PIECES],
  // {ns, ir}]`. At runtime the array is already expanded (live imports); each entry
  // is re-lowered from IR to full pieces here.
  const pieces = Array.isArray(carried)
    ? (carried as Array<LinkablePieces | IRPiece>).map(materializePiece)
    : (item as LinkablePieces).ruleFns instanceof Map
      ? [item as LinkablePieces]
      : [linkable(item as Record<string, Combinator<unknown>>, nextComposeNs(used))]
  for (const p of pieces) used.add(p.ns)
  return pieces
}

export function compose(
  items: Array<LinkablePieces | Record<string, unknown>>,
): Record<string, FusedRule> {
  const used = new Set<string>()
  const pieces = items.flatMap(item => itemPieces(item, used))
  const map = fuseRules(pieces)
  Object.defineProperty(map, COMPOSED_PIECES, { value: pieces, enumerable: false })
  return map
}
