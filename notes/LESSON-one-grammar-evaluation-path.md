# LESSON — one grammar-evaluation path

**Status: DONE.** `evaluateParserFactory` calls `rules()`. There is no second
implementation left to drift from.

Landed on `lane/macro-lowering` over `6747872`: `86b78fe` (the two fixes),
`b4a7d1d` (the route-agreement gate), `2239369` (the collapse).

## What was wrong

A grammar reached `encodeTable` two ways, and BOTH sides of the fork were
reimplementations rather than callers.

- `plugin/evaluator.ts`'s `evaluateParserFactory` reproduced `rules()`
  (`combinators/parser.ts:136`): mint a `ref()` per declared key, build a `g`
  proxy that hands back a placeholder for any name, evaluate, define each slot,
  tag each rule.
- `plugin/index.ts` then reproduced `rules()`'s CLOSING STAMPS a third time —
  `grammarScanSkip`, `grammarHostMode`, `grammarTrackLines` — in three loops
  whose own comment said it had to, "because the macro evaluates the FACTORY
  directly and never calls `rules()`".

Nothing asserted the two produced the same program. What that cost:

| | shipped macro artifact | runtime encode |
|---|---:|---:|
| `SEQ` (builds a tuple) | 326 | 8 |
| `SEQV` (does not) | 4 | 322 |
| `REP` (builds an array) | 110 | 20 |
| `REPV` (does not) | 20 | 90 |
| choice arms with NO first set | 195 / 562 | 103 / 540 |
| dispatch sites keeping the O(1) piece | 31 | 41 |
| char-class pool | 109 | 167 |

jess/less, AST variant, 278 rules both sides. ~29% on `benchmark.less`, on the
path all four jess grammars ship. Two independent causes: the missing
`markUnusedValues`, and `firstSetOf` degrading an unbound `g.X` to `any` while
emission resolved the same reference through `winners`.

## Why the collapse was cheap, having looked expensive

The first attempt at framing this was "extract a shared `finalizeRuleMap()` both
routes call", and that DOES look expensive — `hostMode` and `trackLines` arrive as
`RulesOptions` at runtime and as `TableSettings` under the macro, and the
`trackLines` half REPLACES map entries rather than only stamping metadata.

That framing was wrong. The answer is not a new shared function; it is **one
route calling the other's constructor.** `rules()` takes a factory, and
`evaluateParserFactory` has one — as an AST rather than a closure. Handing
`rules()` a closure that evaluates that AST against whatever proxy `rules()`
supplies gives away every step at once, and the options objection dissolves
because they are simply the argument.

Worth remembering as a shape: when two implementations of one job look expensive
to unify behind a third thing, check whether one can just *call* the other.

## What converging on the runtime shape changed

The runtime shape is the correct one on every quantity measured, so the collapse
lands on it rather than meeting in the middle. A key the factory never referenced
through `g` now comes back as the parser itself rather than a `lazy` wrapping it.

- **4 size fixtures dropped below their committed ceiling** — the hop was rows in
  every emitted program.
- **The macro stopped minting coverage ids with a `lazy:0` segment.** Verified
  against `buildGrammarPlan` over the same grammar built with the real `rules()`:
  runtime mints `dispatch:Entry/matcher:startsWith:%40-`, the macro used to mint
  `dispatch:Entry/lazy:0/matcher:startsWith:%40-`. The two routes had different
  coverage DENOMINATORS for one grammar — a fourth instance of the same defect
  class, and one nobody was looking for.
- **`trackLines` became correct**, because `rules()` wraps rather than only
  stamps.
- jess's four grammars are exactly neutral (`size:jess` byte-identical on all
  sixteen rows, opcode histogram unchanged), because they reference every rule
  through `g` and so already had a placeholder everywhere.

## What still holds the line

`test/unit/encode-route-agreement.test.ts`. It now passes because there is one
route, which is the point — it is a tripwire against re-forking, not a
reconciliation. It compares the reachable opcode histogram, the char-class pool
and the gating summary, deliberately not the raw code stream: the two routes lay
rules out in different orders and always have.

Keep it. A trivially-passing gate that screams if someone re-forks the routes
costs nothing and is the only thing standing between here and a fifth instance.
