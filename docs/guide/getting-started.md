# What is Parséman?

Parséman is a parser-combinator library for TypeScript. You build a grammar out of small
functions — `literal`, `choice`, `sequence`, `many`, and friends — and get back a parser
you can run on any string. No grammar file, no code generator, no build step you have to
remember to run.

> **How should I pronounce "Parséman"?**
>
> Say *parmesan* out loud, then swap the "m" and the "s".

The interesting part is *how* it runs. The **same combinator code** works three ways:

- **Interpreted** — zero setup, runs anywhere. This is what your tests use.
- **Compiled at build time** — a bundler plugin evaluates your grammar and swaps it for an
  optimized table artifact. The combinator import disappears entirely; you still call
  `parse()`.
- **Compiled at runtime** — `compile()` runs the same optimizer on demand, for grammars you
  assemble on the fly.

Nothing generated gets checked into source control, and there's no DSL to learn beyond
ordinary function calls. See [The three modes](./modes) for how to pick one.

## Install

::: code-group

```bash [npm]
npm install parseman
```

```bash [pnpm]
pnpm add parseman
```

```bash [yarn]
yarn add parseman
```

:::

One ESM implementation, plus TypeScript declarations. Supported Node versions can load it
through either `import` or `require()`. There's nothing to configure — import and go.

## Quick start

Here's a parser for an HTTP request line — the first line of every web request you've ever
made — built from five combinators:

```ts
import { literal, sequence, choice, regex, transform, parse } from 'parseman'

const method  = choice(literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'))
const target  = regex(/[^\s]+/)
const version = regex(/1\.[01]/)

const requestLine = transform(
  sequence(method, literal(' '), target, literal(' HTTP/'), version),
  ([verb, , path, , ver]) => ({ verb, path, version: `HTTP/${ver}` })
)

parse(requestLine, 'GET /api/v1 HTTP/1.1')
// { ok: true, value: { verb: 'GET', path: '/api/v1', version: 'HTTP/1.1' }, span: … }
```

Four things worth noticing:

- **`choice`** tries alternatives in order and takes the first that matches. No
  backtracking to find a "better" one — first match wins, and that's the whole rule.
- **`sequence`** matches each term in turn and hands back a tuple of their values.
- **`transform`** reshapes that tuple into whatever you actually want. Here, an object.
- **`parse`** runs a combinator against a string and returns a
  [`ParseResult`](../reference/types#parseresult).

## Reading a result

Every parse hands back a discriminated union, so check `ok` before you touch `value`:

```ts
const r = parse(requestLine, 'GET /api/v1 HTTP/1.1')

if (r.ok) {
  r.value // { verb, path, version }
  r.span  // { start: 0, end: 20 }
} else {
  r.expected // string[] — what the parser wanted at the failure point
  r.span     // where it gave up
}
```

That's the whole surface for a small parser. When you want document-level conveniences —
skipping whitespace, tracking line and column, a reusable `.parse(input)` method — wrap
your root combinator in [`parser()`](./trivia). When you want a real syntax tree, reach for
[`node()`](./ast).

## Where to go next

- **[The three modes](./modes)** — interpreter, macro, or `compile()`, and when each one
  earns its keep.
- **[Combinators](./combinators)** — the full vocabulary of building blocks.
- **[Macro mode](./macro-mode)** — add the plugin, move compilation to build time.
- **[Error recovery](./error-recovery)** — keep parsing, and keep reporting, on input
  that's half-typed or plain broken.
- **[Editor / language-server integration](./editor-integration)** — completions and
  diagnostics for an LSP, over a grammar that never learns the editor exists.

## Developing Parséman itself

```bash
pnpm install
pnpm test        # Vitest — interpreter + compiler parity + ordered-choice semantics
pnpm typecheck   # TypeScript 7
pnpm build       # ESM + .d.ts → dist/
pnpm bench       # vs Peggy, Parsimmon, Chevrotain, Nearley, Jison
pnpm docs:dev    # this documentation site
```
