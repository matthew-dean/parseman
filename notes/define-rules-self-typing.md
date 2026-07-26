# `defineRules` Self-Key Typing Investigation

Date: 2026-07-26

## Problem

Large grammars often want TypeScript help for `rules(factory)` self references:

```ts
const grammar = rules(g => ({
  Stylesheet: many(g.Rule),
  Rule: sequence(g.Selector, literal('{'), many(g.Declaration), literal('}')),
}))
```

Today, authors who enable `noUncheckedIndexedAccess` usually keep a giant explicit self
type such as:

```ts
type CssSelf = {
  readonly Stylesheet: Combinator<unknown>
  readonly Rule: Combinator<unknown>
  readonly Selector: Combinator<unknown>
  readonly Declaration: Combinator<unknown>
}
```

That avoids `g.Rule` being optional or unknown, but it is duplicated maintenance and it
can drift from the returned rules object.

The important safety constraint: unresolved `g.Missing` must not look sound. Parseman's
runtime proxy can create a placeholder for any property name; the type API must be
stricter than that.

## Rejected Shapes

### Generic overload on `rules(factory)`

This cannot infer self keys soundly from a single callback:

```ts
rules(g => ({
  Stylesheet: many(g.Rule),
  Rule: literal('x'),
}))
```

TypeScript must type `g.Rule` before it has inferred the callback's returned object keys.
An overload can either make `g` broad enough to accept every key, which makes
`g.Missing` look valid, or require an explicit generic, which is the maintenance burden
we are trying to remove.

### `rules.infer(factory)`

Rejected by owner direction and by style: method-shaped cleverness does not fit
Parseman's functional API. If this ships, it should be a standalone function.

### Typed lazy self proxy

A helper such as `self<KeyUnion>()` still asks the author to maintain the key union.
It can improve ergonomics around values, but it does not solve this problem.

## Plausible API

`defineRules(definitions)` is the sound standalone shape:

```ts
const grammar = defineRules({
  Stylesheet: g => many(g.Rule),
  Rule: g => sequence(g.Selector, literal('{'), many(g.Declaration), literal('}')),
  Selector: () => regex(/[.#]?[a-z-]+/),
  Declaration: () => sequence(regex(/[a-z-]+/), literal(':'), regex(/[^;}]+/)),
})
```

Because the object keys are known before each rule-definition function is typed, `g` can
be:

```ts
Readonly<{ [K in keyof Definitions]: Combinator<unknown> }>
```

That means:

- `g.Rule` is available without `| undefined`.
- `g.Missing` is a TypeScript error.
- Each returned parser is still inferred from its own definition function.
- Runtime can reuse the existing `rules()` implementation by translating the object into
  a factory, so grammar behavior, macro lowering, and IR stay aligned.

An options form should mirror `rules`:

```ts
defineRules({ trivia: rw }, {
  Stylesheet: g => many(g.Rule),
  Rule: g => sequence(g.Selector, literal('{'), many(g.Declaration), literal('}')),
})
```

## Open Design Work

- Macro support: the plugin currently recognizes `rules(...)` factories. Shipping
  `defineRules(...)` means teaching macro evaluation to lower an object of rule
  functions without interpreter fallback, including `composeLeaf([...base, defineRules(...)])`.
- Return typing: the likely type is a mapped object preserving each rule function's
  return parser type, not just `Record<string, Combinator<unknown>>`.
- Exact options parity: `trivia`, `scanSkip`, and `hostMode` should have exactly the
  same semantics as `rules({ ... }, factory)`.
- Adoption docs: position `defineRules` as the type-DX form for large grammars, while
  keeping `rules(factory)` as the concise dynamic factory form.

## Recommendation

Do not implement this inside the node projection patch. `defineRules` is plausible and
fits Parseman's functional style, but it deserves its own macro/evaluator tests so it
does not create a type-only API that silently falls back under the macro.
