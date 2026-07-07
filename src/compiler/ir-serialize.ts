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
import { transform, skip, trivia, label } from '../combinators/map.ts'
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
    case 'label':
    case 'not':
    case 'node':
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
    if (e instanceof Unserializable) return null
    throw e
  }
}

/** Reconstruct a rule map from serialized IR (the inverse of `serializeRuleMap`) —
 * evaluate the combinator-construction expression with every constructor in scope.
 * Used at fuse time (runtime linker + build-time plugin) to re-lower carried IR. */
export function evalRuleMapIR(ir: string): Array<[string, Comb]> {
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'rules', 'ref', 'regex', 'literal', 'keywords', 'sequence', 'choice',
    'many', 'oneOrMore', 'optional', 'sepBy', 'not', 'node', 'parser',
    'scanTo', 'transform', 'skip', 'trivia', 'label', 'expect',
    `return (${ir})`,
  )
  const map = fn(
    rules, ref, regex, literal, keywords, sequence, choice,
    many, oneOrMore, optional, sepBy, not, node, parser,
    scanTo, transform, skip, trivia, label, expectC,
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
      case 'not':       return `not(${kid(def.parser)})`
      case 'trivia':    return `trivia(${kid(def.parser)})`
      case 'label':     return `label(${JSON.stringify(def.label)}, ${kid(def.parser)})`
      case 'expect':    return `expect(${kid(def.parser)}${def.label !== undefined ? `, ${JSON.stringify(def.label)}` : ''})`
      case 'skip':      return `skip(${kid(def.main)}, ${kid(def.skipped)})`
      case 'scanTo':
        return `scanTo(${kid(def.sentinel)}, { skip: [${def.skip.map(kid).join(', ')}], orEOF: ${def.orEOF} })`
      case 'transform': {
        if (def.fnSrc === undefined) throw new Unserializable('transform without fnSrc')
        return `transform(${kid(def.parser)}, ${def.fnSrc})`
      }
      case 'node': {
        const build = def.buildSrc !== undefined ? `, ${def.buildSrc}` : def.build !== undefined ? undefined : ''
        if (build === undefined) throw new Unserializable('node build without buildSrc')
        const opts = def.collapse ? `, { collapse: true }` : ''
        // node(type, comb, build?, opts?) — opts only valid when build present.
        if (opts && !build) return `node(${JSON.stringify(def.type)}, ${kid(def.parser)}, undefined${opts})`
        return `node(${JSON.stringify(def.type)}, ${kid(def.parser)}${build}${opts})`
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
