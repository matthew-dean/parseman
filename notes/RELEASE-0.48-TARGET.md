# 0.48 release target — recover performance on the canonical table

Working experiment queue: `TABLE-PERF-EXPERIMENTS-0.48.md`. Use that compact
ledger for active status and decisions; this longer file preserves the evidence
and historical reasoning behind the queue.

## Active release boundary

0.47.0 shipped on 2026-08-07 through PR #124 at
`67365b6a9aa71aa51057a7ce0c8b1e9c3b3b380c`. Development now proceeds on
`release/0.48.0`; 0.47's verification record is archived in
`RELEASE-0.47-VERIFICATION.md`.

0.48 starts from 0.47's canonical compact `TableProgram` architecture and owns
the performance debt that 0.47 accepted. The release must recover the
production-shaped Jess/Less/CSS regressions and remove the named workload and
grammar shelves as their rows recover, without splitting runtime compilation
from macro artifacts, moving baselines downward, restoring runtime code
construction, or giving back correctness and package-size gains. External-parser
medium/large competitiveness, full-consumption parity, supported-Node coverage,
V8-shape invariants, and artifact-size gates remain hard constraints.

**Primary 0.48 exit criterion: parse performance must return to at least 0.46
levels on the production-shaped CSS, Less, and generated-Less release fixtures.**
This is the release's number-one goal, not an aspirational follow-up. The 0.47
shelves may bound work in progress, but they are not an acceptable 0.48 shipping
state. A claimed recovery must use the pinned 0.46 build, full-consumption and
result-identity checks, paired A/B runs, and same-source controls; toy grammars
or external-parser wins cannot substitute for this criterion.

---

## STATUS CONVENTION (repo-wide, adopted 2026-08-07)

`LANDED` · `MEASURED-NULL` · `REJECTED` · `QUEUED` · `UNMEASURED` · `REFERENCE`.
Definitions and the repo-wide picture: `PERF_IDEAS.md` § STATUS CONVENTION AND
COUNTS. `UNCLASSIFIABLE` is stated where an item genuinely does not fit — it is
not a sixth bucket, it is an admission.

**This file resists the convention more than any of its siblings, and the reason
is structural: it is not a backlog.** It is four things interleaved — deferred
work items, retracted figures, measurement-hygiene rules, and disclosed defects.
Only the first of those four is an "idea". The retractions and rules are marked
`REFERENCE`. Disclosed defects with no owner were originally marked
`UNCLASSIFIABLE`; the current disposition below moves each repaired defect to
`LANDED` while preserving the checkout and measurements that first exposed it.

## COUNTS — 30 items

| marker | count |
|---|---:|
| `LANDED` | 9 |
| `MEASURED-NULL` | 2 |
| `REJECTED` | 7 |
| **`QUEUED`** | **7** |
| `REFERENCE` | 4 |
| `UNCLASSIFIABLE` | 1 |

> ### **Untried in this file: 7, all `QUEUED`.** None is in `PERF_IDEAS.md`'s index; that index covers `PERF_IDEAS.md` only.
> §1 `_grammarTrace` parity for the table · §2 token streaming · §7 expected-set granularity
> on rule refs (blocked on §6) · §8 the 0.47 parse-time regression, **the headline
> 0.48 item** · §8b the un-built **child-kind specialisation axis** · §9 recover
> the deleted literal/regex/trivia fast paths (= `PERF_IDEAS.md` **U-53**) · §9b
> write down what the trivia scope rule IS.

**Per-item markers.** §1 `QUEUED` (owner ruling: counters are enough to ship) ·
§2 `QUEUED`, and note its *benefit* is `UNMEASURED` by construction — "A prior
bound of ~1.4 ms was measured against the BYTECODE INTERPRETER. **That bound does
not transfer.**" · §3 `REFERENCE` — the section is now a retraction notice, and it
retracts **1.66×** outright ("no fixture run, no commit, no harness is recorded
for it anywhere in this repo") and the per-piece **48/28/20 ns** claims; its three
data rows are the labelled-trivia scanner `LANDED` (−0.8 ms, 16/16 wins, ±1%
control) and two textbook `MEASURED-NULL`s — per-`node()` capture allocation
(~291k allocs/parse, predicted 1.5–3.0 ms, **measured zero**, V8 absorbs
young-gen non-escaping allocation) and the CST mark protocol (predicted 0.5–0.9
ms, **measured zero**, V8 already inlines it) · §4 `LANDED` in the 0.47 audit ·
§5 `LANDED`
(`c398044`) · §5b `LANDED` (`10d21d8`) · §6 stale `disjoint` flag `REJECTED` —
despite "deferred" framing, the recorded owner ruling is *not to fix it*, on
blast-radius grounds, not on a measurement · §7 `QUEUED` (pinned as a subset
relation, blocked on §6; the specific fix at :254 is `REJECTED` with evidence — it
collapsed JSON `[1,2,]` from seven expected tokens to one) · §8 `QUEUED`, the
headline · §8's "does not reproduce at scale" claim `REFERENCE` (a retracted
reading of a harness — `fixture.ts` **builds every leg at HEAD**; there is no 0.46
in the process) and its replacement measurement `REFERENCE` (the best-sourced
block in these five files: harness `bench/jess/ab.ts`, anchor `a5dc9bd`, config
`bench/jess/ab-config.json`, self-check 0.980–1.027, `benchmark.less` 106,802 B →
**2.340×**) · the shelf mechanism (`shelvedRegressionKeys`, no
`SKIP_PERF_GUARD=1`) `LANDED` as policy, though its stated justification is
withdrawn · §8b `QUEUED` for the child-kind axis, `REFERENCE` for the owner's
specification restatement; **the five mechanisms proposed for the gap during 0.47
are all `REJECTED`** and the file says "Do not re-propose them" — runtime
`compose()`, per-parse assembly, per-rule assembly, startup cost, interpreter
fallback · §9 `QUEUED` (= U-53) · §9b `QUEUED` · §10.1–§10.4 `LANDED` in the
shipped 0.47 release · §10.5 `REJECTED` as a defect after the owner
ruling established that `forCtx` is G5's required run-start selection, not a
run-path option branch ·
`## Standing hazard` **`UNCLASSIFIABLE`** — a measurement-hygiene rule that
invalidates a whole class of prior figures, plus the `expected`-digest rider
(`PERF_IDEAS.md` U-55).

> ### THREE HISTORICAL FACTS, WITH THEIR CURRENT DISPOSITIONS
> 1. At the recorded checkout, **`benchmark.jess` accepted 0 of its 124 bytes** —
>    `ok: true`, `errors: 0`, `consumed: 0`, on **0.46 and 0.47 alike**. Fixed by
>    `d0036b4`; the post-fix rows at that commit consume 124/124, but any chart
>    built from the older rows still measures an immediate accept of nothing.
> 2. At the recorded checkout, **`tolerant: true` assemblies refused emission
>    in all four dialects**, so recovery parses ran the closure engine. Fixed by
>    `958f6ad`; old recovery figures still describe a different engine from the
>    old strict figures and must not be relabelled.
> 3. **Every `PM_TABLE_COUNT` figure describes an engine nobody runs** — every row
>    count, arm-entry count and per-op tally in this repo's notes and CHANGELOG is
>    a measurement of the bytecode interpreter, not of the shipping path.
>
> Add to these `PERF_IDEAS.md` fact N: **39,718 records in
> `notes/results/parse-consumed.jsonl` are tagged `"engine":"table"` and are
> actually the reference interpreter**, 11 of 29 bench harnesses are mislabelled,
> and `CHANGELOG.md:756-762` (the "codegen / table / interpreter" fixture table
> present in this tree) carries the same defect. The correction is now merged
> into `release/0.47.0` (`1f84d10`). The historical records were deliberately
> not regenerated, so their old labels remain evidence of the hazard rather
> than corrected data.
>
> Also historical: the original figures left **`trackLines` unmeasured, not
> measured-and-fine**, because the `*-lines` grammar variants built a
> self-referential `OP_RULE ip→ip`. Fixed by `8683433`; the post-fix sweep covers
> the variants, but the original figures remain AST-only (§10.1).
>
> **`PERF_IDEAS.md`'s 2026-08-07 fact I1 also refutes a figure this file carries**:
> §3's "trivia scanner profiled at ~7.3% of parse self-time and was worth ~3.4%"
> is a third number for a path that `lane/capoff` measured as a **null**. Three
> documents, three numbers, one controlled measurement. Do not quote any of them.

---


0.47 is the table cutover: one lowering, one driver, the macro build emitting a
table instead of a second recognition engine. Everything below was found during
that work, understood well enough to size, and either **deferred on purpose** or
subsequently closed before release. Each entry records its current disposition
without rewriting the historical measurement context.

## 0.47 canonical-artifact correction — LANDED; static-source experiment REJECTED

The first table cutover accidentally had two normal construction paths: runtime
`compile()` omitted `asm`, so `assemble.ts` made emitted functions with
`new Function`; macro output printed `a:[]`, so it assembled closures. That split
made the public benchmark path different from Jess's actual macro artifact.

0.47 now stamps **every compiler-created program** — `compile()`, rule-map and
linkable compilation, `run-tabled`, macro output, and folded variants — with the
same explicit empty inventory, `a:[]`. Both paths therefore construct the same
compact closure-backed table object and never invoke `Function`. The regression
test proxies `globalThis.Function` across actual macro output and every public
compiler route.

Static emitted factories were tested as the obvious way to retain codegen-like
direct calls. They are **REJECTED for 0.47**, not deleted: strict-only factory
serialization blew the 24-fixture size guard by **17.5–46.6×**; the real Less
macro would grow from about **1.11 MB** to roughly **9.17 MB** strict-only (and
about **19.3 MB** for strict+tolerant), exceeding the roughly **11.7 MB** 0.46
artifact in the latter case. It also exposed unexercised CST rollback parity
failures. Whole-factory source deduplication saves only 0.5–1.8%, because the
factory bodies close over private environments.

0.48's viable direction is a compact linked-piece ABI with selective hot-piece
specialization, measured on actual macro artifacts. It is not “serialize every
factory,” and it must preserve the one canonical `TableProgram` shape. All old
uses below of “emitted assembly — what ships” are historical descriptions of the
now-removed split, not current architecture or release evidence.

The final 0.47 compact-path attempts are also **MEASURED-NULL**: sink-free
context selection and a direct exclusive-ASCII choice runner both preserved the
canonical closure object and passed correctness tests, but were neutral or
slower (the direct choice experiment: 29.218 / 238.145 µs versus 29.152 /
236.899 µs on JSON medium / large). Do not add context-specialization branches
to the release path. The missing win is a piece-graph/inlining problem, not an
unproven property-load or match-array cleanup.

The remaining `QUEUED` entries are the 0.48 work. The wrong-parse defects found
during 0.47 (`expect()` not clearing the ctx-global commit bit;
`caseInsensitive` dropped from dispatch matcher arms), plus the §10 defects now
marked `LANDED`, were fixed in 0.47 rather than shelved.

### Package layout: deduplicate ESM entry graphs

0.47 keeps its published ESM and CJS surface unchanged. Its package is materially
smaller than 0.46, but the remaining payload repeats most of the runtime graph in
nine independent ESM bundles and again in CJS. A reversible 0.48 build experiment
enabled esbuild `splitting: true` for ESM only: the tarball fell from **3,075,840 B
to 2,256,121 B** (-26.7%) and unpacked size from **13,076,481 B to 9,418,952 B**
(-28.0%). All eight ESM exports, compiled parsing, the plugin transform and CLI
smoke tests passed; CJS bytes and behavior were unchanged.

Do not delete `src/` independently: the shipped JS maps deliberately use
`sourcesContent: false` and resolve their sources there. Dropping CJS entirely is
a separate pre-1.0 package-surface decision now that Jess/Less run on ESM-capable
Node; answer it from consumer compatibility evidence, not as a 0.47 size shortcut.

---

## 1. `_grammarTrace` parity for the table

**What.** Coverage COUNTERS ship in 0.47. The six trace phases — `attempt`,
`selected`, `success`, `failure`, `backtrack`, `rollback` — do not.

**0.47 audit disposition.** Parity remains `QUEUED` for 0.48. Table-backed
artifacts now reject a supplied `_grammarTrace` sink with a `TypeError` at the
artifact boundary instead of accepting it and returning a plausible empty
trace. That is explicit capability reporting, not trace implementation;
interpreted combinators remain the supported trace path.

**Why deferred.** The retired source lowering emitted them at roughly **40
fine-grained sites** in the former `src/compiler/codegen.ts`. Matching that in
the table is not a task, it is a project, and it would have blocked the cutover
for the duration. Owner ruling: counters are enough to ship.

**Cost to pick up.** Every trace site needs a table equivalent, and the
instrumented pieces must stay assembly-SELECTED rather than testing a flag per
node (INV-6). Expect the `cfgKey` assembly-key space to need another bit.

---

## 2. Token streaming

**What.** Leaves consume classified TOKENS rather than characters.

**Why deferred.** It was an original requirement of the design that never
landed, and `src/compiler/token-scanner.ts`, `token-alphabet.ts` and
`token-dispatch.ts` are already in-tree as built-but-never-wired analysis — they
carry `DEBT` entries in
`scripts/invariant-allowlist.mjs` pointing at `docs/design/derived-tokenization.md`.
0.47 stayed on the cutover instead.

**Current disposition.** Still `QUEUED`, with its groundwork deliberately
preserved rather than mistaken for dead code or a completed feature. See
`notes/TOKEN-STREAM-GROUNDWORK.md` for the static probe, the scanner correctness
hole, the stale dispatch half, the reusable packing/folding utilities, and the
first independently landable wiring step. An experiment is ongoing separately;
it has not resolved §8, and this note makes no speed or memory claim for it.

**0.48 integration ruling.** Token cursor work does not put the rest of the
performance queue on hold and does not reset a landed piece design. It must enter
through the canonical `TableProgram` assembler as a per-site selected path. Cheap
sound character rejection stays in front of it; fixed terminal pieces supply the
recognition semantics and raw-input fallback; and the selected leaf or composite
must consume the classified result rather than rescan. Sequence/repeat/node/
rollback/materialisation wins remain valid where they precede classification,
consume its result, or operate outside eligible token sites. Evaluate new work for
that composability, then prioritize by measured production impact.

The reverse constraint is equally important: do not land a large body of terminal
recognition that a token cursor would immediately duplicate. Expose one recognition
contract with raw and pending-token entries. This is a seam requirement, not a
requirement to finish token cursors before banking compatible CSS/Less wins.

**Carry this forward, it is the part people get wrong.** A prior bound of
~1.4 ms was measured against the BYTECODE INTERPRETER — it measured *scanning*
and was structurally blind to entry elimination. **That bound does not
transfer.** Re-derive it against the closure assembler. The same warning applies
to every mechanism closed against the interpreter: materialisation (~10%),
leaf/trivia specialisation, superoperators (~1.6 ms), builder megamorphism
(~0.1 ms). A bound measured against a replaced architecture is not evidence.

What token streaming plausibly buys, from the 0.47 profile work: leaf matching
becomes an integer compare rather than a char test or regex; first-set gating
becomes a lookup on token kind rather than a char-class computation; trivia is
classified once by the stream rather than scanned at every boundary. The last of
those is the one with a measured precedent — see §3.

---

## 3. The remaining table/codegen speed gap

**BOTH NUMBERS THIS SECTION USED TO CARRY WERE DISPROVED. See §8 for the
measurement that replaces them.** It said "the closure assembler is ~1.66×
source lowering on `benchmark.less`", then "DO NOT QUOTE 1.66× — on the `css`
perf-guard context the same cutover measures ~4.4×", then "the gap is
fixture-dependent and ranges at least 1.66×–4.4×."

- **1.66× has no surviving provenance.** No fixture run, no commit, no harness
  is recorded for it anywhere in this repo, and it does not appear in
  `notes/results/parse-consumed.jsonl` or `bench/size-baseline.json`. Treat it
  as unsourced.
- **4.4× was `css/selector` and `css/decls`** — two `bench/perf-guard.ts`
  micro-bars, and §8 records the owner ruling that they are toy grammars.
- **The range built out of the two is therefore a range between an unsourced
  figure and a micro-bar.** It was never a measurement of anything shipped.

The gap that IS measured, HEAD against 0.46 (`a5dc9bd`) on jess's four shipping
grammars, is in §8: **2.3×–2.9×**, and it is a REGRESSION introduced at 0.47,
not a standing table-vs-codegen distance.

Two of the three mechanisms tried returned **measured zero** and are recorded
here so nobody re-runs them:

| mechanism | predicted | measured |
|---|---|---|
| labelled-trivia char scanner | 1.2–1.6 ms | **−0.8 ms, real** (16/16 wins, ±1% control) |
| per-`node()` capture allocation (~291k allocs/parse) | 1.5–3.0 ms | **zero** — V8 already absorbs young-gen non-escaping allocation |
| CST mark protocol, one `_cstBuf` load instead of three | 0.5–0.9 ms | **zero** — V8 already inlines it |

**The lesson worth keeping:** sampled self-time OVER-CREDITS a frequent, cheap
frame. The trivia scanner profiled at ~7.3% of parse self-time and was worth
~3.4%. Bound before building, and expect the profile to overstate.

**Still unexplored, and UNSOURCED — do not build on it.** An earlier draft said
"48 ns per piece invocation against codegen's ~28 ns for the same logical work…
~20 ns of *work* per piece, not call overhead." Both figures were searched for
in this tree and **no fixture, commit, harness or committed result produces
either of them** — `48 ns` occurs exactly once in the repo, in this sentence.
The §8b prediction that the un-built child-kind axis is what that 20 ns buys
leaned on it, so that prediction is currently resting on an unsourced number.
Either re-derive per-piece cost against `bench/jess/g5-ms.ts` and record the run,
or drop the claim.

---

## 4. CST leaf and recovery-error span line-annotation — LANDED

**What.** Under `trackLines`, the interpreter annotates `expect()` error spans
and CST leaf spans with line/column. The table's zero-width `expect()` recovery
errors were the remaining divergence.

**0.47 audit disposition.** The reference table driver, closure assembly and
emitted assembly now use the shared `spanLines` helper for the zero-width
recovery span when the program tracks lines. A regression compares those three
paths with the interpreter. `pushCstLeaf` already funnels line-aware leaves
through `annotateSpanFromLineContext`, and `recoverScan` remains shared for LIST
recovery.

The stale `TODO(table/expect-span-lines)` markers have been removed.

### 4b. Structural host capabilities — LANDED in the 0.47 audit

This is an audit addendum outside the original 30-item ledger above.

The table engines now honor the capability metadata the old source lowering
exposed. `_parsemanReadsChildren = false` skips the semantic children collector
for structural nodes while retaining `rawChildren`; unwrap/collapse nodes keep
children because they inspect them. `_parsemanCaptureTrivia(type)` is evaluated
once per structural node site when a host-specialized assembly is built, and
the assembly cache is isolated by host identity and predicate version so one
host cannot inherit another host's decisions. These close the table parity
TODOs; they do not claim §8's broader child-kind specialization or performance
regression is resolved.

---

## 5. `size-guard` re-baselining — **DONE, and RE-CUT once more**

**What.** `test/unit/size-guard.test.ts` measured generated bytes against
ceilings keyed to codegen output. Re-cut against the table.

**The first re-cut measured HOLLOW ARTIFACTS, and the numbers below replace it.**
`compileTable` computed reducer sources and then never handed them to the
emitter, so `emitTable*` took its `prog.fns.map(() => '() => {}')` fallback and
every author callback — `node` build fns, `transform`, `leaf` — was printed as an
empty arrow. Those modules loaded, parsed, reported `ok`, and returned
`undefined` where both other engines returned a tree. They were also **smaller**
than the correct ones, because a stub pool is smaller than real reducer text, so
the size gate did exactly what it was built to do on a number that meant nothing:
ratcheted it, banked the win, and re-cut the ceilings against the defect. Fixed
in `c398044`; the ceilings are now cut against artifacts that carry their
reducers.

Every example grew when the reducers came back — this is the correction, not a
regression:

| fixture | codegen | hollow table | real table | growth | vs codegen |
|---|---|---|---|---|---|
| example/json | 15,138 B | 1,237 B | **1,336 B** | +8.0% | 11.3x |
| example/csv | 7,680 B | 697 B | **788 B** | +13.1% | 9.7x |
| example/graphql | 69,936 B | 3,503 B | **4,682 B** | +33.7% | 14.9x |
| example/css | 224,100 B | 8,563 B | **9,229 B** | +7.8% | 24.3x |
| example/lang | 41,772 B | 2,443 B | **3,565 B** | +45.9% | 11.7x |
| example/toml-ish | 13,223 B | 1,195 B | **1,414 B** | +18.3% | 9.4x |
| example/jsonc | 18,033 B | 1,295 B | **1,382 B** | +6.7% | 13.0x |
| example/jsonl | 16,019 B | 1,285 B | **1,384 B** | +7.7% | 11.6x |

So the real reduction against codegen is **9.4x (toml-ish) to 24.3x (css)** —
not the 11.0x-20.0x recorded from the hollow measurement, and json is **11.3x**,
not 12.2x. All **eight** examples print (see §5b); the earlier "six that still
print" is stale.

**The `probe/*` half has partly flipped too** — the previous claim that all 16
probe ceilings are byte-identical is stale. `src/plugin/index.ts` imports both the single-root and rule-map
compilers (`compile` / `compileRuleMap`, named `compileTable` / `compileRuleMapTable`
when this was written) and picks per unit. Measured: 10 of 16 emit
`tableRules` (four `node-scale-*`, both `trivia-*`, both `hostmode-*`, three
`variants-*`) and fell by up to **91.5%**; the six that do not
(`compose-depth-1/2/3`, `compose-leaf`, `variant`) are byte-identical to their
pre-flip ceilings. Consequence for the 10x block: `node-scale-32` went 34.2x →
**2.9x**, so the per-node preamble is no longer what holds anything over target.
The eight rows still over are the six source-lowered units and the three
`variants-*`, whose cost is variant DUPLICATION (4 variants = 2.64x one variant
of the same grammar, compression 5.1:1 → 9.2:1).

**The rule used.** Ceiling = the measured byte count, exactly — no headroom,
`RATCHET_SLACK_PCT` left at 0.1%. A percentage of headroom is pre-approved
regression budget, and there is nothing for it to absorb: both lowerings are
deterministic, so the noise floor is 0. Stated at WHY THE CEILINGS CARRY NO
HEADROOM in `bench/size-guard.ts`. Teeth, verified: a **+2 B** growth on
example/json fails the gate (`+0.15%` against 0.1% slack, exit 1). +2 B is the
smallest integer growth that can fail at this size — at 1,336 B the slack is
1.34 B, so +1 B (+0.07%) is absorbed as churn.

**And the precondition the rule turned out to need.** "Record what it says" is
only safe while what it measures is whole. `bench/size-guard.ts` and
`bench/size/probe.ts` now both refuse to record a byte count for an artifact
containing an empty reducer, using the one definition in
`bench/empty-reducer.ts` that `test/unit/table-compile.test.ts` pins the
correctness property with. Being printable was necessary and not sufficient: a
bytes-only gate cannot tell "got smaller" from "got emptier". Observed failing —
`size gate refuses to record bytes for a HOLLOW artifact` reconstructs the defect
in a fixture checkout.

---

## 5b. All eight example grammars print — **RESOLVED, was two refusals**

**Superseded.** This section recorded `example/css` and `example/jsonc` returning
`source: ''` and a null `inlineExpression`, `printable: false` in the baseline,
and **UNGATED for size**. None of that is true any more, and it has not been
since `10d21d8` ("lower the two refused trivia shapes, and GATE example
emission"), which removed both `printable: false` records.

**Verified directly with `compile()` on this branch**, not inferred from the
baseline file:

| fixture | source | printable | empty reducers |
|---|---|---|---|
| example/css | 9,229 B | yes | 0 |
| example/jsonc | 1,382 B | yes | 0 |

All eight examples print, all eight carry a real ceiling, and all eight are GATED
for size. Nothing in `bench/size-baseline.json` records `printable: false`.

**What the refusals actually were.** `triviaSpecOf` demanded a `trivia()`
wrapper, while `parser({ trivia })` and `rules({ trivia })` store what they are
handed verbatim — so a `classifiedTrivia()` or a `transform` body arrived
unwrapped and was refused by name. Lowering those shapes is what `10d21d8` did.

**The ratchet that recorded it is still the point, and is now the only observer
of itself.** Printability ratchets in both directions alongside the bytes:
losing it **BLOCKS**, regaining it is a win to bank, and a recorded loss is
standing debt warned about on every run. Because no shipped fixture is
unprintable any more, the unprintable half is exercised by a CONSTRUCTED
checkout in `test/unit/size-guard.test.ts` (`unprintableRoot()`) rather than by
two grammars that happened to be broken — a guard nobody can see fail is not
known to work.

---

## 6. The stale `disjoint` flag

**What.** `choice()` freezes `_def.disjoint` at construction (`choice.ts:35`)
from `g.X` arms that are still `ref()` slots carrying `any()` — `ref.ts:21`
fills the meta in place *afterwards*. So the interpreter and codegen attempt
**seven arms** per JSON value where the table, which recomputes from resolved
classes (`encode.ts:439`), attempts **one**.

**Why deferred.** The table is both more correct and faster here; the
interpreter is the outlier. Owner ruling: if the table is right, the older
engines do not need fixing. Fixing it properly means deferring first-set
resolution in `choice()`, which flips dispatch decisions across every recursive
grammar — a semantics-and-timing change, not a localised one.

**Also stale, found alongside it:** `encode.ts:439` claims codegen fixes stale
`disjoint` "the same way, at fuse". It does not — `codegen.ts:2076` reads
`def.disjoint` raw, and the linker only repoints `_meta.disjoint`, a different
field.

---

## 7. Expected-set granularity on rule refs

**What.** A top-level `choice` of rule refs reports only the last-failing arm
from the table, where the interpreter reports the union of every arm's first
token. Pinned as a SUBSET relation (the table's set must be a non-empty subset
of the interpreter's, and the position must not move) rather than adjudicated.

**Why deferred.** Same root cause as §6 — it is arm COUNT, not failure
reporting. It moves when §6 does.

**Do not "fix" it by preserving the failing arm's `_fx`.** That was tried: it
collapsed JSON `[1,2,]` from seven expected tokens to one. The rule all three
engines actually apply is *a failing choice reports the arms it ATTEMPTED*
(`choice.ts:105`, `:114-117`, `:145`; `codegen.ts:1985`). There is no positional
furthest-failure merging on the `expected` path anywhere — that framing was
wrong and was disproved with source evidence.

---

## 8. The 0.47 parse-time regression — REAL, REPRODUCED AT SCALE, and shelved on a justification that has since been withdrawn

**What.** `bench/perf-guard.ts` blocks commits. Measured on `release/0.47.0`
itself, with no lane branches applied, against baseline `2a83f9b` (captured when
`compile()` was codegen):

```
css/decls      interp 15.43µs (-14.7%)  compiled 10.86µs (+343.2%)  ratio 1.42× (baseline 7.38×)
css/selector   interp 14.42µs (-12.8%)  compiled  9.93µs (+385.5%)  ratio 1.45× (baseline 8.09×)
```

The table `compile()` is **~4.4× slower than codegen** on these two bars, and the
compiled-vs-interpreted advantage on css collapsed from **8.09× to 1.45×**.

**Why it is believed rather than blamed on the box.** The same run carries its own
control: `interp` moved −14.7% and −12.8% — *faster*, consistent with the
labelled-trivia scanner win — in the same process, on the same box, at the same
moment. Contention does not slow one bar 4× while speeding its neighbour up 13%.
It also reproduces on the release line, so it belongs to neither lane in flight.

**Why it was shelved — and the part of that reasoning that no longer holds.**
Owner ruling: it does not appear in `bench:margin`, whose fixtures are json / csv
/ graphql / CST, so there is no `css` bar in the published chart. That much is
still true. What was *also* claimed — that at real scale the same change measures
~1.09× and the shelf therefore costs nothing — is **withdrawn**; see below.
Shelved for 0.47, addressed in 0.48, and explicitly NOT re-baselined, because the
baseline is right and the measurement is the thing that moved.

**How the gate must behave meanwhile.** Do NOT reach for `SKIP_PERF_GUARD=1`.
That routes around the gate silently and makes every future regression on any
other bar invisible too — the next real one lands unnoticed behind the same
bypass. The shelf has to be NAMED: the `css` context's two `compiled` bars are
known-regressed and tracked here, and everything else stays gated at its real
tolerance. A bypass that cannot tell a shelved regression from a new one is not a
shelf, it is a disabled gate.

**How much these two bars are worth — owner ruling.** `css/selector` and
`css/decls` are *toy grammars*. A 4.4× on them is not, by itself, evidence the
product is 4.4× slower at anything anyone runs. An earlier draft claimed css
"exposes the gap most sharply" and should therefore be where 0.48 starts; that
was reasoning from whichever bench happened to be wired into the pre-commit
hook.

But the correction that replaced it was **also wrong**, and in the opposite
direction — see below. Two wrong passes, and this is the third.

### The "does not reproduce at scale" claim — DISPROVED

A block here read **"MEASURED AT SCALE — THE SIGNAL DOES NOT REPRODUCE"** and
quoted `bench/jess/fixture.ts` at css **1.09×**, less **1.05×**, scss **1.09×**,
concluding "the real gap is 4–9%, not 4.4×" and "the shelf costs nothing."

**Every one of those figures is deleted.** They measure nothing about any
regression, for a mechanical reason:

> `bench/jess/fixture.ts` **builds every leg at HEAD.** Its three contests are
> `compiled -> table`, `CONTROL table -> table` and `compiled -> interpreter`,
> all constructed from this worktree's `src/` (`bench/jess/fixture.ts:33-40`,
> `:190-196`). Its `ref|` / `head|` labels are the **a/b labels of a contest**,
> emitted by `interleave` — not a reference build. There is no 0.46 in the
> process.

So the row labelled "reference" was a table leg built at HEAD, not a release
reference. At the historical commit where that row was collected, the contest
was **runtime-emitted assembly against the `exec.ts` opcode driver, both at
HEAD** — table against table. That emitted route was the now-removed split, not
the final 0.47 shipping artifact. Either way the contest cannot answer "versus
the last release", and quoting it as if it could is what produced the 1.09× /
1.05× / 1.09× row. `bench/jess/ab.ts` now says so in its own header, by name.

### What HEAD vs 0.46 actually measures

`bench/jess/ab.ts`, HEAD against `a5dc9bd` (v0.46.0, the anchor in
`bench/jess/ab-config.json`), jess's shipping grammars, `--two-graph`, Node
25.9.0, self checks 0.980–1.027:

| fixture | 0.46 | HEAD | ratio |
|---|---:|---:|---|
| `benchmark.css` 123,029 B | 5.37 ms | 15.28 ms | **2.845×** |
| `benchmark.less` 106,802 B | 16.93 ms | 39.60 ms | **2.340×** |
| `gen-workload.less` 275,211 B | 42.13 ms | 110.18 ms | **2.615×** |

**0.47 is a 2.3×–2.9× regression on the grammars a downstream parser ships.**
Not 4–9%, not "does not reproduce."

### Which release turned — 0.46 is NOT the regression, 0.47 is

Sweeping the same fixture across release anchors, `benchmark.less` reads:

| anchor | 0.44 | 0.45 | 0.46 | HEAD (0.47) |
|---|---:|---:|---:|---:|
| `benchmark.less` | 17.26 ms | 16.84 ms | 17.19 ms | 39.60 ms |

Flat across three releases, then it turns. Whatever landed in the 0.47 stack owns
all of it; there is no slow drift to blame and no earlier anchor that would
launder it.

**The consequence for the shelf.** `shelvedRegressionKeys` was justified on the
ground that the regression "does not appear in `bench:margin`" and "at real scale
measures 1.09%". The second half of that is withdrawn. The `css/selector` and
`css/decls` bars were *directionally right* and only wrong about magnitude — they
said css regressed, and css regressed 2.8×. The shelf is now hiding a real,
reproduced, at-scale regression, and 0.48's framing is **"recover a 2.3×–2.9×
regression"**, not "close a 4–9% gap."

### 0.47 grammar-density shelf — bounded, named, and still compared to 0.46

`bench/grammar-perf-guard.ts` independently compares the synthetic rollback and
expected-set axes against `a5dc9bd` (0.46). Three exact Node 24 candidate runs
(`855a0ea`, then `67be2d7` with this bench-only shelf work) completed all five
paired passes only after `67be2d7` made the copied fixture's reducers serialize
identically in both compiler generations. They are therefore real 0.47 slowdowns,
not changed parse results. The ranges below are the envelope across all three
complete runs; every ceiling is that observed worst pass plus a fixed 10
percentage-point noise headroom, rounded upward — it is not a new baseline.

| case | candidate median envelope | candidate min envelope | shelf ceiling (median / min) |
|---|---:|---:|---:|
| `rollback/none` | +132.6%…+187.1% | +156.9%…+189.7% | **+200% / +200%** |
| `rollback/sparse` | +153.8%…+187.6% | +171.5%…+196.3% | **+200% / +210%** |
| `rollback/medium` | +228.2%…+255.4% | +239.3%…+268.6% | **+270% / +280%** |
| `rollback/dense` | +299.0%…+353.1% | +328.6%…+365.3% | **+370% / +380%** |
| `expected/none` | +132.7%…+172.8% | +137.2%…+169.4% | **+185% / +180%** |
| `expected/narrow` | +124.1%…+181.2% | +151.0%…+179.8% | **+195% / +190%** |
| `expected/wide` | +373.2%…+424.5% | +390.0%…+441.5% | **+440% / +460%** |

The shelf is active **only** for the normal working-tree gate against its default
0.46 reference: never `--quick`, `--self`, `--ref`, or `--head-ref` replay. It
does not relax result identity: the two sides must still produce exactly the same
parse result before timing begins. An unlisted strict regression blocks. A named
row that no longer fails the normal strict-majority gate prints `RECOVERED` and
must be removed. A named row blocks again when a strict majority of its
independent passes exceeds either of the ceiling columns above, so one noisy pass
does not override the gate's existing majority policy. This is accepted 0.47
debt, not a new baseline; 0.48 owns shrinking and deleting every one of these
entries.

### Historical engine inventory — the split this audit removed

This profile inventory describes the earlier split, not current 0.47 package
behavior. On `benchmark.css` at that historical HEAD:

| engine | module | `benchmark.css` |
|---|---|---:|
| runtime-emitted assembly — historical `asm`-omitted route, **not what ships** | `src/table/emit-assembly.ts` | 13.23 ms |
| `exec.ts` opcode loop — the reference | `src/table/exec.ts` | 22.18 ms |
| combinator interpreter | `src/functional/run.ts` | 43.42 ms |

Final 0.47 compiler-created programs all carry `a:[]` and select the compact
closure linker in `src/table/assemble.ts`; runtime `compile()`, macro output,
rule-map/linkable compilation, `run-tabled`, and folded variants share that
route. `src/table/emit-assembly.ts` remains experimental/diagnostic machinery,
not the normal package artifact. Name the exact construction route and commit in
any future figure.

**Ignore the `jess` dialect row wherever it appears.** `benchmark.jess` is 124
bytes and reports 0.00 ms — and per `notes/results/parse-consumed.jsonl` it
consumes **0 of its 124 bytes** while returning `ok: true`, on 0.46 and 0.47
alike (§10). It is not a timing fixture and it is not a parse.

**The lesson, which is the whole reason this section exists.** THREE successive
drafts named a priority from a bench that could not answer the question — first
css because it blocked a commit, then Jess because css was ruled a toy, then a
table-against-table contest read as a release comparison. The third had numbers
and a control and three-way agreement and was still wrong, because the *legs*
were wrong. A control proves the box was quiet. It does not prove the two sides
are different builds. **Check what a harness builds before quoting what it
prints.**

### 0.47 shipped baseline and measured attempts

The shipped 0.47 source at `67365b6` is byte-identical under `src/` to the final
measured production source (`a28404c`) used for the two-graph comparison on Node
25.9.0:
CSS was 14.88 / 5.44 ms (**2.736×** slower), `benchmark.less` 39.39 /
17.07 ms (**2.308×**), and `gen-workload.less` 108.44 / 42.39 ms
(**2.558×**). Every leg consumed in full; same-source controls were 0.975× /
0.988× / 1.011×. The external-parser release condition was separately met on
the exact final source: JSON led Chevrotain 1.032× medium / 1.045× large, CSV led
Peggy 3.71× large, and GraphQL led Chevrotain 1.51× / 1.66× medium/large.
Parsing identity and artifact size remain hard blockers regardless.

The older emitted-route CPU profile (`_accSet` 4.7%, `_rbBuf` 4.3%,
`pushCstChild` 2.5%, GC 2.4%) is historical and must not be presented as the
final compact artifact's profile. A final compact-closure Less profile instead
ranked sequence value-array bodies 10.0%, scope swaps 8.9%, sentinel/link bodies
6.6%, sequence runners 4.8%, `markCst` 4.2%, `nextTerm` 4.1%, and capture
rollbacks about 6%. Three implementation attempts were made with full-result
digest parity and none should ship:

- A conservative token cursor wired the existing token-stream groundwork into
  literal-led choices. It proved correctness but admitted exactly one choice per
  shipping dialect, added 1.7–2.8 KB of emitted source, and made Less +3.77%
  slower against a +0.73% control. CSS/SCSS results were noise. Preserve the
  groundwork; do not enable it until eligibility expands enough to amortize
  scanner setup while proving boundary and language non-overlap.
- An indexed/single-item `_accSet` path was +1.4% / +1.8% on the two Less
  fixtures and was reverted.
- `_rbBuf` profiling found 143,285 calls per `benchmark.less` parse; 81.3% needed
  no state change. Runtime exact-state guards nevertheless measured from +0.3%
  to +2.2%, within or worse than the +1.5% / +2.8% self-noise floor, and were
  reverted.

The next 0.48 experiments are therefore structural, not helper micro-tuning:

1. Prove arm effects at compile time and omit rollback marks/calls when an arm
   cannot mutate CST buffers, trivia, fields, or errors.
2. Premerge or copy-on-write expected sets so terminal failure does one
   allocation/copy while preserving ordering, duplicates, and diagnostics.
3. Reduce CST child/raw materialization (`pushCstChild` + GC + `rawEntry` are
   roughly 6.9% self time).
4. Emit site-specialized trivia/range/lead scans rather than adding generic
   runtime branches.
5. Hoist `when(matches(/…/), …)` regex construction into the table/assembly
   build phase. The current dispatch selector constructs a `RegExp` for each
   routed value in all three engines; `matches()` already rejects `g`/`y`, so a
   stable compiled regex is safe. This is allocation hygiene, not an explanation
   for the Jess regression (Jess does not use this matcher).

---

## 8b. THE DESIGN, STATED BY THE OWNER — read this before touching the assembler

Every paraphrase of this in earlier notes and in the 0.47 PR was wrong in the
same direction, so it is recorded verbatim in substance:

> "I basically proposed a shape in which we could INFER the same shape as codegen
> but with an assemblage of fixed, generated, static types & paths."

**The goal is EQUIVALENCE BY ASSEMBLY, not subtraction.** The table is supposed to
reconstruct, at run start, the same specialised body codegen emitted at build
time. Nothing about recognition, code generation, inlining or char-code dispatch
was ever to be retired — those are the techniques being *reproduced*, by a
different mechanism.

Wordings that are WRONG and keep recurring: "retired the source-lowering engine",
"deleted an engine", "replaced generated code with data", "the table is the only
lowering", "two recognisers became one". Each describes removal. The spec is
reproduction.

**Where the implementation actually stands.** Assembly specialises on two axes and
not the third:

| axis | specialised? | evidence |
|---|---|---|
| options (trivia / CST / lines / recovery) | **yes** | `cfgKey` selects the assembly; no per-node flag tests |
| arity | **yes** | unrolled per-term-count pieces; generic `runTerms` is the fallback |
| **child kind** | **NO** | every child is an opaque `Piece` behind a call |

The third is the gap. A sequence whose first term is `literal('@media')` assembles
to the same shape as one whose first term is a rule reference — it *calls* the
child. Codegen emitted `input.startsWith('@media', pos)` directly into the
sequence body; the specialisation went to the leaf. To reach parity the piece set
must be selected on child SHAPE as well: the superset becomes
(option × arity × child-shape) rather than (option × arity).

`assemble.ts`'s `OP_SEQ` states the bet the current shape rests on — that
TurboFan "removes [the call cost] by INLINING a small monomorphic child". That
bet is what the numbers below test, and `kids[i](…)` in a loop over heterogeneous
children is not a monomorphic site.

**The number that isolates it.** `json/document`: **zero** `OP_LIVE` interpreter
fallbacks, no `compose`, 138 code rows, build outside the timed region — and it
still measures **+137%** against 0.46.0, stable to a tenth of a percent across
five passes (137.9 / 137.5 / 137.2 / 137.1 / 124.6). Nothing exotic is available
to explain it. That is the cost of the un-built third, measured clean.

Five mechanisms were proposed for that gap during 0.47 and the evidence killed
all five: runtime `compose()` (no workload uses it), per-parse assembly
(`w.make()` is outside the timed region), per-rule assembly (`runRule` is the
boundary, once per parse), startup cost (`min` is HIGHER than `median`, which a
fixed cost cannot produce), and interpreter fallback (0-4 `OP_LIVE` rows per
grammar). Do not re-propose them.

---

## 9. RECOVER THE LITERAL / REGEX / TRIVIA FAST PATHS — an LLM oversight, not a decision

**Owner ruling, recorded verbatim in substance:** optimising the SHAPE of codegen
into a table was the goal. Retiring its literal- and regex-recognition
optimisations was **a non-goal, and was never agreed to.** It happened anyway.

**What was deleted.** These were removed during the 0.47 cutover on the reasoning
that they were "only reachable from codegen." That reasoning is wrong: *only
reachable from the deleted engine* is not the same as *not worth keeping*, and
nobody made the second judgement. All recoverable from `3d4dac6`:

| file | lines | what it did |
|---|---|---|
| `src/compiler/scannable-run.ts` | **1627** | the bulk of literal/regex run recognition |
| `src/compiler/trivia-fast-path.ts` | 296 | trivia scanning specialisation |
| `src/compiler/module-hoist.ts` | 221 | shared-subtree hoisting |
| `src/compiler/inline-build.ts` | 111 | build-call inlining analysis |
| `src/compiler/inline-callback.ts` | 105 | reducer callback inlining |
| `src/compiler/scannable-terminal.ts` | 31 | terminal scan classification |

Also gone: `src/compiler/line-index.ts`, `src/compiler/codegen.ts`, and the
benches `codegen-ab.ts`, `shared-prefix-ab.ts`, `composeleaf-firstset.ts`.

`git show 3d4dac6:src/compiler/scannable-run.ts` — none of it is lost, and 1627
lines of literal-recognition work is not something to re-derive from scratch.

**What the final 0.47 workload gate measures.** Earlier CI runs printed
+666%/+780% CSS/Less figures. Those remain historical evidence that the
direction was real, but they are not the accepted candidate bounds and must not
be quoted as current. The exact `4e1cce5` Node 24 default gate, five independent
passes against `a5dc9bd`, produced:

| workload | final-run median envelope | final-run min envelope | 0.47 ceiling (median / min) |
|---|---:|---:|---:|
| `less/stylesheet` | +254.4%…+330.9% | +328.3%…+340.9% | **+332.3% / +348.5%** |
| `less/mixins` | +300.7%…+326.0% | +303.4%…+328.6% | **+329.8% / +344.3%** |
| `css/stylesheet` | +145.3%…+302.1% | +189.8%…+324.4% | **+309.6% / +333.2%** |
| `graphql/document` | +85.2%…+119.2% | +92.6%…+126.8% | **+124.7% / +129.6%** |
| `json/document` | +118.8%…+136.7% | +121.8%…+135.9% | **+145.8% / +146.9%** |

Every row still prints `FAIL` against 0.46, then `SHELVED`; result identity is
checked before timing. The shelf applies only to these five names in the default
pinned-reference, checked-out-HEAD gate. `--ref`, `--head-ref`, `--self`, and
`--peak` do not use it. An unknown regression blocks, a recovered row prints
`RECOVERED` and must be deleted, and a known row blocks when a strict majority
of passes exceeds either ceiling. This is bounded release debt, not a new
performance baseline.

**RECONCILED — and it was the dialect harness that was wrong, not the release
A/B.** This paragraph used to read "UNRECONCILED": `bench/jess/fixture.ts`
measured css 1.09× and less 1.05× while old CI runs printed +666% and +780%, and
it listed three candidate explanations. The third of them was the right one —
*one harness's reference leg is not the pre-deletion engine at all*.

`bench/jess/fixture.ts` builds **every leg at HEAD** (§8). Its `ref|` label is a
contest's a-side, not a reference build, so it had no pre-deletion engine in the
process and its 1.09× / 1.05× row is withdrawn. The current `workload-perf`
still interleaves HEAD against a pinned reference, and the bounded rows above
are the current evidence.

The two surviving measurement families are consistent in sign but answer
different questions. The final shipping-grammar A/B reads **2.308×–2.736×
slower**; the synthetic workload gate reads the bounded per-row envelopes above.
The workloads lean differently on the missing fast paths. Quote `ab.ts` for
"what did this release do to a shipping grammar" and the final shelf table for
"what does the release workload gate currently bound." Do not revive the old
+666%/+780% rows as current candidate evidence.

**The 0.48 instruction.** When token streaming lands, take whatever was valuable
out of these modules. Token streaming is where literal and regex recognition
should get *faster*, not the occasion to accept having lost it — classified
tokens make leaf matching an integer compare, which is the same objective
`scannable-run.ts` was pursuing through a different mechanism. Read it before
designing the replacement.

**The process lesson, which is why this is written down rather than just fixed.**
Three separate agent briefs listed these files for deletion, and every one
justified it as "its only consumer is codegen." That is a reachability fact, not
a value judgement, and reachability was allowed to stand in for the judgement at
every step — including by me, when I wrote the briefs. A module that only the
deleted engine called still has to be asked *what does it do, and do we want it*.

---

## 9b. The trivia model's REFERENCE is weaker than the fix that rests on it claimed

`1f5d3ea` ("a rule reference re-establishes its OWN trivia scope, in both
engines") is the commit that stopped `benchmark.less` truncating, and the whole
model it installed rests on one sentence in its message:

> "the interpreter and the table scoped trivia DYNAMICALLY, by caller, while
> codegen scopes it **LEXICALLY, per rule** — it binds each rule's trivia scanner
> at compile time."

**That is not confirmable from 0.46's codegen, and the mechanism is not lexical.**
Read at `a5dc9bd`:

- `ctx.activeTrivia` is a **mutable field on the shared `Ctx`**, saved and
  restored around `noTrivia(…)` / `trivia(…)` regions
  (`src/compiler/codegen.ts:4243-4268`, `:3437-3442`).
- `emitLazy` (`:3880`) emits a named rule's body **once**, guarded by
  `ctx.namedParsers.has(p)`, under whatever `ctx.activeTrivia` happens to be at
  the **first emission site it is reached from**. Every later reference is a bare
  `emitNamedFnCall`.
- `emitLazy` explicitly saves and restores `indent`, `failLabel`, `recordFail`,
  `inlineLeft`, `currentFnName` and the coverage fields for the fresh function
  scope. **`activeTrivia` is not among them.**

So 0.46's scoping was **first-emission-site, then memoised** — emission-order
dependent. It is lexical only when the first site a rule is emitted from happens
to carry the rule's own scope, which on jess's two affected grammars it did. The
reference behaved correctly on the grammars anyone checked, **by luck of emission
order**, not by construction.

**Why this matters and is not a footnote.** The 0.47 fix, its follow-on
(`4cfc0bd`), the `hasOwnTriviaBoundary` gate (`d7bf366`) and the byte-consumed
baseline in `notes/results/parse-consumed.jsonl` all treat 0.46 codegen as the
oracle for what a scope should be. It is a good *baseline* — it is the last build
that parsed the corpus whole — but it is not a *specification*, and a grammar
whose emission order differs from jess's could have made 0.46 disagree with
itself. Anything in 0.48 that reasons "codegen did X, therefore X is right" needs
its own argument. Nobody has written down what the trivia scope rule IS,
independent of an engine that reproduced it accidentally.

---

## 10. HISTORICAL `90aa867` DEFECT SNAPSHOT — current dispositions

None of this was fixed at `90aa867`. The descriptions are retained because they
govern measurements taken at that checkout; all five findings have since been
closed before 0.47 shipped or ruled by design.

1. **LANDED (`8683433`): the `*-lines` grammar variants could not parse
   anything.** `ast-lines` and
   `cst-lines` (`bench/jess/grammars.ts:42`, `trackLines: true`) build a
   self-referential `OP_RULE ip→ip` and stack-overflow on **every file of every
   corpus**, all four dialects. It was pre-existing, not introduced by the 0.47
   stack. Consequence for measurements at that checkout: every consumed sweep
   and every A/B figure quoted there is `variant: 'ast'` only, so those figures
   leave **`trackLines` unmeasured, not measured-and-fine.** The fix prevents the
   self-referential rule row; the post-fix sweep covers the line variants.

2. **LANDED (`d0036b4`): `benchmark.jess` accepted 0 of its 124 bytes.**
   `ok: true`, `errors: 0`,
   `consumed: 0` — on **0.46 and 0.47 alike**, on all of `compiled`,
   `interpreted` and `table`. Verifiable in `notes/results/parse-consumed.jsonl`
   without re-running anything. This is the silent-truncation failure mode the
   whole consumed baseline exists to catch, sitting in the jess dialect's own
   timing fixture, and it predates the release. Any `jess` row in any chart is
   measuring an immediate accept of nothing if it came from that snapshot. The
   document-root trailing-trivia fix restores 124/124 consumption.

3. **LANDED (`958f6ad`): `tolerant: true` assemblies refused emission in all
   four dialects.** At that checkout,
   `src/table/emit-assembly.ts:372` threw `Unemittable('a recovery (tolerant)
   assembly')`. Recovery parses therefore run the **closure engine**
   (`src/table/assemble.ts`), never the emitted assembly used by the historical
   strict runtime-compile harness. Every recovery figure describes a different
   engine from every strict figure at that checkout. Tolerant emission was later
   implemented for experiments, but final 0.47 removed the normal construction
   split and ships the compact closure route for both; the old figures remain
   engine-specific historical evidence.

4. **LANDED (`b25be52`): `parseClassOperand` had a latent compound-body hole.**
   It accepted any body
   that starts `[` and ends `]` (`src/regex/classes.ts:82`), so
   `[ \t\n\r\f]*[\$(]` — a sequence — parses as one class whose members are the
   garbage union of everything between the outer brackets. The 0.47 fix put the
   guard `isWholeClassToken` at **one caller**
   (`src/table/scan-shapes.ts:659`), deliberately, to avoid moving first sets.
   The completed fix moved the contract into shared `parseClassOperand`: a class
   must close at the fragment's final character, so the trivia and first-set
   callers now reject compound bodies too. Regression tests pin the shared
   behavior.

5. **REJECTED AS A DEFECT — owner ruling: `forCtx` is G5's run-start step.** The
   artifact's option values arrive on each call, so selecting the assembly before
   that boundary would require changing the artifact contract. `forCtx` reads the
   options once at entry, chooses the specialized assembly, and nothing past that
   point branches on them; INV-6 enforces the latter mechanically. The detailed
   argument and the measured one-call-per-entry result now live beside `forCtx`
   in `src/table/assemble.ts`. This is the criterion's first clause — *build the
   grammar reference on run start* — not its prohibited second clause.

---

## Standing hazard for anything above

**EVERY `PM_TABLE_COUNT` FIGURE DESCRIBES THE REFERENCE OPCODE ENGINE, NOT THE
SHIPPING CLOSURE ROUTE.** The counters
live in **`src/table/exec.ts` only** — `const COUNT = process.env.PM_TABLE_COUNT
=== '1'` at `exec.ts:101`, incremented inside the opcode `switch`. Neither
`src/table/assemble.ts` nor `src/table/emit-assembly.ts` counts anything, and
final 0.47 ships the compact closure linker in `assemble.ts`. So every row
count, arm-entry count and
per-op tally in this repo's notes and CHANGELOG — "497,360 rows for one parse of
`benchmark.less`", "ungated arm entries 268,834 → 67,027", "6,005 `OP_RX` rows
per `json/document` parse", any `OP_SCAN` execution count — is a measurement of
the **bytecode interpreter**, not of the shipping path.

They are not worthless: `exec.ts` is the reference the emitter is gated against,
so a row count is a fair proxy for *how much work the grammar implies*. They are
worthless as statements about *what the product executes*. The shipping closure
route links pieces and calls those pieces rather than executing the opcode
`switch`, so its work has a different shape. Historical emitted-path counts,
such as `balanced` entered **12 times** per 123 KB `benchmark.css` parse, are a
third engine-specific datum and are not a substitute for a closure-path profile.

**Rule: any count sourced from `PM_TABLE_COUNT` must name `exec.ts` in the same
sentence.** Do not compare one against a figure taken from the closure or emitted
engine without explicitly naming both routes and explaining the mapping.

**`expected` is NOT in the identity digest.** `bench/table-lowering-identity.ts`
digests `{ok, value, unconsumedFrom}`, so a table that accepts and rejects
exactly the right inputs while reporting a different error passes the entire
~2,800-file sweep. **Six** divergences hid that way during 0.47, three of them
between the two already-shipped engines. Compare `RunResult.expected` directly —
it is a TOP-LEVEL field; there is no `result.error`.
