# Benchmarks

Most parsers spend their life turning text into JS values: JSON into objects, CSV into
rows, GraphQL into an AST. So that's what gets measured here, against
[Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon),
[Chevrotain](https://chevrotain.io/), [Nearley](https://nearley.js.org/), and
[Jison](https://github.com/zaach/jison), on equivalent small, medium, and large inputs.

Building a **syntax tree** is a different job with a different field, so it gets its own
section — that one adds [Lezer](https://lezer.codemirror.net/). See
[parsing to a syntax tree](#parsing-to-a-syntax-tree).

This page is only about speed. For how these tools actually differ — output shape,
context-sensitive grammars, incremental re-parse, error recovery — see
[How Parséman compares](./comparison).

Everything below was measured on an Apple M4 Pro running Node 24.11.1. Bars show µs per
parse, so shorter is faster.

::: info Where these numbers come from
Every figure on this page is transcribed from `assets/bench-*.svg`, regenerated for
**0.50.2 on 2026-08-29** by `pnpm bench:svg`. Parséman's compiled bars are the table
artifact produced by runtime `compile()` — the same thing the macro build ships. Each
parser runs in its own process, each group over three rotated rounds. If a table and a
chart ever disagree, believe the chart.
:::

Every entrant does the same work on the same fixtures — building real values, row arrays,
and GraphQL AST nodes, not just validating syntax. JSON also gets a
[`JSON.parse`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse)
bar, because it's useful to know how far a native C++ parser is from any of this.

The Peggy grammars in `bench/*.pegjs` are the reference implementations. Nearley's JSON
grammar is [the one from its own repo](https://github.com/kach/nearley/blob/master/examples/json.ne);
the rest of the Nearley and Jison grammars are ports of those Peggy files.

## JSON

![JSON parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-json.svg)

## CSV

![CSV parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-csv.svg)

## GraphQL

![GraphQL parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-graphql.svg)

## Reading the charts

Each chart has two sections:

1. **Initialization** — what you pay once, before the first parse. Only parsers with a
   real setup cost show up here; everyone else starts for free.
2. **Warm parse** — median µs per parse once that's done. **This is the number that
   matters.** Init figures are pinned on the charts because they're noisy run to run.

### Parséman's modes on the charts

Parséman appears as two warm-parse bars:

| Bar | What it is |
| --- | --- |
| **interpreted** | The default combinator interpreter — zero setup |
| **runtime compile** | `compile()` once, then parse the canonical compiled `TableProgram` |

The build-time macro isn't a third bar, because it produces the same table the
runtime-compile bar is measuring — it just produces it earlier. See
[The three modes](./modes). It isn't free, mind you: the artifact costs roughly 1.1–3.0×
your source bytes, plus about 324 bytes per `node()` site, with a 10× ceiling enforced in
CI. [Macro code size](./macro-mode#code-size-what-to-expect) has the details.

For scale, [Chevrotain](https://chevrotain.io/) pays **745–1,340 µs** of initialization
before its first parse, every time — which is why it only appears in the init section.

## Headline numbers

On JSON, CSV, and GraphQL, the compiled artifact is ahead of every other library at every
size measured:

| Fixture | Parséman compiled | Parséman interpreted | [Peggy](https://peggyjs.org/) | [Chevrotain](https://chevrotain.io/) | Native |
| --- | --- | --- | --- | --- | --- |
| JSON small (52 B) | **0.56 µs** | **0.83** | 2.63 | 1.00 | `JSON.parse` 0.17 µs |
| JSON medium (1.8 kB) | **15.37 µs** | **25.28** | 68.20 | 29.57 | `JSON.parse` 3.84 µs |
| JSON large (11.9 kB) | **122.03 µs** | **205.36** | 479.90 | 246.16 | `JSON.parse` 41.16 µs |
| CSV small (54 B) | **0.41 µs** | **1.57** | 1.95 | 5.00 | — |
| CSV large (14.5 kB) | **73.83 µs** | **285.20** | 432.15 | 972.01 | — |
| GraphQL small (27 B) | **0.75 µs** | 2.47 | 2.29 | **2.14** | — |
| GraphQL medium (336 B) | **7.07 µs** | 14.46 | 15.99 | **12.42** | — |
| GraphQL large (7.7 kB) | **146.96 µs** | 361.40 | 374.03 | **329.11** | — |

The **interpreter** — no compile step at all — is now the fastest non-compiled parser on
every JSON and CSV size in these charts. On GraphQL it remains in the leading group:
Chevrotain is 10–16% faster depending on size, and Peggy wins the tiny row while Parseman
wins medium and large. Reach for the macro build when you want construction out of runtime
entirely, and `compile()` when the grammar itself is assembled on the fly.

## Parsing to a syntax tree

Everything above builds plain JS values. Building a **syntax tree** — every token, every
span, nothing thrown away — is a different job, and it has a different field:
[Chevrotain](https://chevrotain.io/)'s `CstParser`, and
[Lezer](https://lezer.codemirror.net/), the incremental parser behind
[CodeMirror 6](https://codemirror.net/). Parséman does it through [`node()`](./ast) rules,
with full trivia and span capture. Same JSON fixtures:

![JSON CST parsing benchmarks](https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/bench-cst-json.svg)

| Parser | small (52 B) | medium (1.8 kB) | large (11.9 kB) | Output |
| --- | --- | --- | --- | --- |
| **Parséman CST (runtime compile)** | **0.58 µs** | **18.27 µs** | **148.48 µs** | object tree + spans |
| [Lezer](https://lezer.codemirror.net/) (parse only) | 2.35 µs | 69.19 µs | 583.41 µs | compact buffer tree |
| [Lezer](https://lezer.codemirror.net/) (parse + walk) | 2.68 µs | 78.76 µs | 665.13 µs | compact buffer tree |
| Parséman CST (interpreter) | 1.87 µs | 64.49 µs | 457.38 µs | object tree + spans |
| [Chevrotain](https://chevrotain.io/) CST | 7.28 µs | 236.37 µs | 1.81 ms | object CST |

**Compiled Parséman is ahead of Lezer at every size here** — about 3.9× at the large
fixture — while producing an object tree you can use directly, with a span on every node.
Turning on [`captureTrivia`](./trivia) to log whitespace for a formatter costs about 5% on
this fixture, which is why it doesn't get its own bar.

That comparison deserves an asterisk, though, and it's a real one: Lezer emits a compact
buffer tree tuned for CodeMirror's incremental pipeline, and Parséman emits JS objects a
formatter or refactor can walk without a second pass. Different outputs for different
consumers. Pick the one yours actually needs.

Even the setup-free **interpreter** holds its own against a purpose-built incremental
generator — faster than Lezer parse-only at every measured size (1.87 vs 2.35 µs, 64.49 vs
69.19 µs, 457 vs 583 µs) while building the richer tree, and roughly 3.7–4.0× faster than Chevrotain
throughout.

## Incremental re-parse

Editors re-parse on every keystroke, so re-parsing *only what changed* is the whole game.
Parséman ([`parseDoc`](./incremental)) and [Lezer](https://lezer.codemirror.net/) both do
it, but their cost curves are shaped differently — different enough that the winner flips
depending on what kind of edit you made. Measured on a 12 kB nested JSON fixture, with
every row verified span-correct against a full reparse:

| Edit | Parséman incremental | [Lezer](https://lezer.codemirror.net/) incremental | Full reparse |
| --- | --- | --- | --- |
| Overtype a value (same length) | **4.6 µs** | 107 µs | ~510 µs |
| Insert a character (+1) | **8.1 µs** | 108 µs | ~510 µs |
| Insert a new element (structural) | 29 µs | **8.0 µs** | ~510 µs |

The trick is that Parséman stores **parent-relative** spans. A length-changing edit never
has to rewrite the offsets of everything after it: a subtree that slides along with its
parent keeps its own offsets untouched and gets shared by identity. That makes all three
edit kinds cheap, in different amounts:

- **In-place value edits** — overtyping, or adding a character to a token you're in the
  middle of. This is what typing actually *is*, most of the time. Only the smallest
  containing rule re-parses; everything else is shared by reference. An overtype comes out
  **~110× faster than a full reparse** and ~20× ahead of Lezer, and a character insert is
  nearly as cheap, since there's no O(n) offset shift waiting at the end.
- **Structural edits** — inserting or removing an element in a large collection — reuse the
  collection's untouched tail elements by identity ([opt-in
  `structuralReuse`](./incremental#structural-edits-opt-in-list-reuse)), re-parsing only the
  disturbed span. That takes the 200-element-array insert from ~full-reparse cost down to
  **~30 µs** — within a few × of Lezer's chunked buffer-tree reuse, which does the tail
  shift in O(log) where Parséman's flat object list does it in O(trailing siblings).

When you need absolute positions, `spanAt(path)` walks them in O(depth), or
`absolutizeCST(tree)` does the whole tree at once. If your editor mostly sees value edits —
a linter or formatter re-running as tokens change — re-parsing is effectively free. Even
heavy structural churn stays within a small factor of Lezer.

## The short version

For parsing to JS values — objects, rows, AST nodes — the compiled artifact is the fastest
general-purpose JS parser in this comparison, at every grammar and every size measured. For
syntax trees, it's ahead of Lezer and Chevrotain on the JSON fixture. The setup-free
interpreter leads every external parser on JSON and CSV and stays within roughly 15% of
the GraphQL leader.

All of it comes from a suite you can run yourself (`pnpm bench:svg`), on one M4 Pro and
Node 24.11.1, three rotated rounds with one parser per process. Think a parser belongs in
here and isn't? [Open an issue](https://github.com/matthew-dean/parseman/issues) — the
harness in `bench/run.ts` was built to take new entrants.

## Refreshing the charts

To update the comparison SVGs in `assets/` (used by this page):

```bash
pnpm bench:svg    # run chart-only benchmarks, then write assets/bench-*.svg
```

That's the whole workflow. It runs only the JSON / CSV / GraphQL / CST-JSON timings the
charts need, not the full `pnpm bench` suite — but the small fixtures run a lot of
iterations, so give it several minutes.

| Command | What it does |
| --- | --- |
| `pnpm bench:svg` | **Update charts** — benchmark chart parsers + write `assets/bench-*.svg` |
| `pnpm bench` | Parser-to-parser comparison |
| `pnpm bench:parseman` | Parseman interpreted vs compiled regression report |
| `pnpm bench:baseline` | Refresh Parseman regression baseline + history snapshot |
| `pnpm perf:guard` | Fast pre-commit CSS speed regression check |

The init-cost bars are **pinned** in `bench/chart-types.ts` rather than measured each run —
they swing wildly by machine and would only add noise. Warm-parse bars are always live.

For regression guarding, see [Performance → Measuring](./performance#measuring).
