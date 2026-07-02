# Benchmarks

**Parsing to JS values** — JSON → objects, CSV → rows, GraphQL → AST — is what most
parsers do, and it's the race Parséman is built to win: **the macro build is the fastest
general-purpose JS parser we benchmark**, beating Peggy, Parsimmon, Chevrotain, Nearley,
and Jison at every grammar and size.

(Building a bare syntax tree is a separate job — [Lezer](https://lezer.codemirror.net/) is
excellent at it. See [parsing to a syntax tree](#parsing-to-a-syntax-tree).)

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
| JSON large (12 kB) | **125 µs** | 483 | 1,936 | `JSON.parse` 38 µs |
| JSON medium (1.8 kB) | **15 µs** | 67 | 243 | `JSON.parse` 4 µs |
| CSV large (14.8 kB) | **69 µs** | 436 | 1,257 | — |
| GraphQL large (7.8 kB) | **146 µs** | 379 | 743 | — |

Even the zero-setup **interpreter** beats all five libraries at the large sizes.

## Parsing to a syntax tree

The numbers above build **JS values**. A separate class of parser builds a **syntax
tree** instead — Chevrotain's `CstParser`, and Lezer, the incremental parser behind
CodeMirror 6. Parséman does this too via [`node()`](./ast) rules (with full trivia and
span capture). Measured on the same JSON fixtures (`pnpm bench`, tree-building group):

| Parser | small (52 B) | medium (1.8 kB) | large (12 kB) | Output |
| --- | --- | --- | --- | --- |
| **Lezer** | **2.8 µs** | **78 µs** | **672 µs** | compact buffer tree |
| Parséman CST (no trivia) | 4.3 µs | 173 µs | 1,007 µs | object tree + spans |
| Parséman CST (with trivia) | 5.5 µs | 170 µs | 1,025 µs | object tree + spans + trivia |
| Chevrotain CST | 8.0 µs | 236 µs | 1,817 µs | object CST |

Parséman produces a **directly-usable object tree** — per-node spans, captured trivia,
ready for formatters and refactors without a second walk — and builds it **~1.8× faster
than Chevrotain**. [Lezer](https://lezer.codemirror.net/) is faster still at raw
tree-building, but it emits a compact buffer tree rather than JS values or an object CST:
a different job. Pick the output your consumer actually needs.

## The headline

**When you're parsing to JS values — objects, rows, AST nodes — Parséman's macro build is
the fastest general-purpose JS parser in this comparison, at every grammar and every input
size**, with **zero initialization cost**. Even the setup-free interpreter beats every
other library at realistic sizes. That's the workload most parsers actually do, and it's
the one Parséman is built to win.

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
