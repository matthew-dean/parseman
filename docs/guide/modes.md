# The three modes

The central idea in Parséman is that one grammar runs three ways, with identical
results. You write combinators once; the mode only changes *when and how* they're
turned into running code.

| Mode | Setup | Per-parse work | Where it fits |
| --- | --- | --- | --- |
| **Interpreter** | None | Walks the combinator tree | Tests, REPLs, dynamic grammars, anywhere a bundler isn't around |
| **Macro build** | Bundler plugin + `with { type: 'macro' }` — lowers at build time | Runs a table artifact through the shared table runtime; a large terminal `composeLeaf` also embeds one strict assembly | Production apps built with Vite/Rollup/webpack |
| **`compile()`** | Call `compile()` — lowers once at runtime | Runs the same compact table artifact through the shared table runtime | Grammars assembled dynamically at runtime |

Most production use lands on one of the first two; `compile()` is there for dynamic
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

## Macro build (no runtime compile step)

Register the [bundler plugin](./macro-mode) and add `with { type: 'macro' }` to your
`parseman` import — standard [import-attributes](./macro-mode#import-attributes) syntax,
with `macro` as the bundler convention for compile-time evaluation. At build time the
plugin evaluates your combinator declarations and replaces them with a table-program
literal. Ordinary rules and `compose()` remain compact data. A sufficiently large
terminal `composeLeaf()` also carries one build-time strict AST assembly: this deliberately spends generated
grammar bytes to avoid closure linking and reduce parse time, while its tracked and CST
siblings stay compact. The combinator import disappears; every artifact imports only the
shared `parseman/table` runtime rather than copying a parser implementation per grammar.

Executing that grammar is still a `run()` / `parse()` call, so parseman stays an ordinary
import in the code that *drives* the parser. The macro removes the combinators and the
compiler from your bundle; it does not remove the driver.

```ts
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. If the attribute is ever stripped (older bundlers,
test runners), it's silently ignored and the interpreter runs instead — identical
results, no errors. This is the recommended path for shipping apps. Full details in
[Macro mode](./macro-mode).

## `compile()` (runtime lowering)

`compile()` runs the *same* optimizer as the plugin, but at runtime. Reach for it when
you assemble a grammar dynamically and can't rely on a build step, or when you just
want the speed without one:

```ts
import { choice, literal, compile } from 'parseman'

const compiled = compile(choice(literal('yes'), literal('no')))
compiled.parse('yes', 0, { trackLines: false }) // { ok: true, value: 'yes', … }
compiled.source                                  // printable table module source
compiled.inlineExpression                        // table expression (requires tableRules)
```

::: warning Content Security Policy
Compiler-created table artifacts never use `new Function` at build time or parse
time. Runtime `compile()`, ordinary macro rules, and `compose()` carry an explicit
empty assembly inventory (`a:[]`) and use the shared closure assembler. Terminal
large `composeLeaf()` artifacts carry one ordinary function literal for their strict
AST/no-lines assembly; it is emitted by the build, not constructed from source at runtime.
Small leaves remain on the empty-inventory closure form. Both
forms work under a strict [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP).

`test/unit/no-function-constructor.test.ts` proxies `globalThis.Function` across
runtime compilation, macro output, rule-map compilation, and folded variants.
That is the regression gate for this contract. Low-level hand-built table programs
without an `asm` field are not compiler artifacts and may opt into experimental
runtime source emission; public compiler APIs do not take that route.
:::

Compiling has a per-grammar cost (~75–650 µs depending on grammar size), so it pays off
when you parse many inputs with the same compiled parser.

## Choosing a mode

- **Shipping an app through a bundler?** Use the **macro build** — no compile step at
  runtime, and it falls back to the interpreter automatically anywhere the attribute is
  stripped.
- **Writing tests, scripts, or a REPL?** Use the **interpreter**. It's the default and
  needs nothing.
- **Building a grammar from user input or config at runtime?** Use **`compile()`**;
  it creates the same CSP-safe compact table artifact as the macro.

Because all three produce identical results, you can develop against the interpreter and
switch on the macro for production without touching grammar code.

## Debugging compiled grammars

How you debug depends on which mode you're running:

| Mode | What you step through |
| --- | --- |
| **Interpreter** | Your combinator source directly — no compilation, no indirection |
| **Macro build** | Your combinator source via source maps — breakpoints on `choice(...)` lines hit when the compiled function runs |
| **`compile()`** | Generated JS (`compiled.source`) — no IDE source maps today |

**Interpreter** is the simplest path while you're writing a grammar: you're already
running the combinator tree you wrote.

**Macro build** compiles that tree away, but the [bundler plugin](./macro-mode) emits
precise source maps via [magic-string](https://github.com/Rich-Harris/magic-string).
Step-through in the debugger shows your original combinator source, not the emitted
`codePointAt` dispatch. If `with { type: 'macro' }` is stripped (older bundlers, test
runners), the attribute is silently ignored and the interpreter runs instead — identical
results, no errors.

**`compile()`** gives you the generated source string for inspection, but does not
currently wire up IDE source maps. Use the interpreter while developing, then macro or
`compile()` for speed once the grammar is stable.
