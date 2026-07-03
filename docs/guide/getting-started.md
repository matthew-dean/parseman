# What is Parséman?

Parséman is a parser-combinator library for TypeScript. You describe a grammar by
composing small functions — `literal`, `choice`, `sequence`, `many`, and friends —
and get back a parser you can run on any string.

> **How should I pronounce "Parséman"?**
>
> Say *parmesan* out loud, then swap the "m" and the "s".

What sets Parséman apart is *how* it runs. The **same combinator code** works three
ways:

- **Interpreted** — zero setup, runs anywhere (including tests and REPLs).
- **Compiled at build time** — a bundler plugin evaluates your grammar and replaces
  it with flat, allocation-light JavaScript. The `parseman` import vanishes from the
  bundle.
- **Compiled at runtime** — `compile()` runs the same optimizer on demand, for
  grammars assembled dynamically.

No grammar files. No generated parser to check into source control. No DSL to learn
beyond ordinary function calls. See [The three modes](./modes) for how to choose.

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

Parséman ships ESM and CJS builds plus TypeScript declarations. It has no required
runtime configuration — import and go.

## Quick start

Here's a parser for an HTTP request line, built from five combinators:

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

A few things to notice:

- **`choice`** tries alternatives in order (PEG semantics — first match wins).
- **`sequence`** matches each term in turn and returns a tuple of their values.
- **`transform`** maps that tuple into whatever shape you want — here a plain object.
- **`parse`** runs a combinator against an input string and returns a
  [`ParseResult`](../reference/types#parseresult).

## Reading a result

Every parse returns a discriminated union. Check `ok` before touching `value`:

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

For richer document-level control — whitespace skipping, line/column tracking, a
reusable `.parse(input)` method — wrap your root combinator with
[`parser()`](./trivia). For grammars that build a syntax tree, reach for
[`node()`](./ast).

## Where to go next

- **[The three modes](./modes)** — interpreter vs. macro vs. `compile()`, and when
  each matters.
- **[Combinators](./combinators)** — the full building-block vocabulary.
- **[Macro mode](./macro-mode)** — add the plugin and compile away the runtime cost.
- **[Error recovery](./error-recovery)** — keep parsing (and reporting) on broken
  input.

## Developing Parséman itself

```bash
pnpm install
pnpm test        # Vitest — interpreter + compiler parity + ordered-choice semantics
pnpm typecheck   # TypeScript 7
pnpm build       # ESM + CJS + .d.ts → dist/
pnpm bench       # vs Peggy, Parsimmon, Chevrotain, Nearley, Jison
pnpm docs:dev    # this documentation site
```
