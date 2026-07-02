# Benchmarks

**Parsing to JS values** — JSON → objects, CSV → rows, GraphQL → AST — is what most
parsers do, and it's the race Parséman is built to win: **the macro build is the fastest
general-purpose JS parser we benchmark**, beating Peggy, Parsimmon, Chevrotain, Nearley,
and Jison at every grammar and size.

For **syntax tree building**, Parséman's compiled CST path (macro build) beats
[Lezer](https://lezer.codemirror.net/) too — while producing a richer object tree with
spans and trivia. See [parsing to a syntax tree](#parsing-to-a-syntax-tree).

Measured on Apple M2 Pro. Bars show µs per parse — shorter is faster.

Compared parsers: **Parséman**, Peggy, Parsimmon, Chevrotain, Nearley, and Jison (plus
`JSON.parse` on JSON). Each implements the same parsing work on the bench fixtures —
building JS values / row arrays / GraphQL AST nodes, not syntax-only validation.

Peggy grammars in `bench/*.pegjs` are the reference; Nearley JSON uses
[kach/nearley `examples/json.ne`](https://github.com/kach/nearley/blob/master/examples/json.ne);
other Nearley and Jison grammars are ports of those Peggy files (`bench/vendor/`).

## JSON

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

## CSV

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

## GraphQL

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

## Reading the charts

Each chart has two sections:

1. **Initialization** — one-time setup cost before the first parse. Only parsers with a
   nonzero setup cost appear here; everything else starts for free.
2. **Warm parse** — median µs per parse after setup. **This is the meaningful
   comparison** — init numbers are pinned on the charts but noisy run-to-run.

### Parséman's three modes on the charts

Parséman appears as up to three bars:

| Bar | What it is |
| --- | --- |
| **interpreted** | The default combinator interpreter — zero setup |
| **compiled** | `.compile()` at runtime — costs **75–650 µs** once, depending on grammar size |
| **macro** | Build-time compilation via the bundler plugin — zero runtime cost |

Most production use lands on **interpreted** (tests, REPLs) or **macro** (shipped apps).
See [The three modes](./modes).

For comparison, Chevrotain always pays **840–1,400 µs** initialization before its first
parse — that's why it only shows up in the init section.

## Headline numbers

On JSON, CSV, and GraphQL, Parséman **macro** beats every other library at every fixture
size in the charts above:

| Fixture | Parséman macro | Peggy | Chevrotain | Native |
| --- | --- | --- | --- | --- |
| JSON large (12 kB) | **125 µs** | 472 | 1,946 | `JSON.parse` 45 µs |
| JSON medium (1.8 kB) | **15 µs** | 67 | 245 | `JSON.parse` 4 µs |
| CSV large (14.8 kB) | **71 µs** | 447 | 1,301 | — |
| GraphQL large (7.8 kB) | **154 µs** | 423 | 768 | — |

Even the zero-setup **interpreter** beats all five libraries at the large sizes.

## Parsing to a syntax tree

The numbers above build **JS values**. A separate class of parser builds a **syntax
tree** instead — Chevrotain's `CstParser`, and Lezer, the incremental parser behind
CodeMirror 6. Parséman does this too via [`node()`](./ast) rules (with full trivia and
span capture). Measured on the same JSON fixtures (`pnpm bench`, tree-building group):

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

| Parser | small (52 B) | medium (1.8 kB) | large (12 kB) | Output |
| --- | --- | --- | --- | --- |
| **Parséman CST (macro build)** | **1.5 µs** | **50 µs** | **344 µs** | object tree + spans |
| Lezer (parse only) | 2.3 µs | 70 µs | 587 µs | compact buffer tree |
| Lezer (parse + walk) | 2.7 µs | 79 µs | 789 µs | compact buffer tree |
| Parséman CST (no compile) | 2.8 µs | 103 µs | 655 µs | object tree + spans |
| Parséman CST (with trivia) | 3.0 µs | 108 µs | 684 µs | object tree + spans + trivia |
| Chevrotain CST | 7.6 µs | 251 µs | 1,950 µs | object CST |

**Compiled Parséman CST (macro build) beats Lezer at every fixture size** — ~1.7× at
large — while building a directly-usable object tree with per-node spans and optional
trivia capture. Lezer emits a compact buffer tree optimized for CodeMirror's incremental
editor pipeline; Parséman emits JS objects ready for formatters and refactors without a
second walk. Pick the output your consumer actually needs.

The zero-setup **interpreter** CST is competitive with Lezer at small inputs and still
~1.1× faster than Lezer parse-only at large, and **~2.8× faster than Chevrotain**.

## Reproducing the numbers

**When you're parsing to JS values — objects, rows, AST nodes — Parséman's macro build is
the fastest general-purpose JS parser in this comparison, at every grammar and every input
size**, with **zero initialization cost**. For syntax trees, the same macro build beats
Lezer and Chevrotain on the JSON CST fixture. Even the setup-free interpreter beats every
other value-building library at realistic sizes.

The numbers come from a reproducible suite you can run yourself (`pnpm bench`) on one M2
Pro / Node+V8, median of 15 samples. Got a parser you think belongs in the comparison?
[Open an issue](https://github.com/matthew-dean/parseman/issues) — the harness
(`bench/run.ts`) is built to add competitors.

## Refreshing the charts

```bash
pnpm bench       # run all benchmarks, print µs/op table
pnpm bench:svg   # regenerate assets/bench-*.svg from the latest bench output
```

Update the µs values in `bench/gen-svg.ts` from `pnpm bench` output before running
`bench:svg` if the chart labels need to change.

For regression guarding and baseline history, see [Performance → Measuring](./performance#measuring).
