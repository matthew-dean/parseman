# Benchmarks

**Parsing to JS values** — JSON → objects, CSV → rows, GraphQL → AST — is what most
parsers do, and it's the race Parséman is built to win: **the macro build is the fastest
general-purpose JS parser we benchmark**, beating [Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) at every grammar and size.

For **syntax tree building**, Parséman's compiled CST path (macro build) beats
[Lezer](https://lezer.codemirror.net/) too — while producing a richer object tree with
spans and trivia. See [parsing to a syntax tree](#parsing-to-a-syntax-tree).

Measured on Apple M2 Pro. Bars show µs per parse — shorter is faster.

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

### Parséman's three modes on the charts

Parséman appears as up to three bars:

| Bar | What it is |
| --- | --- |
| **interpreted** | The default combinator interpreter — zero setup |
| **compiled** | `.compile()` at runtime — costs **75–650 µs** once, depending on grammar size |
| **macro** | Build-time compilation via the bundler plugin — zero runtime cost |

Most production use lands on **interpreted** (tests, REPLs) or **macro** (shipped apps).
See [The three modes](./modes). Speed isn't free: `.compile()` and **macro** expand a
grammar into flat generated JS — roughly **3–14× the source lines** (gzips to a fraction).
See [macro code size](./macro-mode#code-size-what-to-expect).

For comparison, [Chevrotain](https://chevrotain.io/) always pays **840–1,400 µs** initialization before its first
parse — that's why it only shows up in the init section.

## Headline numbers

On JSON, CSV, and GraphQL, Parséman **macro** beats every other library at every fixture
size in the charts above:

| Fixture | Parséman macro | [Peggy](https://peggyjs.org/) | [Chevrotain](https://chevrotain.io/) | Native |
| --- | --- | --- | --- | --- |
| JSON large (12 kB) | **125 µs** | 472 | 1,946 | `JSON.parse` 45 µs |
| JSON medium (1.8 kB) | **15 µs** | 67 | 245 | `JSON.parse` 4 µs |
| CSV large (14.8 kB) | **71 µs** | 447 | 1,301 | — |
| GraphQL large (7.8 kB) | **154 µs** | 423 | 768 | — |

Even the zero-setup **interpreter** beats all five libraries at the large sizes.

## Parsing to a syntax tree

The numbers above build **JS values**. A separate class of parser builds a **syntax
tree** instead — [Chevrotain](https://chevrotain.io/)'s `CstParser`, and [Lezer](https://lezer.codemirror.net/), the incremental parser behind
[CodeMirror 6](https://codemirror.net/). Parséman does this too via [`node()`](./ast) rules (with full trivia and
span capture). Measured on the same JSON fixtures (`pnpm bench`, tree-building group):

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

| Parser | small (52 B) | medium (1.8 kB) | large (12 kB) | Output |
| --- | --- | --- | --- | --- |
| **Parséman CST (macro build)** | **1.5 µs** | **50 µs** | **344 µs** | object tree + spans |
| [Lezer](https://lezer.codemirror.net/) (parse only) | 2.3 µs | 70 µs | 587 µs | compact buffer tree |
| [Lezer](https://lezer.codemirror.net/) (parse + walk) | 2.7 µs | 79 µs | 789 µs | compact buffer tree |
| Parséman CST (interpreter) | 2.8 µs | 103 µs | 655 µs | object tree + spans |
| [Chevrotain](https://chevrotain.io/) CST | 7.6 µs | 251 µs | 1,950 µs | object CST |

**Macro build** = compiled by the bundler plugin at build time (zero runtime setup).
**Interpreter** = default combinator runtime, no `.compile()` or macro. These are the two
ways to run Parséman; the chart shows both against Lezer and Chevrotain.

**Compiled Parséman CST (macro build) beats Lezer at every fixture size** — ~1.7× at
large — while building a directly-usable object tree with per-node spans. Optional
[`captureTrivia`](./trivia) (`parser({ captureTrivia: true })`) also logs whitespace
between tokens for formatters — it adds ~5% on this fixture, so it isn't a separate bar.
Lezer emits a compact buffer tree optimized for CodeMirror's incremental
editor pipeline; Parséman emits JS objects ready for formatters and refactors without a
second walk. Pick the output your consumer actually needs.

The zero-setup **interpreter** CST is competitive with Lezer at small inputs and still
~1.1× faster than Lezer parse-only at large, and **~2.8× faster than Chevrotain**.

## Incremental re-parse

Editors re-parse on every keystroke, so re-parsing only what changed matters. Both
Parséman ([`makeFunctionalDoc`](./incremental)) and [Lezer](https://lezer.codemirror.net/)
support this — but their cost curves are shaped differently, so the winner flips with the
*kind* of edit. Measured on the 12 kB nested JSON fixture; every row produces a
span-correct tree (verified against a full reparse):

| Edit | Parséman incremental | [Lezer](https://lezer.codemirror.net/) incremental | Full reparse |
| --- | --- | --- | --- |
| Overtype a value (same length) | **1.9 µs** | 105 µs | ~560 µs |
| Insert a character (+1) | **68 µs** | 108 µs | ~580 µs |
| Insert a new element (structural) | 616 µs | **7.9 µs** | ~590 µs |

Two engines, two sweet spots:

- **In-place value edits** — overtyping, or typing a character into an existing token, the
  overwhelmingly common editing operation — are Parséman's home turf. It re-parses just the
  smallest containing rule and shares every untouched node by reference, so an overtype is
  **~300× faster than a full reparse** and well ahead of Lezer.
- **Structural edits** — inserting or removing a node in a large collection — are Lezer's.
  Its fragment reuse keeps the untouched sibling subtrees and re-parses almost nothing;
  Parséman re-parses the whole containing rule (here, the 200-element array), landing near
  full-reparse cost.

The reason is the tree representation. Parséman stores **absolute** spans in a plain object
tree, so a length-changing edit shifts the offsets of every node after it — negligible for
a localized value edit, O(nodes-after-edit) for a structural one. Lezer stores a buffer
tree with relative offsets built for exactly this case. If your editor mostly sees value
edits (a linter or formatter re-running as tokens change), Parséman's re-parse is
effectively free; if it sees heavy structural churn in large documents, Lezer's design
wins. Pick for your edit mix.

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
