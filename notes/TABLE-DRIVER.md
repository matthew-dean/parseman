# Grammar as a table, read by one shared driver

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
`bench/table-size.ts`):

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

`bench/table-size.ts`. Artifacts written to `/tmp/pm-table-size/<unit>/`.

```
    n  codegen B   gzip     table B   gzip   words   ratio
    1       8354    2250        340     252      38  24.57x
   32     161242   20516       3838    1341     813  42.01x

  MARGINAL BYTES PER ADDITIONAL RULE (fit over n=1..32)
    codegen (shipped)  4932 B/rule
    table               113 B/rule     43.7x smaller
```

json, 9 productions: **1,072 B** table vs **16,203 B** codegen (`example/json`
in `bench/size-baseline.json`) — 15.1x.

The driver is a fixed cost paid once for a whole bundle: ~26 KB of TS source
(unminified, comments included), break-even at ~5 rules.

## Speed — measured, with a control, and the scaling explained

### The gap does not widen. It asymptotes.

The three-point reading (+82% small, +228% medium, +275% large) invited the
conclusion that something in the driver is per-item. `bench/table-scaling.ts`
takes eight points on one grammar with linearly-scaling work, control within
±3.3%:

Re-taken on a QUIET box (loadavg 6-7, control within ±1.3%) after the machine
came free; the loaded readings are kept beside them because they agree, which is
the useful fact about them.

```
    records    bytes    loaded    quiet    after fuse+collapse
    n=1           81     2.28x    2.27x         2.00x
    n=8          641     3.08x    3.00x         2.55x
    n=64        5121     3.12x    3.08x         2.61x
    n=1024     81921     3.29x    3.17x         2.65x
```

From n=8 to n=1024 — 128x the work — the ratio moves 4-7%. That is an ASYMPTOTE.
The small-input numbers are a shared PER-PARSE fixed cost (ctx setup, `run()`
bookkeeping) that both sides pay identically, diluting the ratio when the parse
is tiny. **The real figure is ~3.2x in steady state**, and there is no per-item
defect to hunt: the cost IS the interpretation.

### Two mechanisms proposed, both refuted

`bench/table-alloc-ablation.ts` keeps the previous driver alive in the same process
(`src/table/exec-baseline.ts`) so one change is measured against a same-path
control, because cross-run comparison is not available on this machine.

| candidate | mechanism | result |
|---|---|---|
| per-item mark ALLOCATION | `saveCstMark`/`saveTriviaMark` allocate per repetition item and per choice attempt | −20.7% large in one run, **+1.6% in the next**, clean control both times. Did not replicate. |
| TRIVIA handling | `advanceTrivia` per term where codegen inlines a charCode loop | gap on whitespace-free input +94/+281/+251 vs +99/+217/+245 with trivia. **Unmoved.** |

### What did work

**Terminal fast path in `SEQ`** — reaching a `LIT`/`RX` through `exec` costs a JS
call frame plus a switch dispatch the emitted code does not pay, and terminals
are the majority of executed instructions. Running them in place:
**−3.7% / −8.2% / −6.7%** against a control of +2.3% / +2.3% / −0.2%.

**`SEQX` — fusing `transform(sequence(...))` into ONE row**, plus an encode-time
peephole that collapses `OP_RULE` pure-indirection rows out of every child slot.
Mechanism, stated before it was tried: that pair is the dominant shape in every
grammar here (json is nine of them) and costs two dispatches and two call frames
per rule invocation where the emitted code pays neither; an `OP_RULE` row is a
dispatch and a frame to do nothing but jump.

**−17.9% / −24.7% / −25.8%** against a control of +1.6% / +0.7% / +0.3%. It is
also a size win: json 116 → 108 words, csv 82 → 76, lang 301 → 277, graphql
426 → 386, and `RULE` rows are gone entirely.

The A/B for it needed a frozen ENCODER as well as a frozen driver
(`src/table/encode-baseline.ts`), because the change spans both — handing the new
table to the old driver just crashes on an opcode it never had.

The mark guard was kept anyway: when no sink is live nothing was recorded, so
nothing needs unrecording. Correct on its own terms whatever it is worth in
wall clock.

## Speed — measured, with a control

`bench/table-speed-ab.ts` and `bench/table-vs-field.ts`, both over `bench/ab-harness.ts`'s
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

**The table driver is ~2.6x slower than codegen in steady state** (was ~3.1x
before the fusion pass below), and 1.6-2.9x faster than the interpreter.

That cost is real and it is the price of the size result. Goal 1 asks whether it
costs the FIELD, which is a different question. `bench/table-vs-field.ts`, loadavg
43.7, control −1.4 / +0.2 / −1.7%:

Three runs, at loadavg 43.7, 6.1 and 6.6. The first two are the same driver
before the fusion pass and they agree, which is what makes the third readable as
a result rather than a fluctuation.

```
                              loaded 43.7      quiet 6.1     after fuse+collapse
  CONTROL compiled->compiled  -1.4/+0.2/-1.7   -1.3/+1.7/-2.7   -3.5/+1.4/-2.2
  GATE    compiled->table    +70.3/+165/+188  +78.0/+163/+184  +61.4/+134/+152
  FIELD   table->chevrotain  -10.3/+31.9/+23.5 -10.0/+30.4/+25.6 -4.6/+46.7/+43.4
  FIELD   table->peggy       +92.0/+159/+123  +92.0/+165/+124  +112/+199/+159
  FIELD   table->parsimmon   +388/+611/+549   +391/+595/+551   +438/+677/+633
  FIELD   table->nearley     +434/+1005/+1017 +454/+989/+1021  +519/+1113/+1188
  FIELD   table->jison       +397/+639/+627   +412/+614/+611   +463/+720/+721
```

**GOAL 1 HOLDS.** pm/table beats peggy, parsimmon, nearley and jison on every
case by 112%-1188%, and beats chevrotain on medium and large by 46.7% and 43.4%.
On the 81-byte input it trails chevrotain by 4.6% against a −3.5% control — a
loss that was a clear 10% before the fusion pass and is now at the noise floor.

## Variants — the point of the exercise

`bench/table-variants.ts`. Four settings pairs, one driver:

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

`bench/table-lowering-sweep.ts` digests `interpreted | compiled | table` with
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

`bench/table-opcode-gaps.ts` walks every real grammar in the repo through
`encodeTable`. This is measured, not extrapolated:

| grammar | result |
|---|---|
| `examples/csv` | encodes — 82 words |
| `examples/json` | encodes — 122 words |
| `examples/lang` | encodes — 301 words |
| `examples/graphql` | encodes — 426 words |
| `bench/workloads/less` (29 rules) | encodes — 1,277 words |
| `examples/css` | encodes — 606 words (5 `CALL` rows) |

**EVERY real grammar in the repo now encodes, and every one is tree-identical on
its fixtures** (42/42 cases across eight grammars).

`scanTo` closed via `OP_CALL`, which runs a pooled COMBINATOR through its own
`.parse` rather than re-implementing it. Reaching for that also caught a latent
defect in this encoder: **`token()` was being treated as a transparent wrapper
and is not.** It clears trivia AND every capture sink, then emits one leaf, so
transparency leaks the inner captures to the parent and lets trivia be skipped
inside a glued token. `balanced()` is sharper still — it OVERRIDES `.parse` to
re-resolve ambient `scanSkip` while leaving `_def` as the eager interior, so
encoding it structurally builds the wrong parser and reports nothing. All three
now run as the real combinator. What closed the gaps:

- `keywords` needed NO new opcode — `keywords()` compiles to one sticky regex
  plus a leaf push, which is exactly what `RX` does, so the encoder rebuilds the
  same regex (`src/combinators/keywords.ts:87-106`).
- `expect` got one row (`OP_EXPECT`): it never fails, it yields a zero-width
  `ParseError` value.
- `literalsLongestFirst` is an arm ORDER, and order is table data — encode the
  arms in `sortedIndices` order.
- `sharedPrefix` is documented in `choice.ts:52` as a firstMatch specialization,
  so declared order is already right for it.

Two choice shapes are REFUSED rather than approximated, because each would pick a
different arm and build a different tree behind a successful parse:

- `greedyClassify` runs one arm and then re-attributes the match to a DIFFERENT
  arm by string equality, re-applying that arm's transforms. Different execution,
  not different order.
- any choice with a non-null `autoNot` entry — that table rejects an arm which
  matched but is followed by a char in a sibling's first set.

`scanTo` is the one construct left, and it is the largest: a sentinel scan with a
skip list, raw mode and `orEOF` (`src/combinators/scanTo.ts`, 12 KB).

### A fourth defect, caught by adding `examples/lang`

`optional()` yields `null` on no-match (`src/combinators/repeat.ts:269,277`) and
grammars TEST for it — `examples/lang`'s `call` reducer is
`if (args === null) return callee`. The driver returned `undefined`, so a bare
identifier became a call node with `args: undefined`. The parse succeeded, the
span was right, and only the tree moved. Same signature as the other three.

### What jess actually needs — counted, not assumed

Call sites across the four `packages/syntax/*/*-parser/src/grammar.ts` files,
comment lines excluded:

| construct | sites | status |
|---|---:|---|
| `node(` | 402 | covered (direct-builder path) |
| `field(` | 32 | **missing** — records a named field into `ctx._fields`; one row |
| `dispatch(` | 29 | **missing** — parse a selector once, route by value; one row plus a case table |
| `scanTo(` | 22 | **missing** — the large one |
| `keywords(` | 21 | covered |
| `balanced(` | 12 | **missing, and was not on anyone's list** |
| `expect(` | 11 | covered |
| `guard(` | 0 | not used — `guard` appears only as an identifier fragment |
| `recover(` | 0 | not used |
| `withCtx(` | 0 | not used |

Two corrections to the assumed set: **`guard`, `recover` and `withCtx` are not
called anywhere in jess's grammars**, and **`balanced` is, 12 times, and was not
in the assumed list at all.**

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
   1,277 words for 29 rules is 44.0 words/rule. (An earlier draft said 1,190 /
   ~41 here while the table above said 1,277; 1,277 is the measured figure —
   `encodeTable(lessRules, {}).code.length` — and the two now agree.)
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


---

## A shipped-path defect found on the way (NOT in `src/table/`)

`bench/choice-disjoint-lazy-arms-repro.ts`. Two grammars, one language, identical arms and
identical trees. The only difference is whether the arms are written directly or
reached through `g.`:

```
  direct  choice: disjoint = true
  via g.  choice: disjoint = false   <- SAME ARMS

  CONTROL  direct -> direct    items/64  +0.2%   items/512  -0.0%
  REPRO    direct -> via g.    items/64 +35.7%   items/512 +40.3%
```

`choice()` decides `disjoint` at CONSTRUCTION from `p._meta.firstSet`
(`src/combinators/choice.ts:35`) and builds its ASCII dispatch table only if that
is true (`:62`, consumed at `:90`). A `rules()` arm is a lazy proxy whose shallow
first set is `any` until the map closes, so `areDisjoint` reports false and the
table is never built — for exactly the choices an author gated most carefully.

**The interpreter runs 36-40% slower on a perfectly gated choice because it was
written recursively.**

SCOPE, verified rather than assumed, because the first framing of this was wider
than the evidence:

- **Codegen is NOT affected.** The emitted artifact recomputes deep first sets
  and emits a real `if (_code === 123) … else if (_code === 91) …` chain.
  Verified in the lowered artifact at `/tmp/pm-disjoint/g.out.js`.
- **`diagnoseGrammar` is NOT lying.** It reports `gates: "recoverable"` with
  `ok: true` and no finding — a named third state, not a false alarm.
- **There is NO mis-parse.** Ordered first-match returns the same arm; it just
  tries them one at a time.

So this is an interpreter PERFORMANCE defect, worth filing on its own, and it is
not evidence about the compiled path.

## Owed once this is proven: a top-to-bottom docs audit

Owner, on accepting the parse cost: *"if / when this all gets proven out, and our
perf numbers hold up, then we would need a top-to-bottom audit and rewrite of docs
since the way we lower (and expected codegen output) would have changed."*

The part that makes this larger than a rewrite of output descriptions: **the
authoring guidance inverts.** Most of what jess's grammar docs tell an author is
arithmetic about how codegen EMITS, not about the grammar.

Invalidated or needing re-derivation under a table lowering:

- **`docs/state/GRAMMAR-SIZE-FACTS.md` — most of §2.** ~950 B per call site;
  `node()` 3,425 B against `transform()`'s 46 B; `keywords()` vs `word()` arms at
  18.6x; `g.X` vs by-const at 13.69x; the depth x reference-path-count rule; "name
  the deep spine, inline shallow leaves". Each is a property of codegen emission.
  A table rule costs ~113 B regardless of which of these an author picks, so
  several stop being true and at least one inverts.
- **The nine contamination filters** were derived by measuring codegen artifacts.
  The measurement DISCIPLINE survives; the specific rows need re-derivation.
- **H1 / H2 inlining defects** are a codegen concept. A table does not inline, so
  the whole refshape analysis has no referent.
- **The promotion sweep** (css 28.47x -> 17.71x, less 16.22x -> 10.08x) is a
  codegen result. It says nothing about a table artifact.
- **`docs/architecture/parser/GRAMMAR-REVIEW-STANDARD.md`** — the items that
  reference emitted output, including the byte-identity oracle's subject.
- **`docs/design/GRAMMAR-REBUILD-SPEC.md`** — goal-2 arithmetic throughout.
- **The codegen-referencing G-rows** in `docs/architecture/core/DESIGN-DECISIONS.md`,
  notably G6 (`g.X` resolves at macro time), G9, G20.

Surviving unchanged, because they are combinator semantics rather than emission:
the cheat sheet's spread/contributes-one-child contracts for all 95 exports, the
arity rules, and the trivia/adjacency model.

This is gated on C and D. Do not start it early — a rewrite against a lowering
that has not proven tree identity on the jess grammars would have to be redone.

---

## Follow-up queue (owner-parked at 0.47.0)

Owner's direction at the 0.47.0 finish line was *"grammar optimization and
railroad diagrams can be a follow-up, you need to get 0.47 past the finish
line"*. The table ships as an exported-but-unwired prototype. These are the
parked items, in the order they unblock each other:

1. **`balanced()`** — `token`-shaped over its eager interior, and `token` is
   already lowered. `_balancedAmbient` and the interior `self` back-edge sit on
   the INNER combinator (`balanced()` returns `token(combi)`), so the detection
   must look at the child, not the outer node. The read-back must distinguish
   **acceptance from recovery**: `balanced()` does detect crossed closures —
   `([a)]` reports `errors=1` via `expect()` — and a probe that measures only
   consumption cannot tell that from acceptance. It also has a documented
   history of contributing 7 children rather than 1; if a lowering moves that
   number in either direction, that is a tree-shape change and must be said.
2. **`scanTo()`** — the one with real structure. Its `scanSkip` set is ambient
   but static per scope, so it should encode as offsets installed by `OP_SCOPE`.
   PROVE that rather than assume it: a skip set that resolves at the outer scope
   and silently empties in an inner one is the same silent shape as the ambient
   trivia bug, and a corpus parse would not obviously show it.
3. **The emit round-trip for SHIPPING grammars.** Round-trips exist for small
   fixtures (dispatch, labelled trivia). No shipping grammar can be emitted at
   all until 1 and 2 land, because both park live combinators in the const pool.
4. **Per-dialect bytes and timings.** Blocked on 3 for bytes. Timings were
   deferred throughout development on a box that sat above load 15; run them
   quiet, print the load average at start and end, and name the instrument.
5. **Furthest-failure merging.** Both shipped engines report the expected set at
   the furthest position an enclosing sequence could also have closed at; the
   table reports the failing choice's own union at its own position. Position
   and count now agree — the residue is one element, pinned as an exact set
   difference in `test/unit/table-encode-refusals.test.ts`.

Also open, and smaller: the structural-node refusal under `hostMode: 'cst'`
(correct for `'ast'`, a gap for `'cst'`, fails closed), and the three remaining
expected-set shapes (`keywords()`, `peek()`, `sepBy`-min).

**On figures.** `113 B/rule` and `~2.65x` were measured on a synthetic ladder and
on json, never on a shipping grammar. Do not quote them as per-dialect results.
When quoting any number here, name the instrument that produced it — the gated
tests under `test/unit/table-*.test.ts` and the ungated
`bench/table-lowering-sweep.ts` are not the same evidence.

---

## The jess-corpus identity harness (COMMITTED — do not rebuild it a fourth time)

`bench/jess/` runs a THREE-WAY identity sweep — interpreted | compiled | table —
over jess's four shipping grammars and their real corpora. Three previous lanes
built a version of this and lost it with their worktrees.

```sh
pnpm divergence:jess less --list      # one dialect per invocation
```

- `register.mjs` / `hooks.mjs` — ESM hooks. The grammars are macro modules
  (`with { type: 'macro' }`, which node refuses) and they are `.ts`. The hooks
  strip import attributes, transpile with esbuild, resolve `parseman` and
  `parseman/<sub>` into THIS worktree's `src/`, and resolve
  `@jesscss/parser-shared/*` to that package's `src/`. Loading jess's built
  `lib/` instead measures a grammar this worktree never saw — less and scss do
  not even fuse against it ("references missing rule").
- With `PM_MACRO=1` the same hooks run the macro-tagged modules through
  `transformMacro` instead, so the module exports the CODEGEN artifact. That is
  the honest "old compiled" leg.
- `grammars.ts` — the four `composeLeaf()` maps plus their corpora.
- `digest.ts` — ONE engine's answer per file, as TSV. Each leg is its own
  process: the interpreted fuse binds the shared recognition pieces in place and
  the macro lowering replaces the grammar module outright, so the three cannot
  coexist. It asserts the leg is the leg it claims (a codegen rule is a
  FUNCTION, the interpreted fuse leaves an object) — `run()` accepts both, so a
  `compiled` leg that silently got the combinator graph would show a perfect
  interpreted-vs-compiled agreement and prove nothing.
- `divergence.ts` — spawns the three and joins their digests.

`JESS_ROOT` overrides the checkout path (default `~/git/oss/jess`). The scss
corpus is the first 400 sass-spec inputs in sorted order.

### Two method corrections, both of which changed the answer

1. **Identity is the WHOLE `RunResult`, not the tree.** A `{ ok, value,
   unconsumedFrom }` digest agreed on files where the engines had taken
   different paths to the same answer. The comparison is now every field `run()`
   returns, digested per FACET — value, span (which carries the FAILURE
   POSITION), the expected SET, its order, the recovery ERRORS with messages and
   spans, and root trivia.
2. **The bar is three engines, not two.** A two-way version compared the table
   against the INTERPRETER and scored every disagreement as a table defect. Under
   the three-way sweep **`table-outlier` is 0 in every dialect**: there is no file
   in 626 where interpreted and compiled agree and the table alone differs.

Do NOT substitute `compose([ruleMap])` for the macro leg. `composeLeaf()`
documents that a leaf grammar never falls back to runtime codegen composition;
that path builds a DIFFERENT parser, and it was observed disagreeing with both
other engines on trees, spans and reducer throws. The macro leg requires
`@jesscss/parser-shared`'s `lib/` to be current, because the macro's own module
resolver honours package `exports` and cannot be pointed at `src/`.

### What it found

**Round 1 — two table-driver defects**, both invisible to `pnpm test` (the suite
was green with both live) and both reachable only through Less, which is the only
dialect that calls `leaf()` and the only one running `peek(classifiedTrivia)` at
a repeat's first item:

1. **`OP_LEAF` was not a capture boundary.** `leaf()` suppresses its interior's
   own CST captures and contributes ONE leaf (`src/combinators/token.ts:89-127`).
   The driver ran the interior with the parent's sinks live, so interior
   terminals leaked into the parent's `children` and moved the enclosing
   reducer's arity.
2. **`OP_REP` skipped leading trivia before the MANDATORY first item.** Only
   `many()` — min 0, no separator — runs its first item through `repItem`
   (`src/combinators/repeat.ts:130-137`); `oneOrMore`/`atLeast` (`:203`) and
   `sepBy` (`:412`) parse it at `pos`.

**Round 2 — the residual is not the table.** Three-way, after both fixes:

| dialect | files | identical | table-outlier | interp-outlier | compiled-outlier | three-way |
|---|---:|---:|---:|---:|---:|---:|
| css | 87 | 58 | **0** | 2 | 18 | 9 |
| scss | 400 | 315 | **0** | 83 | 0 | 2 |
| jess | 3 | 1 | **0** | 0 | 2 | 0 |
| less | 136 | 130 | **0** | 0 | 6 | 0 |

The `interp-outlier` column is what a two-way sweep called "the table's residual
css 11 + scss 85". It is drift between the two SHIPPED engines, on `expected`
only, and the table sides with what ships compiled. `compiled-outlier` is a
SEPARATE pre-existing class the table is not party to — on less it moves `value`
and `span`, i.e. the compiled engine builds a different tree on 6 fixtures where
the interpreter and the table agree. Neither is gated by anything today.

### Open, with reproductions

- **`keywords()` reports the category, not its words.** `src/combinators/keywords.ts:137`
  and `src/compiler/codegen.ts:1489,1669` emit the bare string `'keyword'`, while
  the same combinator's own `deriveExpected` (`src/combinators/expect.ts:44`) and
  codegen's merged-choice path both emit the N words — and `codegen.ts:1577`
  argues in favour of the words. `expected` is public API and the basis of
  `completionsAt`, so a category name gives an editor nothing.
  Repro: `sequence(choice(keywords(['if','ifdef']), literal('@')), literal(';'))`
  on `"zzz"`. Fixing all three to emit the words was tried and works, but it grows
  `example/graphql` by 149 B (+0.21%), which crosses its committed size ceiling
  (slack 0.1%) — an owner sign-off, not an agent decision — and it contradicts
  `test/unit/table-encode-refusals.test.ts:337`, which pins `['keyword']` as the
  intended answer. NOT LANDED; the owner owns this call.
- **`routed()` escapes as a top-level expectation under the table.** Repro:
  `a{@x}` under the css grammar — interpreted reports 26 tokens, compiled reports
  `[";", "{"]`, the table reports `["routed()"]`, which is a combinator name and
  not a token anyone can type. Same defect class as the one above, on the table
  side. `ctx._fe`/`_fx` are LAST-WRITE-WINS in both `src/table/exec.ts` and
  codegen, so which failure survives depends on evaluation order rather than on
  depth; a standalone `routed()` attempted after the real arm failed overwrites
  the better record.
