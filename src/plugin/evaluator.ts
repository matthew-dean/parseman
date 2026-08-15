/**
 * Statically evaluates parseman combinator call expressions from an oxc AST
 * into actual Combinator<unknown> objects by calling the real library functions.
 *
 * Returns null for anything unresolvable (external variables, template literals,
 * computed keys, etc.) — callers leave those as-is.
 */
import type {
  Expression, Node,
  ArrowFunctionExpression, Function as OxcFunction,
  ReturnStatement,
  VariableDeclaration, VariableDeclarator,
  StaticMemberExpression,
  ObjectExpression, ObjectProperty,
} from '@oxc-project/types'
import type { Combinator } from '../types.ts'
import type { DispatchArm } from '../combinators/dispatch.ts'
import { ref } from '../combinators/ref.ts'
import { rules, type RulesOptions } from '../combinators/parser.ts'
import * as parseman from '../index.ts'
import { directBuilderBindings } from './direct-builder-static.ts'
import type { ReducerResolver } from './reducer-resolver.ts'

/**
 * Emit an AST subtree's source with TypeScript-only syntax removed. A gate source
 * is sliced verbatim from the grammar's `.ts` and may carry a type annotation (e.g.
 * `(s: any) => …`, unavoidable for a gate under a `g: any` factory with
 * noImplicitAny). Where the macro INLINES the source, downstream TS→JS transpilation
 * strips that — but a gated choice also round-trips through the `serializeRuleMap`
 * IR string, which is re-lowered with `new Function` VERBATIM, where TS syntax is a
 * hard parse error. So blank out every TS-only span (param/return/variable type
 * annotations, generic type args, and `as`/`satisfies`/`!` cast suffixes) using the
 * spans the oxc parser already gave us — no extra transpiler dependency. A subtree
 * with no TS syntax (every existing untyped callback) is returned byte-for-byte, so
 * standalone codegen output is unchanged.
 */
function stripTsFromSource(node: Node, code: string): string {
  const cuts: Array<[number, number]> = []
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const rec = n as Record<string, unknown> & { type?: string; start?: number; end?: number; expression?: { start?: number; end?: number } }
    // A whole TS-only node (a type annotation, type-argument list, etc.): drop it.
    if (typeof rec.type === 'string' && rec.type.startsWith('TS') && typeof rec.start === 'number' && typeof rec.end === 'number') {
      const ex = rec.expression
      // SUFFIX wrappers keep their expression; only the trailing TS is dropped:
      // `x as T` / `x satisfies T` / `x!` (after the expression) and `f<T>` (the
      // `<T>` type-argument list after the callee expression).
      if ((rec.type === 'TSAsExpression' || rec.type === 'TSSatisfiesExpression' || rec.type === 'TSNonNullExpression' || rec.type === 'TSInstantiationExpression') && ex && typeof ex.end === 'number') {
        cuts.push([ex.end, rec.end])
        walk(rec.expression)
        return
      }
      // PREFIX wrapper: `<T>x` (angle-bracket assertion) — cut the leading `<T>`,
      // keep the wrapped expression.
      if (rec.type === 'TSTypeAssertion' && ex && typeof ex.start === 'number') {
        cuts.push([rec.start, ex.start])
        walk(rec.expression)
        return
      }
      // Everything else (annotations, bare type-argument lists) is dropped whole.
      cuts.push([rec.start, rec.end])
      return
    }
    for (const key of Object.keys(rec)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const v = rec[key]
      if (Array.isArray(v)) { for (const item of v) walk(item) }
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(node)
  const start = (node as { start: number }).start
  const end = (node as { end: number }).end
  if (cuts.length === 0) return code.slice(start, end)
  cuts.sort((a, b) => a[0] - b[0])
  let out = ''
  let cur = start
  for (const [s, e] of cuts) {
    if (s < cur) continue // nested cut already covered
    out += code.slice(cur, s)
    cur = e
  }
  return out + code.slice(cur, end)
}

/**
 * The stand-in for a `withCtx(extra, …)` argument the macro could not evaluate.
 *
 * It is a CLASS INSTANCE on purpose. `{}` would be indistinguishable from an
 * author's own empty state object, so the table encoder would intern it, print
 * it, and ship a grammar whose every state gate is silently false. A non-plain
 * prototype fails `emittableConst`, which is what turns "we don't know the state"
 * into a named `runtimeOnly` refusal instead of a wrong artifact.
 */
class UnevaluatedExtra {}
const UNEVALUATED_EXTRA: unknown = new UnevaluatedExtra()

// ---------------------------------------------------------------------------
// Reducer resolution
//
// `buildSrc` is the source text of the EXPRESSION at the `node(...)` call site, so a
// reducer passed as a bare identifier — `node('Foo', p, { build: foldOperation })` —
// arrives as the string `"foldOperation"`. That matches no parameter list, so
// `confirmedBuildArity` returned `null` and every capture tier stayed on: the runtime
// cost of a rule depended on how its reducer was SPELLED.
//
// `reducer-resolver.ts` does the real work — lexical scope analysis over this module,
// plus cross-module import following — and this is where its answer is attached. The
// resolved arity lands on `_def.buildArity` and the resolved source on
// `_def.buildSigSrc`; both are ANALYSIS-ONLY and never emitted, so the generated builder
// reference is byte-identical either way.
// ---------------------------------------------------------------------------
let _reducers: ReducerResolver | null = null

/**
 * The source of the module actually being EMITTED, so a factory evaluated out of some
 * OTHER file can be told apart from one written here. See `setReducerResolver`.
 */
let _entrySource: string | null = null

/** Install (or clear, with `null`) the resolver for the module being transformed. */
export function setReducerResolver(r: ReducerResolver | null, entrySource: string | null = null): void {
  _reducers = r
  _entrySource = entrySource
}

/**
 * Map a free lexical name read by a direct node builder to the import it came from
 * in the AUTHORING module. A name that resolves is no longer a refusal — the node
 * carries `{ source, imported }` provenance, and a downstream `compose()` re-binds
 * it by re-emitting the same import into the consuming module. A name that does not
 * resolve (a module-private const, a genuinely undefined read) stays a refusal.
 */
export type BuilderImportResolver = (name: string) => { source: string; imported: string } | null
let _builderImports: BuilderImportResolver | null = null
/** Install (or clear, with `null`) the import-provenance resolver for the module being transformed. */
export function setBuilderImportResolver(r: BuilderImportResolver | null): void {
  _builderImports = r
}

// ---------------------------------------------------------------------------
// Scope types
//
// Each scope entry is either a raw Combinator, or an enriched entry that
// carries the mapFnSources this combinator will contribute when the codegen
// traverses its subtree.  The enriched form is needed so that anyValue can
// "replay" those sources when the combinator is referenced by another
// expression — keeping mapFnSources aligned with what ctx.mapFns builds.
// ---------------------------------------------------------------------------
export type ScopeEntry = {
  combi: Combinator<unknown>
  mfSrcs: string[]
}
export type Scope = Map<string, ScopeEntry>

// Internal XScope also holds non-Combinator values (g proxy objects etc.)
type XScopeVal = ScopeEntry | unknown
type XScope = Map<string, XScopeVal>

type WordFactoryEntry = { tag: 'wordFactory'; boundary: string; caseInsensitive: boolean }
type WhenFactoryEntry = { tag: 'whenFactory'; caseInsensitive: boolean }
type StaticValueEntry = { value: unknown; mfSrcs: string[] }

function isWordFactory(v: unknown): v is WordFactoryEntry {
  return !!v && typeof v === 'object' && (v as WordFactoryEntry).tag === 'wordFactory'
}

function isWhenFactory(v: unknown): v is WhenFactoryEntry {
  return !!v && typeof v === 'object' && (v as WhenFactoryEntry).tag === 'whenFactory'
}

function isStaticValueEntry(v: unknown): v is StaticValueEntry {
  return !!v && typeof v === 'object' && 'value' in v && 'mfSrcs' in v
}

function wordFactoryFromArgs(args: readonly (Expression | { type: 'SpreadElement' })[], scope: XScope, code?: string, mfs?: string[]): WordFactoryEntry | null {
  const [boundaryOrOptsArg, optsArg] = args
  if (boundaryOrOptsArg?.type === 'SpreadElement' || optsArg?.type === 'SpreadElement') return null

  const rawBoundaryOrOpts = boundaryOrOptsArg === undefined
    ? undefined
    : anyValue(boundaryOrOptsArg as Expression, scope, code, mfs)
  const boundaryOrOpts = rawBoundaryOrOpts === undefined ? '_0-9A-Za-z' : rawBoundaryOrOpts
  const opts = optsArg === undefined
    ? undefined
    : anyValue(optsArg as Expression, scope, code, mfs)

  if (typeof boundaryOrOpts === 'string') {
    if (opts !== undefined && (typeof opts !== 'object' || opts === null || Array.isArray(opts))) return null
    const caseInsensitive = typeof opts === 'object' && opts !== null && 'caseInsensitive' in opts
      ? (opts as { caseInsensitive?: unknown }).caseInsensitive
      : false
    if (typeof caseInsensitive !== 'boolean') return null
    return { tag: 'wordFactory', boundary: boundaryOrOpts, caseInsensitive }
  }

  if (typeof boundaryOrOpts !== 'object' || boundaryOrOpts === null || Array.isArray(boundaryOrOpts) || opts !== undefined) {
    return null
  }
  const caseInsensitive = 'caseInsensitive' in boundaryOrOpts
    ? (boundaryOrOpts as { caseInsensitive?: unknown }).caseInsensitive
    : false
  if (typeof caseInsensitive !== 'boolean') return null
  return { tag: 'wordFactory', boundary: '_0-9A-Za-z', caseInsensitive }
}

function dispatchWhenOptions(v: unknown): parseman.DispatchWhenOptions | null {
  if (v === undefined) return {}
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  for (const key of Object.keys(v)) {
    if (key !== 'caseInsensitive') return null
  }
  const caseInsensitive = 'caseInsensitive' in v
    ? (v as { caseInsensitive?: unknown }).caseInsensitive
    : false
  if (typeof caseInsensitive !== 'boolean') return null
  return { caseInsensitive }
}

function whenFactoryFromArgs(args: readonly (Expression | { type: 'SpreadElement' })[], scope: XScope, code?: string, mfs?: string[]): WhenFactoryEntry | null {
  const [optsArg, extra] = args
  if (optsArg?.type === 'SpreadElement' || extra !== undefined) return null
  const rawOpts = optsArg === undefined
    ? undefined
    : anyValue(optsArg as Expression, scope, code, mfs)
  const opts = dispatchWhenOptions(rawOpts)
  return opts === null ? null : { tag: 'whenFactory', caseInsensitive: opts.caseInsensitive ?? false }
}

/**
 * Generic fallback table, consulted LAST (see the dispatch at the end of
 * `exprToCombi`). A combinator with an UNCONDITIONAL explicit branch above must
 * not appear here — the entry would be unreachable. `many`/`oneOrMore`/`sepBy`/
 * `oneOrMoreSep`/`peek`/`not` are all handled explicitly, because their emitters
 * traverse the item more than once (mfSrcs replay) or take options that must not
 * be silently dropped.
 */
const SUPPORTED: Record<string, (...args: unknown[]) => Combinator<unknown>> = {
  literal:   (...a) => parseman.literal(a[0] as string, a[1] as parseman.LiteralOptions | undefined),
  regex:     (...a) => parseman.regex(a[0] as RegExp, a[1] as string | undefined),
  keywords:  (...a) => parseman.keywords(a[0] as readonly string[], a[1] as parseman.KeywordsOptions | undefined),
  word:      (...a) => parseman.word(a[0] as string, a[1] as string | undefined, a[2] as Omit<parseman.KeywordsOptions, 'boundary'> | undefined),
  sequence:  (...a) => (parseman.sequence as (...p: Combinator<unknown>[]) => Combinator<unknown[]>)(...(a as Combinator<unknown>[])),
  choice:    (...a) => (parseman.choice as (...p: Combinator<unknown>[]) => Combinator<unknown>)(...(a as Combinator<unknown>[])),
  attempt:   (...a) => parseman.attempt(a[0] as Combinator<unknown>),
  optional:  (...a) => parseman.optional(a[0] as Combinator<unknown>),
  trivia:    (...a) => parseman.trivia(a[0] as Combinator<unknown>),
  classifiedTrivia: (...a) =>
    parseman.classifiedTrivia(
      a[0] as Readonly<Record<string, Combinator<unknown>>>,
    ),
  label:     (...a) => parseman.label(a[0] as string, a[1] as Combinator<unknown>),
  field:     (...a) => parseman.field(a[0] as string, a[1] as Combinator<unknown>),
  noTrivia:  (...a) => parseman.noTrivia(a[0] as Combinator<unknown>),
  token:     (...a) => parseman.token(a[0] as Combinator<unknown>),
  // `routed(fallback)` — the fallback must be forwarded. A zero-arg entry here read
  // as "routed takes no arguments" and SILENTLY built a bare `routed()`, so a
  // production written to work both inside and outside a dispatch branch lost its
  // out-of-branch behaviour under the macro while keeping it under the interpreter.
  // `undefined` reproduces the bare def exactly (see `routed()`), so `routed()` is
  // byte-identical.
  routed:    (...a) => parseman.routed(a[0] as Combinator<unknown> | undefined),
  leaf:      (...a) => parseman.leaf(a[0] as Combinator<unknown>, a[1] as (value: unknown, span: { start: number; end: number }) => unknown),
  expect:    (...a) => parseman.expect(a[0] as Combinator<unknown>, a[1] as string | undefined),
  // Adjacency assertions carry only plain data (a polarity and an optional list of
  // category names), so the macro reproduces them exactly — no source capture, no
  // interpreter fallback.
  adjacent:  () => parseman.adjacent(),
  notAdjacent: (...a) => parseman.notAdjacent(a[0] as { kinds?: readonly string[] } | undefined),
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isScopeEntry(v: unknown): v is ScopeEntry {
  return !!v && typeof v === 'object' && 'combi' in v && 'mfSrcs' in v
}

/** THE reader for an object-literal property key, for every consumer in the plugin.
 *
 * Returns the key a JavaScript engine would use, or null when the property does not
 * name a static key at all — a spread, a rest, or a COMPUTED key whose value is not
 * known until runtime.
 *
 * Both halves are load-bearing and each was got wrong somewhere:
 *   - a quoted key is a `Literal`, not an `Identifier`. Reading only `key.name` sees
 *     `{ 'hostMode': 'cst' }` as having no hostMode, and drops the option SILENTLY.
 *   - `key.name` is also populated for a COMPUTED key `{ [hostMode]: … }`, where the
 *     identifier is a variable and the actual key is its value. Reading only
 *     `key.name` there invents an option the source never set.
 *
 * So an Identifier-only reader both misses keys that are present and matches keys that
 * are not. Three option readers in plugin/index.ts each re-derived one wrong half; the
 * fix is this one function, imported. */
export function propName(p: { type?: string; computed?: boolean; key?: unknown }): string | null {
  if ((p.type !== undefined && p.type !== 'Property') || p.computed || !p.key) return null
  const key = p.key as { type?: string; name?: unknown; value?: unknown }
  return key.type === 'Identifier' ? (typeof key.name === 'string' ? key.name : null)
    : key.type === 'Literal' ? String(key.value)
    : null
}

/** Is this a gated-choice arm object literal — `{ gate, combinator }`? */
function isGatedArmExpr(e: { type: string }): boolean {
  if (e.type !== 'ObjectExpression') return false
  let hasGate = false, hasCombinator = false
  for (const prop of (e as ObjectExpression).properties) {
    if (prop.type !== 'Property') continue
    const name = propName(prop as unknown as ObjectProperty)
    if (name === 'gate') hasGate = true
    else if (name === 'combinator') hasCombinator = true
  }
  return hasGate && hasCombinator
}

/** Extract the `gate` / `combinator` value expressions from a gated-arm object.
 * Returns null on any unexpected shape (spread, computed key, extra key). */
function gatedArmParts(e: ObjectExpression): { gate: Expression; combinator: Expression } | null {
  let gate: Expression | undefined
  let combinator: Expression | undefined
  for (const prop of e.properties) {
    if (prop.type !== 'Property') return null
    const op = prop as unknown as ObjectProperty
    const name = propName(op)
    if (name === 'gate') gate = op.value as Expression
    else if (name === 'combinator') combinator = op.value as Expression
    else return null
  }
  return gate && combinator ? { gate, combinator } : null
}

function dispatchArmValue(node: Expression, scope: XScope, code?: string, mfs?: string[]): DispatchArm<unknown> | null {
  if (node.type === 'Identifier') {
    const value = anyValue(node, scope, code, mfs)
    return isDispatchArm(value) ? value : null
  }

  if (node.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type !== 'Identifier') return null

  const factory = scope.get(callee.name)
  if (isWhenFactory(factory)) {
    const [keyArg, parserArg, extraArg] = node.arguments
    if (!keyArg || !parserArg || extraArg !== undefined || keyArg.type === 'SpreadElement' || parserArg.type === 'SpreadElement') return null
    const key = anyValue(keyArg as Expression, scope, code, mfs)
    const parserValue = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(parserValue)) return null
    const opts = { caseInsensitive: factory.caseInsensitive }
    if (typeof key === 'string') return parseman.when(key, parserValue, opts)
    if (Array.isArray(key) && key.every(item => typeof item === 'string')) return parseman.when(key, parserValue, opts)
    // `makeWhen(opts)` returns `(key, parser) => when(key, parser, opts)`, so it accepts
    // EVERY key `when` accepts — including a startsWith/endsWith/matches matcher. Omitting
    // that case here made the aliased form a hard macro failure ("factory isn't statically
    // evaluable") for an arm the interpreter builds, so the alias silently carried a
    // narrower contract than the constructor it forwards to.
    if (isDispatchMatcher(key)) return parseman.when(key, parserValue, opts)
    return null
  }

  if (callee.name === 'otherwise') {
    const [parserArg] = node.arguments
    if (!parserArg || parserArg.type === 'SpreadElement') return null
    const parserValue = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(parserValue)) return null
    return parseman.otherwise(parserValue)
  }

  if (callee.name === 'when') {
    const [keyArg, parserArg, optsArg] = node.arguments
    if (!keyArg || !parserArg || keyArg.type === 'SpreadElement' || parserArg.type === 'SpreadElement' || optsArg?.type === 'SpreadElement') return null
    const key = anyValue(keyArg as Expression, scope, code, mfs)
    const parserValue = anyValue(parserArg as Expression, scope, code, mfs)
    const opts = dispatchWhenOptions(optsArg === undefined ? undefined : anyValue(optsArg as Expression, scope, code, mfs))
    if (opts === null) return null
    if (!isCombinator(parserValue)) return null
    if (typeof key === 'string') return parseman.when(key, parserValue, opts)
    if (Array.isArray(key) && key.every(item => typeof item === 'string')) return parseman.when(key, parserValue, opts)
    if (isDispatchMatcher(key)) return parseman.when(key, parserValue, opts)
  }

  return null
}

function isCombinator(v: unknown): v is Combinator<unknown> {
  return !!v && typeof v === 'object' && '_def' in v
}

function isDispatchArm(v: unknown): v is DispatchArm<unknown> {
  if (!v || typeof v !== 'object') return false
  const rec = v as { kind?: unknown; keys?: unknown; matcher?: unknown; parser?: unknown; caseInsensitive?: unknown }
  if (rec.kind === 'otherwise') return isCombinator(rec.parser)
  if (rec.kind === 'whenMatcher') {
    return isDispatchMatcher(rec.matcher) &&
      typeof rec.caseInsensitive === 'boolean' &&
      isCombinator(rec.parser)
  }
  return rec.kind === 'when' &&
    Array.isArray(rec.keys) &&
    rec.keys.every(key => typeof key === 'string') &&
    typeof rec.caseInsensitive === 'boolean' &&
    isCombinator(rec.parser)
}

function isDispatchMatcher(v: unknown): v is ReturnType<typeof parseman.startsWith> {
  if (!v || typeof v !== 'object') return false
  const rec = v as { kind?: unknown; value?: unknown; flags?: unknown }
  if ((rec.kind === 'startsWith' || rec.kind === 'endsWith') && typeof rec.value === 'string') return true
  return rec.kind === 'matches' &&
    typeof rec.value === 'string' &&
    typeof rec.flags === 'string'
}

/**
 * Resolve an identifier from scope.
 * If the entry carries mfSrcs, replay them into `mfs` so that the
 * overall accumulator stays aligned with what codegen will push.
 */
function scopeGet(scope: XScope, name: string, mfs?: string[]): Combinator<unknown> | null {
  const entry = scope.get(name)
  if (!entry) return null
  if (isScopeEntry(entry)) {
    if (mfs && entry.mfSrcs.length > 0) mfs.push(...entry.mfSrcs)
    return entry.combi
  }
  if (isCombinator(entry)) return entry
  return null
}

// ---------------------------------------------------------------------------
// Core evaluators
// ---------------------------------------------------------------------------

/** Read static node opts that affect generated grammar shape. */
function unwrapStaticExpr<T extends { type?: string }>(expr: T): T {
  let cur = expr as unknown as { type?: string; expression?: T }
  while (cur.type === 'TSAsExpression'
    || cur.type === 'TSSatisfiesExpression'
    || cur.type === 'TSNonNullExpression'
    || cur.type === 'TSTypeAssertion'
    || cur.type === 'TSInstantiationExpression'
    || cur.type === 'ParenthesizedExpression') {
    if (!cur.expression) break
    cur = cur.expression as unknown as typeof cur
  }
  return cur as unknown as T
}

function staticLiteralValue(expr: unknown): unknown {
  const val = unwrapStaticExpr(expr as { type?: string; value?: unknown })
  return val.type === 'Literal' || val.type === 'BooleanLiteral' || val.type === 'NumericLiteral'
    ? val.value
    : undefined
}

function staticStringArray(expr: unknown, scope?: XScope): readonly string[] | undefined {
  const id = unwrapStaticExpr(expr as { type?: string; name?: string })
  if (id.type === 'Identifier' && scope !== undefined && id.name !== undefined) {
    const scoped = scope.get(id.name)
    const value = isStaticValueEntry(scoped) ? scoped.value : scoped
    return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined
  }
  const arr = id as { type?: string; elements?: unknown[] }
  if (arr.type !== 'ArrayExpression' || !Array.isArray(arr.elements)) return undefined
  const out: string[] = []
  for (const el of arr.elements) {
    if (!el || (el as { type?: string }).type === 'SpreadElement') return undefined
    const value = staticLiteralValue(el)
    if (typeof value !== 'string') return undefined
    out.push(value)
  }
  return out
}

type StaticNodeProject = { ok: true; value: number } | { ok: false }
const STATIC_NODE_OPTIONS_FAILED = Symbol('parseman.staticNodeOptions.failed')
const STATIC_NODE_OPTIONS_NOT_OPTIONS = Symbol('parseman.staticNodeOptions.notOptions')
type StaticNodeOptions =
  | parseman.NodeOptions<readonly string[]>
  | undefined
  | typeof STATIC_NODE_OPTIONS_FAILED
  | typeof STATIC_NODE_OPTIONS_NOT_OPTIONS

function staticNodeProject(expr: Expression): StaticNodeProject | undefined {
  const literalValue = staticLiteralValue(expr)
  if (typeof literalValue === 'number' && Number.isInteger(literalValue) && literalValue >= 0) {
    return { ok: true, value: literalValue }
  }
  if (typeof literalValue === 'number' || literalValue !== undefined) return { ok: false }
  return { ok: false }
}

function scopedStaticValue(expr: Expression, scope: XScope): { found: true; value: unknown } | { found: false } {
  const unwrapped = unwrapStaticExpr(expr)
  if (unwrapped.type !== 'Identifier' || unwrapped.name === 'undefined') return { found: false }
  if (!scope.has(unwrapped.name)) return { found: false }
  const scoped = scope.get(unwrapped.name)
  const value = isStaticValueEntry(scoped) ? scoped.value : scoped
  return { found: true, value }
}

function staticNodeOptionsFromValue(value: unknown): parseman.NodeOptions<readonly string[]> | undefined | typeof STATIC_NODE_OPTIONS_FAILED | typeof STATIC_NODE_OPTIONS_NOT_OPTIONS {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isCombinator(value)) return STATIC_NODE_OPTIONS_NOT_OPTIONS
  const opts: parseman.NodeOptions<readonly string[]> = {}
  const rec = value as Record<string, unknown>
  for (const name of Object.keys(rec)) {
    const v = rec[name]
    if (name === 'unwrap' || name === 'collapse' || name === 'captureTrivia' || name === 'trailingTrivia') {
      if (v === true) opts[name] = true
      else if (v !== false && v !== undefined) return STATIC_NODE_OPTIONS_FAILED
    } else if (name === 'project') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return STATIC_NODE_OPTIONS_FAILED
      opts.project = v
    } else if (name === 'tags') {
      if (!Array.isArray(v) || !v.every(item => typeof item === 'string')) return STATIC_NODE_OPTIONS_FAILED
      opts.tags = v
    } else if (name === 'buildArity') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 6) return STATIC_NODE_OPTIONS_FAILED
      opts.buildArity = v
    }
  }
  return opts.unwrap || opts.collapse || opts.project !== undefined || opts.captureTrivia || opts.trailingTrivia || opts.tags !== undefined || opts.buildArity !== undefined ? opts : undefined
}

function staticNodeOptions(expr: Expression, scope: XScope): StaticNodeOptions {
  const unwrapped = unwrapStaticExpr(expr)
  const scoped = scopedStaticValue(unwrapped, scope)
  if (scoped.found) return staticNodeOptionsFromValue(scoped.value)
  if (unwrapped.type !== 'ObjectExpression') return STATIC_NODE_OPTIONS_NOT_OPTIONS
  const opts: parseman.NodeOptions<readonly string[]> = {}
  for (const prop of (unwrapped as ObjectExpression).properties) {
    if ((prop as { type?: string }).type !== 'Property') return STATIC_NODE_OPTIONS_FAILED
    const p = prop as unknown as ObjectProperty
    if (p.computed) return STATIC_NODE_OPTIONS_FAILED
    const name = propName(p as never)
    if (name === 'unwrap' || name === 'collapse' || name === 'captureTrivia' || name === 'trailingTrivia') {
      const value = staticLiteralValue(p.value)
      if (value === true) opts[name] = true
      else if (value !== false && value !== undefined) return STATIC_NODE_OPTIONS_FAILED
    } else if (name === 'project') {
      const project = staticNodeProject(p.value as Expression)
      if (project?.ok === false) return STATIC_NODE_OPTIONS_FAILED
      if (project !== undefined) opts.project = project.value
    } else if (name === 'tags') {
      const tags = staticStringArray(p.value, scope)
      if (tags === undefined) return STATIC_NODE_OPTIONS_FAILED
      opts.tags = tags
    } else if (name === 'buildArity') {
      const arity = staticLiteralValue(p.value)
      if (typeof arity !== 'number' || !Number.isInteger(arity) || arity < 0 || arity > 6) return STATIC_NODE_OPTIONS_FAILED
      opts.buildArity = arity
    }
  }
  return opts.unwrap || opts.collapse || opts.project !== undefined || opts.captureTrivia || opts.trailingTrivia || opts.tags !== undefined || opts.buildArity !== undefined ? opts : undefined
}

/**
 * Evaluate a call expression to a Combinator.
 * `mfs` accumulates mapFn source texts in depth-first order — must match
 * what codegen pushes to ctx.mapFns when it traverses the same tree.
 */
function exprToCombi(node: Expression, scope: XScope, code?: string, mfs?: string[]): Combinator<unknown> | null {
  if (node.type === 'Identifier') return scopeGet(scope, node.name, mfs)

  if (node.type !== 'CallExpression') return null

  const callee = node.callee

  // makeWord(boundary?, opts?)(str)
  if (callee.type === 'CallExpression'
    && callee.callee.type === 'Identifier'
    && callee.callee.name === 'makeWord') {
    const strArg = node.arguments[0]
    if (!strArg || strArg.type === 'SpreadElement') return null
    const factory = wordFactoryFromArgs(callee.arguments, scope, code, mfs)
    const str = anyValue(strArg as Expression, scope, code, mfs)
    if (factory === null || typeof str !== 'string') return null
    try { return parseman.word(str, factory.boundary, { caseInsensitive: factory.caseInsensitive }) } catch { return null }
  }

  if (callee.type === 'Identifier') {
    const factory = scope.get(callee.name)
    if (isWordFactory(factory)) {
      const [strArg] = node.arguments
      if (!strArg || strArg.type === 'SpreadElement') return null
      const str = anyValue(strArg as Expression, scope, code, mfs)
      if (typeof str !== 'string') return null
      try { return parseman.word(str, factory.boundary, { caseInsensitive: factory.caseInsensitive }) } catch { return null }
    }
  }

  if (callee.type !== 'Identifier') return null

  // transform(inner, fn) — capture fn source text before pushing to mfs
  if (callee.name === 'transform' && code !== undefined && mfs !== undefined) {
    const [parserArg, fnArg] = node.arguments
    if (!parserArg || !fnArg || parserArg.type === 'SpreadElement' || fnArg.type === 'SpreadElement') return null
    const inner = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    const fnSrc = stripTsFromSource(fnArg as Node, code)
    mfs.push(fnSrc)
    try {
      const combi = parseman.transform(inner, (v: unknown) => v)
      // Carry the callback source on the def so codegen can pull it in traversal
      // order (order-independent across rules that share sub-combinators).
      if (combi._def.tag === 'transform') combi._def.fnSrc = fnSrc
      return combi
    } catch { return null }
  }

  // leaf(inner, fn) — like transform(), but suppresses inner CST captures and
  // publishes one reducer-selected terminal leaf to its parent.
  if (callee.name === 'leaf' && code !== undefined && mfs !== undefined) {
    const [parserArg, fnArg] = node.arguments
    if (!parserArg || !fnArg || parserArg.type === 'SpreadElement' || fnArg.type === 'SpreadElement') return null
    const inner = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    const fnSrc = stripTsFromSource(fnArg as Node, code)
    mfs.push(fnSrc)
    try {
      const combi = parseman.leaf(inner, (v: unknown) => v)
      if (combi._def.tag === 'leaf') combi._def.fnSrc = fnSrc
      return combi
    } catch { return null }
  }

  // node(parser, build?, opts?) / node(type, parser, build?, opts?) — CST node rule.
  // Capture the build callback source (like transform) so codegen inlines it; the
  // inner parser carries the capture. Options may be the trailing argument or the
  // third argument when no build callback is present.
  if (callee.name === 'node' && code !== undefined) {
    const [firstArg, secondArg, thirdArg, fourthArg] = node.arguments
    if (!firstArg || firstArg.type === 'SpreadElement') return null
    const firstVal = anyValue(firstArg as Expression, scope, code, mfs)
    const explicitType = typeof firstVal === 'string' ? firstVal : undefined
    const parserArg = explicitType !== undefined ? secondArg : firstArg
    const buildArg = explicitType !== undefined ? thirdArg : secondArg
    const optsArg = explicitType !== undefined ? fourthArg : thirdArg
    if (!parserArg || parserArg.type === 'SpreadElement') return null
    const inner = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    // `build` is OPTIONAL — a structural node() omits it (or passes the literal
    // `undefined` to reach the 4th opts arg). Structural nodes build via the
    // injected `ctx.build` host; codegen keys that off `def.build === undefined`.
    const be = buildArg as { type: string; start: number; end: number; name?: string } | undefined
    const buildExpr = be === undefined || be.type === 'SpreadElement' ? undefined : unwrapStaticExpr(be as unknown as Expression)
    const buildArgOptions = be !== undefined && be.type !== 'SpreadElement'
      ? staticNodeOptions(buildArg as Expression, scope)
      : STATIC_NODE_OPTIONS_NOT_OPTIONS
    if (buildArgOptions === STATIC_NODE_OPTIONS_FAILED) return null
    const buildArgIsOptions = buildArgOptions !== STATIC_NODE_OPTIONS_NOT_OPTIONS
    const scopedBuild = buildExpr === undefined
      ? { found: false } as const
      : scopedStaticValue(buildExpr, scope)
    const absentBuild = (buildExpr?.type === 'Identifier' && buildExpr.name === 'undefined')
      || (buildExpr !== undefined && staticLiteralValue(buildExpr) === null)
      || (scopedBuild.found && (scopedBuild.value === undefined || scopedBuild.value === null))
    const hasBuild = be !== undefined && be.type !== 'SpreadElement'
      && !buildArgIsOptions
      && !absentBuild
    const buildSrc = hasBuild ? stripTsFromSource(be! as Node, code) : undefined
    let opts: parseman.NodeOptions<readonly string[]> | undefined
    if (buildArgIsOptions) {
      opts = buildArgOptions as parseman.NodeOptions<readonly string[]> | undefined
    } else if (optsArg !== undefined) {
      if (optsArg.type === 'SpreadElement') return null
      const optsResult = staticNodeOptions(optsArg as Expression, scope)
      if (optsResult === STATIC_NODE_OPTIONS_FAILED || optsResult === STATIC_NODE_OPTIONS_NOT_OPTIONS) return null
      opts = optsResult
    }
    try {
      const combi = explicitType !== undefined
        ? parseman.node(explicitType, inner, hasBuild ? () => null : undefined, opts as parseman.NodeOptions | undefined)
        : parseman.node(inner, hasBuild ? () => null : undefined, opts as parseman.NodeOptions | undefined)
      if (combi._def.tag === 'node' && buildSrc !== undefined) {
        combi._def.buildSrc = buildSrc
        // The type argument's IDENTIFIER, when it was written as one. A `node(type, …)`
        // inside a factory resolves `type` to a string here, which loses the fact that
        // the reducer's `mk(type, …)` names the SAME binding — and losing it is what
        // made every factory-built node miss the inline-`mk` path.
        if (explicitType !== undefined && firstArg.type === 'Identifier') {
          combi._def.typeSrc = (firstArg as unknown as { name: string }).name
        }
        // A NAMED reducer (`foldOperation`, `helpers.fold`, an import): resolve it so the
        // capture-tier analysis reads the REAL parameter list instead of failing open.
        // `null` means the expression was an inline function, which is self-describing.
        const resolved = _reducers?.resolve(buildSrc, be!.start, code)
        if (resolved) {
          if (resolved.src !== null) combi._def.buildSigSrc = resolved.src
          /*
           * A reducer named from a FOREIGN factory has to be emitted as its SOURCE, not
           * its name. `buildSrc` is the call site's expression text, and the call site is
           * in the factory's module — so `node('Fold', …, fold)` in an imported factory
           * emitted `const _build = [fold]` into the CONSUMING module, where `fold` is a
           * module-private const of a file that was never imported. That artifact threw
           * `ReferenceError: fold is not defined` on import, and nothing noticed: the
           * shape has tests, but they assert on the emitted TEXT and never run it. The
           * emit-time scope check below `ms.toString()` is what found it.
           *
           * The resolver has already read the declaration out of the right module, so the
           * substitution is exact for a self-contained reducer. One that closes over more
           * of its own module's privates is NOT fixed by this — it is caught by that same
           * scope check, which refuses to emit rather than shipping the next ReferenceError.
           */
          if (_entrySource !== null && code !== _entrySource
            && resolved.src !== null && be!.type === 'Identifier') {
            combi._def.buildSrc = resolved.src
          }
          // An author-declared `node(..., { buildArity })` is authority 1 in
          // `confirmedArityForDef`; the resolver is authority 2. Both land in the SAME
          // field, so writing unconditionally here demoted the declaration to whatever
          // scope analysis happened to find.
          if (combi._def.buildArity === undefined && resolved.arity !== null) combi._def.buildArity = resolved.arity
          if (resolved.reason !== undefined) combi._def.buildArityUnresolved = resolved.reason
        }
        // Analyze the REDUCER BODY, not the call-site reference. A named `function`
        // reducer (`node(..., foldOperation)`) arrives here as the bare identifier
        // `foldOperation`, which the analyzer can only read as `unsupported callback
        // shape`. `buildSigSrc` is the resolved declaration source (see the resolver
        // above and `buildAnalysisSrc`), so preferring it lets the function-reducer
        // lift walk the real body and report its real free names. An inline builder
        // has no `buildSigSrc`, so this is exactly `buildSrc` for that case.
        const analysisSrc = combi._def.buildSigSrc ?? buildSrc
        // A free name that this module IMPORTED is not a refusal: carry its
        // provenance so a downstream compose() re-emits the import. Only structural
        // refusals and free names with NO import provenance become the fail-closed
        // `buildStaticError` — which the runtime re-lowerer still throws on.
        const report = directBuilderBindings(analysisSrc)
        const carriedImports: Array<{ local: string; source: string; imported: string }> = []
        const unresolved: string[] = []
        for (const name of report.free) {
          const prov = _builderImports?.(name) ?? null
          if (prov) carriedImports.push({ local: name, source: prov.source, imported: prov.imported })
          else unresolved.push(name)
        }
        const staticError = [...report.structural, ...unresolved]
        if (staticError.length > 0) combi._def.buildStaticError = staticError
        if (carriedImports.length > 0) combi._def.buildImports = carriedImports
      }
      return combi
    } catch { return null }
  }

  // rules(factory) — handled separately by evaluateParserFactory; signal null here
  if (callee.name === 'rules') return null

  // ref() — forward-declared recursion slot. Standalone refs (declared, then
  // resolved later via `x.define(...)`) are the interpreter/compile() recursion
  // mechanism; the macro must support them too for parity. We return a REAL ref
  // placeholder here; index.ts pre-resolves all `x.define(...)` statements into
  // scope before compilation so codegen's emitLazy sees a defined thunk.
  if (callee.name === 'ref') {
    if (node.arguments.length !== 0) return null
    return ref<unknown>() as Combinator<unknown>
  }

  // parser(opts, root) — bakes trivia/trackLines into a `grammar` combinator so
  // the compiled output skips whitespace between sequence terms identically to
  // the interpreter. opts.trivia is itself a combinator; evaluate it with a
  // throwaway mfs accumulator since the trivia parser is emitted out-of-band
  // (ensureTriviaFn) and its sources are pulled via def.fnSrc, not positionally.
  if (callee.name === 'parser') {
    const [optsArg, rootArg] = node.arguments
    if (!optsArg || !rootArg || optsArg.type === 'SpreadElement' || rootArg.type === 'SpreadElement') return null
    const opts = anyValue(optsArg as Expression, scope, code, [])
    if (!opts || typeof opts !== 'object') return null
    const root = anyValue(rootArg as Expression, scope, code, mfs)
    if (!isCombinator(root)) return null
    try {
      return parseman.parser(opts as parseman.ParserOptions, root)
    } catch { return null }
  }

  // sepBy(item, sep, opts?) — emitSepBy traverses: item (first probe), sep, item
  // (loop body). We must push item's mfSrcs twice to stay aligned with ctx.mapFns.
  // `opts` (notably `{ min: 1 }`) MUST be honored: dropping it would silently
  // compile a NULLABLE list where the source asked for a non-empty one.
  if (callee.name === 'sepBy' || callee.name === 'oneOrMoreSep') {
    const [itemArg, sepArg, optsArg] = node.arguments
    if (!itemArg || !sepArg || itemArg.type === 'SpreadElement' || sepArg.type === 'SpreadElement') return null
    const itemMfs: string[] = []
    const itemCombi = anyValue(itemArg as Expression, scope, code, itemMfs)
    if (!isCombinator(itemCombi)) return null
    const sepMfs: string[] = []
    const sepCombi = anyValue(sepArg as Expression, scope, code, sepMfs)
    if (!isCombinator(sepCombi)) return null
    let opts: parseman.SepByOptions | undefined
    if (optsArg) {
      if (optsArg.type === 'SpreadElement') return null
      const v = anyValue(optsArg as Expression, scope, code, [])
      if (!v || typeof v !== 'object') return null
      opts = v as parseman.SepByOptions
    }
    if (mfs) mfs.push(...itemMfs, ...sepMfs, ...itemMfs)
    try {
      return callee.name === 'sepBy'
        ? parseman.sepBy(itemCombi, sepCombi, opts)
        : parseman.oneOrMoreSep(itemCombi, sepCombi, opts)
    } catch { return null }
  }

  // many(item, opts?) / oneOrMore(item, opts?) — emitMany traverses `min` mandatory
  // items then the loop body, so item's mfSrcs are replayed min+1 times. `opts`
  // MUST be honored: dropping `{ min }` would silently compile a NULLABLE repeat.
  if (callee.name === 'oneOrMore' || callee.name === 'many') {
    const [itemArg, optsArg] = node.arguments
    if (!itemArg || itemArg.type === 'SpreadElement') return null
    const itemMfs: string[] = []
    const itemCombi = anyValue(itemArg as Expression, scope, code, itemMfs)
    if (!isCombinator(itemCombi)) return null
    let opts: parseman.RepeatOptions | undefined
    if (optsArg) {
      if (optsArg.type === 'SpreadElement') return null
      const v = anyValue(optsArg as Expression, scope, code, [])
      if (!v || typeof v !== 'object') return null
      opts = v as parseman.RepeatOptions
    }
    let combi: Combinator<unknown>
    try {
      combi = callee.name === 'many' ? parseman.many(itemCombi, opts) : parseman.oneOrMore(itemCombi, opts)
    } catch { return null }
    const min = combi._def.tag === 'oneOrMore' ? combi._def.min : 0
    if (mfs) for (let i = 0; i <= min; i++) mfs.push(...itemMfs)
    return combi
  }

  // not(parser) — negative lookahead (consumes nothing).
  if (callee.name === 'not') {
    const [innerArg] = node.arguments
    if (!innerArg || innerArg.type === 'SpreadElement') return null
    const inner = anyValue(innerArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    try { return parseman.not(inner) } catch { return null }
  }

  // peek(parser) — POSITIVE lookahead (consumes nothing), carrying the body's
  // first-set so a leading peek() still gates its choice arm.
  if (callee.name === 'peek') {
    const [innerArg] = node.arguments
    if (!innerArg || innerArg.type === 'SpreadElement') return null
    const inner = anyValue(innerArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    try { return parseman.peek(inner) } catch { return null }
  }

  // balanced(open, close, opts?) — like scanTo, opts (notably opts.skip, an array
  // of combinators) MUST be honored. The interpreter and compile() build the full
  // combinator structure from opts; the macro must evaluate and pass opts too —
  // dropping it silently produces wrong (parity-breaking) behavior.
  if (callee.name === 'balanced') {
    const [openArg, closeArg, optsArg] = node.arguments
    if (!openArg || !closeArg || openArg.type === 'SpreadElement' || closeArg.type === 'SpreadElement') return null
    const open = anyValue(openArg as Expression, scope, code, [])
    const close = anyValue(closeArg as Expression, scope, code, [])
    if (typeof open !== 'string' || typeof close !== 'string') return null
    const opts = optsArg && optsArg.type !== 'SpreadElement'
      ? anyValue(optsArg as Expression, scope, code, [])
      : undefined
    try { return parseman.balanced(open, close, opts as parseman.ScanToOptions | undefined) } catch { return null }
  }

  // scanTo(sentinel, opts?) — consume up to (and including) a sentinel, optionally
  // skipping balanced pairs. opts.skip is an array of combinators.
  if (callee.name === 'scanTo') {
    const [sentinelArg, optsArg] = node.arguments
    if (!sentinelArg || sentinelArg.type === 'SpreadElement') return null
    const sentinel = anyValue(sentinelArg as Expression, scope, code, [])
    if (!isCombinator(sentinel)) return null
    const opts = optsArg && optsArg.type !== 'SpreadElement'
      ? anyValue(optsArg as Expression, scope, code, [])
      : undefined
    try { return parseman.scanTo(sentinel, opts as parseman.ScanToOptions | undefined) } catch { return null }
  }

  // gate(pred) (formerly guard(pred)) — context assertion. Capture the predicate
  // source (like transform's fn) so codegen inlines it into `_mf`; build a
  // placeholder gate and stash the source on `_def.predSrc`. Without source-capture
  // context we return null → the whole rule falls back to the (correct)
  // interpreter, never dropping the predicate.
  if (callee.name === 'gate' || callee.name === 'guard') {
    if (code === undefined || mfs === undefined) return null
    const [predArg] = node.arguments
    if (!predArg || predArg.type === 'SpreadElement') return null
    const predSrc = stripTsFromSource(predArg as Node, code)
    mfs.push(predSrc)
    try {
      const combi = parseman.gate(() => true)
      if (combi._def.tag !== 'guard') return null
      combi._def.predSrc = predSrc
      return combi
    } catch { return null }
  }

  // withCtx(extra, inner) — run `inner` with ctx.state = extra. Capture the
  // `extra` argument source; codegen wraps it as `() => (extra)` in `_mf`. The
  // extra getter is emitted BEFORE the inner parser's own mapFns (matching
  // emitWithCtx's push order), so push the extra token first, then eval inner.
  if (callee.name === 'withCtx') {
    if (code === undefined || mfs === undefined) return null
    const [extraArg, innerArg] = node.arguments
    if (!extraArg || !innerArg || extraArg.type === 'SpreadElement' || innerArg.type === 'SpreadElement') return null
    const extraSrc = stripTsFromSource(extraArg as Node, code)
    mfs.push(extraSrc)
    const inner = anyValue(innerArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    try {
      // THE VALUE, not just its source text. Codegen only ever needed `extraSrc`
      // — it prints `() => (extra)` into `_mf` — so `{}` was an adequate stand-in
      // for the def's own `extra`. The TABLE ENCODER reads `d.extra` and interns
      // it in the const pool, so the placeholder became the artifact: the pool
      // held a bare `{}` and every `withCtx` gate predicate (`s => !!(s && s.inner)`)
      // was present and permanently false. Evaluate the argument; the placeholder
      // survives only when it cannot be evaluated, and then it is `emittableConst`
      // that decides — a plain `{}` extras object is indistinguishable from an
      // author's `{}`, so an unevaluable one must NOT masquerade as empty state.
      const evaluated = anyValue(extraArg as Expression, scope, code, [])
      const usable = typeof evaluated === 'object' && evaluated !== null && !Array.isArray(evaluated)
        && Object.getPrototypeOf(evaluated) === Object.prototype
      const combi = parseman.withCtx(usable ? evaluated : UNEVALUATED_EXTRA, inner)
      if (combi._def.tag !== 'withCtx') return null
      combi._def.extraSrc = extraSrc
      return combi
    } catch { return null }
  }

  if (callee.name === 'dispatch') {
    const [selectorArg, ...armArgs] = node.arguments
    if (!selectorArg || selectorArg.type === 'SpreadElement') return null
    const selector = anyValue(selectorArg as Expression, scope, code, mfs)
    if (!isCombinator(selector)) return null
    const arms: DispatchArm<unknown>[] = []
    for (const arg of armArgs) {
      if (arg.type === 'SpreadElement') return null
      const arm = dispatchArmValue(arg as Expression, scope, code, mfs)
      if (!isDispatchArm(arm)) return null
      arms.push(arm)
    }
    try {
      const unsafeDispatch = parseman.dispatch as (selector: Combinator<string>, ...items: DispatchArm<unknown>[]) => Combinator<unknown>
      return unsafeDispatch(selector as Combinator<string>, ...arms)
    } catch { return null }
  }

  // choice(...) WITH at least one gated arm `{ gate, combinator }`. The generic
  // SUPPORTED path evaluates a gated-arm ObjectExpression via anyValue, whose
  // arrow-gate evaluates to `null` — so `choice` would treat the arm as UNGATED
  // and emit it unconditionally (a SILENT semantic miscompile vs the interpreter).
  // Handle gated choices explicitly: capture each gate's source, build the REAL
  // gated arm, and stash the per-arm sources on `_def.gateSrcs`. If any gate can't
  // be source-captured, return null for the WHOLE choice → safe interpreter
  // fallback. (Non-gated choices fall through to the generic path → byte-identical.)
  if (callee.name === 'choice' && node.arguments.some(a => a.type !== 'SpreadElement' && isGatedArmExpr(a as { type: string }))) {
    if (code === undefined || mfs === undefined) return null
    const arms: Array<Combinator<unknown> | { gate: (s: unknown) => boolean; combinator: Combinator<unknown> }> = []
    const gateSrcs: (string | null)[] = []
    for (const argNode of node.arguments) {
      if (argNode.type === 'SpreadElement') return null
      if (isGatedArmExpr(argNode as { type: string })) {
        const parts = gatedArmParts(argNode as unknown as ObjectExpression)
        if (!parts) return null
        // Gate mapFn is pushed BEFORE the arm body's mapFns (matches emitFirstMatch).
        const gateSrc = stripTsFromSource(parts.gate as unknown as Node, code)
        mfs.push(gateSrc)
        const combi = anyValue(parts.combinator, scope, code, mfs)
        if (!isCombinator(combi)) return null
        arms.push({ gate: () => true, combinator: combi })
        gateSrcs.push(gateSrc)
      } else {
        const combi = anyValue(argNode as Expression, scope, code, mfs)
        if (!isCombinator(combi)) return null
        arms.push(combi)
        gateSrcs.push(null)
      }
    }
    try {
      const combi = (parseman.choice as (...p: unknown[]) => Combinator<unknown>)(...arms)
      if (combi._def.tag !== 'choice') return null
      combi._def.gateSrcs = gateSrcs
      // Guard: a real gate MUST align with a captured source, and vice-versa —
      // no predicate-bearing arm may reach codegen with a dropped source.
      for (let i = 0; i < combi._def.gates.length; i++) {
        if ((combi._def.gates[i] !== null) !== (gateSrcs[i] !== null)) return null
      }
      return combi
    } catch { return null }
  }

  const factory = SUPPORTED[callee.name]
  if (!factory) return null

  const args = node.arguments.map(arg => {
    if (arg.type === 'SpreadElement') return null
    return anyValue(arg as Expression, scope, code, mfs)
  })
  if (args.some(a => a === null)) return null

  try {
    return factory(...(args as unknown[]))
  } catch { return null }
}

/** Evaluate any expression to its JS value (not necessarily a Combinator). */
function anyValue(node: Expression, scope: XScope, code?: string, mfs?: string[]): unknown {
  if (node.type === 'TSAsExpression'
    || node.type === 'TSSatisfiesExpression'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSTypeAssertion'
    || node.type === 'TSInstantiationExpression'
    || node.type === 'ParenthesizedExpression') {
    const inner = (node as unknown as { expression?: Expression }).expression
    return inner ? anyValue(inner, scope, code, mfs) : null
  }

  if (node.type === 'Literal') {
    if ('regex' in node && node.regex !== null && node.regex !== undefined) {
      return new RegExp(node.regex.pattern, node.regex.flags)
    }
    return node.value
  }

  if (node.type === 'ArrayExpression') {
    const arr = node as unknown as { elements: Array<Expression | null> }
    const out: unknown[] = []
    for (const el of arr.elements) {
      if (el === null) { out.push(null); continue }
      if ((el as { type: string }).type === 'SpreadElement') return null
      out.push(anyValue(el as Expression, scope, code, mfs))
    }
    return out
  }

  if (node.type === 'ObjectExpression') {
    const obj: Record<string, unknown> = {}
    for (const prop of node.properties) {
      const key = propName(prop as never)
      if (key === null) return null
      obj[key] = anyValue((prop as unknown as ObjectProperty).value as Expression, scope, code, mfs)
    }
    return obj
  }

  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined
    const entry = scope.get(node.name) ?? null
    if (isScopeEntry(entry)) {
      if (mfs && entry.mfSrcs.length > 0) mfs.push(...entry.mfSrcs)
      return entry.combi
    }
    if (isStaticValueEntry(entry)) {
      if (mfs && entry.mfSrcs.length > 0) mfs.push(...entry.mfSrcs)
      return entry.value
    }
    return entry
  }

  // MemberExpression — handles g.ruleName references inside parser() factories
  if (node.type === 'MemberExpression') {
    const mem = node as unknown as StaticMemberExpression
    const obj = anyValue(mem.object as Expression, scope, code, mfs)
    if (!obj || typeof obj !== 'object') return null
    if ((node as unknown as { computed: boolean }).computed) {
      const key = anyValue((node as unknown as { property: Expression }).property, scope, code, mfs)
      if (typeof key !== 'string' && typeof key !== 'number') return null
      return (obj as Record<string | number, unknown>)[key] ?? null
    }
    // A member ACCESS name (`obj.foo`), not an object-literal key — a different thing
    // from `propName`, and named apart from it so it cannot shadow the shared reader.
    const memberName = (mem.property as { name?: string }).name
    if (!memberName) return null
    return (obj as Record<string, unknown>)[memberName] ?? null
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (callee.type === 'Identifier' && callee.name === 'makeWord') {
      return wordFactoryFromArgs(node.arguments, scope, code, mfs)
    }
    if (callee.type === 'Identifier' && callee.name === 'makeWhen') {
      return whenFactoryFromArgs(node.arguments, scope, code, mfs)
    }
    if (callee.type === 'Identifier' && (callee.name === 'startsWith' || callee.name === 'endsWith')) {
      if (node.arguments.length !== 1 || node.arguments[0]?.type === 'SpreadElement') return null
      const value = anyValue(node.arguments[0] as Expression, scope, code, mfs)
      if (typeof value !== 'string') return null
      return callee.name === 'startsWith' ? parseman.startsWith(value) : parseman.endsWith(value)
    }
    if (callee.type === 'Identifier' && callee.name === 'matches') {
      if (node.arguments.length !== 1 || node.arguments[0]?.type === 'SpreadElement') return null
      const value = anyValue(node.arguments[0] as Expression, scope, code, mfs)
      if (!(value instanceof RegExp)) return null
      return parseman.matches(value)
    }
    if (callee.type === 'Identifier' && (callee.name === 'when' || callee.name === 'otherwise')) {
      return dispatchArmValue(node, scope, code, mfs)
    }
    if (callee.type === 'Identifier' && isWhenFactory(scope.get(callee.name))) {
      return dispatchArmValue(node, scope, code, mfs)
    }
    return exprToCombi(node, scope, code, mfs)
  }

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Evaluate makeWord(boundary?, opts?) to a factory entry (not a combinator). */
export function evaluateWordFactory(
  node: Expression,
  scope: Scope,
  code?: string,
): WordFactoryEntry | null {
  if (node.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type !== 'Identifier' || callee.name !== 'makeWord') return null
  return wordFactoryFromArgs(node.arguments, scope as XScope, code)
}

/** Evaluate makeWhen(opts?) to a dispatch-arm factory entry (not a combinator). */
export function evaluateWhenFactory(
  node: Expression,
  scope: Scope,
  code?: string,
): WhenFactoryEntry | null {
  if (node.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type !== 'Identifier' || callee.name !== 'makeWhen') return null
  return whenFactoryFromArgs(node.arguments, scope as XScope, code)
}

/** Evaluate a single combinator expression. Returns null if unresolvable. */
export function evaluateExpr(
  node: Expression,
  scope: Scope,
  code?: string,
  mapFnSources?: string[],
): Combinator<unknown> | null {
  return exprToCombi(node, scope as XScope, code, mapFnSources)
}

/**
 * Evaluate a `const X = [combinator, …]` array literal into an array of
 * Combinators. Lets a shared option array (e.g. a `skip` set reused across
 * `scanTo`/`balanced` calls) be referenced by name — `{ skip: X }` — instead of
 * inlining the array at every call site. Returns null when `node` isn't an array
 * literal of statically-resolvable combinators.
 */
export function evaluateCombinatorArray(
  node: Expression,
  scope: Scope,
  code?: string,
): Combinator<unknown>[] | null {
  if (node.type !== 'ArrayExpression') return null
  const val = anyValue(node, scope as XScope, code, [])
  if (!Array.isArray(val) || val.length === 0) return null
  if (!val.every(isCombinator)) return null
  return val as Combinator<unknown>[]
}

// ---------------------------------------------------------------------------
// A rules() factory's returned object is a flat map of `key: combinator` — the
// ONLY composition mechanism is compose() (see linker.ts). `...frag(g)` spreads
// are not supported: a spread property makes the factory non-statically-evaluable
// (propName returns null below), so it falls back to the interpreter.
// ---------------------------------------------------------------------------

/** Collect every rule key from a rules() return object. A non-`key: value`
 * property (spread / computed / rest) → null → the caller falls back. */
function collectRuleKeys(retObj: ObjectExpression): string[] | null {
  const out: string[] = []
  for (const prop of (retObj as unknown as { properties: Array<{ type: string }> }).properties) {
    const key = propName(prop as never)
    if (!key) return null
    out.push(key)
  }
  return out
}

export function evaluateStaticValue(
  node: Expression,
  scope: Scope,
  code?: string,
): unknown {
  return anyValue(node, scope as XScope, code, [])
}

type RuleEntry = { key: string; value: Expression; scope: XScope; code: string }

/** Flatten a rules() return object into ordered (key, valueExpr, evalScope).
 * A non-`key: value` property → null → interpreter fallback. */
function flattenRuleEntries(retObj: ObjectExpression, scope: XScope, code: string): RuleEntry[] | null {
  const out: RuleEntry[] = []
  for (const prop of (retObj as unknown as { properties: Array<{ type: string; value?: unknown }> }).properties) {
    const key = propName(prop as never)
    if (!key) return null
    out.push({ key, value: (prop as { value: Expression }).value, scope, code })
  }
  return out
}

/** Every `Identifier` name appearing anywhere under an expression node. */
function identifierNamesIn(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) identifierNamesIn(n, out); return out }
  const rec = node as Record<string, unknown>
  if (rec.type === 'Identifier' && typeof rec.name === 'string') out.add(rec.name)
  for (const k of Object.keys(rec)) {
    if (k === 'type' || k === 'start' || k === 'end') continue
    identifierNamesIn(rec[k], out)
  }
  return out
}

/**
 * Evaluate a factory body's `const` declarations into `scope`. Returns false on failure,
 * and writes a specific reason into `out.reason`.
 *
 * The reason matters more than it looks. A body binding that fails takes the whole
 * factory down, and the caller's generic "isn't statically evaluable" — or, through
 * `composeLeaf`, a message about the ARGUMENT SHAPE — points nowhere near the cause.
 * The dominant real cause is a forward reference: `const A = node('A', B, …)` above
 * `const B = …`. That is a JavaScript temporal dead zone, not a macro limitation — the
 * interpreter throws `ReferenceError: Cannot access 'B' before initialization` on the
 * very same source — so the macro should say so as plainly as the interpreter does.
 * `g.B` is order-free (the proxy mints a ref and defines it in phase 2), which is why
 * converting a `g.` reference to a bare const can only move DOWN the file.
 */
function evalBodyStatements(
  statements: VariableDeclaration[],
  scope: XScope,
  code: string,
  out?: { reason?: string },
): boolean {
  const bodyMfs: string[] = []
  // Names bound later in this body, for forward-reference attribution.
  const laterNames: Array<Set<string>> = []
  {
    const all: string[][] = statements.map(stmt =>
      stmt.declarations.map(d => ((d as unknown as VariableDeclarator).id as unknown as { name?: string }).name ?? '')
    )
    const flat = all.flat()
    let seen = 0
    for (const names of all) {
      laterNames.push(new Set(flat.slice(seen + names.length)))
      seen += names.length
    }
  }
  let si = -1
  for (const stmt of statements) {
    si++
    for (const d of stmt.declarations) {
      const decl = d as unknown as VariableDeclarator
      const id = decl.id as unknown as { type: string; name?: string }
      const name = id.name ?? '<destructured>'
      if (!decl.init) { if (out) out.reason = `\`${name}\` has no initializer`; return false }
      if (id.type !== 'Identifier' && id.type !== 'BindingIdentifier') {
        if (out) out.reason = 'a destructuring binding in the factory body'
        return false
      }
      const before = bodyMfs.length
      const val = anyValue(decl.init as unknown as Expression, scope, code, bodyMfs)
      if (val === null) {
        if (out) {
          const used = identifierNamesIn(decl.init)
          const forward = [...(laterNames[si] ?? [])].filter(n => n !== '' && used.has(n))
          out.reason = forward.length > 0
            ? `\`${name}\` references ${forward.map(n => `\`${n}\``).join(', ')} before ${forward.length > 1 ? 'their declarations' : 'its declaration'}`
              + ` — a temporal dead zone (the interpreter throws "Cannot access '${forward[0]}' before initialization" on this source too);`
              + ` move the declaration above \`${name}\`, or use \`g.${forward[0]}\`, which is order-free`
            : `\`${name}\` isn't a statically-evaluable combinator`
        }
        return false
      }
      const thisDeclMfSrcs = bodyMfs.slice(before)
      if (isCombinator(val)) scope.set(name, { combi: val, mfSrcs: thisDeclMfSrcs } satisfies ScopeEntry)
      else if (isDispatchArm(val)) scope.set(name, { value: val, mfSrcs: thisDeclMfSrcs } satisfies StaticValueEntry)
      else scope.set(name, val)
    }
  }
  return true
}

/**
 * Evaluate a `parser(g => { ... return { ruleName: combinator, ... } })` call.
 * Returns a map of rule names → defined Combinators, or null if the factory
 * can't be statically evaluated.
 *
 * mapFnSources is populated with the sources for mapFns that codegen will push
 * when compiling each returned rule — each rule's entry in the map will produce
 * a sub-slice of mapFnSources aligned to its specific ctx.mapFns.
 *
 * Important: this function uses a SEPARATE accumulator for body statement
 * evaluation so that only the return-expression phase adds entries to the
 * caller-provided mapFnSources (which is what compile() will receive).
 * The body-phase entries are stored as `mfSrcs` on localScope entries and
 * replayed when those entries are referenced during return evaluation.
 */
export function evaluateParserFactory(
  factoryNode: Expression,
  scope: Scope,
  code: string,
  mapFnSources: string[],  // receives ONLY the return-expression mfSrcs
  out?: { reason?: string },  // receives a SPECIFIC failure reason (see evalBodyStatements)
  /**
   * The `rules({ … }, factory)` options this call site declared, THREADED THROUGH
   * rather than reapplied afterwards.
   *
   * `plugin/index.ts` used to stamp `grammarScanSkip`, `grammarHostMode` and
   * `grammarTrackLines` onto the evaluated rules in three loops of its own,
   * carrying a comment that it had to "because the macro evaluates the FACTORY
   * directly and never calls `rules()`". It calls `rules()` now, so the options
   * belong where every other caller puts them: in the argument. That also gets
   * the `trackLines` half right for the first time — `rules()` does not merely
   * stamp it, it WRAPS each rule in a `grammarParser({ trackLines: true })` scope
   * (`parser.ts:228-242`), which the macro's stamp-only copy never did.
   */
  options?: RulesOptions,
): Map<string, Combinator<unknown>> | null {
  if (factoryNode.type !== 'ArrowFunctionExpression' && factoryNode.type !== 'FunctionDeclaration' && factoryNode.type !== 'FunctionExpression') return null

  const factory = factoryNode as unknown as ArrowFunctionExpression | OxcFunction
  const params = factory.params
  if (params.length !== 1) return null
  const param = params[0] as unknown as { type: string; name?: string }
  // FormalParameter is { decorators? } & BindingPattern — BindingIdentifier has type "Identifier"
  const proxyName = param.type === 'Identifier' ? param.name ?? null : null
  if (!proxyName) return null

  const body = factory.body
  if (!body) return null
  const statements: VariableDeclaration[] = []
  let returnExpr: Expression | null = null

  if ((body as unknown as { type: string }).type === 'BlockStatement') {
    const stmts = (body as unknown as { body: unknown[] }).body
    for (const stmt of stmts) {
      const s = stmt as { type: string }
      if (s.type === 'ReturnStatement') {
        returnExpr = ((s as unknown as ReturnStatement).argument ?? null) as Expression | null
        break
      }
      if (s.type === 'VariableDeclaration') {
        statements.push(s as unknown as VariableDeclaration)
      } else {
        return null // unsupported statement type
      }
    }
  } else {
    // Concise arrow body: g => ({ ... })
    returnExpr = body as unknown as Expression
  }

  if (!returnExpr) return null

  // Unwrap parenthesized expression if needed
  const retObj = returnExpr.type === 'ParenthesizedExpression'
    ? (returnExpr as unknown as { expression: Expression }).expression
    : returnExpr
  if (retObj.type !== 'ObjectExpression') return null

  // Pre-scan the return object for rule names. A non-`key: value` property (spread,
  // computed, rest) → null → the caller falls back to the interpreter. One ref per
  // UNIQUE key (first occurrence).
  const keys = collectRuleKeys(retObj as unknown as ObjectExpression)
  if (!keys) return null

  /*
   * ── ONE GRAMMAR-EVALUATION PATH ────────────────────────────────────────────
   *
   * Everything below this point used to be a SECOND IMPLEMENTATION of `rules()`:
   * mint a `ref()` per key, build a `g` proxy that hands back a placeholder for
   * any name, evaluate, define each slot, tag each rule. `rules()`
   * (`combinators/parser.ts:136`) does exactly that, and the two had drifted —
   * the copy never ran the closing `markUnusedValues`, so every macro-lowered
   * grammar reached the encoder with `valueUnused` unset and the shipped artifact
   * built 318 sequence tuples and 90 repeat arrays per parse of `benchmark.less`
   * that nothing reads. That was fixed by calling the real pass; this removes the
   * copy that made the omission possible, so there is nothing left to omit.
   *
   * `rules()` takes a FACTORY, which is precisely what this function has — not as
   * a JS closure, but as an AST it can evaluate on demand. So the collapse is to
   * hand `rules()` a closure that evaluates that AST against whatever proxy
   * `rules()` supplies, and let `rules()` own every step it already owned:
   *
   *   - the `g` proxy, INCLUDING the external-ref behaviour. `rules()`'s proxy
   *     mints a tagged placeholder for ANY name touched, which is what the local
   *     `externalRefs` map was reproducing — a `g.X` this grammar references but
   *     does not define, bound later by the fuse.
   *   - the define loop, the self-alias check, `tagRule` (byte-identical to the
   *     `tagRef` that lived here, `_ruleName` plus the untyped-`node()` type).
   *   - the ambient `trivia` / `scanSkip` stamps and the `hostMode` / `trackLines`
   *     stamps, which `plugin/index.ts` was applying itself in three more loops
   *     with a comment saying it had to "because the macro never calls `rules()`".
   *   - `markUnusedValues`, `RULE_ORDER`, and the grammar reflection.
   *
   * WHAT THIS CHANGES ABOUT THE RESULT, deliberately: a key the factory never
   * referenced through `g` now comes back as the parser itself rather than a
   * `lazy` wrapping it, because that is what `rules()` produces and the runtime
   * shape is the one the encoder is measured good on. A key that IS referenced
   * still comes back as its placeholder, so recursion is unchanged.
   *
   * A failure inside the factory cannot `return null` from here — it is running
   * under `rules()` — so it throws `ABORT` and is caught below. `rules()`'s own
   * self-alias `Error` is caught by the same handler, preserving this function's
   * "return null and let the caller fall back to the interpreter" contract rather
   * than turning a tolerated shape into a build failure.
   */
  const ABORT = Symbol('parseman: factory not statically evaluable')
  let built: Record<string, Combinator<unknown>>
  try {
    built = rules(options ?? {}, (g: Record<string, Combinator<unknown>>) => {
      // Outer ScopeEntry values carry their mfSrcs and are replayed by scopeGet()
      // when body statements or return expressions reference them.
      const localScope: XScope = new Map(scope as XScope)
      localScope.set(proxyName, g)

      // ── Phase 1: the factory's own body statements ────────────────────────
      if (!evalBodyStatements(statements, localScope, code, out)) throw ABORT

      // ── Phase 2: flatten the return object → dedup last-wins → evaluate ────
      // `flattenRuleEntries` returns the ordered (key, valueExpr, scope). A later
      // property of the same name wins.
      const entries = flattenRuleEntries(retObj as unknown as ObjectExpression, localScope, code)
      if (!entries) throw ABORT
      const finalByKey = new Map<string, RuleEntry>()
      for (const e of entries) finalByKey.set(e.key, e) // keeps first position, updates value → last wins
      const definitions: Record<string, Combinator<unknown>> = {}
      for (const [key, e] of finalByKey) {
        const val = anyValue(e.value, e.scope, e.code, mapFnSources)
        if (!isCombinator(val)) throw ABORT
        definitions[key] = val as Combinator<unknown>
      }
      return definitions
    }) as unknown as Record<string, Combinator<unknown>>
  } catch (e) {
    if (e === ABORT) return null
    // `rules()` throws on a rule that is a direct alias to itself. This function's
    // contract is `null` — "leave it interpreted" — not a thrown build failure, and
    // the interpreter accepts the same shape, so the caller's existing fallback is
    // the right answer. Anything else is a real defect and must not be swallowed.
    if (e instanceof Error && /cannot be a direct alias to itself/.test(e.message)) return null
    throw e
  }

  /*
   * DECLARED KEYS ONLY, in DECLARATION order.
   *
   * `rules()` returns its whole cache, which also holds a placeholder for every
   * EXTERNAL name the factory touched — a `g.X` provided by another piece. Those
   * are references, not rules of this map, and handing them back would mint
   * `rule:` ids this grammar does not define, widen the coverage denominator and
   * put an undefined slot in the emitted map. The previous implementation
   * returned only its own `ruleRefs` for the same reason; this preserves that
   * contract exactly while letting `rules()` own everything else.
   */
  const map = new Map<string, Combinator<unknown>>()
  for (const key of keys) map.set(key, built[key]!)
  return map
}

/** A combinator slot created by ref() — has a callable `define`. */
type DefinableRef = Combinator<unknown> & { define(p: Combinator<unknown>): void }

function isDefinableRef(v: unknown): v is DefinableRef {
  return isCombinator(v)
    && typeof (v as { define?: unknown }).define === 'function'
    && (v as { _def: { tag?: string } })._def.tag === 'lazy'
}

/**
 * If `init` is a bare `ref()` call, evaluate it to a real ref placeholder and
 * register it in scope under `name`. Returns the ref, or null if `init` isn't
 * a `ref()` call. Used by the macro pre-pass so standalone refs resolve before
 * compilation (parity with the interpreter / compile()).
 */
export function evaluateRefDeclaration(
  init: Expression,
  name: string,
  scope: Scope,
): DefinableRef | null {
  if (init.type !== 'CallExpression') return null
  const callee = (init as unknown as { callee: { type: string; name?: string } }).callee
  if (callee.type !== 'Identifier' || callee.name !== 'ref') return null
  if ((init as unknown as { arguments: unknown[] }).arguments.length !== 0) return null
  const slot = ref<unknown>() as DefinableRef
  ;(scope as XScope).set(name, { combi: slot, mfSrcs: [] } satisfies ScopeEntry)
  return slot
}

/**
 * Apply a `someRef.define(expr)` statement: resolve the target ref from scope,
 * evaluate the argument to a combinator, and call `.define()`. Returns true on
 * success. The macro removes the original statement from the output (it would
 * otherwise reference the stripped import); returning false signals "leave it".
 */
export function applyDefineStatement(
  callExpr: Expression,
  scope: Scope,
  code: string,
): boolean {
  if (callExpr.type !== 'CallExpression') return false
  const callee = (callExpr as unknown as { callee: { type: string } }).callee
  if (callee.type !== 'MemberExpression') return false
  const mem = callee as unknown as { object: { type: string; name?: string }; property: { type: string; name?: string }; computed: boolean }
  if (mem.computed) return false
  if (mem.property.type !== 'Identifier' || mem.property.name !== 'define') return false
  if (mem.object.type !== 'Identifier' || !mem.object.name) return false

  const target = (scope as XScope).get(mem.object.name)
  const refCombi = isScopeEntry(target) ? target.combi : (isCombinator(target) ? target : null)
  if (!refCombi || !isDefinableRef(refCombi)) return false

  const args = (callExpr as unknown as { arguments: Array<{ type: string }> }).arguments
  if (args.length !== 1 || args[0]!.type === 'SpreadElement') return false
  const inner = anyValue(args[0] as unknown as Expression, scope as XScope, code, [])
  if (!isCombinator(inner)) return false

  try { refCombi.define(inner) } catch { return false }
  return true
}

/** Check if an AST node references any name from the given scope or names set. */
export function referencesAny(node: Node, names: Set<string>, scope: Scope): boolean {
  if (node.type === 'Identifier') {
    return names.has(node.name) || scope.has(node.name)
  }
  for (const key of Object.keys(node) as (keyof typeof node)[]) {
    const child = node[key]
    if (!child || typeof child !== 'object') continue
    if (Array.isArray(child)) {
      if (child.some(c => c && typeof c === 'object' && 'type' in c && referencesAny(c as Node, names, scope))) return true
    } else if ('type' in child) {
      if (referencesAny(child as Node, names, scope)) return true
    }
  }
  return false
}
