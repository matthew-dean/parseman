<p align="center">
  <img src="https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png" alt="Parséman — 100% Pure Parsing" width="220" />
</p>

# Parséman (PAR-zə-mahn)

Write parsers in TypeScript — fast enough to run as-is, and blazing fast when the bundler macro kicks in. Same grammar either way; no grammar files, no generated output to check in. Drop the plugin in tests or anywhere a bundler isn't around and everything still works.

> **📖 Full documentation: [matthew-dean.github.io/parseman](https://matthew-dean.github.io/parseman/)**

---

## Install

```bash
npm install parseman
# pnpm add parseman
```

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
- **Macro build** — a [bundler plugin](https://matthew-dean.github.io/parseman/guide/macro-mode) evaluates your grammar at build time and replaces it with inline JS. Zero runtime cost; the `parseman` import disappears from the bundle.
- **`.compile()`** — the same optimizer, run on demand at runtime.

```ts
// Add the plugin (vite.config.ts) and one import attribute — that's the whole change:
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

See **[The three modes](https://matthew-dean.github.io/parseman/guide/modes)** for the full story.

## What's in the box

- **[Combinators](https://matthew-dean.github.io/parseman/guide/combinators)** — `literal`, `regex`, `sequence`, `choice`, `many`, `sepBy`, `not`, and more.
- **[Whitespace & trivia](https://matthew-dean.github.io/parseman/guide/trivia)** — grammar-defined filler skipping, with per-chunk kind capture.
- **[Recursive rules](https://matthew-dean.github.io/parseman/guide/recursive-rules)** — `rules()` for mutually recursive grammars; fully macro-compilable.
- **[CST / AST nodes](https://matthew-dean.github.io/parseman/guide/ast)** — `node()` captures terminals and trivia for you, with a `collapse` option for transparent wrapper rules.
- **[Incremental re-parsing](https://matthew-dean.github.io/parseman/guide/incremental)** — `makeFunctionalDoc` re-parses just the edited subtree on each keystroke.
- **[Error recovery](https://matthew-dean.github.io/parseman/guide/error-recovery)** — `recover`, `expect`, and a `{ recover: true }` channel keep parsing broken input and report every error.
- **[Context-sensitive parsing](https://matthew-dean.github.io/parseman/guide/context)** — `withCtx` / `guard` without mutating shared state.

Full API in the **[reference](https://matthew-dean.github.io/parseman/reference/api)**.

---

## Benchmarks

**When parsing to JS values** — objects, row arrays, AST nodes — **Parséman's macro build is the fastest general-purpose JS parser we benchmark**, beating [Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) at every grammar and size. The only thing that edges it out is a purpose-built native like `JSON.parse`; for anything that *doesn't* have a built-in, Parséman is the one to beat.

For **syntax tree building**, the compiled CST path (macro build) beats [Lezer](https://lezer.codemirror.net/) on the JSON CST fixture too — while producing a richer object tree with spans and trivia. For **incremental re-parse**, the two trade places by edit type: Parséman's `makeFunctionalDoc` is ~300× faster than a full reparse on in-place value edits (and ahead of Lezer), while Lezer's buffer reuse wins on structural edits. Full breakdown in the [benchmarks guide](https://matthew-dean.github.io/parseman/guide/benchmarks).

Measured on Apple M2 Pro. Bars show µs per parse — shorter is faster. Refresh: `pnpm bench`, then `pnpm bench:svg` (updates `assets/bench-*.svg`).

Compared parsers: **Parséman**, [Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) (plus `JSON.parse` on JSON). Each implements the same parsing work on the bench fixtures — building JS values / row arrays / GraphQL AST nodes, not syntax-only validation. Peggy grammars in `bench/*.pegjs` are the reference; Nearley JSON uses [kach/nearley `examples/json.ne`](https://github.com/kach/nearley/blob/master/examples/json.ne); other Nearley and Jison grammars are ports of those Peggy files (`bench/vendor/`).

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

Parséman has three modes — **interpreter** (zero setup, works anywhere), **macro build** (compiled by the bundler plugin at build time, zero runtime cost), and **`.compile()`** (optional runtime JIT). Most production use lands on one of the first two. The initialization section only shows parsers with a nonzero setup cost: `.compile()` costs 75–650 µs depending on grammar size; Chevrotain always costs 840–1,400 µs. Parsers not listed there start for free. (Init numbers are pinned on the charts — they're noisy run-to-run; warm-parse bars are the meaningful comparison.)

On JSON, CSV, and GraphQL, Parséman macro beats every other library at every fixture size in the charts above — e.g. GraphQL large **154 µs** vs Peggy **423 µs**, JSON large **125 µs** vs Peggy **472 µs** / Chevrotain **1,946 µs**. Native `JSON.parse` is the one thing faster on JSON (**45 µs** large). Even the zero-setup interpreter beats all five libraries at large sizes. On the CST chart, macro build beats Lezer at every size (**344 µs** vs **587 µs** large, parse-only). Full write-up and how to refresh the charts: **[benchmarks guide](https://matthew-dean.github.io/parseman/guide/benchmarks)**. Grammar-level speed levers: [performance guide](https://matthew-dean.github.io/parseman/guide/performance); library-level codegen: [PERF_IDEAS.md](./PERF_IDEAS.md).

---

## Developing

```bash
pnpm install
pnpm test                   # Vitest — interpreter + compiler parity + ordered-choice semantics
pnpm typecheck              # TypeScript 7
pnpm build                  # ESM + CJS + .d.ts → dist/
pnpm bench                  # Parséman vs Peggy, Parsimmon, Chevrotain, Nearley, Jison
pnpm bench:svg              # refresh assets/bench-*.svg after bench
pnpm bench:compile-grammars # regenerate Peggy / Nearley / Jison parser output in bench/
pnpm docs:dev               # run this documentation site locally
```

## License

MIT © [Matthew Dean](https://github.com/matthew-dean)
