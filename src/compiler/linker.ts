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
 * Restrict a linkable artifact to `names` plus their transitive rule-dependency
 * closure (à la carte selection). A picked rule pulls in every rule name it
 * references, so the result is always self-consistent within the artifact.
 */
export function pick(p: LinkablePieces, names: string[]): LinkablePieces {
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
export function fuseRules(pieces: LinkablePieces[]): Record<string, FusedRule> {
  // Winner per rule name — later pieces override earlier ones.
  const winner = new Map<string, LinkablePieces>()
  for (const p of pieces) for (const k of p.keys) winner.set(k, p)

  // Name-closure check: every referenced rule must resolve in the fused set.
  for (const [k, p] of winner) {
    for (const d of p.deps.get(k) ?? []) {
      if (!winner.has(d)) throw new Error(`fuseRules: rule "${k}" references missing rule "${d}"`)
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

  // Inject each artifact's transform/build callback FUNCTIONS (when they weren't
  // inlined from source — runtime `compile()` mode). Keyed `<ns>mf` / `<ns>build`.
  const env: Record<string, unknown> = {}
  for (const p of contributing) {
    if (p.mfFns.length) env[`${p.ns}mf`] = p.mfFns
    if (p.buildFns.length) env[`${p.ns}build`] = p.buildFns
  }

  // eslint-disable-next-line no-new-func
  return new Function('_env', body)(env) as Record<string, FusedRule>
}

/**
 * Compose linkable artifacts into a parser map — the extension entry point.
 * `compose([base, ext, …])`: later artifacts override earlier ones by rule name,
 * and because fusion re-binds every reference in one shared scope, an override
 * reroutes the base's OWN calls too (open recursion). The friendly name for
 * `fuseRules`.
 */
export const compose = fuseRules
