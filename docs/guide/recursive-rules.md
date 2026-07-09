# Recursive rules

Real grammars are recursive: a JSON value contains arrays, which contain values. To let
combinators reference each other by name — including before they're defined — use
`rules()`.

## `rules()`

Pass a factory that receives all rule names as ready-to-use references and returns the
definitions. Any rule can reference any other through the `g` argument, regardless of
declaration order.

> **Rule names must be valid JavaScript identifiers** (`Value`, `valueList`, `$foo_1`).
> They compile to `_r_<Name>` functions and cross-artifact dispatch guards, so a
> non-identifier key like `'my-rule'` is rejected at compile time with a clear error
> rather than silently mangled. (This is about the *grammar's* rule names — not the
> text your grammar parses, which can be anything.)

```ts
import { rules, parser, choice, sequence, literal, sepBy, transform, trivia, regex } from 'parseman'
import type { Combinator } from 'parseman'

type JSON = null | boolean | number | string | JSON[] | Record<string, JSON>

const ws = trivia(regex(/[ \t\n\r]*/))

const { value } = rules<{ value: Combinator<JSON> }>(g => {
  const comma = literal(',')

  const array = transform(
    sequence(literal('['), sepBy(g.value, comma), literal(']')),
    ([, items]) => items as JSON[]
  )
  const pair = transform(
    sequence(jsonString, literal(':'), g.value),
    ([key, , val]) => [key, val] as [string, JSON]
  )
  const object = transform(
    sequence(literal('{'), sepBy(pair, comma), literal('}')),
    ([, pairs]) => Object.fromEntries(pairs) as Record<string, JSON>
  )

  return {
    value: choice(object, array, jsonString, jsonNumber, jsonBool, jsonNull) as Combinator<JSON>,
  }
})

export const jsonParser = parser({ trivia: ws }, value)
jsonParser.parse('{ "a": 1 }')
```

`g.value` is a reference that works anywhere inside the factory regardless of order.

### Which rules go in the returned object?

- **Local helpers** that don't need to be cross-referenced (`comma`, `pair`, `object`
  above) can be plain `const`.
- **Only put a rule in the returned object** if other rules need to reach it as `g.xxx`,
  or if you'll call it directly (e.g. as a start rule, or as an entry in the registry for
  [incremental re-parsing](./incremental)).

Each rule returned from the factory is independently callable — that returned object *is*
the "rule registry" that incremental re-parsing needs.

## Grammar-level options — `rules({ trivia }, factory)`

Pass an **options object first** — mirroring `parser({ trivia }, combinator)` — to set
options **once for the whole grammar**, instead of wrapping rules individually. Today that's
`trivia`, the ambient whitespace/comment skipping:

```ts
const rw = trivia(oneOrMore(choice(ws, comment)))

const grammar = rules({ trivia: rw }, (g) => ({
  Stylesheet: many(g.Rule),
  Rule:       sequence(g.Selector, literal('{'), many(g.Declaration), literal('}')),
  // …every rule below skips `rw` between its terms, automatically…
}))
```

Every rule inherits `rw` — reached from any entry, **including incremental parsing of a
single rule** (`run(grammar.Rule, …)` skips trivia too). You do **not** wrap individual rules
in `parser({ trivia: rw })`; doing so is redundant. Reach for `parser({ trivia })` /
`noTrivia` only to *override* the grammar trivia inside a sub-region — see
[Whitespace & trivia → local overrides](./trivia#local-overrides-set-once-override-when-needed).

This is the same option `parser({ trivia }, combinator)` takes; `rules()` applies it to the
whole grammar, `parser()` applies it to one wrapped combinator. Use whichever matches the
scope — you don't need both.

It's fine to return your trivia rule itself from the factory (e.g. `rw`, so a driver can
reach it as `g.rw`): a `trivia()` rule is automatically **excluded** from the grammar-level
trivia, so it never recursively skips filler within itself.

## `rules()` and the macro

The plugin fully compiles `rules()` factories, **including recursive ones**. Each rule
becomes a named function derived from its rule name (`_r_<Name>`) and mutual references
are direct calls to those names, so the cycle is broken with zero dispatch. Add
`with { type: 'macro' }` to your import and the entire grammar — recursive rules
included — is inlined at build time. Both binding forms compile:

```ts
const { value } = rules(…)   // each rule becomes a top-level function
const grammar   = rules(…)   // an object literal of compiled rules; grammar.value(…) works
```

If the plugin meets a macro-imported declaration it can't compile statically (it closes
over a runtime value, or isn't a recognized combinator shape), it leaves that
declaration for the interpreter, strips the `with { type: 'macro' }` attribute so the
import stays valid, and emits a build **warning** pointing at it — so a silent fallback
never goes unnoticed. See [Macro mode](./macro-mode).

## `ref<T>()` — the low-level primitive

`rules()` handles forward references automatically. `ref<T>()` is the lower-level
primitive it uses internally, exposed for the rare case where you need a single forward
slot outside a `rules()` call:

```ts
import { ref, choice } from 'parseman'

const value = ref<JSON>()
// … build parsers that use value …
value.define(choice(object, array, str, num, bool, nil))
```

Prefer `rules()` in almost all cases — it's clearer and it's what the macro is tuned to
compile.

## Reusing one factory with different config

This is a different lever from [extending a grammar](./extending): there you take an
existing grammar and **override its rules by name** with `compose()`. Here you have a
*single* factory you want to reuse with a different setting (trivia, document shape) —
don't copy it, export what stays the same and pass in (or wrap) what changes. The
`examples/json/` directory is the template:

| File | What changes |
| --- | --- |
| `parser.ts` | Base grammar + `makeJSONParser(customWs)` |
| `jsonc.ts` | Trivia only — `makeJSONParser(jsoncWs)` |
| `jsonl.ts` | Document shape — `sepBy(jsonValue, '\n')` with tighter trivia |

```ts
// jsonc.ts — same recursive grammar, different trivia
export const jsoncValue = makeJSONParser(jsoncWs)

// jsonl.ts — reuse jsonValue, wrap at the top
export const jsonl = parser({ trivia: lineWs }, sepBy(jsonValue, literal('\n')))
```

Two levers: **unchanged core → parameterize** (pass trivia into the factory); **unchanged
rule, different document → wrap the export**.
