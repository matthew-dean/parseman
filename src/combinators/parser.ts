import type { Combinator } from '../types.ts'
import { ref } from './ref.ts'
import { markUnusedValues } from '../compiler/value-usage.ts'

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
export function rules<T extends Record<string, Combinator<unknown>>>(
  factory: (self: any) => T
): T {
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
        ;(r as unknown as { _ruleName?: string })._ruleName = key
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
    if (placeholder !== undefined && typeof (placeholder as any).define === 'function') {
      ;(placeholder as any).define(parser)
      // Propagate actual first-set so later choices wrapping this ref get correct dispatch.
      placeholder._meta.firstSet = parser._meta.firstSet
      placeholder._meta.canMatchNewline = parser._meta.canMatchNewline
    } else {
      ;(cache as Record<string, Combinator<unknown>>)[key] = parser
    }
  }

  // Dead-value analysis: mark container aggregates that only feed a node()'s
  // capture so the interpreter (and, via the same flag, the compiled output) skips
  // building them. Each rule is its own root — refs are boundaries (see value-usage).
  for (const key of Object.keys(definitions)) {
    markUnusedValues((cache as Record<string, Combinator<unknown>>)[key]!)
  }

  return cache as T
}
