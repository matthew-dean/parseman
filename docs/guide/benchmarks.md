# Benchmarks

**Parsing to JS values** — JSON → objects, CSV → rows, GraphQL → AST — is what most
parsers do. The release gate measures Parséman's compact table artifact against
[Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) on equivalent small, medium, and large inputs.

For **syntax tree building**, Parséman's table CST path is compared with
[Lezer](https://lezer.codemirror.net/) too — while producing a richer object tree with
spans and trivia. See [parsing to a syntax tree](#parsing-to-a-syntax-tree).

This page is about **speed**. For a feature-by-feature look at how these parsers differ —
output shape, context-sensitive grammars, incremental re-parse, error recovery — see
[How Parséman compares](./comparison).

Measured on Apple M4 Pro with Node 25.9.0. Bars show µs per parse — shorter is faster.

::: info Basis for every timing on this page
The Parséman compiled bars measure the 0.50 canonical `TableProgram` produced by runtime
`compile()`, not the removed direct-source parser and not a separately named macro leg.
Every number below is transcribed from `assets/bench-*.svg`, regenerated for **0.50.0 on
2026-08-26** by `pnpm bench:svg`. Each parser bar runs in its own process and each group is
measured in three rotated rounds. If a table and chart disagree, the chart is the source.
:::

Compared parsers: **Parséman**, [Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) (plus [`JSON.parse`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse) on JSON). Each implements the same parsing work on the bench fixtures —
building JS values / row arrays / GraphQL AST nodes, not syntax-only validation.

Peggy grammars in `bench/*.pegjs` are the reference; [Nearley](https://nearley.js.org/) JSON uses
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

### Parséman's modes on the charts

Parséman appears as two warm-parse bars:

| Bar | What it is |
| --- | --- |
| **interpreted** | The default combinator interpreter — zero setup |
| **runtime compile** | `compile()` once, then parse the canonical compiled `TableProgram` |

The build-time macro is a production delivery mode for the same canonical table
architecture, but it is not a separate warm bar in these charts. See [The three
modes](./modes). The generated artifact has a real byte cost: the current probe is roughly
1.1–3.0× source bytes for its representative shapes and about 324 bytes per additional
`node()` site. CI enforces a 10× ceiling. See [macro code
size](./macro-mode#code-size-what-to-expect) for the current measurements.

For comparison, [Chevrotain](https://chevrotain.io/) always pays **745–1,340 µs** initialization before its first
parse — that's why it only shows up in the init section. Both init ranges are the values
pinned in `bench/chart-types.ts`.

## Headline numbers

On JSON, CSV, and GraphQL, Parséman's **runtime-compiled TableProgram** beats every other
library at every fixture size in the charts above:

| Fixture | Parséman compiled | [Peggy](https://peggyjs.org/) | [Chevrotain](https://chevrotain.io/) | Native |
| --- | --- | --- | --- | --- |
| JSON small (52 B) | **0.57 µs** | 2.55 | 1.00 | `JSON.parse` 0.21 µs |
| JSON medium (1.8 kB) | **15.69 µs** | 64.40 | 29.57 | `JSON.parse` 4.41 µs |
| JSON large (11.9 kB) | **121.50 µs** | 451.40 | 245.15 | `JSON.parse` 51.70 µs |
| CSV small (54 B) | **0.41 µs** | 1.93 | 5.31 | — |
| CSV large (14.5 kB) | **74.32 µs** | 425.53 | 1,050.49 | — |
| GraphQL small (27 B) | **0.61 µs** | 2.10 | 2.15 | — |
| GraphQL medium (336 B) | **5.03 µs** | 14.74 | 12.64 | — |
| GraphQL large (7.7 kB) | **108.18 µs** | 332.98 | 334.17 | — |

The zero-setup **interpreter** remains competitive with no compile step. It is the fastest
option after compiled Parseman on CSV, ahead of Peggy on JSON, and in the leading group on
GraphQL. Reach for the macro build when you want construction moved out of runtime; use
`compile()` when the grammar itself is assembled dynamically.

## Parsing to a syntax tree

The numbers above build **JS values**. A separate class of parser builds a **syntax
tree** instead — [Chevrotain](https://chevrotain.io/)'s `CstParser`, and [Lezer](https://lezer.codemirror.net/), the incremental parser behind
[CodeMirror 6](https://codemirror.net/). Parséman does this too via [`node()`](./ast) rules (with full trivia and
span capture). Measured on the same JSON fixtures (`pnpm bench:svg`, tree-building group):

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

| Parser | small (52 B) | medium (1.8 kB) | large (11.9 kB) | Output |
| --- | --- | --- | --- | --- |
| **Parséman CST (runtime compile)** | **0.59 µs** | **18.18 µs** | **153.12 µs** | object tree + spans |
| [Lezer](https://lezer.codemirror.net/) (parse only) | 2.25 µs | 69.33 µs | 603.50 µs | compact buffer tree |
| [Lezer](https://lezer.codemirror.net/) (parse + walk) | 2.60 µs | 79.03 µs | 681.03 µs | compact buffer tree |
| Parséman CST (interpreter) | 1.82 µs | 63.55 µs | 449.12 µs | object tree + spans |
| [Chevrotain](https://chevrotain.io/) CST | 7.74 µs | 249.73 µs | 1.96 ms | object CST |

**Runtime compile** = construct the canonical compiled table once, then time parsing.
**Interpreter** = default combinator runtime, no `compile()` or macro. The chart shows both
against Lezer and Chevrotain; it does not label the macro as a third warm engine.

**Compiled Parséman CST beats Lezer at every fixture size on this chart** — ~3.9× at large
— while building a directly-usable object tree with per-node spans. Optional
[`captureTrivia`](./trivia) (`parser({ captureTrivia: true })`) also logs whitespace
between tokens for formatters — it adds ~5% on this fixture, so it isn't a separate bar.
Lezer emits a compact buffer tree optimized for CodeMirror's incremental
editor pipeline; Parséman emits JS objects ready for formatters and refactors without a
second walk. Pick the output your consumer actually needs.

Even the zero-setup **interpreter** CST holds its own against a purpose-built incremental
generator: it is faster than Lezer parse-only at small and large inputs (1.82 vs 2.25 µs;
449 vs 604 µs) while building a richer object tree, and **about 3.9–4.4× faster than
Chevrotain** throughout. Compile it and it moves ahead of Lezer outright.

## Incremental re-parse

Editors re-parse on every keystroke, so re-parsing only what changed matters. Both
Parséman ([`parseDoc`](./incremental)) and [Lezer](https://lezer.codemirror.net/)
support this — but their cost curves are shaped differently, so the winner flips with the
*kind* of edit. Measured on the 12 kB nested JSON fixture; every row produces a
span-correct tree (verified against a full reparse):

| Edit | Parséman incremental | [Lezer](https://lezer.codemirror.net/) incremental | Full reparse |
| --- | --- | --- | --- |
| Overtype a value (same length) | **4.6 µs** | 107 µs | ~510 µs |
| Insert a character (+1) | **8.1 µs** | 108 µs | ~510 µs |
| Insert a new element (structural) | 29 µs | **8.0 µs** | ~510 µs |

Parséman stores **parent-relative** spans in a plain object tree, so a length-changing edit
never rewrites the offsets of the nodes after it — a subtree that slides as a unit with its
parent keeps its parent-relative offsets and is shared by identity. That makes all three
edit kinds cheap:

- **In-place value edits** — overtyping, or typing a character into an existing token, the
  overwhelmingly common editing operation — re-parse just the smallest containing rule and
  share every untouched node by reference. An overtype is **~110× faster than a full
  reparse** and ~20× ahead of Lezer; a character insert is nearly as cheap (no O(n) offset
  shift to pay).
- **Structural edits** — inserting or removing an element in a large collection — reuse the
  collection's untouched tail elements by identity ([opt-in
  `structuralReuse`](./incremental#structural-edits-opt-in-list-reuse)), re-parsing only the
  disturbed span. That takes the 200-element-array insert from ~full-reparse cost down to
  **~30 µs** — within a few × of Lezer's chunked buffer-tree reuse, which does the tail
  shift in O(log) where Parséman's flat object list does it in O(trailing siblings).

Absolute positions come from the O(depth) `spanAt(path)` cursor, or `absolutizeCST(tree)`
for the whole tree at once. If your editor mostly sees value edits (a linter or formatter
re-running as tokens change), Parséman's re-parse is effectively free; even heavy structural
churn stays within a small factor of Lezer.

## Reproducing the numbers

**When you're parsing to JS values — objects, rows, AST nodes — Parséman's runtime-compiled artifact is
the fastest general-purpose JS parser in this comparison, at every benchmarked grammar and
every input size in it**. For syntax trees, the compiled CST artifact beats Lezer and
Chevrotain on the JSON fixture. The setup-free interpreter is also the fastest option after
compiled Parseman on CSV and remains in the leading group on JSON and GraphQL.

The numbers come from a reproducible suite you can run yourself (`pnpm bench:svg`) on one
M4 Pro / Node 25.9.0, three rotated rounds with one parser bar per process. Got a parser
you think belongs in the comparison?
[Open an issue](https://github.com/matthew-dean/parseman/issues) — the harness
(`bench/run.ts`) is built to add competitors.

## Refreshing the charts

To update the comparison SVGs in `assets/` (used by this page):

```bash
pnpm bench:svg    # run chart-only benchmarks, then write assets/bench-*.svg
```

That's the whole workflow — one command. It runs **only** the JSON / CSV / GraphQL /
CST-JSON timings the charts need, not the full `pnpm bench` suite. Runtime depends on the
host and on the restored high-iteration small rows; allow several minutes.

| Command | What it does |
| --- | --- |
| `pnpm bench:svg` | **Update charts** — benchmark chart parsers + write `assets/bench-*.svg` |
| `pnpm bench` | Parser-to-parser comparison |
| `pnpm bench:parseman` | Parseman interpreted vs compiled regression report |
| `pnpm bench:baseline` | Refresh Parseman regression baseline + history snapshot |
| `pnpm perf:guard` | Fast pre-commit CSS speed regression check |

Init-cost bars on the charts (`compile()` vs Chevrotain setup) are **pinned** in
`bench/chart-types.ts` — they vary wildly by machine and aren't refreshed on each run.
Warm-parse bars come from live measurement.

For regression guarding, see [Performance → Measuring](./performance#measuring).
