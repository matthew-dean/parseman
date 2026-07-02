# Recursive rules

Real grammars are recursive: a JSON value contains arrays, which contain values. To let
combinators reference each other by name — including before they're defined — use
`rules()`.

## `rules()`

Pass a factory that receives all rule names as ready-to-use references and returns the
definitions. Any rule can reference any other through the `g` argument, regardless of
declaration order.

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

## `rules()` and the macro

The plugin fully compiles `rules()` factories, **including recursive ones**. It emits
mutually recursive named functions (`_pf0`, …) so the cycle is broken. Add
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

## Reusing and extending grammars

Don't copy a `rules()` factory to make a variant — export what stays the same and pass in
(or wrap) what changes. The `examples/json/` directory is the template:

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
