# DESIGN — the piece library: generate ahead of time, link at run start, parse with no option reads

Branch `design/balance`, on `origin/release/0.47.0` = `6bc265f5b854b256a2e8ea0df5522ca7cfd57770`,
the base all lanes are standardised on. (This lane opened at `c8eb725`, two commits behind; the two
byte measurements in §5 were re-run at `6bc265f` and are **byte-identical** at both, and the line
numbers cited for `assemble.ts` — `:282` `cfgKey`, `:2536` `new Function` — hold at both.)

**Supersedes `notes/DESIGN-child-kind-specialisation.md`** (`eb516a4`) and its three reviews
(`0787105` predictions, `9dab253` law, `73fe585` coverage). That design's central inference —
*any shared FunctionLiteral is fatal, therefore per-site bodies, therefore generate them at
runtime* — **is measured wrong in this document, at §1.** The reviews upheld the FeedbackCell
mechanism but nobody tested the conclusion drawn from it. It does not follow.

Everything numbered `M-n` below is a measurement I ran in this lane, with the command. Everything
numbered `H-n` is a **hypothesis** — not measured, stated with its falsifier, and named for a lane.
Nothing else in this document is load-bearing.

**Scope: this is 0.48 work. 0.47 ships without it.** The 0.47 bar is basic competence under the
table closure architecture — features work, no huge outliers, jess's grammars compile correctly,
perf acceptable to the owner. Not beating 0.46, and not a settled architecture. So nothing here is
sized to be safe enough to land this week; it is sized to be *right*, on whatever timescale the
measurement takes. Where a number is not yet measured this document says so and hands it to a lane
rather than guessing forward.

Two general questions were re-scoped into this document so their lanes could land small for 0.47 —
**how site labelling should work** (from `lane/capoff`) and **how options bind to pieces** (from
`lane/no-new-function`). Both are answered in §7, which shows they are one question.

---

## 0. The three rules, and what each one turns into

| rule | mechanism in this design |
|---|---|
| **1. If you are building a function, codegen it ahead of time.** | `emitAssemblySource` already generates every body. It runs at the wrong time. Move the call into the macro; ship the text as a module. §6. |
| **2. Runtime may work at start; never `Function`.** | `link` = calling the shipped module's factory with its runtime bindings. `assemble.ts:2536` deletes. §6.3 makes it a test that is red on today's HEAD. |
| **3. While parsing, no rule consults options.** | Options are bound into the *selection of which body* the macro emitted and which the linker picked. The binding-time law is §7.1; `grammar.ts:103` resolves at §7.4. |

Two endpoints are disqualified and this document does not revisit them: the fully abstract
closure table (2.0–2.3× slower, remeasured by `lane/emitprofile` at `c274a04`) and fully inline
codegen (`example/css` 224,100 B).

> **On the 2.0–2.3×**, since it is quoted often and loosely: the attribution above is the one this
> document uses and it is intact. But it is an attribution to `lane/emitprofile` at `c274a04`, and
> **not** to `exp/cliff` or `exp/wiring`, which are the two artifacts it now tends to get quoted
> against. Those two measured the *mechanisms* (§1), not this ratio. The ratio is neither confirmed
> nor refuted by them, and H-6 is the hypothesis that would connect the two.

### 0.1 — There are TWO engines, not three, and the axis is per-construct

An earlier framing of this work — including my own first draft — treated *emitted source* and
*linked closures* as two candidate architectures to choose between. **They are not.** Traced at
`6bc265f`: `emit-assembly.ts` has exactly **one** importer in all of `src/` (`assemble.ts:101`) and
the sole consumer of its output is `new Function(...EMITTED_PARAMS, em.source)` at
`assemble.ts:2536`. It is not a peer engine; it is a source-emission stage bolted inside the
compiled engine, and `lane/no-new-function` is removing it.

So: **interpreter and compiled. Two.** The real axis is not "which engine" but, per construct:

> **shared driver ↔ specialised**, with the specialised form produced at macro/build time into
> shipped source.

In the owner's words: *a set of pre-written building blocks, reused everywhere they work, with
custom versions only in the few spots where reuse actually costs speed.* §2 is the procedure for
deciding "the few spots"; §3 is the block set; §4 is where reuse wins outright.

This changes how §5's byte numbers must be read. `emitAssemblySource`'s output is **not a rival
engine's artifact** — it is the best available *measurement of what the specialised form costs in
bytes*, taken from the very stage that is being deleted. It is a ruler, not a destination.

---

## 1. The measurement everything else is downstream of

The previous design's §0.3 reasoned: V8 attaches inline-cache feedback per **FunctionLiteral**;
minting a second closure from one `CreateClosure` site moves the `FeedbackCell` to
`kManyClosures` and the vector is shared; therefore every piece call in `assemble.ts` is
megamorphic; therefore we need one FunctionLiteral per grammar site; therefore we must emit
source; therefore — because per-site source is huge — emit it at runtime.

The first clause is true. **The third does not follow from it, and it is false.**

**Every probe is committed at `notes/probes/piece-library/`, with a README mapping each `M-n` to the
command that produces it and stating that probe's limits.** They are marked illustrative in their
headers, and are shape/trace observations and byte counts only — no timing, per the serialisation
rule. Node **v24.11.1**.

### M-1 — closure count is irrelevant. 64 closures from ONE FunctionLiteral still inline.

`probe/cliff.mjs`: one `seq2` FunctionLiteral minting `N` closures, each binding two children
that are themselves closures of one shared `leaf` FunctionLiteral. Both sides are firmly
`kManyClosures`.

```
node --trace-turbo-inlining probe/cliff.mjs <N>     # grep "Inlining ... leaf ... into ... seq2"
N=1 2 3 4 5 6 8 12 20 64  ->  leaf inlined into seq2 at EVERY N (2 call sites, both inlined)
```

A shared feedback vector did not prevent inlining at any N up to 64. The superseded design's
premise, taken to its conclusion, predicts failure here. It does not happen.

### M-2 — the cliff is at **two distinct callee FunctionLiterals**, and it is sharp.

`probe/kinds2.mjs`: one shared `seq2` FunctionLiteral. Slot `k1` always binds `tail` (one
literal). Slot `k0` binds one of `M` distinct FunctionLiterals with **identical bodies**, so the
only variable is SharedFunctionInfo identity. Both slots live in the same shared feedback vector,
so this is a controlled within-run comparison.

```
M=2  k0 slot inlined:[]   k1 slot inlined=1
M=3  k0 slot inlined:[]   k1 slot inlined=1
M=4  k0 slot inlined:[]   k1 slot inlined=1
M=5  k0 slot inlined:[]   k1 slot inlined=1
M=6  k0 slot inlined:[]   k1 slot inlined=1
M=8  k0 slot inlined:[]   k1 slot inlined=1
```

At every `M ≥ 2` the monomorphic slot inlines and the polymorphic slot does not. There is **no
polymorphic call-inlining tier** — the mono→mega transition happens at the second literal.
This is consistent with V8's call feedback holding a single weak target rather than a
≤4-entry map list; the load/store IC's `kMaxPolymorphicMapCount = 4` does not apply to calls.
**"V8 tolerates a few shapes at a call site" is true of property access and false of calls.**
That is a correction to the brief, and it is the good news, not the bad news — see M-3.

### M-3 — the wiring does not matter. At all.

`probe/wiring.mjs`, four link strategies, callee held at one FunctionLiteral, 1/8/64 sites:

| wiring | 1 site | 8 sites | 64 sites |
|---|---|---|---|
| A closure-captured binding `k0(input,p)` | inlined | inlined | inlined |
| B constant array index `kids[0](input,p)` | inlined | inlined | inlined |
| C object property `self.k0(input,p)` | — | inlined | inlined |
| D generic loop, variable index `kids[i](input,cur)` | — | inlined | inlined |

`probe/matrix.mjs` isolates it as a 2×2 (`probe/sweep-matrix.sh`):

```
wiring=A(closure-captured) kinds=1 -> inlined     wiring=D(generic kids[i] loop) kinds=1 -> inlined
wiring=A                   kinds=2 -> NOT         wiring=D                       kinds=2 -> NOT
wiring=A                   kinds=4 -> NOT         wiring=D                       kinds=4 -> NOT
wiring=A                   kinds=8 -> NOT         wiring=D                       kinds=8 -> NOT
```

**This refutes a specific inherited conclusion.** `REVIEW-child-kind-law.md`'s Test C found
that `assemble.ts`'s shape — pieces reached through `kids[i]` — did not inline, and attributed it
to the array indexing. It is not the indexing. Test C reached **24 different pieces** through that
index; the confound was kind count. `kids[i]` with a uniform callee inlines exactly as well as a
closure-captured binding. Any design premised on "remove the array indexing" is optimising a
non-variable.

### M-4 — specialising the parent by child kind recovers inlining completely. A shared wrapper recovers half.

`probe/specialise.mjs` — the direct test of the proposed library, four shapes, 8 child kinds,
16 sites (`probe/sweep-spec.sh`):

| mode | what it is | measured |
|---|---|---|
| `shared` | one `seq2` literal for all 8 kinds | only `tail` (the monomorphic slot) inlines. `leafA..H` never. |
| `specialised` | **8 parent literals, one per child kind** | **`leafA→seqS0`, `leafB→seqS1`, `leafC→seqS2`, `leafD→seqS3`, `leafE→seqS4` … every pair inlines.** Full recovery. |
| `wrapper` | one parent literal + ONE shared wrapper literal in front of every child | `pieceWrapper→seqShared` inlines (the slot is monomorphic again) but `leaf→pieceWrapper` **does not** (0 events). The megamorphism moved inward one frame. |
| `pasted` | child body inlined textually; no call | no child slot exists. Control. |

> **SUPERSEDED by `exp/cliff` (275 records, `notes/results/inlining-cliff.jsonl`), which ran this
> on real-scale bodies with a 3.7% A/A floor. Keep the `shared`/`specialised` rows; the `wrapper`
> row's design reading was wrong and my D7 fell with it (§2).**
>
> - **`shared` vs `specialised` confirmed**, and the closure-count half confirmed at real scale:
>   40 closures from one `CreateClosure` site, one FeedbackVector verified by address equality in
>   `%DebugPrint`, **3 considered / 3 inlined at N=1 and at N=40**. Inlining never stops with N.
>   The clinching control is 40 sites built / 1 exercised: monomorphic *and* fast, so
>   `kManyClosures` is not itself a cost. It is the **executed** callee count.
> - **The step is at N=2 and is a single step** — N=2 and N=40 cost the same. Calls do have a
>   polymorphic state, but it behaves as a binary one-callee/many-callee distinction, not a 4-wide
>   tier. Cost: choice **+37.6%**, many **+37.8%**, seq **nil** (+3.1%, inside the floor) — seq's
>   callee arrives via `parsers[i]`, an array element that was never a constant, so it had nothing
>   to lose. My probe read the sign correctly and could not have seen the magnitudes.
> - **A third axis I did not have: receiver maps.** A fifth distinct hidden class takes the
>   `.parse` **LoadProperty** slot poly→megamorphic at N=5 (+17.6% seq / +24.7% choice / +25.1%
>   many). This is the real `kMaxPolymorphicMapCount = 4`, on property access, and it never fires
>   when callees share a map at any N. Separate axis from calls; both are live.
> - **My `wrapper` reading is refuted.** `exp/cliff` predicted a capture-wired wrapper would win by
>   constant-folding and **falsified its own prediction**: `wrapCAP` and `wrapIND` agree everywhere.
>   On `seq` and `choice` the wrapper is **pure loss** (+1.3 to +3.6 ns/op, ~149 B/site, inner body
>   still megamorphic). `exp/wiring` refutes it from a second direction — it has **no denominator**:
>   27 of 28 json bodies and 296 of 349 less bodies are already distinct, so there is nothing to
>   dedup and it is ~pure byte cost (+5.8%) with no inlining change either way.
> - **The one exception, and it is mine to explain:** on `many` the wrapper recovers the entire
>   megamorphic penalty — **91.09 → 65.61**, below even the `identical`-map baseline of 70.17 — at
>   725–5,830 bytes. See H-5 in §2 D7.

### M-5 — the size axis nobody has named: V8's inlining budget is a hard number.

`node --v8-options`, shipped Node v24.11.1:

```
--max-inlined-bytecode-size            460     (a single inlining)
--max-inlined-bytecode-size-cumulative 920     (per optimisation unit)
--max-inlined-bytecode-size-absolute  4600
--max-inlined-bytecode-size-small       27     (always-inline tier)
--max-optimized-bytecode-size        61440     (above this, TurboFan declines entirely)
```

`probe/budget.mjs` confirms the shape: a perfectly monomorphic callee inlines at bytecode sizes
29, 116 and 390. **This is the axis that explains both disqualified endpoints and it appears in
neither previous design.** A piece can be perfectly monomorphic and still not inline because it is
too big.

> **`exp/cliff` and `exp/wiring` have now measured this axis properly. One half of what I wrote is
> confirmed sharply; the other half was my invention and is dead.**
>
> - **The 460 B edge is real and bracketed to 27 bytes: 448 B inlines, 475 B does not**, identically
>   for all three piece kinds, with `consideredForInlining` dropping **3 → 1** past it — so past 460
>   the callee is not even a candidate. Cost of crossing: seq **+23.3%**, choice **+52.8%**, many
>   **+34.9%**. `exp/wiring` proves the same thing causally from the other side: every
>   `Cannot consider (reason: 5)` is exactly the over-460 set (refused 801/801/801/746/647/647), and
>   raising `--max-inlined-bytecode-size` to 900 produces **zero** refusals with every
>   previously-refused piece inlining.
> - **There is NO 460–4,600 dead zone. I invented it and it does not exist.** From 475 B to
>   **52,188 B** the curve is one flat plateau, across a range crossing 920 and 4,600 several times
>   over. My error has an exact root cause worth recording: **920 and 4,600 are caller-side budgets
>   — cumulative and absolute inlining across one compilation — not callee sizes.** I read three
>   numbers off a flag list and treated them as three thresholds on the same quantity. §9.3 flagged
>   this as inferred-not-measured, which was right, but flagging it did not stop me building D6 on
>   it.

### M-5b — the consequence that reshapes the design: the real population is entirely past the edge

Real emitted `_pf` bodies are **17.4 KB (css)** and **31.7 KB (less)**. Both sit far past 460 B,
i.e. **entirely inside the not-inlined plateau.** And it is not only the outliers: `exp/wiring`
measures **16.6–28.4% of all real pieces already over the 460 ceiling** — json 6/28, graphql 21/74,
css 20/103, less 53/319 — **and they are the composites.**

Three things follow, and together they are the largest correction in this document.

1. **At current body sizes, specialising to recover inlining recovers nothing, because there is no
   inlining to recover.** D2/D5 were built to make a child slot monomorphic so the callee would
   inline. If the callee is 17 KB, it will not inline whether the slot is monomorphic or not.
2. **Body size is the primary lever**, ahead of both IC axes. And it points somewhere neither
   design considered: *getting bodies under 460 B*, rather than choosing between shared and
   specialised at their current size.
3. **The tradeoff the whole design was framed around inverts.** I framed reuse and speed as opposed
   — share to save bytes, specialise to go fast. On the size axis they are *aligned*: reuse that
   shrinks a body buys inlining. `exp/wiring` demonstrated exactly this rather than arguing it —
   sharing the piece-free CST snapshot prologue gave **−25.2% bytes on json, identical parse, and
   MORE inlining than baseline (22 vs 19)**, because shrinking composite bodies moved some back
   under 460. That is the balance point, measured: **the best byte result and the best inlining
   result were the same change.**

> **H-1 is superseded.** I proposed the reducer gap was a *cumulative-budget* effect — which rested
> on the 920 number I had misread, so the mechanism as stated cannot be right. `exp/cliff` prices
> the candidates: one extra monomorphic call layer is 1.02–1.33×; one callee → two executed callees
> is 1.03–1.38×; crossing 460 B is 1.23–1.53×. **Worse IC feedback is sufficient on its own; extra
> calls are not required.** Its prior is the size threshold, and the reasoning is better than mine
> was: the observed ratio is **stable across reducers**, and a body-size cliff produces exactly that
> flat, complexity-independent ratio where a call-count difference would vary with reducer
> complexity. The deterministic test it names — read each reducer's `BytecodeArray` length under
> both engines, off a **cold twin**, because a tiered-up function prints no bytecode line — is the
> one to run.

> **Two retractions, both measured by `lane/capoff`, recorded here because this document cited the
> withdrawn figures.**
>
> - **`46.3` vs `26.8` MB/parse is retracted.** The figures with stated provenance are
>   **34.68 MB/parse (css)** and **64.48 MB/parse (less)** at `6bc265f` — css `benchmark.css`
>   (123,029 B), 100 parses after 5 warmups, all `ok=100` with full `consumed`, via `--trace-gc`
>   byte deltas. 46.3 could not be reconciled without the other lane's harness, and **`26.8` has no
>   counterpart in any committed artifact at all** — it is not a contested number, it is an
>   unsourced one. Nothing in this document's byte argument rests on either — §5 is entirely
>   artifact bytes, not heap bytes — but neither figure may be re-cited.
> - **The `09f3452` inflation caveat I added in an earlier revision is retracted entirely.** Same
>   protocol at both commits: `90e115c9` 34.78 → `6bc265f` 34.68 MB/parse, a **0.3%** difference. It
>   inflated nothing. That caveat was speculation and it was wrong; the profile's shares stand on
>   their own.

What survives independently of any of this is presence/absence: 0.46 has zero self-time in those
four files while producing byte-identical output including `rootTrivia`.

**jess's author reducers are identical source on both sides and run 1.30–1.32× slower under the
emitted engine.** A reducer called from a small `_pf` that is itself inlined into its parent is
inside a unit with budget left; a reducer called from a 17 KB `_pf` root competes for the same 920
cumulative bytes against everything else in that body. Same source, different inlining outcome.

> **H-1 (for `exp/cliff`).** The reducer slowdown is a cumulative-inline-budget effect, not an IC
> effect. **Falsified if** `--trace-turbo-inlining` shows the reducer inlined into its `_pf` on both
> engines, or if it is un-inlined on both. **Confirmed if** it inlines under 0.46's `_r_<Name>` and
> is declined into the emitted `_pf` with a budget message. One trace run; no timing.

### The law, as measured

> **A call site inlines iff the callee's bytecode is under ~460 bytes AND exactly one
> FunctionLiteral is *executed* there AND the receiver carries no more than four distinct hidden
> classes. Closure count does not matter. Wiring does not matter. Bound data does not matter.**

Three conditions, in that order — size first, because §M-5b shows the real population fails it
before either IC condition is even reached. The two IC axes are independent: the call axis is
binary (mono vs many, stepping at the **second executed callee**) and the map axis is the classic
4-wide one (stepping at the **fifth receiver map**).

Both halves are necessary and neither previous design had both.

---

## 2. The decision procedure

Someone holding a new opcode, or a new site, applies this and gets an answer.

**This procedure has been reordered by `exp/cliff` and `exp/wiring`.** The original put the IC
axes first and the size check last, as D6. That was wrong: §M-5b shows 16.6–28.4% of real pieces —
and every composite — already fail the size condition, so for them the IC questions never arise.
**Size is now D0 and it gates everything after it.**

**Default: share.** A site uses the generic library piece for its `(opcode, arity)` unless a rule
below fires. Reuse is free on the IC axes — M-1 proves an unbounded number of sites may share one
FunctionLiteral with no penalty, and M-3 proves the linking mechanism is irrelevant — and on the
size axis reuse is *actively good*, because a shared piece is a small piece (§M-5b.3).

Then, in order:

**D0 — Is the body under ~448 bytes of bytecode?**
Measured edge: 448 inlines, 475 does not, and past it the callee is not even considered. This is
the first question because it is the only one whose answer the others depend on.

- **Under 448 → the body is inlinable into its parent.** Proceed to D1; the IC axes now matter,
  because there is inlining to win or lose.
- **Over 460 → the body is a root, and everything from 475 B to 52,188 B is one flat plateau.**
  The IC axes still cost *within* the body, but no amount of specialisation will make it inline.
  For a root, the only two useful moves are (a) **split it back under 448**, which is the
  high-value move and the one `exp/wiring` demonstrated, or (b) accept root status and paste
  freely, since past the edge additional size is free at runtime and costs only shipped bytes.

**The failure mode to look for is a root that has not earned it** — a body over 460 that still
makes megamorphic calls out to other pieces. It pays the plateau's non-inlining *and* collects
none of the fusion that would justify being large. The 17.4 KB `_pf` bodies are exactly this
shape, and it is the sharpest available account of why the current engine is 2.0–2.6× slower.
**Unproven:** that this is the dominant term rather than one of several. See H-6.

**D0 supersedes the old D6.** There is no dead zone to avoid (§M-5); there is one edge, and the
question is which side of it you are on and whether you have earned the far side.

> **H-6 — the unearned root is the dominant term in the 2.0–2.6× gap.** Mechanism: the composite
> `_pf` bodies sit past 460 B so nothing inlines into or out of them, while still dispatching to
> other pieces through slots that are polymorphic on callee and megamorphic on receiver map — the
> plateau's cost with none of the plateau's compensation. **Falsified if** splitting the over-460
> composites back under 448 (the `exp/wiring` prologue-sharing move, applied to the composites
> rather than the prologues) fails to move the ratio materially — which would mean the gap is
> mostly elsewhere and body size is a real but secondary term. This is the cheapest available test
> of the whole reordered procedure, because `exp/wiring` has already built the splitter; note its
> splitter currently **throws** on `example/css`, and that throw is a prerequisite, not an obstacle.

**D1 — Does anything vary between sites other than *bound data*?**
If the only difference is a literal's characters, a char code, a regex, an expected-set index, a
reducer, a slot number — **share.** A closed-over primitive or object reference does not enter any
call site's feedback. This is the single largest source of reuse and it costs nothing.

**D2 — Does the site's child slot see more than one callee FunctionLiteral?**
Count the distinct piece kinds bound to that slot across all sites sharing the piece. **One → share,
and the callee inlines (M-2, M-4).** More than one → the slot is megamorphic and the site is a
candidate for specialisation. *Note the counting unit: kinds, not sites. `OP_SCOPE` covering 1,331
sites is one kind and costs nothing.*

**D3 — If D2 fired, is the site hot?**
Megamorphism only costs where it executes. Rank sites by executed rows, not by static count.
`bench/table-opcode-gaps.ts` with `PM_TABLE_COUNT=1` gives an executed row census with no timing;
for json, 43% of executions land on 11 `OP_LIT` rows. **Cold → leave it shared and megamorphic.**
Hot → continue.

**D4 — Can the child be pasted instead of specialised?**
Pasting is strictly better than specialising: it removes the slot rather than making it
monomorphic, and it does not multiply the parent. Paste iff the child is **self-contained** —
needs no call into another piece, allocates nothing, and exposes no backtrack point to its parent
(it either consumes a span or reports `end === start`).

> Adopted verbatim from `REVIEW-child-kind-coverage.md` §1, which refuted the superseded design's
> "branch-free straight-line" rule by showing **zero of the nine `ScanShape` variants are
> branch-free** — applied literally the old rule rejects every shape and the unit collapses to
> nothing. Internal branching and looping are expected and irrelevant; the `end === start`
> invariant is what makes a paste safe. Builtin calls (`indexOf`, measured 4.3× on
> `until`/`delimited`) must not be excluded.

**D4b — Does pasting push the body over 448 B?** Pasting is how a small piece becomes a root, and
`exp/wiring` measures the composites as already the over-460 class. So D4 is bounded by D0: paste
while the result stays under 448, and stop. **The budget is 448 bytes of bytecode, not a node
count** — which is the correction to codegen's `INLINE_MAX_NODES = 1000` policy, the policy that
produced the 17.4 KB bodies. If a paste would cross the edge, either don't, or commit to root
status and paste until the remaining calls out are cold.

**D5 — Otherwise specialise the parent by that slot's child kind.** One new FunctionLiteral per
distinct kind at that slot (M-4 `specialised`).

> **D5 is the weakest step in this procedure and may be net-negative on real grammars.**
> `exp/wiring` measures 16.6–28.4% of real pieces already over 460 — json 6/28, graphql 21/74, css
> 20/103, less 53/319 — **and they are the composites**, which is exactly the class D5 specialises.
> Specialising a parent per child kind grows the parent. So D5 spends size budget on the pieces
> already at the limit: it recovers the *child's* inlining and can lose the *parent's*. Apply D5
> only after D0 says the parent has room, and prefer D4/splitting over D5 wherever both apply.

**D6 — REMOVED.** It asserted a 460–4,600 dead zone that does not exist (§M-5). Its live content
is now D0.

**D7 — REMOVED. The wrapper is refuted from two independent directions.** `exp/cliff`: pure loss
on `seq` and `choice` (+1.3 to +3.6 ns/op, inner body still megamorphic), and `wrapCAP` ≈ `wrapIND`
kills the constant-folding rationale. `exp/wiring`: it has **no denominator** — 27 of 28 json
bodies and 296 of 349 less bodies are already distinct, so there is nothing to dedup and it is
~pure byte cost (+5.8%) with no inlining change. I proposed it as "the cheap 80%-solution for the
long tail"; it is neither cheap nor a solution.

> **H-5 — the one place the wrapper earns its bytes, and the mechanism is mine to explain.**
> On `many` the wrapper recovers everything: **91.09 → 65.61**, *below* the `identical`-map baseline
> of 70.17. `many` is the only piece whose dispatch sits inside a hot inner loop. Two candidate
> mechanisms, and I can name an experiment that separates them:
>
> - **(i) Loop-invariant hoisting.** The per-site wrapper has a per-site feedback vector, so the
>   `.parse` load inside it is monomorphic; the wrapper (145 B, under 448) inlines into `many`'s
>   loop body, and the now-monomorphic loop-invariant load hoists out of the loop. Recovery is then
>   proportional to iteration count.
> - **(ii) Load elimination.** The wrapper is a plain function, so calling it replaces a
>   *megamorphic LoadProperty* (`.parse` on 5 distinct maps, the +25.1% term) with a *polymorphic
>   Call*. The load is gone regardless of inlining; the loop merely multiplies the saving until it
>   exceeds the added frame, which is why `seq`/`choice` — dispatching once per call, not once per
>   iteration — stay net-negative.
>
> **The separating experiment: pad the wrapper past 460 B.** Under (i) recovery must vanish
> entirely, because an un-inlinable wrapper cannot hoist anything. Under (ii) recovery must
> largely survive, because the megamorphic load is eliminated whether or not the wrapper inlines.
> One config on an existing harness. A second, cheaper check that discriminates the same way:
> **vary `many`'s iteration count** — both mechanisms predict recovery scales with it, so a *flat*
> result falsifies both and means neither of my explanations is right.
>
> This also predicts something testable and currently unmeasured: **`seq` at high arity should
> begin to recover**, since many terms per call is the same multiplication by another name. If it
> does not, the loop is doing something neither mechanism captures.

**What never earns a piece.** An option. Options select *which generated body a site links to*;
they are not a slot-kind and they do not enter D2. Their cost is bytes (§5), which is why §5 treats
them with dedup and overgeneration rather than with the taxonomy.

---

## 3. The library: cardinalities per axis

### 3.1 The axes, with what each is worth

| axis | cardinality | earns a distinct piece? | why |
|---|---|---|---|
| **bound data** (literal text, char code, regex, expected index, reducer, slot) | unbounded | **no** | D1. M-1: closed-over data never enters call feedback. This is where nearly all the reuse is. |
| **arity** | 1, 2, 3, 4, generic | **yes** | changes the number of child slots, hence the body's call structure. Existing cutoff at 3+generic (`assemble.ts:1621–1731`); extend to 4 — `example/css` has `SEQV` at n=4 (3 sites) and n=5 (2), the vendored less grammar n=4 (4) and n=6 (3). |
| **child kind at each slot** | 2 effective per slot after D4 (**pasted** / **called**) | **yes, but only where D2+D3 fire** | M-4. The naive `K^arity` never materialises because D4 removes leaf slots entirely and D3 removes cold ones. |
| **site attributes** (trivia scope, cst-leaf shape, replay slot, routed-local) | small enums, packed into one operand | **yes** | already half-built: `src/table/site-labels.ts` computes `{tri, buf, cap}` to fixpoint. Generalise to the record `REVIEW-child-kind-coverage.md` §3 enumerates; the operand cost is the same one integer. |
| **choice strategy** | 5 (`ordered`, `disjoint-dispatch`, `greedyClassify`, `literalsLongestFirst`, `sharedPrefix`) | **yes** | a whole-choice property, not any child's kind. `OP_GREEDY` and `OP_REJECT` appear in neither previous design and are in every real language grammar. |
| **option set** (`cfgKey`, 5 bits) | 32 nominal, **1–2 realised per process** | **no — it selects among generated bodies** | §5. |
| **emissibility** (`OP_LIVE`/`OP_GUARD`/`OP_ARMGATE`/`OP_WITHCTX`/`OP_COV`) | per-row | **no — a degradation policy** | §4.3. |

### 3.2 The count

Two tiers, and the split is the design.

**Tier S — the shared runtime library, in `src/`, authored once, used by every grammar.**
One piece per `(opcode, arity)`. Today's `assemble.ts` already is this: **61 `(input,pos,ctx)=>`
Piece literals inside `lower()`**, over 40 opcodes, with arity specialisation on `SEQ/SEQV/SEQX`
(1/2/3/general × fused/wantValues/neither = 18) and length specialisation on `LIT`/`LIT_TRACK`
(4 each). Plus 4 `TermRunner` literals. Add arity 4 (+3 for SEQ family): **≈64 authored pieces.**
(Was ≈65 including D7's `pieceWrapper`; D7 is removed, so that piece is not authored.)

Tier S is not deleted and is not a fallback of last resort. It is the correct answer for every
site that fails D3, which by execution share is most of them — **and, after §M-5b, it has a second
justification stronger than the first: Tier S pieces are small, so they are on the inlinable side
of D0. Tier G's per-site bodies are the ones at risk of becoming unearned roots.** The tier split
was originally justified on IC grounds and survives on size grounds, which is a better argument
than the one I built it with.

**Tier G — generated per-site bodies, emitted at macro time.**
One `_pf<ip>` per site that passes D3. Measured today, when the emitter runs for every site:
**`example/css` 163 bodies / `example/json` 37 bodies** (`probe/bodyshare.mjs`). Against 154 and 28
reachable opcode sites respectively — the surplus is the `_sk<N>` per-site-label skip functions and
the `_r_<Rule>` aliases.

> **H-2 (for `exp/mixture`).** A D3 threshold covering ~90% of executed rows emits **40–60%** of
> sites, not 100%. Basis: json's 43%-on-11-rows census. **Falsified if** the execution histogram
> on jess's grammars is flat enough that 90% coverage needs >80% of sites — in which case Tier G is
> effectively "all sites" and §5's byte estimate goes to its top end. This is the single number
> that most moves the byte answer and `exp/mixture`'s Pareto curve measures it directly.

---

## 4. Where genericity is correct

Naming these is as valuable as naming the specialised ones, and three of them are places a
reviewer will expect specialisation.

**4.1 — Every site that fails D3.** By construction. A megamorphic call at a site that executes
twice per parse costs nothing measurable, and specialising it costs a FunctionLiteral, its bytes,
and a maintenance obligation forever. `OP_SCOPE`'s 1,331 sites are one kind (D2 passes) and mostly
cold; they stay generic and stay fast.

**4.2 — Arity ≥ 5.** `example/css`'s widest `SEQV` is 5 and the vendored less grammar's is 6, both
at ≤3 sites. The generic loop (`assemble.ts:1714–1731`) is correct there, and M-3 shows the loop's
`kids[i]` call inlines fine when the kind is uniform. **Do not extend past 4.**

**4.3 — Live rows: `OP_LIVE`, `OP_GUARD`, `OP_ARMGATE`, `OP_WITHCTX`, `OP_COV`.**
`emit-assembly.ts:1603` refuses 8 opcodes by name; `cfg.coverage` refuses the whole assembly at
`:399`. Codegen degraded the same way (`emitRuntimeFallback`). Under the two-tier split this stops
being a degradation at all: **a live row links to its Tier S piece and the generated module takes
the live combinators as factory parameters rather than printing them.** Cost: parameters on an
already-44-parameter factory. This is `REVIEW-child-kind-coverage.md` §4.2's fix and it is strictly
better than codegen's whole-artifact disable — it removes the class of grammar for which no
artifact exists.

**4.4 — `ScanShape` recognition, as a closed set with a named fallback.**
`ScanShape` is recursive (`alt.arms: ScanShape[]`, `lookahead.inner`, `seq.parts[].group.inner`),
so the number of distinct shape *trees* is a property of each grammar's regexes and is unbounded.
A Tier S piece cannot hold the constant-folded `classCond` chains — it must close over a `ranges`
array and loop it, which is `inRanges` (`src/combinators/trivia-skip.ts:391–397`), i.e. exactly what
is there today.

This design sits on the **generated** side of that line, and can, because generation happens at
macro time where the grammar's regexes are known. Tier G emits constant-folded chains per site.
Tier S ships a `ranges`-loop fallback for sites that fail D3, and **that fallback is named and its
cost owned rather than hidden**. `emitShapeMatch` is a fragment emitter with a calling convention
over minted variable names (`{setup, ok, end}`, a caller-supplied `firstChar`), not a body set —
wrapping each shape in a function to tidy it silently loses the shared `firstChar` load and loses
the paste, which is the entire unit.

**4.5 — `OP_ADJ` must not be a pasted leaf.** The superseded design put it in the paste row as
"zero-width, already trivial." `ops.ts:226–251` says it is a boundary test evaluated at the
sequence cursor **before** the ambient trivia scan; a piece handed the post-scan position answers
"adjacent" every time, **silently**. It belongs as a third value in the site-attribute trivia enum
(`no-trivia` / `scan-trivia` / `adjacent-checked`), not as a child kind. Failure mode is wrong
output, not a slow parse.

---

## 5. Bytes

### 5.1 What the gate actually measures — a correction to the framing

`bench/size-guard.ts:454` sets `genBytes = Buffer.byteLength(compiled.source)` and `:465`
`bytesRatio = genBytes / srcBytes`. **The gate measures the per-grammar artifact only.** Tier S
lives in `src/`, is counted by nothing in `bench/size-baseline.json`, is amortised across every
grammar in a bundle, and is tree-shakeable. So 224,100 B and 9,229 B are both per-grammar numbers
and only Tier G is compared against them. The design's byte cost is not one number; it is
`(fixed library, once) + (generated bodies, per grammar per shipped option set)`.

### 5.2 Measured, first-hand: what the specialised form costs in bytes

Read per §0.1: `emitAssemblySource` is a stage being deleted, not an engine. Its output is used
here only because it is the one place in the tree that already renders every construct in its
fully-specialised per-site form, so it is the ruler for what §2's D4/D5 produce.

`probe/emitsize.mjs`, this worktree, Node v24.11.1:

| grammar | table data (today) | emitted source, cfgKey 0 | 0.46 codegen | emitted ÷ codegen |
|---|---:|---:|---:|---:|
| `example/json` | 1,336 B | **24,782 B** | 15,138 B | 1.64× |
| `example/css`  | 9,229 B | **155,076 B** | 224,100 B | 0.69× |

So full per-site emission is already **below** codegen on css and above it on json. Consistent
with `lane/emitprofile`'s 1.14 MB (css) / 2.12 MB (less) factories on jess's real grammars and with
the relayed ~23 MB vs 0.46's shipped **43.9 MB** across the same 16 modules. **The size endpoint is
not a wall; 0.46 already shipped twice this and it went out.**

### 5.3 Measured, first-hand: how much the option axis actually costs

`probe/bodyshare.mjs` splits each emitted artifact into named top-level bodies and hashes each
against cfgKey 0. This is per-**body** identity; whole-artifact hashes are the wrong granularity
and are why the relayed "no two option sets share a body text" reads more pessimistically than the
truth.

`example/css` — 163 bodies:

| cfg | bodies identical to k0 | differing | variant bytes |
|---|---:|---:|---:|
| k1 `hostCst` | 145 (**89.0%**) | 18 | 23,715 |
| k2 `trackLines` | 55 (33.7%) | 108 | 90,451 |
| k3 both | 55 (33.7%) | 108 | 96,553 |
| k4 `tolerant` | 25 (16.7%) | 125 | 154,908 |

`example/json` — 37 bodies:

| cfg | identical to k0 | differing | variant bytes |
|---|---:|---:|---:|
| k1 `hostCst` | 37 (**100.0%**) | 0 | 0 |
| k2 `trackLines` | 19 (51.4%) | 18 | 9,501 |
| k4 `tolerant` | 11 (29.7%) | 26 | 24,537 |

**`trackLines`: resolved, and my number stands.** I measured 66.3% (css) / 48.6% (json) against a
relayed 16–21% and flagged it as an open disagreement. `exp/wiring` is now a **third independent
measurement by a different method: 52–61%**, converging with mine and not with the relay. The
16–21% is retracted at source. H-3 is closed — not because I was believed, but because two methods
that share no code agree.

### 5.3b — PAIRWISE vs N-WAY invariance: reconciling 89% with 39–48%

`exp/wiring` reports the **option-invariant fraction at 39–48%**, against my 89%, and asked me to
re-base §5.4 on it. These are two different quantities and both are right. Measured in this lane
with `notes/probes/piece-library/invariant-fraction.mjs`:

| set of option sets | `example/css` | `example/json` |
|---|---:|---:|
| k0↔k1 **pairwise** (`hostCst` only) | **145/163 (89.0%)** | 37/37 (100.0%) |
| k0,k1,k2,k3 — 4 sets, **n-way** | 55/163 (**33.7%**) | 19/37 (**51.4%**) |
| k0..k4 — 5 sets, **n-way** | 13/163 (8.0%) | 11/37 (29.7%) |

**My own data reproduces `exp/wiring`'s 39–48% when computed its way** — the 4-set n-way row is
33.7%/51.4%, which brackets it. The 89% is the *pairwise* k0↔k1 figure, and it is the right one
**only** because the shipped set is two (CLI k0, language service k0+k1), where n-way and pairwise
coincide. So §5.4 does not need re-basing as it stands — but it is now explicitly conditional on
the shipped set staying at two, and that condition is stated below rather than assumed.

The general shape, which is the reusable lesson: **invariance collapses fast with each option set
added.** 89% → 33.7% → 8.0% on css. Any argument of the form "most bodies are option-invariant, so
overgeneration is cheap" is only true for a small shipped set and must name the set.

### 5.4 The estimate

The number that matters is not "all 32 option sets." Per the relay, **the CLI reaches cfgKey 0
only and the language service reaches two.** So the shipped set is 1–2, and dedup across it is
measured, not guessed:

- **css, one option set (CLI):** 155,076 B. `bytesRatio` = 155,076 / 9,715 ≈ **16.0**.
- **css, two option sets (k0 + k1), bodies deduped:** 155,076 + 23,715 = **178,791 B**, i.e.
  **+15.3%** to cover both. `bytesRatio` ≈ 18.4.
- With the D3 hot-only split at H-2's 40–60% of sites, Tier G lands at roughly
  **0.4–0.6× of the above** — css **62,000–107,000 B**, `bytesRatio` **6.4–11.0**.

**Range, stated as a range, with the ceiling named:** `example/css` **62,000–179,000 B**
(`bytesRatio` **6.4–18.4**) depending on H-2 and on how many option sets ship. The gate's ceiling
is 10 and `RATCHET_SLACK_PCT` is 0.1 with no headroom by design, so **the ceiling is crossed in
most of this range and `bench/size-baseline.json` needs a deliberate committed re-cut with owner
sign-off.** Saying so now is cheaper than discovering it mid-unit — the superseded design's
16–24 KB figure would have stalled exactly there.

**Conditional on the shipped set being two.** Per §5.3b, invariance collapses with each option set
added: the +15.3% for a second set becomes **+136%** for four (155,076 + 23,715 + 90,451 + 96,553 =
365,795 B deduped, against 620,304 naive — dedup still saves 41%). If the shipped set grows past
two, this estimate must be recomputed, not extrapolated.

**Independently corroborated on the overgeneration axis.** `exp/wiring` measures targeted
overgeneration — restricting it to the bodies an option actually moves — at **+30–55%** against
naive **+87–97%**, at identical zero runtime cost. My measured single-option deltas bracket that:
`hostCst` +15.3%, `trackLines` +58.3%. Two methods, same conclusion: **overgeneration is affordable
when targeted and not otherwise.**

**And the estimate has a downward lever I did not have.** §M-5b.3: `exp/wiring`'s partial-sharing
result took **−25.2% bytes on json with more inlining, not less** (22 vs 19). Every number in this
section is a *pre*-sharing figure. Sharing the piece-free prologues moves the whole range down and
the inlining count up at the same time, which is the one direction this design did not previously
believe existed.

**What narrows it:** H-2, first and by far. Then whether Tier G emits per-option-set artifacts or
one artifact carrying deduped variant bodies selected at link (the latter, per §5.3b, and what §6
assumes). Then how much of the −25.2% generalises past json.

---

## 6. Generation, and the no-`Function` requirement

### 6.1 The renderer already exists and runs at the wrong time

Not a third engine (§0.1) — a stage. The point is that the *text-rendering* half of specialisation
is already written and debugged, and only its schedule is wrong.

`emit-assembly.ts` (1,638 lines) is the piece generator. Its vocabulary is real and must be used
rather than replaced with placeholders: `_pf<ip>` per site (`:603`), `_r_<RuleName>` per rule
(`:1612`), `_sk<N>` per site label (`:512`), `_k<N>`/`_fx<N>`/`_fn<N>`/`_ts<N>`/`_sent<N>` hoisted
pool consts (`:458–476`), `_pfEnd`/`_pfScan`/`_pfHost` scope state (`:121–124`).

`assemble.ts:2536` calls `new Function(...EMITTED_PARAMS, em.source)` on that text, then
immediately calls the resulting factory with **44 arguments** (`EMITTED_PARAMS`,
`emit-assembly.ts:93–116`).

**That 44-argument call is already the link step.** Nothing about it needs to happen at runtime.
The design is three moves:

1. **Macro time:** the plugin calls `emitAssemblySource(t, prog, cfg, extraIps)` for each option
   set that ships, dedups bodies across them (§5.3: 89% shared on the css pair), and writes the
   text to a real module with a default-exported factory whose parameter list is `EMITTED_PARAMS`.
   Parsed by the engine like any other module.
2. **Run start:** `link` = `import`ing that module and calling the factory with the 44 runtime
   bindings, plus — per §4.3 — any live combinators as additional parameters. Options are paid
   here by selecting which deduped body each site binds to. This is the "runtime may do some work
   at start" the rules allow.
3. **Parse:** the returned `pieces` map. No option read; §7 lists what has to move for that to be
   literally true.

The generated text is **not self-contained** and this is the one real piece of work: it closes over
live `Combinator` objects (`SCANS`, `SENTS`), `RegExp` objects (`K`), user builder functions
(`FNS`), and three emitter-built data pools (`masks`, `classes`, `armExpected`). Moving to build
time means serialising those alongside the source — the pools are plain data; the `RegExp`s and
`Combinator`s are what `emitConst` already refuses, which is why `runtimeOnly` exists. §4.3's
"pass them as factory parameters" is the same answer for both problems.

### 6.2 Keeping it in sync with the opcode set

The emitter's `lower()` has **31 `case OP_*` labels** against `assemble.ts`'s **40**. That drift
is the sync hazard, not the piece library. Two mechanical guards, both cheap and both static:

- **A totality check.** For every `OP_*` in `ops.ts`, either `emit-assembly.ts` has a case or
  `OP_NAMES` marks it Tier-S-only. A new opcode with neither fails the build. This is the
  `OP_NAMES` table's existing job, extended by one column.
- **The differential already exists.** `scripts/check-differentials.mjs:184–191` runs
  `bench/jess/emit-identity-one.ts` with `PM_TABLE_EMIT=1` and `=0` and compares. Under this design
  that becomes Tier G vs Tier S over the same table — the strongest possible sync test, because
  every site has both implementations and they must agree byte-for-byte.

### 6.3 The no-`Function` requirement, as a test

There is **no such test today.** The three existing negative assertions
(`test/unit/compose-leaf-source-module.test.ts:28`,
`test/unit/compose-direct-builder-ir.test.ts:214`,
`test/unit/shared-shape-external-ref.test.ts:91`) all assert `expect(leaf.code).not.toContain('new
Function')` — static text checks on macro *output*, which pass while `tableRules(<data>)` evals on
first parse. There is no `.oxlintrc`/`eslint.config.*` anywhere in the repo, so
`assemble.ts:2535`'s `// eslint-disable-next-line ... no-new-func` is inert against CI.

The test must be dynamic and must observe the constructor itself, because the defect is a *call*,
not a *string*:

```ts
// ILLUSTRATIVE. Shape of the gate, not final code.
const RealFunction = globalThis.Function
let calls = 0
globalThis.Function = new Proxy(RealFunction, { construct: (t, a) => { calls++; return Reflect.construct(t, a) },
                                                apply:     (t, s, a) => { calls++; return Reflect.apply(t, s, a) } })
try {
  const rules = macroCompiledRules            // the artifact the macro produced
  expect(calls).toBe(0)                       // linking is allowed to run here
  rules.Entry.parse(fixture)                  // FIRST parse — this is where it fires today
  expect(calls).toBe(0)                       // <- RED on HEAD
} finally { globalThis.Function = RealFunction }
```

Three properties this has to keep:

- It **must run the first parse**, because that is where the current call happens
  (`tableRules(<data>)` → 0 calls; first `parse()` → 1). A gate that only links is green today and
  proves nothing.
- It must cover **each shipped option set**, since `assemble()` compiles once per `cfgKey` and a
  process that only ever reaches key 0 never exercises the others.
- It must run **under the macro**, which is the configuration the docs promise about —
  `docs/guide/modes.md:70-72` sends strict-CSP users to the macro build, and
  `docs/reference/api.md:925` promises "No `new Function`, no eval." Both are false today for a
  table-lowered grammar.

A second, weaker gate is worth having because it is free: a source scan asserting `src/table/`
contains no `Function(` construction outside a test. It cannot replace the dynamic gate — the
current call is behind `EMIT_ENABLED` and a text scan gives no signal about whether it fires — but
it catches reintroduction at review time. `lane/no-new-function` owns both.

---

## 7. Binding time — the one mechanism behind both general questions

Two questions were re-scoped into this document when `lane/capoff` and `lane/no-new-function` were
cut down to land small for 0.47: **how site labelling should work**, and **how options bind to
pieces**. They look like two problems. They are one, and the unifying idea is *when a fact becomes
known*.

### 7.1 The binding-time lattice

Every fact a piece could consult is determined at exactly one of three times. The law is: **bind at
the earliest time the fact is determined, and never later.**

| bound at | determined by | example | mechanism |
|---|---|---|---|
| **encode** | program structure alone | is this sequence term inside a trivia-bearing scope? is this leaf dynamically inside an `OP_NODE`? | **site label** (`site-labels.ts`) |
| **link** | the caller's option set, fixed for the parse | `hostCst`, `tolerant`, `trackLines`, `coverage`, `probe` | **`cfgKey`** → which generated body a site binds to |
| **parse** | genuinely varying within one parse | the position; the input | the only things allowed to be arguments |

`RunCfg`'s existing doc discipline (`assemble.ts:213–277`) is the *link* row's admission test, and it
is correct: a bit belongs there only if it is fixed for the lifetime of a parse. `site-labels.ts`'s
header states the *encode* row's, equally correctly: a label says what is true **at that site**
rather than what is true for the parse, so it is legal where a bit is not — `ctx.trivia` is
per-scope and `ctx._cstBuf` is per-node, and neither could ever be a bit.

Both mechanisms already exist and are well built. What was missing is the statement that they are
the same move at two different times, and that **there is no third mechanism and no parse-time row.**

### 7.2 Site labelling, generally: it is two-stage partial evaluation

The reason `cap` is three-valued is worth stating precisely, because it is the general shape and not
a quirk. `site-labels.ts:38–41` notes that `OP_NODE` writes `ctx.captureTrivia` the literal
`readsTrivia || hostCst`, "resolved at emit". `readsTrivia` is structural — encode knows it.
`hostCst` is an option — encode does **not** know it. So the honest label at encode is not a fact;
it is a **residual**, a small expression in the cfg bits.

That gives the general rule:

> **Stage 1, at encode:** compute what program structure determines, leaving residuals
> parameterised by cfg bits. **Stage 2, at link:** substitute the cfg bits; every residual collapses
> to a constant and selects a body. Neither stage runs at parse time.

Three-valued lattices like `CAP_UNKNOWN` are what an un-substituted residual looks like when you are
forced to store it as an enum. Under two-stage evaluation the third value is not a third fact — it
is "not yet substituted", exactly as the existing header says ("the lattice's top element, not a
third fact"). This also answers whether the labelling pass should run per-cfg: it need not, and
should not. Run it once, keep residuals, substitute at link. That is strictly cheaper than 32 passes
and strictly more honest than pretending encode knows `hostCst`.

**The soundness law, which the existing pass gets right and which any extension must keep.**
`buf === false` means *unknown*, never *guaranteed absent*, because no root can prove absence —
every entry point (`prog.rules`, plus the `extraIps` a scan pool reaches from outside the emitted
scope) is called with a context the pass cannot see. Hence:

> **A site label licenses dropping a TEST. It never licenses dropping WORK** — unless it is a
> must-analysis over a root set proven complete.

That single sentence is what rules out the unsound elision the header warns about (dropping a leaf's
capture when `hostCst === false`, when `OP_NODE` opens `_cstBuf` regardless of host mode). It is also
the reason §4.5's `OP_ADJ` and §9.7's capture-reachability are the two places this design can emit
wrong output rather than a slow parse: both are tempting *must*-analyses over a root set nobody has
proven complete. `lane/capoff`'s narrow 0.47 fix is compatible with all of this; it is the same
lattice with one residual substituted early.

### 7.3 The worked example, and the first 0.48 unit: `rawChildren` is dead work

Everything in §7.1–7.2 is abstract until it decides something. Here is the case that it decides, and
it is the unit I would land first — **it removes work rather than moving a branch**, so it is the
`(B)`-ground of §2's procedure, not the IC ground, and it is independent of every unmeasured
hypothesis in this document.

**The defect.** Every leaf is written into **two** parallel collectors. `_pushLeafBuf`
(`emit-assembly.ts:133–142`, verified verbatim in this lane) pushes each leaf into `b.ch`/`b.single`
*and* into `b.raw`/`b.rawSingle`. `emitMark(buf:true)` reads both lengths at every mark; `_rbBuf`
truncates both at every rollback. In emitted css/ast that is **206 `_pushLeafBuf`, 678 `_rbBuf`,
749 `_accSet`** sites (`lane/capoff`). The assembler carries the same pair —
`assemble.ts:455–456` reads `b.raw`/`b.rawSingle` into `MRAW` at every mark.

**Why it is dead.** `rawKids` is materialised once, at `assemble.ts:2387`, and reaches exactly two
consumers: a CST host (`:2419`, `:2424`, as the 5th positional argument) and a builder's **4th formal
parameter** (`:2426`, `build(kids, fieldMap, span, rawKids, …)`). Every node def reachable in css and
less has builder arity ≤ 3. So in AST mode with those grammars, the second collector is maintained
per leaf, per mark, per rollback, and read by nobody.

**Why it is only half of the 12.4% CST-capture attribution, and the other half is live.** Neither
this document nor the brief named the mechanism correctly. `lane/capoff` dumped emitted css/ast
source before and after forcing the cap label: **1,049,296 bytes both times, identical** — so **cap
labels cost nothing**, corroborating `exp/mixture` from a second direction. The driver is the `buf`
axis plus `OP_NODE` opening `ctx._cstBuf` unconditionally, and most of *that* is genuinely live:
`_cstBuf` collects the node's children and `build(kids, …)` consumes them in AST mode too. **Do not
try to elide `_cstBuf`.** `rawChildren` is the separable dead half.

> **A relayed figure I never used, recorded so nobody adds it later.** A "74%/84% CAP_ON" share was
> relayed to me as fact for this attribution. It has **no committed source anywhere** in the tree.
> This document never leaned on it — the paragraph above rests on capoff's byte-identical dump and
> on the `buildReadsRaw` reachability argument, both of which I verified directly — and it must not
> be introduced now that it has been repeated. What the artifacts *do* say cuts the other way and
> strengthens the sentence above: **`buf: true` is the CHEAP mark**, so eliding it would be
> *slower*, not faster. That is a second, independent reason not to touch `_cstBuf`, and it makes
> the `raw`/`buf` split load-bearing rather than incidental: the dead half and the cheap half are
> different fields and only one of them is worth an encoder bit.

**Why this is a §7 problem and not a peephole.** The question "does any reachable builder read
`rawKids`?" is determined by program structure alone — it is an **encode-row** fact by §7.1, and it
should be bound there. The oracle is already written and already tested and is **called from nowhere
in `src/`**: `buildReadsRaw` (`build-arity.ts:309`), with `buildReadsChildren` (`:301`) in the same
condition — both verified uncalled outside `test/unit/build-arity.test.ts` in this lane. And
`encode.ts:1014–1019` derives an `OP_NODE` flag word with bits for trivia (4), state (8), fields
(16), collapse (32), unwrap (64) and trailingTrivia (128) — and **no bit for raw**. The whole shape
of the fix is: one more bit, derived by an oracle that exists, consumed by the two collector
emitters.

**The soundness check from §7.2 applies and is the reason this needs care.** This is a *must*
-analysis — "no reachable builder reads raw" — and §7.2's law says a label licenses dropping a test,
and licenses dropping **work** only over a root set proven complete. The root set here is
`prog.rules` plus `extraIps`, exactly the set `site-labels.ts`'s header says cannot prove absence. So
the bit must be derived **conservatively**: set "raw is dead" only when every `NodeDef` in the
encoded program answers `buildReadsRaw === false` *and* the host mode is non-CST. `hostCst` is a
cfg bit, so by §7.2 this is a residual at encode substituted at link — the two-stage shape exactly.
Getting it wrong drops CST children silently, which is §9.7's failure class.

**Status:** deferred out of 0.47 because a new `OP_NODE` flag bit is assembly-key adjacent. It is
**unmeasured** as a speed win — I have verified the dead-ness statically, not priced it.

> **H-4 (for whoever takes it).** Eliding the `raw` collector removes a measurable share of the
> 34.68 MB/parse allocation and of the CST-capture self-time. **Falsified if** a build with
> `_pushLeafBuf`'s raw arm stubbed out shows no allocation delta on css `benchmark.css` under
> capoff's protocol — which would mean the pair is being optimised away already and the cost is
> elsewhere. That stub is a ten-line change and settles it before any encoder work starts.

### 7.4 Options binding to pieces, generally

An option is a **link-row** fact by definition — it is fixed for the parse and supplied by the
caller. So the general answer is a one-liner: *an option is never read; it selects.* The interesting
part is the places where the current code lets an option arrive **later than link**, because those
are the only real defects.

Rule 3 is violated in more places than the one named, and the fix is the same for all of them.

**`src/combinators/grammar.ts:103`** — `const trackLines = opts.trackLines ?? _ctx?.trackLines ??
false`, read on scope entry during the parse, with `:104`'s `lineContext` derived from it. The
`opts.trackLines` half is fixed at grammar-construction time. The `_ctx?.trackLines` half is
runtime **only because a grammar object can be used both as a root and as a child of a
differently-configured parent.**

That is not a fact about JavaScript. It is a consequence of a signature we wrote.

**The binding.** Make the inherited option part of the **link key**, not a parse-time read. A
nested `parser({...})` is linked by its parent's link step, against the parent's resolved option
set, and if the same grammar object is reached from two differently-configured parents it is linked
twice — which is exactly what `AssemblyCache.byCfg` already does per `cfgKey`, one level up. The
mechanism exists; it is applied at the wrong boundary.

**The precedent for this is already in the tree and is the strongest argument in this document.**
`ops.ts:95–99`, on `OP_LIT_TRACK`/`OP_RX_TRACK`/`OP_NODE_TRACK`:

> "This is the variant axis, made concrete. `trackLines` picks these rows when the TABLE IS BUILT;
> the driver holds a case for each and never asks whether line tracking is on."

`trackLines` is *already* a build-time variant selector for four opcodes. Rule 3 asks for that
discipline everywhere, not for a new idea. Note also that `trackLines` is currently bound in **two**
places — those rows and `RunCfg.trackLines` — which is a latent inconsistency worth collapsing.

**What reshapes, said plainly, since nothing we authored is fixed.** If binding at link means the
entry is `(input, pos)` and `ParseContext` no longer carries `trackLines`, propose that. If it
means `run(entry, input, opts)` becomes `link(entry, opts)` returning a parser that is then called
with `(input)`, propose that. The relayed counter-argument — "options arrive on the `ctx` per call,
so the consult is irreducible" — is circular: the `ctx` carries them because we put them there.

**The enumerated population, so nobody claims 57 was the number and moves on.** LAW's `inv6x.mjs`
run found **57** config reads inside piece-internal bodies while `check-invariants.mjs` reports 0.
The gap is three defects in `INV-6`, and the largest is **file scope** — `ASSEMBLER` is
`'src/table/assemble.ts'` and nothing else is scanned, so 10 `ctx.trackLines` reads in
`src/combinators/trivia-skip.ts` and `src/recovery/scan.ts` are invisible even though `trackLines`
is *already* in `CONFIG_FIELDS`. The other two: `isPiece` requires exactly 3 parameters ending in
`ctx` (so `runTerms(input,pos,ctx,values)` and `nextTerm` evade it — the arity is the cause, and
the superseded design's proposed "trailing suffix" fix does not repair it either); and it rejects
`FunctionDeclaration`. LAW's replacement predicate — *a function is piece-internal iff its
parameter list contains an identifier named `ctx`* — is arity-free and order-free and is what
surfaced all 57. `lane/no-new-function` owns landing it.

Two specific reads worth naming because they are provably constant in the assembly that selects
them, and so are pure waste: `assemble.ts:803`'s `ctx._probe` **and `ctx._tolerant`** inside
`OP_GATE` (both are already `RunCfg` bits; css has 13 GATE rows, less 22, json none — a json-first
reading misses it entirely), and `:298`'s `REC = prog.rec === 1 && cfg.tolerant` guarding bodies
that then re-test `ctx._tolerant === true` internally, justified at `:294` as keeping `exec.ts` the
identity reference. Rule 3 does not admit that justification.

---

## 8. What I corrected in the brief and in the inherited notes

1. **"V8 tolerates a few shapes at a call site before going megamorphic."** True of property
   access (`kMaxPolymorphicMapCount = 4`), **false of calls**. M-2: the cliff is at the second
   FunctionLiteral, sharply, with no polymorphic tier. This sounds like bad news and is the
   opposite — see (2).
2. **"Nobody has established where the cliff is."** Now established, and it inverts the previous
   design. **Closures do not count; FunctionLiterals do.** 64 closures of one literal inline (M-1);
   2 closures of two literals do not (M-2). *Sharing a piece across sites is what makes the call
   site monomorphic.* The superseded design read `kManyClosures` as the defect when it is the cure.
3. **The array indexing is not the problem.** M-3. `REVIEW-child-kind-law.md`'s Test C was
   confounded — it varied kind count and index together. `kids[i]` inlines fine at uniform kind.
4. **A third axis exists and neither design has it: callee bytecode size.** Half right, and the
   half I got wrong was mine alone. The **460 B edge is real** and is now the design's primary
   lever (§M-5b) — but the **460–4,600 "dead zone" I predicted does not exist**; 475 B to 52,188 B
   is one flat plateau. Root cause of my error, recorded because it is a reusable trap: **920 and
   4,600 are caller-side budgets (cumulative and absolute inlining across one compilation), not
   callee sizes.** I read three numbers off a flag list and treated them as three thresholds on one
   quantity. A fourth axis I did not have at all: **receiver-map count**, poly→mega at the fifth
   map, +17–25%.
5. **`_probe` is already a `RunCfg` bit** at `c8eb725` (`assemble.ts:262–279`, `cfgKey` `:282`).
   The superseded design proposes adding it. The tree moved.
6. **`cfgKey` is five bits / 32 assemblies**, not three/eight — `assemble.ts:282` and the 32-slot
   `byCfg` at `:2648`. The doc comments at `:2637–2643` and `:2703` still say eight, and the bit
   layout is duplicated verbatim at `:283` and `:2688` with no shared constant and no test pinning
   them. Small, but it is exactly how a sixth bit ships half-wired.
7. **The size gate measures the per-grammar artifact only** (`bench/size-guard.ts:454`, `:465`).
   Tier S is not counted by it. Comparing a shipped library against 224,100 B is comparing
   different things.
8. **`trackLines` divergence is 66.3% / 48.6%, not 16–21%** (§5.3). **Settled.** `exp/wiring`'s
   independent third measurement is 52–61%, converging with mine; the 16–21% is retracted at
   source. This is the one place a number of mine survived a challenge, and it survived because a
   different method reproduced it, not because the challenge was withdrawn.
9. **`rawChildren` is dead work with an unused oracle already in the tree** (§7.3). Verified in this
   lane: `buildReadsRaw`/`buildReadsChildren` (`build-arity.ts:309`, `:301`) are called from nowhere
   in `src/`, `encode.ts:1014–1019` has no raw bit, and `assemble.ts:2426`'s
   `build(kids, fieldMap, span, rawKids, …)` is a 4th formal parameter no reachable css or less node
   def declares. Not a correction to the brief so much as a finding the brief handed me; recorded
   here because it is the first 0.48 unit and the only one independent of every open hypothesis.
10. **The 27.5–28.4% trivia self-time figure is a measured NULL** (§9.6). Removing the work
   entirely — `triviaScanLowered` all-`false` → all-`true`, verified in the emitted table — moved
   the parse not at all across 12 load-gated legs. Sampled self-time was wrong by more than an
   order of magnitude. **I was wrong about this number in both directions**, first attaching a
   staleness caveat and then re-endorsing it as "a figure that stands" while citing §1/M-5, a
   section about inlining budgets that says nothing about trivia. A wrong citation on a release
   branch is worse than a wrong number, because it survives review by looking checked.
11. **Cap labels cost zero bytes** — `lane/capoff` dumped emitted css/ast before and after forcing
   the cap label and got 1,049,296 bytes **identical**. My §3.1 lists site attributes as an axis
   that "earns a distinct piece"; for the `cap` field specifically that is now measured false, and
   §7.2 explains why (it is a residual, not a fact). The `buf` field is the one that costs.
12. **`PM_TABLE_COUNT` instruments `exec.ts`.** Honoured: every count in this document is either
   re-derived here (`probe/*`, `reachableIps`) or attributed to the lane that measured it.
   Relatedly, `bench/table-lowering-identity.ts:19` imports `tableRules` from `exec.ts`, so the
   ~2,800-file corpus sweep has never executed `assemble.ts` — the same defect the
   `consumed-sweep.ts` fix just addressed, in the gate this design's correctness rests on.
13. **`exec.ts` IS on the product path, and a public export runs it.** `src/table/index.ts:25–26`
    asserts of the bytecode interpreter: *"It is not on the product path and nothing emitted imports
    it."* Both halves are false at `6bc265f`. `src/table/fold.ts:1` imports `tableRules` from
    `./exec.ts` and is re-exported publicly as `tableVariants`/`variantNames` (`index.ts:48`);
    `src/compiler/linker.ts:24` imports it and `:334` runs it for `compose()` fusion. Worse than
    "nothing emitted imports it": **`src/table/emit.ts:265` *emits* `import { tableVariants } from …`
    into the generated module**, and `:273` calls it per variant — so a folded artifact ships code
    that runs the interpreter driver while the rest of the product runs the assembler. That is
    precisely the two-live-drivers drift the same comment warns about two paragraphs earlier
    (`index.ts:18–20`), already realised. It also means `example/*` fold fixtures and `compose()`
    users are not exercising the engine this design is about. Not this document's fix, but it must
    not be discovered later as a surprise: it silently narrows what every corpus gate covers.
14. **jess's real Less grammar is not in this repo.** `bench/workloads/less.ts` is a vendored
    re-creation (its own header says so). Every "less" cardinality in §3/§4 is the vendored
    grammar's.

---

## 9. What I am least sure of

Ordered by how much of the design falls if it is wrong.

**9.1 — H-2, the D3 hot-site fraction, is the load-bearing unknown and I have not measured it.**
Every byte number in §5.4 is a function of it, and my basis is one census on one grammar (json's
43%-on-11-rows) generalised to four. If jess's execution histograms are flat, Tier G approaches
"all sites", the byte answer goes to 155 KB–179 KB per css-sized grammar, and the ratchet
conversation is larger than §5.4 implies. `exp/mixture`'s Pareto curve measures this directly and
should be read before anything is built.

**9.2 — RESOLVED, and the worry was the right one.** I flagged that my `seq2` was 51 bytecode bytes
against real pieces that are far larger, and that on real pieces the D2 win might be smaller because
"the parent was never going to inline the child anyway." That is exactly what `exp/cliff` and
`exp/wiring` found: **16.6–28.4% of real pieces, and every composite, are already past 460 B**, so for
them there is no inlining to win. The instinct was right and I still built D5 on the assumption it
was not. That is the pattern to watch in the rest of this document — §9 correctly named two of my
three biggest errors before they were measured, and naming them did not stop me designing on them.

**9.3 — REFUTED, and I flagged it as inferred-not-measured before it was.** The dead zone does not
exist. What I wrote here — "the most confident-sounding claim in this document and the least
directly tested" — was accurate, and the ladder I proposed (`probe/budget.mjs` extended past 460)
is precisely the run that killed it. Kept in place rather than deleted, because the useful artifact
is the record that a self-flagged weak claim still made it into the procedure as D6.

**9.4 — CLOSED.** `trackLines` at 66.3%/48.6% is corroborated by `exp/wiring`'s independent
52–61% by a different method. I had recorded the interim state as a *downgrade* in confidence — one
lane, one method, two toy fixtures, with the only opposing number withdrawn rather than reproduced.
That was the correct reading at the time and the resolution came from a third measurement, not from
the objection being dropped.

**9.4b — The separate reconciliation, and the one I nearly got wrong.** `exp/wiring` reported the
option-invariant fraction at 39–48% against my 89% and asked me to re-base §5.4. Recomputing my own
committed data n-way rather than pairwise gives 33.7%/51.4% over four option sets — which brackets
their number. Both were right; they measure different quantities (§5.3b). The trap worth recording:
the fastest response would have been to retract 89%, and that would have thrown away a correct
measurement. **Reconcile before retracting.**

**9.5 — I did not measure the reducer finding, only offer a mechanism for it (H-1).** "Identical
source, 1.30–1.32× slower" is the sharpest unexplained fact in the tree and my budget explanation
is a hypothesis with a one-run falsifier. If it is wrong, roughly half the remaining gap has no
owner in this design either.

**9.6 — RESOLVED by a null, and my previous revision of this paragraph was wrong twice over.**

The worry was: Tier S reproduces `inRanges`, `inRanges` is on the trivia path, and "cold sites get
the slow shape" is only safe if trivia sites are cold — which I had not established.

**It is now established, by removal.** `notes/RESULT-capoff-trivia-scanner-is-a-null.md` (`bccc32f`
against `6bc265f`) flips `triviaScanLowered` from all-`false` to all-`true` — verified *in the
emitted table*, not inferred — so every trivia gap stops going through the per-character labelled
classifier (`src/cst/trivia-charscan.ts`) and through a fused scanner instead. 12 load-gated legs,
3 interleaved rounds × 2 dialects: **every delta inside its own base-to-base spread, signs
inconsistent across dialects.** A null, pre-registered as one. So **trivia scanning was never 28% of
parse time**, and the sampled self-time attribution that produced 27.5–28.4% is wrong by more than
an order of magnitude — the exact failure mode the brief warned about, sampled profiling
over-crediting frequent cheap frames.

**Two errors of mine, and the second is worse than the first.** I cited 27.5–28.4% as a figure that
"stands", and I justified that by pointing at §1/M-5 — which is the inlining-budget section and says
nothing whatever about trivia. That is a citation to a section that does not support the claim, in a
document on a release branch. I had earlier attached a *staleness* caveat to the same figure, which
was also wrong (retracted at §1, M-5, correctly). So I have now been wrong about this number in both
directions, and the thing I never did was ask what would happen if the work were removed.

**Bearing on §4.4, stated with its limit.** The null is evidence in the right direction and it is
the strongest available: making the trivia path substantially *faster* bought nothing measurable, so
Tier S's somewhat-slower `inRanges` fallback is unlikely to cost anything measurable either. That
bounds the **magnitude** of the whole trivia path. It does **not** prove any particular slower
implementation is free, and it is not licence to treat §4.4 as settled without a direct A/B of the
Tier S fallback itself. What it does retire is the specific fear stated here — that trivia is hot
enough for a generic fallback to be a deferred defect. It is not.

**Standing note on this figure.** It has four documents and three numbers in the tree — capoff's
null, `exp/mixture` still using 28% as a denominator, this paragraph's prior re-endorsement, and
`RELEASE-0.48-TARGET.md:88` carrying 7.3%. `lane/perf-ideas-consolidation` has recorded all four
without smoothing them, which is the right treatment. Anyone reaching for a trivia share should
start from the null, not from any of the percentages.

**9.7 — `OP_ADJ` (§4.5), capture-reachability, and the site-attribute record are the three places
this design can produce silently wrong output** rather than a slow parse. They are the ones to gate
hardest: whole-object comparison against the interpreter (`test/parity/helpers/engine-parity.ts`),
not a field checklist, which is how the `sepBy trailing:'require'` divergence got through.

**9.8 — I have read `assemble.ts`'s structure and `lower()`'s case list, not all 2,731 lines.**
The `OP_CHOICE`, `OP_REP` and `OP_NODE` bodies I know only by their closure-minting counts. The
corrected `INV-6` of §7 is the instrument that would enumerate what I missed, which is another
reason `lane/no-new-function` should land before anything here is built on.
