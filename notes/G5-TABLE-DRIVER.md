# G5 — grammar as a table, read by one shared driver

Status: **working prototype, landed on `pm-g5-driver`.** Not wired into the
macro, `compile()` or `compose()`; `src/table/` is additive and nothing existing
imports it. What follows is what was built and what it measured, so the next
lane starts from numbers rather than from the argument again.

The ruling (design ledger G5, owner verbatim):

> "basically, you should be reasoning about quickly building the grammar
> reference on run start, making some swaps on rules or sub-rules (leafs), and
> then the run actually runs with no logic branching for that option input"

## Why the per-rule floor exists

Every rule's recognizer is **inlined bespoke into its own emitted function**, so
an artifact pays the whole recognition machinery once PER RULE. Measured here
with the size probe's own ruler (`transformMacro` over a macro-tagged module,
`bench/g5-size.ts`):

| | marginal cost |
|---|---:|
| one additional distinct `node()` rule | **4,932 B** |
| one additional call site to an existing rule | **186 B** |

The call-site figure confirms `g.X` compiles to a direct static call and is not
the problem. The rule figure is the problem, and it is why `example/css` is
247,553 B for 26 productions and why jess's css parser ships four copies of one
grammar for four `trackLines` × `hostMode` variants.

## What was built

`src/table/` — a flat instruction table plus one interpreter.

| file | role |
|---|---|
| `ops.ts` | opcode set (20), with operand layouts as the encoder/driver contract |
| `encode.ts` | combinator graph → flat program. **Consumes the settings here.** |
| `exec.ts` | THE SHARED DRIVER. Reads no setting. |
| `program.ts` | the `(grammar, settings)` reference table, built once and cached |
| `emit.ts` | prints a program as the module a build emits |
| `inspect.ts` | reachability walk over the stream |

The driver uses the SAME zero-allocation protocol the emitted code uses — a
module sentinel for failure plus a shared end-position slot — so what it adds
over open-coded recognition is the opcode read and the switch, not an
allocation. That is the whole reason it is not the interpreter, which allocates
a `{ ok, value, span }` per combinator call.

Capture is **not** reimplemented: `OP_NODE` goes through
`src/cst/capture-buffer.ts`, the buffer the interpreter already uses. A second
implementation of it would be exactly the duplication this is about removing.

## Size — measured

`bench/g5-size.ts`. Artifacts written to `/tmp/pm-g5-size/<unit>/`.

```
    n  codegen B   gzip     table B   gzip   words   ratio
    1       8354    2250        340     252      38  24.57x
   32     161242   20516       3838    1341     813  42.01x

  MARGINAL BYTES PER ADDITIONAL RULE (fit over n=1..32)
    codegen (shipped)  4932 B/rule
    table   (G5)        113 B/rule     43.7x smaller
```

json, 9 productions: **1,072 B** table vs **16,203 B** codegen (`example/json`
in `bench/size-baseline.json`) — 15.1x.

The driver is a fixed cost paid once for a whole bundle: ~26 KB of TS source
(unminified, comments included), break-even at ~5 rules.

## Speed — measured, with a control

`bench/g5-speed.ts` and `bench/g5-field.ts`, both over `bench/ab-harness.ts`'s
`interleave` — one process, sides measured in adjacent order-alternated pairs.
A CONTROL contest (the compiled path against a second instance of ITSELF) runs
alongside and states the run's noise floor. The machine was at loadavg 90-120
throughout, so **`min` is the readable statistic and the medians are not**: the
control's median swung ±20-50% while its `min` held within ±3%.

Best run (loadavg 91, 20 pairs per case):

```
                              small     medium     large
  CONTROL compiled->compiled  -1.6%      -3.0%     -2.0%     <- the floor
  GATE    compiled->table    +82.0%    +228.1%   +275.4%
  REF     compiled->interp  +181.9%    +831.1%   +755.6%
```

**The table driver is 1.8-3.8x slower than codegen and 1.6-2.9x faster than the
interpreter.** Across three runs the gate band on `min` was +62..+82% (small),
+143..+391% (medium), +162..+275% (large).

That cost is real and it is the price of the size result. Goal 1 asks whether
it costs the FIELD, which is a different question, and `bench/g5-field.ts`
answers it directly: against the same external parsers the comparison chart
uses, in one process, **pm/table still beats peggy, parsimmon, nearley and jison
on every case by 85%-2600%**, and trades with chevrotain — chevrotain edges it
on the smallest input by a margin inside the control floor, pm/table wins
medium and large.

## Variants — the point of the exercise

`bench/g5-variants.ts`. Four settings pairs, one driver:

```
  hostMode=ast trackLines=false   2078 B   [LIT:32 RX:16 NODE:17   *_TRACK:0]
  hostMode=ast trackLines=true    2131 B   [LIT:0  RX:0  NODE:0    *_TRACK:32/16/17]
  hostMode=cst trackLines=false   2078 B
  hostMode=cst trackLines=true    2131 B

  four variants total 8,418 B of table
  option reads in src/table/exec.ts: 0
```

`trackLines` swaps every terminal and node row for its tracking twin at
table-build time; the driver holds a case per opcode and never asks whether
tracking is on. The parse output confirms it — the same grammar under the two
tables returns `{start,end}` and `{start,end,startLine,startColumn,…}`
respectively. `hostMode` sets the capture-flag operand. `resolveTable()`
memoizes on the program object, so one table per pair, built once.

For scale: the 16-rule ladder is 82,273 B under the shipped lowering for ONE
variant.

## Correctness

`bench/g5-run.ts` digests `interpreted | compiled | table` with
`parseman/oracle`'s `digestValue` — the repo's byte-identity primitive — over
the whole outcome (`ok`, value, `unconsumedFrom`). `interpreted ≡ compiled` is
already gated by `test/parity/*`, so agreement with both pins the new path.

**29/29 cases identical** across json (12, including whitespace, unicode escapes
and three failure inputs), the node-scale ladder at 4/8/16/32, the probe's
node-building base grammar (8), and **the 29-rule Less workload grammar on its
committed `app.less` / `site.css` / `decls.css` / `selector.css` fixtures (4)**.

Three defects the gate caught. Every one of them PARSED FINE and moved only the
tree — none would have been visible in a pass/fail test:

- a **nullable rule must not carry a first-set gate**. It legally matches where
  its first set cannot start, EOF included.
- **trivia precedes every repetition item, the first included.** Skipping it for
  the first dropped exactly one trivia-log entry per repetition — invisible in
  the parse, visible in a node's `triviaLog`.
- **O(1) first-char dispatch is sound only over DISJOINT arms**, and
  disjointness must be computed at encode time, not read off `def.disjoint`.
  That flag is set when `choice()` is constructed, when `g.X` arms are still
  unresolved refs reporting `any` — so every recursive grammar reports
  non-disjoint and silently loses its dispatch. With overlapping arms, "the
  first arm whose class contains this char" is not "the first arm that matches":
  a `Keyword` arm whose first set over-approximates to include digits was
  selected ahead of `Num` for the input `0`.

## Projection to the remaining grammars

`bench/g5-coverage.ts` walks every real grammar in the repo through
`encodeTable`. This is measured, not extrapolated:

| grammar | result |
|---|---|
| `examples/csv` | encodes — 82 words |
| `examples/json` | encodes — 119 words |
| `bench/workloads/less` (29 rules) | **encodes — 1,277 words, and is tree-identical on its fixtures** |
| `examples/lang` | blocked on `choice(strategy=literalsLongestFirst)` |
| `examples/graphql` | blocked on `keywords` (7 uses) |
| `examples/css` | blocked on `expect` (6), `scanTo` (5) |

So the 20 opcodes already cover the largest real grammar in the repo. **Four
constructs stand between the prototype and every grammar here**: the non-default
choice strategies (`literalsLongestFirst`, `sharedPrefix`, `greedyClassify`),
`keywords`, `expect`, `scanTo`. None needs a new execution model — `keywords` is
a trie terminal, `expect` a label around a child, `scanTo` a sentinel scan the
runtime already implements, and a strategy is an arm ORDER, which is table data.

`examples/lang` is worth calling out: an earlier revision encoded it silently and
WRONG, because a choice strategy reorders arms and lowering it as a plain ordered
choice picks a different arm. It now refuses. That is the second time in this
lane a defect showed up as a moved tree behind a successful parse, and it is why
the identity oracle is the gate rather than a test suite.

Assumptions in that projection, stated so they can be checked:

1. **The jess grammars need more than these three.** `dispatch`, `field`,
   `guard`, `withCtx` and `recover` appear in jess's four `grammar.ts` files and
   in none of the in-repo grammars, so they are unmeasured here.
2. **`node()` is covered only for the direct-builder path.** `unwrap`,
   `collapse`, `project`, the `ctx.build` host path and per-node trivia-kind
   masks throw `UnsupportedConstruct` rather than lower wrong. The Less workload
   exercises the direct-builder path with `rawChildren` and `triviaLog` reads,
   which is why its identity result is worth something.
3. **The 113 B/rule figure is for the ladder's rule shape.** A rule's table cost
   is proportional to its combinator count, so a large rule costs more — but it
   costs its OPERANDS, not a fresh copy of the machinery, which is the whole
   claim. json at 9 productions came out at 119 B/rule and the Less grammar at
   1,190 words for 29 rules is ~41 words/rule.
4. **The speed number is JSON's.** A grammar with heavier backtracking or deeper
   `node()` nesting will have a different ratio; css and less are unmeasured for
   speed under the table.

## What is NOT done

- Not wired into the macro / `compile()` / `compose()`. `encodeTable` takes a
  live rule map; a build would call it where `compileRuleMap` is called now.
- No incremental (`parseDoc.edit`), no `tolerant` recovery, no coverage
  instrumentation, no `_probe` completions path.
- `emitTableModule` prints a module but no build imports `parseman/table` yet —
  the subpath export is not declared in `package.json`.
- The driver's ~26 KB is unminified TS source, not the shipped runtime cost.
  Measure the bundled delta before quoting a break-even to anyone.
