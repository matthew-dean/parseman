# Performance

Parséman is fast by default — the [macro build](./macro-mode) beats hand-tuned generators
on the benchmarks — but grammar authoring still has one dominant lever. This page covers
the technique that matters most, plus how to measure.

## The one rule: fewer combinator boundaries

The single biggest grammar-level perf lever is **the number of combinator boundaries on
the hot path**. Every `sequence` / `regex` / `oneOrMore` step is a function call plus a
result-object allocation plus — in a `node()` rule — a leaf push. Fewer, fatter
combinators beat many thin ones.

## Collapse opaque shapes into one regex

Measured on a repeated 3-shape group (`name1 1px #111 …`, ~29 KB), parsing the same
content three ways:

| Approach | Interpreted | Compiled |
| --- | --- | --- |
| `oneOrMore(sequence(ident, sp, num, sp, hex, sp))` | 0.289 ms | 0.167 ms |
| same, with **inline** `regex(…)` instead of shared refs | 0.281 ms | 0.183 ms |
| **one** `regex(/…ident…num…hex…/)` per group | **0.055 ms** | **0.042 ms** |

Two takeaways:

- **Shared combinator ref vs. inline `regex(…)` literal makes no difference.** Both
  produce the identical runtime structure (one `regex` combinator either way), and the
  compiler inlines a `regex` test at every use site regardless of sharing — there's no
  function-call indirection to eliminate (that only exists for `ref()` / `rules()`
  entries). Factor out shared terminals for readability; it costs nothing.
- **Collapsing a fixed multi-token shape into a single `regex` is 4–5× faster** in both
  the interpreter and compiled output, because it erases the per-step call + allocation
  overhead. `compile()` is a real but smaller win (~1.7×) and **stacks** with collapsing.

### When to collapse

Only where the CST treats the group as opaque text — a dimension `\d+px`, a hex color, an
`nth` expression, a simple ident-run. A single regex yields **one leaf**, not structured
sub-nodes.

If the shape is easier to write as combinators but should still be one source token, wrap
it in [`token()`](../reference/api#token-combinator). `token()` clears internal trivia,
returns the matched source text, and contributes one CST leaf inside `node()`. The compiler
can collapse safe nullable terminal runs inside it (`many`, `optional`, `sepBy` over
literals/regexes) to one regex. That is an optimization opportunity, not a promise that
retrofitting `token()` onto an already tuned grammar will make it faster — benchmark the
actual grammar.

### When *not* to collapse

Keep the parts as separate combinators wherever the builder needs them as distinct CST
children:

- for named values/spans consumed by a builder (`field(name, parser)`),
- for trivia recovered *between* the parts,
- for distinct typed nodes.

Correctness first; collapse only the genuinely opaque runs.

::: tip Not to be confused with node unwrap or CST wrapper collapse
This is a *performance* technique — folding an opaque source token into one matcher. It is
separate from `node(…, { unwrap: true })`, which changes **AST/value shape**, from
`node(..., { collapse: true })`, which changes one grammar wrapper's **CST-like shape**,
and from `cstBuildHost({ collapse })`, which changes **public CST shape**. See
[CST / AST nodes](./ast#unwrapping-and-collapsing-wrapper-rules).
:::

## `compile()` stacks on top

Collapsing reduces the *number* of combinators; [`compile()`](./modes#compile-runtime-jit)
(or the macro build) makes each remaining combinator cheaper by emitting flat JS. The two
compound — a collapsed grammar compiled is the fastest configuration. Use the macro build
for production so you pay the compile cost once, at build time.

## Measuring

```bash
pnpm bench                  # parser-to-parser comparison
pnpm bench:parseman         # Parseman interpreted vs compiled regression report
pnpm bench:svg              # chart-only benchmarks + regenerate assets/bench-*.svg
pnpm bench:baseline         # refresh the regression baseline + append a history snapshot
pnpm bench:release-compare-svg # regenerate committed 0.26/0.27/0.28 release evidence SVGs
pnpm bench:compile-grammars # regenerate the precompiled Peggy/Nearley/Jison parsers
pnpm perf:guard             # fast pre-commit CSS speed regression check

node --import tsx bench/compose-dispatch.ts   # composed-grammar first-char dispatch A/B
```

See [Benchmarks → Refreshing the charts](./benchmarks#refreshing-the-charts) for when to
use `bench:svg` vs the full `bench` suite.

### Composed grammars

The cross-parser charts measure **single** grammars compiled whole. A grammar built by
[`compose([...])`](./extending) gets first-char dispatch across artifacts too (see
[macro mode](./macro-mode#what-gets-emitted)) — `bench/compose-dispatch.ts` isolates that:
a CSS-value-shaped composed grammar whose `value` is a `choice` over many cross-rule ref
arms. With fuse-time dispatch the compiled parser skips arms whose first char can't match
instead of trying each per token. Check it out across a change to A/B it — the win scales
with arm count and how many `choice` rules a grammar has (a real stylesheet grammar, with
a 15-arm value rule plus many selector choices, sees appreciably more than one 6-arm
choice in isolation).

The benchmark reports each grammar's median µs/op interpreted and compiled, with a delta
against the committed baseline — so a regression shows up immediately. See
[Benchmarks](./benchmarks) for the full parser comparison charts (JSON, CSV, GraphQL).

## Library-level ideas

The lever above is what *grammar authors* control. Below the grammar, the compiler also
lowers many `regex(…)` terminals into `charCodeAt` scan loops — see
[Under the hood: regex lowering](./regex-lowering) for what gets lowered, into what, and how
it's kept correct and fast.

Node capture is arity-driven: a direct AST `build` that doesn't declare
`children`, `rawChildren`, `triviaLog`, or `state` pays nothing to collect them;
an injected `ctx.build` host keeps the complete CST contract. This is often a
large slice of parse time on value-dense grammars. See
[Capture follows your `build`'s arity](./ast#capture-follows-arity).

For the full catalog of library-level codegen and macro optimizations (choice fast-paths,
trivia loop specialization, transform/build inlining, and more), see
[`PERF_IDEAS.md`](https://github.com/matthew-dean/parseman/blob/main/PERF_IDEAS.md) in the
repo.
