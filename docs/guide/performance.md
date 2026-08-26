# Performance

Parséman is fast by default — the [macro build](./macro-mode) beats hand-tuned parser
generators on the benchmarks. But how you write your grammar still matters more than
anything the compiler does for you. This page covers the one technique that matters most,
and how to measure your own grammar.

::: info What "the compiler" means on this page
As of 0.48, "the compiler" means the **`TableProgram` lowering** that both `compile()`
and the [macro build](./macro-mode) share. The macro build serializes that table, and for
a large enough terminal (a `composeLeaf`) it may also materialize one strict assembly —
but it no longer restores the old direct-source parser, which has been removed. So treat
the historical numbers below as snapshots from the checkpoint they were measured at, not
as current 0.48 figures.
:::

## The one rule: fewer combinator boundaries

The single biggest grammar-level performance lever is the number of combinator boundaries
on your hot path. Every `sequence` / `regex` / `oneOrMore` step costs a function call and
a result-object allocation. Inside a `node()` rule, it also costs a leaf push. Fewer,
fatter combinators beat many thin ones.

## Collapse opaque shapes into one regex

Here's a measurement on a repeated 3-shape group (`name1 1px #111 …`, about 29 KB), parsed
three different ways:

| Approach | Interpreted | Compiled |
| --- | --- | --- |
| `oneOrMore(sequence(ident, sp, num, sp, hex, sp))` | 0.289 ms | 0.167 ms |
| same, with **inline** `regex(…)` instead of shared refs | 0.281 ms | 0.183 ms |
| **one** `regex(/…ident…num…hex…/)` per group | **0.055 ms** | **0.042 ms** |

Two takeaways:

- Whether a bare terminal is a shared combinator reference or an inline `regex(…)`
  literal doesn't matter for speed. Either way, the final graph keeps one terminal
  recognizer. Factor out shared terminals for readability, not performance — the
  boundaries worth optimizing are semantic ones, not how the object happens to be spelled.

  That's a statement about *terminals* specifically, not sharing in general. A subtree
  that's referenced more than once, or is recursive, stays a named linkage boundary in the
  compiled table — so a shared subtree and a copy-pasted one aren't interchangeable in
  size or shape.
- Collapsing a fixed multi-token shape into a single `regex` is **4–5× faster**, in both
  the interpreter and compiled output, because it erases the per-step call-and-allocation
  overhead. `compile()` on its own is a smaller but real win (about 1.7×), and it stacks
  with collapsing.

### When to collapse

Collapse only where your CST already treats the group as opaque text — a dimension like
`\d+px`, a hex color, an `nth` expression, a simple identifier run. A single regex gives
you one leaf, not structured sub-nodes.

If a shape is easier to write with combinators but should still end up as one source
token, wrap it in [`token()`](../reference/api#token-combinator) instead. `token()` clears
internal trivia, returns the matched source text, and contributes a single CST leaf inside
`node()`. The compiler can then collapse safe nullable terminal runs inside it — `many`,
`optional`, `sepBy` over literals or regexes — into one regex. That's an opportunity, not
a guarantee: retrofitting `token()` onto an already-tuned grammar won't automatically make
it faster. Benchmark it.

### When *not* to collapse

Keep the parts as separate combinators wherever your builder needs them as distinct CST
children — for a named value or span consumed by `field(name, parser)`, for trivia
recovered *between* the parts, or for distinct typed nodes.

Correctness comes first. Collapse only the runs that are genuinely opaque.

::: tip Not to be confused with node unwrap or CST wrapper collapse
This is a *performance* technique — folding an opaque source token into one matcher. Don't
confuse it with `node(…, { unwrap: true })`, which changes the AST/value shape;
`node(..., { collapse: true })`, which changes one wrapper's CST-like shape; or
`cstBuildHost({ collapse })`, which changes the public CST shape. See
[CST / AST nodes](./ast#unwrapping-and-collapsing-wrapper-rules) for those.
:::

## `compile()` stacks on top

Collapsing reduces the *number* of combinators. [`compile()`](./modes#compile-runtime-jit)
(or the macro build) makes the boundaries that remain cheaper, by assembling direct bodies
for shapes it can prove. The two effects compound. Use the macro build in production, so
construction and linking happen at build/import time instead of on the first runtime
compile.

## Shared broad openers: prefer `dispatch`

Keep using [`choice`](../reference/api#choiceargs) for literal alternatives and branches
with disjoint first sets. The compiler already turns those into cheap first-char dispatch,
longest-literal checks, greedy classification, or shared-prefix code — whichever shape
fits.

But sometimes several branches all start by recognizing the same broad token, and only
differ once you look at that token's value. A plain `choice` is still correct there, but
it repeats the same opener check on every branch. CSS at-rules are the easy example: exact
arms for `@media`, `@supports`, `@property`, plus a generic `@anything;` fallback, all
begin with `@`.

That's the shape [`dispatch`](../reference/api#dispatch-combinator-when-otherwise) is for:
parse the at-keyword once, route the exact names with `when(...)`, and keep the generic
continuation in `otherwise(...)`. The grammar reads the way the language actually works,
and the compiled parser doesn't recheck the shared opener for every late or generic arm.

This is the scannerless story in miniature. Parséman doesn't need a separate lexer to
freeze every token kind before the grammar even sees it — but it still gets token-style
routing where that helps: parse the meaningful shared prefix once, then choose the
continuation from the value you got back or the next structural marker. CSS function
values, a CSS-superset dialect's `@supports`/`@media` overlapping with interpolation, and
same-opener node arms like identifier-or-function values all fit this shape. A sibling
`choice(...)` might also be correct, but `dispatch(...)` expresses the route the language
actually takes, and lets the chosen branch own its value with `routed()`.

`pnpm bench:dispatch` keeps small proof fixtures for this recommendation: the same-opener
at-rule case, broad identifier/function node arms where both the function arm and the
keyword arm start by parsing an identifier, and a `matches(...)` route. None of these are
literal-vs-literal comparisons on purpose — that's a case where plain `choice(...)`
already wins.

The benchmark prints current medians for each workload. Expect the broad-opener advantage
to shrink as more items take the same specialized route — the real win is avoiding
repeated opener parsing and fallback backtracking, not raw speed on any one item. Stick
with `choice(...)` for literal or first-set-disjoint arms, for closed sets with no generic
fallback, and for cases where one arm dominates and the rejected tails are cheap.

`matches(...)` dispatch arms are included for generated-code coverage of matcher routing.
They're tracked, not treated as a speed gate — the regex predicate itself does real work,
so small wins can get lost in run-to-run noise.

Treat this as a directional signal, not a hard release gate — absolute timings move with
the machine you're on. The normal test suite only checks that the two grammars are
equivalent and exercise the paths they're meant to. Opt into the timing check yourself
with:

```bash
PARSEMAN_PERF=1 pnpm vitest run --config vitest.perf.config.ts test/perf/dispatch-vs-choice.test.ts
```

## Measuring

```bash
pnpm bench                  # parser-to-parser comparison
pnpm bench:parseman         # Parseman interpreted vs compiled regression report
pnpm bench:svg              # chart-only benchmarks + regenerate assets/bench-*.svg
pnpm bench:baseline         # refresh the regression baseline + append a history snapshot
pnpm bench:release-compare-svg # regenerate committed 0.26/0.27/0.28 release evidence SVGs
pnpm bench:compile-grammars # regenerate the precompiled Peggy/Nearley/Jison parsers
pnpm bench:dispatch         # dispatch vs equivalent shared-opener choice A/B
pnpm perf:guard             # fast pre-commit CSS speed regression check

node --import tsx bench/compose-dispatch.ts   # composed-grammar first-char dispatch A/B
```

See [Benchmarks → Refreshing the charts](./benchmarks#refreshing-the-charts) for when
`bench:svg` is enough and when you need the full `bench` suite.

### Composed grammars

The cross-parser charts measure single grammars compiled as a whole. A grammar built with
[`compose([...])`](./extending) also gets first-char dispatch across its combined
artifacts (see [macro mode](./macro-mode#what-gets-emitted)), and
`bench/compose-dispatch.ts` isolates that effect: a CSS-value-shaped composed grammar
whose `value` rule is a `choice` over many cross-rule arms. With dispatch applied at fuse
time, the compiled parser skips arms whose first character can't match instead of trying
each one per token. Run it before and after a change to A/B it yourself — the win scales
with how many arms and `choice` rules a grammar has. A real stylesheet grammar, with a
15-arm value rule plus many selector choices, sees appreciably more benefit than one
isolated 6-arm choice.

The benchmark reports each grammar's median microseconds per op, interpreted and compiled,
with a delta against the committed baseline — so a regression shows up immediately. See
[Benchmarks](./benchmarks) for the full parser comparison charts across JSON, CSV, and
GraphQL.

## Library-level ideas

Everything above is what *you*, the grammar author, control. Below the grammar, the
compiler also lowers many `regex(…)` terminals into `charCodeAt` scan loops on its own —
see [Under the hood: regex lowering](./regex-lowering) for what gets lowered, into what,
and how it stays correct and fast.

Node capture is also driven by arity: a direct AST `build` that doesn't declare
`children`, `rawChildren`, `triviaLog`, or `state` pays nothing to collect them, while an
injected `ctx.build` host keeps the full CST contract. On value-dense grammars, that
difference is often a large slice of total parse time. See
[Capture follows your `build`'s arity](./ast#capture-follows-arity).

For the full catalog of library-level codegen and macro optimizations — choice
fast-paths, trivia loop specialization, transform/build inlining, and more — see
[`notes/PERF_IDEAS.md`](https://github.com/matthew-dean/parseman/blob/main/notes/PERF_IDEAS.md)
in the repo.
