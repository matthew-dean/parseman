<p align="center">
  <img src="https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png" alt="Parséman — 100% Pure Parsing" width="220" />
</p>

# Parséman (PAR-zə-mahn)

Write parsers as ordinary functions. Ship them like hand-written parsers.

Parser combinators are pleasant to write and usually slow. Parser generators are fast and
usually mean grammar files, generated code, and extra tooling. Parséman is a combinator
library with an optional compiler, and it gives you both.

**Parsing to JS values, the macro build is the fastest general-purpose JS parser in the
suite** — ahead of every other library measured, at every grammar and every input size in
that suite.
Every parser in the suite builds real output: objects, row arrays, AST nodes. On a 7.7 kB
GraphQL document Parséman takes **131 µs**; Peggy takes 328 µs. Only a purpose-built native
edges it out, `JSON.parse` on JSON.

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

Two more results. The compiled CST path beats Lezer on the JSON CST fixture — **174 µs** vs
594 µs at 11.9 kB — while producing a richer tree carrying spans and trivia. And `parseDoc`
stores parent-relative spans, so an in-place edit costs a fraction of a full reparse rather
than a multiple of it. Results move with grammar shape, input size and runtime — which is
why [the suite](#benchmarks) ships with the library rather than only its conclusions.

You get there by writing normal code. Add the bundler plugin, mark one import, and the
combinators you already wrote compile to flat JavaScript — the compiler computes the first
sets and left-factors the choices for you.

Grammars work the same in plain JavaScript: the macro compiles a `.js` grammar to the same
output as a `.ts` one, and the package ships both ESM and CJS. Write in TypeScript and result
types are inferred across the whole combinator chain — types you didn't have to write out.

Reach for it when you want CST/AST nodes with spans and trivia, error recovery and
incremental re-parsing for editor tooling, or simply a fast parser for a DSL, config
language, formatter, or linter.

Parséman is scannerless without giving up token-style routing. Literal or first-set-disjoint
alternatives are a natural fit for `choice(...)`; when several branches share a broad opener,
`dispatch(selector, when(...), otherwise(...))` parses that head once, then routes by the
returned value or structural marker. CSS-like grammars use that for at-rules,
identifier-or-function values, media features, and dialect routes where interpolation and
dedicated syntax overlap.

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

New here? **[What is Parséman?](https://matthew-dean.github.io/parseman/guide/getting-started)**
walks the same ground more slowly.

## Three modes, one grammar

The same combinator code runs three ways, with identical results:

- **Interpreter** — zero setup, works anywhere (tests, REPLs, dynamic grammars).
- **Macro build** — a [bundler plugin](https://matthew-dean.github.io/parseman/guide/macro-mode)
  evaluates your grammar at build time and inlines the result. The combinator import you
  mark `with { type: 'macro' }` disappears entirely; what ships is flat JavaScript with no
  parseman import in it. (Executing that parser still goes through `run()`/`parse()`, so an
  app keeps parseman as an ordinary dependency — see
  [the three modes](https://matthew-dean.github.io/parseman/guide/modes).)
- **`compile()`** — the same optimizer, on demand at runtime.

```ts
// Add the plugin (vite.config.ts) and one import attribute — that's the whole change:
import { literal, sequence, choice } from 'parseman' with { type: 'macro' }
```

See **[The three modes](https://matthew-dean.github.io/parseman/guide/modes)**.

## What's in the box

**✍️ Writing grammars**

- 🧩 **[Combinators](https://matthew-dean.github.io/parseman/guide/combinators)** — `literal`,
  `regex`, `sequence`, `choice`, `many`, `sepBy`, `token`, `peek`, `not`, and more.
- 🌀 **[Recursive rules](https://matthew-dean.github.io/parseman/guide/recursive-rules)** —
  `rules()` for mutually recursive grammars; fully macro-compilable.
- 🫧 **[Whitespace & trivia](https://matthew-dean.github.io/parseman/guide/trivia)** —
  grammar-defined filler skipping, with per-chunk kind capture.
- 🎯 **[Ordered choice, done right](https://matthew-dean.github.io/parseman/guide/keywords)** —
  PEG semantics you control by ordering, with keyword boundaries that don't bite.
- 🪶 **[Grammars the way you write them](https://matthew-dean.github.io/parseman/guide/natural-grammars)** —
  no FIRST/FOLLOW sets to compute, no left-factoring `choice(a·x, a·y)` into `a·(x | y)`
  to satisfy the tool. The compiler does that for you.
- 🧬 **[Extending grammars](https://matthew-dean.github.io/parseman/guide/extending)** —
  `compose()` a dialect onto a base grammar instead of forking it.
- 🎛️ **[Context-sensitive parsing](https://matthew-dean.github.io/parseman/guide/context)** —
  `withCtx` / `gate` without mutating shared state.
- 🧭 **[Scannerless routing](https://matthew-dean.github.io/parseman/guide/combinators#dispatch)** —
  `dispatch` parses a broad shared head once and routes at the grammar boundary that matters.

**🌳 Getting structure out**

- 🌲 **[CST / AST nodes](https://matthew-dean.github.io/parseman/guide/ast)** — `node()`
  captures terminals, named fields, and trivia, with policies for wrapping and collapsing.
- 🩹 **[Error recovery](https://matthew-dean.github.io/parseman/guide/error-recovery)** —
  keep parsing broken input and report every error.
- ⚡ **[Incremental re-parsing](https://matthew-dean.github.io/parseman/guide/incremental)** —
  `parseDoc` re-parses just the edited subtree on each keystroke.
- 💡 **[Editor / LSP integration](https://matthew-dean.github.io/parseman/guide/editor-integration)** —
  completions and lint keyed by rule name; the grammar stays pure structure.

**🔬 Seeing what your grammar does**

- 🚂 **[Railroad diagrams & EBNF](https://matthew-dean.github.io/parseman/guide/spec-generation)** —
  `toRailroadHtml()` and `toEBNF()` generate the grammar reference *from the parser*, so
  the spec can't drift from what actually parses.
- 🔎 **[Grammar observability](https://matthew-dean.github.io/parseman/guide/grammar-observability)** —
  coverage ("which rules and choice arms ran?") and trace ("what did it try, select, and
  backtrack through?").
- 🚦 **[First-char gating diagnostics](https://matthew-dean.github.io/parseman/guide/first-char-gating)** —
  `diagnoseGrammar()` tells you which `choice` lost its O(1) dispatch, names the
  overlapping arms, and says how to fix it. Run it in a test or a CI job — compiling
  reports nothing.
- 📈 **[Performance guide](https://matthew-dean.github.io/parseman/guide/performance)** —
  the levers that actually move a grammar, and [how regexes lower](https://matthew-dean.github.io/parseman/guide/regex-lowering).

Full API in the **[reference](https://matthew-dean.github.io/parseman/reference/api)**; how
it stacks up against Peggy, Chevrotain, Lezer, tree-sitter, Parsimmon, Nearley and
hand-written parsers in
**[How Parséman compares](https://matthew-dean.github.io/parseman/guide/comparison)**.

## Benchmarks

Benchmarked against [Peggy](https://peggyjs.org/),
[Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/),
[Nearley](https://nearley.js.org/), [Jison](https://github.com/zaach/jison) and
[Lezer](https://lezer.codemirror.net/) on JSON, CSV and GraphQL, at three input sizes each.
Each chart's legend names the libraries measured for that grammar.

Largest fixture of each, macro build against the fastest other library on that chart:
GraphQL **131 µs** vs Peggy's 328 µs, JSON **133 µs** vs Chevrotain's 241 µs, CSV
**75.3 µs** vs Peggy's 420 µs. Native `JSON.parse` does JSON large in 51.6 µs. On the CST
chart, macro build runs 174 µs against Lezer's 594 µs parse-only.

Those are the committed charts, regenerated at 0.29.0 (2026-07-22) on an M4 Pro, measuring
the JS-codegen lowering that `compile()` and the macro build emit.

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

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

The active 0.48 runtime architecture and release specification is
[`docs/design/parseman-0.48.md`](./docs/design/parseman-0.48.md). Detailed measurements
and rejected experiments remain in the linked evidence registers rather than being
treated as current design.

## License

MIT © [Matthew Dean](https://github.com/matthew-dean)
