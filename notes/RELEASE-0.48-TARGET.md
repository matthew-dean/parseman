# 0.48 target — what 0.47 deliberately shelved

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
`REFERENCE`; the disclosed defects with no owner are marked `UNCLASSIFIABLE`
rather than forced into `QUEUED`, because nobody has decided to do them, nobody
has rejected them, and they are not ideas — they are known-broken facts recorded
so a reader does not have to rediscover them.

## COUNTS — 30 items

| marker | count |
|---|---:|
| `LANDED` | 4 |
| `MEASURED-NULL` | 2 |
| `REJECTED` | 6 |
| **`QUEUED`** | **11** |
| `REFERENCE` | 4 |
| `UNCLASSIFIABLE` | 3 |

> ### **Untried in this file: 11, all `QUEUED`.** None is in `PERF_IDEAS.md`'s index; that index covers `PERF_IDEAS.md` only.
> §1 `_grammarTrace` parity for the table · §2 token streaming · §4 CST leaf span
> line-annotation (`TODO(table/expect-span-lines)`) · §7 expected-set granularity
> on rule refs (blocked on §6) · §8 the 0.47 parse-time regression, **the headline
> 0.48 item** · §8b the un-built **child-kind specialisation axis** · §9 recover
> the deleted literal/regex/trivia fast paths (= `PERF_IDEAS.md` **U-53**) · §9b
> write down what the trivia scope rule IS · §10.1 the broken `*-lines` variants ·
> §10.4 `parseClassOperand`'s unguarded callers · §10.5 `forCtx`'s per-parse
> config consult (= `PERF_IDEAS.md` **U-52**).

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
ms, **measured zero**, V8 already inlines it) · §4 `QUEUED` · §5 `LANDED`
(`c398044`) · §5b `LANDED` (`10d21d8`) · §6 stale `disjoint` flag `REJECTED` —
despite "deferred" framing, the recorded owner ruling is *not to fix it*, on
blast-radius grounds, not on a measurement · §7 `QUEUED` (pinned as a subset
relation, blocked on §6; the specific fix at :254 is `REJECTED` with evidence — it
collapsed JSON `[1,2,]` from seven expected tokens to one) · §8 `QUEUED`, the
headline · §8's "does not reproduce at scale" claim `REFERENCE` (a retracted
reading of a harness — `fixture.ts` **builds every leg at HEAD**; there is no 0.46
in the process) and its replacement measurement `REFERENCE` (the best-sourced
block in these five files: harness `bench/jess/ab.ts`, anchor `a5dc9bd`, config
`bench/jess/ab-config.json`, self-check 0.999–1.033, `benchmark.less` 106,802 B →
**2.221×**) · the shelf mechanism (`shelvedRegressionKeys`, no
`SKIP_PERF_GUARD=1`) `LANDED` as policy, though its stated justification is
withdrawn · §8b `QUEUED` for the child-kind axis, `REFERENCE` for the owner's
specification restatement; **the five mechanisms proposed for the gap during 0.47
are all `REJECTED`** and the file says "Do not re-propose them" — runtime
`compose()`, per-parse assembly, per-rule assembly, startup cost, interpreter
fallback · §9 `QUEUED` (= U-53) · §9b `QUEUED` · §10.1 `QUEUED` (lane assigned) ·
§10.2 and §10.3 **`UNCLASSIFIABLE`** — unassigned known-broken defects stated for
disclosure, with no disposition · §10.4 `QUEUED` · §10.5 `QUEUED` (= U-52) ·
`## Standing hazard` **`UNCLASSIFIABLE`** — a measurement-hygiene rule that
invalidates a whole class of prior figures, plus the `expected`-digest rider
(`PERF_IDEAS.md` U-55).

> ### THREE FACTS FROM THIS FILE THAT GOVERN EVERY OTHER FIGURE IN THE REPO
> 1. **`benchmark.jess` accepts 0 of its 124 bytes** — `ok: true`, `errors: 0`,
>    `consumed: 0`, on **0.46 and 0.47 alike**. Any `jess` row in any chart is
>    measuring an immediate accept of nothing.
> 2. **`tolerant: true` assemblies refuse emission in all four dialects**, so
>    recovery parses run the closure engine. Every recovery figure describes a
>    different engine from every strict figure.
> 3. **Every `PM_TABLE_COUNT` figure describes an engine nobody runs** — every row
>    count, arm-entry count and per-op tally in this repo's notes and CHANGELOG is
>    a measurement of the bytecode interpreter, not of the shipping path.
>
> Add to these `PERF_IDEAS.md` fact N: **39,718 records in
> `notes/results/parse-consumed.jsonl` are tagged `"engine":"table"` and are
> actually the reference interpreter**, 11 of 29 bench harnesses are mislabelled,
> and `CHANGELOG.md:756-762` (the "codegen / table / interpreter" fixture table
> present in this tree) carries the same defect. Its correction banner is on
> `lane/name-collision` (`7f954af`) and **is not merged into `release/0.47.0` yet**.
>
> Also open, and unmeasured: **`trackLines` is unmeasured, not
> measured-and-fine** — the `*-lines` grammar variants build a self-referential
> `OP_RULE ip→ip` and stack-overflow on every file of every corpus (§10.1).
>
> **`PERF_IDEAS.md`'s 2026-08-07 fact I1 also refutes a figure this file carries**:
> §3's "trivia scanner profiled at ~7.3% of parse self-time and was worth ~3.4%"
> is a third number for a path that `lane/capoff` measured as a **null**. Three
> documents, three numbers, one controlled measurement. Do not quote any of them.

---


0.47 is the table cutover: one lowering, one driver, the macro build emitting a
table instead of a second recognition engine. Everything below was found during
that work, understood well enough to size, and **deferred on purpose** rather
than half-done. Each entry says what it is, why it was deferred, and what it
costs to pick up.

Nothing here is a bug being ignored. The two wrong-parse defects found during
0.47 (`expect()` not clearing the ctx-global commit bit; `caseInsensitive`
dropped from dispatch matcher arms) were fixed in 0.47, not shelved.

---

## 1. `_grammarTrace` parity for the table

**What.** Coverage COUNTERS ship in 0.47. The six trace phases — `attempt`,
`selected`, `success`, `failure`, `backtrack`, `rollback` — do not.

**Why deferred.** Codegen emits them at roughly **40 fine-grained sites** in
`src/compiler/codegen.ts`. Matching that in the table is not a task, it is a
project, and it would have blocked the cutover for the duration. Owner ruling:
counters are enough to ship.

**Cost to pick up.** Every trace site needs a table equivalent, and the
instrumented pieces must stay assembly-SELECTED rather than testing a flag per
node (INV-6). Expect the `cfgKey` assembly-key space to need another bit.

---

## 2. Token streaming

**What.** Leaves consume classified TOKENS rather than characters.

**Why deferred.** It was an original requirement of the design that never
landed, and `src/compiler/token-scanner.ts` + `token-alphabet.ts` are already
in-tree as built-but-never-wired analysis — they carry `DEBT` entries in
`scripts/invariant-allowlist.mjs` pointing at `docs/design/derived-tokenization.md`.
0.47 stayed on the cutover instead.

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
grammars, is in §8: **2.2×–2.6×**, and it is a REGRESSION introduced at 0.47,
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

## 4. CST leaf span line-annotation

**What.** Under `trackLines`, the interpreter annotates `expect()` error spans
with line/column (`expect.ts:145`). Neither table driver does, and CST **leaf**
spans (the `pushCstLeaf` sites) are not annotated either.

**Why deferred.** Pre-existing, unrelated to the cutover, and fixing it needs
`spanLines` proven equivalent to `annotateSpanFromLineContext` first.
`recoverScan` annotates for everyone, so LIST recovery is unaffected.

**Marker in-tree:** `TODO(table/expect-span-lines)` at both sites. Two
assertions in `test/unit/line-index.test.ts` fail on this once `compile()` is
flipped.

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
probe ceilings are byte-identical is stale. `src/plugin/index.ts` imports BOTH
`compile` and `compileTable` and picks per unit. Measured: 10 of 16 emit
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

So the row labelled "reference" was the macro-lowered leg at HEAD, and at 0.47
the macro emits a table too. The contest was **emitted assembly against the
`exec.ts` opcode driver, both at HEAD** — table against table. It cannot answer
"versus the last release", and quoting it as if it could is what produced the
1.09× / 1.05× / 1.09× row. `bench/jess/ab.ts` now says so in its own header,
by name.

### What HEAD vs 0.46 actually measures

`bench/jess/ab.ts`, HEAD against `a5dc9bd` (v0.46.0, the anchor in
`bench/jess/ab-config.json`), jess's four SHIPPING grammars, `--two-graph`,
self-check 0.999–1.033:

| fixture | 0.46 | HEAD | ratio |
|---|---:|---:|---|
| `benchmark.css` 123,029 B | 5.67 ms | 14.97 ms | **2.641×** |
| `benchmark.less` 106,802 B | 17.40 ms | 38.65 ms | **2.221×** |
| `gen-workload.less` 275,211 B | 49.96 ms | 112.55 ms | **2.253×** |

**0.47 is a 2.2×–2.6× regression on the grammars a downstream parser ships.**
Not 4–9%, not "does not reproduce."

### Which release turned — 0.46 is NOT the regression, 0.47 is

Sweeping the same fixture across release anchors, `benchmark.less` reads:

| anchor | 0.44 | 0.45 | 0.46 | HEAD (0.47) |
|---|---:|---:|---:|---:|
| `benchmark.less` | 17.26 ms | 16.84 ms | 17.19 ms | 38.65 ms |

Flat across three releases, then it turns. Whatever landed in the 0.47 stack owns
all of it; there is no slow drift to blame and no earlier anchor that would
launder it.

**The consequence for the shelf.** `shelvedRegressionKeys` was justified on the
ground that the regression "does not appear in `bench:margin`" and "at real scale
measures 1.09%". The second half of that is withdrawn. The `css/selector` and
`css/decls` bars were *directionally right* and only wrong about magnitude — they
said css regressed, and css regressed 2.6×. The shelf is now hiding a real,
reproduced, at-scale regression, and 0.48's framing is **"recover a 2.2×–2.6×
regression"**, not "close a 4–9% gap."

### The engine inventory, because "the table" is now ambiguous

Three engines run in this repo, and a note that says "the table" without saying
which one is unreadable. On `benchmark.css` at HEAD:

| engine | module | `benchmark.css` |
|---|---|---:|
| emitted assembly — **what ships** | `src/table/emit-assembly.ts` | 13.23 ms |
| `exec.ts` opcode loop — the reference | `src/table/exec.ts` | 22.18 ms |
| closure interpreter | `src/functional/run.ts` | 43.42 ms |

`src/table/assemble.ts` links the closure pieces the emitter prints; it is the
fallback whenever emission refuses (see §10). Name the engine in any figure.

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

**What it appears to have cost.** CI `workload-perf`, HEAD vs the pinned
reference, on a quiet runner (load 0.27 → 1.37), null control worst median ±0.7%:

```
less/mixins       59 KB   median +780.6% … +810.9%   won 0/12   breached 5/5
css/stylesheet    64 KB   median +666.3% … +759.5%   won 0/12   breached 5/5
json/document     59 KB   median +126.9% … +134.3%   won 0/12   breached 5/5
graphql/document  49 KB   median  +93.4% … +112.6%   won 0/12   breached 5/5
```

**RECONCILED — and it was the dialect harness that was wrong, not CI.** This
paragraph used to read "UNRECONCILED": `bench/jess/fixture.ts` measured css 1.09×
and less 1.05× while CI measured +666% and +780%, and it listed three candidate
explanations. The third of them was the right one — *one harness's reference leg
is not the pre-deletion engine at all*.

`bench/jess/fixture.ts` builds **every leg at HEAD** (§8). Its `ref|` label is a
contest's a-side, not a reference build, so it had no pre-deletion engine in the
process and its 1.09× / 1.05× row is withdrawn. CI's `workload-perf` really does
interleave HEAD against a pinned reference, and it is not contradicted.

What remains open is only MAGNITUDE, and the two surviving measurements are
consistent in sign and roughly an order apart in size: CI's synthetic workloads
read +666%/+780% where `bench/jess/ab.ts` reads **+122%/+164%** (2.221×/2.641×)
on the shipping dialect grammars against the same 0.46 anchor. The remaining
candidate is the second one on the old list — the CI workloads lean harder on the
deleted scan fast paths than the dialect fixtures do. **Quote the `ab.ts`
figures for "what did this release do to a shipping grammar"; quote CI's for
"what did deleting these modules cost the workloads that exercised them."** They
are different questions.

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

## 10. KNOWN BROKEN AT 0.47 — stated here, not buried

None of this is fixed at `90aa867`. It is listed so a reader does not have to
discover it.

1. **The `*-lines` grammar variants cannot parse anything.** `ast-lines` and
   `cst-lines` (`bench/jess/grammars.ts:42`, `trackLines: true`) build a
   self-referential `OP_RULE ip→ip` and stack-overflow on **every file of every
   corpus**, all four dialects. Pre-existing, not introduced by the 0.47 stack, and
   a lane is on it. Consequence for everything else in this file: every consumed
   sweep and every A/B figure quoted anywhere is `variant: 'ast'` only, so
   **`trackLines` is unmeasured, not measured-and-fine.**

2. **`benchmark.jess` accepts 0 of its 124 bytes.** `ok: true`, `errors: 0`,
   `consumed: 0` — on **0.46 and 0.47 alike**, on all of `compiled`,
   `interpreted` and `table`. Verifiable in `notes/results/parse-consumed.jsonl`
   without re-running anything. This is the silent-truncation failure mode the
   whole consumed baseline exists to catch, sitting in the jess dialect's own
   timing fixture, and it predates the release. Any `jess` row in any chart is
   measuring an immediate accept of nothing.

3. **`tolerant: true` assemblies refuse emission in all four dialects.**
   `src/table/emit-assembly.ts:372` throws `Unemittable('a recovery (tolerant)
   assembly')`. Recovery parses therefore run the **closure engine**
   (`src/table/assemble.ts`), never the emitted assembly that ships for strict
   parses. Every recovery figure describes a different engine from every strict
   figure.

4. **`parseClassOperand` has a latent compound-body hole.** It accepts any body
   that starts `[` and ends `]` (`src/regex/classes.ts:82`), so
   `[ \t\n\r\f]*[\$(]` — a sequence — parses as one class whose members are the
   garbage union of everything between the outer brackets. The 0.47 fix put the
   guard `isWholeClassToken` at **one caller**
   (`src/table/scan-shapes.ts:659`), deliberately, to avoid moving first sets.
   The other callers — `src/combinators/trivia-skip.ts:511`, `:640`, and the
   first-set analyser — still call it unguarded. Nothing currently mis-lowers
   through them; nothing stops one from doing so.

5. **`forCtx` is still a per-parse option consult** — the last standing violation
   of this project's own stated criterion (*build the grammar reference at run
   start, make the swaps at that point, then run with no logic branching for that
   option input*). `src/table/assemble.ts:2672` reads five `ctx` fields per parse
   at the `runRule` boundary. It is one read per parse rather than per row, and
   its own comment concedes it is "THE ONLY CONFIG READ ON THE RUN PATH" — but
   the criterion says none. (That comment also still says "three-bit option set"
   while the code computes a five-bit key.)

---

## Standing hazard for anything above

**EVERY `PM_TABLE_COUNT` FIGURE DESCRIBES AN ENGINE NOBODY RUNS.** The counters
live in **`src/table/exec.ts` only** — `const COUNT = process.env.PM_TABLE_COUNT
=== '1'` at `exec.ts:101`, incremented inside the opcode `switch`. Neither
`src/table/assemble.ts` nor `src/table/emit-assembly.ts` counts anything, and
**the emitted assembly is what ships**. So every row count, arm-entry count and
per-op tally in this repo's notes and CHANGELOG — "497,360 rows for one parse of
`benchmark.less`", "ungated arm entries 268,834 → 67,027", "6,005 `OP_RX` rows
per `json/document` parse", any `OP_SCAN` execution count — is a measurement of
the **bytecode interpreter**, not of the shipping path.

They are not worthless: `exec.ts` is the reference the emitter is gated against,
so a row count is a fair proxy for *how much work the grammar implies*. They are
worthless as statements about *what the product executes*. On the emitted path
the same work has a different shape entirely — `balanced` is entered **12 times**
per 123 KB parse of `benchmark.css`, against opcode-level tallies in the
thousands, because the emitter folds the surrounding rows into straight-line
source rather than executing them as rows.

**Rule: any count sourced from `PM_TABLE_COUNT` must name `exec.ts` in the same
sentence.** Do not compare one against a figure taken from the emitted engine.

**`expected` is NOT in the identity digest.** `bench/table-lowering-identity.ts`
digests `{ok, value, unconsumedFrom}`, so a table that accepts and rejects
exactly the right inputs while reporting a different error passes the entire
~2,800-file sweep. **Six** divergences hid that way during 0.47, three of them
between the two already-shipped engines. Compare `RunResult.expected` directly —
it is a TOP-LEVEL field; there is no `result.error`.
