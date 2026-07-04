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
 * collide; the sentinel protocol / `_EMPTY_TL` / `_collator` are shared and
 * emitted once.
 *
 * Uses `new Function` (like `compile()`), so it needs `'unsafe-eval'` under a
 * strict CSP; a build-time variant that emits fused source instead is a later
 * addition. Fusion runs ONCE at parser construction — parsing is then full speed.
 */
import { compileLinkable } from './codegen.ts'
import type { LinkablePieces } from './codegen.ts'
import type { Combinator } from '../types.ts'

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

/**
 * A generic positioned-CST build host (RULE_ABI_PLAN §7). Pass as `ctx.build`
 * (or `parseDoc(..., { build: cstBuildHost })`) to make ANY linkable/fused
 * grammar produce a uniform CST — `{ _tag:'node', type, span, state, children }`
 * — instead of its own eval-AST builders. This is the host the linter and IDE
 * drivers use; the eval driver leaves `ctx.build` unset (grammar's own builders).
 */
export function cstBuildHost(
  type: string,
  children: ReadonlyArray<unknown>,
  _rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
): unknown {
  return { _tag: 'node', type, span: { start: span.start, end: span.end }, state: null, children: [...children] }
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
  const visit = (n: string): void => {
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
 * Fuse linkable artifacts into one map of parse functions. Later artifacts win
 * per rule name (spread-order override). Throws if a surviving rule references a
 * name absent from the fused set (the compose-time name-closure check).
 */
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
  const needsEmptyTl = [...contributing].some(p => p.needsEmptyTl)
  const needsCollator = [...contributing].some(p => p.needsCollator)

  const lines: string[] = [
    // Shared sentinel protocol (must match NAMED_FN_FAIL / NAMED_FN_END in codegen).
    'const _pfFail = {}',
    'let _pfEnd',
    ...(needsEmptyTl ? ['const _EMPTY_TL = Object.freeze([])'] : []),
    ...(needsCollator ? ["const _collator = new Intl.Collator(undefined, { sensitivity: 'accent' })"] : []),
    // Each contributing artifact's namespaced private prelude (regexes, _pf, …).
    ...[...contributing].flatMap(p => p.prelude),
    // The winning `_r_<Name>` function for each rule (one per name → no redeclare).
    ...[...winner].map(([k, p]) => p.ruleFns.get(k)!),
  ]
  const wrapperEntries = [...winner].map(([k, p]) => `${JSON.stringify(k)}: ${p.wrappers.get(k)!}`)
  const body = [...lines, 'return {', wrapperEntries.join(',\n'), '}'].join('\n')

  // Non-inlined callbacks (runtime compile() mode), keyed `<ns>mf` / `<ns>build`.
  const env: Record<string, unknown> = {}
  for (const p of contributing) {
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
export function compose(
  items: Array<LinkablePieces | Record<string, Combinator<unknown>>>,
): Record<string, FusedRule> {
  const pieces = items.map(it =>
    (it as LinkablePieces).ruleFns instanceof Map
      ? (it as LinkablePieces)
      : linkable(it as Record<string, Combinator<unknown>>),
  )
  return fuseRules(pieces)
}
