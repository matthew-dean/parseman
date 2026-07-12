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
    case 'expect':    return [def.parser]
    case 'grammar':   return def.triviaParser ? [def.parser, def.triviaParser] : [def.parser]
    case 'sepBy':     return [def.parser, def.separator]
    case 'precedence': return [def.operand, def.operator]
    case 'skip':      return [def.main, def.skipped]
    case 'scanTo':    return [def.sentinel, ...def.skip]
    case 'lazy':
    case 'literal':
    case 'regex':
    case 'keywords':
    case 'guard':
    case 'withCtx':
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
    const n = node(type, child as never, undefined, opts as never)
    ;(n._def as { buildSrc?: string }).buildSrc = src
    return n as Comb
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'rules', 'ref', 'regex', 'literal', 'keywords', 'sequence', 'choice',
    'many', 'oneOrMore', 'optional', 'sepBy', 'not', 'node', 'parser',
    'scanTo', 'token', 'transform', 'skip', 'trivia', 'label', 'field', 'expect', '_tf', '_nd',
    `return (${ir})`,
  )
  const map = fn(
    rules, ref, regex, literal, keywords, sequence, choice,
    many, oneOrMore, optional, sepBy, not, node, parser,
    scanTo, token, transform, skip, trivia, label, field, expectC, _tf, _nd,
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
    if (def.tag === 'guard' || def.tag === 'withCtx' || def.tag === 'recover' || def.tag === 'unknown') {
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
        if (def.gates.some(g => g !== null)) throw new Unserializable('choice with a gate() has no source')
        return `choice(${def.parsers.map(kid).join(', ')})`
      }
      case 'many':      return `many(${kid(def.parser)})`
      case 'oneOrMore': return `oneOrMore(${kid(def.parser)})`
      case 'optional':  return `optional(${kid(def.parser)})`
      case 'sepBy':     return `sepBy(${kid(def.parser)}, ${kid(def.separator)})`
      case 'precedence': throw new Unserializable('precedence not yet serializable to IR')
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
      case 'guard':
      case 'withCtx':
      case 'recover':
      case 'unknown':
        throw new Unserializable(`unsupported tag ${def.tag}`)
    }
  }
}
