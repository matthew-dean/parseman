# Performance ideas (codegen / macro)

Library-level opportunities for faster compiled parsers. Grammar authors can only reach some of these via hand-merging or collapsing shapes (see README § "collapse opaque shapes into one regex").

Interpreter-side ideas are split out to [`INTERPRETER_PERF_IDEAS.md`](./INTERPRETER_PERF_IDEAS.md) so this file can stay focused on compiled/macro output.

---

## STATUS CONVENTION AND COUNTS (updated 2026-08-25)

One marker per item, across this file and its four siblings
(`INTERPRETER_PERF_IDEAS.md`, `REVIEW-parseman-perf-proposals.md`,
`CODEGEN-FAST-PATHS.md`, `RELEASE-0.48-TARGET.md`). Strikethroughs and
"partial ✅" are retired: a compound item carries one marker per part.

| marker | means |
|---|---|
| `LANDED` | implemented and in the tree |
| `MEASURED-NULL` | built and measured; delta inside the control spread |
| `REJECTED` | ruled out on grounds other than a null measurement (built-and-worse, moot, or scoped and deprioritized) |
| `QUEUED` | decided to do, not done |
| `UNMEASURED` | nobody has tried or costed it |
| `REFERENCE` | data, protocol, invariant or design guidance — not a work item |

**THE COUNT, which is the thing this file exists to make answerable:**

> ## **61 untried items.**
> **[§ Untried index](#untried-index-queued--unmeasured) is the authoritative list — one row each, no prose to read.**
> Of the 61: **27 `QUEUED`** (decided, not done) and **34 `UNMEASURED`** (nobody has tried or costed it).
> **26 came out of the 2026-08 measurement batch** (U-31…U-56); the five
> architecture programs added on 2026-08-25 are U-57…U-61.

Everything else, for orientation:

| marker | where | count |
|---|---|---:|
| `LANDED` | 18 bullets under "Already landed" + 21 headings marked in place | 39 |
| `MEASURED-NULL` | built and measured, delta inside the control spread | 2 |
| `REJECTED` | ruled out on non-null grounds (built-and-worse, moot, scoped-and-deprioritized) | 9 |
| `REFERENCE` | data, protocol, invariant, design guidance — not work items | 12 |

Compound items carry one marker per part and are counted once per marker, so
these totals exceed the 41 headings in the file. The untried count does **not**
double-count: it is exactly the number of rows in the untried index.

**Scope of the 56: this file only.** Each sibling carries its own count at its own
top, under the same convention. Repo-wide, deduplicated:

| file | items | untried | notes |
|---|---:|---:|---|
| `PERF_IDEAS.md` (this file) | 46 headings + 18 landed bullets | **61** | the U-index |
| `INTERPRETER_PERF_IDEAS.md` | 26 | **3** | no commit SHA appears anywhere in it |
| `REVIEW-parseman-perf-proposals.md` | 8 | **3** (1 net new — 2 are U-29 / U-30) | rigorous code citations, zero measurement provenance |
| `CODEGEN-FAST-PATHS.md` | 16 | **2** (both file-local) | **describes an engine deleted at the 0.47 cutover** |
| `RELEASE-0.48-TARGET.md` | 30 | **11** | not a backlog — four kinds of content interleaved |
| | | **= 78 distinct** | |

**Two files resisted classification and are marked as resisting, not forced.**
`CODEGEN-FAST-PATHS.md` needed a state none of the six markers covers —
`LANDED, THEN REMOVED`, because the work shipped and was then deleted *without a
decision* (recovery is U-53). `RELEASE-0.48-TARGET.md` is not a backlog at all: it
interleaves deferred work, retracted figures, hygiene rules and disclosed
defects, and its two ownerless known-broken defects (§10.2, §10.3) are
`UNCLASSIFIABLE` — nobody decided to do them, nobody rejected them, and they are
not ideas. Read both files' headers before their bodies.

---

## 2026-08-25 — radical macro-runtime programs (U-57…U-61)

These are the five high-ceiling programs selected after the 0.50 optimization
loop found that local choice predecisions made the current macro artifact
roughly 17–22% faster than released 0.49, but still left a broad architectural
gap to 0.45. They are deliberately not another list of opcode peepholes.

**Scope contract for every result in this section:** it counts only when run
through ordinary macro-built shipping output. Build-time generation may use
dynamic evaluation; the emitted parser may not use `eval` or `new Function` at
runtime. Use the existing Jess macro A/B harness, a nearby clean worktree of the
comparison commit, interleaved candidate/reference rounds, full-consumption and
value/parity checks, and an adjacent identical-code control. Do not promote a
wall-clock result whose effect does not clear the control spread. Generated JS
size, per-body bytecode size around V8's measured 460-byte inlining limit, and
hot-site execution coverage are co-equal outputs—not afterthoughts.

The common thesis is that Parseman still executes too much *generic parser
machinery* after the grammar has become static. A macro compiler should partially
evaluate the grammar into a small number of deterministic source-recognition
regions and keep PEG fallback, semantic branching, diagnostics, and tree
construction only at the boundaries that truly require them.

### U-57. Deterministic-region fusion and size-budgeted superinstructions — `ACTIVE`

Compile maximal deterministic regions—not individual combinators—into
straight-line JS. A region starts where the active grammar state is known and
continues through terminals, trivia, fixed sequences, bounded repetitions, and
uniquely predicted choices until it reaches a genuine ambiguity, semantic gate,
recursive boundary, recovery point, or output barrier. Its hot success trace is
one function with local scalar cursor/capture variables and direct cold exits;
there is no per-combinator call/return, FAIL sentinel traffic, or repeated
save/install/restore protocol inside the region.

This is closer to instruction selection and trace formation than to regex
fusion. Build a grammar CFG, annotate edges with FIRST/nullability, capture and
rollback effects, then form single-entry regions whose success path is unique.
Lower recurring region fragments as *generated* superinstructions. There are
**two size regimes**, not one universal 460-byte cap: keep a leaf region below
the measured threshold when its value depends on inlining into a parent; allow a
hot trace-root region to exceed it deliberately when the region has deleted the
internal calls and optimizes as a standalone function. The 0.45 direct source
emitter is the topology proof: it recursively emitted combinator logic inside
named parser bodies, so those bodies did not need to inline into another parser
to avoid internal call traffic. Cold ambiguity/failure continuations may remain
ordinary piece calls. The compiler should choose a Pareto point from `{executed
calls, emitted bytes, estimated bytecode size, caller-inline value}`, rather than
maximizing fusion, sharing, or inlining in isolation.

First falsification experiment: fuse one high-coverage Less value/declaration
region end-to-end while leaving its cold exits on existing code. Require a
double-digit isolated-site reduction and a credible whole-Less ceiling of at
least 15%; reject a shape that merely trades calls for >10% artifact growth.
Crossing 460 bytes is a cost only if current profile/inlining evidence says the
region's caller needs that body to inline; it is not grounds to reject a
standalone hot trace. Prove rollback/CST/diagnostic parity by forcing every cold
exit, not only the success corpus.

**First ceiling result (iteration 59): per-NODE placement rejected, region
formation still active.** A generic macro-only probe activated 54 Less
`NODE -> SCOPE -> SEQV/REPV` regions and deleted 147 private generated functions.
It removed 88,617/260,867 dynamic generic calls on benchmark/generated Less
(about 16% of counted rows) while growing the 1.93 MB artifact only 0.161%, and
passed exact digest/full-consumption parity plus forced rollback/commit/throw
exits. Nevertheless, the adjacent two-graph control normalized runtime to
**+3.4%/+2.5% slower**. The placement had enlarged representative hot NODE
bytecode from 467 B to about 1.45 KB and mixed recognition loops with
capture/build logic. Later TurboFan tracing sharpened the interpretation: this
probe still stopped at every nested NODE call. It pasted SCOPE/SEQ work that V8
already inlined while retaining the actual 467–490 B NODE refusal boundaries,
so it did **not** test the recursively emitted 0.45 named-rule topology.

**Second ceiling result (iteration 60): coarse standalone scalar placement also
rejected.** Moving the same 54 regions into dedicated end/failure recognizers
restored the representative NODE to 466 B, retained all 88,617/260,867 counted
call deletions, and grew source only 0.353%. The recognizers themselves were
roughly 0.8–2.5 KB of V8 bytecode, however, and controlled runtime regressed
**+4.4%/+5.8%**; generated Less lost every paired round. Thus counted table-row
calls are not evidence of machine calls—TurboFan already inlines the small
SCOPE/SEQ baseline topology. The remaining region experiments target the
boundaries the trace proved real: either compact flags-2 NODEs below the inline
cutoff, or form a genuinely vertical named-rule trace that fuses **through**
eligible nested NODE/REPV construction instead of stopping at it. The latter may
remain a large standalone trace, as 0.45 did; iterations 59–60 do not falsify it
because neither removed the nested NODE calls. Per-NODE pasting and a large
recognizer beside each NODE are the rejected placements—not large trace roots
categorically.

**Third ceiling result (iteration 61): broad NODE-inline compaction rejected.**
Cold-extracting only inherited-buffer publication cut direct-builder NODE
bytecode from 472/490/493 B to 324/342/343 B and made TurboFan recursively inline
previously refused NODE chains. It activated 213 Less sites, shrank the macro
artifact 2.93%, passed 314/314 corpus identity and cold-buffer RED tests, and put
no replacement helper on the ordinary flat-array success path. Yet the adjacent
control normalized runtime to **+2.9%/+2.5% slower**, with zero winning rounds.
The old cutoff was protective: recursively copying the full capture/context
protocol increased optimized-code pressure. A smaller NODE is useful only when
inlining is leaf-local, or when a fused scalar/tape trace deletes those repeated
frames rather than copying them. Source shrink and confirmed inlining are not
performance evidence by themselves.

### U-58. Make derived tokens the primary control-flow currency — `ACTIVE`

Today token information often acts as an advisory pretest, after which the
selected arm re-enters ordinary PEG machinery and reconstructs facts already
known. Replace that handoff with a compact scalar token result such as
`kind | route | flags | end`, held in locals or packed integers. A decision site
consumes the token directly: it jumps to a route, adopts the known end offset,
and materializes text only if a reducer requests it. Same-family arms share the
recognition once; prefix-compatible arms receive a residual token state rather
than rescan source. There should be no token object, general token buffer, string
classifier, or context-level pending-result protocol on the hot path.

The scanner is grammar-derived and mode-aware, not a traditional independent
lexer. Its state is the current viable terminal family plus lexical/context
bits, so it can preserve scannerless PEG semantics where token boundaries depend
on the production. Token recognition and branch choice become one generated
operation. Cache only where dynamic traces prove reuse across decision sites;
otherwise keep the packed result in the current region's locals.

First falsification experiment: on Less's hottest unrestricted `Value` family,
generate a route table from the full viable-arm set and delete the selected
arm's duplicate selector, regex/literal scan, and wrapper entry. Instrument
scans and executed arms to prove work disappeared. The earlier one-slot pending
handoff was slightly slower; this program succeeds only if the token is the
control flow itself and no generic handoff state remains. Target ≥15% whole-Less
ceiling before generalizing.

### U-59. PEG residual/derivative decision DAG — `QUEUED`

Treat each hot choice as a language-state problem. Compute a bounded residual
of the ordered PEG expression after each observed character/token: the state is
the remaining viable arms, their ordered-commit relation, nullable/accepting
status, and the capture/semantic actions deferred at that point. Hash-cons
equivalent residuals into a decision DAG. At runtime, a table or generated
switch advances the state until it reaches a unique continuation, then jumps
directly into the residual grammar rather than restarting an original arm.

This is not a DFA conversion that discards PEG priority. Ordered choice is part
of the state: an earlier arm may shadow a later accepting arm, and semantic
predicates or unbounded context create explicit opaque transitions back to the
normal engine. Use derivatives only over the regular/token-recognizable prefix;
attach deferred capture actions to edges or accepting states. Bound state count,
lookahead depth, and emitted bytes, falling back per site when construction
explodes. Minimize states after capture-equivalence partitioning, not only
language equivalence.

First falsification experiment: build the residual DAG for the hot Less Value
and selector families and report `(original decisions, residual states, unique
continuations, fallback rate, emitted bytes, dynamic avoided arm entries)` before
timing. If the state graph does not collapse substantially or covers too little
dynamic traffic for a ≥15% ceiling, reject it there. If it does, compare a packed
transition table against generated nested switches; JS engine behavior, not
aesthetic preference, picks the representation.

### U-60. Recognition tape followed by selective construction — `QUEUED`

Split recognition from object/tree construction without parsing twice. The hot
recognizer writes a compact event tape—production/action id plus source offsets
and only the few scalar values that cannot be reconstructed cheaply—into reusable
numeric storage. It performs no node allocation, child-array construction,
builder dispatch, source slicing, or trivia object work. A second linear pass
replays successful events into the exact public CST/host value. Failed speculative
paths rewind a numeric tape cursor instead of undoing several heterogeneous
collector arrays and context fields.

This is valuable only if the tape is cheaper than the current interleaved capture
protocol. Prefer struct-of-arrays or packed 32-bit words with geometric reuse;
avoid per-event objects and callbacks. Allow a hybrid: directly build leaf/simple
regions where that is cheaper, and tape only rollback-heavy or host-heavy
regions. Reducers that affect future recognition remain eager semantic actions;
pure constructors move to replay. Trivia and spans can be represented as source
ranges and expanded only when demanded by the output contract.

First falsification experiment: tape one complete hot Less subtree and replay it
through the unchanged builder contract. Compare parse-only, replay-only,
parse+replay, allocation, and peak tape words. Require total macro parse+build to
beat the current interleaved engine by enough to imply ≥15% whole-Less upside;
recognizer-only speed is not a win. Verify exact AST/CST/trivia identity and force
speculative rollback paths.

### U-61. Scalar parse ABI and packed rollback/capture machine — `QUEUED`

Replace the generic `value | FAIL` calling convention and mutable ParseContext
protocol inside compiled regions with a scalar ABI. A recognizer returns an end
offset (negative encodes failure/commit class); semantic values travel through
statically assigned local/result slots only where demanded. Cursor, farthest
failure, commit bits, capture tops, and tape tops are numeric locals. A rollback
point is a fixed-width record in a reusable numeric stack or a compile-time set
of locals, not repeated snapshots of independent arrays. Cross-region calls use
a small number of arity-specialized signatures rather than one universal object
context.

Exploit JS/V8 deliberately: keep hot numeric locals as Smis where practical;
avoid polymorphic return shapes, exceptions, destructuring, rest parameters,
and property churn; preserve direct named calls; keep callees below the measured
inlining threshold; use typed arrays only after plain packed arrays are measured,
because bounds checks and numeric conversion can lose. Emit separate ABIs for
recognizer-only, scalar-value, and structural actions so unused output channels
do not survive as runtime branches.

First falsification experiment: lower a vertically complete Less region to the
integer-return ABI with a fixed capture/rollback frame, including one committed
failure, one speculative rollback, and one value-producing exit. Inspect actual
V8 bytecode and deopts as well as wall time. The result must remove measurable
loads/stores/calls and show a ≥15% whole-workload ceiling; a context object merely
hidden behind helper accessors is not this design.

### Orchestration order and combination

Run U-57, U-58/U-59, and U-60/U-61 as independent ceiling probes first. Do not
prematurely force them into one implementation. The likely combined architecture,
if the probes validate it, is: a residual/token predictor selects a deterministic
region; the region executes under the scalar ABI; rollback-heavy structural
actions append to a tape; cold opaque PEG continuations retain the existing
engine. Each boundary must justify itself by dynamic frequency and emitted-byte
cost. Retain and commit only macro-runtime wins to `feature/0.50.0`, one measured
win per commit.

---

## 2026-08-07 — ESTABLISHED FACTS from the piece-library measurement batch

`REFERENCE`. These are results, not proposals. They are recorded here because
several of them **invalidate premises that items further down this file were
designed against**, and because the artifacts lived only on lane branches until
now.

### Provenance table — read before quoting any number below

| lane | branch SHA | artifact in-tree |
|---|---|---|
| cliff | `origin/exp/cliff` `405476d0c023487d87828f2d584a96b361f477a6` | `notes/EXPERIMENT-inlining-cliff.md`, `notes/results/inlining-cliff.jsonl` (275 records) |
| wiring | `origin/exp/wiring` `5b45501ab03c0efad30c90f6eb598fb4e9ed7238` | `notes/EXPERIMENT-wiring.md`, `notes/results/wiring-sweep.jsonl` (34 records) |
| mixture | `origin/exp/mixture` `c78a9cee2da84381b28e59a9f5f37e9543b832fe` | `notes/EXPERIMENT-mixture-sweep.md`, `notes/results/mixture-sweep.jsonl` (208 rows), `notes/results/mixture-shape.jsonl` (8 rows) |
| balance | `origin/design/balance` `d026e56bc329eca5f166bc289d64aebbeee2b5f7` | `notes/DESIGN-piece-library.md`, `notes/probes/piece-library/` |
| capoff | `origin/lane/capoff` `93de44ea8b8d36189cab70a0d202ad65780ce56a` | `notes/RESULT-capoff-trivia-scanner-is-a-null.md`, `notes/FINDING-rawchildren-collector-is-unread-in-ast.md` |
| linker | `origin/lane/linker-engine` `249cbd9a1177fb1d20c8bbbf827f844e332f147d` | code + `249cbd9`'s bench result |

All six lanes branched from `origin/release/0.47.0` = `6bc265f5b854b256a2e8ea0df5522ca7cfd57770`.
All artifacts are now merged into `origin/release/0.47.0` at
`67478722cc33fd6654fb44a48fd460a1ad5ced34`; `exp/wiring` and `exp/mixture` still
carry unmerged *code* (the `setWiring` / `PM_MIX_DRIVER` hooks), but their notes
and results files are byte-identical to the ones in this tree.

Node `v24.11.1` / V8 `13.6.233.10-node.28` throughout. Cliff harness SHA
`bbacf3d9eb7b75167bd22971bd7223ba851ea73d`, stamped on every jsonl record.

### A. The V8 premise this file's per-site-body designs rested on is DEAD

`EXPERIMENT-inlining-cliff.md` §1-§3, §6-§8. Modelled pieces (faithful reductions
of `sequence.ts` / `choice.ts` disjoint arm / `repeat.ts` `many`), plain ESM, no
build step. **A/A control 35.21 / 36.04 / 36.55 ns/op → 3.7% spread**; median
within-config rep spread 7.5% across 131 timed configs. Nothing under ~4% is
reported as signal; every effect below is ≥17%.

1. **Closure count is free.** 40 closures from one `CreateClosure` site, all
   sharing one FeedbackVector (`sharedFeedbackVector: true`, verified by *address
   equality* in `%DebugPrint`), still inline at every N: `--trace-turbo-inlining`
   reports 3 considered / 3 inlined at N=1 **and** at N=40, in both shape regimes,
   monomorphic through megamorphic. `kManyClosures` is present in every one of
   those rows and **is not itself a cost**. The chain "second closure ⇒
   `kManyClosures` ⇒ megamorphic ⇒ must emit per-site bodies ⇒ must use
   `new Function` ⇒ CSP guarantee broken" does not hold at any link.
2. **The cliff for calls is the second distinct *executed* callee
   FunctionLiteral, at N=2 — sharp, one step, flat to N=40.** V8 prints
   `Call POLYMORPHIC` literally, but it behaves as a binary one-callee/many-callee
   distinction, **not** a 4-wide tier. `kMaxPolymorphicMapCount = 4` governs
   **property access**, not calls. Cost of the N=1→2 step under *identical* maps:
   choice 7.58→10.43 (**+37.6%**), many 50.83→70.05 (**+37.8%**), seq
   35.44→36.54 (+3.1%, inside the floor — seq's callee arrives via `parsers[i]`,
   never a constant to begin with).
3. **Memory control:** 40 sites BUILT / 1 EXERCISED stays MONOMORPHIC and stays
   fast (seq 36.53, choice 7.71, many 51.45 — all within the floor of N=1). It is
   the executed callee count, not the closure count.
4. **A fifth distinct receiver map is a separate axis**, poly→MEGA at N=5 on the
   `.parse` *load* slot: seq 38.28→45.01 (**+17.6%**), choice 10.39→12.96
   (**+24.7%**), many 72.80→91.09 (**+25.1%**). Never fires when callees share a
   map, at any N.
5. **Captures 0→8: no effect** (every delta inside the 3.7% floor; the cliff does
   not move). **The cliff does not compound through a call chain** —
   seq-of-choices at N=40 is +21.8% against +22.0% unchained. **`--no-polymorphic-inlining`
   changes nothing** (every column inside the floor), so the flat N=2..4 region is
   flat for another reason. Deopt reasons are constant at 2 per run at every N in
   both regimes (`OSR`, `Insufficient type feedback for generic named access`) —
   no deopt storm, no N-dependence.

### B. Callee bytecode size is the dominant axis, and the threshold is 460 B

`EXPERIMENT-inlining-cliff.md` §4 (modelled) and `EXPERIMENT-wiring.md` §1
(real emitted pieces). Two independent instruments agree.

- **448 B inlines, 475 B does not** — identically for all three piece kinds, at
  N=1 with identical shapes so the size effect is not confounded with callee
  count. Padding sits behind `if (pos < 0)`, which never runs and which TurboFan
  cannot fold, so bytecode grows while executed work stays constant. Sizes are
  real `BytecodeArray[N]` lengths read from a cold twin via `%DebugPrint`.
  That brackets `--max-inlined-bytecode-size=460` **to within 27 bytes**.
- It is not merely slower: `consideredForInlining` drops **3 → 1** past the
  boundary, so the callee is not even a candidate. Cost of crossing: seq
  **+23.3%**, choice **+52.8%**, many **+34.9%**.
- **Proved causally on real pieces.** `EXPERIMENT-wiring.md` §1: re-run with
  `--max-inlined-bytecode-size=900 --max-inlined-bytecode-size-cumulative=5000`
  gives **zero `Cannot consider` rows**, and every previously-refused piece
  inlines (`_pf12` into `_pf43`/`_pf70`, `_pf43` into `_pf56`, `_pf92` into
  `_pf56`/`_pf70`). Same source, same wiring, one flag. On real pieces the cutoff
  is bracketed between 424 (inlines) and 647 (refused).
- **There is NO 460–4,600 dead zone.** 920 and 4,600 are
  `--max-inlined-bytecode-size-cumulative` and `-absolute` — **caller-side
  budgets, not callee sizes**. From 475 B to 52,188 B the curve is one flat
  plateau, across a range that crosses both several times over. The predicted
  dead zone was a misreading of three flags as one axis.

**Consequence, and it is the important one.** Real emitted bodies (`--print-bytecode`,
pieces reached in two parses, `EXPERIMENT-wiring.md` §2):

| workload | pieces | min | p50 | p90 | max | over 460 |
|---|---:|---:|---:|---:|---:|---:|
| json/document | 28 | 58 | 84 | 801 | 801 | **6 (21.4%)** |
| graphql/document | 74 | 58 | 323 | 801 | 3,974 | **21 (28.4%)** |
| css/stylesheet | 103 | 59 | 246 | 726 | 3,600 | **20 (19.4%)** |
| less/stylesheet | 319 | 59 | 202 | 568 | 2,813 | **53 (16.6%)** |

Roughly 3:1 source-to-bytecode, so ~1,400 source bytes is the practical ceiling.
**The over-460 set is precisely the COMPOSITE pieces** — sequences and repeats,
the parents. So: specialising a parent per child kind spends bytecode budget on
the one class of piece already at the ceiling; it recovers the CHILD's inlining
and can push the PARENT past 460, losing the parent's inlining into ITS parent.
**Sharing is what makes a call site monomorphic, and reuse that shrinks bodies
buys inlining rather than costing it.** Specialising to recover inlining recovers
nothing at current sizes.

> `EXPERIMENT-inlining-cliff.md` states the real `_pf` body sizes as 17.4 KB (css)
> / 31.7 KB (less) — an aggregate figure it carries as still-owed context, whereas
> the wiring lane's per-piece census above is the measured distribution. Both are
> recorded; they are different quantities (whole emitted body text vs per-piece
> bytecode) and neither is a correction of the other.

### C. Wiring is free. Shared dispatch is the one thing that costs

`EXPERIMENT-wiring.md` §1. `json/document`, 60 parses,
`--trace-turbo-inlining`, counting DISTINCT emitted pieces. Every leg's parse
result compared against the unrewritten one: **all seven wirings parse
identically on every workload measured**.

| wiring | considered | inlined | refusals |
|---|---:|---:|---|
| w0 direct hoisted name | 36 | 19 | reason5 × 11 |
| w1 array of refs, indexed at each site | 35 | 19 | reason5 × 14 |
| w2 object property → local const at link | 36 | 19 | reason5 × 11 |
| w3 closure capture of the callee | 36 | 19 | reason5 × 11 |
| w4 monomorphic wrapper over shared body | 60 | 38 | reason5 × 8 |
| **w5 switch dispatch on a small integer** | **33** | **9** | **reason5 × 53** |
| w7 partial sharing (snapshot prologue) | 52 | 22 | reason5 × 11 |

Direct name, array index, object property and closure capture are
indistinguishable to V8 at real body sizes — `design/balance` found this on
51-byte synthetic pieces and it **holds at 800-byte real ones**. Those four are
closed.

**w5 switch dispatch halves inlining (19 → 9)** because routing every call through
one `_disp(id, …)` makes the dispatcher a second distinct callee at every site —
fact A2 reproduced on real pieces. The generalisation: **any shared indirection
layer in front of the pieces costs the callers their inlining.** Never route
calls through a shared dispatcher.

> **Recorded trap.** The first run of that table read w1/w2/w3 at **1 inlined**
> against w0's 19 — a clean, plausible, publication-shaped 19× collapse, and
> entirely an artifact: those rewrites produce *anonymous* function expressions,
> whose `SharedFunctionInfo` has an empty name and so vanishes from the trace.
> Naming them (`P[0]=function _pf0(…)`) made the collapse disappear. The fix was
> one character wide.

### D. Partial sharing is the best result found

`EXPERIMENT-wiring.md` §4. `emit-assembly.ts`'s own criterion — *a shared
emitted-scope helper is sound exactly when it takes no piece as an argument* — is
a **decomposition rule**, not an all-or-nothing verdict on a piece, and nothing
had exercised it below the level of a whole piece. The emitted sequence-term
prologue snapshots six CST sink lengths so a zero-width term can roll back; it
takes no piece; it is repeated at every sequence term.

| workload | baseline | shared prologue (`w7`) | delta | inlining |
|---|---:|---:|---:|---|
| json/document | 24,776 B | **18,540 B** | **−25.2%** | **22 inlined vs 19 — better** |

Identical parse. It buys inlining *back*, because shrinking the composite bodies
moves some of them under 460. This is the only one of the seven strategies that
is unambiguously positive on every axis measured, and the one the design work had
not costed. **Byte-and-inlining result only — no wall-clock number exists.**

### E. Overgeneration is affordable when targeted

`EXPERIMENT-wiring.md` §3. Axis: `trackLines`, aligned site-for-site between two
emitted variants. The overgenerated module was **BUILT AND RUN**, not modelled: it
parses identically to the baseline and the live half is the untouched direct-name
wiring, so the un-picked variant's runtime cost is measured zero rather than
asserted zero.

| workload | sites | identical bodies | differing | option-INVARIANT |
|---|---:|---:|---:|---:|
| json/document | 28 | 12 | 16 | **42.9%** |
| graphql/document | 94 | 45 | 49 | **47.9%** |
| less/stylesheet | 349 | 136 | 213 | **39.0%** |

| workload | one variant | overgenerate ALL | overgenerate MOVERS |
|---|---:|---:|---:|
| json/document | 24,776 B | 46,374 B (+87.2%) | ~32,342 B (**+30.5%**) |
| graphql/document | 112,042 B | 219,979 B (+96.3%) | ~173,753 B (**+55.1%**) |
| less/stylesheet | 268,576 B | 529,786 B (+97.3%) | ~394,972 B (**+47.1%**) |

**Correction to a standing figure.** The circulating "~80% of piece bodies are
option-INVARIANT" and "`trackLines` changes 16–21% of them" are wrong for this
quantity. Measured on the emitted assembly, `trackLines` changes **57%** of bodies
on json, **52%** on graphql, **61%** on less; the invariant fraction is
**39–48%**. Whatever the 80% described, it is not bodies of emitted pieces under
`trackLines`.

### F. The monomorphic wrapper (D7) is dead, and its one win was a harness artifact

Two independent kills.

**Byte side** (`EXPERIMENT-wiring.md` §5) — **there is no denominator.** 27 of 28
json bodies are distinct; 296 of 349 on less; 156 of 177 on css; 81 of 94 on
graphql. A shared-body-plus-wrapper scheme has no deduplication to pay the
wrapper with: on json it is +5.8% bytes, neither losing inlining (38 inlined,
wrappers and impls both) nor gaining bytes. **Wrappers only pay when bodies
actually repeat, and today they do not.**

**Time side** (`EXPERIMENT-inlining-cliff.md` §5, §5b) — pure loss on seq and
choice (**+1.3 to +3.6 ns/op**, ~145–149 B/site at N=1), and the inner body stays
MEGAMORPHIC under it. `wrapCAP` (captured binding) and `wrapIND` (array element,
not constant-foldable) agree everywhere within the floor, which independently
falsifies the prediction that capture-wiring would win by constant-folding.

Its one apparent win — `many` at N=5, **91.09 → 65.61** — is **traced to the
benchmark driver**. Body sizes rule out the size explanation (`seq.parse` 248 B,
`choice.parse` 213 B, `many.parse` 263 B, all under 460). What the trace shows: a
per-site `new Function` literal makes the *caller's* call site megamorphic,
inlining is refused, and `many` gets a clean standalone compilation. `many` is
the only piece whose body loops over its callee (8 calls/op); inlined into
`benchRound`, which already has two nested loops, it becomes a triple-nested loop
in one function and TurboFan does materially worse. **Real callers are other
pieces, not a degenerate two-deep counting loop.** One timing is still owed (see
untried U-38).

### G. The size lever, measured — 8.2× to 9.9×, at unknown speed cost

`EXPERIMENT-mixture-sweep.md` Result 1. Four shipping jess dialects, `ast`
variant, `JESS_ROOT=/Users/matthew/git/oss/jess`.

| dialect | all-specialised | all-shared | ratio |
|---|---:|---:|---:|
| css | 1,021 KB | 125 KB | **8.2×** |
| less | 1,986 KB | 218 KB | **9.1×** |
| scss | 1,369 KB | 138 KB | **9.9×** |
| jess | 1,443 KB | 160 KB | **9.0×** |

**NO TIMING WAS TAKEN.** Every jsonl row carries `timing: null`. There is no
Pareto curve, only its x-axis. **A 9× size lever is not a recommendation.**

Validity controls that make the number mean something: 13 configurations on
less/ast including all-shared digest IDENTICALLY to the all-specialised endpoint;
across all 208 rows, 0 errors, 0 rows with `ok !== true`, **0 rows where
`consumed !== bytes`**. Positive control: the all-specialised endpoint runs **0**
driver rows; every flip shows rows appearing with the flipped construct on top.
Mechanism control: less has no XFORM site, so `PM_MIX_DRIVER=XFORM` on less is an
all-specialised parse carrying the whole mixture cost — **+28,764 B** — and every
mixed byte count is net of that per-dialect constant.

### H. Byte savings are additive across constructs

`EXPERIMENT-mixture-sweep.md` Results 2-3. The forward sweep (flip one FROM
all-specialised) and the reverse sweep (flip one TO specialised FROM all-shared)
return **the same number for every construct, to the byte** — CHOICE 508 KB both
ways on less, SEQV 440, NODE 240. The brief predicted disagreement and there is
none. **Single flips fully determine the byte half of the curve; the greedy phase
can discover nothing about it.** Any interaction effect will be in TIME.

KB saved by sharing, net of the mechanism constant:

| construct | css | less | scss | B/driver-row (less) |
|---|---:|---:|---:|---:|
| CHOICE | 207 | **508** | 353 | 5.09 |
| SEQV | **231** | 440 | 347 | 2.83 |
| NODE | 121 | 240 | 141 | 2.29 |
| REPV | 42 | 137 | 106 | 4.58 |
| OPT | 55 | 106 | 62 | 2.52 |
| RX | 52 | 89 | 76 | 1.24 |
| SCOPE | 55 | 79 | 52 | 0.98 |
| NOT | 21 | 40 | 25 | 2.39 |
| REP | 33 | 39 | 7 | 2.26 |
| LIT | 27 | 37 | 28 | 0.83 |
| DISPATCH | 23 | 21 | 20 | **13.66** |
| GATE | 3 | 8 | 4 | 0.37 |
| FIELD | 1 | 3 | 0.4 | 0.24 |

Ranking stable across dialects. Six constructs — CHOICE, SEQV, NODE, REPV, OPT,
RX — carry **77%** of the recoverable bytes on less. `B/driver-row` separates them
by character: DISPATCH is the outlier at **13.66** (much source, few rows), while
GATE **0.37** and FIELD **0.24** mean sharing them costs interpretive work and
recovers almost nothing. **jess's density column is excluded** — its fixture
(`benchmark.jess`) is 124 B, so row counts are 1-2 and `B/row` reads in the tens
of thousands; jess's BYTE column is sound.

### I. NULLS — recorded so nobody re-chases them

**I1. Trivia scanning was never 28% of parse time.** `RESULT-capoff-trivia-scanner-is-a-null.md`.
Change measured: `bccc32f` against `6bc265f`, one file (`src/combinators/trivia-skip.ts`).
Protocol: `bench/jess/fixture.ts`, one directory, git-toggled by SHA between legs,
3 interleaved base/fix rounds × 2 dialects = **12 load-gated legs**; each leg waits
for the 1-minute load average to fall under 4 before starting; no leg `PM_FORCE`d;
every leg reported three-way agreement YES.

| fixture / engine | delta | base-spread |
|---|---:|---:|
| benchmark.css / assembler | −0.2% | 5.5% |
| benchmark.css / interpreter | −2.1% | 3.6% |
| benchmark.less / assembler | +0.7% | 2.4% |
| benchmark.less / interpreter | −0.7% | 4.2% |
| gen-workload.less / assembler | +0.7% | 2.0% |
| gen-workload.less / interpreter | +0.2% | 2.0% |

**Every delta is inside its own base-to-base spread and the signs are inconsistent
across dialects.** The change is *not* inert: it flips `triviaScanLowered` from
`[false,false,false,false]` to `[true,true,true,true]` for every dialect —
verified in the emitted table, not inferred — so every trivia gap stops going
through the per-character labelled classifier and starts going through a fused
scanner. **The work was provably removed and the parse did not move.** Therefore
the coarse-interval sampled self-time attribution that produced "28%" is wrong by
**more than an order of magnitude**. Not an allocation fix either: `--trace-gc`
css 34.68 → 34.29 MB/parse, less 64.48 → 64.56.

> Method note worth keeping: at 10 legs the css assembler read −3.0% and looked
> like a small win. The third base reading (13.08) widened the base spread to 5.5%
> and the delta collapsed to −0.2%. **An A/B stopped at two rounds would have
> published a 3% improvement that does not exist.**

> **THREE-WAY LIVE DISAGREEMENT ON THIS NUMBER. Recorded, not smoothed.**
>
> - `RESULT-capoff-trivia-scanner-is-a-null.md:43` — **measured null**, 12
>   load-gated legs, the attribution "wrong by more than an order of magnitude".
> - `EXPERIMENT-mixture-sweep.md:188` still reasons from "~28% self-time in
>   trivia" as a denominator ("capoff's real fix moves the total every
>   construct's marginal value is expressed against, so the ranking may
>   reorder"). I1 refutes that premise, so the mixture ranking's stated reason to
>   re-take the top configs after capoff lands is **void** — the ranking itself
>   is a byte ranking and is unaffected.
> - `DESIGN-piece-library.md:1034-1036` is worse: it not only repeats
>   **27.5–28.4%** (per `lane/emitprofile`) but **affirmatively re-endorses it** —
>   "a figure that **stands** — the staleness caveat I attached to it in an earlier
>   revision is retracted at §1, M-5". **That retraction pointer does not support
>   the retraction:** §1/M-5 is the inlining-budget section and contains nothing
>   about trivia. That file's §9.6 (the `ScanShape` genericity self-doubt, U-51
>   below) is built on the 28% figure and inherits its weakness.
> - `RELEASE-0.48-TARGET.md:88-89` carries a **third, much smaller** number for
>   the same path: "The trivia scanner profiled at ~7.3% of parse self-time and was
>   worth ~3.4%."
>
> Four documents, three numbers, one measured null. **Do not transcribe
> 27.5–28.4% anywhere.** Only the capoff null is a controlled measurement of the
> work actually being removed.
>
> **Transcription trap, flagged because the digits collide.** `EXPERIMENT-wiring.md:115`
> reports graphql at **28.4%** *over-460 pieces*. That is numerically identical to
> the disputed 28.4% *trivia self-time* and is a completely different quantity.

**I2. CAP_ON site labels cost nothing.** `FINDING-rawchildren-collector-is-unread-in-ast.md`.
Forcing `CAP_OFF` everywhere emits **byte-identical source** — css/ast is
**1,049,296 bytes either way** — because `skipFor()` only consults `l.cap` when
`hasScan` is true (`emit-assembly.ts:508`) and `triviaScan` was null in every slot
of every grammar on base. Confirmed independently by `exp/mixture` on all four
dialects. Actual CAP_ON share (`notes/results/mixture-shape.jsonl`, `ast` variant):
**css 0.9%** (11 of 1,265 sites), **less 5.3%** (117 of 2,220), **scss 0%**,
**jess 0%**. Under the `cst` variant the same census reads 54.6 / 66.9 / 61.4 /
63.3% — so any circulated high CAP_ON figure is a `cst`-variant number being
quoted against an `ast` parse.

> **Unverified relay.** The brief that commissioned this consolidation states the
> circulated 74%/84% figure was "the `buf` rollback share". **No committed
> artifact in `notes/` states 74% or 84% for anything**, so that attribution is
> recorded here as an unsourced claim, not as a fact. What the artifacts do say
> about `buf`: it is **not** the wrong axis either — `buf: true` selects the
> *cheap* mark (five unconditional loads, against a three-way discriminating chain
> for `buf: false`), so eliding it would be **slower**.

**I3. Deopts, body size and GC are all ruled out** as explanations for the
emitted-engine gap. Deopts: constant at 2 per run at every N in both shape regimes
(cliff §8). Body size: `seq.parse` 248 B / `choice.parse` 213 B / `many.parse`
263 B, all under 460 (cliff §5b). GC: allocation per parse, `--trace-gc` byte
deltas, `benchmark.css`, 100 parses — `90e115c9` 34.78 MB vs `6bc265f` 34.68 MB,
a 0.3% difference, so it is also **not** an artefact of the pre-`09f3452`
stale-assembly defect.

**I4. 46.3 / 26.8 MB/parse DOES NOT REPRODUCE.** The widely-relayed figures of
46.3 MB/parse (HEAD) vs 26.8 (0.46) do not reproduce. The controlled figure with
provenance is **34.7 MB/parse on `6bc265f`** (precisely 34.68), stated with its
fixture, size, warmup count, parse count, and the `ok`/`consumed` totals that
prove every parse in the window actually parsed. Do not carry 46.3/26.8 forward.

**I5. The 2.0–2.3× table-vs-codegen figure is UNEXAMINED — neither confirmed nor
refuted.** Two lanes challenged it and both retracted. Do not record it as either.
What is established instead: `fixture.ts`'s columns are **mislabelled** — the
"codegen" column is the pm-macro leg resolving to `src/table/index.ts:28`
(`assembledRules`, i.e. the shipped ASSEMBLER), and the "table" column is a direct
`src/table/exec.ts` import (the reference INTERPRETER, which `src/table/index.ts:24-26`
states is "not on the product path"). `src/compiler/codegen.ts` was deleted in
`37c57b5`. **The 1.61–1.63× this harness prints is a ratio between two mislabelled
columns and must not be quoted against 2.0–2.3×.** An earlier draft blamed the
composition tax for the cross-harness gap; that was wrong and the same run's data
refutes it (dropping the interpreter leg moved the assembler −1.5% on css and
+7.0% on less — not −24%, and not consistently signed).

> **A partial provenance for 2.0–2.3× DOES exist and must be recorded, because it
> narrows what "unexamined" means.** `DESIGN-piece-library.md:39-42` disqualifies
> two endpoints up front: "the fully abstract closure table (2.0–2.3× slower,
> **remeasured by `lane/emitprofile` at `c274a04`**)" and fully inline codegen
> (`example/css` 224,100 B). So the figure has *an* attribution — to the fully
> abstract **closure table**, not to `src/compiler/codegen.ts`, which was deleted
> in `37c57b5` and against which the "table vs codegen" framing is meaningless at
> this SHA. Two lanes then challenged the figure and both retracted. **Net: the
> figure is not free-floating, but neither is it confirmed, and the two artifacts
> it is quoted about are not the two artifacts it was measured on.** Record it as
> neither confirmed nor refuted; state which two artifacts you mean before quoting
> it. See U-45.
>
> Related, and separately unsourced: `RELEASE-0.48-TARGET.md:56` retracts
> **1.66×** outright ("has no surviving provenance. No fixture run, no commit, no
> harness is recorded for it anywhere in this repo"), and retracts the per-piece
> **48 ns / 28 ns / 20 ns** claims the same way. Its own replacement measurement
> (`bench/jess/ab.ts`, anchor `a5dc9bd`, `benchmark.less` 106,802 B, 17.40 ms vs
> 38.65 ms) reads **2.221×** — for HEAD vs 0.46, which is again a different
> comparison from either of the above.

### J. The shipping artifact is ~29% slower than the same engine over the interpreted fuse

`lane/linker-engine` `249cbd9`, reported in `RESULT-capoff-trivia-scanner-is-a-null.md`.
Both built in one process, same grammar, same 278 rules, identical tree, identical
106,802 bytes consumed, `benchmark.less`:

| leg | run 1 | run 2 |
|---|---:|---:|
| `assembled` (interpreted fuse, `grammars.ts:75-85`) | 28.03 ms | 27.65 ms |
| macro artifact (SHIPPED, `import('pm-macro:…')`) | 36.05 ms | 35.91 ms |
| ratio | 1.286× | 1.299× |
| macro wins | 0/16 | 0/16 |
| CONTROL assembled/assembled | 1.8% | −0.1% |

The two harnesses were never in conflict — **they measure different artifacts**.
This is a real defect on the path every consumer ships, not a measurement
artefact, and it is why the capoff assembler leg reads 33.5–34.3 ms where
`g5-ms.ts` reads 27.3. Also established on the way: `fixture.ts` shows **no
`interleave()` order effect** (21 CONTROL table/table rows span −1.5% to +1.9%,
centred on zero), so `g5-ms.ts`'s +12–15% comes from that file's contest wiring,
not the shared `ab-harness.ts`.

### K. Bearing on the jess author-reducer gap (1.30–1.32×, identical source, two engines)

`EXPERIMENT-inlining-cliff.md` "Bearing on…". The two candidate explanations were
"more calls" and "worse IC feedback". Priced:

| effect | measured ratio |
|---|---|
| one extra monomorphic call layer | 1.02× (seq) – 1.33× (choice) |
| mono → megamorphic on an otherwise identical body | 1.19× (choice) – 1.28× (many) |
| one callee → two executed callees at a site | 1.03× (seq) – 1.38× (choice/many) |
| callee crossing 460 B of bytecode | 1.23× (seq) – 1.53× (choice) |

**Worse IC feedback is sufficient on its own. Extra calls are not required to
explain 1.30–1.32×.** The discriminating test is cheap and deterministic — see
untried U-36.

### N. **THE ENGINE TOKEN IN THIS REPO'S RESULTS DOES NOT MEAN WHAT IT SAYS**

`lane/name-collision` (`origin/lane/name-collision` `7f954af`, **not yet merged
into `release/0.47.0`**). This is the widest-blast-radius finding of the batch and
it governs how every other number in the repo may be read.

- **11 of 29 bench harnesses are mislabelled.**
- **39,718 records in `notes/results/parse-consumed.jsonl` are tagged
  `"engine":"table"` and are actually the reference INTERPRETER.** Verified
  independently in this tree at `67478722`: the file's 87,947 rows split
  `table` **39,718** / `interpreted` 34,044 / `assembled` 11,348 / `compiled`
  2,837.
- **The README legend omitted `assembled` entirely** — so the one token that names
  the shipping engine was not in the key. Each harness now carries an
  engine-token legend on that lane.

This is the same defect as fact I5, at scale: `tableRules` names two different
engines depending on import path, with the same type signature
(`src/table/index.ts:28` exports `assembledRules as tableRules`, while
`exec.ts`'s own `tableRules` is the reference driver). `7f954af` retires the
collision — `exec.ts` exports `execRules`.

**Published figures carrying the same mislabelling — DO NOT PROPAGATE:**

- `CHANGELOG.md:756-762` — the "Absolute parse times on the canonical fixtures"
  table, whose columns read **codegen / table / interpreter**. Present in this
  tree at `67478722` and *uncorrected here*; the correction banner lives on
  `lane/name-collision`. Per fact I5 the "codegen" column is the shipped
  **assembler** and the "table" column is the reference **interpreter**, so the
  headline `benchmark.less` row (17.41 / 46.86 / 99.68 ms) does not say what its
  header says.
- `docs/design/canonical-fixture-benchmark.md` — same mislabelling, same banner.

> **Standing rule for anything added to this file from here on: name the ENGINE
> and cite the harness, not the column header.** A figure whose engine is
> identified only by the token `table` is unusable until the harness is checked.
> The three engines are: reference interpreter (`src/table/exec.ts`), assembler
> over the interpreted fuse (`assembledRules`), and the macro-fused shipping
> artifact (`import('pm-macro:…')`) — and fact J measures a **~29% gap between the
> last two**, so conflating any pair of them is a real error, not a naming nit.

### L. The decision procedure that survives — D0…D5, with D6 and D7 REMOVED

`DESIGN-piece-library.md` §2 states the piece-library decision procedure. The
cliff and wiring lanes reordered it and deleted two steps. Recording the current
shape here so nobody designs against the old one:

| step | question | status after the batch |
|---|---|---|
| **D0** | Is the body under ~448 bytes of bytecode? | **Promoted to first, and it gates everything after it.** "Size is now D0." |
| **D1** | Does anything vary between sites other than *bound data*? | A closed-over primitive or object reference does not enter any call site's feedback. **The single largest source of reuse, and it costs nothing.** |
| **D2** | Does the site's child slot see more than one callee FunctionLiteral? | Count **kinds, not sites** — `OP_SCOPE` covering 1,331 sites is one kind and costs nothing. One → share, and the callee inlines. |
| **D3** | If D2 fired, is the site hot? | Census instrument exists (`bench/table-opcode-gaps.ts`, `PM_TABLE_COUNT=1`); for json, 43% of executions land on 11 `OP_LIT` rows. **The threshold is open — see U-46.** |
| **D4 / D4b** | Can the child be pasted instead of specialised, and does pasting cross 448 B? | D4 is **bounded by D0**: paste while the result stays under 448, and stop. "**The budget is 448 bytes of bytecode, not a node count**" — the correction to codegen's `INLINE_MAX_NODES = 1000`, the policy that produced the 17.4 KB bodies. |
| **D5** | Otherwise specialise the parent by that slot's child kind | **"The weakest step in this procedure and may be net-negative on real grammars."** It spends size budget on pieces already at the limit: recovers the child's inlining, can lose the parent's. Apply only after D0 says the parent has room; prefer D4/splitting wherever both apply. |
| **D6** | ~~460–4,600 dead zone~~ | **REMOVED.** The zone does not exist (fact B). Its live content is now D0. |
| **D7** | ~~per-site monomorphic wrapper~~ | **REMOVED.** Refuted from two independent directions (fact F). "I proposed it as 'the cheap 80%-solution for the long tail'; it is neither cheap nor a solution." |

The law the batch establishes, stated as one sentence:

> **A call site inlines iff the callee's bytecode is under ~460 bytes AND exactly
> one FunctionLiteral is *executed* there AND the receiver carries no more than
> four distinct hidden classes. Closure count does not matter. Wiring does not
> matter. Bound data does not matter.**

The two IC axes are independent: the **call** axis is binary (mono vs many,
stepping at the second executed callee) and the **map** axis is the classic 4-wide
one (stepping at the fifth receiver map). And the reusable one-liner:
**closures do not count, FunctionLiterals do** — 64 closures of one literal
inline; 2 closures of two literals do not. *Sharing a piece across sites is what
makes the call site monomorphic.* **The superseded design read `kManyClosures` as
the defect when it is the cure.**

> Two probes, two closure counts, no conflict: `design/balance`'s `probe/cliff.mjs`
> swept to **N=64**, `exp/cliff` swept to **N=40** on real-scale bodies with the
> 3.7% A/A floor and the `%DebugPrint` address-equality control. Both report
> inlining at every N.

### M. Option-invariance collapses with each option set added — the reusable lesson

`DESIGN-piece-library.md` §5.3–§5.3b reconciles its own 89% against
`exp/wiring`'s 39–48% and shows **both are right, because they are different
quantities**. `probe/bodyshare.mjs` / `invariant-fraction.mjs`, `example/css`
(163 bodies) and `example/json` (37 bodies):

| comparison | css | json |
|---|---:|---:|
| k0↔k1 **pairwise** (`hostCst` only) | **145/163 (89.0%)** | 37/37 (100.0%) |
| k0,k1,k2,k3 — 4 sets, **n-way** | 55/163 (**33.7%**) | 19/37 (**51.4%**) |
| k0..k4 — 5 sets, **n-way** | 13/163 (8.0%) | 11/37 (29.7%) |

The 89% is the *pairwise* figure and is the right one **only** because the shipped
set is two (CLI `k0`, language service `k0+k1`), where n-way and pairwise
coincide. The general shape:

> **Invariance collapses fast with each option set added — 89% → 33.7% → 8.0% on
> css. Any argument of the form "most bodies are option-invariant, so
> overgeneration is cheap" is only true for a small shipped set and must name the
> set.**

Corresponding byte estimates, and the ratchet consequence: css one option set
155,076 B; two sets deduped 178,791 B (**+15.3%**); **four sets 365,795 B
(+136%)** against 620,304 naive — dedup still saves 41%. With D3's hot-only split
at H-2's assumed 40–60% of sites, Tier G lands at roughly 0.4–0.6× of that
(css 62,000–107,000 B). **Stated as a range because H-2 is unmeasured:**
`example/css` **62,000–179,000 B**, `bytesRatio` **6.4–18.4**. The size gate's
ceiling is 10 with `RATCHET_SLACK_PCT` 0.1 and no headroom by design, so **the
ceiling is crossed across most of that range and `bench/size-baseline.json` needs
a deliberate committed re-cut with owner sign-off.** Every figure in that section
is a *pre*-sharing number — fact D's −25.2% is a downward lever not yet applied to
it.

> **Internal inconsistency in the source, recorded not smoothed.**
> `DESIGN-piece-library.md:613` computes `bytesRatio` = 155,076 / **9,715** ≈ 16.0,
> while its own §5.2 table at `:548` gives `example/css` table data as **9,229 B**.
> The two denominators differ and the file does not reconcile them. Both are
> recorded; neither is corrected here.

Size endpoints for context (`probe/emitsize.mjs`, Node v24.11.1):
`example/json` table data 1,336 B → emitted 24,782 B (0.46 codegen 15,138 B,
**1.64×**); `example/css` 9,229 B → 155,076 B (codegen 224,100 B, **0.69×**). So
full per-site emission is already **below** codegen on css and above it on json.
**The size endpoint is not a wall; 0.46 already shipped 43.9 MB across the same 16
modules and it went out.**

---

## 2026-08-07 — UNTRIED items generated by the measurement batch

`UNMEASURED` unless marked otherwise. Each carries what is known and what is not.

### U-31. Decompose emitted bodies toward the 460 B budget, as a first-class lowering goal — `UNMEASURED`

**Known:** 460 bytecode bytes is a hard per-callee cliff (fact B), causally
proved by moving the flag; 16.6–28.4% of real pieces are already past it and they
are precisely the composites; crossing costs +23–53% on modelled pieces;
shrinking bodies back under it demonstrably restores inlining (fact D, 19 → 22).
Practical source-byte ceiling ≈ 1,400 B at the observed ~3:1 ratio.
**Unmeasured:** everything about the lowering itself — whether a composite body
*can* be decomposed under 460 without adding a shared indirection layer (which
fact C says would cost the callers their inlining anyway), what the decomposition
rule is, and what any of it is worth in wall-clock. This is the largest lever the
batch identified and it has no implementation.

### U-32. Targeted overgeneration — emit variants only for the bodies an option MOVES — `QUEUED`

**Known:** +30.5% (json) / +55.1% (graphql) / +47.1% (less) against naive
+87.2/+96.3/+97.3%, for the same zero runtime cost and the same parse; the
overgenerated module was built and run, not modelled; 39–48% of bodies are
option-invariant (fact E). **Unmeasured:** only the `trackLines` axis was aligned
site-for-site. `hostCst`, and the interaction when two or more options
overgenerate together, are uncosted. Also unmeasured: whether the alignment
procedure that identifies "movers" is cheap enough to run at macro time.

### U-33. Partial sharing beyond the CST snapshot prologue — `QUEUED`

**Known:** the one measured instance is −25.2% bytes on json with *more* inlining
(22 vs 19) and an identical parse (fact D). The soundness criterion already exists
in the tree — `emit-assembly.ts`: a shared emitted-scope helper is sound exactly
when it takes no piece as an argument — and it is a decomposition rule that
nothing had applied below whole-piece granularity. **Unmeasured:** every other
piece-free fragment. Nobody has enumerated what else qualifies. No wall-clock
number exists for even the measured instance, and the json-only scope means the
−25.2% may not hold on css/less/graphql.

### U-34. `rawChildren` elision — needs a 7th `OP_NODE` flag bit — `QUEUED`

Full write-up: `notes/FINDING-rawchildren-collector-is-unread-in-ast.md`.
**Known:** an AST parse maintains two parallel child collectors per node;
`rawChildren` can only be read by a CST host or a build reducer declaring a 4th
formal parameter, and **neither exists in an `ast` parse of any of the four
shipping grammars**. It is still filled (`_pushLeafBuf`, `emit-assembly.ts:133-142`),
still marked (`emitMark(buf:true)` reads both lengths, `:233-238`) and still
truncated on rollback (`_rbBuf`, `:160-181`). Emitted site counts, css/ast:
`_pushLeafBuf` 206, `_rbBuf` 678, `_accSet` 749. The oracle
`buildReadsRaw` (`src/compiler/build-arity.ts:309`) is **exported and never called
anywhere in `src/`** — as is `buildReadsChildren` (`:301`) — while its three
siblings are wired at `encode.ts:1008-1010`. The flag word at `encode.ts:1014-1019`
derives six bits and **there is no bit for raw**, which is why the question is
never asked. Cost of a fix: the 7th bit plus `emit-assembly.ts` (`_pushLeafNoRaw`,
four-slot `emitMark`/`_rbBuf`) plus the `assemble.ts` and `exec.ts` twins.
**Unmeasured, and two caveats that must not be dropped:** (1) the arity walker
(`bench/jess/capoff-rawcensus.ts`) **under-reaches** — 7 defs for css against 131
`OP_NODE` sites, 5 for less against 259 — so treat "every def has confirmed arity
≤ 3" as a strong indication, not a census; a real fix must derive the bit in
`encode.ts` where every def is seen by construction. (2) The change touches the
`OP_NODE` flag word, which participates in the **assembly key**. That is why it
was scoped out of 0.47.

### U-35. Finish the seven-wiring byte table on css and graphql — `QUEUED`

**Known:** the table exists for `json/document` only. The css and graphql legs
were RUNNING and were **killed deliberately, not because they failed** — the box
reached loadavg 20 while another lane held the timing floor. Nothing about the
instrument changed. **To run:** `node --import tsx/esm bench/wiring/check.ts css/stylesheet graphql`
on a quiet box. Also outstanding: `w4`'s byte cost is json-only (§5's argument
rests on the distinct-body counts, which *are* complete).

### U-36. The discriminating test for the jess author-reducer gap — `QUEUED`, cheap and deterministic

**Known:** fact K prices all four candidate mechanisms; worse IC feedback alone
reaches 1.37–1.38×. The stated prior is that a **size threshold** is the
explanation, because it produces exactly the flat, body-independent ratio observed
(1.30–1.32×, *stable* across reducers), whereas a call-count difference would vary
with reducer complexity. **The test, in order:** (1) `%DebugPrint` the reducer body
under each engine and compare the Call-slot IC state — MONOMORPHIC under one and
POLYMORPHIC under the other means the emitted engine instantiates the reducer at
2+ sites where the other does at 1; (2) read the reducer's `BytecodeArray` length
under each engine — one side under 460 and the other over is 1.23–1.53× and needs
no further explanation; (3) only if both come back identical is "more calls" live,
and then an invocation counter settles it. **Unmeasured:** all three steps. No
timing required for (1) or (2).

### U-37. Confirm the cliff on real emitted `_pf` bodies — `QUEUED`

**Known:** everything in fact A is on **modelled** pieces, swept 70 B to 52,188 B,
which straddles the whole real range. Fact B's real-piece leg (wiring §1-§2)
confirms the 460 threshold on real pieces but not the N-axis or the map-count
axis. **Unmeasured:** the N=2 call cliff and the N=5 map cliff on real bodies.
Note the size axis makes this the *least* likely result to change: real bodies sit
far past 460, entirely inside the not-inlined plateau.

### U-38. The one owed cliff timing: the `shared` arm's throughput — `QUEUED`

**Known:** the trace says `shared` (one literal, **zero** generated bytes) is
inlined into `benchRound` exactly as `none` is. The lane states a scoreable
**prediction**: `shared` ≈ `none` ≈ **91 ns/op**. It was deferred because the box
was loaded. **Either outcome leaves D7 with nothing** — if `shared` is fast, a
zero-byte shared trampoline buys the same thing; if `shared` is slow, per-site
bodies "help" only by defeating inlining into a caller, which is a cost in any
real caller. Also still owed by that lane: the mechanism behind `many`'s wrapper
recovery.

### U-39. The time axis of the mixture Pareto curve — `QUEUED`

**Known:** the byte axis is complete and, per fact H, **fully determined by single
flips**. **Unmeasured:** ns/parse, entirely — every row carries `timing: null`.
Any interaction effect this sweep can find is in TIME. The mixture lane states
three predictions the curve will confirm or refute explicitly: (1) shared-driver
wins where a slot sees one callee kind and loses where a parent dispatches to
several, with NODE (718 sites, 10.9%) the sharpest test; (2) `OVR`'s array
indirection should NOT be visible (fact C); (3) sharing may win MORE than (1)
implies, because specialisation spends body size on exactly the composites already
at the ceiling (fact B).

### U-40. Rename `fixture.ts`'s mislabelled engine columns — `QUEUED`

**Known:** "codegen" is the shipped assembler and "table" is the reference
interpreter (fact I5). It was recommended as a separate follow-up rather than
landed with the capoff fix **because changing those column names changes what
every published figure in this release cycle means.** **Unmeasured:** nothing to
measure; this is a correctness-of-reporting change with a documentation blast
radius.

### U-41. The ~29% shipping-artifact gap — `UNMEASURED` cause, confirmed effect

**Known:** fact J — 1.286×/1.299×, macro wins 0/16 in both runs, control clean,
identical tree and identical consumed bytes. **Unmeasured:** the cause. It is a
real defect on the path every consumer ships and nothing in this batch explains
it. Facts I3 (deopts / body size / GC) rule out three candidate explanations;
facts A/B name the live ones.

### U-42. `grammar.ts:103` reads `opts.trackLines ?? _ctx?.trackLines` on scope entry, mid-parse — `UNMEASURED`

An option-shaped consult on the parse path. Named as still-open by
`EXPERIMENT-wiring.md` §7 and not fixed there. Directly adjacent to U-32: an
option consulted at parse time is an option that could instead have been resolved
into which body the site got.

### U-43. The emitted sequence-term prologue branches on `ctx.trivia === undefined` **per term**, inside the piece body — `UNMEASURED`

Found while reading the emitted json text; **not investigated**. Another
option-shaped consult on the parse path, and one that `§10.5`'s `forCtx` write-up
does not mention. Note this is the *same* prologue that U-33 shares — the two
interact.

### U-44. Print per-site named function declarations at macro time; retire `assemble.ts:2550`'s `new Function` — `QUEUED`

**Known — this is what the wiring sweep says the macro should emit:**
(1) direct hoisted names, because the wiring spelling is free (fact C) and that is
what `emit-assembly.ts` already prints, leaving run-start to LINK and do nothing
else; (2) **never** route calls through a shared dispatcher; (3) treat 460
bytecode bytes as a hard per-piece budget; (4) overgenerate only the bodies an
option MOVES; (5) share the option-invariant, piece-free prologues.
**Unmeasured:** the sweep reached this through `new Function`, which is the
*measurement vehicle, not the proposal*. **This sweep says WHAT the macro should
print; it does not print it.** No wall-clock number anywhere backs the §6 ranking
— it is an inlining and byte-count ranking, and whether −25.2% bytes and +3
inlined pieces is worth milliseconds is unmeasured.

### U-45. Settle the 2.0–2.3× table-vs-codegen figure — `UNMEASURED`

Per fact I5 it is neither confirmed nor refuted, two lanes retracted, and the axis
as originally stated **does not exist at this SHA** (`src/compiler/codegen.ts` was
deleted in `37c57b5`; what exists is shared-driver `exec.ts` vs specialised
`assemble.ts`+`emit-assembly.ts`, which are the same engine either side of a
codegen step). Settling it therefore requires first stating which two artifacts
the figure was ever about. Do not quote it in either direction until then.

### U-46. H-2 — the D3 hot-site fraction. **The load-bearing unknown.** — `UNMEASURED`

`DESIGN-piece-library.md` §9.1 names this itself: *"H-2, the D3 hot-site fraction,
is the load-bearing unknown and I have not measured it. Every byte number in §5.4
is a function of it, and my basis is one census on one grammar (json's
43%-on-11-rows) generalised to four."* **Hypothesis:** a D3 threshold covering
~90% of executed rows emits **40–60%** of sites, not 100%. **Falsified if** the
execution histogram on jess's grammars is flat enough that 90% coverage needs
>80% of sites — in which case Tier G is effectively "all sites", fact M's byte
answer goes to its top end (155–179 KB per css-sized grammar), and the ratchet
conversation is larger than the design implies. **`exp/mixture`'s Pareto curve
measures this directly and should be read before anything is built** (so U-39
gates this).

### U-47. H-5's separating experiment — pad the wrapper past 460 B — `UNMEASURED`

The `many` wrapper recovery (91.09 → 65.61, below even the identical-map 70.17)
has two candidate mechanisms and the design lane owns explaining it.
**The experiment:** pad the wrapper past 460 B. Under mechanism (i) recovery must
**vanish entirely**, because an un-inlinable wrapper cannot hoist anything; under
(ii) it must **largely survive**, because the megamorphic load is eliminated
whether or not the wrapper inlines. One config on an existing harness. **A second,
cheaper check that discriminates the same way:** vary `many`'s iteration count —
both mechanisms predict recovery scales with it, so a **flat** result falsifies
both and means neither explanation is right. **A third, currently unmeasured
prediction that falls out:** `seq` at high arity should begin to recover, since
many terms per call is the same multiplication by another name; if it does not,
the loop is doing something neither mechanism captures. Note fact F already traces
the *benchmark-driver* explanation for this anomaly — these three tests
discriminate the residual mechanism, they do not reopen D7.

### U-48. The ten-line falsifier that should run before any `rawChildren` encoder work — `QUEUED`

H-4, stated with its falsifier: eliding the `raw` collector removes a measurable
share of the 34.68 MB/parse allocation and of the CST-capture self-time.
**Falsified if** a build with `_pushLeafBuf`'s raw arm **stubbed out** shows no
allocation delta on css `benchmark.css` under capoff's protocol — which would mean
the pair is being optimised away already and the cost is elsewhere. **That stub is
a ten-line change and settles it before any encoder work starts.** U-34's
dead-ness has been verified **statically**; it has **not been priced**. Run this
first.

### U-49. The no-`new Function` dynamic gate — does not exist, and is red on HEAD by design — `QUEUED`

`DESIGN-piece-library.md` §6.3: *"There is no such test today."* The gate is a
test that **fails on today's HEAD deliberately**, and goes green when
`assemble.ts:2536`/`:2550`'s `new Function` is deleted. It is the enforcement
half of U-44 and belongs to `lane/no-new-function`. The illustrative shape is in
the design note, marked "Shape of the gate, not final code".

### U-50. Two mechanical sync guards between the emitter and the opcode set — `UNMEASURED`

**Known:** the emitter's `lower()` has **31 `case OP_*` labels** against
`assemble.ts`'s **40** — a nine-opcode drift that nothing detects.
**Proposed, not built:** (1) a **totality check** — for every `OP_*` in `ops.ts`,
either `emit-assembly.ts` has a case or `OP_NAMES` marks it Tier-S-only, and a new
opcode with neither fails the build; (2) reuse the **existing differential** as
Tier G vs Tier S over the same table. Neither is costed.

### U-51. §4.4's `ScanShape` fallback is not a settled genericity call — `UNMEASURED`

`DESIGN-piece-library.md` §9.6, verbatim: *"this is where I am least comfortable
calling something 'correct genericity'."* Saying "cold sites get the slow shape" is
only safe **if trivia sites are cold, and that has not been established**. If
trivia scanning is hot everywhere, §4.4 is a **deferred defect**, not a design
call, and D3's threshold must be set by execution count on the trivia path
specifically. **The input that settles it** is `lane/capoff`'s dump of the
actually-emitted trivia-skip functions. **Caution:** the reasoning in §9.6 rests
on the 27.5–28.4% trivia self-time figure that fact I1 refutes, so the question is
live but its stated framing is not.

### U-52. `INV-6` — 57 config reads inside piece-internal bodies that the invariant checker reports as 0 — `QUEUED`

**Known:** `lane/no-new-function`'s `inv6x.mjs` found **57** config reads inside
piece-internal bodies while `check-invariants.mjs` reports **0**. The checker and
the reality disagree, which makes every "no config read on the run path" claim
unverified. Related and already located: `forCtx` (`src/table/assemble.ts:2672`)
reads five `ctx` fields **per parse**, and its own comment concedes it is "THE ONLY
CONFIG READ ON THE RUN PATH" — but the criterion says *none*. **Unmeasured:** its
cost, which is once-per-parse and therefore probably small; the issue is the
invariant, not the nanoseconds. `DESIGN-piece-library.md` §9.8 states plainly that
`lane/no-new-function` should land before anything in the piece-library design is
built on: the corrected `INV-6` is the instrument that enumerates what a
structure-only read of `assemble.ts` missed (2,731 lines; `OP_CHOICE`, `OP_REP`,
`OP_NODE` known only by their closure-minting counts).

### U-53. Recover the literal / regex / trivia fast paths deleted at the 0.47 cutover — `QUEUED`

`RELEASE-0.48-TARGET.md` §9, and it is filed there as **"an LLM oversight, not a
decision"**: retiring the literal- and regex-recognition optimisations "was a
non-goal, and was never agreed to. It happened anyway."
`src/compiler/codegen.ts`, `src/compiler/trivia-fast-path.ts` (296 lines) and
`src/compiler/scannable-run.ts` (1,627 lines) were deleted; **recovery point
`3d4dac6`**. The 0.48 instruction is to take whatever was valuable out of these
modules when token streaming lands. **This is why `CODEGEN-FAST-PATHS.md`
describes an engine that no longer ships** — see that file's header.

### U-54. The three silent-wrong-output surfaces, ungated — `UNMEASURED`

`DESIGN-piece-library.md` §9.7 names `OP_ADJ` (§4.5), capture-reachability, and
the site-attribute record as **the three places the design can produce silently
wrong output** rather than a slow parse. They are the ones to gate hardest, and
the gate must be **whole-object comparison against the interpreter**
(`test/parity/helpers/engine-parity.ts`), *not* a field checklist — which is how
the `sepBy trailing:'require'` divergence got through. Nothing is built.

### U-55. `expected` is not in the identity digest — `QUEUED`

`RELEASE-0.48-TARGET.md`'s standing-hazard rider: **six** divergences hid behind
this during 0.47. A gate defect, currently unassigned.

---

## Untried index (`QUEUED` + `UNMEASURED`)

**61 items — 27 `QUEUED`, 34 `UNMEASURED`.** The count at the top of this file is
this table's length. U-01…U-30 are the pre-existing backlog; U-31…U-56 came out
of the 2026-08 measurement batch; U-57…U-61 are the radical macro-runtime
programs selected on 2026-08-25. Nothing is counted twice: an item whose
siblings landed appears here once, for its unlanded part only.

| # | item | marker |
|---|---|---|
| U-01 | P0 §1 — `none` and `gaps` root-trivia policies (`allEntries`/`selectedKinds` landed in 0.44.0) | `QUEUED` |
| U-02 | P0 §4 — kind-query postings index instead of a repeated full gap scan | `UNMEASURED` |
| U-03 | P0 §5 — split "need a gap" from "need every trivia token" in host contracts | `UNMEASURED` |
| U-04 | P0 §6 — stop allocating the empty root sink and empty index | `UNMEASURED` |
| U-05 | P0 §8 — typed-buffer (`Uint32Array`) alternative, last and only as an implementation detail | `UNMEASURED` |
| U-06 | §2 — compile-time transparent-wrapper elimination when `buildSrc` is `(c) => c[0]` | `UNMEASURED` |
| U-07 | §4 — inline transforms whose body references outer scope or non-destructure params | `UNMEASURED` |
| U-08 | §5 — general `buildSrc` object-literal inlining for non-`mk` grammars | `UNMEASURED` |
| U-09 | §6b — generalize the trivia fast-path to value-capturing positions | `UNMEASURED` |
| U-10 | §7 — common-prefix choice factoring, generic | `UNMEASURED` |
| U-11 | §7a — factor `Dimension`/`Num` into one numeric node (grammar-side; verified 2026-07-16) | `QUEUED` |
| U-12 | §7b — partial first-char choice dispatch (switch + fallback) | `UNMEASURED` |
| U-13 | §7c — richer dispatch structures: trie, second-char, length-switch, binary-search ranges, perfect hash | `UNMEASURED` |
| U-14 | §8d — `/i` on char classes (ASCII case-fold ranges) | `UNMEASURED` |
| U-15 | §8g — lazy-delimited `<open>[\s\S]*?<close>` | `UNMEASURED` |
| U-16 | §8h-next — Approach B: divergence-set analysis or `regexp-tree` left-factoring | `UNMEASURED` |
| U-17 | §regexp-tree — hand-rolled first-set parser, to drop `regexp-tree` for interpreter users too | `QUEUED` |
| U-18 | cleanup — `emitSkip` still uses `try/catch {}`; move to `emitFallible` | `UNMEASURED` |
| U-19 | cleanup — `withCtx`'s `{ ..._ctx, state: … }` allocates; save/restore `_ctx.state` | `UNMEASURED` |
| U-20 | cleanup — `charCodeAt` instead of `codePointAt` in disjoint dispatch when the first-set proves BMP-only | `UNMEASURED` |
| U-21 | cleanup — parallel `compile()` per rule; cache by combinator-tree hash | `UNMEASURED` |
| U-22 | #1 — lazy/scalar promotion for the *consumed-but-tiny* `many` arrays (dead-value part landed at ~7% alloc / 0% time; size expectations accordingly) | `UNMEASURED` |
| U-23 | #2 — residual intra-frame buffer-*reference* hoist (cold CST-capture path only; micro-opt) | `UNMEASURED` |
| U-24 | #4 — kill the per-node `loc` object and per-build filtered child arrays in `buildNode` | `UNMEASURED` |
| U-25 | Q-40 #1 — compile-time output-contract variants (recognizer-mode proof exists, unpublished, `c84d777`) | `QUEUED` |
| U-26 | Q-40 #4a follow-on — extend the node-frame elision to the interpreter's `node.ts` | `UNMEASURED` |
| U-27 | Q-40 #4a follow-on — the `_cstRawChildren`/`_ch`/`_raw` half, where a subtree proves no child capture | `UNMEASURED` |
| U-28 | Q-40 #5 — host-boundary allocation contract (span numbers + positional access instead of `loc` + `filter`) | `UNMEASURED` |
| U-29 | jess-host — collapse `children`/`rawChildren` when a node captures no trivia (bank as alloc/GC, not wall-clock) | `QUEUED` |
| U-30 | jess-host — `(b)` per-call-site skip-only vs skip+log | `QUEUED` |
| U-31 | decompose emitted bodies toward the 460 B budget as a first-class lowering goal | `UNMEASURED` |
| U-32 | targeted overgeneration — variants only for the bodies an option MOVES | `QUEUED` |
| U-33 | partial sharing beyond the CST snapshot prologue | `QUEUED` |
| U-34 | `rawChildren` elision — 7th `OP_NODE` flag bit | `QUEUED` |
| U-35 | finish the seven-wiring byte table on css and graphql | `QUEUED` |
| U-36 | the discriminating `%DebugPrint` / `BytecodeArray` test on the author-reducer gap | `QUEUED` |
| U-37 | confirm the cliff on real emitted `_pf` bodies | `QUEUED` |
| U-38 | the owed `shared`-arm throughput timing (prediction: ≈ 91 ns/op) | `QUEUED` |
| U-39 | the time axis of the mixture Pareto curve | `QUEUED` |
| U-40 | rename `fixture.ts`'s mislabelled engine columns | `QUEUED` |
| U-41 | the cause of the ~29% shipping-artifact gap | `UNMEASURED` |
| U-42 | `grammar.ts:103`'s mid-parse `opts.trackLines ?? _ctx?.trackLines` | `UNMEASURED` |
| U-43 | the per-term `ctx.trivia === undefined` branch inside the emitted sequence-term prologue | `UNMEASURED` |
| U-44 | print per-site named declarations at macro time; retire `assemble.ts:2550`'s `new Function` | `QUEUED` |
| U-45 | settle (or retire) the 2.0–2.3× table-vs-codegen figure | `UNMEASURED` |
| U-46 | H-2 — the D3 hot-site fraction, on jess's execution histograms (**the load-bearing unknown**) | `UNMEASURED` |
| U-47 | H-5's separating experiment — pad the wrapper past 460 B; vary `many`'s iteration count; `seq` at high arity | `UNMEASURED` |
| U-48 | stub `_pushLeafBuf`'s raw arm and price it under capoff's protocol — **run before any U-34 encoder work** | `QUEUED` |
| U-49 | the no-`new Function` dynamic gate (does not exist; red on HEAD by design) | `QUEUED` |
| U-50 | mechanical sync guards — `OP_*` totality check; Tier G vs Tier S differential (emitter has 31 cases against 40 opcodes) | `UNMEASURED` |
| U-51 | settle §4.4's `ScanShape` fallback — are trivia sites actually cold? | `UNMEASURED` |
| U-52 | `INV-6` — 57 config reads in piece-internal bodies that `check-invariants.mjs` reports as 0; plus `forCtx` at `assemble.ts:2672` | `QUEUED` |
| U-53 | recover the literal/regex/trivia fast paths deleted at the 0.47 cutover (recovery point `3d4dac6`) | `QUEUED` |
| U-54 | gate the three silent-wrong-output surfaces (`OP_ADJ`, capture-reachability, site-attribute record) by whole-object parity | `UNMEASURED` |
| U-55 | put `expected` in the identity digest (six divergences hid behind its absence during 0.47) | `QUEUED` |
| U-56 | re-tag the 39,718 mislabelled `"engine":"table"` rows in `notes/results/parse-consumed.jsonl`, and land `lane/name-collision`'s legend + the `CHANGELOG.md:756-762` / `canonical-fixture-benchmark.md` correction banners on the release tip | `QUEUED` |
| U-57 | deterministic-region fusion and size-budgeted superinstructions | `ACTIVE` (broad recursive NODE inlining rejected; leaf-local or protocol-deleting rule traces next) |
| U-58 | derived tokens as primary control-flow currency (packed route/end, no generic handoff) | `ACTIVE` |
| U-59 | bounded PEG residual/derivative decision DAG preserving ordered-choice semantics | `ACTIVE` |
| U-60 | recognition event tape followed by selective exact construction | `ACTIVE` |
| U-61 | scalar parse ABI with packed rollback/capture state | `ACTIVE` |

---

## Already landed — `LANDED` (18)

- **Flat trivia log** — `_cstTriviaLog` as `[start, end, insertIdx, …]` per trivia entry; no per-entry `CSTTrivia` objects.
- **`node()` ctx save/restore** — mutate `_ctx` fields instead of spreading a new `ParseContext` per call.
- **Fast non-capturing trivia** — `_tfN` returns a position number, not `{ ok, value, span }`.
- **Choice fast paths (non-CST)** — `greedyClassify`, `literalsLongestFirst`, disjoint first-char dispatch, `autoNot` for `firstMatch`.
- **Choice fast paths in CST grammars** — `emitGreedyClassify` / `emitLiteralsLongestFirst` with `emitLeafCapture` in capturing compiles.
- **Log-only compiled trivia capture** — merged `_tcN` into `_tfN(…, cap?)`; ~6% bootstrap4 vs duplicate-tree `_tc`.
- **Trivia loop specialization** — `trivia-fast-path.ts`: hand-rolled `charCodeAt` loop for `oneOrMore(choice(ws, blockComment))` and ASCII ws-only trivia; CSS bootstrap4 compiled **−52%** (25.8→12.3ms).
- **Transform / build inlining** — `inline-callback.ts`: paste unary and `sequence`+destructure transform bodies at call sites; GraphQL large compiled **−6%**. `inline-build.ts`: emit `mk()` CST nodes literally (CSS-neutral).
- **Labeled trivia kind capture** — `label(name, parser)` on trivia `choice` arms records per-chunk kind indices in `_triviaLog` / per-node `triviaLog`; `triviaEntries()` resolves kinds and text lazily. Interpreter + compiled parity in `test/parity/trivia-kinds.test.ts`.
- **`\s` as a fixed code-point set** — `\s`/`[\s…]` now lower to a `charCodeAt` scan (`SPACE_RANGES` next to `shorthandRanges`'s `\d`/`\w`), same as `\d`/`\w`. `\s`'s set (WhiteSpace + LineTerminator) is fixed regardless of the `u` flag, so no ambiguity guard was needed. Unblocks `lang` `\s*` trivia, `graphql` ws, and any `\s`-based `seq` (e.g. `[^)"'\s]+`-style `urlInner`). See `test/unit/scannable-regex.test.ts` (`\s+` parity + codegen-uses-scan assertion) and `test/unit/trivia-fast-path.test.ts`.
- **Recalibrated `literal()` charCodeAt/startsWith crossover (4 → 16 chars)** — `emitLit`/`emitLiteralCondition` were switching to `input.startsWith()` above 4 chars, but measurement (see below) shows the unrolled `charCodeAt` chain is actually faster or tied all the way out to ~256 chars, with `startsWith` only winning on raw runtime past ~256–512. The `4` threshold meant almost every real literal (`important`, `instanceof`, HTTP header names, …) was silently taking the slower path. Moved to `CHARCODE_CHAIN_MAX = 16` instead of raising all the way to the runtime crossover, because the unrolled chain's *generated source* grows ~4–30× faster than `startsWith`'s near-constant call site — 16 caps worst-case codegen bloat while still covering every literal that appears in this repo's example grammars (longest: `important`, 9 chars) with room to spare. See `test/unit/codegen-output.test.ts` (pins the exact 16/17-char crossover), `test/unit/macro-transform.test.ts`, `test/parity/compiler-capture-choice.test.ts`.
- **Trailing lookahead boundary guard `(?!class)`/`(?=class)`** — a token followed by a char-class lookahead lowers to a post-match `charCodeAt(end)` check (new `lookahead` `ScanShape`), unlocking `lang`'s five keyword boundaries (`if(?!\w)`, `then(?!\w)`, `else(?!\w)`, `true(?!\w)`, `false(?!\w)` — verified directly, not just by analogy). CSS `colorHex`/`Num` still fall back to `exec` since their bases need `{n,m}` bounded repeat (§8c) / groups (§8f), which don't exist yet — that's a real, expected gap, not a regression. *(Update: both landed — §8f groups and §8c bounded-repeat; CSS `colorHex` now fully lowers, this lookahead included.)* **Important correctness finding beyond the original idea write-up:** a naive "lower the inner shape, then check once" is NOT always safe when the inner shape ends in an unbounded/optional run — real backtracking can rescue a shorter match that a one-shot check would miss (verified empirically: `/^[0-9]+(?=[5-9])/.exec('12345')` returns `["1234"]`, not a total failure). Added `lookaheadUnambiguous` (mirrors `seqIsUnambiguous`'s reasoning): safe iff the inner shape's trailing backtrackable class is a **subset** of the operand (negative lookahead) or **disjoint** from it (positive lookahead); shapes with no trailing quantifier at all (pure literals, `litFold`) are unconditionally safe. `until`/`delimited`/`string`/nested-`lookahead` bases are declined outright (unmodeled backtracking semantics) rather than risk an unproven guard. Verified with 140k randomized fuzz inputs against native `RegExp` (0 mismatches) plus a deliberate bypass-the-guard case that DOES mismatch (proving the guard is load-bearing, not just defensive). See `test/unit/scannable-regex.test.ts` (`§8b` describe blocks). Closed the follow-on gap too — see the `emitKeywordsFast` entry below.
- **`keywords()`/`word()`/`makeWord()` compiled fast path (`emitKeywordsFast`)** — closes the gap the §8b lookahead work deliberately left open. Every word is a fixed literal (optionally wrapped in the shared boundary lookahead), so this reuses the exact `seq`/`litFold`/`lookahead` `ScanShape` machinery instead of building one `RegExp.exec` alternation — unconditionally ambiguity-safe, since `trailingBacktrackClass` treats a single-literal `seq`/`litFold` as fixed-length (nothing for a backtracker to shrink), so wrapping either in a lookahead is safe for ANY boundary class. Real, measured impact: GraphQL's `kw('true')`, `kw('false')`, `kw('null')`, `kw('on')`, `kw('fragment')`, and `keywords(['query','mutation','subscription'], …)` all now compile to `charCodeAt` dispatch instead of a sticky regex — confirmed directly against the real grammar (`examples/graphql/parser.ts`), not just in isolation. Declines to the regex fallback for: an empty-string keyword, a keyword containing an astral code point (same BMP-only limitation as the rest of this file — caught by fuzzing an emoji keyword, which silently failed to match before the guard was added), an unparseable boundary class, and `caseInsensitive` + a boundary together (would need ASCII-folding the boundary ranges too, i.e. the general §8d problem — left on the safe path rather than risk narrowing which chars the boundary excludes). **Bugs caught by fuzzing before landing:** (1) the first version returned the canonical keyword string as the matched value instead of `input.slice(pos, end)`, which is wrong whenever `caseInsensitive` lets the actual input differ in case from the keyword (e.g. matching `"ABC"` must return `"ABC"`, not `"abc"`) — fixed. (2) the astral-code-point gap above. Verified with 120k+ randomized fuzz inputs against native `RegExp` across keyword sets with shared prefixes (`instanceof`/`in`), case-insensitivity, and boundaries (0 mismatches after both fixes). See `test/unit/keywords.test.ts`, `test/unit/macro-transform.test.ts`.
- **Top-level alternation `A|B|C` → dispatch (§8e)** — a new `alt` `ScanShape`: split a regex source on top-level `|` (outside any `[]`/`()`, one redundant whole-string `(?:…)` wrapper stripped first so `(?:a|b)`-style patterns split too), lower each arm independently via the existing recognizers (so an arm can itself be a `seq`/`chars`/`ident`/`lookahead`/…), and decline the WHOLE alternation if any single arm doesn't lower (e.g. an arm with its own nested group — §8f). Two dispatch strategies, chosen by comparing every pair of arms' first-char sets (`shapeFirstAccept`/`classDisjoint`, reusing the same subset/disjoint math as §8b's lookahead guard): **disjoint** → an if/else-if chain keyed on each arm's first-char class, straight to the one matching arm (no ordering to preserve); **overlapping** → an ordered labeled-block trying each arm in turn, taking the first that succeeds — which is regex `|`'s ACTUAL semantics (first alternative to match at all wins on its own greedy length; verified directly against native `RegExp`, e.g. `/^a|ab/.exec('ab')` → `"a"`, not `"ab"` — it is NOT longest-match). A shape that can match empty (`[x]*` with no `+`) degrades its first-set to "any", forcing ordered dispatch rather than falsely claiming disjointness. Real motivating CSS patterns: `anyValueTok` (`[+\-*/=<>|~^]+|[^\s;{}\[\]()'",!]+` — clean 2-arm overlapping case, exercises both the literal-`|`-inside-a-bracket-class and escaped-bracket-inside-a-negated-class edges of the splitter) and `Dimension`'s trailing `-?ident|%` (clean disjoint case) both now fully lower. `basicSel`/`nth`/`numPart` correctly still decline — each has an arm with its own nested `(?:…)` group, which needs §8f too; this is an expected, documented gap, not a bug. Verified with 30k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches) across both dispatch strategies, plus full `compile()`-pipeline parity tests (interpreter vs `compile()`; macro mode blocked in this sandbox by an unrelated pre-existing `oxc-parser` native-binding issue, confirmed to affect even already-landed macro tests identically). See `test/unit/scannable-regex.test.ts` (`§8e` describe blocks).
- **Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)*`, `(?:…)+` → nested `seq` (§8f)** — a new `group` `SeqPart`: `parseSeqParts` recognizes `(?:…)` (paren-depth-tracked, bracket-classes skipped atomically), recursively lowers the body via `parseScanShape` (so a group's own content can be a `seq`, another nested group, or an alternation via §8e), and only accepts it when `groupInnerSafe` holds. **Key correctness finding:** a group's body may only be treated as an atomic "resolve once, never reconsider" unit when it's a `chars`/`ident`/`seq`/`litFold` (already proven to have exactly one valid greedy match) or a **disjoint** `alt` — a non-disjoint alt inside a group (`(?:a|ab)`) is declined outright, because real backtracking CAN switch to a different arm if something after the group fails (verified: `/^(?:a|ab)c/.exec("abc")` matches via the SECOND arm, only because the first arm's match left "c" unsatisfied — our ordered-dispatch codegen resolves once and never reconsiders, so this case is genuinely unsound to lower and must fall back to `exec`). The same hazard applies to `trailingBacktrackClass` (§8b's lookahead-composition guard), extended here to handle a trailing `group` part and a top-level `alt` shape — again requiring disjointness before trusting the wiggle-room class. **Also generalized `seqIsUnambiguous`** from "check only the immediate next sibling part" to "check against `seqFirstAccept` of everything that follows, through a chain of optionals" — needed because JSON/GraphQL's number pattern has **two consecutive** optional groups (`(?:\.\d+)?(?:[eE][+-]?\d+)?`), and the old immediate-neighbor-only rule would have rejected this chain outright even though each part is provably disjoint from everything that could follow it. This is a strict generalization (verified: every previously-accepted lit/run-only pattern still accepts, plus adversarial genuinely-ambiguous chains still correctly decline). Real, measured wins: the number pattern shared by JSON and GraphQL (`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?` and its float-arm-nested-group variant) now fully lowers to `charCodeAt` dispatch — this was previously the single largest un-lowered hot path across the example grammars — and CSS's `basicSel` (a 3-arm top-level alternation where one arm has its own optional group) now fully lowers too. CSS's `numPart`/`Num` correctly still decline *here*: their alternation's arms overlap on the leading digit class, so `groupInnerSafe` conservatively declines rather than risk the arm-switching hazard. **(Update: `numPart` now lowers — the overlapping-arm group is safe in the *trailing* position; see §8h below. `Num`'s trailing lookahead still declines.)** Verified with 40k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches, including multiple adversarial chained-optional-group and overlapping-group cases designed specifically to stress the generalized ambiguity check), full `compile()`-pipeline parity (interpreter vs `compile()`), and an end-to-end regression sweep across all 6 example grammars (json/graphql/css/lang/toml-ish/csv) confirming no behavior change outside the newly-unlocked patterns. See `test/unit/scannable-regex.test.ts` (`§8f` describe blocks).
- **Trailing non-disjoint-alt group → ordered-commit (§8h-alt)** — closes the gap the §8f entry above explicitly left open (CSS `numPart`/`Num`). A group whose body is a NON-disjoint (overlapping-arm) alternation was declined outright by `groupInnerSafe`, because ordered-choice-commit can pick a shorter arm that a continuation later rejects (`/^(?:a|ab)c/` needs the SECOND arm). **Key finding:** that hazard requires a continuation — when the group is the *trailing, matched-exactly-once* part of its `seq`, nothing follows to force an arm switch, so ordered-commit provably equals the engine. Two-part change: `groupInnerSafe` now admits a non-disjoint `alt` inner, and `seqIsUnambiguous` gates it to the trailing-once position (a trailing *optional/repeated* group, or any non-trailing one, still declines — the "drop the group" / "repeat" choices reintroduce the hazard). Also tightened `shapeFirstAccept` for `alt`: it now returns the true *union* of arm first-sets even when the arms overlap (the `disjoint` flag governs dispatch, not what the shape can start with) — needed so `numPart`'s leading `[+-]?` proves disjoint from the group's `{., digits}` first-set instead of hitting the old blanket `'any'`. This is why the CSS number token — the single biggest un-lowered value-path terminal — now fully lowers as-written (no grammar respelling). CSS `numPart` (`[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)`) is `sequence(numPart, unit)`'s first arm and is attempted on *every* numeric value, so this is a hot path. **`Num`/`numTok` (numPart + trailing `(?![a-zA-Z-￿%])`) still declines — correctly**: its lookahead genuinely needs backtracking (`/…(?!…%)/.exec("50%")` matches `"5"` via a shrunk `\d+`), which a one-pass scan can't reproduce, so `trailingBacktrackClass(number-ish trailing group)` stays `'unsupported'` and the whole lookahead declines to `exec`; the fast `numPart` scan still runs first inside `Dimension`. Verified: 371k exhaustive short-input differential (compiled scan vs native `RegExp`, 0 diffs), full suite (1248 tests) + typecheck, and a controlled A/B on the real `examples/css` grammar over `bootstrap4.css` — full compiled parse **7.31 → 6.21 ms median (~15%)** from this terminal alone. See `test/unit/scannable-regex.test.ts` (`§8h` describe blocks).
- **Non-trailing overlapping-alt groups + group trailing-exposure soundness fix (§8i)** — generalizes §8h beyond the trailing-once position, and in doing so fixes a **pre-existing §8f soundness bug** it uncovered. **The bug:** `seqIsUnambiguous` only ever checked a part's *first*-set against what follows, and only for *skippable/repeated* parts — so a **required-once** `group` whose body ends in an unbounded run, followed by a continuation that overlaps that run, was lowered but is UNSOUND. `(?:\d+)\d` on `"12"`: greedy `\d+` swallows both digits, the trailing `\d` fails, and a one-pass scan reports no-match — but the engine backtracks the run and matches `"12"`. Caught only by differencing against the **compiled** output (the interpreter trivially equals `RegExp`, which is why the earlier §8h `parse()`-based differential missed it); 189 diffs over a short-input sweep. **The fix:** a new `groupPartExposure(part)` computes a group's full right-edge exposure (its body's own trailing wiggle via `trailingBacktrackClass`, plus the drop-exposed first-set when optional/repeated), factored out of `trailingBacktrackClass`'s trailing-group branch so both sites share it. `seqIsUnambiguous` now runs this for **every** `group` part at any position: a concrete exposure class must be disjoint from `seqFirstAccept` of everything that follows (so `(?:\d+)\d` now declines; the JSON-number and CSS-`numPart` groups still lower, their digit exposure being disjoint from the `.`/`e`/unit continuations); an `'unsupported'` exposure keeps the §8h trailing-once gate. **The feature:** a non-disjoint alt whose arms are **fixed-length and pairwise mutually exclusive** (`altFixedMutuallyExclusive` / `fixedClassSeq` — no arm's match can be a prefix, proper or equal-length-overlap, of another's, so at most one arm matches any input and the group has a single fixed end) now reports `null` (no wiggle) from `trailingBacktrackClass`, so it lowers at **any** position — `(?:ab|ac)x`, `(?:foo|barn)z`, `(?:ax|ab)c`. A non-disjoint alt where one arm *is* a prefix of another (`(?:a|ab)`) is not mutually exclusive → stays `'unsupported'` → still gated to trailing-once (§8h), because the engine genuinely arm-switches when the continuation rejects the shorter match. This is the conservative Approach A from the §8h follow-up (fixed-length mutual-exclusivity, not the full prefix-language/divergence-set analysis or `regexp-tree` left-factoring of Approach B — left as future widenings). Verified: **183.7M-input** randomized-pattern differential (compiled scan vs native `RegExp`, 0 diffs across 1037 lowered `X(?:…)Y` patterns), a compiled-output exhaustive differential for `(?:ab|ac)x`, full suite (1263 tests) + typecheck, and a neutral A/B on `examples/css`/`bootstrap4.css` (off the hot path by design — `numPart` still lowers, the 4 remaining fallbacks are the pre-existing i-flag/`{n,m}`/backtracking-lookahead declines, unchanged). **Separately found (pre-existing, since fixed):** the `delimited` recognizer (`<open>(?:…)*<close>`) unsoundly shadowed any `X(?:alternation)*Y` before the seq/group path — `z(?:a|[0-2]+)*a` mis-lowered. Fixed on `release/0.14.0` (`fix(scannable): tighten delimited recognizer to block-comment idiom only`): `parseDelimited`/`delimitedBodySound` now only lower a body that provably can't contain the close (the block-comment idiom `[^l0]` / `[^l0]|l0(?!l1)`); every other `X(?:…)*Y` declines to `RegExp.exec`. Verified by a compiled-vs-native differential over a randomized `X(?:alt)*Y` family (0 diffs). See `test/unit/scannable-regex.test.ts` (`§8i` describe blocks).
- **Bounded counted repeat `{n}` / `{n,}` / `{n,m}` on a run (§8c)** — generalizes the `seq` `run` part from `min: 0|1; unbounded: boolean` to a real `min: number; max: number` (`Infinity` = unbounded), so a counted class/shorthand run lowers to a `charCodeAt` loop (`while (cnt < max && cls) { end++; cnt++ } if (cnt < min) break`) instead of `RegExp.exec`. The four legacy quantifiers map as `+`→`{1,∞}` `*`→`{0,∞}` `?`→`{0,1}` bare→`{1,1}`; the emitter is **purely additive** — existing shapes emit byte-identically (a new counted-loop branch only for finite `max ≥ 2`, and the unbounded branch's min-check generalizes from `=== s` to `- s < min` only when `min > 1`). **The soundness story is one clean predicate:** a greedy one-pass scan of a run has wiggle a backtracker could exploit **iff `max > min`** — which unifies `?`/`*`/`+` and bounded `{n,m}` (`m>n`) under the *existing* `seqIsUnambiguous` disjoint-from-continuation guard, while a **fixed** `{n}` run (`max === min`) has no wiggle and needs no guard at all (it lowers even when the next segment overlaps its class, e.g. `[0-9]{2}[0-9]`). `trailingBacktrackClass` (§8b's lookahead-composition guard) and `fixedClassSeq` (§8i's mutual-exclusivity check) both generalized the same way (wiggle ⟺ `max > min`; a `{n}` run is `n` fixed positions). **Real win:** CSS `colorHex` (`#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])`) now **fully lowers** — the `{3,8}` run *plus* its trailing negative lookahead (§8b composes automatically: the run's wiggle class `[0-9a-fA-F]` is a subset of the lookahead operand, so `lookaheadUnambiguous` proves it safe) — previously entirely on `exec`. The isolated `\uXXXX` body `u[0-9a-fA-F]{4}` also lowers; the full JSON/GraphQL *string* pattern still declines for independent reasons (its outer `(?:alt)*` structure is §8g/delimited territory, unaffected by this change). **Correctly declines:** `[0-9]{2,4}[0-9]` (bounded wiggle overlaps the continuation — greedy would overshoot, the engine backtracks) stays on `exec`; degenerate `{0}`/`{0,0}` (max < 1, matches empty) decline in the parser. Verified: compiled-scan-vs-native-`RegExp` differentials (0 diffs over ~2M inputs incl. the real colorHex-with-lookahead and `u{4}` patterns, plus adversarial decline cases), full suite (1651) + typecheck, CSS perf-guard neutral-or-better. Note the codegen-A/B exec oracle moved from `{1,}`/`{0,}` (which now lower) to the same pattern under the `u` flag (lowering is disabled for `u`). See `test/unit/scannable-regex.test.ts` (`§8c` describe block).
- **Per-node trivia capture kind-filter (`_triviaCaptureMask`)** — the fix that lets a host (jess) get *comments only* out of a node's `triviaLog` without paying to log every whitespace run, so it never has to hand-roll a comment re-scan. A **general kind filter**, not a comment special case: `ctx._triviaCaptureMask` is a bitmask over the active `triviaKindLabels` indices (bit `k` = "record kind `k`"; `undefined` = record all, the default). It gates ONLY the per-node CST trivia log (the `triviaLog` arg a `node()` builder sees); the global `_triviaLog` stays complete, so a downstream trivia map is untouched. Interpreter: one filter point in `recordTriviaChunks` (`src/cst/trivia-kinds.ts`) — global push unconditional, per-node `pushCstTriviaEntry` gated on `mask === undefined || (mask & (1<<kind))`. Compiled: the three labeled trivia emitters (`scanBranchLabeled`, `buildLabeledRegexTriviaFnDecl`, `buildLabeledRuntimeTriviaFnDecl`) wrap the `_cstTriviaLog.push` in `_ctx._triviaCaptureMask === undefined || (_ctx._triviaCaptureMask & <1<<k>)` where `k`/`1<<k` are **compile-time constants** — so a filtered-out kind costs one integer AND, and a captured kind is unchanged. **Zero overhead when per-node capture is off** (the check sits behind the existing `_cstTriviaLog !== undefined` guard, which short-circuits). Wiring: `parser({ trivia, captureTrivia: true, captureTriviaKinds: ['comment'] })` (interpreter, resolves names→mask via the trivia labels), `run(entry, input, { triviaCaptureMask })` (compiled host), the **`_parsemanTriviaKinds(type)` build-host hook** for a PER-NODE-TYPE mask (returns a mask per node type, `undefined` = all; scoped to the node and restored on exit — this is what real grammars need, e.g. `Ruleset`→comments-only while `CompoundSelector`→all so it keeps the whitespace that marks a descendant combinator), or set `ctx._triviaCaptureMask` directly; build a mask with the exported `triviaKindMask(labels, keep)`. The per-type hook is threaded in both the interpreter (`node.ts`) and compiled (`codegen.ts` node scope, alongside the existing `_parsemanCaptureTrivia` gate) paths; interpreter⇔compiled parity in the test. **Proven end-to-end** replacing Jess's `_liftStandaloneComments` source re-scan with a comment-only log-walk: byte-identical output (193 css-parser tests), parse-neutral on both real and comment-dense corpora, no whitespace-capture regression (see `notes/jess-comment-lift-proof/`). This is the parseman-side realization of the "don't overfit `hasComment`" design note below — the primitive stays a general per-kind filter, so a future erasable-but-meaningful trivia kind (pragma, significant-newline) is one more label, not a new capture mode. Interpreter⇔compiled parity + global-log-completeness in `test/parity/trivia-capture-mask.test.ts` (7 cases); full suite (1545) + CSS perf-guard neutral. **Supersedes** the reverted jess-side `_liftStandaloneComments`-off-the-log attempt (which regressed 15–25% because per-node capture logged every whitespace run — exactly what this filter removes).

---

## P0 — Root trivia: separate recognition, capture, and formatting facts (2026-07-30)

`LANDED` × 2, `QUEUED` × 1, `UNMEASURED` × 4, `REFERENCE` × 3. Untried here: U-01…U-05.

### What is already cheap, and what is not — `REFERENCE`

The premise needs precision. Parseman has already made **skipping** trivia cheap:
the compiled CSS-shaped loop is `charCodeAt`-based (`src/compiler/trivia-fast-path.ts`),
and the current per-node logs are packed number arrays rather than token objects.
Do **not** replace that with a scanner that reparses source, token objects, an Error-like
diagnostic record, or a per-character table.

The root path is different and currently pays for *all* presentation facts whether a
consumer needs them or not:

1. `runOnce()` in `src/functional/run.ts` always allocates `triviaLog: number[]` and
   installs it as `_ctx._triviaLog` on an ordinary parse. Every committed root trivia
   run therefore takes the capture branch.
2. For **labeled** trivia (the CSS/Less `whitespace | comment` form), the generated
   loop pushes `[start, end, kind]` for **every individual whitespace and comment
   chunk** (`buildLabeledScannableTriviaFnDecl` in
   `src/compiler/trivia-fast-path.ts`), even if the downstream consumer only asks
   “does this gap contain a comment?”. `_triviaCaptureMask` cannot fix this: it
   deliberately filters only the *per-node* CST log; `recordTriviaChunks()` makes
   the root log complete.
3. A root `RootTriviaIndex` is lazy only until its first meaningful query. Then
   `buildRootMaps()` (`src/cst/trivia-entries.ts`) constructs four `Map`s, a gap
   object for every gap, and an `entryIndices` array that copies every chunk index;
   it also stores each entry-range twice (`before` and `after`). `gapsWithKind()`
   subsequently walks every gap and resolves kind strings one entry at a time.

This is not hypothetical. The current Jess Less bootstrap profile, after the separate
diagnostic fix, attributes visible self-time to Parseman's `appendGap` (2.83%),
`gapsWithKind` (2.55%), `buildRootMaps` (1.53%), and `getMaps` (0.96%); the complete
root stream is also retained for a 288 KB input. Those are **formatting-fact costs**,
not recognizer costs. The existing packed log is the right representation for a
consumer that truly needs every labeled token; it is the wrong unavoidable default
for a compiler that only sometimes re-emits comments.

The exact 288,434-byte PostCSS Bootstrap-Less workload makes the representation
failure concrete: the current root sink retains **22,663 labeled entries / 67,989
numeric cells** and `buildRootMaps()` materializes **22,631 root gaps**, while only
**20** selected comment markers collapse to **16** owned gaps (100 numeric cells).
A packed cell is cheaper than an object, but 68,000 cells and 22,000 gaps for 20
meaningful markers is still the wrong asymptotic contract. Keep this count in the
real-workload gate: a selected-comment capture that merely makes map construction
faster, while retaining the full whitespace stream, has not fixed the architecture.

**Prototype evidence (2026-07-30):** a compiled labeled-trivia scanner over the
current PostCSS benchmark Bootstrap CSS (280,308 bytes) retained 74,271 legacy
numeric cells / 24,729 root gaps. Selecting only the `blockComment` label
retained 16 marker rows = 80 numeric cells / 16 owned ranges. After the full
rollback-safe implementation, 240 median samples of compiled parse plus the
renderer-relevant `gapsWithKind('blockComment')` query measured **7.99 ms →
1.24 ms**: **84.4% less elapsed work**. CPU profiles of the legacy path put 28.8% of samples in
GC, 10.2% in `appendEntryRange`, 3.3% in `buildRootMaps`, and 2.8% in
`buildGap`; those functions are absent from the selected path. This is a
root-trivia capture/index measurement, not yet the Jess end-to-end verdict; the
Jess adoption must repeat it with the exact Less eval+emit workload.

The rule for this lane is therefore:

> Skip trivia on every ordinary grammar edge. Capture exactly the source facts a
> selected output policy can prove it will consume. Never reconstruct omitted facts
> by rescanning the source after parse.

The last clause matters: “capture nothing now, find comments later with a source scan”
simply moves an O(source length) pass back into render, often once per output boundary.
That is not a win.

### The existing offset model is the baseline, not an optional optimization — `REFERENCE`

`src/cst/offset-model.ts` already states the right representation: leaf/AST source
spans are the anchors, and a trivia gap is the subtraction between adjacent spans.
For a source-preserving consumer, `source.slice(left.end, right.start)` recovers the
exact authored bytes only when it has chosen to replay that gap. Plain horizontal
whitespace therefore has no independent root fact to retain: one space, many spaces,
and tabs are all already implied by the two source offsets and can be normalized by a
normalizing emitter without consulting a log.

The *formatting* facts that are not reducible to ordinary semantic output are sparse:

- a comment marker and the contiguous authored gap that owns it;
- a line-break/layout marker only for a consumer that preserves line structure;
- the offset after the last line break when indentation must be recovered without
  revisiting the gap text.

Do not turn these into one record per whitespace lexer chunk. A selected comment gap
retains the exact surrounding spaces/newlines as one `[start, end]` pair, and a
newline-aware mode can store a compact bit/last-break offset per *meaningful* gap.
`OffsetIndex` tests already pin that pure inline whitespace is insignificant while a
comment or newline is significant. The root capture redesign must use that model;
otherwise a new packed log merely preserves the current 22k-fact mistake in a smaller
array.

### 1. Add an explicit *root* capture policy — `LANDED` (`allEntries`, `selectedKinds`) + `QUEUED` (`none`, `gaps` — U-01)

Keep the current complete root log as the compatibility mode, but stop treating it as
the only `run()` shape. Add a policy separate from the existing **per-node**
`triviaCaptureMask`; exact spelling is open, but the semantic states must be:

| Root policy | Record while parsing | Correct consumer |
| --- | --- | --- |
| `none` | no root trivia data; no `_triviaLog` allocation or pushes | compilers/AST consumers that never preserve comments/layout |
| `allEntries` (legacy default) | every labeled chunk, current `[start,end,kind]` contract | tooling that really needs every trivia token/kind |
| `selectedKinds` | only named kinds plus enough gap boundaries to preserve their authored source context | comment/pragma-preserving emitters |
| `gaps` | one contiguous root gap per committed trivia site, no kind markers | format-preserving tools that only slice complete gaps |

This must be a parse-time policy. `none` should leave `_ctx._triviaLog` undefined from
the start, which makes the existing compiled `_cap = _ctx._triviaLog !== undefined ?
2 : 0` path cold and eliminates array growth/pushes. `allEntries` remains byte-for-byte
compatible for `RunResult.triviaLog` and existing callers. Do **not** silently change
the public default in a minor release.

**Current release boundary:** 0.44.0 lands `allEntries` and `selectedKinds` only.
`none` and broad `gaps` remain separately testable policy additions; they are not
silently represented as an empty selected result.

**Semantic risk:** a client that calls `triviaMap` / `commentRuns()` after selecting
`none` must fail loudly or receive an explicitly unavailable view — never an empty map
that claims there were no comments. Trailing trivia is separately owned today; preserve
the documented `trailingTrivia` behavior exactly. Every mode must maintain recognition,
failure offset, recovery diagnostics, and line tracking byte-for-byte.

**Proof / measure:** add a compile+interpreter parity matrix for none/all/selected/gaps
with whitespace-only, `ws-comment-ws`, line comment, nested parser/noTrivia, failed
lookahead/attempt rollback, recovery, and terminal-document comments. Add an exact
Jess CSS/Less fixture to a Parseman workload harness (not a synthetic tokenizer): report
parse median, retained trivia numbers, root-gap count, selected-marker count, and V8
allocated bytes. The expected `none` result is *zero root entries*, not merely a faster
map query. Keep only modes that are neutral-or-better for no-capture parsing and win on
the real Jess parse+emit workload.

### 2. Represent `selectedKinds` as **owned-range rows + kind markers**, not filtered chunks — `LANDED`

For the common CSS/Less requirement, an emitter needs two different facts:

- the exact authored text of the entire boundary gap (to preserve ` /* comment */ `,
  including its surrounding whitespace when that is semantically chosen), and
- the source spans/kinds of the meaningful members in it (normally block/line comments).

It does **not** need one root entry for each whitespace run. The first minor-release
implementation uses one fixed-width numeric row per selected marker while the existing
trivia scan already knows the answer:

```text
[ownedRangeStart, ownedRangeEnd, markerStart, markerEnd, kindIndex]
```

The whitespace / comment / whitespace sequence becomes **one five-number selected row**,
rather than three full labeled rows; `input.slice(ownedRangeStart, ownedRangeEnd)` still
returns the exact authored gap. Adjacent selected markers in one range repeat the range
pair—a deliberate fixed-width/rollback tradeoff that keeps the hot scanner monomorphic;
the sparse index coalesces them on read. This is a general labeled-trivia feature: pragma,
directive, and significant-newline clients select different labels; no CSS/comment special
case.

Do not try to coalesce entries across a grammar boundary that was not committed. The
current deferred-commit/rollback rules are ownership semantics: a trivia run before a
failed optional term is terminal, not a sibling gap. The new stream must be appended and
truncated at precisely the same commit marks as `_triviaLog`.

**Compatibility shape:** `RunOptions.rootTrivia` accepts the legacy `allEntries` default
or `{ selectedKinds }`. The legacy `triviaLog` shape stays unchanged; the selected result
is exposed separately as `rootTrivia.rows` and is consumed through the same range-oriented
`triviaMap` API. Existing callers that parse `[start,end,kind]` themselves therefore keep
their contract.

**Proof / measure:** a golden test should show identical source slice and selected-kind
answers for legacy entries vs gap+marker on mixed whitespace/comment input. Differential
tests must include repeated comments within one gap, adjacent comments, different labels,
and a label mask of zero. Count emitted numeric cells on Bootstrap Less/CSS and a
comment-dense stylesheet; this idea is worth implementing only if it materially reduces
cells/GC and wins Parseman *and* Jess parse+emit.

### 3. Make direct boundary queries truly sparse — `LANDED` (selected rows; the broad legacy APIs stay lazy adapters)

Selected-root `gapBefore(offset)` and `gapAfter(offset)` now binary-search the ordered
rows and do not force `buildRootMaps()` for the whole document. For an ordered gap stream, implement direct lookup with binary search
over starts/ends (or a flat sorted pair array): O(log gaps) reads, no document-wide map,
no copied entry-index arrays. A queried gap can carry `{ start, end, firstMarker,
markerEnd, kindMask }`; materialize a public object only for that requested gap.

The existing `before`/`after` map getters, `gaps()`, and legacy `entryIndices` arrays can
remain compatibility adapters that materialize lazily **only when those old broad APIs
are used**. Do not make a `Map` the primary index merely because the legacy surface
exposes one. If a caller asks for every gap, O(gaps) allocation is honest; a caller that
asks for one boundary must not pay O(document) work.

**Semantic risk:** source offsets can coincide only at a real boundary; assert sorted,
non-overlapping committed ranges and pin the existing before/after ownership convention.
Do not return one mutable flyweight object, because public callers may retain a gap.

**Proof / measure:** retain all `trivia-entries` boundary tests, then add a counter/test
that `gapBefore(oneOffset)` has not initialized legacy maps or visited unrelated gaps.
Benchmark one lookup, N random lookups, and a full `entries()` enumeration independently;
the full enumeration is allowed to be linear, the singleton lookup is not.

### 4. Give kind queries an index, not a repeated full gap scan — `UNMEASURED` (U-02)

`gapsWithKind()` presently loops every gap, then loops its entries and resolves label
strings. Build selected-kind postings while capturing (`kindIndex -> marker/gap ranges`) or,
for legacy all-entry logs, lazily scan the flat triples once into compact index ranges.
Within a gap, retain a `kindMask` for up to 32 labels; for wider label sets use a sorted
small-int span/bitset representation, **not** an object set per gap. Resolve requested
label names to indices once per query.

This makes comment enumeration O(comments + matching gaps), rather than O(all trivia
chunks) every time a serializer calls `commentRuns()`. It also makes `hasKind` an integer
test in normal CSS/Less grammars. Preserve exact label semantics: a gap with two selected
kinds must be emitted once and in source order.

**Proof / measure:** differential against the legacy `gapsWithKind` for single/multi-kind
queries, duplicates, unknown labels, and unlabeled trivia. A test must call it twice and
prove the second query neither rebuilds nor rescans. Report work proportional to matching
markers, not only wall time.

### 5. Split “need a gap” from “need every trivia token” in host contracts — `UNMEASURED` (U-03)

The current root log is effectively enabled by `run()` itself, while per-node capture has
a host-aware plan. Add a declarative root demand to the `run`/build-host contract (or a
small explicit `RunOptions` object) so an AST compiler chooses one policy once at parse
entry. Examples:

- normal minified compile: `none`;
- render that preserves only authored comments: `selectedKinds(['blockComment',
  'lineComment'])` + gap rows;
- language service/reformatter: `allEntries` only when it truly edits/replays trivia
  tokens individually.

Do not infer demand from whether a caller happens to access `result.triviaMap` later;
by then the information either had to be captured or is gone. Do not make a generic
runtime callback that fires for every gap: that replaces packed writes with call overhead
and polymorphism. The plan must be fixed per parse, and codegen should see only cheap
numeric mode/mask checks.

**Proof / measure:** explicit policy is part of the parser wrapper's behavioral contract.
For Jess, tests must demonstrate the selected policy preserves all output-required comments
and that `none` is used only where output has no formatting obligation. Run all four dialect
parse + render corpora; no parser may "pass" simply because comments vanished from its AST.

### 6. Stop allocating the empty root sink and empty index — `UNMEASURED` (U-04)

Even a no-trivia document currently allocates `triviaLog: []`, `errors: []`, a root-index
closure, and an entry view in `runOnce()`. For root policy `none`, return shared immutable
empty result views and do not attach `_triviaLog`; for a parse with `allEntries` that
encounters no trivia, use a shared empty index after parse. This is not the main Bootstrap
win, but it matters for the common small/minified stylesheet path and makes “no capture”
actually zero-sink rather than “capture an empty array.”

**Guard:** never share a mutable `number[]` or error array. The compatibility result may
expose a frozen/shared readonly empty view; if mutability is presently public, allocate
only at that API boundary and document the legacy cost.

### 7. Preserve source *ranges*, never eagerly rebuilt formatting strings — `REFERENCE` (an invariant, not a work item)

The right representation for reproducible formatting is offsets into the immutable input.
The source already exists for parse lifetime, so exact output requires `slice(start,end)`
only at the one renderer that chose to emit it. Do not turn each gap into a string, split
whitespace into lines, normalize it during parse, or store both raw bytes and a normalized
copy. Gap+marker capture is deliberately range-only.

This is also the semantic boundary for deciding whether a rule should reproduce formatting:
that decision belongs to the output contract, not the recognizer. A minifier that never
re-emits authored layout should choose `none`; a formatter that needs a complete lexical
trivia stream should choose `allEntries`; comment-preserving output gets the intermediate
gap+marker form. Do not make every parser pay the language-service formatter's bill.

### 8. Measure a typed-buffer alternative last, and only as an implementation detail — `UNMEASURED` (U-05)

The current JavaScript number arrays are already packed and append-friendly. Replacing
them wholesale with `Uint32Array`/`Int32Array` can regress due to growth copies, bounds
checks, conversion of offsets above 2³², and less-friendly V8 optimization. First land a
capture policy that removes unnecessary cells. Only then A/B a chunked/growable typed
writer behind the same root-view API, with ordinary arrays as the control.

**Keep condition:** retained heap materially lower *and* no slowdown on real CSS/Less
compile+emit. A typed array is not a design win by itself; it is expressly not permission
to reintroduce per-entry objects, Maps, or source rescans.

### Required workload and review gates for this lane — `REFERENCE`

1. Add a reproducible **root-trivia workload** that uses a real compiled CSS/Less grammar
   and a real large stylesheet (including the PostCSS Bootstrap Less fixture when available),
   plus a synthetic comment-dense variant. It must report: source bytes, committed trivia
   gaps, legacy entries, gap rows, selected markers, numeric cells, parse median, and
   retained/allocated heap.
2. Separate timings for recognition/structural host work/root capture/index construction/
   `commentRuns()` (or equivalent selected-kind enumeration). `run({ profile: true })`
   currently omits global sinks in its first two passes, so it cannot by itself certify this
   path; add a dedicated A/B driver.
3. V8 CPU profiles must show `appendGap`, `buildRootMaps`, and `gapsWithKind` disappear or
   shrink in the selected/no-root modes. Do not call a regression “neutral” only because a
   synthetic parse never queried formatting.
4. Differential tests must assert interpreter, `compile()`, `compileLinkable`, and macro/
   fused output agree on recognition, source spans, selected kinds, rollback ownership,
   recovery, and exact preserved source slices.
5. For Jess integration, run the real parser suites and byte-identical Less output corpus,
   then the exact PostCSS eval+emit benchmark. A parser-only win that drops a comment or
   changes output whitespace is a failure, not a performance result.

---

## High priority

`LANDED` × 2, `REJECTED` × 1, `UNMEASURED` × 1 (U-06).

### 1. Choice fast paths disabled in CST grammars — `LANDED`

Moved to **Already landed**.

---

### 2. `node()` per-invocation overhead — `REJECTED` (both compiled attempts) + `UNMEASURED` (transparent-wrapper elimination — U-06)

Interpreter-only `node()` capture work moved to [`INTERPRETER_PERF_IDEAS.md`](./INTERPRETER_PERF_IDEAS.md).

**Rejected (compiled — do not retry without a new approach):**

| Attempt | Result |
|---------|--------|
| Runtime helper prelude (`_cstPushLeaf`, `_cstSaveMark`, …) | CSS compiled **+~50%** (bootstrap4 25.8→39ms) |
| Inline lazy buf in `cst-capture-codegen.ts` (no helper calls) | CSS compiled **+~32–47%** (bootstrap4 25.8→38ms) |

Eager `[], [], []` in `emitNode` remains faster — branchy inline push costs more than the array alloc it avoids on typical CST shapes.

**Remaining:**

- Compile-time transparent-wrapper elimination when `buildSrc` is `(c) => c[0]` (or equivalent).

---

### 3. Log-only compiled trivia capture — `LANDED`

Moved to **Already landed**.

---

## Medium priority

`LANDED` × 4, `MEASURED-NULL` × 1, `REJECTED` × 1, `QUEUED` × 1 (U-11), `UNMEASURED` × 8 (U-07…U-10, U-12…U-16).

### 4. Fuse `sequence` + `transform` — `LANDED` (destructure + unary) + `UNMEASURED` (outer-scope / non-destructure params — U-07)

`transform(sequence(a, b, c), ([x, y, z]) => …)` with destructure-array `fnSrc` / arrow `toString()` now emits straight-line locals + inlined body — no `_arr`, no `_mf[n]`. Unary transforms (`s => parseInt(s, 10)`, object literals, etc.) also inline when closure-free.

**Result:** GraphQL large compiled **−6%** (~149→~142µs); medium **−5%**. Remaining: transforms whose body references outer scope or non-destructure params.

### 5. Inline transforms and builds at call sites — `LANDED` (transform inlining) + `MEASURED-NULL` (`mk()` literal emission, CSS-neutral) + `UNMEASURED` (general `buildSrc` object-literal inlining — U-08)

Macro `fnSrc` / `buildSrc` and runtime `toString()` for arrow builds. Landed: transform inlining (§4), CSS `mk(type,…)` literal emission (`inline-build.ts`, **neutral** on bootstrap4 — removes `_build` indirection but no measurable CSS win). Remaining: general `buildSrc` object-literal inlining for non-`mk` grammars.

### 6. Trivia loop specialization — `LANDED` + `REJECTED` (the inline-vs-hoist `charCodeAt` micro-tweak, measured the opposite way)

When trivia is `oneOrMore(choice(ws, blockComment))` (CSS `rw`) or ASCII ws-only, emit a hand-rolled `charCodeAt` scan in `_tfN` instead of regex / combinator dispatch. Single alternation regexes are excluded — one `RegExp.exec` matches only one arm per call.

**Result:** CSS bootstrap4 compiled **−52%** (25.8→12.3ms); selector/decls **−43–47%**. See `src/compiler/trivia-fast-path.ts`, `test/unit/trivia-fast-path.test.ts`.

**Rejected micro-tweak (measured, do not retry):** inlining `input.charCodeAt(_e)` at each dispatch branch instead of hoisting `const c = input.charCodeAt(_e)` once per loop iteration. This was an attempt to apply the "repeated inline access beats a hoisted local" finding (the recalibrated-literal / charCodeAt-hoisting result) to the trivia loop. Measured the *opposite* here via an isolated in-process A/B recompiling the real CSS grammar both ways: **hoisting wins** — inline was 0.7–5% slower on bootstrap4 across 4 runs, never faster, and tied-or-slower on selector/decls. The finding doesn't generalize because in this loop `c` is compared across *several distinct branch sites* per iteration (ws class ranges, comment open literal), not two `charCodeAt` calls fused in one boolean expression in a single basic block (where V8's CSE reliably dedups). The hoisted form is already optimal.

### 6b. Generalize the trivia fast-path to value-capturing positions — `UNMEASURED` (U-09)

`trivia-fast-path.ts`'s own doc comments (and `scannable-run.ts`'s: "Trivia … is just the value-discarded instance of this; nothing here is trivia-specific") already claim the underlying dispatch-loop technique is general-purpose — but that generalization only ever happened *within* trivia (see the file's git history: several rounds of "generalize to any scannable-shape set," all still inside the trivia codegen path). Today a plain, ordinary (value-capturing) `oneOrMore(choice(regex(...), regex(...)))` or `many(choice(...))` sitting in a normal grammar position gets **none** of this treatment — `scannable-terminal.ts` only fast-paths a single regex per call site, not a multi-arm choice-loop, and `trivia-fast-path.ts`'s builders (`buildFastTriviaFnDecl`, `buildLabeledScannableTriviaFnDecl`, …) are hardcoded to discard the match and return only the end position (`return _e`).

The reusable ~60–70%: `analyzeTriviaFastPath`'s recognition logic (minus the trivia-specific unwrap) and `composeFastLoop`'s loop skeleton, plus all of `scannable-run.ts`'s shape/branch machinery (`scanShapeFromRegex`, `scanBranch`, `emitShapeMatch`) — none of that is trivia-specific already. The net-new ~30–40%: an emit path that builds a value (`input.slice(start, _e)`) or CST node per matched run instead of discarding it, threading capture-buffer/CST child-append calls per arm the way `emitLeafCapture`/`inline-build.ts` already do elsewhere — essentially a `buildValueScanFnDecl` sibling to `buildFastTriviaFnDecl`. **Guard:** identical to what's already proven for the trivia loop (`scanBranch`'s completion semantics: only advance/log on real progress) — no new ambiguity analysis needed, this is a codegen-target change, not a new safety proof. **Measure:** any grammar with a hot value-capturing `oneOrMore(choice(...))` of scannable regexes — CSS's `anyValueTok`-adjacent value-list loops are a plausible candidate once profiled.

### 7. Common-prefix choice factoring — `UNMEASURED` (U-10)

Arms like `ident '(' …` vs bare `ident` can't use disjoint dispatch. Generalize the CSS grammar hand-merge: parse shared prefix once, branch on lookahead. Complements existing `autoNot` (suffix rejection) but doesn't replace it.

#### 7a. Factor `Dimension`/`Num` into one numeric node (grammar-side; verified 2026-07-16) — `QUEUED` (U-11)

**Verified against the real jess CSS grammar** (`@jesscss/core` `packages/css-parser/src/grammar.ts`), not projected:

```js
57:  const numPart = regex(/[+-]?(?:\d*\.\d+…|\d+…|\d+)/);
163: const value = choice(g.Dimension, g.Num, g.Color, …);          // Dimension BEFORE Num
186: const Dimension = node(sequence(numPart, regex(/…unit…|%/)));  // number + REQUIRED unit
262: const numTok   = regex(/…numPart…(?![a-zA-Z-￿%])/); // numPart + negative lookahead
267: const Num      = node(numTok);
```

`Dimension` and `Num` are separate ordered `choice` arms that BOTH start with `numPart`, so they
share a first-set → the disjoint-dispatch fast path can't split them → ordered `firstMatch`,
Dimension tried first. **The waste, per unitless number** (`16`, `1.5`, `0` — opacity/line-height/
z-index/flex/calc operands, i.e. very common): enter the `Dimension` `node()` **capture frame** →
scan `numPart` → fail the required unit → **roll the frame back** → enter `Num` → scan `numPart`
**again** + run the `(?!unit)` lookahead. The re-scan is cheap (numPart lowers to a charCodeAt
loop); the **failed-capture-frame enter+rollback** is the real cost, and it lands in the #1-hot
value rule, in the 30%-capture phase — i.e. this removes WORK, not allocation (the class that has
actually moved time; allocation-shaped ideas all measured 0% — see zero-copy / dead-value / §1).

**Fix — one numeric node, unit as an optional glued continuation** ("a Dimension is just a Number
that continues into a unit"):

```js
const numeric = node(noTrivia(sequence(numPart, optional(unitRegex))));
// builder: unit leaf present → Dimension, else → Num
```

- `numPart` scanned once; one capture frame; zero rollback on the common (unitless) path.
- **The `(?!unit)` lookahead disappears** — `optional(unit)` greedily takes an adjacent unit, so
  `16px`→Dimension / `16`→Num disambiguate structurally.
- **Use `noTrivia`, NOT `token`** (`src/combinators/grammar.ts` vs `src/combinators/token.ts`):
  `_buildDimension` reads number and unit as TWO leaves (grammar comment at :185); `token` flattens
  to one `Combinator<string>` and loses the split. `noTrivia` preserves the leaves while killing
  inter-element trivia.

**This is also a CORRECTNESS fix (red test first).** Current `Dimension` is a BARE `sequence`
under the grammar's ambient trivia (`rules({ trivia: rw })` → `sequence` skips trivia between
elements dynamically). So today `16 /* c */ px` and `16   px` skip the trivia and parse as ONE
`Dimension`, when they must be `Num(16)` + a separate `px` token. The `Num` arm's `(?!unit)` only
guards the immediately-adjacent case; it does NOT stop the Dimension arm from eating trivia. So:
- **RED on current grammar / GREEN after `noTrivia`:** `16 /*c*/ px` and `16 px` ⇒ `Num` + separate
  token, not `Dimension`. `16px` ⇒ `Dimension`. `16` ⇒ `Num`. (Exact-equality asserts, no substring.)

**Scope:** Jess-grammar + builder change (`grammar.ts` collapses the two arms; `builders.ts` picks
Dimension/Num by unit-leaf presence). NOT a Parseman-core change — but it's the concrete instance of
the generic §7 factoring; teaching Parseman to detect shared-prefix arms and factor them
automatically is the reusable follow-on (§7c richer dispatch). **Magnitude: honestly single-digit**
overall (numeric tokens are a subset; numPart is cheap) — worth doing for the capture-frame removal
on the hot path AND because it makes the grammar correct and match how it reads. Measure on
value-dense CSS via `pnpm bench:parseman -- --only=css` + a Jess CSS/Less A/B; guard with `perf:guard`.

### 7b. Partial first-char choice dispatch (switch + fallback) — `UNMEASURED` (U-12)

**Problem:** `choice(quotedField, unquotedField)` in CSV is *not* marked `disjoint` because
`unquotedField`'s first set (`[^,\r\n]*`) includes `"` — same as `quotedField`'s leading
literal. So codegen emits **`firstMatch`**: on every unquoted field it still enters the full
`quotedField` arm, fails at `charCodeAt !== 34`, records the miss, then tries `unquotedField`.
That's correct PEG semantics but wasteful on the hot path (almost every field is unquoted).

**Already landed for the fully-disjoint case:** `emitChoice` → `planDisjointDispatch` emits a
`switch (codePointAt(pos))` (or `if/else if` range chain) when *all* arms have pairwise-
disjoint first sets. Keyword/operator grammars get O(1) dispatch today.

**Idea (circle back after CSV perf is stable):**

1. **Partition arms** by first-set overlap:
   - **Unique keys** — exactly one arm can start at code point `c` → `switch` case → try only that arm.
   - **Ambiguous / wide-class arms** — collect into a small fallback `firstMatch` (or `greedyClassify`) subset.
2. **Second-char refinement** — when two arms share a first char but diverge on the second
   (e.g. `\r\n` vs `\n`), nest a switch on `charCodeAt(pos+1)` inside the first-char case.
3. **CSV-specific win without new machinery:** at `"` → quoted only; else → unquoted only.
   Semantically safe: non-`"` inputs never succeed on `quotedField` anyway.

Complements §7 (shared-prefix factoring) and `autoNot` (suffix rejection). Does **not**
replace them — handles the "wide regex arm overlaps a literal-prefix arm" pattern common in
data grammars (CSV, config, log formats).

**Measure:** `csv/small` + `csv/large` speedup ratio; `test/unit/choice-dispatch.test.ts` +
`test/parity/failure-diagnostics.test.ts` for parity.

### 7c. Richer dispatch structures (beyond the flat first-char `switch`) — `UNMEASURED` (U-13)

Today `planDisjointDispatch` emits a `switch (codePointAt)` / `if-else` chain keyed on **one** first code point. Several grammars want more than that:

1. **Keyword trie / char-by-char `switch`** — `choice(literal('||'), literal('>'), literal('+'), literal('~'), literal('|'))` (CSS `combinator`), `choice(kw('fragment'), kw('query'), …)` (GraphQL), `lang` keyword set. Build a small trie and emit nested `switch (charCodeAt(pos + k))`; leaves confirm the full literal. This is the runtime form of `makeWord()` (see cleanup table) and the *literal-alternation* case of 8e — `regex(/even|odd/)` and `choice(literal('even'), literal('odd'))` should share the emitter.
2. **Second-char refinement** (already noted in §7b step 2) — nest `switch (charCodeAt(pos+1))` when arms collide on the first char (`\r\n` vs `\n`, `::` vs `:`, `>=` vs `>`).
3. **Length + `switch` for fixed-width token sets** — when all arms are fixed-length keywords, switch on length first, then compare (branch-free memcmp-style). Good for large keyword tables.
4. **Binary-search range dispatch** — for many *wide-char-class* arms (can't be a jump table), emit a sorted range `if` tree (O(log n)) instead of a linear `if-else if` chain. Helps grammars with dozens of class-keyed arms.
5. **Perfect-hash for large keyword sets** — when a `choice`/alternation has many (>~16) distinct keywords, a generated perfect hash on (length, chars) can beat a deep trie. Measure before adopting; tries usually win at these sizes.

**Guard:** all forms must preserve PEG ordered-choice semantics for overlapping arms (unique-key cases only for the O(1) paths). **Measure:** GraphQL (keyword-dense), CSS `combinator`/`pseudoColon`, `lang`.

### 8. Simple regex lowering — `LANDED` (8a–8c, 8e–8i) + `UNMEASURED` (8d, 8g, 8h-next)

`scanShapeFromRegex` shapes lower terminal `regex()` to `charCodeAt` scan loops in `emitRegex` (`scannable-terminal.ts`); trivia uses the same shapes via `trivia-fast-path.ts`. Supported:

- `[X]+` / `[X]*` char-class runs (`chars`)
- `\d`/`\w`/`\s` runs and `\d`/`\w`/`\s` **inside** classes (e.g. `[\d.]+`, `[\s,]+`)
- `[head][tail]*` identifier runs (`ident`), incl. shorthand head/tail
- `<lit>[^X]*` open-until-terminator (`until`) and `<open>…<close>` delimited tokens
- escape-aware quoted strings `<q>(?:[^q\\]|\\.)*<q>` (`string`), incl. `\uXXXX` in classes
- **general linear chains** (`seq`): any sequence of literal segments (required or `x?` optional) and char-class runs (positive/negated, `?`/`*`/`+`). This is the categorical generalization that covers CSS/Less `ident` (`-?[…][…]*`), `customProp` (`--[…]*`), `atKeyword` (`@-?[…][…]*`), `pseudoColon` (`::?`), bare negated runs (`[^…]+`), and non-escaped quoted tokens (`"[^"]*"`) — with **no hardcoded byte values**. A `seq` is only lowered when greedy one-pass scanning provably equals the engine's backtracking (`seqIsUnambiguous`: optional segments must be disjoint from what follows; greedy unbounded runs must be disjoint from the next segment's first-set).
- pure-literal case-insensitive tokens under `/i` (`litFold`, ASCII case-fold), e.g. CSS `url(`

Lowering is disabled for `m`/`s`/`u` flags and for `/i` on anything but a pure literal (case-folding a char class isn't a fixed code-point scan).

**Still open — concrete classes (ordered by payoff × frequency across the example grammars).** Each is a self-contained shape or `seq` extension; the guard column is what keeps a greedy code-point scan provably equal to the engine.

#### 8a. `\s` as a fixed code-point set (trivia hot path) — `LANDED`

Moved to **Already landed**.

#### 8b. Trailing lookahead boundary guard `(?!class)` / `(?=class)` — `LANDED`

Moved to **Already landed**.

#### 8c. Bounded repeat `{n}` / `{n,}` / `{n,m}` on a class/shorthand run — `LANDED`

Moved to **Already landed**.

#### 8d. `/i` on char classes (ASCII case-fold ranges) — `UNMEASURED` (U-14)

Generalize `litFold` from literals to classes: for each range, add its ASCII-folded twin (`[a-z]→+[A-Z]`, etc.), then scan the widened range set. Unblocks CSS `attrMod` `[is]/i` and lets `/i` idents/keywords lower. **Guard:** only fold ASCII `A–Z`/`a–z`; a non-ASCII range under `/i` (Unicode case-fold, e.g. `ß`, `ﬀ`) stays on `exec`. **Measure:** CSS `AttributeSelector`.

#### 8e. Top-level alternation `A|B|C` → ordered / first-char dispatch — `LANDED`

Moved to **Already landed**.

#### 8f. Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)+` → nested `seq` — `LANDED`

Moved to **Already landed**.

#### 8g. Lazy-delimited `<open>[\s\S]*?<close>` — `UNMEASURED` (U-15)

`jsonc` block comment `/\*[\s\S]*?\*/` is "scan to first `<close>`" — the same core as `delimited` but lazy `*?` instead of the negated-body form. Recognize `<lit>[\s\S]*?<lit>` (and `.*?`) as a `delimited` variant. **Measure:** `jsonc` comment-heavy.

#### 8h. Trailing non-disjoint-alt group → ordered-commit — `LANDED` + `UNMEASURED` (Approach B widenings — U-16)

Moved to **Already landed** (closes the CSS `numPart` gap §8f left open).

**Next (non-trailing overlapping alternations):** the general form — a non-disjoint-alt group in *non*-trailing position, or an overlapping top-level alternation followed by more — needs a soundness gate (the alt's inter-arm *divergence set* must be disjoint from the continuation's first-set) or an automatic left-factoring pass over `regexp-tree`'s AST at macro time (subsumption + suffix-factor + prefix re-partition into a disjoint form). Bigger, and off the current hot path; deferred. Related cleanup surfaced while scoping this: `regexp-tree` is a compile-time analysis library but was imported by the *runtime* `regex()` combinator — **done**, see below.

#### Runtime `regex()` no longer statically depends on `regexp-tree` — `LANDED` + `QUEUED` (hand-rolled first-set parser — U-17)

`regexp-tree` was ~264 KB of `regex.ts`'s 271 KB runtime import graph (measured: bundling `regex.ts` alone = 271 094 B; with `regexp-tree` external = 7 148 B). Two changes: (1) **deleted `optimizeRegex`** outright — it did essentially nothing (only trivial char-class reordering; verified it leaves `abc|abd` and the CSS number regex unchanged) and additionally dragged in `regexp-tree`'s `optimizer`/`generator`/`transform` submodules. The now-redundant `_def.optimizedSource` field (always `=== source`) is dropped; codegen uses `def.source` directly. (2) **`firstSetFromRegex` moved to `src/combinators/regex-analyze.ts`** (the sole `regexp-tree` importer), reached from `regex.ts` through a `RegexFirstSetAnalyzer` injection seam (`registerRegexAnalyzer`). `index.ts` registers it as an import side-effect, so **every real code path — interpreter, JIT `compile()`, and the macro (its evaluator does `import * as parseman from '../index.ts'`) — gets byte-identical first-sets**. A consumer importing `regex` from the combinator subpath *without* the entry gets a permissive `any()` first-set (the same value `firstSetFromRegex` already returned on an unparseable pattern) — this only disables choice-dispatch fast paths, never changes a match. **Result:** `regex.ts` bundles to 2 527 B with `regexp-tree` absent; a lean `import { regex }` consumer tree-shakes it to 2 471 B / 0 B of `regexp-tree`; `index.ts` still bundles it (interpreter needs it). Full suite (1248) + typecheck pass. **Next (drop it for interpreter users too):** replace the `regexpTree.parse` call in `regex-analyze.ts` with a hand-rolled first-set parser producing the same AST shape `extractFirstSet` consumes — the injection seam means nothing else changes, and `regexp-tree` becomes a dev-only differential-test oracle.

---

## Lower priority / cleanup — `LANDED` × 2, `UNMEASURED` × 4 (U-18…U-21)

| Target | Issue | Fix |
|--------|-------|-----|
| `emitSkip` | Still uses `try/catch {}` | `emitFallible` |
| `withCtx` | `{ ..._ctx, state: … }` allocates | Save/restore `_ctx.state` |
| ASCII-only grammars | `codePointAt` in disjoint dispatch | `charCodeAt` when first-set proves BMP-only |
| ~~Dense disjoint choices~~ ✅ | ~~Long `if/else if` chains~~ | `switch` jump table when arms key off ≤48 discrete first code points; if/else kept for wide char-class arms (`emitChoice` → `planDisjointDispatch`) |
| ~~`makeWord()` at macro time~~ ✅ | ~~Expands to regex per keyword~~ | Moved to **Already landed** — `emitKeywordsFast` |
| Macro build time | Sequential `compile()` per rule | Parallel compile; cache by combinator-tree hash |

---

## Measuring — `REFERENCE`

- `pnpm bench` — external parser comparison only (Peggy, Parsimmon, Chevrotain, Nearley, Jison, native JSON).
- `pnpm bench:parseman` — Parseman interpreted vs compiled across all example grammars (with baseline Δ). For tweak loops, narrow it: `pnpm bench:parseman -- --only=json --scale=0.5 --samples=7`.
- `pnpm bench:literal` — literal-match A/B (`slice` vs `startsWith(value, pos)` vs `charCodeAt`) for interpreter `literal()` work.
- `pnpm bench:codegen` — codegen A/B micro-benchmarks.
- `pnpm bench:compile-grammars` — regenerate precompiled Peggy, Nearley, and Jison parsers in `bench/` after editing `bench/*.pegjs` or `bench/vendor/`.
- `pnpm bench:svg` — chart-only benchmarks (JSON/CSV/GraphQL/CST-JSON) + regenerate `assets/bench-*.svg` for the README. Much faster than `pnpm bench`; init bars stay pinned in `bench/chart-types.ts`.
- `pnpm bench:baseline` — refresh `bench/parseman-baseline.json` **and append** a snapshot to `bench/parseman-history.jsonl` (commit both to track the needle over time).
- `test/perf/parseman-perf.test.ts` — smoke + CSS tight speed regression guard (robust median) + full-suite gross guard (single-pass). Excluded from default `pnpm test` (heavy by design); run via `pnpm test:perf`.
- `pnpm perf:guard` — pre-commit: CSS-only robust guard (~2s). `pnpm perf:guard --all` — every grammar.
- `test/perf/codegen-ab.test.ts` + `bench/codegen-ab.ts` — within-process A/B that isolates the two codegen optimizations (machine-independent, no old-git-state needed):
  - **regex scan lowering** — a scannable `+`/`*` terminal (charCodeAt) vs the SAME grammar with `{1,}`/`{0,}` (identical matches, stays on `RegExp.exec`). Realistic many-short-token regime: **~2.3× faster**. Single very long token: scan loses to native exec (~0.3×, printed as contrast, not asserted). Uses `__setForceDisjointIf` / semantic-equivalent quantifiers so no production code changes.
  - **switch vs if/else disjoint dispatch** — same choice compiled both ways via `__setForceDisjointIf`. ~1.0× (neutral; switch is cleaner for many arms, no perf cost).
- `test/perf/css-parser.test.ts` — CSS correctness + bootstrap timing when fixture available.
- `test/parity/trivia-kinds.test.ts` — labeled trivia kind indices: interpreted vs compiled parity.
- `test/parity/trivia-log-regression.test.ts` — interpreted/compiled `_triviaLog` golden parity.
- `test/parity/compiler-capture-choice.test.ts` — capturing choice fast-path parity.
- `test/unit/codegen-output.test.ts` — snapshot guard on emitted JS shape.
- `test/parity/compiler.test.ts` — correctness after codegen changes.

**Parseman baseline** (`bench/parseman-baseline.json`): CI regression anchor — median µs/op for interpreted **and** compiled on JSON, CSV, GraphQL, TOML-ish, lang, and CSS fixtures. Updated deliberately when you accept a new perf level.

**Parseman history** (`bench/parseman-history.jsonl`): append-only time series (one JSON line per `bench:baseline`). `pnpm bench:parseman` reports Δ vs baseline plus Δc↓prev / Δc↓origin from history. `printHistoryIndex()` lists bootstrap4 compiled µs across all snapshots.

---

# Jess parser hotspots (from @jesscss render profiling) — 2026-07-05

> ⚠️ **STALE PROFILE — re-measure before trusting any number below.** This
> profile was taken `2026-07-05` against jess core `parseman 0.14.0` compiled
> grammars. It has since been partly invalidated by core changes on the SAME
> day and after — most visibly the **#2 hotspot `ensureProv` is GONE**: jess
> `2b39c8072` (2026-07-05) inlined the node span onto `Node` and killed the PROV
> WeakMap, `311cf9232` left only sparse slot-spans in flag-gated WeakMaps, and
> `cc9888e29` deleted dead provenance CST plumbing. So the #2/#3 rows are dead
> and the #1 reify (61.9%) / trivia shares can no longer be assumed to hold their
> proportions. **Numbers here are a stamped snapshot, not current truth.** Before
> ranking any idea off this table, re-run a fresh profile on current jess core —
> `run(entry, input, { profile: true })` (added parseman 0.27.0) gives the
> recognizer / structuralCapture / hostConstruction phase split; add a V8 CPU
> sample for self-time. Then correct the rows IN PLACE (strike them), don't append.

**Source of this section:** the @jesscss/core render re-profile flagged PARSE as
the #1 render hotspot (~42% of a render). Investigating *inside* the parser
subsystem (parseman 0.14.0 compiled grammars + the @jesscss builder hosts) to
find where that parse time goes, with measured evidence. **Ideas only — nothing
here has been implemented.** Owner: leave core alone; these are parser-team
candidates.

## Honesty caveat: parse-once vs parse-per-render — `REFERENCE`

`@jesscss` `Compiler.render()` **re-parses the source on every render**
(`Compiler.render` → `context.parseString(...)`; no AST cache keyed by input —
`packages/jess/src/index.ts:1026`). So the render re-profile that put PARSE at
~42% is measuring parse-per-render. Real-world usage parses a stylesheet **once**
and can render/re-render the AST many times; against a parse-once/render-many
baseline, parse's amortized share is far lower. **Treat the numbers below as the
per-parse cost, not the steady-state render weight** — they matter most for
cold-start / single-render / watch-mode-edit-a-file scenarios, and for the
`Compiler` re-parse itself (an AST cache would erase most of it, but that's a
jess-side change, out of scope for the parser team).

## Measurement setup — `REFERENCE`

- Corpus (Less): `packages/jess/benchmark/benchmark.less` — 106,802 chars,
  **12,984 AST nodes** (~8.2 source chars / node), ~8.8 MB retained AST / parse.
- Corpus (CSS): synthetic value/selector-dense sheet, 248,040 chars.
- Driver: functional Less/CSS parser (`parseLessFn` / `parseCssFn`) run under
  parseman's macro register hook (`--import scripts/parseman-macro-register.mjs`),
  V8 CPU sampling profiler (50 µs interval, 40 parses), `--trace-gc`, and the
  compiled-grammar source (via `parseman/plugin` `transform`) for static
  allocation-site counts.
- Parse median: **Less 55.6 ms** (106 KB), **CSS 58.5 ms** (248 KB).

## Aggregate self-time split (Less benchmark.less, 40 parses) — `REFERENCE`

| Bucket | self-time | % |
|--------|-----------|---|
| **reify `_r_*` (compiled grammar rule fns)** | **2400 ms** | **61.9%** |
| provenance `ensureProv` (per-node WeakMap side-table) | 280 ms | 7.2% |
| GC (garbage collector) | 277 ms | 7.1% |
| build\* (CST→AST host: `buildNode`/`_dispatchBuild`/`_build*`) | 271 ms | 7.0% |

The compiled reify layer dominates. On the value/decl-dense **CSS** corpus the
mix shifts: **GC 28.2%**, **`ensureProv` 12.5%**, reify 35.6%, `_dispatchBuild`
2.4% — i.e. the per-node allocation + side-table cost climbs sharply when nodes
are small and numerous (Num/Dimension/Color).

## Hotspot ranking with evidence — `REFERENCE`

Self-time %, from the Less CPU profile unless noted. `_r_<Rule>` = the compiled
reify function parseman emits for that grammar rule.

| # | fn | self % | where | note |
|---|----|--------|-------|------|
| 1 | `_r_value` | 6.3% | less `grammar.ts:249` region / css `grammar.ts:152` | value disjunction `choice(Dimension,Num,Color,Url,CalcCall,Call,Paren,Quoted,anyValue)` run per value token |
| 2 | `ensureProv` | 5.6% (Less) / 12.5% (CSS) | core `provenance.ts:46` | **per-node `{}` alloc + `WeakMap.set`** via `setSourceSpan` in every Node ctor |
| 3 | `_r_InterpolatedSelector` | 4.9% | less `grammar.ts:249` | `sequence(optional(regex),many(regex),lessInterp,many(choice(...)))` — two `many` arrays + interp scan per interpolated selector |
| 4 | `_r_ComplexSelector` | 3.8% | less `grammar.ts` selectors | combinator run |
| 5 | `_1533bf42__tf0` | 3.2% | compiled trivia-skip fn | whitespace/comment skip called at every `many`/`sequence` boundary |
| 6 | `_r_LessAmpersand` | 2.9% | less `grammar.ts:247` | `sequence(ampToken, optional(sequence(literal('('), scanTo(...), literal(')'))))` per `&` |
| 7 | `_r_simpleSelector` / `_r_CompoundSelector` | 2.8% / 2.2% | less selectors | inner selector-run reifiers |
| 8 | `_r_topProduct` / `_r_topSum` | 2.7% / 2.2% | less math | operation folding per value |
| 9 | `_r_PseudoSelector`, `_r_SelectorList`, `_r_AttributeSelector`, `_r_Declaration`, `_r_Ruleset`, `_r_Dimension`, `_r_Call`, `_r_Reference`, `_r_valueList`, … | 0.9–2.5% ea. | grammar | the long reify tail — collectively the bulk of the 61.9% |
| 10 | `buildNode`/`_dispatchBuild`/`_buildLessDeclaration`/`_buildDeclaration` | ~7% combined | less+css `builders.ts` | CST→AST host; per-node `loc` + filtered child arrays |

### Static allocation-site counts in the compiled Less grammar (3.99 M chars emitted) — `REFERENCE`

| pattern | count | meaning |
|---------|-------|---------|
| `const _arr = []` | 465 | a fresh array per `many(...)` / repetition, even when 0–1 matches |
| `.push(` | 2520 | per-child CST collection |
| `.build(` | 207 | AST node construction call sites |
| `_cstRawChildren?` length marks | 1810 | CST raw-child bookkeeping |
| `_cstLeaves?.` length marks | 1052 | CST leaf bookkeeping |
| `_triviaLog?` length marks | 1105 | trivia-log bookkeeping |
| `charCodeAt` | 5213 | scan sites (mostly fine; noted for scale) |

`--trace-gc` shows a Scavenge roughly every ~33 ms during a parse loop
(reclaiming ~58 MB each) — confirming the transient CST allocation is the GC
driver, on top of the ~8.8 MB retained AST.

## Optimization IDEAS (evidence-backed)

Per-item markers, in list order: #1 `LANDED` (dead-value part) + `UNMEASURED` (U-22) · #2 `LANDED` + `UNMEASURED` (U-23) · #3 `LANDED` by core, the idea itself moot · #4 `UNMEASURED` (U-24) · #5 `REJECTED` (scoped; ceiling well under 3.2%, no free redundancy) · #6 `REJECTED` (dispatch already fires; the residual is §7a) · #7 `REJECTED` (built as `precedence()` on branch `perf/precedence-collapse` and A/B'd: 4× only over a trivial operand, noise on the real grammar).

1. **Reify per-`many` array pre-sizing / lazy alloc.** Every `many(...)` emits
   `const _arr = []` then `.push()` per match (465 arrays, 2520 pushes in the Less
   grammar). For the *common* selector/value runs the arity is 0, 1, or 2. IDEA:
   emit a lazy/scalar fast path in `emitMany`/`emitSequence` — keep a single-element
   scalar until a 2nd match forces array promotion. Sub-idea: when a `many` feeds
   directly into a `.build()` whose builder only iterates, pass the CST child cursor
   range (start/end indices into a shared buffer) instead of materializing a fresh
   array — no intermediate array at all.

   **⚠ MEASURED OUTCOME (2026-07-05): the *dead-value* subset of this — eliding the
   aggregate array/tuple of a `many`/`sequence`/`optional` whose value is only ever
   discarded under a `node()` — has LANDED (parseman `markUnusedValues`, both the
   interpreter and the compiled emitter; see `src/compiler/value-usage.ts`). On the
   real macro-compiled Less grammar it cut `const _arr = []` 258→172 (−33% of the
   value arrays) but moved transient allocation only 47.3 → 43.9 MB/pass (~7%) and
   parse time NOT AT ALL (57 ms both). So the value-array building is NOT the 61.9%
   — it is a small slice of allocation and off the hot CPU path. The reify self-time
   is dominated by choice dispatch, trivia-skip, and CST-buffer bookkeeping (see #2,
   #5, #6), NOT array construction. Do not expect a big win from the remaining
   lazy/scalar-promotion part of this idea either.** The full lazy/scalar promotion
   would only help the arrays that ARE consumed-but-tiny; given the dead ones gave
   ~7% alloc / 0% time, size the expectation accordingly.

2. **Pool/reuse the CST bookkeeping marks.** ~3967 `_cstRawChildren?` /
   `_cstLeaves?.` / `_triviaLog?` length-mark reads per compiled grammar, each a
   property-existence check + length read at every rule entry/backtrack point.
   IDEA: hoist the three length snapshots into locals once per rule frame
   (many are re-read inside the same `many` loop body), and/or skip the
   raw-children/leaf tracking entirely for rules whose builder never consults
   `rawChildren` (a compile-time flag per `node()` — many builders use only
   `children`). This is the parseman-side complement to the `_dispatchBuild`
   host cost.

   **⚠ LARGELY LANDED (verified in `src/compiler/codegen.ts`, 2026-07-11) — do not
   treat as an available "cheap, broad" win.** Both halves of this idea now exist:
   the **skip** half is `armNeedsRollback = ctx.capturing && (mayLeavePartialCapture(p)
   || (armHasAutoNot && capturesLeaf(p)))` (`codegen.ts:1387`) — the leaf/raw/trivia
   marks are only *emitted* when the arm can actually leave a partial capture — plus
   the builder-consults-it gates `capturesTrivia`/`buildReadsTrivia` and the runtime
   `_hostReads(build, n)` arity probe and the per-type `_parsemanCaptureTrivia` hook.
   The **hoist / don't-read-`?.length`-4×-on-the-hot-path** half was also already
   done and is documented in the `captureRestoreBody` comment (`codegen.ts:564-583`):
   the exact regression this idea fears ("reading `_x?.length ?? 0` four times per
   fallible block … compiled CSS regressed ~2.3×") was found and fixed by gating the
   whole save/restore on a single boolean and only reading when a buffer is live.
   What remains unlanded is a marginal intra-frame **buffer-reference** hoist (`const
   _rc = _ctx._cstRawChildren` to cut repeated `_ctx.` reads) — but the length itself
   mutates as children push, so only the *reference* is hoistable, and it only touches
   the **cold CST-capture path** (most runtime callers request only the value, no CST).
   Micro-opt, not the broad lever the ~3967-count implied.

3. ~~**`ensureProv` per-node allocation (2nd-ranked; 5.6%→12.5%).**~~ ✅ **FIXED BY
   CORE — do not chase.** The profile above (2026-07-05) caught the OLD shape:
   every node did `ensureProv(node)` → allocate a `{}` Provenance + `WeakMap.set`,
   12,984 allocs + WeakMap inserts/parse, and it was the #1 GC driver. **That was
   re-architected the same afternoon.** jess `2b39c8072` ("inline source-span
   provenance onto Node, kill PROV WeakMap") moved the node-level span to inline
   monomorphic Node fields (`_spanStart`/`_spanEnd` + `F_HAS_SPAN` bit); `311cf9232`
   left only the SPARSE per-slot value/field spans in flag-gated WeakMaps. The `{}`
   alloc and per-node WeakMap insert are gone; `ensureProv` no longer exists. The
   inline-fields solution is strictly better than the "defer / dense-array-by-index"
   idea this entry used to propose — that idea is moot. **Lesson: this hotspot's
   numbers here are stale; re-profile current jess core before ranking provenance
   against anything.** (Core owner already handled it; nothing for the parser team.)

4. **`buildNode` host: kill the per-node `loc` object and per-build filtered
   arrays.** `_dispatchBuild` calls `spanToLocation(span)` → `{start,end}` per
   node (12,984/parse), and `nodeChildren`/`leafText` do `children.filter(...)`
   (fresh array) per build (css/less `builders.ts:102-113,366`). IDEA: pass
   `span.start`/`span.end` as two numbers into the node ctors (no wrapper
   object), and replace `.filter()` child partitioning with a single pass that
   the reifier already knows the shape of (the grammar knows which children are
   leaves vs nodes at compile time — emit typed positional access instead of a
   runtime filter). This is a jess-builders change but is driven entirely by how
   parseman hands children to `ctx.build`, so it's worth co-designing.

5. ~~**Trivia-skip fn (`_tf0`, 3.2%) call-site reduction.**~~ ⚠️ **EXPLORED
   2026-07-16 — real but SMALL, no free redundancy; deprioritized.** Read the
   compiled less grammar (`@jesscss/less-parser/lib/grammar.js`): 394 `_tf0` call
   sites. Findings: (a) **no double-skip** — rule bodies do NOT skip leading trivia
   on entry (they open with the per-`node()` capture-frame setup, not `_tf0`), so
   the caller's skip + a rule-entry skip never stack; (b) **no back-to-back `_tf0`**
   anywhere, so no adjacent-redundant-skip to delete; (c) the elidable subset is
   narrow **because CSS/Less are whitespace-permissive** — trivia is legal at nearly
   every boundary, and the genuinely-glued spots (number→unit, `::`, `funcname(`)
   are already single regexes or (post-§7a) `noTrivia`-wrapped, which already omit
   the call. Per-call empty-path cost is low (call + 2–3 `charCodeAt` + return). Net
   ceiling is well under the 3.2% (most of which is calls that DO skip real trivia).
   Capturing even the tail needs manual `noTrivia` (author work) or an automatic
   trivia-forbidden first-set proof (real feature + soundness burden). **Not worth
   prioritizing ahead of §7a.** Same conclusion applies to Q-40 candidate #3
   ("explicit no-trivia boundaries"). **Two bigger things seen while reading:**
   (i) the per-`node()` capture-frame header (6 ctx-field saves + buffer installs +
   `_hostReads`/`_parsemanCaptureTrivia` gate computations, ×~22.6k nodes) is the fat
   part of node entry — this is the "per-node scope save/restore" lever flagged as
   unmeasured in [[zero-copy-range-builder-negative]], higher-risk (adjacent runtime-
   indirection attempts measured +32–50%, see §2), but where capture-phase time
   actually is; (ii) the 0.27.0 profiling boundary's per-node `_ctx._pmProfile?.phase`
   reads were **hoisted** (commit 4621ed6) to one `_ctx._pmProfile` read + two reused
   boolean locals (`_rec`/`_cap`) per structural node, so the off-profile path pays one
   read + two short-circuiting compares instead of ~8 optional-chain reads. Measured
   effect: bootstrap4 compiled +2% → ~0% (amortized case); tiny µs cases unmoved (they
   were a stale-baseline artifact, not per-node profile cost).

6. ~~**`_r_value` disjunction ordering / first-char dispatch.**~~ ✅ **ANSWERED
   (verified 2026-07-16) — dispatch IS firing; residual = §7a, not dispatch.**
   Read the actual compiled value choice in BOTH `@jesscss/css-parser/lib/grammar.js`
   (monolithic) and `@jesscss/less-parser/lib/grammar.js` (composed/fused): each arm
   is first-char guarded off one `codePointAt` (`_chcode`), 0 unresolved `@FS`
   placeholders — the fuse-time first-set dispatch shipped on parseman release/0.15.0
   (~30% jess win) is working end-to-end. Disjoint arms (`Color` `#`, `Quoted`,
   `Paren`) are correctly skipped. The ONLY residual waste is the OVERLAPPING arms:
   Dimension and Num carry the **identical** guard (`43 || 45..46 || 48..57`), so a
   unitless number passes the Dimension guard, enters+fails `_r_Dimension`, then
   enters `_r_Num` — the double-entry §7a fixes. First-char dispatch structurally
   CANNOT separate same-first-char arms; only §7a common-prefix factoring can. So
   there is no "sub-dispatch keyed on the char after the numeric run" to add here —
   the fix is §7a's structural collapse. (CalcCall/Call is the same story on the
   ident-led arms — §7 idea #2.) See [[macro-firstset-dispatch-unsound]].

7. **Value / math-expression precedence-chain descent cost (operator-precedence rules).**
   *Parked — a bounded constant-factor parse win, not the dominant scaling cost.*

   **Evidence (distinct from the `benchmark.less` profile above).** A controlled
   CPU profile (`node:inspector`, 50 µs sampling interval) of **jess-alpha
   `bb3b31863` compiling the real Less `functions.less`**, compared against
   Less 4.6.7, ranks the value-expression grammar rules very differently from the
   `benchmark.less` run in the hotspot table (§ "Hotspot ranking with evidence",
   where `_r_value` was #1 and `_r_topProduct`/`_r_topSum` sat at #8, 2.7%/2.2%).
   On this value/function-heavy file:

   - **`_r_topSum` (grammar.js) and `_r_topProduct` are the #1 and #2 hottest
     self-time functions in the *entire* jess compile.** `_r_value` and the
     condition-arg rules (`_r_CondArgAndOp` / `_r_CondArgAnd` / `_r_CondArgTermOp`)
     are close behind.
   - On value/function-heavy Less this value-expression grammar is **~30–40% of
     parse time** (and parse is ≈ 60% of a small-file compile).

   This is workload-dependent: the same rules are a modest slice on selector-heavy
   `benchmark.less` but dominate on value-dense `functions.less`.

   **What the cost actually is (NOT backtracking).** The precedence chain is
   `sequence(base, many(sequence(opParser, base)))` stacked N levels deep — the
   `leftAssoc` shape, identical to this repo's `examples/lang/parser.ts` (7 levels:
   `unary→mul→add→cmp→eq→and→or`). On the overwhelmingly common **bare value with no
   operator**, a token descends *every* level, and at each one pays: enter a
   rule/node scope, allocate an empty `_arr` for the `many`, try the operator
   `choice` (fails on the **first char**), then fold the transform over an empty
   `rest`. That is a **fixed-depth descent with a single failed first-char lookahead
   per level**, not retry/backtracking — each position is parsed at most once on the
   success path. It tops the profile because it runs once per value token on
   value-dense input (O(tokens)), not because of superlinear re-derivation. The cost
   is the per-level node scope + empty-array + fold — the same reify/CST-bookkeeping
   story as #2/#5, restricted to the value path.

   **Why parked (not urgent).** Parse cost is roughly **LINEAR** in input size
   (~6–7× Less 4.x, and flat) — so this is a bounded constant-factor win, not the
   dominant scaling cost. The dominant scaling cost is eval, not parse (see the
   cross-reference below). Worth doing eventually; not the strategic lever.

   **Directions to explore (options, not prescriptions):**

   - **Collapse the no-operator level — the real lever.** When
     `many(sequence(opParser, base))` provably matches zero times (the operator
     `choice`'s first-char set is absent) and the level's transform is identity on
     the single-operand case, the whole level should collapse to its `base`: no node
     scope, no empty `_arr`, no fold. This is **§2.3 "compile-time transparent-wrapper
     elimination when `buildSrc` is `(c) => c[0]`"** combined with a first-set-guarded
     no-op `many` elision — a pure shape-collapse guarded by first-set disjointness
     (the same proof discipline §8 already uses), reusable across *every* precedence
     grammar, not jess-specific.
   - ~~Memoize / packrat the descent to cut backtracking.~~ **Rejected direction** —
     there is no re-derivation at a position to memoize; a clean precedence descent
     visits each position once per level. A memo table would put per-position writes
     on a path that already visits each position once → net-negative, exactly the
     "helper prelude / table indirection" class measured at **+32–50%** in §2. Don't.
   - Profile whether the condition-arg rules (`_r_CondArg*`) can **share** the
     value descent instead of re-deriving it.
   - Compare against **Less 4.x's** cheaper `expression` / `operand` / `addition`
     scanner approach. Note that Less 4.x's parser matches regexes against source
     slices and builds the AST directly (**no separate CST-capture layer**), which
     is a large part of why its value/math path is far cheaper in absolute terms —
     any parseman equivalent still pays the CST-capture bookkeeping (§2, §5).

   **Local measurement target.** The jess-alpha profile isn't reproducible in this
   repo, but `examples/lang/parser.ts` has the identical 7-level `leftAssoc` chain
   and is value/expression-heavy — use it (not the retired alpha) as the in-repo A/B
   for any implementation of the level-collapse above.

   **Cross-reference.** This is the **parse-side** lever. The bigger strategic
   target is the **eval-side** allocation/GC gap (~85× Less 4.x), which is being
   worked separately on the jess core side (object-reduction / spine render
   architecture) — not here.

   ---

   **TESTED — negative result (2026-07, branch `perf/precedence-collapse`, not landed).**
   Built the level-collapse as a real, shared-tag `precedence()` combinator (both the
   interpreter and codegen recognize `{ tag: 'precedence' }`) and A/B'd it against the
   existing `leftAssoc` shape on the real `examples/lang` grammar. **It does not help.**

   *The shape built.* A precedence-table combinator, tightest-row first, stacking
   handled internally so the ladder reads declaratively:

   ```ts
   precedence(unary, [ ['*','/'], ['+','-'], ['<=','>=','<','>'], ['==','!='], ['&&'], ['||'] ])
   ```

   Bare op strings auto-wrap to `literal`; a default combine builds
   `{ type:'binary', op, left, right, span }` (per-node spans — a correctness upgrade
   over `leftAssoc`, which stamps every node with the whole-chain span). Designed row
   vocabulary: `assoc:'left'|'right'|'none'` and `mixing:false` (homogeneous run — the
   jess/media `and`/`or`-can't-mix rule) and `{ prefix:[…] }` (unary, e.g. `not`, `-`).
   Only left-assoc infix was implemented (enough to A/B). Both paths guard the loop on
   the operator's first-set, so the no-operator case returns the operand directly — no
   array, no `combine` — with identity-on-empty true **by construction** (no sentinel
   probe needed). Correct: interpreter ≡ compiled structurally, full suite green.

   *Why it doesn't help — the measurement.* The scaffolding the collapse removes (the
   `sequence` tuple + empty `many` array + fold) is **not** the per-level bottleneck on
   a realistic grammar:

   | scenario | leftAssoc | precedence | result |
   |---|---|---|---|
   | synthetic chain, no trivia, **trivial `ident` operand** | 123 ns | 29.5 ns | 4.2× |
   | **real lang grammar**, no trivia | 17.7 µs | 18.3 µs | 0.96× (noise) |
   | real lang grammar, trivia on | 32.3 µs | 32.0 µs | 1.01× (noise) |

   The 4× only appears when the operand is a **straw** (`ident`), which inflates the
   scaffolding's share. With a realistic operand (`unary→call→atom→ident`), parsing the
   operand dwarfs the per-level array/tuple/fold, and V8 escape-analyzes the scaffolding
   away regardless. Trivia scanning per level piles on identically for both shapes.

   *Correction to the framing above.* The "§2.3 transparent-wrapper elimination +
   first-set no-op `many` elision" lever is real but its payoff is bounded by *operand
   triviality*, not just chain depth — and real operands are never trivial. The profile's
   `_r_topSum`/`_r_topProduct` #1/#2 self-time is therefore most likely **inlined-operand
   time attributed to the fold frame**, or genuine operator-dense folding (which both
   shapes do equally), **not** removable no-op scaffolding. Do not re-chase this as a perf
   lever. (`precedence()` may still be worth having as an ergonomics/correctness feature —
   readable table, correct per-node spans — but that's a DX decision, not a perf one.)

   *Method lesson.* A single A/B on the **real grammar** answers "does it help?" in one
   step. Microbenchmarks that model the *mechanism* (here, a chain over a trivial operand)
   share confounds and gave three false positives before the real grammar exposed them.
   Measure the real thing first; drop to microbenchmarks only to *explain* a real delta.

### Top ideas in one line each — `REFERENCE`

- **#1 lazy/scalar `many` in the compiled reifier** — ⚠ the dead-value part landed
  and measured at only ~7% alloc / 0% time; array building is NOT the 61.9%. Not
  the big lever. The real reify cost is dispatch + trivia + CST bookkeeping (#2/#5/#6).
- **#2 hoist/skip CST length-mark bookkeeping** for builders that ignore
  `rawChildren` — ⚠ **largely LANDED** (`mayLeavePartialCapture`/`capturesTrivia`/
  `_hostReads` skip + the single-boolean save/restore gate in `codegen.ts`); only a
  cold-path buffer-reference hoist remains. NOT an available cheap/broad win.
- ~~**#3 defer/dense-array `ensureProv`** — 12,984 per-node `{}`+WeakMap inserts is
  the 2nd hotspot and the main GC driver (worse on CSS: 12.5%).~~ ✅ **DONE BY CORE**
  — jess `2b39c8072` inlined the node span onto `Node` (monomorphic fields +
  `F_HAS_SPAN`), killed the PROV WeakMap; only sparse slot-spans remain (flag-gated).
  `ensureProv` deleted. The dense-array idea is moot — inline fields beat it. (verified 2026-07-16)
- **#4 drop per-node `loc` object + filtered child arrays in `buildNode`.**
- **#7 value/math precedence-chain descent** (`_r_topSum`/`_r_topProduct`) — #1/#2
  self-time on value-heavy Less (`functions.less`); ~30–40% of parse. Fixed-depth
  descent + one failed first-char lookahead per level (NOT backtracking). ❌ **TESTED
  and SHELVED** (branch `perf/precedence-collapse`): built as a real `precedence()`
  combinator; the collapse is 4× only over a *trivial* operand, noise on the real
  grammar (real operands dominate; V8 eats the scaffolding). Not a perf lever — see
  the TESTED block under §7. Don't re-chase.
- Remember the **parse-once/render-many** caveat: an AST cache in `Compiler` (jess
  side) would amortize all of the above for the common re-render case.

## Q-40 follow-up queue: fresh Parseman-versus-Less flow evidence — `REFERENCE` header

Added 2026-07-14 after tracing the generated Parseman flow against Less 4.x.
This section is a ranking and an agent handoff, not an implementation claim.
The current detailed phase baseline is Parseman recognizer-only `12.784 ms`,
structural capture `28.873 ms`, and CSS-CST host construction `37.558 ms`,
versus Less 4.6.3 native AST parse `4.417 ms` on the same 106,797-byte fixture,
Node v24.11.1, 12 warmups, and 45 samples. A later equal-contract run measured
Parseman recognizer-only `12.58 ms` and Less parse `6.01 ms`; reconcile the
fixture/node-count difference before treating either as a new gate.

The important attribution is that Parseman's current "recognizer-only" mode is
the normal generated structural parser with output suppressed at runtime. It
still executes structural collector save/install/restore, profile/output
branches, rollback checks, trivia checks, and named-rule call ladders. That is
generic Parseman work. Less's mutable cursor/save stack is part of its lower
cost, but Less also benefits from declaration-before-ruleset dispatch and a
raw `anonymousValue()` path taken by 2,024/2,902 benchmark declarations
(69.7%). Those latter choices belong to the Less grammar/host, not Parseman.

### Experimental result — compile-time stripped recognizer (2026-07-15; unpublished) — `QUEUED` (U-25; measured positive in isolation, jess adoption `REJECTED` for now, branch never pushed)

The first generic implementation proof now exists on local branch
`feature/true-recognizer-20260715`, commit `c84d777`. It adds an opt-in
`compile(..., { mode: 'recognizer' })` code-generation contract that emits only
acceptance, end-offset, and failure-cursor data. It removes collector
setup/restore, CST/raw/trivia/field capture, host/node construction,
output-only profile branches, dead output temporaries, and output-state
cloning, while retaining lookahead, guards, context operations, rollback,
consumed offsets, and diagnostics. This is generic Parseman behavior; it does
not know about CSS, Less, or comments.

The isolated equal-contract result was positive: JSON-like input improved
`0.180875→0.095291 ms` (`−47.32%`) and the real `106,802`-byte Less grammar
improved `7.38425→5.534 ms` (`−25.06%`), with p95 and GC neutral-or-better.
Focused contract coverage was `39/39`, perf coverage `5/5`, and typecheck,
build, and lint passed. The full Parseman suite still has the unrelated
baseline source-shape failure at `test/unit/build-arity.test.ts:116`
(`1,735` passed, `1` failed). The branch could not be pushed because SSH
credentials were unavailable; no published package or default parser behavior
changed.

Jess adoption was tested separately and rejected for now: the disposable
candidate reduced parse+render by `4.95%` but increased render-only by `1.09%`,
and the current Jess grammar does not opt into the recognizer mode. Both
phases were byte-identical at `131,578` bytes (SHA-256
`98a0536086c7e555b1a98e2372ad4000d51e25f1418c6345b6b8a9a97d80972f`). Keep
this as an unpublished architecture proof, not as a Jess or Parseman release
claim. (It was once framed as not replacing "the zero-copy structural-builder
target below" — but that target has since been built through the fused path and
measured neutral; see candidate #2, now shelved.)

### Ranked candidates

Per-item markers: #1 `QUEUED` (U-25) · #2 `MEASURED-NULL` (built end-to-end through the fused path, array ≈ range on both time and heap; **do not ship**) · #3 `REJECTED` (same scoping as §5) · #4 `LANDED` (4a, `e4936d8`) + `UNMEASURED` (U-26, U-27) · #5 `UNMEASURED` (U-28) · #6 out of scope — jess-side, `REFERENCE` · #7 `REFERENCE` (a directive, not an item).

1. **Compile-time output-contract variants — highest generic leverage.**
   Generate separate recognition, ordinary-value, structural-capture, and
   host-building variants from one grammar, instead of making every generated
   rule test a runtime phase flag. The recognition variant should omit
   collector setup, CST/raw/trivia buffers, host calls, node construction,
   profile branches, and output-only state cloning while retaining lookahead,
   guards, context operations, rollback, consumed offsets, and diagnostics.
   This is the clean generic answer to the proven structural-protocol cost; it
   must not know anything about CSS, comments, or Less values. It is a parser
   architecture experiment, not permission to weaken the existing capture
   contract.

2. **Zero-copy structural builder input — ❌ TRIED THROUGH THE FUSED PATH; NEUTRAL, DON'T SHIP.**
   The real profile's largest avoidable family is per-node CST/raw-child
   materialization, not value arrays: raw/child/trivia bookkeeping was measured
   as a 28–51% ceiling in isolated capture probes, while dead value-array
   elision produced about 7% allocation relief and 0% parse-time change. The
   idea was an opt-in generic builder contract that pushes children onto a
   shared arena and hands the host a windowed `CstRangeView` instead of
   allocating a fresh `children`/`rawChildren` array per node.

   **This was built end-to-end and measured neutral.** Branch
   `feature/parseman-zero-copy-builder-20260715` (worktree
   `/private/tmp/parseman-zero-copy-builder-20260715`) carried it past the POC:
   `950e8b4` prototype range builders → `53a5bfb` arena-as-stack (killed the
   POC's 4 wrapper objects/node) → `04c0573` **wired the range runtime through
   the `compileLinkable`/fused path** (closing the "Jess adoption blocked, proof
   only wires `compile()`" gap this entry used to name) → `b395706` widened
   `CstRangeView` to the array-read methods real hosts use (filter/map/find/
   some/slice/iterator).

   **The earlier "parse-time win" was a measurement artifact — do NOT trust the
   old `10.97 ms → 4.35 ms` number.** That was a single-process A/B: array mode
   ran first and made the host's `children.filter(...)`/`.length`/`for..of` call
   sites monomorphic for `Array`, then range mode fed them a `CstRangeView` →
   megamorphic deopt/recompile. Whichever mode ran **second** ate the penalty;
   the delta followed run-order, not the representation. Redone correctly
   (separate process per mode, bootstrap4.css, 22.6k nodes, 3 runs): **array
   ~26.9 ms vs range ~26.8 ms (indistinguishable), transient ~50 vs ~51 MB
   (indistinguishable).** The "−13% memory" claim was the same single-process
   GC-timing artifact.

   **Why it's structurally neutral (not just noisy):** phase decomposition is
   recognize 34% / capture-bookkeeping 30% / host-builder 36%. Zero-copy only
   removes the array-alloc *slice* of the 30% capture — and per the dead-value
   elision finding, array building is ~0% of capture **time** (the cost is
   trivia/raw/span bookkeeping). There is no time sitting in those arrays to
   reclaim, so even a perfect `(buffer, start, end)` primitives contract can't
   beat neutral. **Verdict: do not ship** — not because it regresses, but
   because a provably-neutral feature with real added surface (arena lifecycle,
   view/primitives contract, builder rewrites) is complexity for nothing. The
   branch stays as an architecture reference, not a shippable path.

   *Caveat on "tried": this settles the range-view-through-the-fused-host shape.
   A different shape — e.g. partition-at-capture so builders skip the
   `filter(isLeaf)`/`filter(isNode)` split — was separately sized and is also a
   small, **conditional** prize (breaks builders needing ordered interleaved
   `children[i]` access), so it's declined on the no-conditional-wins rule, not
   because it was benchmarked. The one clean bit there is a Jess-side
   single-pass-builder fix (~0.6–1 ms), which needs no Parseman change.*

3. **Explicit no-trivia boundaries — safe call-site reduction.** Add a generic
   `noTrivia`/adjacent-token contract (or equivalent grammar metadata) that
   lets codegen omit the trivia-skip call where whitespace/comments are
   semantically forbidden. Do not infer this from CSS or from a weak first-set
   guess. Prove the boundary in interpreter and compiled modes, including
   comments and rollback failures. The current `_tf0` profile share is about
   3.2%, so this is a bounded follow-up, not the primary capture fix.

4. **Capture-plan specialization.** Replace the remaining per-node runtime
   feature checks with a compile-time capture plan describing whether a node
   needs semantic children, raw children, trivia, fields, state, and rollback
   marks. This should consolidate the already-landed arity/trivia gates rather
   than add another hook or reflection path. Measure generated code size and
   both capture and non-capture parses; do not land a frame object or side map
   without a whole-parser A/B.

   #### 4a. SCOPED 2026-07-16 — the per-`node()` scope save/restore (the last unmeasured capture lever)

   **Target (concrete):** `emitNode` (`src/compiler/codegen.ts:2134-2171`) emits, per
   `node()`, an **unconditional** save of 6 `_ctx` fields (`_sc/_sl/_sr/_st/_stl` +
   `_smk`), an install of fresh capture buffers, and a restore of all 6 on exit — so
   ~12 `_ctx` property ops **per node × ~22.6k nodes/parse**. Confirmed by reading the
   compiled less header (every `_r_*` opens with exactly this). This is DISTINCT from
   (and unaffected by) the already-gated **fallible-block** restore (`captureRestoreBody`,
   `codegen.ts:597-644` — "gate the whole save/restore on a single boolean"): that fix
   covers sequence-term rollback, NOT the node-scope frame.

   **Rule OUT first (don't re-chase):** the two array allocs (`_ch`/`_raw`) are ~0% time
   ([[dead-value-elision-landed]]); the gate computations are memoized (`??=`) so cheap
   after node 1; profile-phase checks short-circuit off-profile. The only candidate cost
   is the 6 saves + 6 installs + 6 restores themselves.

   **Direction (the ONLY safe one):** a compile-time capture-plan that emits **fewer
   save/install/restore lines** for a node whose SUBTREE provably never touches a given
   field — e.g. a leaf whose subtree never trivia-captures skips `_st/_stl/_smk`; one
   whose subtree never reads rawChildren skips `_sr`. This is compile-time line-selection,
   **NOT** a runtime frame object / depth-indexed stack — that shape was rejected TWICE
   (§2: +50% and +32-47%), and "eager `[],[],[]` beat branchy indirection." Runtime
   indirection is off the table; only emitting-less-code is on it.

   **Soundness burden (the real cost):** "node N needn't save field X" requires proving
   **no descendant rule reachable from N modifies X** — a whole-subtree reachability pass
   over the grammar (does the subtree contain any `node()`/trivia/field-capturing construct
   that writes X?). Conservative default: save unless proven-clean. Composed grammars
   complicate it (an overridden rule's subtree can change) — must resolve at fuse time like
   the §FS first-set dispatch, or stay conservative across compose boundaries.

   **FIRST MEASUREMENT DONE (2026-07-16, additive method) — real but small; magnitude
   unconfirmed.** Isolated worktree `perf/measure-nodescope`: added N extra redundant
   save/restore roundtrips per `node()` behind a flag, A/B'd via `run(compiledCss,
   bootstrap4.css, { profile: true })` structuralCapture.ms (18,458 nodes). Result: a
   **clear, monotonic, non-DCE'd slope** — the frame is genuinely executed work, NOT the
   sub-noise nothing that zero-copy/trivia-elision were. Rough size from the low-rep slope:
   one ~10-op roundtrip ≈ 0.1–0.15 ms/parse → the real ~18-op frame ≈ **~0.2–0.3 ms ≈ ~3–4%
   of the ~5.5 ms capture-mode parse**. **Caveats (why this is upper-bound-ish, not a
   verdict):** (1) the additive method inflates via function-size bloat — at high reps V8
   deopts the bloated rule fns and the slope runs 3–4× the true op cost, so only low-rep
   points are usable; (2) the box was contended (absolute times drifted 5→18 ms across the
   session); (3) a subtractive test (a `structural &&` guard bug made the first passes emit
   0 blocks — every "delta" there was noise between identical binaries; caught by grepping
   the generated source for the marker). **So: signal is real, ~low-single-digit %, but the
   number needs the SOUND method.** Step 2 = the SUBTRACTIVE prototype on a QUIET machine:
   actually skip the save/restore where a subtree proves it unused and measure the DROP (no
   bloat confound). **Prior revised from LOW → "worth the real prototype"**: unlike the dead
   levers, there's measurable time here. **Kill condition unchanged:** if the sound
   subtractive measurement lands sub-1%, drop it. See [[zero-copy-range-builder-negative]]
   (flagged this exact lever as "one unmeasured possibility that could still matter").

   **THE KEEP/TOSS GATE IS THE JESS PARSER PERF TESTS — not this parseman proxy.** The
   `examples/css` number above is a MOTIVATOR only. Two reasons it can't decide it: (1) it's
   the `compile()` MONOLITHIC path, but Jess runs `compileLinkable`/fused — those diverge
   (see the zero-copy saga); (2) it's a synthetic proxy grammar, and the standing rule is
   measure on real Jess, not a synthetic best case ([[feedback-no-conditional-wins]]). So the
   decision A/B is: land the subtractive frame-elision in the parseman worktree Jess links to,
   then run Jess's own parser perf suite — `@jesscss/css-parser/test/bootstrap-baseline.test.ts`
   + `test/bench.ts` (and `@jesscss/core/test/perf-compare.test.ts` for whole-render context) —
   before/after, on a quiet machine, NOT concurrently with any agent compiling Jess ([[jess-parseman-link-coupling]]).
   Keep only on a real Jess parse-time win with no render regression; otherwise toss.

   **✅ BUILT + INTEGRATED-BENCHED — KEEPER (2026-07-16, commit e4936d8).** Implemented as
   `parserHasTriviaSite` (conservative walker in `fields.ts`) gating the `captureTrivia`/
   `_cstTriviaLog`/`_triviaCaptureMask` save+install+restore in `emitNode` for bare-terminal
   nodes. **No-regression PROVEN deterministically** (not timing): generated-code diff baseline-
   vs-change across all 5 example grammars is *remove-or-byte-identical* — 0 additions anywhere,
   only bare-leaf trivia-frame writes removed; css −522 B, csv/json/graphql/lang byte-identical.
   Interpreter untouched by construction (diff is codegen-only; `node.ts` runtime unchanged).
   **Parseman suite 1719/1719 green** (CST byte-identity parity incl.). **Compile size same-or-
   smaller** (never larger). **Integrated Jess bench** (`pnpm bench` = shipping macro-compiled
   `parseCssFn`/`parseLessFn` via the macro register, min-of-100 over real corpora, PM_NO_ELIDE
   A/B, min column — contention-robust): **CSS ~2–4% faster** (235 files; base min 12.71/12.34/
   12.18 → elide 12.25/11.70/12.16, faster in 3/3 pairs), **LESS ~neutral** (base min ~37.7–41.4
   → elide ~37.6–38.3, within noise — less parse is dominated by non-leaf work: vars/ops/mixins).
   Net: real modest CSS win, neutral Less, zero regression risk. The jess test path DOES run
   macro-compiled (`vitest.config.ts` → `parseman.vite()` compiles grammars imported
   `with { type: 'macro' }`), so this is exercised end-to-end. **Note:** absolute bench medians
   were noisy (contended machine — a stale Jul-7 saved baseline shows spurious "9–52% slower");
   only the min-of-N A/B is trustworthy. **Follow-on:** extend the elision to the interpreter's
   `node.ts` frame (same soundness proof) and to the `_cstRawChildren`/`_ch`/`_raw` half where a
   subtree proves no child capture — bigger prize, more analysis.

5. **Host-boundary allocation contract.** Keep this explicitly parser-adjacent,
   not a generic Parseman semantic change: measure an opt-in builder path that
   receives span start/end numbers instead of a per-node `loc` object and uses
   positional/range access instead of `children.filter(...)`. The profile
   attributes roughly 7% combined to `buildNode`/dispatch/host work. This needs
   Jess/CSS host ownership and exact AST/output/CST parity, so it should follow
   the generic range experiment rather than be mixed into it.

6. **Late value materialization and Less dispatch.** Keep this outside Parseman:
   test declaration-before-ruleset candidate ordering and broaden Less's
   authored scalar/opaque-value path for colors, decimals, units, and multi-token
   values with explicit type tags. This is potentially valuable for Jess but
   cannot be used to justify a generic Parseman optimization or a string-only
   parser contract.

7. **Do not prioritize more regex lowering or value-array cleverness.** Regex
   execution is only about 2.6% of the measured CSS parse, and prior keyword/
   escape-identifier lowering moved whole-parse time by 0%. Dead-value array
   elimination already measured allocation relief without parse-time movement.
   These remain valid future work only when a new profile identifies a target.

### Host-integration proof — `LANDED`, and it is what settled the neutral verdict

The host-integration proof this section used to request as future work **was
carried out** (commits `04c0573`/`b395706` above): the range-view runtime was
wired through the actual `compileLinkable`/fused host contract used by Jess and
A/B'd on the real Jess CSS/Less host. Under a correct separate-process
methodology the parse-time "win" did **not** survive — it was array-vs-view
inline-cache poisoning in a single process — and the array/range paths are
indistinguishable on both time and transient heap. That is precisely why
candidate #2 above is now shelved rather than promoted. Do not re-run this as an
open question; the answer is neutral.

Any future agent must NOT re-propose as new wins: this range-view/zero-copy
builder (settled neutral through the fused path), partition-at-capture (small +
conditional), the rejected trivia-call guard, the recognizer-only node-frame
bypass, the raw-child alias proof, the precedence-chain collapse, or a
CSS-specific comment mode. Landed gates to compose with, not reinvent, live in
`src/compiler/codegen.ts`: `capturesTrivia`, `buildReads*`,
`mayLeavePartialCapture`, and the rollback marks.

## Jess builder-host proposals (from jess `docs/future/parseman-perf-proposals.md` — reshaped/corrected)

Per-bullet markers, in order: comment-lift `LANDED` · children/rawChildren collapse `QUEUED` (U-29) · `_tf0` (b) `QUEUED` (U-30), (a) `REJECTED` (the micro-tweak class measured neutral-to-negative twice) · single-frame node-scope `REJECTED` (the shape was rejected twice under §2) · declarative host-capture descriptor `REFERENCE` (hygiene, never land standalone for perf).

Parseman-side changes proposed by the jess side to cut the `builders.ts` + capture
cost, reviewed against the measured findings above and reshaped. Each still needs an
A/B (neutral-or-better) + all-four-parser-suites-green + CST byte-identity before landing.

- **Comment-lift without the whitespace-capture regression — ✅ LANDED** as the per-node
  trivia capture kind-filter (see Already-landed). The jess proposal's "comment-only
  capture *mode*" (`kindIndex === blockComment`) was **reshaped to a general per-kind
  filter** (`_triviaCaptureMask`), so it doesn't overfit the primitive to comments and
  also carries `//` line comments for free (a `blockComment`-only branch would have
  dropped them). Recovers most of `_liftStandaloneComments`' host-side cost.

- **Collapse `children`/`rawChildren` when a node captures no trivia — real, but bank it
  as allocation/GC, not wall-clock.** This is the same insight as idea #2 above ("skip
  raw-child bookkeeping for builders that ignore `rawChildren`"). The jess doc grades it
  "highest-value / halves per-node cost"; **temper that** — dead-value elision already
  removed 33% of value arrays for **~7% alloc / 0% time** (idea #1's measured outcome),
  and reify self-time is dispatch + trivia + CST bookkeeping, not array construction. Do
  it (low risk, gated on the existing `capturesTrivia` compile-time flag), expect GC
  relief. Note the aliasing invariant: pass one collector as both `children` and
  `rawChildren` only where they provably never diverge (jess gates divergence to
  `CompoundSelector`).

- **Fused trivia-skip + first-token dispatch (`_tf0`).** Split into two:
  - *(b) per-call-site skip-only vs skip+log* — worth doing; aligns with the landed
    `_tfN(…, cap?)` merge and the kind-filter (which is the per-kind instance of this).
  - *(a) fuse the post-`_tf0` `charCodeAt`+bounds read into the skip's return* —
    **speculative; measure with low expectation.** This is the same micro-tweak class
    measured *neutral-to-negative* twice (the trivia-loop "inline vs hoist `charCodeAt`"
    rejection in §6, and the recalibrated-literal charCodeAt finding). A likely-bigger
    `_tf0` lever the jess doc omits is idea #5: **elide the trivia call entirely** where
    the grammar proves adjacent terms can't be trivia-separated (`noTrivia` / first-set
    proof) rather than calling `_tf0` to have it return the same position.

- **Single-frame node-scope save/restore — highest regression risk of the set; prototype-
  gate.** The per-call `ParseContext` spread is *already gone* (landed: "mutate `_ctx`
  fields instead of spreading"); what remains is ~6 field writes. Bundling them into a
  frame object / depth-indexed stack is exactly the shape rejected twice under §2
  ("Runtime helper prelude" +50%, "Inline lazy buf" +32–47%; eager `[],[],[]` beat
  branchy indirection). Only land behind a genuinely neutral-or-better A/B on the full
  CST byte-identity suite; be ready to bin it.

- **Declarative host-capture descriptor (drop the `_hostReads` `toString`/regex) —
  cleanliness, not perf.** Memoized to ~once-per-arity-per-parse, so not hot. Fold into
  the children/rawChildren collapse as hygiene; never land standalone for perf.

## Design note: Trivia API — don't overfit `hasComment` (owner-flagged) — `REFERENCE` (the file says so itself: “Not a perf item.”)

**Status (parseman side): the capture primitive now honours this** — per-node trivia
capture filters by a general **kind mask** (`_triviaCaptureMask` / `triviaKindMask`), never
a hardcoded "comment" branch (see Already-landed). The guidance below still governs the
*jess-core* `hasComment` boolean and any future classification field.


**Not a perf item.** A design caution for whoever evolves the trivia primitive.

`makeTrivia` (jess core `packages/core/src/tree/util/trivia.ts:52`) derives
`hasComment` as "the run contains any non-whitespace char" — a `charCodeAt` scan
that trips on the first char that isn't space/`\t`/`\n`/`\r`/`\f`. So it is really
**`hasNonWhitespace`**; it only *equals* "has a comment" by virtue of the grammar
invariant that `trivia = whitespace | comment` (nothing else can appear in a
trivia run today).

Why that's a lossy bit to build on:

- It **cannot distinguish `//` line comments from `/* */` block comments**. That
  matters for output: `printableTriviaText` (`trivia.ts:86`) blanket-strips
  `//[^\n\r]*` whenever `hasComment` is set in a compressed context — because a
  `//` can't survive line-collapse, whereas an inline `/* */` can. One bit can't
  carry that distinction; it works only because the strip regex happens to be a
  no-op on block comments.
- It would **mislabel any future erasable-but-meaningful trivia as a "comment"** —
  e.g. a directive/pragma trivia, a preserved-annotation token, or a
  significant-newline marker — the moment the grammar admits trivia that isn't
  purely whitespace-or-comment. Consumers keying off `hasComment` would then
  silently mis-handle it.

**Guidance (owner): don't overfit the trivia primitive to "comment."** We don't
yet know what trivia consumers will want to skip vs. preserve vs. classify. Keep
it general:

- The run already exposes **position + raw range** (`{ start, end, src }`) — that
  is the durable, lossless contract; let consumers classify the slice themselves
  when they need to.
- If a classification bit/field is warranted, carry a **`kind`** (or per-segment
  kinds, matching the labeled-trivia-kind capture already landed for `_triviaLog`)
  rather than a boolean that conflates categories.
- Treat the existing boolean as **`hasNonWhitespace`** semantically (rename or at
  least document it as such), and don't add new call sites that assume
  `hasComment === "there is a comment here"`.

This keeps the trivia layer forward-compatible with trivia kinds the grammar
doesn't emit yet, instead of baking today's `ws|comment`-only assumption into the
API surface.
