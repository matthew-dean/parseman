# The three modes

The central idea in Parséman is that one grammar runs three ways, with identical
results. You write combinators once; the mode only changes *when and how* they're
turned into running code.

| Mode | Setup | Per-parse work | Where it fits |
| --- | --- | --- | --- |
| **Interpreter** | None | Walks the combinator tree | Tests, REPLs, dynamic grammars, anywhere a bundler isn't around |
| **Macro build** | Bundler plugin + `with { type: 'macro' }` — compiles at build time | Runs the shared table driver over your grammar's table | Production apps built with Vite/Rollup/webpack |
| **`compile()`** | Call `compile()` — one-time build at runtime | Same driver, table built in memory | Grammars assembled dynamically at runtime |

Most production use lands on one of the first two; `compile()` is there for dynamic
grammars that need it.

::: info Recognition was implemented twice; since 0.47.0 it is implemented once
Until 0.47.0 there were **two independent implementations of recognition** behind these
three modes: the interpreter, and a second recogniser the compiler generated per grammar.
Every feature had to be built twice, and the two copies drifted. The differential caught
real divergence — a committed failure inside `many()` under recovery returned `ok: true`
from one and `ok: false` from the other. That is a different *language*, not a different
error message. The second implementation is gone.

`compile()`, `rules()` and `compose()` now emit a **table** — a data literal describing your
grammar, plus your own reducers — which a closure assembler links at run start against the
one shared recogniser in `parseman/table`. Everything else about compiling is unchanged: it
still emits a JavaScript module, still dispatches on character codes, still puts your regexes
in as source literals. One implementation of recognition, not one fewer technique.

Two consequences worth knowing up front. Artifacts are **much smaller**, because the parts
the assembler now resolves once at run start are no longer spelled out per grammar (a
`parser()` grammar went 2,976 B → 860 B). And **no part of building or running one uses
`eval` or `new Function`**, so `compile()` now works under a strict Content Security Policy.
:::

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

## Macro build (no runtime compile step)

Register the [bundler plugin](./macro-mode) and add `with { type: 'macro' }` to your
`parseman` import — standard [import-attributes](./macro-mode#import-attributes) syntax,
with `macro` as the bundler convention for compile-time evaluation. At build time the
plugin evaluates your combinator declarations and replaces them with a table literal. The
import you marked disappears from the output entirely — the combinator set, the compiler and
the analysis passes are all gone from your bundle.

What the plugin puts in their place is one line:

```js
import { tableRules } from 'parseman/table'
```

`parseman/table` is the shared driver: one copy for every grammar in the bundle, and for
every variant of each. Executing the grammar is still a `run()` / `parse()` call, so parseman
stays an ordinary dependency of the code that *drives* the parser. The macro removes the
combinators and the compiler from your bundle; it does not remove the driver.

```ts
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. If the attribute is ever stripped (older bundlers,
test runners), it's silently ignored and the interpreter runs instead — identical
results, no errors. This is the recommended path for shipping apps. Full details in
[Macro mode](./macro-mode).

## `compile()` (runtime build)

`compile()` runs the *same* lowering as the plugin, but at runtime. Reach for it when
you assemble a grammar dynamically and can't rely on a build step, or when you just
want the speed without one:

```ts
import { choice, literal, compile } from 'parseman'

const compiled = compile(choice(literal('yes'), literal('no')))
compiled.parse('yes', 0, { trackLines: false }) // { ok: true, value: 'yes', … }
compiled.source                                  // the artifact as a module (its own `parseman/table` import)
compiled.inlineExpression                        // the artifact as an expression (names `tableRules`)
```

::: tip Content Security Policy — `compile()` no longer needs `'unsafe-eval'`
**Changed in 0.47.0.** `compile()` used to produce its runnable parser by handing emitted
source to `new Function`, so it could not run where a strict
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) blocks
`'unsafe-eval'`. It now assembles the table with ordinary closures instead — no `eval`, no
`new Function` — and runs under a strict CSP unchanged. **If you relaxed a CSP for
parseman, you can put it back.**

Two things on this page still do eval, and both are avoidable:

- a **runtime** `compose()` (no macro) hydrates each carried piece with `new Function`;
- a `node()` builder recovered from a serialized artifact is evaluated on the same path.

Compose at build time with the macro, or ship a `linkable()` artifact, and neither runs.
`compile()`, the interpreter, and a macro-built artifact never do.
:::

Building has a per-grammar cost (111–603 µs on the benchmark grammars, depending on grammar
size), so it pays off when you parse many inputs with the same compiled parser.

## Choosing a mode

- **Shipping an app through a bundler?** Use the **macro build** — no compile step at
  runtime, and it falls back to the interpreter automatically anywhere the attribute is
  stripped.
- **Writing tests, scripts, or a REPL?** Use the **interpreter**. It's the default and
  needs nothing.
- **Building a grammar from user input or config at runtime?** Use **`compile()`** — it
  needs no `eval`, so a strict CSP is no longer a reason to stay on the interpreter.

Because all three produce identical results, you can develop against the interpreter and
switch on the macro for production without touching grammar code.

## Debugging compiled grammars

How you debug depends on which mode you're running:

| Mode | What you step through |
| --- | --- |
| **Interpreter** | Your combinator source directly — no compilation, no indirection |
| **Macro build** | Your combinator source via source maps — breakpoints on `choice(...)` lines hit when the compiled function runs |
| **`compile()`** | The emitted artifact (`compiled.source`) plus the shared driver — no IDE source maps today |

**Interpreter** is the simplest path while you're writing a grammar: you're already
running the combinator tree you wrote.

**Macro build** compiles that tree away, but the [bundler plugin](./macro-mode) emits
precise source maps via [magic-string](https://github.com/Rich-Harris/magic-string).
Step-through in the debugger shows your original combinator source, not the emitted table.
If `with { type: 'macro' }` is stripped (older bundlers, test runners), the attribute is
silently ignored and the interpreter runs instead — identical results, no errors.

**`compile()`** gives you `compiled.source` for inspection, but does not currently wire up
IDE source maps. Note that a table artifact is data: stepping into it lands you in the
shared driver (`parseman/table`), not in code shaped like your grammar. Use the interpreter
while developing, then macro or `compile()` for speed once the grammar is stable.
