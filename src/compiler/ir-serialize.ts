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
import type { Combinator, DispatchMatcherCase, ParserDef } from '../types.ts'
import { rules } from '../combinators/parser.ts'
import { ref } from '../combinators/ref.ts'
import { regex } from '../combinators/regex.ts'
import { literal } from '../combinators/literal.ts'
import { keywords } from '../combinators/keywords.ts'
import { sequence } from '../combinators/sequence.ts'
import { choice } from '../combinators/choice.ts'
import { dispatch, endsWith, matches, otherwise, routed, startsWith, when } from '../combinators/dispatch.ts'
import { attempt } from '../combinators/attempt.ts'
import { many, oneOrMore, optional, sepBy, keepSeparator } from '../combinators/repeat.ts'
import { not } from '../combinators/not.ts'
import { peek } from '../combinators/peek.ts'
import { node } from '../combinators/node.ts'
import { parser } from '../combinators/grammar.ts'
import { scanTo, balanced, type BalancedAmbient } from '../combinators/scanTo.ts'
import { token, leaf } from '../combinators/token.ts'
import { classifiedTrivia, transform, trivia, label, field } from '../combinators/map.ts'
import { analyzeLabeledTrivia } from '../cst/trivia-kinds.ts'
import { expect as expectC } from '../combinators/expect.ts'
import { withCtx } from '../combinators/withCtx.ts'
import { adjacent, notAdjacent } from '../combinators/adjacency.ts'

type Comb = Combinator<unknown>

/** Child combinators of a def, in construction order (mirrors codegen's childrenOf). */
function childrenOf(def: ParserDef): Comb[] {
  switch (def.tag) {
    case 'sequence':
    case 'choice':    return def.parsers
    case 'dispatch':  return [def.selector, ...def.cases.map(entry => entry.parser), ...(def.matchers ? def.matchers.map(entry => entry.parser) : []), ...(def.otherwise ? [def.otherwise] : [])]
    case 'many':
    case 'oneOrMore':
    case 'optional':
    case 'attempt':
    case 'transform':
    case 'trivia':
    case 'token':
    case 'leaf':
    case 'label':
    case 'field':
    case 'not':
    case 'peek':
    case 'node':
    case 'withCtx':
    case 'expect':    return [def.parser]
    case 'grammar':   return def.triviaParser ? [def.parser, def.triviaParser] : [def.parser]
    case 'sepBy':     return [def.parser, def.separator]
    case 'scanTo':    return [def.sentinel, ...def.skip]
    case 'routed':    return def.fallback ? [def.fallback] : []
    case 'lazy':
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'adjacency':
    case 'recover':
    case 'unknown':   return []
  }
}

const ruleNameOf = (c: Comb): string | undefined =>
  (c as unknown as { _ruleName?: string })._ruleName

/**
 * A `balanced()` that must re-resolve ambient `scanSkip` into its interior.
 *
 * The obligation is recorded as an OWN PROPERTY (`_balancedAmbient`), deliberately
 * outside `_def`, so every static analysis keeps seeing the eager interior. Structural
 * serialization therefore loses it: the round trip emits the raw interior, the rebuilt
 * object is an ordinary `transform`, and codegen's ambient-rebuild branch never fires.
 * The composed parser then stops at a delimiter hidden inside a string or comment,
 * while the interpreter and a direct compile of the same grammar do not.
 *
 * So a balanced round-trips as the CONSTRUCTOR CALL that built it, not as its lowered
 * shape — the marker is re-created by `balanced()` itself. Its interior is derived, so
 * the serializer treats it as an atom: it is not descended for sharing/recursion
 * analysis (the interior's `self` ref is internal and must not surface as a cycle).
 */
const balancedOf = (c: Comb): { open: string; close: string; ownSkip: Comb[] } | undefined =>
  (c as BalancedAmbient)._balancedAmbient

/** Resolve a lazy's target, or null if it isn't defined yet (external ref). */
function lazyTarget(c: Comb): Comb | null {
  if (c._def.tag !== 'lazy') return null
  try { return c._def.thunk() } catch { return null }
}

class Unserializable extends Error {}

/** `, { min, max, trailing }` — omitted entirely when everything is at its default. */
function repeatOpts(min: number, max: number | undefined, trailing?: string): string {
  const parts: string[] = []
  if (min !== 0) parts.push(`min: ${min}`)
  if (max !== undefined) parts.push(`max: ${max}`)
  if (trailing !== undefined) parts.push(`trailing: ${JSON.stringify(trailing)}`)
  return parts.length === 0 ? '' : `, { ${parts.join(', ')} }`
}

function projectOpt(project: Extract<ParserDef, { tag: 'node' }>['project']): string | undefined {
  if (project === undefined) return undefined
  return `project: ${project}`
}

function tagsOpt(tags: Extract<ParserDef, { tag: 'node' }>['tags']): string | undefined {
  if (tags === undefined || tags.length === 0) return undefined
  return `tags: ${JSON.stringify(tags)}`
}

function matcherExpr(entry: DispatchMatcherCase): string {
  switch (entry.kind) {
    case 'startsWith':
      return `startsWith(${JSON.stringify(entry.value)})`
    case 'endsWith':
      return `endsWith(${JSON.stringify(entry.value)})`
    case 'matches':
      return `matches(${new RegExp(entry.value, entry.flags ?? '').toString()})`
  }
}

export function serializeRuleMap(
  ruleMap: ReadonlyArray<readonly [string, Comb]>,
  scanSkip?: readonly Comb[] | null,
): string | null {
  try {
    return new Serializer(ruleMap, scanSkip ?? []).run()
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
  // source only. Macro-only validation metadata is carried as plain data: this
  // runtime module never parses callback source or imports a compiler frontend.
  const _tf = (child: Comb, src: string, recognitionOnly = false): Comb => {
    let fn: (...a: unknown[]) => unknown
    // eslint-disable-next-line no-eval
    try { fn = (0, eval)(`(${src})`) } catch { fn = () => { throw new Error('IR transform fn not materialized') } }
    const t = transform(child as never, fn as never)
    ;(t._def as { fnSrc?: string }).fnSrc = src
    if (recognitionOnly) (t._def as { recognitionOnly?: boolean }).recognitionOnly = true
    return t as Comb
  }
  const _lf = (child: Comb, src: string): Comb => {
    let fn: (...a: unknown[]) => unknown
    // eslint-disable-next-line no-eval
    try { fn = (0, eval)(`(${src})`) } catch { fn = () => { throw new Error('IR leaf fn not materialized') } }
    const l = leaf(child as never, fn as never)
    ;(l._def as { fnSrc?: string }).fnSrc = src
    return l as Comb
  }
  const _nd = (type: string, child: Comb, src: string, opts?: unknown, staticError?: readonly string[], sigSrc?: string, buildImports?: ReadonlyArray<{ local: string; source: string; imported: string }>, rawUnused?: true, childrenUnused?: true): Comb => {
    if (staticError !== undefined && staticError.length > 0) {
      // Fail closed: a builder with an un-rescuable binding is NOT fused. The
      // plugin catches this and leaves the runtime compose() in place rather than
      // shipping a fused table that would ReferenceError on import. Import-rescued
      // free names never reach here — they ride in `buildImports`, not `staticError`.
      throw new Error(`IR direct node builder for ${type} must be macro-static and self-contained; unsupported binding(s): ${staticError.join(', ')}`)
    }
    // A serialized direct builder needs an inert sentinel as well as buildSrc.
    // `node(..., undefined)` is structural, so re-lowering a composed artifact
    // silently routes it through ctx.build/default CST even though the IR still
    // carries the callback source. The compiler is the only consumer that may
    // materialize `buildSrc`; raw IR interpretation deliberately rejects direct
    // builders rather than evaluating arbitrary captured source at runtime.
    const n = node(type, child as never, (() => { throw new Error('IR node build requires static re-lowering') }) as never, opts as never)
    ;(n._def as { buildSrc?: string; buildStaticError?: readonly string[] }).buildSrc = src
    if (staticError !== undefined) (n._def as { buildStaticError?: readonly string[] }).buildStaticError = staticError
    // Analysis-only resolved reducer signature (see `buildAnalysisSrc`). Without it a
    // re-lowered composed artifact silently re-acquires the fail-open capture cost the
    // authoring module had already resolved away.
    if (sigSrc !== undefined) (n._def as { buildSigSrc?: string }).buildSigSrc = sigSrc
    if (rawUnused === true) (n._def as { buildRawUnused?: true }).buildRawUnused = true
    if (childrenUnused === true) (n._def as { buildChildrenUnused?: true }).buildChildrenUnused = true
    // Re-attach the direct-builder import provenance so the plugin's re-lower pass
    // can re-emit the imports into the consuming module. Plain data — this runtime
    // module never resolves or emits imports itself.
    if (buildImports !== undefined) (n._def as { buildImports?: ReadonlyArray<{ local: string; source: string; imported: string }> }).buildImports = buildImports
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
    'rules', 'ref', 'regex', 'literal', 'keywords', 'sequence', 'choice', 'dispatch', 'when', 'startsWith', 'endsWith', 'matches', 'otherwise', 'routed', 'attempt',
    'many', 'oneOrMore', 'optional', 'sepBy', 'keepSeparator', 'not', 'peek', 'node', 'parser',
    'scanTo', 'balanced', 'token', 'leaf', 'transform', 'trivia', 'classifiedTrivia', 'label', 'field', 'expect', 'adjacent', 'notAdjacent', '_tf', '_lf', '_nd', '_gch', '_wc',
    `return (${ir})`,
  )
  const map = fn(
    rules, ref, regex, literal, keywords, sequence, choice, dispatch, when, startsWith, endsWith, matches, otherwise, routed, attempt,
    many, oneOrMore, optional, sepBy, keepSeparator, not, peek, node, parser,
    scanTo, balanced, token, leaf, transform, trivia, classifiedTrivia, label, field, expectC, adjacent, notAdjacent, _tf, _lf, _nd, _gch, _wc,
  ) as Record<string, Comb>
  return Object.entries(map)
}

/** A recursive combinator currently being emitted, and the local `ref()` var that
 * stands in for its back-edge. Frames NEST: an inline recursive combinator inside
 * another one must still be able to name the outer one's ref var. */
type SelfFrame = { comb: Comb; var: string }

class Serializer {
  private counts = new Map<Comb, number>()
  private selfRef = new Set<Comb>()       // combinators reached by an unnamed lazy pointing back into their own subtree
  private cycleInterior = new Set<Comb>() // combinators lying ON a self-reference cycle (strictly below its target)
  private constName = new Map<Comb, string>()
  private emitted = new Set<string>()
  private decls: string[] = []
  private ruleValues = new Set<Comb>()
  private localRuleNames = new Map<Comb, string>()
  private ruleMap: ReadonlyArray<readonly [string, Comb]>
  private scanSkip: readonly Comb[]

  constructor(ruleMap: ReadonlyArray<readonly [string, Comb]>, scanSkip: readonly Comb[] = []) {
    this.ruleMap = ruleMap
    this.scanSkip = scanSkip
    for (const [name, c] of ruleMap) {
      this.localRuleNames.set(c, name)
      this.ruleValues.add(this.body(c))
    }
  }

  /** A grammar-level `scanSkip` unit is an opaque TERMINAL (a string, a balanced
   * bracket) — it must not reach a grammar-rule ref (`g[name]`), because the
   * serialized `scanSkip` array sits in the `rules({ scanSkip })` OPTIONS position,
   * outside the `(g) => …` factory where `g` is bound. A unit that does reference a
   * rule can't be carried in options; bail to the full-pieces fallback. */
  private assertNoRuleRef(c: Comb, seen: Set<Comb>): void {
    if (seen.has(c)) return
    seen.add(c)
    if (c._def.tag === 'lazy') {
      if (ruleNameOf(c) !== undefined) throw new Unserializable('scanSkip unit references a grammar rule')
      const target = lazyTarget(c)
      if (target) this.assertNoRuleRef(target, seen)
      return
    }
    for (const child of childrenOf(c._def)) this.assertNoRuleRef(child, seen)
  }

  /** A `rules()` map wraps each rule value in a named `lazy` proxy; the real body is
   * its target (compileLinkable unwraps the same way). A ref INSIDE a body stays a
   * `g[name]` ref — only the top-level entry is unwrapped. */
  private body(c: Comb): Comb {
    return c._def.tag === 'lazy' && ruleNameOf(c) !== undefined ? (lazyTarget(c) ?? c) : c
  }

  run(): string {
    for (const [, c] of this.ruleMap) this.analyze(this.body(c), new Set())
    for (const c of this.scanSkip) { this.assertNoRuleRef(c, new Set()); this.analyze(c, new Set()) }
    // A shared sub-combinator (count ≥ 2) or a self-ref target gets a const, EXCEPT
    // a top-level rule value (it already lives under its rule name) and EXCEPT a
    // combinator lying on a self-reference cycle.
    //
    // A cycle's single lazy edge is the local `ref()` var bound by the enclosing
    // `ref()/define()` closure, so it is only expressible INSIDE that closure. A
    // hoisted const is emitted outside it, at decl scope, where the ref var does not
    // exist — the back-edge then re-resolves through the cycle target's OWN const and
    // the two decls reference each other eagerly. That is a genuine `const` cycle, and
    // since `emitDecl` pushes the inner decl first it throws at compose time:
    //   const _s1 = many(choice(_s0, …));  const _s0 = (() => { … _s1 … })()
    //   ReferenceError: Cannot access '_s0' before initialization
    // No declaration order fixes it, so cycle-interior nodes are inlined instead. They
    // are re-hoisted by identity on re-lowering; the only cost is IR text, once per
    // reference. `balanced()`'s interior is referenced once, so nothing existing moves.
    let n = 0
    for (const [c, count] of this.counts) {
      if (this.ruleValues.has(c)) continue
      if (this.cycleInterior.has(c)) continue
      if (count >= 2 || this.selfRef.has(c)) this.constName.set(c, `_s${n++}`)
    }
    // Two decl scopes. `scanSkip` is emitted FIRST into `outerDecls` (an IIFE that
    // wraps the whole rules() call) because the `{ scanSkip }` options object
    // precedes the `(g) => …` factory and so cannot see consts declared inside it.
    // A scanSkip unit is grammar-rule free (asserted above), so every const it
    // reaches is g-free and safe in the outer scope; the `emitted` guard then keeps
    // each remaining (factory-only, possibly `g[name]`-referencing) const inside the
    // factory. With no scanSkip, `outerDecls` stays empty and the output is
    // byte-identical to the pre-scanSkip form.
    const outerDecls: string[] = []
    const innerDecls: string[] = []
    let optionsArg = ''
    if (this.scanSkip.length > 0) {
      this.decls = outerDecls
      const units = this.scanSkip.map(c => this.ref(c, []))
      optionsArg = `{ scanSkip: [${units.join(', ')}] }, `
    }
    this.decls = innerDecls
    const body = this.ruleMap
      .map(([name, c]) => `  ${JSON.stringify(name)}: ${this.wrap(this.body(c), [])}`)
      .join(',\n')
    // Shared consts go INSIDE the factory: they can reference `g[name]` rule refs,
    // and `g` only exists in the factory scope.
    const factory = innerDecls.length === 0
      ? `(g) => ({\n${body}\n})`
      : `(g) => {\n${innerDecls.map(d => '  ' + d).join('\n')}\n  return ({\n${body}\n})\n}`
    const call = `rules(${optionsArg}${factory})`
    return outerDecls.length === 0
      ? call
      : `(() => {\n${outerDecls.map(d => '  ' + d).join('\n')}\n  return ${call}\n})()`
  }

  /** Count identity references and flag self-referential subtrees. `active` is the
   * set of combinators on the current DFS path (to detect a lazy pointing back). */
  private analyze(c: Comb, active: Set<Comb>): void {
    const def = c._def
    if (def.tag === 'lazy') {
      if (ruleNameOf(c) !== undefined) return          // named rule ref — resolved by g[name]
      const target = lazyTarget(c)
      if (!target) throw new Unserializable('unresolved unnamed ref')
      if (active.has(target)) {                          // recursion into an ancestor
        this.selfRef.add(target)
        // Everything on the DFS path strictly BELOW `target` is on the cycle. `active`
        // is a Set built in path order, so the suffix after `target` is exactly that
        // path. These must not be hoisted out of the cycle's ref()/define() closure.
        let past = false
        for (const a of active) {
          if (past) this.cycleInterior.add(a)
          else if (a === target) past = true
        }
        return
      }
      this.analyze(target, active)                      // inline (unnamed, non-recursive) — rare
      return
    }
    if (def.tag === 'guard' || def.tag === 'recover' || def.tag === 'unknown') {
      throw new Unserializable(`unsupported tag ${def.tag}`)
    }
    this.counts.set(c, (this.counts.get(c) ?? 0) + 1)
    if ((this.counts.get(c) ?? 0) > 1) return           // already descended
    // A balanced() is an atom: its interior is derived by the constructor, so descending
    // would count derived nodes and mistake its internal `self` ref for a user cycle.
    // Its own skip units are authored, so they are still analyzed.
    const bal = balancedOf(c)
    if (bal) {
      active.add(c)
      for (const unit of bal.ownSkip) this.analyze(unit, active)
      active.delete(c)
      return
    }
    active.add(c)
    for (const child of childrenOf(def)) this.analyze(child, active)
    active.delete(c)
  }

  /** Reference `c`: a const var if it has one (emitting its decl first), else inline.
   * `frames` are the recursive combinators currently open around this position — an
   * unnamed lazy back into any of them emits that frame's ref var instead of recursing.
   * A const is never cycle-interior (see `run`), so its decl is emitted with NO frames:
   * decl scope cannot see any ref var, and it never needs to. */
  private ref(c: Comb, frames: readonly SelfFrame[]): string {
    const cn = this.constName.get(c)
    if (cn) { this.emitDecl(c); return cn }
    // An un-hoisted recursive target still needs its own ref()/define() closure, and
    // the enclosing frames stay lexically visible inside it.
    if (this.selfRef.has(c)) return this.wrap(c, frames)
    return this.expr(c, frames)
  }

  private emitDecl(c: Comb): void {
    const name = this.constName.get(c)!
    if (this.emitted.has(name)) return
    this.emitted.add(name)                              // mark first (cycle-safe)
    this.decls.push(`const ${name} = ${this.wrap(c, [])}`)
  }

  private selfN = 0

  /** Emit `c`'s own constructor call, wrapping it in a `ref()`+`.define()` closure
   * if it is self-referential (an unnamed lazy in its subtree points back to it) —
   * the shape `balanced()` and other recursive library combinators build. */
  private wrap(c: Comb, frames: readonly SelfFrame[]): string {
    if (!this.selfRef.has(c)) return this.expr(c, frames)
    const rv = `_rr${this.selfN++}`
    const bodyExpr = this.expr(c, [...frames, { comb: c, var: rv }])
    return `(() => { const ${rv} = ref(); const _b = ${bodyExpr}; ${rv}.define(_b); return _b })()`
  }

  /** Emit the constructor-call source for `c` (never a const shortcut for `c` itself). */
  private expr(c: Comb, frames: readonly SelfFrame[]): string {
    const def = c._def
    const kid = (x: Comb) => this.ref(x, frames)
    // Re-emit a balanced as its constructor call so `balanced()` re-creates the ambient
    // marker on the far side. `raw: true` balanceds carry no marker and stay structural,
    // which is correct — they opt out of ambient resolution by definition.
    const bal = balancedOf(c)
    if (bal) {
      const skipArg = bal.ownSkip.length === 0 ? '' : `, { skip: [${bal.ownSkip.map(kid).join(', ')}] }`
      return `balanced(${JSON.stringify(bal.open)}, ${JSON.stringify(bal.close)}${skipArg})`
    }
    switch (def.tag) {
      case 'lazy': {
        const name = this.localRuleNames.get(c) ?? ruleNameOf(c)
        if (name !== undefined) return `g[${JSON.stringify(name)}]`
        const target = lazyTarget(c)!
        // Innermost matching frame wins.
        for (let i = frames.length - 1; i >= 0; i--) {
          const f = frames[i]!
          if (f.comb === target) return f.var
        }
        return this.ref(target, frames)
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
      case 'dispatch': {
        const arms = def.cases.map(entry =>
          `when(${entry.keys.length === 1 ? JSON.stringify(entry.keys[0]) : JSON.stringify(entry.keys)}, ${kid(entry.parser)}${entry.caseInsensitive ? ', { caseInsensitive: true }' : ''})`
        )
        if (def.matchers) {
          for (const entry of def.matchers) {
            arms.push(`when(${matcherExpr(entry)}, ${kid(entry.parser)}${entry.caseInsensitive ? ', { caseInsensitive: true }' : ''})`)
          }
        }
        if (def.otherwise) arms.push(`otherwise(${kid(def.otherwise)})`)
        return `dispatch(${kid(def.selector)}${arms.length === 0 ? '' : `, ${arms.join(', ')}`})`
      }
      case 'many':      return `many(${kid(def.parser)}${repeatOpts(def.min, def.max)})`
      // A `oneOrMore` def with min > 1 came from `many(x, { min: n })`; round-trip
      // it through `many` so the bounds survive (oneOrMore defaults min to 1).
      case 'oneOrMore': return def.min === 1 && def.max === undefined
        ? `oneOrMore(${kid(def.parser)})`
        : `many(${kid(def.parser)}${repeatOpts(def.min, def.max)})`
      case 'optional':  return `optional(${kid(def.parser)})`
      case 'attempt':   return `attempt(${kid(def.parser)})`
      // `keepSeparators` is an opt-in expressed at the SEPARATOR, not in the options
      // bag, so it must round-trip as `keepSeparator(sep)` — serializing it as an
      // option would reconstruct a grammar whose call site no longer states its own
      // children arity, which is the exact defect this API shape exists to prevent.
      case 'sepBy':     return `sepBy(${kid(def.parser)}, ${def.keepSeparators ? `keepSeparator(${kid(def.separator)})` : kid(def.separator)}${repeatOpts(def.min, def.max, def.trailing)})`
      case 'not':       return `not(${kid(def.parser)})`
      case 'peek':     return `peek(${kid(def.parser)})`
      case 'routed':   return def.fallback === undefined ? 'routed()' : `routed(${kid(def.fallback)})`
      case 'trivia':    return `trivia(${kid(def.parser)})`
      case 'token':     return `token(${kid(def.parser)})`
      case 'leaf': {
        if (def.fnSrc === undefined) throw new Unserializable('leaf without fnSrc')
        return `_lf(${kid(def.parser)}, ${JSON.stringify(def.fnSrc)})`
      }
      case 'label':     return `label(${JSON.stringify(def.label)}, ${kid(def.parser)})`
      case 'field':     return `field(${JSON.stringify(def.name)}, ${kid(def.parser)})`
      case 'expect':    return `expect(${kid(def.parser)}${def.label !== undefined ? `, ${JSON.stringify(def.label)}` : ''})`
      case 'scanTo':
        return `scanTo(${kid(def.sentinel)}, { skip: [${def.skip.map(kid).join(', ')}]${def.raw ? ', raw: true' : ''}, orEOF: ${def.orEOF} })`
      case 'transform': {
        if (def.fnSrc === undefined) throw new Unserializable('transform without fnSrc')
        // `_tf` sets `_def.fnSrc` so re-lowering INLINES the callback (a plain
        // `transform(child, fn)` would leave fnSrc unset → a non-static runtime
        // callback that emitFusedSource can't inline).
        return `_tf(${kid(def.parser)}, ${JSON.stringify(def.fnSrc)}${def.recognitionOnly ? ', true' : ''})`
      }
      case 'node': {
        if (def.build !== undefined && def.buildSrc === undefined) throw new Unserializable('node build without buildSrc')
        const projectEntry = projectOpt(def.project)
        const tagEntry = tagsOpt(def.tags)
        const optEntries = [
          ...(def.unwrap ? ['unwrap: true'] : []),
          ...(def.collapse ? ['collapse: true'] : []),
          ...(projectEntry === undefined ? [] : [projectEntry]),
          ...(def.captureTrivia ? ['captureTrivia: true'] : []),
          ...(def.trailingTrivia ? ['trailingTrivia: true'] : []),
          // Declared or resolved arity. Carried so a re-lowered composed artifact does
          // not silently re-acquire the fail-open capture cost this module resolved away.
          ...(def.buildArity === undefined ? [] : [`buildArity: ${def.buildArity}`]),
          ...(tagEntry === undefined ? [] : [tagEntry]),
        ]
        const opts = optEntries.length > 0 ? `, { ${optEntries.join(', ')} }` : ''
        // `_nd` sets `_def.buildSrc` (same reason as `_tf`). No build → plain node.
        if (def.type === undefined) {
          if (def.buildSrc !== undefined) throw new Unserializable('inferred node build without inferred type')
          return opts ? `node(${kid(def.parser)}, undefined${opts})` : `node(${kid(def.parser)})`
        }
        if (def.buildSrc !== undefined) {
          // Trailing optionals, emitted only when present so an artifact that carries
          // neither is byte-identical to what previous versions produced.
          const tail: string[] = []
          // Positional args to `_nd`: (…, staticError, sigSrc, buildImports). A later
          // arg being present forces the earlier ones to be emitted (as `undefined`)
          // so the positions line up.
          if (def.buildStaticError !== undefined || def.buildSigSrc !== undefined || def.buildImports !== undefined || def.buildRawUnused === true || def.buildChildrenUnused === true) {
            if (!opts) tail.push('undefined')
            tail.push(def.buildStaticError === undefined ? 'undefined' : JSON.stringify(def.buildStaticError))
          }
          if (def.buildSigSrc !== undefined || def.buildImports !== undefined || def.buildRawUnused === true || def.buildChildrenUnused === true) tail.push(def.buildSigSrc === undefined ? 'undefined' : JSON.stringify(def.buildSigSrc))
          if (def.buildImports !== undefined || def.buildRawUnused === true || def.buildChildrenUnused === true) tail.push(def.buildImports === undefined ? 'undefined' : JSON.stringify(def.buildImports))
          if (def.buildRawUnused === true || def.buildChildrenUnused === true) tail.push(def.buildRawUnused === true ? 'true' : 'undefined')
          if (def.buildChildrenUnused === true) tail.push('true')
          const trailing = tail.length > 0 ? `, ${tail.join(', ')}` : ''
          return `_nd(${JSON.stringify(def.type)}, ${kid(def.parser)}, ${JSON.stringify(def.buildSrc)}${opts}${trailing})`
        }
        return opts ? `node(${JSON.stringify(def.type)}, ${kid(def.parser)}, undefined${opts})` : `node(${JSON.stringify(def.type)}, ${kid(def.parser)})`
      }
      case 'grammar': {
        const classified = def.triviaParser?._meta.rootTriviaClassified === true
        const spec = classified && def.triviaParser ? analyzeLabeledTrivia(def.triviaParser) : null
        if (classified && !spec) throw new Unserializable('classified trivia without labeled arms')
        const trivia = def.clearTrivia
          ? 'null'
          : spec
            ? `classifiedTrivia({ ${spec.arms.map(arm => `${JSON.stringify(arm.label)}: ${kid(arm.parser)}`).join(', ')} })`
            : def.triviaParser ? kid(def.triviaParser) : 'undefined'
        return `parser({ trivia: ${trivia}${def.captureTrivia ? ', captureTrivia: true' : ''}${def.rootCapture ? `, rootCapture: ${JSON.stringify(def.rootCapture)}` : ''}${def.trackLines ? ', trackLines: true' : ''} }, ${kid(def.parser)})`
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
      case 'adjacency':
        return def.polarity === 'adjacent'
          ? 'adjacent()'
          : def.kinds === undefined
            ? 'notAdjacent()'
            : `notAdjacent({ kinds: ${JSON.stringify(def.kinds)} })`
      case 'guard':
      case 'recover':
      case 'unknown':
        throw new Unserializable(`unsupported tag ${def.tag}`)
    }
  }
}
