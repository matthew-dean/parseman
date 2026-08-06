# REVIEW — child-kind specialisation: prediction defensibility and staging

Adversarial review of `notes/DESIGN-child-kind-specialisation.md` against
`notes/RELEASE-0.48-TARGET.md` §2/§3/§8/§8b/§9.

**Base.** `review/predictions` cut from `origin/design/child-kind` @ `eb516a4`.
**Method.** Static analysis, source reading, counting, and non-timing execution
(opcode census, row-execution counters under `PM_TABLE_COUNT=1`, a
`fastTriviaScanner` null check, an `encodeTable` structure dump, and a
re-implementation of `check-invariants.mjs`'s own INV-6 algorithm against the
real oxc AST). **No benchmark was run. Nothing was timed. `src/` was not modified.**

**Mandate.** Not "can this be done" — it must be. Every attack below carries a
constructive alternative: a better prediction, a cheaper discriminator, or a
different ordering.

**Owner priority applied throughout:** (1) V8 execution speed, over all else;
(2) output size, second and real; (3) tests, third. Nothing in this review
recommends deferring a speed unit to protect a byte ceiling. Where U4's size
estimate is attacked, it is attacked as *arithmetic that will surprise the owner
mid-flight*, not as a reason to descope.

---

## 0. The five findings that change the plan

1. **U3 cannot deliver its css/less prediction, and the reason is not the one
   the design tested.** `buildFastTriviaScanner` *is* null for css and less —
   §9.3's guess is correct and I executed it. But `skipTrivia`'s fast path also
   requires `ctx._triviaLog === undefined` (`assemble.ts:461`), and the css/less
   workloads are built with `_triviaLog: []` (`bench/workloads/index.ts:104-106`).
   **A non-null scanner is unreachable on those workloads regardless.** U3 as
   scoped — a recogniser plus nine leaf bodies — moves css/less by **zero**.

2. **U3's json prediction is inverted.** It predicts "near zero" for json. json
   executes **6,005 `OP_RX` rows per parse (12.9% of all rows)**, each doing
   `re.lastIndex = pos; re.exec(input)` and allocating a match array. `ScanShape`
   leaf bodies are exactly what removes that. U3 is a **json** unit that is
   *also* a prerequisite for the css/less unit — not "the css/less unit".
   The document's sharpest falsifiable claim is backwards on both halves.

3. **U1's `_probe` component is worth ~0, not ~5 points.** All six
   `ctx._probe !== undefined` tests (`assemble.ts:669, 687, 706, 726, 749, 763`)
   are on the **failure** path, after `return`-ing from the success branch.
   §0.4's "a load and a branch on every leaf of every parse" and U1's "one of very
   few instructions in the success path" are both false. json reaches that line
   1,052 times against 19,966 literal executions (5.3%), with `ungatedFails=0`.
   The census also **misses the one `_probe` test that is on a hot success path**:
   `assemble.ts:803`, inside `OP_GATE` — which reads `ctx._probe` *and*
   `ctx._tolerant` on every first-set gate, and `_tolerant` is already a `RunCfg`
   field. That is a live INV-6 violation on a hot path today.

4. **U0 as specified is self-contradictory and its prediction is off by 12×.**
   §2.1 argues correctly that `ctx.trivia` is **per-scope runtime state**
   (`OP_SCOPE` swaps it mid-parse) and therefore *cannot* be a config bit. U0
   then adds `trivia` to `CONFIG_FIELDS` anyway. INV-6 reports member
   *expressions*, not reads, so the six `ctx.trivia = …` save/restore assignments
   in the scope pieces (`assemble.ts:1008-1033, 1152-1177, 2208-2243`) become
   findings. Simulated tightened run: **22 findings — `_probe` 7, `_tolerant` 3,
   `trivia` 12** — against a predicted "~6 and 1". And the *one* site U0 exists to
   catch, `nextTerm`'s `ctx.trivia === undefined` at `:526`, is **not among
   them**: `isPiece` rejects `FunctionDeclaration`, and `nextTerm` is one.

5. **U4's size arithmetic and U4's speed mechanism are built on two different
   models of what U4 emits.** §0.3 proves a distinct FunctionLiteral per site is
   the *only* way to get monomorphic feedback, and U4's change text says
   "sequence bodies emitted per site". The size estimate then prices a
   "~25 B binding line". Those are not the same artifact. Worse: §2 attributes
   the 224,100 → few-tens-of-KB gap to "codegen also pasted whole rule bodies
   under a 1000-node budget, and we do not" — but **`example/json` and
   `example/css` each have exactly ONE rule** (`r:{"Entry":134}` /
   `r:{"Entry":878}`). Rule-body inlining cannot be the difference when there is
   one rule. The stated size lever is inert on both fixtures used to size it.

---

## 1. Verified facts (what survives, what does not)

| claim | source | verdict |
|---|---|---|
| `OP_LIT` body as quoted, `startsWith` for every length | `assemble.ts:657-672` | **CONFIRMED** |
| `_probe` test is per-leaf on the parse path | §0.4.2 | **REFUTED** — failure path only; 6 of 7 sites |
| `END = e` is a Context-cell store | `assemble.ts:322, 665` | **CONFIRMED** |
| `nextTerm` 4 params, `ctx.trivia === undefined`, mark/rollback | `assemble.ts:525-550` | **CONFIRMED** (early return, not `else`) |
| `skipTrivia` gating as quoted | `assemble.ts:458-471` | **CONFIRMED** |
| `scanTrivia` returns `{end, commit}`; "two allocations per term" | `combinators/trivia-skip.ts:219-293` | **PARTIAL** — shape right, count wrong: **≥5 and input-dependent** (object, closure, a full ~30-slot detached `ParseContext`, a `ParseResult` + span, plus `oneOrMore`'s internals) |
| css fast trivia scanner is null | executed | **CONFIRMED** — css NULL, less NULL, json non-null, graphql non-null |
| css/less fall to a combinator re-entry | `trivia-skip.ts:239` | **CONFIRMED** — but via `scanTrivia`, not `advanceTrivia`, and **because capture is on**, not because the shape is unlowerable |
| `CONFIG_FIELDS = {trackLines, build}`; `isPiece` needs 3 params, `names[2]==='ctx'` | `scripts/check-invariants.mjs:586, 596-602` | **CONFIRMED**, plus two omissions: it also requires `names[0] === 'input'\|'_input'`, and it excludes `FunctionDeclaration`. `pos\|cur` is already accepted — U0's `pos\|cur` broadening is a **no-op** |
| counts: `_probe` 6 / `cstCaptureActive` 9 / `captureTrivia` 7 / `ctx.trivia===undefined` 1 / `_tolerant` 9 | §0.4 | **3 of 5 wrong**: `_probe` **7**, `_tolerant` **4** in code (9 counts prose in doc comments) |
| "json/document … 138 code rows" | §6, `RELEASE:361` | **WRONG UNIT** — 138 is `prog.code.length` in **Int32 words**. Reachable instruction **rows = 28**. css: 885 words / **154 rows** (165 sites incl. scan subtrees) |
| codegen json 15,138 B / css 224,100 B | baseline at `bfb17d1^` | **CONFIRMED** |
| `RATCHET_SLACK_PCT = 0.1`, +2 B on json fails | `bench/size-guard.ts:263, 545, 637-640` | **CONFIRMED** — true tolerance on json is ±1 B |
| interpreter-era bounds cited as evidence | §8b.1:804-811 | **NONE FOUND** — see §6 |
| reasoned from `bench/jess/fixture.ts`'s 4–9% | §0.2 | **NO** — correctly refuted and excluded |

Two citation defects worth fixing in place:

- The design says `src/table/trivia-skip.ts` throughout. **That file does not
  exist.** It is `src/combinators/trivia-skip.ts`. The line numbers are right.
- The design analyses `examples/css/parser.ts` for all three css/less rows.
  `css/stylesheet` does use it (`bench/workloads/index.ts:43`), but
  **`less/stylesheet` and `less/mixins` use `bench/workloads/less.ts`** — a file
  the design never opens. Its trivia is
  `trivia(oneOrMore(choice(ws, lineComment, blockComment)))`
  (`bench/workloads/less.ts:60-63`), i.e. one **extra** arm. The diagnosis
  transfers (I verified less → NULL); a patch validated only against
  `examples/css/parser.ts` will miss the `//` arm, which `untilLineBreakScanner`
  (`trivia-skip.ts:411-422`) would otherwise lower for free. Two of five
  regressed rows are governed by an unread file.

### The workload measurements this review is built on

Row-execution counts, one parse of the exact workload input, no timing:

```
json/document    60,323 B  totalRows=46,393  gatedEntries=4,204  ungatedEntries=0     ungatedFails=0
  LIT:19966  SEQX:12611  RX:6005  CHOICE:4204  XFORM:1502  REP:1052  OPT:1052  SCOPE:1
graphql/document 49,762 B  totalRows=53,706  gatedEntries=336    ungatedEntries=3,752 ungatedFails=952
  SEQX:14784 LIT:12096 OPT:10304 RX:8232 CHOICE:3976 REP:3641 XFORM:504 SEQ:168 SCOPE:1
```

json: LIT **43.0%**, RX 12.9%, SEQX 27.2%. Of 19,966 literal executions,
**19,516 (97.7%) are single-character**. These reconcile *exactly* with a census
of the input (751 objects, 301 arrays, 1,650 strings, 1,052 numbers, 450
keywords, 3,303 keys, 3,151 commas + 1,052 loop-exit comma probes), so the model
is derived, not estimated.

One asymmetry the design does not know about and that matters: **json's input
contains effectively zero structural whitespace** (`JSON.stringify` output; its
1,350 whitespace chars are all inside string values). graphql is **40.3%**
whitespace. The two "capture-off" workloads the design treats as a matched pair
are not matched on the trivia axis at all.

---

## 2. Per unit

### U0 — invariant checker

**Claimed mechanism.** Widen `CONFIG_FIELDS` and `isPiece` so the defects the
design removes become build failures, and every later unit is checked for free.
Predicted: 0% perf; ~6 `_probe`, 1 `trivia`, ~9 array sites.

**Weakest link.** The rule's *semantics*, not the author's reading. INV-6 fires
on any non-computed `ctx.<field>` MemberExpression — **writes included**.

**Defensible?** The direction yes; the specification no, on three counts:

1. **`trivia` must not join `CONFIG_FIELDS`.** §2.1 of the design proves it is
   per-scope runtime state. Adding it produces **12 findings**, six of them
   `ctx.trivia = …` restores that are *correct code*. §8 forbids exemptions
   ("a unit that needs an exemption is a unit that has misunderstood the
   design"), so U0 as written lands a checker that cannot go green without
   violating the design's own gate.
2. **The `pos|cur` broadening is a no-op** — `names[1]` is already unconstrained.
   The change that actually matters is admitting `FunctionDeclaration`, which is
   the *only* reason `nextTerm` (`:525`) and `skipTrivia` (`:458`) are invisible.
   §0.5 diagnoses the arity as the cause; the arity is not the cause.
3. **INV-7's "~9" is right by two cancelling errors.** `runners[i]` at `:1351`
   and `:1418` sit in `runSyncTerms`/`runAdjTerms`, whose params are
   `(input, pos, ctx, values)` — `values` follows `ctx`, so the trailing-suffix
   test rejects them. Four of the nine that *do* qualify (`:2253, 2255, 2263,
   2265`) are `kids[0]`, a constant index with nothing to dispatch on. **Genuinely
   dynamic `Piece[]` indexing inside a piece body: 5** (`:1627, 1716, 1734, 1760,
   2135`) — exactly the design's own `arms` list. Also: the checker uses
   `oxc-parser` with **no type checker** (`check-invariants.mjs:205`), so
   "`Piece[]`-typed" is not decidable; a purely syntactic rule flags 28 sites
   including `hi[…]`, `ascii[…]`, `mask[…]`, `gates[…]` — the ASCII/bitmask fast
   paths you specifically do not want reported.

**Revised prediction.** With `CONFIG_FIELDS = {trackLines, build, _probe,
_tolerant}` and `isPiece` admitting `FunctionDeclaration`: **11 findings**
(`_probe` 7, `_tolerant` 3, plus `:526`'s `ctx.trivia` if a separate read-only
`trivia` rule is added). INV-7 reporting-only: **5**. Perf 0% — agreed.

**Constructive.** Split the rule. `_probe`/`_tolerant` are config → INV-6.
`trivia` is not config → a distinct rule, "no piece may *read* `ctx.trivia` to
decide control flow", which catches `:526` and leaves the scope pieces alone.
And note in the rule's comment block that INV-6's field set is only safe because
it is hard-scoped to `assemble.ts` (`ASSEMBLER` at `:587`): widening scope to
`exec.ts` would surface 18 more sites that are correct by design.

---

### U1 — length-keyed literal bodies + `_probe` → `RunCfg`

**Claimed mechanism.** json's literals are 1–5 chars; it pays a `startsWith`
builtin call plus a `_probe` load-and-branch per literal where codegen paid one
to five inline integer compares and nothing. PREDICTED 20–30% of the +137%,
apportioned "roughly 20% and 5%".

**Weakest link.** The `_probe` half is on the failure path (finding 3). The
literal half rests on an unmeasured constant: the cost of `startsWith` on a
1-char needle.

**Defensible?** The literal half — yes, and now quantified. The `_probe` half —
no, by two orders of magnitude.

19,516 single-char `startsWith` per parse. `String.prototype.startsWith` is a
CSA builtin with no general `JSCallReducer` inlining path (unlike `charCodeAt`,
which lowers to a byte load); it pays argument adaptation, receiver and
searchString `ToString` checks, position clamping, then the compare. A realistic
delta against an inlined `charCodeAt(p) !== 123` is **7–23 ns**. Using the
row-execution count and the +137% ratio, that is:

| delta | saved | share of the json excess |
|---|---|---|
| 7 ns | 137 µs | **11%** |
| 15 ns | 293 µs | **23%** |
| 23 ns | 449 µs | **35%** |

**Revised estimate: U1 = 10–30% of the json excess, essentially all of it from
the literal bodies; `_probe` ≈ 0.05%.** So the design's headline range is
roughly right for the wrong reason, and its internal apportionment is wrong.

**The kill threshold is set inside the noise of its own mechanism.** "Kills the
hypothesis if json moves less than 10%" — but 11% is the *low end of the
mechanism working correctly*. A genuine small win would be read as a kill.
**Recommend restating: <5% kills the leaf-work model; 5–12% is ambiguous and
must not be read as a kill; >12% confirms it.**

**Constructive addition to U1.** `cstCaptureActive(ctx)` is called on **every
successful leaf** — 19,966 + 6,005 = 25,971 cross-module calls per json parse,
on a `withoutCapture` workload where it can only return false. §3.4 defers
capture elision to U5 because a *site-reachability* analysis can silently drop
CST children. **For a leaf that risk does not exist**: a leaf has no children to
drop, and `RunCfg.hostCst` already exists. If `hostCst === false` alone is
sufficient (this needs the same one-paragraph justification `RunCfg` demands of
every field), the leaf-only capture elision belongs in U1, not U5 — same opcode
family, same test surface, no reachability analysis, and it acts on 26k
executions rather than 20k.

---

### U2 — inline `nextTerm` away, trivia at the site, capture tail in the loop

**Claimed mechanism.** A per-term option branch assembly could have resolved,
plus two allocations per term on capture workloads. PREDICTED json 10–20%;
css/less 200–400 of the 500–835 points.

**Weakest link (json).** The stated cause is wrong; the prediction is right
anyway. The mass in `nextTerm` is not "the removed `ctx.trivia` branch" — it is
`markCst` (`:395-425`), which on a `withoutCapture` parse loads **eight `ctx`
fields** and returns false, followed by four `need ?` ternaries and
`skipTrivia`'s three further `ctx` loads plus a call to a `SCAN` that, on json,
scans **zero characters** because the input has no structural whitespace.

At ~18,000 non-first terms and ~10–15 ns of protocol each, that is **160–270 µs
= 12–21% of the json excess**. The design's 10–20% is the best-calibrated number
in the document. `alwaysConsumes` — statically true for every literal and every
`min>=1` regex, i.e. most json terms — is what removes the eight loads, and it
has direct codegen precedent (`rewindable` gating in archived
`codegen.ts:emitSeqValues`). **Keep the number; replace the reasoning.**

**Weakest link (css/less).** Fatal, and it is a *sequencing* defect rather than
a magnitude error. U2's stated css/less mechanism is "the capture tail moves
*into* the scan loop (`CAP_RECORD`'s shape), killing the `{end, commit}` object".
**There is no scan loop for css/less to move it into** — `buildFastTriviaScanner`
returns null for both grammars, and even if it did not, `_triviaLog: []` bypasses
it. What U2 can deliver on css/less without U3 is only: the `alwaysConsumes` mark
elision, and 2 of the ≥5 allocations per term. The detached `ParseContext`, the
`ParseResult`, and the full `oneOrMore(choice(…))` combinator re-entry at
`trivia-skip.ts:239` all survive U2 untouched — and those are the expensive part.

**§9.2 is the right worry and it is under-stated.** The design defends its
allocation claim against RELEASE §3's measured **zero** for ~291k non-escaping
`node()` allocations by arguing these escape. Two of the five allocations do
escape; but the real cost is not the allocation, it is **a full interpreted
combinator parse per sequence term on a 64 KB input**. That reframing is
stronger than the design's own argument and does not depend on escape analysis
at all — which is fortunate, because the escape argument is exactly the kind
sampled profiling flatters.

**Revised estimate.** json **12–21%** (mechanism corrected, magnitude kept).
css/less **standalone: 40–150 points, not 200–400** — and the residual is worth
far more than either U2 or U3 claims individually.

---

### U3 — `ScanShape` port including `delimited`

**Claimed mechanism.** css/less trivia has no fast scanner, so every term falls
to a combinator re-entry. PREDICTED 150–300 further points on css/less; **json
essentially zero** — "the sharpest before/after prediction in the document".

**Weakest link.** Both halves of the sharp claim are wrong, in opposite
directions.

**css/less → 0, not 150–300.** §9.3's guess is correct: `fastTriviaScanner` is
null for css *and* for `bench/workloads/less.ts`. I executed it. But
`skipTrivia:461` requires `ctx._triviaLog === undefined`, and `scanTrivia:228`'s
own fast guard requires `log === undefined`. The css/less workloads set
`_triviaLog: []`. **Restoring the recogniser makes a scanner exist that nothing
on these workloads can reach.** U3 as scoped is a 1,627-line port that measures
zero on the rows it was written for. The correct statement of the defect is not
"block comments lost their recogniser" — it is **"the capture-on trivia path has
no lowered form at all"**.

**json → not zero.** json executes **6,005 `OP_RX` rows per parse (12.9% of all
rows)**: 4,953 string-inner and 1,052 number matches. Each does
`re.lastIndex = pos`, `re.exec(input)`, and allocates a match array that is read
once and discarded. `emitShapeMatch`'s `alt` and `seq` variants are precisely
what replaces that with an allocation-free char loop. **U3 should move json,
not css/less** — the exact inverse of the stated test.

This is the most consequential correction in the review. As written, U3 would
consume the largest budget in the plan, measure ~0 on the rows it targets, and
be read as falsifying the split model of §0.6 — when the split model is right
and only the *unit boundary* is wrong.

**Revised estimate.** U3-as-scoped: css/less **0**; json **10–25%** of the
excess (6,005 executions × regex-engine entry + one match-object allocation).

**Constructive — split U3 into two units that each pay:**

- **U3a — the capturing trivia lowering (the css/less unit).** Recognise only
  the four shapes css/less actually need — `chars`, `altStar`, `untilLineBreak`
  (for `bench/workloads/less.ts`'s `//` arm), `delimited` — and emit a scan loop
  **with the capture tail inside it**, selected by a `triviaCapture` `RunCfg`
  bit. This merges the *useful* half of U2 with the *useful* half of U3, is a
  small fraction of 1,627 lines, and is **the only work in the entire plan that
  touches the 500–835%**. It also disarms §9.7: the four shapes it needs are the
  four least likely to be superseded by token streaming.
- **U3b — `ScanShape` terminal bodies (the json/graphql unit).** The remaining
  shapes, routed through `OP_RX`. Pays on json's 6,005 and graphql's 8,232 regex
  executions. Defer the soundness-proof-heavy shapes until a row histogram
  (`src/table/inspect.ts`) says which are reachable.

---

### U4 — emitted source, static bindings

**Claimed mechanism.** §0.3 — V8 attaches inline-cache feedback to the
FunctionLiteral, not the closure, so every 2-ary sequence piece in the process
shares one feedback vector and `k0(...)` is megamorphic. Only emitting distinct
sites fixes it. PREDICTED the remaining 40–60% of the json floor.

**Weakest link.** §9.1 states it honestly: the `kNoClosures → kOneClosure →
kManyClosures` model is unverified in the shipped Node. I agree with the V8
reasoning and cannot fault it statically — which is exactly why the free check
must run *before* budget is committed, not before U4 is scheduled.

**Defensible?** The mechanism, yes. The magnitude is if anything **understated**
once U1's `_probe` component is corrected away: U1 10–30 + U2 12–21 leaves
**~50–75%** of the json excess for dispatch and the `END` Context-cell store,
against a claimed 40–60. Under the owner's speed-first priority this is the
largest term in the plan and the only one that addresses it.

**The unaddressed structural point.** §1's illustration shows `_r1 = make(_s0,
_s1, _s2, _s3)` — one `make` per *rule*. Both fixtures have exactly **one rule**
(`r:{"Entry":134}` / `r:{"Entry":878}`), so as illustrated `make` would take 28
and 165 arguments and could not express a tree. `make` has to be per-*site*.
That is not a fatal flaw, but §1 is the picture a reader sizes the unit from, and
it is not the artifact §6 prices.

**Revised estimate: U4 = 50–75% of the json excess**, conditional on the §9.1
check. If §9.1 refutes the feedback-vector model, **nothing else in the plan
addresses that 50–75%** — which is why the check outranks every implementation
unit in the schedule.

---

## 3. The size trade in U4 — the arithmetic does not support the range

Ground truth gathered for this review:

| | json | css |
|---|---|---|
| artifact today | 1,336 B | 9,229 B |
| `prog.code` words | 138 | 885 |
| **reachable rows / assembly sites** | **28** | **154 / 165** |
| rules | **1** | **1** |
| current cost per node | **47.7 B** | **55.9 B** |
| codegen | 15,138 B | 224,100 B |
| codegen per node | **541 B** | **1,358 B** |

Artifact composition (`src/table/emit.ts:174-185`), which is what U4 can and
cannot displace:

| line | json | css |
|---|---|---|
| `c:` code stream — **the only thing U4 removes** | 343 B (**25.7%**) | 2,467 B (**26.7%**) |
| `e:` expected-set pool — survives | 348 B (26.0%) | **3,601 B (39.0%)** |
| `k:` const pool | 152 B | 982 B |
| `f:` reducer sources | 183 B | 831 B |
| everything else | 310 B | 1,348 B |

**Four defects in the estimate, in order of weight.**

1. **The stated model and the stated range disagree.** "One binding line
   (~25 B) plus one `make(...)` argument list per node" prices out at
   **1,850–2,193 B (json)** and **11,831–14,298 B (css)** — *below* the predicted
   2,200–3,000 and 16,000–24,000, css by 11–26%. Back-solving the ranges gives
   **31–89 B/node**, against a stated model of ~30 B/node. The range was chosen
   first and the arithmetic attached after.

2. **The model prices the wrong artifact.** §0.3 requires a distinct
   FunctionLiteral per site and U4's change text says "sequence bodies emitted
   per site". A per-site emitted body is not a 25 B binding line. This is the
   same contradiction as finding 5: the speed thesis needs bodies, the size
   thesis prices wiring.

3. **The claimed size lever is inert on both fixtures.** §2's "codegen also
   pasted whole rule bodies under a 1000-node budget, and we do not — that single
   decision is most of the 224,100 → target gap" cannot hold when **each fixture
   has one rule**. There is no rule-body inlining to decline. Codegen's 541 and
   1,358 B/node *are* the cost of per-site bodies for 28 and 165 nodes, and U4
   emits per-site bodies for 28 and 165 nodes.

4. **The ratio is directionally backwards.** Node ratio css/json = 165/28 =
   5.89; byte ratio = 9,229/1,336 = 6.91. At any equal per-node cost css must
   grow by a factor **1.17× smaller** than json's. The design gives css the
   larger factor at both ends. Minor, but it confirms the ranges are not derived.

**My revised estimate.** U4's honest per-node cost is codegen's per-node cost
minus what the table's pools still deduplicate — chiefly the `e:` expected-set
pool, which codegen re-listed as an array literal at every failure site (visible
in the archived `test/unit/codegen-output.test.ts` snapshots), and the hoisted
regex consts. Call that a 2–4× reduction against codegen:

> **json 1,336 B → 4,000–8,000 B (3–6×). css 9,229 B → 40,000–110,000 B (4–12×).**

Both remain **2–5× below codegen** and both stay under the `ceiling: 10`
(`bytesRatio`: json 0.231 → ~0.7–1.4; css 0.950 → ~4.1–11.3 — css's top end is
the only figure that touches the ceiling at all).

**This is not an argument against U4.** Per the owner's priority, if the speed is
real the bytes are a named trade and the ratchet gets re-cut. The argument is
that **the number the owner signs off on should be 40–110 KB for css, not
16–24 KB**, because a ruling given on 16–24 KB and delivered at 80 KB stalls the
unit mid-flight and reads as a failure of the design rather than of the estimate.

**Constructive — the lever that actually bounds the bytes.** The design already
owns the right tool and mis-files it: `module-hoist.ts`'s use-count threshold,
**inverted**. Emit a distinct FunctionLiteral per site only for sites whose
*execution count* justifies one; leave cold sites on shared library pieces.
Execution counts are already obtainable with zero timing —
`bench/table-opcode-gaps.ts` with `PM_TABLE_COUNT=1` produced every number in
§1 of this review. For json, 43% of executions land on 11 `LIT` rows; a
hot-site-only emission captures most of the monomorphism win for a minority of
the bytes, and — importantly — **it is decidable before the emitter is written.**

---

## 4. Double-counting and accounting honesty

**The sums.** json: 20–30 + 10–20 + 40–60 = **70–110%** of +137%. At the low end
**30% of +137% (≈ +41%) is unallocated with no unit to own it**; at the high end
the plan overshoots by 10%. §9.4 admits the numbers were made to sum, which is
honest but does not discharge the planning problem: a plan that can legitimately
end at +41% with every unit having hit its prediction will read as failure.

**No true double-count in the json column, but three real accounting hazards:**

1. **The percentages are order-dependent and the plan does not say so.** All
   three are quoted as "% of the +137%", but U4 is explicitly "the remaining",
   i.e. residual after U1–U3. **U1 and U4 act on the same 19,966 literal
   executions**: U1 removes the `startsWith` in the leaf body, U4 removes the
   megamorphic call *to* that leaf and (per §2.3) pastes the leaf body into its
   parent. **U4 subsumes U1.** In the stated order the arithmetic is fine; if U4
   ever moves earlier, U1's 10–30% collapses to near zero. The plan needs an
   explicit restatement rule: *these are residual-ordered, not independent.*

2. **U2's "one fewer call frame" is counted twice.** It is the same frame U4
   removes. Small — ~18,000 × 1–2 ns ≈ 30 µs ≈ 2% — but it is in both budgets.

3. **The `alwaysConsumes` mark elision is in both U2 and U4.** U4's emitted
   bodies would omit the mark block for the same statically-decided reason. Again
   fine as residual, invalid if reordered.

**The css/less column is not accounted at all.** U2 200–400 + U3 150–300 =
350–700 against a 500–835 regression. At the low end **150 points are missing**,
and neither U1 nor U4 is credited with any css/less effect — although css/less
execute the same `OP_LIT`/`OP_RX` bodies and the same megamorphic dispatch, so
they must carry the json floor too. The design should state the css/less budget
as: *json-floor defects (U1 + U4, ~137 points) + trivia defects (U3a, the
balance)* — which happens to close the arithmetic, and which correctly predicts
that the two terms are separable.

**One unit-of-measure error worth fixing.** "138 code rows" is 138 **Int32
words**; the reachable row count is **28**. The design's own argument turns on
separating *sites* from *row executions* (§0.3, §2.3), so conflating the two
units in the sentence that introduces the discriminator is a real hazard —
particularly for U4, where "one binding per node" against 138 rather than 28
overestimates the artifact by 4.9×.

---

## 5. Interpreter-era bounds — the design is clean

Checked directly. `notes/RELEASE-0.48-TARGET.md` §2:44-47 names five bounds
measured against the retired bytecode interpreter — ~1.4 ms token scanning,
~1.6 ms superoperators, ~10% materialisation, ~0.1 ms builder megamorphism, and
leaf/trivia specialisation.

**None appears as evidence anywhere in the design.** The only occurrence is
§8b.1:804-811, which names them precisely in order to disclaim them and declines
to predict token streaming's payoff. Correct.

Likewise `bench/jess/fixture.ts`'s 4–9%: §0.2 refutes it with source evidence
(both legs are the table; `src/plugin/index.ts:28` imports only `compileTable`;
`src/compiler/codegen.ts` does not exist) and §6 does not use it. The
"UNRECONCILED" standoff at `RELEASE:411-419` is resolved in the right direction.

Two residual notes:

- **U4 leans on §3's "48 ns per piece against codegen's ~28 ns"** (design:650).
  That figure sits in the closure-assembler section and is not on §2's
  interpreter list, but it carries **no stated provenance — no fixture, no
  commit, no harness**. It is used to support the largest single prediction in
  the plan. It should be re-derived or dropped; as it stands it is an
  unattributed number doing load-bearing work, which is the same failure class
  §2 exists to warn about.
- **The design ignores a directly relevant *measured* precedent that cuts
  against it.** `RELEASE:72-78` records the labelled-trivia char scanner
  predicted at 1.2–1.6 ms and delivered **−0.8 ms**, with the lesson "the trivia
  scanner profiled at ~7.3% of parse self-time and was worth ~3.4%. Bound before
  building, and expect the profile to overstate." That is the closest thing in
  the repo to a measured bound on trivia-path work, and U2/U3 predict 350–700
  points from the trivia path without engaging it. It does not refute them — the
  css/less path is a *combinator re-entry*, a categorically larger cost than a
  scanner tuning — but the design should say so explicitly rather than leave the
  precedent unaddressed.

---

## 6. What is not predicted at all

1. **The css/less capturing trivia path has no owner.** U2 owns the allocation,
   U3 owns the recogniser, and **neither owns the detached `ParseContext` +
   `ParseResult` + `oneOrMore(choice(…))` re-entry at `trivia-skip.ts:239`** —
   which is the largest single item in the largest regression in the set. U3a
   above is the proposal.

2. **`bench/workloads/less.ts` is never read**, and it governs `less/stylesheet`
   and `less/mixins` — the two worst rows (+765…+844%).

3. **`OP_GATE`'s success-path config test** (`assemble.ts:803`:
   `ctx._probe === undefined && !ctx._tolerant && !classHas(...)`). css has 13
   `GATE` rows and less has 22; json has none, which is why the design's
   json-first reading missed it. `_tolerant` is *already* a `RunCfg` field, so
   this is a live INV-6 violation on a hot css/less path today. Free win, belongs
   in U1.

4. **`graphql/document` has no unit and no prediction** (§9.8 says so). It is not
   a curiosity: graphql has **3,752 speculative arm entries with 952 failures**
   where json has **zero**, and it is **40.3% whitespace** where json is ~0%. It
   is the only workload that exercises backtracking and trivia scanning together
   with capture off, so it is the natural control for U2 and U3b. Give it a
   predicted row.

5. **No unit owns the residual if §9.1 refutes the feedback-vector model.** The
   design says "say so loudly", which is the right instinct but not a plan. Under
   speed-first priority the largest term in the budget cannot have "restart the
   diagnosis" as its only contingency — see §7 for the mitigation.

6. **Not a defect, recorded so it is not re-litigated:** the per-sequence
   `values` array and the `{start, end}` span object passed to fused reducers
   (`assemble.ts:1499`, `:1534`) look like unpredicted per-match allocations.
   They are not a regression — archived `codegen.ts:emitSeq` allocated the same
   array (skipping it only under `valueUnused`) and the same span object at
   `:2996`, `:3949`, `:4677`. Table and codegen are at parity here. No unit
   needed.

---

## 7. Recommended ordering

Ordered by *evidence gained per unit of budget*, with the owner's speed-first
priority applied.

**D0 — run §9.1's trace. Before anything, including U1. Hours, no timing.**
`--trace-turbo-inlining` / `--trace-ic` on `json/document`, looking at (a)
whether `k0(...)` inside the arity-2 piece reports megamorphic, and (b) whether
`String.prototype.startsWith` is reduced at the `OP_LIT` site. **One run bounds
both U1 and U4** — the two largest terms in the plan — and U4 is 50–75% of the
budget resting on an unverified V8 model. The design correctly identifies this as
"the highest-value single check in this document" and then schedules it before
U4 rather than before the plan. Move it to the front.

**D1 — already discharged by this review.** `fastTriviaScanner` is null for css
and less, non-null for json and graphql; and `_triviaLog` is set on css/less so
the scanner is unreachable either way. §9.3's check is done. **U3's stated
css/less justification is retired before a line is written** — which is exactly
what a zero-cost falsification is for.

**D2 — the cheapest discriminator not in the plan: count allocations, don't time
them.** `node --trace-gc` (or `bench/alloc-count.ts`'s scavenge counter) over one
parse of `css/stylesheet` at HEAD and at `a5dc9bd`, materialised by
`bench/ab-harness.ts:214-256`. Counting scavenges is **not timing**, it is
deterministic to the allocation, and it settles §9.2 — the design's own softest
number — directly. It would also have caught the "two allocations" error (the
real figure is ≥5 plus a full `ParseContext`). Run it before committing to U2's
css/less magnitude.

**U0′** — the checker, with `trivia` removed from `CONFIG_FIELDS`,
`FunctionDeclaration` admitted to `isPiece`, and INV-7 scoped to dynamic
`Piece[]` indexing (5 sites). Expect **11** findings, not 7.

**U1′** — literal bodies. Drop the `_probe` claim; keep `_probe` → `RunCfg`
anyway because it is nearly free and it makes `OP_GATE:803` fixable. Add
`OP_GATE`'s `_tolerant` (already a `RunCfg` field — a bug fix, not a feature) and
the leaf-only capture elision. Revised **10–30%**, kill threshold restated at
<5%.

**Then branch on D0.** If D0 confirms megamorphism, **U4 moves up**: it is
50–75% of the budget, priority 1 is speed, and U1′/U2′ reduce the emitter's
surface but are not prerequisites for measuring it. Land U4 on a hot-site
emission threshold, and name the bytes at **json 4–8 KB / css 40–110 KB** in the
PR that asks for the ratchet re-cut. If D0 refutes it, U3b and U2′ absorb the
budget and the residual diagnosis restarts from a profile — decide that now, not
after.

**U2′ / U3a merged** — the capturing trivia lowering. The only work in the plan
that touches +500–835%. Four shapes, not nine.

**U3b** — `ScanShape` terminal bodies for `OP_RX`. json 6,005 executions,
graphql 8,232. Revised **10–25%** on json — the *opposite* of the stated
prediction, and the correction that matters most, because measuring U3 as
specified would produce a zero on css/less and be misread as falsifying §0.6's
split model when the split model is right.

**On U1 as first substantive unit.** Its discrimination argument survives, with a
caveat the design should record. The cross-workload arithmetic is genuinely
informative: json runs 331 LIT/KB and 769 rows/KB; graphql runs 243 LIT/KB and
1,079 rows/KB — the two ratios point in *opposite* directions, yet both workloads
land in the same +107…+138% band. A two-term linear fit puts **65–85% of the
excess on the per-leaf-execution term** rather than on total rows. But that term
contains *both* the leaf body (U1) *and* the megamorphic call into it (U4), so it
cannot split them — which is precisely the split U1 exists to make, and confirms
U1 is a real discriminator rather than a redundant one. It is a **one-sided**
discriminator, though: a positive result confirms leaf work; a null result leaves
U4's dispatch model and the per-term protocol model entangled. D0 splits them for
free and should run first regardless.

---

## 8. Summary table

| unit | claimed | mechanism verdict | revised | confidence |
|---|---|---|---|---|
| U0 | 0%; 6 `_probe`, 1 `trivia`, 9 arrays | **spec self-contradictory** — `trivia` is runtime by §2.1; `isPiece` misdiagnosed (declarations, not arity) | 0%; **11** findings, INV-7 **5** | high |
| U1 | 20–30% json (20 literals + 5 `_probe`) | literal half sound; `_probe` half on the **failure path** | **10–30%**, all literals; `_probe` ≈ 0.05% | med-high |
| U2 | json 10–20%; css/less 200–400 pts | json right, **reason wrong** (`markCst`'s 8 loads, not the `trivia` branch); css/less mechanism **blocked on U3** | json **12–21%**; css/less **40–150 pts** standalone | med |
| U3 | css/less 150–300 pts; **json ≈ 0** | **inverted both ways** — unreachable on css/less (`_triviaLog` set); json runs 6,005 `OP_RX` | css/less **0**; json **10–25%** | high |
| U4 | 40–60% json; 2.2–3 KB / 16–24 KB | mechanism sound but unverified; size prices the wrong artifact | **50–75%**; **4–8 KB / 40–110 KB** | med (perf), high (size) |
| U5 | single digits each | not examined in depth; leaf-only capture elision should be promoted into U1 | — | — |

---

## 9. Credit where due

Three things in the design are better than the brief asked for and should not be
lost in the corrections above.

- **§0.3 is right, and it is the load-bearing insight in the document.** Feedback
  is per-FunctionLiteral. No rearrangement inside `assemble.ts` produces a
  monomorphic call site. Everything downstream follows from it correctly.
- **§0.2 refuses a convenient number.** The 4–9% would have made this work look
  small and optional; the design shows both legs are the table and deletes it.
- **§9 lists the weak points instead of hiding them.** Every finding in this
  review that lands on §9.1, §9.2, §9.3, §9.4, §9.6 or §9.8 lands on a target the
  author put there on purpose. §9.3 in particular said "one line to check, check
  it before U3 is costed" — I checked it, and it saved the largest unit in the
  plan from being built against a defect it cannot reach.
