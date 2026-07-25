<p align="center">
  <img src="https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png" alt="Parséman — 100% Pure Parsing" width="220" />
</p>

# Parséman (PAR-zə-mahn)

Write parsers as TypeScript functions. Ship them like hand-written parsers.

Parser combinators are pleasant to write and usually slow. Parser generators are fast and
usually mean grammar files, generated code, and extra tooling. Parséman is a TypeScript
combinator library with an optional compiler: write ordinary TypeScript, and a build-time
macro turns it into flat JavaScript that behaves like a parser you wrote by hand.

Reach for it when you want normal TypeScript instead of grammar files, CST/AST nodes with
spans and trivia, error recovery and incremental re-parsing for editor tooling, or simply
a fast parser for a DSL, config language, formatter, or linter.

> **📖 Full documentation: [matthew-dean.github.io/parseman](https://matthew-dean.github.io/parseman/)**

## Install

```bash
npm install parseman
# pnpm add parseman
```

Pre-1.0: minor versions may carry breaking changes — check the [changelog](./CHANGELOG.md)
before upgrading. Requires Node `^20.19.0 || >=22.12.0`.

## Quick start

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
// { ok: true, value: { verb: 'GET', path: '/api/v1', version: 'HTTP/1.1' }, span: ... }
```

## Three modes, one grammar

The same combinator code runs three ways, with identical results:

- **Interpreter** — zero setup, works anywhere (tests, REPLs, dynamic grammars).
- **Macro build** — a [bundler plugin](https://matthew-dean.github.io/parseman/guide/macro-mode)
  evaluates your grammar at build time and inlines the result. Zero runtime cost; the
  `parseman` import disappears from the bundle.
- **`compile()`** — the same optimizer, on demand at runtime.

```ts
// Add the plugin (vite.config.ts) and one import attribute — that's the whole change:
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

See **[The three modes](https://matthew-dean.github.io/parseman/guide/modes)**.

## What's in the box

- **[Combinators](https://matthew-dean.github.io/parseman/guide/combinators)** — `literal`,
  `regex`, `sequence`, `choice`, `many`, `sepBy`, `token`, `peek`, `not`, and more.
- **[Whitespace & trivia](https://matthew-dean.github.io/parseman/guide/trivia)** —
  grammar-defined filler skipping, with per-chunk kind capture.
- **[Recursive rules](https://matthew-dean.github.io/parseman/guide/recursive-rules)** —
  `rules()` for mutually recursive grammars; fully macro-compilable.
- **[CST / AST nodes](https://matthew-dean.github.io/parseman/guide/ast)** — `node()`
  captures terminals, named fields, and trivia, with policies for wrapping and collapsing.
- **[Incremental re-parsing](https://matthew-dean.github.io/parseman/guide/incremental)** —
  `parseDoc` re-parses just the edited subtree on each keystroke.
- **[Error recovery](https://matthew-dean.github.io/parseman/guide/error-recovery)** —
  keep parsing broken input and report every error.
- **[Context-sensitive parsing](https://matthew-dean.github.io/parseman/guide/context)** —
  `withCtx` / `gate` without mutating shared state.

Full API in the **[reference](https://matthew-dean.github.io/parseman/reference/api)**; how
it stacks up against Peggy, Chevrotain, Lezer, tree-sitter, Parsimmon, Nearley and
hand-written parsers in
**[How Parséman compares](https://matthew-dean.github.io/parseman/guide/comparison)**.

## Benchmarks

Benchmarked against [Peggy](https://peggyjs.org/),
[Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/),
[Nearley](https://nearley.js.org/), [Jison](https://github.com/zaach/jison) and
[Lezer](https://lezer.codemirror.net/) on JSON, CSV and GraphQL — each building real output
(objects, row arrays, AST nodes), not validating syntax.

**Parsing to JS values, the macro build is the fastest general-purpose JS parser in the
suite** — ahead of every library above at every grammar and size (GraphQL large: **142 µs**
vs Peggy's 339 µs). Only a purpose-built native edges it out, `JSON.parse` on JSON.

Two more results worth calling out: the compiled CST path beats Lezer on the JSON CST
fixture while producing a richer tree carrying spans and trivia, and `parseDoc` stores
parent-relative spans so an in-place edit costs a fraction of a full reparse rather than a
multiple of it.

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

Per-fixture figures, initialization costs, hardware, grammar provenance and how to reproduce
any of it: **[benchmarks guide](https://matthew-dean.github.io/parseman/guide/benchmarks)**.
Results move with grammar shape, input size and runtime — which is why the suite ships with
the library rather than only its conclusions. Speed levers for your own grammars:
[performance guide](https://matthew-dean.github.io/parseman/guide/performance).

The GraphQL fixture is a [real grammar](./examples/graphql/parser.ts), parsing executable
documents — queries, mutations, fragments, directives, every value type — into typed AST
nodes, so the numbers come from a spec-shaped language rather than a toy.

## Developing

```bash
pnpm install
pnpm test         # interpreter + compiled parity, ordered-choice semantics
pnpm typecheck
pnpm build        # ESM + CJS + .d.ts → dist/
pnpm docs:dev     # this documentation site, locally
```

Benchmark and chart tasks (`pnpm bench`, `bench:svg`, `bench:parseman`, …) are described in
the [benchmarks guide](https://matthew-dean.github.io/parseman/guide/benchmarks#reproducing-the-numbers).

## License

MIT © [Matthew Dean](https://github.com/matthew-dean)
