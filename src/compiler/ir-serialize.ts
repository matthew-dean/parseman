/**
 * Serialize a compiled rule map BACK to a compact combinator-construction source
 * expression — the "IR" a composed grammar carries instead of ~1MB of fully
 * lowered `_r_<Name>` function source. At fuse time the expression is evaluated
 * (with the combinator constructors in scope) to reconstruct the rule map, then
 * re-lowered via `compileLinkable` — identical behaviour, a fraction of the bytes.
 *
 * The output mirrors how a grammar is WRITTEN, not how it lowers:
 *   - a rule reference (`g.Foo`, a `lazy` carrying `_ruleName`) → `g["Foo"]`
 *   - a sub-combinator shared by identity (referenced ≥2×, e.g. a `balanced` const
 *     reused across rules) → a hoisted `const _s<N> = …`, referenced by name, so it
 *     stays shared through the round trip (and `compileLinkable` re-hoists it)
 *   - a self-referential combinator (`balanced`'s internal `self = ref()`) → a
 *     `ref()` + `.define()` closure, the same shape the library combinator emits
 *   - `transform`/`node` callbacks → their captured source (`fnSrc`/`buildSrc`)
 *
 * Returns null if the map can't be faithfully serialized (a callback without
 * source, or an unsupported construct) — the caller then keeps the lowered source.
 */
import type { Combinator, ParserDef } from '../types.ts'
import { rules } from '../combinators/parser.ts'
import { ref } from '../combinators/ref.ts'
import { regex } from '../combinators/regex.ts'
import { literal } from '../combinators/literal.ts'
import { keywords } from '../combinators/keywords.ts'
import { sequence } from '../combinators/sequence.ts'
import { choice } from '../combinators/choice.ts'
import { many, oneOrMore, optional, sepBy } from '../combinators/repeat.ts'
import { not } from '../combinators/not.ts'
import { node } from '../combinators/node.ts'
import { parser } from '../combinators/grammar.ts'
import { scanTo } from '../combinators/scanTo.ts'
import { token } from '../combinators/token.ts'
import { transform, skip, trivia, label, field } from '../combinators/map.ts'
import { expect as expectC } from '../combinators/expect.ts'
import { withCtx } from '../combinators/withCtx.ts'
import { directBuilderUnsupportedBindings } from './inline-callback.ts'

type Comb = Combinator<unknown>

/** Child combinators of a def, in construction order (mirrors codegen's childrenOf). */
function childrenOf(def: ParserDef): Comb[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':    return def.parsers
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'label':
    case 'field':
    case 'not':
    case 'node':
    case 'withCtx':
    case 'expect':    return [def.parser]
    case 'grammar':   return def.triviaParser ? [def.parser, def.triviaParser] : [def.parser]
    case 'sepBy':     return [def.parser, def.separator]
    case 'skip':      return [def.main, def.skipped]
    case 'scanTo':    return [def.sentinel, ...def.skip]
    case 'lazy':
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'recover':
    case 'unknown':   return []
  }
}

const ruleNameOf = (c: Comb): string | undefined =>
  (c as unknown as { _ruleName?: string })._ruleName

/** Resolve a lazy's target, or null if it isn't defined yet (external ref). */
function lazyTarget(c: Comb): Comb | null {
  if (c._def.tag !== 'lazy') return null
  try { return c._def.thunk() } catch { return null }
}

class Unserializable extends Error {}

export function serializeRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Comb]>,
): string | null {
  try {
    return new Serializer(ruleMap).run()
  } catch (e) {
    if (e instanceof Unserializable) {
      if (process.env.PARSEMAN_IR_DEBUG) console.error(`[ir] fallback: ${(e as Error).message}`)
      return null
    }
    throw e
  }
}

/** Reconstruct a rule map from serialized IR (the inverse of `serializeRuleMap`) —
 * evaluate the combinator-construction expression with every constructor in scope.
 * Used at fuse time (runtime linker + build-time plugin) to re-lower carried IR. */
export function evalRuleMapIR(ir: string): Array<[string, Comb]> {
  // `_tf`/`_nd` reconstruct a transform/node AND restore its captured callback
  // source (`_def.fnSrc`/`buildSrc`) so re-lowering inlines it statically. The live
  // fn is only needed for interpreted mode; a self-contained transform source is
  // eval'd, a node build (which may reference imported AST classes) is left to its
  // source only.
  const _tf = (child: Comb, src: string): Comb => {
    let fn: (...a: unknown[]) => unknown
    // eslint-disable-next-line no-eval
    try { fn = (0, eval)(`(${src})`) } catch { fn = () => { throw new Error('IR transform fn not materialized') } }
    const t = transform(child as never, fn as never)
    ;(t._def as { fnSrc?: string }).fnSrc = src
    return t as Comb
  }
  const _nd = (type: string, child: Comb, src: string, opts?: unknown): Comb => {
    const unsupported = directBuilderUnsupportedBindings(src)
    if (unsupported.length > 0) {
      throw new Error(`IR direct node builder must be macro-static and self-contained; unsupported binding(s): ${unsupported.join(', ')}`)
    }
    // A serialized direct builder needs an inert sentinel as well as buildSrc.
    // `node(..., undefined)` is structural, so re-lowering a composed artifact
    // silently routes it through ctx.build/default CST even though the IR still
    // carries the callback source. The compiler is the only consumer that may
    // materialize `buildSrc`; raw IR interpretation deliberately rejects direct
    // builders rather than evaluating arbitrary captured source at runtime.
    const n = node(type, child as never, (() => { throw new Error('IR node build requires static re-lowering') }) as never, opts as never)
    ;(n._def as { buildSrc?: string }).buildSrc = src
    return n as Comb
  }
  // `_gch` rebuilds a GATED choice AND restores its `_def.gateSrcs` (parallel to the
  // arms) — the gate mirror of `_tf`/`_nd`. Each item is either a plain arm or a
  // `[gateSource, arm]` tuple: the source is eval'd to the live predicate (interpreted
  // mode) and recorded as the arm's gateSrcs entry so re-lowering INLINES the gate
  // statically (keeping the artifact fusible via `emitFusedSource`). A missing/failed
  // source falls back to a throwing predicate — the same contract as `_tf`.
  const _gch = (items: Array<Comb | [string, Comb]>): Comb => {
    const gateSrcs: (string | null)[] = []
    const arms = items.map(it => {
      if (Array.isArray(it)) {
        const [src, comb] = it
        gateSrcs.push(src)
        let gate: (s: unknown) => boolean
        // eslint-disable-next-line no-eval
        try { gate = (0, eval)(`(${src})`) } catch { gate = () => { throw new Error('IR gate fn not materialized') } }
        return { gate, combinator: comb }
      }
      gateSrcs.push(null)
      return it
    })
    const c = (choice as (...a: unknown[]) => Comb)(...arms)
    // `choice` is the authority on gate alignment; `gateSrcs` must line up 1:1 with
    // the constructed `_def.gates`. They always do on the normal path (both from the
    // same `items.map`), but assert it so a future change in `choice` that coalesces
    // or drops arms can't silently ship a mis-aligned gate-source array.
    const gates = (c._def as { gates?: unknown[] }).gates
    if (gates && gates.length !== gateSrcs.length) {
      throw new Error(`_gch: gateSrcs length ${gateSrcs.length} != choice gates length ${gates.length}`)
    }
    ;(c._def as { gateSrcs?: (string | null)[] }).gateSrcs = gateSrcs
    return c
  }
  // `_wc` rebuilds a `withCtx` AND restores its `_def.extraSrc` (the source of the
  // `extra`/state value) — the withCtx mirror of `_tf`/`_nd`/`_gch`. The source is
  // eval'd to the live `extra` value (interpreted mode) and recorded on the def so
  // re-lowering INLINES the state getter statically (`() => (extraSrc)`), keeping the
  // artifact fusible via `emitFusedSource`. A plain `withCtx(value, inner)` would
  // leave `extraSrc` unset → codegen emits a source-less runtime closure (a non-static
  // callback) → `emitFusedSource` fails and a downstream `compose()` silently falls
  // back to a runtime fuse. A missing/failed source falls back to `undefined` state —
  // the same best-effort contract as `_tf`.
  const _wc = (src: string, inner: Comb): Comb => {
    let extra: unknown
    // eslint-disable-next-line no-eval
    try { extra = (0, eval)(`(${src})`) } catch { extra = undefined }
    const w = (withCtx as (e: unknown, c: Comb) => Comb)(extra, inner)
    ;(w._def as { extraSrc?: string }).extraSrc = src
    return w
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'rules', 'ref', 'regex', 'literal', 'keywords', 'sequence', 'choice',
    'many', 'oneOrMore', 'optional', 'sepBy', 'not', 'node', 'parser',
    'scanTo', 'token', 'transform', 'skip', 'trivia', 'label', 'field', 'expect', '_tf', '_nd', '_gch', '_wc',
    `return (${ir})`,
  )
  const map = fn(
    rules, ref, regex, literal, keywords, sequence, choice,
    many, oneOrMore, optional, sepBy, not, node, parser,
    scanTo, token, transform, skip, trivia, label, field, expectC, _tf, _nd, _gch, _wc,
  ) as Record<string, Comb>
  return Object.entries(map)
}

class Serializer {
  private counts = new Map<Comb, number>()
  private selfRef = new Set<Comb>()       // combinators reached by an unnamed lazy pointing back into their own subtree
  private constName = new Map<Comb, string>()
  private emitted = new Set<string>()
  private decls: string[] = []
  private ruleValues = new Set<Comb>()
  private ruleMap: ReadonlyArray<readonly [string, Comb]>

  constructor(ruleMap: ReadonlyArray<readonly [string, Comb]>) {
    this.ruleMap = ruleMap
    for (const [, c] of ruleMap) this.ruleValues.add(this.body(c))
  }

  /** A `rules()` map wraps each rule value in a named `lazy` proxy; the real body is
   * its target (compileLinkable unwraps the same way). A ref INSIDE a body stays a
   * `g[name]` ref — only the top-level entry is unwrapped. */
  private body(c: Comb): Comb {
    return c._def.tag === 'lazy' && ruleNameOf(c) !== undefined ? (lazyTarget(c) ?? c) : c
  }

  run(): string {
    for (const [, c] of this.ruleMap) this.analyze(this.body(c), new Set())
    // A shared sub-combinator (count ≥ 2) or a self-ref target gets a const, EXCEPT
    // a top-level rule value (it already lives under its rule name).
    let n = 0
    for (const [c, count] of this.counts) {
      if (this.ruleValues.has(c)) continue
      if (count >= 2 || this.selfRef.has(c)) this.constName.set(c, `_s${n++}`)
    }
    const body = this.ruleMap
      .map(([name, c]) => `  ${JSON.stringify(name)}: ${this.wrap(this.body(c))}`)
      .join(',\n')
    // Shared consts go INSIDE the factory: they can reference `g[name]` rule refs,
    // and `g` only exists in the factory scope.
    if (this.decls.length === 0) return `rules((g) => ({\n${body}\n}))`
    return `rules((g) => {\n${this.decls.map(d => '  ' + d).join('\n')}\n  return ({\n${body}\n})\n})`
  }

  /** Count identity references and flag self-referential subtrees. `active` is the
   * set of combinators on the current DFS path (to detect a lazy pointing back). */
  private analyze(c: Comb, active: Set<Comb>): void {
    const def = c._def
    if (def.tag === 'lazy') {
      if (ruleNameOf(c) !== undefined) return          // named rule ref — resolved by g[name]
      const target = lazyTarget(c)
      if (!target) throw new Unserializable('unresolved unnamed ref')
      if (active.has(target)) { this.selfRef.add(target); return }  // recursion into an ancestor
      this.analyze(target, active)                      // inline (unnamed, non-recursive) — rare
      return
    }
    if (def.tag === 'guard' || def.tag === 'recover' || def.tag === 'unknown') {
      throw new Unserializable(`unsupported tag ${def.tag}`)
    }
    this.counts.set(c, (this.counts.get(c) ?? 0) + 1)
    if ((this.counts.get(c) ?? 0) > 1) return           // already descended
    active.add(c)
    for (const child of childrenOf(def)) this.analyze(child, active)
    active.delete(c)
  }

  /** Reference `c`: a const var if it has one (emitting its decl first), else inline.
   * `selfOf` is the const currently being wrapped in a ref()/define closure — an
   * unnamed lazy back into it emits the local ref var instead of recursing. */
  private ref(c: Comb, selfOf: { comb: Comb; var: string } | null): string {
    const cn = this.constName.get(c)
    if (cn) { this.emitDecl(c); return cn }
    return this.expr(c, selfOf)
  }

  private emitDecl(c: Comb): void {
    const name = this.constName.get(c)!
    if (this.emitted.has(name)) return
    this.emitted.add(name)                              // mark first (cycle-safe)
    this.decls.push(`const ${name} = ${this.wrap(c)}`)
  }

  private selfN = 0

  /** Emit `c`'s own constructor call, wrapping it in a `ref()`+`.define()` closure
   * if it is self-referential (an unnamed lazy in its subtree points back to it) —
   * the shape `balanced()` and other recursive library combinators build. */
  private wrap(c: Comb): string {
    if (!this.selfRef.has(c)) return this.expr(c, null)
    const rv = `_rr${this.selfN++}`
    const bodyExpr = this.expr(c, { comb: c, var: rv })
    return `(() => { const ${rv} = ref(); const _b = ${bodyExpr}; ${rv}.define(_b); return _b })()`
  }

  /** Emit the constructor-call source for `c` (never a const shortcut for `c` itself). */
  private expr(c: Comb, selfOf: { comb: Comb; var: string } | null): string {
    const def = c._def
    const kid = (x: Comb) => this.ref(x, selfOf)
    switch (def.tag) {
      case 'lazy': {
        if (ruleNameOf(c) !== undefined) return `g[${JSON.stringify(ruleNameOf(c))}]`
        const target = lazyTarget(c)!
        if (selfOf && target === selfOf.comb) return selfOf.var
        return this.ref(target, selfOf)
      }
      case 'literal':
        return `literal(${JSON.stringify(def.value)}${def.caseInsensitive ? ', { caseInsensitive: true }' : ''})`
      case 'regex':
        return `regex(${JSON.stringify(def.source)}, ${JSON.stringify(def.flags)})`
      case 'keywords':
        return `keywords(${JSON.stringify(def.words)}, { caseInsensitive: ${def.caseInsensitive}${def.boundary !== undefined ? `, boundary: ${JSON.stringify(def.boundary)}` : ''} })`
      case 'sequence':
        return `sequence(${def.parsers.map(kid).join(', ')})`
      case 'choice': {
        // Ungated choices stay `choice(a, b, …)` byte-for-byte as before.
        const gates = def.gates
        if (gates.every(g => g === null)) return `choice(${def.parsers.map(kid).join(', ')})`
        // A gated choice round-trips through `_gch`, which rebuilds the choice AND
        // re-attaches `_def.gateSrcs` from each arm's captured gate SOURCE. Preserving
        // gateSrcs is load-bearing: on re-lowering, codegen inlines the gate from its
        // source (a static callback), so the re-lowered artifact stays STATICALLY
        // FUSIBLE. A plain `choice({ gate: fn, … })` would rebuild the predicate as a
        // source-less runtime closure → a non-static callback → `emitFusedSource`
        // (macro static fusion) fails and `compose()` silently falls back to a runtime
        // fuse. Without a captured source we cannot re-emit the gate → keep full pieces.
        const gateSrcs = def.gateSrcs
        const items = def.parsers.map((p, i) => {
          if (gates[i] === null) return kid(p)
          const src = gateSrcs?.[i]
          if (src == null) throw new Unserializable('choice gate() has no captured source')
          // `[gateSource, arm]` — `_gch` evals the source to the live predicate and
          // records it as the arm's `gateSrcs` entry.
          return `[${JSON.stringify(src)}, ${kid(p)}]`
        })
        return `_gch([${items.join(', ')}])`
      }
      case 'many':      return `many(${kid(def.parser)})`
      case 'oneOrMore': return `oneOrMore(${kid(def.parser)})`
      case 'optional':  return `optional(${kid(def.parser)})`
      case 'sepBy':     return `sepBy(${kid(def.parser)}, ${kid(def.separator)})`
      case 'not':       return `not(${kid(def.parser)})`
      case 'trivia':    return `trivia(${kid(def.parser)})`
      case 'token':     return `token(${kid(def.parser)})`
      case 'label':     return `label(${JSON.stringify(def.label)}, ${kid(def.parser)})`
      case 'field':     return `field(${JSON.stringify(def.name)}, ${kid(def.parser)})`
      case 'expect':    return `expect(${kid(def.parser)}${def.label !== undefined ? `, ${JSON.stringify(def.label)}` : ''})`
      case 'skip':      return `skip(${kid(def.main)}, ${kid(def.skipped)})`
      case 'scanTo':
        return `scanTo(${kid(def.sentinel)}, { skip: [${def.skip.map(kid).join(', ')}], orEOF: ${def.orEOF} })`
      case 'transform': {
        if (def.fnSrc === undefined) throw new Unserializable('transform without fnSrc')
        // `_tf` sets `_def.fnSrc` so re-lowering INLINES the callback (a plain
        // `transform(child, fn)` would leave fnSrc unset → a non-static runtime
        // callback that emitFusedSource can't inline).
        return `_tf(${kid(def.parser)}, ${JSON.stringify(def.fnSrc)})`
      }
      case 'node': {
        if (def.build !== undefined && def.buildSrc === undefined) throw new Unserializable('node build without buildSrc')
        const opts = def.unwrap || def.collapse
          ? `, { ${def.unwrap ? 'unwrap: true' : 'collapse: true'} }`
          : ''
        // `_nd` sets `_def.buildSrc` (same reason as `_tf`). No build → plain node.
        if (def.type === undefined) {
          if (def.buildSrc !== undefined) throw new Unserializable('inferred node build without inferred type')
          return opts ? `node(${kid(def.parser)}, undefined${opts})` : `node(${kid(def.parser)})`
        }
        if (def.buildSrc !== undefined) return `_nd(${JSON.stringify(def.type)}, ${kid(def.parser)}, ${JSON.stringify(def.buildSrc)}${opts})`
        return opts ? `node(${JSON.stringify(def.type)}, ${kid(def.parser)}, undefined${opts})` : `node(${JSON.stringify(def.type)}, ${kid(def.parser)})`
      }
      case 'grammar': {
        const trivia = def.clearTrivia ? 'null' : def.triviaParser ? kid(def.triviaParser) : 'undefined'
        return `parser({ trivia: ${trivia}${def.trackLines ? ', trackLines: true' : ''} }, ${kid(def.parser)})`
      }
      case 'withCtx': {
        // A `withCtx` round-trips through `_wc`, which rebuilds it AND re-attaches
        // `_def.extraSrc` from the captured `extra` SOURCE. Preserving extraSrc is
        // load-bearing for the same reason as `_tf`/`_gch`: on re-lowering, codegen
        // inlines the state getter from source (a static callback), so the re-lowered
        // artifact stays STATICALLY FUSIBLE. Without a captured source we cannot
        // re-emit the state statically → keep full pieces (interpreter fallback).
        if (def.extraSrc === undefined) throw new Unserializable('withCtx without extraSrc')
        return `_wc(${JSON.stringify(def.extraSrc)}, ${kid(def.parser)})`
      }
      case 'guard':
      case 'recover':
      case 'unknown':
        throw new Unserializable(`unsupported tag ${def.tag}`)
    }
  }
}
