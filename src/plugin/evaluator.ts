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
    const rec = n as Record<string, unknown> & { type?: string; start?: number; end?: number; expression?: { end?: number } }
    // A whole TS-only node (a type annotation, type-argument list, etc.): drop it.
    if (typeof rec.type === 'string' && rec.type.startsWith('TS') && typeof rec.start === 'number' && typeof rec.end === 'number') {
      // Cast/non-null WRAPPERS keep their expression; only the `as T` / `satisfies T`
      // / `!` suffix after the inner expression is TS. Everything else (annotations,
      // type-argument lists) is dropped whole.
      if ((rec.type === 'TSAsExpression' || rec.type === 'TSSatisfiesExpression' || rec.type === 'TSNonNullExpression') && rec.expression && typeof rec.expression.end === 'number') {
        cuts.push([rec.expression.end, rec.end])
        walk(rec.expression)
        return
      }
      cuts.push([rec.start, rec.end])
      return
    }
    for (const key in rec) {
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
  field:     (...a) => parseman.field(a[0] as string, a[1] as Combinator<unknown>),
  noTrivia:  (...a) => parseman.noTrivia(a[0] as Combinator<unknown>),
  token:     (...a) => parseman.token(a[0] as Combinator<unknown>),
  expect:    (...a) => parseman.expect(a[0] as Combinator<unknown>, a[1] as string | undefined),
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isScopeEntry(v: unknown): v is ScopeEntry {
  return !!v && typeof v === 'object' && 'combi' in v && 'mfSrcs' in v
}

/** Read a non-computed object-property key name (Identifier or Literal), or null. */
function propName(p: ObjectProperty): string | null {
  if (p.computed) return null
  const key = p.key as unknown as { type: string; name?: string; value?: unknown }
  return key.type === 'Identifier' ? key.name ?? null
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

/** Read static `{ unwrap: true }` / `{ collapse: true }` node opts. */
function staticNodeOptions(expr: Expression): parseman.NodeOptions | undefined {
  if (expr.type !== 'ObjectExpression') return undefined
  const opts: parseman.NodeOptions = {}
  for (const prop of (expr as ObjectExpression).properties) {
    const p = prop as unknown as ObjectProperty
    if (p.computed) continue
    const key = p.key as unknown as { type: string; name?: string; value?: unknown }
    const name = key.type === 'Identifier' ? key.name
      : key.type === 'Literal' ? String(key.value)
      : undefined
    if (name === 'unwrap' || name === 'collapse') {
      const val = p.value as unknown as { type: string; value?: unknown }
      if ((val.type === 'Literal' || val.type === 'BooleanLiteral') && val.value === true) opts[name] = true
    }
  }
  return opts.unwrap || opts.collapse ? opts : undefined
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

  // node(parser, build?, opts?) / node(type, parser, build?, opts?) — CST node rule. Capture the build callback
  // source (like transform) so codegen inlines it; the inner parser carries the
  // capture. Optional `{ unwrap: true }` / `{ collapse: true }` opts are read statically.
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
    const hasBuild = be !== undefined && be.type !== 'SpreadElement'
      && !(be.type === 'Identifier' && be.name === 'undefined')
    const buildSrc = hasBuild ? code.slice(be!.start, be!.end) : undefined
    const opts = optsArg !== undefined && optsArg.type !== 'SpreadElement'
      ? staticNodeOptions(optsArg as Expression)
      : undefined
    try {
      const combi = explicitType !== undefined
        ? parseman.node(explicitType, inner, hasBuild ? () => null : undefined, opts)
        : parseman.node(inner, hasBuild ? () => null : undefined, opts)
      if (combi._def.tag === 'node' && buildSrc !== undefined) combi._def.buildSrc = buildSrc
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

  // guard(pred) — context assertion. Capture the predicate source (like
  // transform's fn) so codegen inlines it into `_mf`; build a placeholder guard
  // and stash the source on `_def.predSrc`. Without source-capture context we
  // return null → the whole rule falls back to the (correct) interpreter, never
  // dropping the predicate.
  if (callee.name === 'guard') {
    if (code === undefined || mfs === undefined) return null
    const [predArg] = node.arguments
    if (!predArg || predArg.type === 'SpreadElement') return null
    const predSrc = code.slice((predArg as Expression).start, (predArg as Expression).end)
    mfs.push(predSrc)
    try {
      const combi = parseman.guard(() => true)
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
    const extraSrc = code.slice((extraArg as Expression).start, (extraArg as Expression).end)
    mfs.push(extraSrc)
    const inner = anyValue(innerArg as Expression, scope, code, mfs)
    if (!isCombinator(inner)) return null
    try {
      const combi = parseman.withCtx({}, inner)
      if (combi._def.tag !== 'withCtx') return null
      combi._def.extraSrc = extraSrc
      return combi
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
// (propKey returns null below), so it falls back to the interpreter.
// ---------------------------------------------------------------------------

/** Extract just the property key of a rules() return `Property`, or null
 * (a spread / computed / shorthand-rest property → not statically evaluable). */
function propKey(prop: { type: string; computed?: boolean; key?: { type: string; name?: string; value?: unknown } }): string | null {
  if (prop.type !== 'Property' || prop.computed || !prop.key) return null
  if (prop.key.type === 'Identifier') return prop.key.name ?? null
  if (prop.key.type === 'Literal') return String(prop.key.value)
  return null
}

/** Collect every rule key from a rules() return object. A non-`key: value`
 * property (spread / computed / rest) → null → the caller falls back. */
function collectRuleKeys(retObj: ObjectExpression): string[] | null {
  const out: string[] = []
  for (const prop of (retObj as unknown as { properties: Array<{ type: string }> }).properties) {
    const key = propKey(prop as never)
    if (!key) return null
    out.push(key)
  }
  return out
}

type RuleEntry = { key: string; value: Expression; scope: XScope; code: string }

/** Flatten a rules() return object into ordered (key, valueExpr, evalScope).
 * A non-`key: value` property → null → interpreter fallback. */
function flattenRuleEntries(retObj: ObjectExpression, scope: XScope, code: string): RuleEntry[] | null {
  const out: RuleEntry[] = []
  for (const prop of (retObj as unknown as { properties: Array<{ type: string; value?: unknown }> }).properties) {
    const key = propKey(prop as never)
    if (!key) return null
    out.push({ key, value: (prop as { value: Expression }).value, scope, code })
  }
  return out
}

/** Evaluate a factory body's `const` declarations into `scope`. Returns false on failure. */
function evalBodyStatements(statements: VariableDeclaration[], scope: XScope, code: string): boolean {
  const bodyMfs: string[] = []
  for (const stmt of statements) {
    for (const d of stmt.declarations) {
      const decl = d as unknown as VariableDeclarator
      if (!decl.init) return false
      const id = decl.id as unknown as { type: string; name?: string }
      if (id.type !== 'Identifier' && id.type !== 'BindingIdentifier') return false
      const name = id.name!
      const before = bodyMfs.length
      const val = anyValue(decl.init as unknown as Expression, scope, code, bodyMfs)
      if (val === null) return false
      const thisDeclMfSrcs = bodyMfs.slice(before)
      if (isCombinator(val)) scope.set(name, { combi: val, mfSrcs: thisDeclMfSrcs } satisfies ScopeEntry)
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
  const ruleRefs = new Map<string, Combinator<unknown> & { define(p: Combinator<unknown>): void }>()
  const tagRef = (r: Combinator<unknown>, name: string): void => {
    ;(r as unknown as { _ruleName?: string })._ruleName = name
    if (r._def.tag === 'node' && r._def.type === undefined) r._def.type = name
  }
  for (const key of keys) {
    if (!ruleRefs.has(key)) {
      const r = ref<unknown>() as Combinator<unknown> & { define(p: Combinator<unknown>): void }
      tagRef(r, key)
      ruleRefs.set(key, r)
    }
  }

  // Build local extended scope: outer scope (typed as XScope) + g proxy.
  // The proxy returns a rule ref for ANY name: LOCAL keys get the ref defined in
  // Phase 2; any OTHER name is an EXTERNAL ref — a rule this grammar references
  // but doesn't define, provided by a base grammar it's `compose()`d over. Tagged
  // with `_ruleName`, codegen emits a by-name `_r_<Name>` call (resolved at
  // fusion) instead of trying to inline it. This is what lets an inline delta
  // reference the composed base's rules (`g.Num`, `g.Quoted`, …).
  const externalRefs = new Map<string, Combinator<unknown>>()
  const gProxy = new Proxy(Object.fromEntries(ruleRefs) as Record<string, Combinator<unknown>>, {
    get(target, prop): unknown {
      if (typeof prop !== 'string' || prop in target) return (target as Record<string, unknown>)[prop as string]
      let ext = externalRefs.get(prop)
      if (!ext) { ext = ref<unknown>() as Combinator<unknown>; tagRef(ext, prop); externalRefs.set(prop, ext) }
      return ext
    },
  })

  // Note: outer ScopeEntry values carry their mfSrcs and will be replayed by
  // scopeGet() when body statements or return expressions reference them.
  const localScope: XScope = new Map(scope as XScope)
  localScope.set(proxyName, gProxy)

  // ── Phase 1: evaluate the factory's own body statements ───────────────────
  if (!evalBodyStatements(statements, localScope, code)) return null

  // ── Phase 2: flatten the return object → dedup last-wins → eval + define ──
  // flattenRuleEntries returns the ordered (key, valueExpr, scope). A later property
  // of the same name wins (refs throw on double-define, so each key defines once).
  const entries = flattenRuleEntries(retObj as unknown as ObjectExpression, localScope, code)
  if (!entries) return null
  const finalByKey = new Map<string, RuleEntry>()
  for (const e of entries) finalByKey.set(e.key, e) // set() keeps first insert position, updates value → last wins
  for (const [key, e] of finalByKey) {
    const val = anyValue(e.value, e.scope, e.code, mapFnSources)
    if (!isCombinator(val)) return null
    tagRef(val as Combinator<unknown>, key)
    ruleRefs.get(key)!.define(val as Combinator<unknown>)
  }

  return ruleRefs as Map<string, Combinator<unknown>>
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
