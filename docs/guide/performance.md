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

### When *not* to collapse

Keep the parts as separate combinators wherever the builder needs them as distinct CST
children:

- for per-field source spans (`fieldSpans` / `valueSpans`),
- for trivia recovered *between* the parts,
- for distinct typed nodes.

Correctness first; collapse only the genuinely opaque runs.

::: tip Not to be confused with node collapse
This is a *performance* technique — folding tokens into one regex. There's a separate,
unrelated `node(…, { collapse: true })` option about **tree shape** (a wrapper rule
becoming its single child). See [CST / AST nodes](./ast#collapsing-wrapper-rules).
:::

## `.compile()` stacks on top

Collapsing reduces the *number* of combinators; [`compile()`](./modes#compile-runtime-jit)
(or the macro build) makes each remaining combinator cheaper by emitting flat JS. The two
compound — a collapsed grammar compiled is the fastest configuration. Use the macro build
for production so you pay the compile cost once, at build time.

## Measuring

```bash
pnpm bench                  # Parséman vs Peggy, Parsimmon, Chevrotain, Nearley, Jison —
                            # plus Parséman interpreted vs compiled across all examples
pnpm bench:baseline         # refresh the regression baseline + append a history snapshot
pnpm bench:svg              # regenerate assets/bench-*.svg (see guide/benchmarks)
pnpm bench:compile-grammars # regenerate the precompiled Peggy/Nearley/Jison parsers
```

The benchmark reports each grammar's median µs/op interpreted and compiled, with a delta
against the committed baseline — so a regression shows up immediately. See
[Benchmarks](./benchmarks) for the full parser comparison charts (JSON, CSV, GraphQL).

## Library-level ideas

The lever above is what *grammar authors* control. For library-level codegen and macro
optimizations (choice fast-paths, trivia loop specialization, transform/build inlining,
and more), see
[`PERF_IDEAS.md`](https://github.com/matthew-dean/parseman/blob/main/PERF_IDEAS.md) in the
repo.
