# Benchmarks

**Parsing to JS values** — JSON → objects, CSV → rows, GraphQL → AST — is what most
parsers do. The release gate measures Parséman's compact table artifact against
[Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), [Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and [Jison](https://github.com/zaach/jison) on equivalent medium and large inputs.

::: warning 0.47 chart refresh in progress
The committed SVG snapshots and historical numbers below predate canonical artifact
unification: they measured runtime `compile()` while calling it “macro build,” and that
runtime path then used a different emitted-assembly strategy. They are historical material,
not 0.47 release evidence. The release ledger records only a fresh run whose runtime and
macro artifacts share the same `a:[]` closure shape.
:::

For **syntax tree building**, Parséman's table CST path is compared with
[Lezer](https://lezer.codemirror.net/) too — while producing a richer object tree with
spans and trivia. See [parsing to a syntax tree](#parsing-to-a-syntax-tree).

This page is about **speed**. For a feature-by-feature look at how these parsers differ —
output shape, context-sensitive grammars, incremental re-parse, error recovery — see
[How Parséman compares](./comparison).

Measured on Apple M4 Pro. Bars show µs per parse — shorter is faster.

::: info Basis for every timing on this page
The historical Parséman bars and tables below measure the former **JS-codegen lowering** — the interpreter,
`compile()`, and what the charts called the macro build. Every number is transcribed from the committed charts in
`assets/bench-*.svg`, last regenerated at **0.29.0 (2026-07-22)** by `pnpm bench:svg`.
Re-run that command to refresh both the charts and these tables together; if a table and a
chart disagree, the chart is the source.
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

### Parséman's three modes on the charts

Parséman appears as up to three bars:

| Bar | What it is |
| --- | --- |
| **interpreted** | The default combinator interpreter — zero setup |
| **compiled** | `compile()` at runtime — costs **111–603 µs** once on the chart grammars, depending on grammar size |
| **macro** | Build-time compilation via the bundler plugin — zero runtime setup |

Most production use lands on **interpreted** (tests, REPLs) or **macro** (shipped apps).
See [The three modes](./modes). Speed isn't free: `compile()` and **macro** expand a
grammar into flat generated JS. Budget in **bytes**, not lines: small self-contained
grammars land at **3–9× the source bytes**, and denser or derived ones go well past that.
Size is roughly linear in `node()` call sites at **≈4.2 kB each**, and the ceiling
enforced in CI is **10×**. See [macro code size](./macro-mode#code-size-what-to-expect)
for the measurement and its basis.

For comparison, [Chevrotain](https://chevrotain.io/) always pays **745–1,340 µs** initialization before its first
parse — that's why it only shows up in the init section. Both init ranges are the values
pinned in `bench/chart-types.ts`.

## Headline numbers

On JSON, CSV, and GraphQL, Parséman **macro** beats every other library at every fixture
size in the charts above:

| Fixture | Parséman macro | [Peggy](https://peggyjs.org/) | [Chevrotain](https://chevrotain.io/) | Native |
| --- | --- | --- | --- | --- |
| JSON large (11.9 kB) | **133 µs** | 445 | 241 | `JSON.parse` 51.6 µs |
| JSON medium (1.8 kB) | **16.5 µs** | 63.0 | 29.2 | `JSON.parse` 4.34 µs |
| CSV large (14.5 kB) | **75.3 µs** | 420 | 1,060 | — |
| GraphQL large (7.7 kB) | **131 µs** | 328 | 343 | — |

The zero-setup **interpreter** stays close behind with no compile step at all. On **CSV** it's
the fastest option after the macro build, well ahead of every generator. On **JSON** and
**GraphQL** it runs in the leading pack: ahead of
Peggy, and roughly neck-and-neck with a well-tuned [Chevrotain](https://chevrotain.io/)
(Chevrotain edges it on large JSON; the two trade places within noise on GraphQL) — and well
ahead of Parsimmon, Nearley, and Jison throughout. Reach for the macro build when you want the
last 2–3×; either way you pay nothing up front.

## Parsing to a syntax tree

The numbers above build **JS values**. A separate class of parser builds a **syntax
tree** instead — [Chevrotain](https://chevrotain.io/)'s `CstParser`, and [Lezer](https://lezer.codemirror.net/), the incremental parser behind
[CodeMirror 6](https://codemirror.net/). Parséman does this too via [`node()`](./ast) rules (with full trivia and
span capture). Measured on the same JSON fixtures (`pnpm bench:svg`, tree-building group):

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

| Parser | small (52 B) | medium (1.8 kB) | large (11.9 kB) | Output |
| --- | --- | --- | --- | --- |
| **Parséman CST (macro build)** | **0.72 µs** | **21.2 µs** | **174 µs** | object tree + spans |
| [Lezer](https://lezer.codemirror.net/) (parse only) | 2.31 µs | 71.2 µs | 594 µs | compact buffer tree |
| [Lezer](https://lezer.codemirror.net/) (parse + walk) | 2.60 µs | 79.4 µs | 664 µs | compact buffer tree |
| Parséman CST (interpreter) | 2.59 µs | 92.9 µs | 579 µs | object tree + spans |
| [Chevrotain](https://chevrotain.io/) CST | 8.19 µs | 260 µs | 1.98 ms | object CST |

**Macro build** = compiled by the bundler plugin at build time (zero runtime setup).
**Interpreter** = default combinator runtime, no `compile()` or macro. These are the two
ways to run Parséman; the chart shows both against Lezer and Chevrotain.

**Compiled Parséman CST (macro build) beats Lezer at every fixture size on this chart** —
~3.4× at large — while building a directly-usable object tree with per-node spans. Optional
[`captureTrivia`](./trivia) (`parser({ captureTrivia: true })`) also logs whitespace
between tokens for formatters — it adds ~5% on this fixture, so it isn't a separate bar.
Lezer emits a compact buffer tree optimized for CodeMirror's incremental
editor pipeline; Parséman emits JS objects ready for formatters and refactors without a
second walk. Pick the output your consumer actually needs.

Even the zero-setup **interpreter** CST holds its own against a purpose-built incremental
generator: it's within ~1.1× of Lezer parse-only at small inputs, and slightly faster at large
(579 µs vs 594 µs) while building a richer object tree, and **~2.8–3.4× faster than
Chevrotain** throughout. Compile it (macro build) and it moves ahead of Lezer outright.

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

**When you're parsing to JS values — objects, rows, AST nodes — Parséman's macro build is
the fastest general-purpose JS parser in this comparison, at every benchmarked grammar and
every input size in it**, with **zero initialization cost**. For syntax trees, the same macro build beats
Lezer and Chevrotain on the JSON CST fixture. And the setup-free interpreter is
remarkably competitive on its own — the fastest option after the macro build on CSV, and
running with the leading generators on JSON and GraphQL (ahead of Peggy; trading the lead
with a well-tuned Chevrotain).

The numbers come from a reproducible suite you can run yourself (`pnpm bench`) on one M4
Pro / Node+V8, median of 15 samples. Got a parser you think belongs in the comparison?
[Open an issue](https://github.com/matthew-dean/parseman/issues) — the harness
(`bench/run.ts`) is built to add competitors.

## Refreshing the charts

To update the comparison SVGs in `assets/` (used by this page):

```bash
pnpm bench:svg    # run chart-only benchmarks, then write assets/bench-*.svg
```

That's the whole workflow — one command. It runs **only** the JSON / CSV / GraphQL /
CST-JSON warm-parse timings the charts need (~30–60 s), not the full `pnpm bench` suite.

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
