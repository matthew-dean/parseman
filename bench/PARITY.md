# Benchmark parity & fairness

`bench/run.ts` compares parser libraries head-to-head. For that to mean anything,
every parser in a language suite must do **equivalent work** — recognize the
input *and* build the same value. If one library returns a heavier structure
(e.g. a CST) or a lighter one (recognition only), the numbers compare different
jobs.

## The rule

Every bench parser for a language builds the **same value** as the reference:

- **GraphQL** → the plain-object AST of `examples/graphql/parser.ts`
  (`parseGraphQL`).
- **JSON** → the value `JSON.parse` produces.

This is enforced by `test/parity/bench-parsers.test.ts`, which runs in the normal
test suite. Add a parser or change a grammar's output shape and it must still
`toEqual` the reference on every fixture.

`toEqual` (not `toStrictEqual`) is intentional: some parsers build
null-prototype objects (`Object.create(null)`, to avoid `__proto__` injection) —
the same values, so they pass.

## Chevrotain — PR #2189 background

[Chevrotain#2189](https://github.com/Chevrotain/chevrotain/pull/2189) surfaced
that the Chevrotain benches here weren't doing the same work as the others:

- **JSON** used a `CstParser`: *recognize → build a CST → traverse the CST to
  build the JS value*. The other parsers build the value in one pass. This was a
  large, real tax.
- **GraphQL** used a `CstParser` too, but the bench returned the CST without
  traversing it — so the tax was smaller than JSON's, and a *different* problem
  dominated (below).

Both are now `EmbeddedActionsParser`s that build the value directly, matching
`bench/chevrotain-csv.ts` (which was already written this way).

Two fixes, and their measured effect (`bench/run.ts`, warm; representative):

1. **CST → single-pass value building.** JSON large **~1820µs → ~270µs** (~6.8×):
   this is the CST-construction + CST→value traversal the others never did.
2. **Cache the `OR` alternatives arrays**
   ([Chevrotain perf guide](https://chevrotain.io/docs/guide/performance.html#caching-arrays-of-alternatives)).
   A fresh array of alternative closures was allocated on every rule invocation.
   GraphQL large **~815µs → ~460µs** (~1.8×). This — not the CST — was the
   dominant cost for GraphQL, since that bench never traversed its CST.

Net: the fair, tuned Chevrotain is substantially faster than the old bench in
both languages, and now builds the identical value everything else does.

## Architecture note (inherent, not fixed)

Parséman / Peggy / Parsimmon are **scannerless**; Nearley / Jison / Chevrotain
are **lexer-based** (they build a token array first). On value-dense inputs like
JSON that token-construction cost is inherent to the approach, not a benchmark
artifact — it is disclosed, not neutralized.
