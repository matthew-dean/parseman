# The three modes

The central idea in Parséman is that one grammar runs three ways, with identical
results. You write combinators once; the mode only changes *when and how* they're
turned into running code.

| Mode | Setup | Runtime cost | Where it fits |
| --- | --- | --- | --- |
| **Interpreter** | None | Walks the combinator tree per parse | Tests, REPLs, dynamic grammars, anywhere a bundler isn't around |
| **Macro build** | Bundler plugin + `with { type: 'macro' }` | **Zero** — compiled to inline JS at build time | Production apps built with Vite/Rollup/webpack |
| **`.compile()`** | Call `compile()` | One-time JIT, then flat JS | Grammars assembled dynamically at runtime |

Most production use lands on one of the first two; `.compile()` is there for dynamic
grammars that need it.

## Interpreter (the default)

Import a combinator, call `parse()`, done. The interpreter walks the combinator tree
node by node on every parse. There is no build step, no `new Function`, nothing to
configure — it runs in any JavaScript environment.

```ts
import { choice, literal, parse } from 'parseman'

const yesNo = choice(literal('yes'), literal('no'))
parse(yesNo, 'yes') // { ok: true, value: 'yes', … }
```

This is the mode your tests use, and the fallback the other two modes degrade to when
their tooling isn't present.

## Macro build (zero runtime cost)

Register the [bundler plugin](./macro-mode) and add `with { type: 'macro' }` to your
`parseman` import. At build time the plugin evaluates your combinator declarations and
replaces them with inline functions — the `parseman` import disappears from the output
entirely.

```ts
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. If the attribute is ever stripped (older bundlers,
test runners), it's silently ignored and the interpreter runs instead — identical
results, no errors. This is the recommended path for shipping apps. Full details in
[Macro mode](./macro-mode).

## `.compile()` (runtime JIT)

`compile()` runs the *same* optimizer as the plugin, but at runtime. Reach for it when
you assemble a grammar dynamically and can't rely on a build step, or when you just
want the speed without one:

```ts
import { choice, literal, compile } from 'parseman'

const compiled = compile(choice(literal('yes'), literal('no')))
compiled.parse('yes', 0, { trackLines: false }) // { ok: true, value: 'yes', … }
compiled.source                                  // the generated JS source string
compiled.inlineExpression                        // self-contained expr (what the plugin inlines)
```

::: warning Content Security Policy
`compile()` uses `new Function` under the hood, so it cannot run where a strict
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) blocks
`'unsafe-eval'`. Use the interpreter or the macro build plugin in those environments.
:::

Compiling has a per-grammar cost (~75–650 µs depending on grammar size), so it pays off
when you parse many inputs with the same compiled parser.

## Choosing a mode

- **Shipping an app through a bundler?** Use the **macro build** — zero runtime cost,
  and it falls back to the interpreter automatically anywhere the attribute is stripped.
- **Writing tests, scripts, or a REPL?** Use the **interpreter**. It's the default and
  needs nothing.
- **Building a grammar from user input or config at runtime?** Use **`compile()`** if
  the environment allows `new Function`; otherwise stay on the interpreter.

Because all three produce identical results, you can develop against the interpreter and
switch on the macro for production without touching grammar code.

## Debugging compiled grammars

How you debug depends on which mode you're running:

| Mode | What you step through |
| --- | --- |
| **Interpreter** | Your combinator source directly — no compilation, no indirection |
| **Macro build** | Your combinator source via source maps — breakpoints on `choice(...)` lines hit when the compiled function runs |
| **`.compile()`** | Generated JS (`compiled.source`) — no IDE source maps today |

**Interpreter** is the simplest path while you're writing a grammar: you're already
running the combinator tree you wrote.

**Macro build** compiles that tree away, but the [bundler plugin](./macro-mode) emits
precise source maps via [magic-string](https://github.com/Rich-Harris/magic-string).
Step-through in the debugger shows your original combinator source, not the emitted
`codePointAt` dispatch. If `with { type: 'macro' }` is stripped (older bundlers, test
runners), the attribute is silently ignored and the interpreter runs instead — identical
results, no errors.

**`.compile()`** gives you the generated source string for inspection, but does not
currently wire up IDE source maps. Use the interpreter while developing, then macro or
`.compile()` for speed once the grammar is stable.
