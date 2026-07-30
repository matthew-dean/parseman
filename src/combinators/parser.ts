import type { Combinator } from '../types.ts'
import type { HostMode } from '../compiler/codegen.ts'
import { ref } from './ref.ts'
import { markUnusedValues } from '../compiler/value-usage.ts'
import { parser as grammarParser } from './grammar.ts'
import { attachGrammarReflection, collectGrammarReflection, NODE_TAG, NODE_TYPE, type GrammarWithReflection } from '../cst/reflection.ts'

/**
 * Non-enumerable key on a `rules()` result holding the factory's declaration
 * order (the returned object's key order), which differs from the result's own
 * reference-creation key order. Read by `parseman/spec` for source-order output.
 */
export const RULE_ORDER = '__parsemanRuleOrder'

function tagRule(r: Combinator<unknown>, key: string): void {
  ;(r as unknown as { _ruleName?: string })._ruleName = key
  if (r._def.tag === 'node' && r._def.type === undefined) r._def.type = key
}

type DefinableRef = Combinator<unknown> & { define(p: Combinator<unknown>): void }

function isDefinableRef(v: unknown): v is DefinableRef {
  return !!v
    && typeof v === 'object'
    && '_def' in v
    && (v as { _def: { tag?: string } })._def.tag === 'lazy'
    && typeof (v as { define?: unknown }).define === 'function'
}

function ruleNameOf(r: Combinator<unknown>): string | undefined {
  return (r as unknown as { _ruleName?: string })._ruleName
}

function isNamedRuleRefForAnotherRule(r: Combinator<unknown>, key: string): boolean {
  const name = r._def.tag === 'lazy' ? ruleNameOf(r) : undefined
  return name !== undefined && name !== key
}

/**
 * Define named grammar rules without forward declarations.
 *
 * Pass a factory that receives all rule names as references (via a Proxy)
 * and returns a record of combinators. rules() handles creating ref()
 * placeholders and wiring them up — the user never sees ref() at all.
 *
 *   const { value } = rules(g => ({
 *     value:  choice(g.object, g.array, str, num, bool, nil),
 *     object: transform(sequence('{', sepBy(g.pair, ','), '}'), Object.fromEntries),
 *     array:  transform(sequence('[', sepBy(g.value, ','), ']'), ([, items]) => items),
 *     pair:   transform(sequence(g.key, literal(':'), g.value), ([k,, v]) => [k, v]),
 *   }))
 *
 * Not every name in the factory must appear in the returned object — local helpers
 * (like `comma`, `key`) can be plain const inside the factory and composed normally.
 * Only names that OTHER rules reference via `g.xxx` need to be in the returned record.
 *
 * TypeScript: use an explicit type parameter for full type safety on `g`:
 *   rules<{ value: Combinator<JSONValue>; array: Combinator<JSONValue[]> }>(g => ({ ... }))
 * Without it, `g.*` accesses are typed as `any` but the return is still inferred.
 */
/**
 * Grammar-level options for `rules()`. Parity with `parser({...})`, but declared
 * ONCE for the whole grammar instead of wrapped around a scope. `trivia` becomes
 * the ambient trivia for every rule (installed at the parse entry, inherited
 * everywhere, incremental parse included); `parser({trivia})` / `noTrivia` still
 * override it locally for a sub-region.
 */
export type RulesOptions = {
  /** Ambient trivia for the whole grammar. See `parser({ trivia })` for the shape
   * (`null` clears it — equivalent to omitting it at the grammar level). */
  trivia?: Combinator<unknown> | null
  /**
   * Ambient scan-skip for the whole grammar: opaque non-trivia units (strings,
   * balanced brackets, …) that a `scanTo`/`balanced` with no explicit `skip`
   * consults so a sentinel hidden inside one is never matched. Declared ONCE here
   * and inherited everywhere, mirroring `trivia`. `null`/absent = none.
   */
  scanSkip?: Combinator<unknown>[] | null
  /**
   * Compile-time host mode for this grammar, same meaning as `compile(g, { hostMode })`
   * and `compose(items, { hostMode })`: `'ast'` (default) emits each direct builder's
   * own result and NO positioned-CST branch; `'cst'` builds every node through the
   * `ctx.build` host and captures unconditionally.
   *
   * Declaring it HERE is what lets ONE grammar source serve both consumers under the
   * macro, which cannot take a compile option any other way:
   *
   * ```ts
   * const factory = (g: any) => ({ … })
   * export const grammar    = rules({ trivia: rw }, factory)
   * export const cstGrammar = rules({ trivia: rw, hostMode: 'cst' }, factory)
   * ```
   *
   * Two call sites over one factory, so the macro emits two independent top-level
   * artifacts and each bundle tree-shakes away the one it does not import. Neither
   * pays the other's cost — which is the whole reason host mode is a compile-time
   * decision rather than a per-node runtime read.
   *
   * The INTERPRETER routes dynamically off the host and does not need this; it is
   * still recorded, so `run()` can refuse a mismatched host once per parse instead of
   * quietly producing the wrong tree shape.
   */
  hostMode?: HostMode
  /**
   * Compile-time line tracking for this grammar. Under the macro this emits a
   * separate line-aware artifact from the same factory; the default artifact
   * remains free of line-tracking helpers and branches.
   */
  trackLines?: boolean
}

// Options-first, mirroring `parser({ opts }, combinator)` — set once on the grammar
// vs scope it locally, same options in the same position. The bare `rules(factory)`
// form is unchanged. The impl also tolerates the legacy `rules(factory, opts)` order.
type RuleNodeType<K extends string, C> =
  C extends { readonly [NODE_TYPE]?: infer T extends string }
    ? [T] extends [never] ? K : T
    : K

type RuleNodeTag<C> =
  C extends { readonly [NODE_TAG]?: infer Tag extends string } ? Tag : never

type RuleMapNodeType<T extends Record<string, Combinator<unknown>>> = {
  [K in keyof T & string]: RuleNodeType<K, T[K]>
}[keyof T & string]

type RuleMapNodeTag<T extends Record<string, Combinator<unknown>>> = {
  [K in keyof T & string]: RuleNodeTag<T[K]>
}[keyof T & string]

type RulesResult<T extends Record<string, Combinator<unknown>>> =
  T & GrammarWithReflection<RuleMapNodeType<T>, RuleMapNodeTag<T>>

export function rules<T extends Record<string, Combinator<unknown>>>(factory: (self: any) => T): RulesResult<T>
export function rules<T extends Record<string, Combinator<unknown>>>(options: RulesOptions, factory: (self: any) => T): RulesResult<T>
export function rules<T extends Record<string, Combinator<unknown>>>(
  a: ((self: any) => T) | RulesOptions,
  b?: (self: any) => T,
): RulesResult<T> {
  const factory = (typeof a === 'function' ? a : b) as (self: any) => T
  const options = (typeof a === 'function' ? b : a) as RulesOptions | undefined
  const cache: Partial<T> = {}

  // Proxy: accessing any property creates a ref() placeholder on first touch.
  const proxy = new Proxy(cache, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      const record = target as Record<string, Combinator<unknown>>
      if (!(key in record)) {
        const r = ref()
        // Tag the placeholder with its rule name so the linkable compiler can
        // emit a by-name `_r_<key>` call for a reference to a rule defined in
        // ANOTHER artifact (resolved at fuse time) — see compileLinkable.
        tagRule(r, key)
        record[key] = r
      }
      return record[key]
    },
  })

  // Evaluate all rule definitions. JavaScript evaluates object-literal values
  // left-to-right, so any `g.ruleName` access inside triggers placeholder creation
  // before the rule's own parser is built — enabling forward references.
  const definitions = factory(proxy)

  // Fill each ref with its actual definition, or store directly if never accessed via proxy.
  for (const key of Object.keys(definitions)) {
    const placeholder = (cache as Record<string, Combinator<unknown>>)[key]
    const parser = (definitions as Record<string, Combinator<unknown>>)[key]!
    if (placeholder === parser) {
      throw new Error(`rules(): rule "${key}" cannot be a direct alias to itself`)
    }
    if (isDefinableRef(placeholder)) {
      if (!isNamedRuleRefForAnotherRule(parser, key)) tagRule(parser, key)
      placeholder.define(parser)
      // Propagate actual first-set so later choices wrapping this ref get correct dispatch.
      placeholder._meta.firstSet = parser._meta.firstSet
      placeholder._meta.canMatchNewline = parser._meta.canMatchNewline
    } else if (isNamedRuleRefForAnotherRule(parser, key)) {
      const alias = ref()
      tagRule(alias, key)
      alias.define(parser)
      alias._meta.firstSet = parser._meta.firstSet
      alias._meta.canMatchNewline = parser._meta.canMatchNewline
      ;(cache as Record<string, Combinator<unknown>>)[key] = alias
    } else {
      tagRule(parser, key)
      ;(cache as Record<string, Combinator<unknown>>)[key] = parser
    }
  }

  // Declare the grammar-level ambient trivia on every rule, so parsing ANY rule
  // as an entry installs it (run()/parse() read this), and the macro can seed the
  // compiled map. `parser({trivia})` / `noTrivia` still override it locally.
  // `!= null`: a `trivia: null` grammar clears trivia — same as omitting it at the
  // grammar level — so store nothing (and never write null, which has no `_meta`).
  if (options?.trivia != null) {
    for (const key of Object.keys(definitions)) {
      const rule = (cache as Record<string, Combinator<unknown>>)[key]
      // Skip trivia rules (e.g. the grammar's `rw`, returned so the driver can
      // reach it as `g.rw`): a trivia rule must never carry ambient trivia, or it
      // would recursively skip trivia within itself. Mirrors the codegen guard.
      if (rule && !rule._meta.isTrivia) (rule._meta as { grammarTrivia?: Combinator<unknown> }).grammarTrivia = options.trivia
    }
  }

  // Grammar-level ambient scan-skip, mirroring the trivia stamp above: every
  // non-trivia rule carries it so any parse entry installs `ctx.scanSkip` and the
  // compiled map can seed it. `!= null` so `scanSkip: null` clears (stores nothing).
  if (options?.scanSkip != null) {
    for (const key of Object.keys(definitions)) {
      const rule = (cache as Record<string, Combinator<unknown>>)[key]
      if (rule && !rule._meta.isTrivia) (rule._meta as { grammarScanSkip?: Combinator<unknown>[] }).grammarScanSkip = options.scanSkip
    }
  }

  // Grammar-level host mode, mirroring the two stamps above. Only `'cst'` is recorded:
  // `'ast'` is the default everywhere, so stamping it would put a field on every rule of
  // every grammar to say "unchanged". Trivia rules are skipped for the same reason as
  // above — they build no nodes, so the mode is meaningless on them.
  if (options?.hostMode === 'cst') {
    for (const key of Object.keys(definitions)) {
      const rule = (cache as Record<string, Combinator<unknown>>)[key]
      if (rule && !rule._meta.isTrivia) (rule._meta as { grammarHostMode?: HostMode }).grammarHostMode = 'cst'
    }
  }

  if (options?.trackLines === true) {
    for (const key of Object.keys(definitions)) {
      const rule = (cache as Record<string, Combinator<unknown>>)[key]
      if (rule && !rule._meta.isTrivia) (rule._meta as { grammarTrackLines?: true }).grammarTrackLines = true
    }
    for (const key of Object.keys(definitions)) {
      const rule = (cache as Record<string, Combinator<unknown>>)[key]
      if (rule && !rule._meta.isTrivia && rule._def.tag !== 'grammar') {
        const wrapped = grammarParser({ trackLines: true }, rule)
        tagRule(wrapped, key)
        ;(wrapped._meta as { grammarTrackLines?: true }).grammarTrackLines = true
        ;(cache as Record<string, Combinator<unknown>>)[key] = wrapped
      }
    }
  }

  // Dead-value analysis: mark container aggregates that only feed a node()'s
  // capture so the interpreter (and, via the same flag, the compiled output) skips
  // building them. Each rule is its own root — refs are boundaries (see value-usage).
  for (const key of Object.keys(definitions)) {
    markUnusedValues((cache as Record<string, Combinator<unknown>>)[key]!)
  }

  // Record the factory's DECLARATION order (the returned object's key order).
  // `cache`'s own key order is reference-creation order — a Proxy artifact — so
  // it can lead with an internal rule instead of the entry rule. Consumers that
  // want the order the author actually wrote (e.g. `parseman/spec`) read this.
  // Non-enumerable, so Object.keys / spread / for-in over the grammar are
  // unaffected and every existing consumer sees exactly the rules it did before.
  Object.defineProperty(cache, RULE_ORDER, {
    value: Object.keys(definitions),
    enumerable: false,
    configurable: true,
  })
  attachGrammarReflection(cache, collectGrammarReflection(Object.keys(definitions).map(key => [key, (cache as Record<string, Combinator<unknown>>)[key]!])))

  return cache as RulesResult<T>
}
