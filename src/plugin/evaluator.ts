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
import { ref } from '../combinators/ref.ts'
import * as parseman from '../index.ts'

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

type WordFactoryEntry = { tag: 'wordFactory'; boundary: string }

function isWordFactory(v: unknown): v is WordFactoryEntry {
  return !!v && typeof v === 'object' && (v as WordFactoryEntry).tag === 'wordFactory'
}

const SUPPORTED: Record<string, (...args: unknown[]) => Combinator<unknown>> = {
  literal:   (...a) => parseman.literal(a[0] as string, a[1] as parseman.LiteralOptions | undefined),
  regex:     (...a) => parseman.regex(a[0] as RegExp, a[1] as string | undefined),
  keywords:  (...a) => parseman.keywords(a[0] as readonly string[], a[1] as parseman.KeywordsOptions | undefined),
  word:      (...a) => parseman.word(a[0] as string, a[1] as string | undefined),
  sequence:  (...a) => (parseman.sequence as (...p: Combinator<unknown>[]) => Combinator<unknown[]>)(...(a as Combinator<unknown>[])),
  choice:    (...a) => (parseman.choice as (...p: Combinator<unknown>[]) => Combinator<unknown>)(...(a as Combinator<unknown>[])),
  many:      (...a) => parseman.many(a[0] as Combinator<unknown>),
  oneOrMore: (...a) => parseman.oneOrMore(a[0] as Combinator<unknown>),
  optional:  (...a) => parseman.optional(a[0] as Combinator<unknown>),
  sepBy:     (...a) => parseman.sepBy(a[0] as Combinator<unknown>, a[1] as Combinator<unknown>),
  trivia:    (...a) => parseman.trivia(a[0] as Combinator<unknown>),
  label:     (...a) => parseman.label(a[0] as string, a[1] as Combinator<unknown>),
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isScopeEntry(v: unknown): v is ScopeEntry {
  return !!v && typeof v === 'object' && 'combi' in v && 'mfSrcs' in v
}

function isCombinator(v: unknown): v is Combinator<unknown> {
  return !!v && typeof v === 'object' && '_def' in v
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

/**
 * Evaluate a call expression to a Combinator.
 * `mfs` accumulates mapFn source texts in depth-first order — must match
 * what codegen pushes to ctx.mapFns when it traverses the same tree.
 */
function exprToCombi(node: Expression, scope: XScope, code?: string, mfs?: string[]): Combinator<unknown> | null {
  if (node.type === 'Identifier') return scopeGet(scope, node.name, mfs)

  if (node.type !== 'CallExpression') return null

  const callee = node.callee

  // makeWord(boundary)(str)
  if (callee.type === 'CallExpression'
    && callee.callee.type === 'Identifier'
    && callee.callee.name === 'makeWord') {
    const boundaryArg = callee.arguments[0]
    const strArg = node.arguments[0]
    if (!strArg || strArg.type === 'SpreadElement') return null
    const boundary = boundaryArg && boundaryArg.type !== 'SpreadElement'
      ? anyValue(boundaryArg as Expression, scope, code, mfs)
      : '_0-9A-Za-z'
    const str = anyValue(strArg as Expression, scope, code, mfs)
    if (typeof boundary !== 'string' || typeof str !== 'string') return null
    try { return parseman.word(str, boundary) } catch { return null }
  }

  if (callee.type === 'Identifier') {
    const factory = scope.get(callee.name)
    if (isWordFactory(factory)) {
      const [strArg] = node.arguments
      if (!strArg || strArg.type === 'SpreadElement') return null
      const str = anyValue(strArg as Expression, scope, code, mfs)
      if (typeof str !== 'string') return null
      try { return parseman.word(str, factory.boundary) } catch { return null }
    }
  }

  if (callee.type !== 'Identifier') return null

  // transform(inner, fn) — capture fn source text before pushing to mfs
  if (callee.name === 'transform' && code !== undefined && mfs !== undefined) {
    const [parserArg, fnArg] = node.arguments
    if (!parserArg || !fnArg || parserArg.type === 'SpreadElement' || fnArg.type === 'SpreadElement') return null
    const inner = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    const fnSrc = code.slice((fnArg as Expression).start, (fnArg as Expression).end)
    mfs.push(fnSrc)
    try {
      const combi = parseman.transform(inner, (v: unknown) => v)
      // Carry the callback source on the def so codegen can pull it in traversal
      // order (order-independent across rules that share sub-combinators).
      if (combi._def.tag === 'transform') combi._def.fnSrc = fnSrc
      return combi
    } catch { return null }
  }

  // node(type, parser, build) — CST node rule. Capture the build callback source
  // (like transform) so codegen inlines it; the inner parser carries the capture.
  if (callee.name === 'node' && code !== undefined) {
    const [typeArg, parserArg, buildArg] = node.arguments
    if (!typeArg || !parserArg || !buildArg
      || typeArg.type === 'SpreadElement' || parserArg.type === 'SpreadElement' || buildArg.type === 'SpreadElement') return null
    const typeVal = anyValue(typeArg as Expression, scope, code)
    if (typeof typeVal !== 'string') return null
    const inner = anyValue(parserArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    const buildSrc = code.slice((buildArg as Expression).start, (buildArg as Expression).end)
    try {
      const combi = parseman.node(typeVal, inner, () => null)
      if (combi._def.tag === 'node') combi._def.buildSrc = buildSrc
      return combi
    } catch { return null }
  }

  // rules(factory) — handled separately by evaluateParserFactory; signal null here
  if (callee.name === 'rules') return null

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

  // sepBy(item, sep) — emitSepBy traverses: item (first probe), sep, item (loop body)
  // We must push item's mfSrcs twice to stay aligned with ctx.mapFns.
  if (callee.name === 'sepBy') {
    const [itemArg, sepArg] = node.arguments
    if (!itemArg || !sepArg || itemArg.type === 'SpreadElement' || sepArg.type === 'SpreadElement') return null
    const itemMfs: string[] = []
    const itemCombi = anyValue(itemArg as Expression, scope, code, itemMfs)
    if (!isCombinator(itemCombi)) return null
    const sepMfs: string[] = []
    const sepCombi = anyValue(sepArg as Expression, scope, code, sepMfs)
    if (!isCombinator(sepCombi)) return null
    if (mfs) mfs.push(...itemMfs, ...sepMfs, ...itemMfs)
    try { return parseman.sepBy(itemCombi, sepCombi) } catch { return null }
  }

  // oneOrMore(item) — emitMany(min=1) traverses: item (mandatory first), item (loop body)
  if (callee.name === 'oneOrMore') {
    const [itemArg] = node.arguments
    if (!itemArg || itemArg.type === 'SpreadElement') return null
    const itemMfs: string[] = []
    const itemCombi = anyValue(itemArg as Expression, scope, code, itemMfs)
    if (!isCombinator(itemCombi)) return null
    if (mfs) mfs.push(...itemMfs, ...itemMfs)
    try { return parseman.oneOrMore(itemCombi) } catch { return null }
  }

  // not(parser) — negative lookahead (consumes nothing).
  if (callee.name === 'not') {
    const [innerArg] = node.arguments
    if (!innerArg || innerArg.type === 'SpreadElement') return null
    const inner = anyValue(innerArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    try { return parseman.not(inner) } catch { return null }
  }

  // balanced(open, close) — a scanTo def used as a scanTo skipper.
  if (callee.name === 'balanced') {
    const [openArg, closeArg] = node.arguments
    if (!openArg || !closeArg || openArg.type === 'SpreadElement' || closeArg.type === 'SpreadElement') return null
    const open = anyValue(openArg as Expression, scope, code, [])
    const close = anyValue(closeArg as Expression, scope, code, [])
    if (typeof open !== 'string' || typeof close !== 'string') return null
    try { return parseman.balanced(open, close) } catch { return null }
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
      if (prop.type !== 'Property') return null
      if ((prop as unknown as ObjectProperty).computed) return null
      const key = (prop as unknown as ObjectProperty).key.type === 'Identifier'
        ? ((prop as unknown as ObjectProperty).key as { name: string }).name
        : (prop as unknown as ObjectProperty).key.type === 'Literal'
        ? String(((prop as unknown as ObjectProperty).key as { value: unknown }).value)
        : null
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
    const propName = (mem.property as { name?: string }).name
    if (!propName) return null
    return (obj as Record<string, unknown>)[propName] ?? null
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (callee.type === 'Identifier' && callee.name === 'makeWord') {
      const boundaryArg = node.arguments[0]
      const boundary = boundaryArg && boundaryArg.type !== 'SpreadElement'
        ? anyValue(boundaryArg as Expression, scope, code, mfs)
        : '_0-9A-Za-z'
      if (typeof boundary !== 'string') return null
      return { tag: 'wordFactory', boundary } satisfies WordFactoryEntry
    }
    return exprToCombi(node, scope, code, mfs)
  }

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Evaluate makeWord(boundary?) to a factory entry (not a combinator). */
export function evaluateWordFactory(
  node: Expression,
  scope: Scope,
  code?: string,
): WordFactoryEntry | null {
  if (node.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type !== 'Identifier' || callee.name !== 'makeWord') return null
  const boundaryArg = node.arguments[0]
  const boundary = boundaryArg && boundaryArg.type !== 'SpreadElement'
    ? anyValue(boundaryArg as Expression, scope as XScope, code)
    : '_0-9A-Za-z'
  if (typeof boundary !== 'string') return null
  return { tag: 'wordFactory', boundary }
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

  // Pre-scan return object to get rule names and create refs
  const ruleRefs = new Map<string, Combinator<unknown> & { define(p: Combinator<unknown>): void }>()
  for (const prop of (retObj as unknown as ObjectExpression).properties) {
    if (prop.type !== 'Property') return null
    if ((prop as unknown as ObjectProperty).computed) return null
    const p = prop as unknown as ObjectProperty
    const key = p.key.type === 'Identifier' ? (p.key as unknown as { name: string }).name
      : p.key.type === 'Literal' ? String((p.key as unknown as { value: unknown }).value)
      : null
    if (!key) return null
    ruleRefs.set(key, ref<unknown>() as Combinator<unknown> & { define(p: Combinator<unknown>): void })
  }

  // Build local extended scope: outer scope (typed as XScope) + g proxy object.
  // Note: outer ScopeEntry values carry their mfSrcs and will be replayed by
  // scopeGet() when body statements or return expressions reference them.
  const localScope: XScope = new Map(scope as XScope)
  localScope.set(proxyName, Object.fromEntries(ruleRefs))

  // ── Phase 1: evaluate body statements ────────────────────────────────────
  // Use a LOCAL accumulator so body-phase mfSrcs don't end up in mapFnSources.
  // Each declaration's mfSrcs slice is stored on the localScope entry so it
  // gets replayed when the return-phase references that declaration.
  const bodyMfs: string[] = []

  for (const stmt of statements) {
    for (const d of stmt.declarations) {
      const decl = d as unknown as VariableDeclarator
      if (!decl.init) return null
      const id = decl.id as unknown as { type: string; name?: string }
      if (id.type !== 'Identifier' && id.type !== 'BindingIdentifier') return null
      const name = id.name!

      const before = bodyMfs.length
      const val = anyValue(decl.init as unknown as Expression, localScope, code, bodyMfs)
      if (val === null) return null

      const thisDeclMfSrcs = bodyMfs.slice(before)
      if (isCombinator(val)) {
        localScope.set(name, { combi: val, mfSrcs: thisDeclMfSrcs } satisfies ScopeEntry)
      } else {
        localScope.set(name, val)
      }
    }
  }

  // ── Phase 2: evaluate return values and define refs ───────────────────────
  // Uses mapFnSources (the caller-provided accumulator) — only these entries
  // will be in mapFnSources when compile() is called on the resulting rules.
  // Scope replay ensures outer and body combinators contribute their mfSrcs.
  for (const prop of (retObj as unknown as ObjectExpression).properties) {
    const p = prop as unknown as ObjectProperty
    const key = p.key.type === 'Identifier' ? (p.key as unknown as { name: string }).name
      : String((p.key as unknown as { value: unknown }).value)
    const val = anyValue(p.value as Expression, localScope, code, mapFnSources)
    if (!isCombinator(val)) return null
    ruleRefs.get(key)!.define(val)
  }

  return ruleRefs as Map<string, Combinator<unknown>>
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
