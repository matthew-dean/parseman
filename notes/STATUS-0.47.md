# Status — 0.47

Four questions, answered with provenance. Every number says what it was taken
on, with what protocol, and what its control spread was. A number without those
is not in this file.

## Provenance for every figure below

| | |
|---|---|
| base sha | **`67478722cc33fd6654fb44a48fd460a1ad5ced34`** (`origin/release/0.47.0`) |
| previous tip | `6bc265f5b854b256a2e8ea0df5522ca7cfd57770` — moved mid-report; see below |
| node | **v24.11.1**, darwin/arm64 |
| parseman | **0.47.0** |
| jess root | `/Users/matthew/git/oss/jess` @ `eeda0e28b`. It *installs* parseman 0.46.0; that is **not** what was measured — the bench hooks resolve `parseman` and `parseman/<sub>` into this worktree's `src/` |
| worktree | `scratchpad/pt-status`, branch `lane/status-report` |

**The base moved during this report.** It was `6bc265f` when the lane opened and
`6747872` by the time it closed, absorbing seven lanes in one window —
`lane/linker-engine`, `lane/capoff`, `lane/no-new-function`, `design/balance`,
`exp/cliff`, `exp/wiring`, and `exp/mixture`'s `cell.ts` fix. `src/table/` was
materially rewritten in that merge (`assemble.ts` +262 lines, plus
`emit-assembly.ts`, `exec.ts`, `program.ts`, new `cell.ts`). **Every size figure
below was re-measured at `6747872` rather than carried over.** Where a figure is
quoted from the repo rather than measured here, it is labelled with its commit.

---

## 0. The finding that governs how you read section 1

**There is no codegen lowering in this repo any more, and both of
`bench/jess/fixture.ts`'s engine columns are table lowerings.**

`src/compiler/codegen.ts` was deleted at `37c57b5`. Verified here from the
emitted artifact rather than from a note: running `transformMacro` on jess's CSS
grammar at `6747872` emits, at line 4 of its output,

```js
import { tableRules } from "parseman/table"
```

and `src/table/index.ts:28` aliases `assembledRules as tableRules`. So the macro
emits a **table module driven by the closure assembler**. Three engines exist;
`fixture.ts` names two of them wrongly:

| `fixture.ts` prints | binds | what it actually is |
|---|---|---|
| `codegen (shipped)` | `import('pm-macro:…')` → `parseman/table` → `assembledRules` | the **macro-fused shipping artifact**. Correctly "shipped", wrongly "codegen" |
| `table` | `tableRules` from **`src/table/exec.ts`** (`fixture.ts:36`) | the **reference bytecode interpreter** over a runtime `encodeTable`. Not the assembler, and not what ships |
| `interpreter` | `rules[ENTRY]` from `loadGrammar` | the combinator graph |

**The consequence is worse than a naming problem.** The two columns differ in
*both* the driver **and** the program, so their ratio confounds an engine
difference with an artifact difference and is not attributable to either.
`lane/capoff` reached this independently and stated it plainly:
"changing those column names changes what every published figure in this release
cycle means."

**Still unfixed on the release branch; a fix exists and is unmerged.** `git diff
6bc265f 6747872 -- bench/jess/fixture.ts` is empty, so `lane/capoff` landed and
the note documenting the mislabelling now sits on the release branch **beside the
harness it refutes**. `lane/name-collision` has since pushed **`48ac5f1`** — "one
engine, one name" — which renames `exec.ts`'s export to `execRules`, retires
`assembledRules` in favour of `tableRules` across 43 files, relabels
`fixture.ts`'s columns to `assembled (shipped)` / `exec (reference)`, drops the
`Nx codegen` ratio "whose quantity no longer exists", relabels 18 further
harnesses, and adds **INV-8** to gate the class (no specifier may bind one
engine's name to the other's; no `src/**/index.ts` may re-export a symbol under a
second name). It found a second live instance on landing —
`src/index.ts:36 compileTable as compile`. **That commit is not on
`origin/release/0.47.0`.** Until it merges, the release branch ships the wrong
names.

**Structural consequence for this report.** Architecturally there are **two**
paths — compiled and interpreter. There is no third. Any harness that appears to
offer a third is offering a bench-only construction, and `macro-vs-assembled.ts`
is one: its reference leg loads the grammar module **without** the macro, takes
the interpreted fuse, and calls `encodeTable(g.rules, {})` **directly** with empty
settings, bypassing `compile()` entirely (`macro-vs-assembled.ts:54-57`, verified
by reading it, not by report). **No product path performs that.** Its numbers are
in Appendix A, under a heading that says what the legs are, and nothing in the
body of this report rests on them.

---

## 1. Benchmark speed — `benchmark.css` and `benchmark.less`

### 1a. The honest answer: not measured at `6747872`

**The shipped-path absolute milliseconds for `benchmark.css` and `benchmark.less`
at the current release tip are UNMEASURED.** That is the question this report was
asked first and it is the one it does not answer. Naming the gap is a better
report than filling it with a proxy.

Two reasons, both deliberate.

1. **The floor was serialised all cycle**, and when it freed, an integration lane
   was running the full gate set across six merges serially. The 1-minute load
   average sat between 4.85 and 9.15 for the entire window in which I had the
   floor. The gate I committed to is **under 4.0** — stricter than the harness's
   own `LOAD_CEILING = 6` — and I did not lower it or reach for `PM_FORCE=1` /
   `SKIP_PERF_GUARD=1`. A forced figure is the exact class of number §1c exists to
   warn against.
2. **A figure taken now is stale on arrival.** `lane/macro-lowering` has two fixes
   to the shipped macro path that are diagnosed, counted and converging (§1b), and
   both land on the artifact every consumer ships. Paying the three-round protocol
   twice on a contended box has worse expected value than paying it once, after.

### 1b. What IS established about the shipped artifact, with no wall clock

The macro route encodes a **measurably wrong table**, and the evidence is
deterministic opcode counting rather than timing. Counted by
`lane/macro-lowering` at `6747872` — that is, re-derived after the seven-lane
merge, not carried over from the pre-merge base — comparing the program the macro
actually prints against `encodeTable()` over the same grammar:

| quantity | macro route | reference | after fix |
|---|---:|---:|---|
| SEQ (tuple-building sequence rows) | 326 | 8 | 8 / 8 |
| SEQV | 4 | 322 | 322 / 322 |
| REP (array-building repeat rows) | 110 | 20 | 20 / 20 |
| REPV | 20 | 90 | 90 / 90 |
| choice arms with no first set | 195 of 562 | 103 of 540 | 103 |
| dispatch sites losing O(1) `exclusive` | 10 | 0 | 41 sites restored |
| char-class pool | 109 | 167 | 167 |

**318 sequence tuples and 90 repeat arrays built per execution that nothing
reads**, and choice gating computed without the resolver the emission path uses.

Two independent causes, both in the rule map handed to the encoder, **neither in
the encoder itself**:

1. `plugin/evaluator.ts`'s `evaluateParserFactory` is the build-time `rules()`. It
   never ran `rules()`'s closing `markUnusedValues` pass
   (`combinators/parser.ts:246`). Nothing else sets `valueUnused` and the encoder
   branches on it directly.
2. `firstSetOf` / `matchesEmpty` degrade a `lazy` whose thunk **throws**. A runtime
   grammar never hits it — `composeLeaf` binds every `g.X` before the encoder sees
   the map. The macro does: `evaluateParserFactory` mints an `externalRefs` slot
   for a `g.X` this `rules()` call does not define, and never defines it, because
   the definition arrives in the merge. The arm still **encodes correctly** through
   `winners`, so the artifact parses the same bytes — with the gate switched off.

This is the solid result on the shipped artifact, it needed no quiet box, and it
survives the merge intact. What it does **not** carry is a cost in milliseconds.
Nobody has measured what those 318 tuples and 90 arrays are worth on
`benchmark.css` or `benchmark.less`, and this report does not guess.

### 1c. The protocol for whoever runs it

So it does not have to be re-derived:

```
pnpm bench:less                # benchmark.less + gen-workload.less
pnpm fixture:jess css          # benchmark.css
```

| | |
|---|---|
| path | `hostMode: 'ast'`, `trackLines: false` — canonical by owner ruling |
| composition | **PINNED** at three legs plus the control. Load-bearing: the legs share one heap, and dropping the interpreter leg moves its neighbour 18% (45.92 → 38.80 ms) while leaving the macro leg untouched |
| sampling | 8 rounds × 2 runs = 16 samples/side, ONE parse per repetition, each sample itself the median of 5 |
| statistic | **median** of the 16. Not min, not mean |
| control | in-run same-engine contest; its delta is the run's noise floor. A gap smaller than the control is not a result in either direction |
| gate | **1-minute load average under 4.0**, checked per leg, waiting rather than forcing. Never `PM_FORCE=1`, never `SKIP_PERF_GUARD=1` |
| rounds | **three minimum.** `lane/capoff` read −3.0% at ten legs and watched it collapse to −0.2% on the third base reading |
| provenance | print the sha, node version, loadavg at START **and** END. A run whose end load is far off its start load measured a moving box, ceiling or no ceiling |

Take them **after** `lane/macro-lowering` lands, and take 0.46 alongside via
`bench/jess/ab.ts` if the box allows — that harness genuinely interleaves HEAD
against a pinned reference, which `fixture.ts` does not.

### 1d. Absolute figures that exist today, with their provenance

Not measured by this lane. Quoted with commit provenance and with their known
defects attached.

**Cross-release, `bench/jess/ab.ts`, HEAD vs `a5dc9bd` (v0.46.0), `--two-graph`,
self-check 0.999–1.033** — recorded in `notes/RELEASE-0.48-TARGET.md` §8:

| fixture | 0.46 | HEAD (0.47) | ratio |
|---|---:|---:|---|
| `benchmark.css` 123,029 B | 5.67 ms | 14.97 ms | **2.641×** |
| `benchmark.less` 106,802 B | 17.40 ms | 38.65 ms | **2.221×** |
| `gen-workload.less` 275,211 B | 49.96 ms | 112.55 ms | **2.253×** |

Anchor sweep on `benchmark.less`: 0.44 **17.26** → 0.45 **16.84** → 0.46
**17.19** → HEAD **38.65**. Flat across three releases, then it turns. **0.47 is
a 2.2×–2.6× regression on the grammars a downstream parser ships**, and no
earlier anchor launders it. Independently corroborated by `verify/jess-ab`
(`4f3ce6e`), an adversarial check whose verdict on the opposite claim was "it is
inverted."

**Per-engine on `benchmark.css` at HEAD**, from the same section:

| engine | module | `benchmark.css` |
|---|---|---:|
| emitted assembly — what ships | `src/table/emit-assembly.ts` | 13.23 ms |
| `exec.ts` opcode loop — the reference | `src/table/exec.ts` | 22.18 ms |
| closure interpreter | `src/functional/run.ts` | 43.42 ms |

**Standing reference for `benchmark.less`** under the pinned 3-leg
`fixture.ts` composition, from `docs/design/canonical-fixture-benchmark.md`:
shipped-macro ~16.4–17.4 ms, reference-driver ~45.9 ms, interpreter ~99.7 ms,
control ±1.2%. Note that this is a *different harness composition* from
`macro-vs-assembled.ts` — dropping the interpreter leg alone moves the reference
driver 18% (45.92 → 38.80 ms) while the macro leg does not move, and reps=3
batching reads +6.7% slower per parse than reps=1. **Absolutes are
harness-relative; only the within-run ratio travels.** That is precisely how this
fixture acquired two remembered baselines 27% apart.

### 1e. Figures that must not be quoted

| figure | status |
|---|---|
| **2.0–2.3× table-vs-codegen** | **UNEXAMINED as that claim.** Origin `lane/emitprofile` `c274a04` §1 measured 0.46 `macro→source` vs HEAD `macro→emitted` — a **release regression**, not a table-vs-codegen ratio. `design/balance:notes/DESIGN-piece-library.md:40` re-quotes it as a property of "the fully abstract closure table"; `c274a04` measured no such thing and **that line is not retracted** — it is the live re-entry point. `lane/capoff` states it "remains unexamined — neither refuted nor corroborated" |
| **1.61–1.63×** | withdrawn — "a ratio between two mislabelled columns" |
| **1.66×** | **no surviving provenance.** No fixture, commit or harness anywhere in the repo |
| **4.4×** | `css/selector` + `css/decls`, owner-ruled **toy micro-bars** |
| **1.66×–4.4× range** | a range between an unsourced figure and a micro-bar |
| **1.09× / 1.05× / 1.09×** | **deleted.** `fixture.ts` builds every leg at HEAD; its `ref|`/`head|` are a/b contest labels, not builds. It was table against table, and cannot answer "versus last release" |
| **46.3 / 26.8 MB/parse** | **retracted, unreproduced.** Use **34.7** |

On allocation: **34.7 MB/parse** is the figure with provenance — `benchmark.css`
(123,029 B), 100 parses after 5 warmups, `--trace-gc` byte deltas, every parse
verified `ok` with full `consumed`. Cross-checked `90e115c9` 34.78 → `6bc265f`
34.68 (0.3%), and independently re-read at 34.68 → 34.29. **Gap worth naming:
34.7 is HEAD-side only.** No re-measured 0.46 counterpart exists, so there is
currently **no surviving HEAD-vs-0.46 allocation ratio** — the "+19.5 MB/parse,
1.73×" claim rested entirely on the retracted pair and dies with it.

---

## 2. Macro output size per grammar — and an independent corroboration

**This is the strongest result in this report and it is not supporting material.**
It measures the same defect as §1b on a completely different axis, it is
deterministic, and it is immune to load, to harness composition and to every
failure mode that has cost this cycle its time.

Machinery: `bench/jess/size.ts` (`pnpm size:jess`), which drives **both** sides
from this worktree's `src/` over the **same** grammar module and the **same**
reducers. The macro side is `transformMacro` — the lowering a build actually
splices, not a reconstruction of it.

**Naming, per §0.** `size.ts` prints its two columns as `codegen` and `table`,
inheriting the same wrong vocabulary as `fixture.ts`. They are **macro artifact**
and **`emitTableModule` over a runtime `encodeTable`** respectively — both table
lowerings. Every table below is relabelled; the raw harness output is not.
`48ac5f1` relabels `fixture.ts` and 18 other harnesses but **`size.ts` is not
among them**, so this one still prints `codegen` today.

### 2a. Macro output, as shipped — raw and gzip, whole artifact

The shipped module carries **all four `(trackLines × hostMode)` variants**, so
this is the byte count a consumer's bundle actually takes.

| grammar | source | macro raw | macro gzip | raw ÷ source |
|---|---:|---:|---:|---:|
| **css** | 118,981 B | **468,985 B** | 97,137 B | 3.94× |
| **less** | 267,078 B | **1,075,155 B** | 206,370 B | 4.03× |
| **scss** | 174,531 B | **684,983 B** | 134,947 B | 3.92× |
| **jess** | 202,508 B | **719,362 B** | 154,476 B | 3.55× |
| all four | 763,098 B | **2,948,485 B** (2.81 MB) | | 3.86× |

Against the standing "codegen ≤4× source" acceptance target: **css, scss and
jess pass; less is at 4.03× and marginally over.** Raw bytes of emitted output
over raw bytes of grammar source, which is the target's own unit.

**Not netted off any figure above:** the shared driver is **135,398 B** of TS
source across `src/table/exec.ts`, `program.ts`, `ops.ts`, added to a bundle
**once**, by all grammars and all variants together.

### 2b. Per-variant, AST path — and the gap

Canonical path, `hostMode: 'ast'`, `trackLines: false`. One dialect, one variant,
both lowerings, same reducers. "Table" here is `emitTableModule` over
`encodeTable` of the interpreted fuse.

| grammar | rules | macro raw | table raw | ratio | macro gzip | table gzip | gzip ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| **css** | 195 | 212,420 B | 84,837 B | **2.5×** | 46,149 B | 16,844 B | **2.7×** |
| **less** | 278 | 478,649 B | 318,419 B | **1.5×** | 97,393 B | 38,642 B | **2.5×** |
| **scss** | 209 | 303,911 B | 140,057 B | **2.2×** | 65,224 B | 22,697 B | **2.9×** |
| **jess** | 237 | 336,233 B | 148,707 B | **2.3×** | 75,531 B | 26,289 B | **2.9×** |

Machinery only, with the author's reducers excluded from both sides — they ship
under either lowering and are neither one's credit:

| grammar | reducers | macro machinery | table machinery | ratio | macro B/rule | table B/rule |
|---|---:|---:|---:|---:|---:|---:|
| css | 19.6 KB | 187.8 KB | 63.2 KB | **3.0×** | 986 | 332 |
| less | 67.1 KB | 400.3 KB | 243.8 KB | **1.6×** | 1,474 | 898 |
| scss | 39.4 KB | 257.4 KB | 97.4 KB | **2.6×** | 1,261 | 477 |
| jess | 46.4 KB | 282.0 KB | 98.8 KB | **2.9×** | 1,218 | 427 |

**The obvious confound was tested and excluded.** The macro preserves the source
module's JSDoc, which a bare `emitTableModule` does not. Measured by stripping
block and line comments from the emitted output: comments are **7.9% (css), 6.3%
(less), 9.4% (scss), 9.4% (jess)** of the macro artifact. They cannot account for
a 1.5–3.0× gap. **This is program bulk.**

### 2c. Why this matters

Both sides are the *same lowering* producing the *same parse* from the *same
rules*, and the macro artifact is **1.5–3.0× larger**. That is a size statement
about the macro route's encoding, on the same axis as §1b's opcode counts and
pointing the same way: the macro route emits more program for the same grammar.
It is **not** paired here with any millisecond figure, because none has been
measured on a shipping configuration.

**And seven lanes landed without moving it.** Re-measured across the merge:

| | `6bc265f` | `6747872` | Δ |
|---|---:|---:|---:|
| css macro, AST variant | 212,168 B | 212,420 B | +0.12% |
| less macro, AST variant | 478,241 B | 478,649 B | +0.09% |
| scss macro, AST variant | 303,767 B | 303,911 B | +0.05% |
| jess macro, AST variant | 335,969 B | 336,233 B | +0.08% |

All of that movement is the build stamp from `1643f17` / `b78b33a`. **Nothing
merged so far touches the defect**, which is consistent with the fix living on
`lane/macro-lowering` — and it means this table stands as a clean pre-fix
baseline to gate that fix against, at zero timing cost.

**Recommendation: gate `lane/macro-lowering` on this table as well as on its
timing.** Its own commit message makes this table the right instrument for two
independent reasons.

First, the fix's stated effect is *convergence onto the runtime encode*: SEQ 8/8,
SEQV 322/322, REP 20/20, REPV 90/90 exact; gating 195-of-562 → 103, dispatch sites
→ 41; char-class pool 109 → 167 to match. **Those are the same two programs this
table weighs against each other**, so if the convergence is real the 1.5–3.0×
column should collapse toward 1.0×, at zero wall-clock cost and with no quiet box
required.

Second, the direction is **not** simply "smaller". The commit records size-guard
going red on 8 compose/variant fixtures at +6 to +56 B, with variants-1/2/4 at
exactly +14/+28/+56 — 14 B per emitted program, fix 2 trading bytes for gating
data, **not rebaselined** because raising a ceiling needs owner sign-off. So the
net per-grammar movement is the sum of a removal (unread tuple/array construction)
and an addition (14 B/program of first-set data), and only measuring says which
dominates. That is exactly the case where a deterministic instrument beats a
prediction.

**Base note.** This lane first observed `lane/macro-lowering` at `51c525d`,
parented on the pre-merge `6bc265f`, and flagged that its counts had been derived
against an artifact that no longer ships. It has since rebased onto `6747872`;
`51c525d` is dead and nothing was measured on it. The counts in §1b are the
re-derived ones, and they came back **identical digit-for-digit** to the pre-merge
figures — so the diagnosis survives the merge intact. The flag is recorded because
the check was worth making, not because it found a defect.

### 2d. The 24-fixture size ceilings — green

`pnpm size:guard` **at `6bc265f`** — this one figure predates the merge and is
labelled accordingly rather than silently attributed to the tip.
`bench/size-baseline.json` cut at `f4d2099`, slack 0.1%: **24 fixtures, none above
its committed ceiling, every one at +0.00%.** Ratios run 0.2×–4.2× (worst: `probe/trivia-off` 4.2×,
`probe/trivia-on` 4.1×, `probe/hostmode-{ast,cst}` 3.9×, `probe/variants-4`
3.9×), all inside the published 10× target. Both halves of the two-sided ratchet
are green: nothing grew, nothing is sitting on unbanked headroom.

Caveat carried from the gate's own docs: a bytes-only gate cannot distinguish an
artifact that got smaller from one that got **emptier**. That failure has already
happened once — `compileTable` dropped the encoder's reducer sources,
`emitTable*` substituted `() => {}` for every author callback, and modules 8–34%
smaller loaded, parsed, reported `ok`, and returned `undefined`. The ceilings
were re-cut against them and the file recorded a defect as an improvement. The
empty-reducer refusal now in `measureExamples()` and `bench/size/probe.ts` is
what stops that recurring.

---

## 3. Experiments run this cycle — inventory

Base for every lane: `origin/release/0.47.0`. Seven of the nine productive lanes
have now merged into it at `6747872`.

### 3a. Requested branches

| branch | state | notes file |
|---|---|---|
| `exp/cliff` | 3 commits, merged (`f9ce7f3`) | `notes/EXPERIMENT-inlining-cliff.md`, `notes/results/inlining-cliff.jsonl` (275 rows) |
| `exp/wiring` | 2 commits, merged (`63bb1e2`) | `notes/EXPERIMENT-wiring.md`, `notes/results/wiring-sweep.jsonl` (34 rows) |
| `exp/mixture` | notes + jsonl, merged (`6747872`, `8ac6076`) | `notes/EXPERIMENT-mixture-sweep.md`, `mixture-sweep.jsonl` (208), `mixture-shape.jsonl` (8) |
| `design/balance` | 4 commits, merged (`e7ea7c4`) | `notes/DESIGN-piece-library.md` + 15 probes under `notes/probes/piece-library/` |
| `lane/capoff` | merged (`9d922ee`) | `notes/RESULT-capoff-trivia-scanner-is-a-null.md`, `notes/FINDING-rawchildren-collector-is-unread-in-ast.md` |
| `lane/linker-engine` | 3 commits, merged (`d7cb182`) | **no notes file** — results in commit messages + `bench/jess/macro-vs-assembled.ts` |
| `lane/no-new-function` | 8 commits, merged (`2ea0c1f`) | **no notes file** — results in commit messages, `test/unit/no-function-constructor.test.ts`, docs |
| `lane/macro-lowering` | **`51c525d`, one commit — but parented on `6bc265f`, NOT the tip.** Unmerged | none |

`lane/name-collision` was the same commit as `lane/linker-engine` (`249cbd9`)
when this lane opened; it has since advanced to **`48ac5f1`** on top of
`6747872`. Also unmerged. Both in-flight lanes are listed here because a reader
counting "what has been run" will otherwise miss them.

### 3b. What each lane measured and concluded

**`exp/cliff` — where the V8 inlining cliff is.** Swept call sites 1→40, hidden
classes, callee bytecode 70 B→52,188 B, capture counts, call chains, per-site
wrappers, with `%DebugPrint` / `%GetOptimizationStatus` / `--trace-turbo-inlining`
/ `--trace-deopt`. Noise floor stated first: A/A **3.7%**; nothing under ~4%
reported, every reported effect ≥17%.
*Concluded:* costs are (a) the 2nd distinct **executed** callee at a site, at
N=2; (b) the 5th distinct receiver map, +17–25%; (c) **callee bytecode crossing
~460 B, +23–53% — bracketed at 448 B inlines / 475 B does not.**
*Negative, and it is the important one:* the repo's design premise — shared
literal ⇒ `kManyClosures` ⇒ megamorphic ⇒ per-site bodies ⇒ `new Function` ⇒ CSP
broken — **does not hold.** "The CSP-breaking step was bought with nothing."
*Nulls:* capture count 0→8, all inside the floor. `--no-polymorphic-inlining`,
all inside the floor. Chain compounding, +21.8% vs +22.0%. No second size step
from 475 B to 52,188 B.
*Self-retraction:* the per-site wrapper recovering the `many` penalty was "an
artifact of my own benchmark driver" (`ce841d0`). One timing is explicitly
**owed** and flagged as a scored prediction, not a result.

**`exp/cliff` second output — the `trackLines` denominator.** No measurement run
at all, and it says so. Three competing divergence figures (16–21% / 66.3%+48.6%
/ 52–61%) are **not in conflict — 16–21% counts LINES, the others count BODIES**.
Two corrections rated above the reconciliation: 16–21% was measured on
`src/compiler/codegen.ts`, **deleted at `37c57b5`**, and should not be carried
forward whatever its denominator; and `trackLines` also disables a structural
emit-time swap (`emit-assembly.ts:371 swapLegal`).

**`exp/wiring` — how pieces get wired at run start.** Seven respellings (direct
name / array index / object property / closure capture / mono wrapper / switch
dispatch / shared snapshot prologue) against real emitted assembly and real
corpora. **"Every number in this file is deterministic … Not one wall-clock
measurement was taken."** Two guards: a byte-accounting splitter that throws, and
a per-leg parse-identity check.
*Concluded:* wiring shape is free at 800-byte real bodies; **callee bytecode size
is the whole story**, cutoff bracketed 424 B / 647 B and proven causally by
raising `--max-inlined-bytecode-size` to 900 → zero refusals. 17–28% of real
pieces are already over 460 B and **they are precisely the composites**. Best win
found: sharing the piece-free CST snapshot prologue, **−25.2% bytes on json with
MORE inlining (22 vs 19)**.
*Negative:* switch dispatch is the only actively worse wiring (9 inlined vs 19,
53 refusals). The monomorphic wrapper is near-pure byte cost (+5.8%) because
there is nothing to dedupe — 27 of 28 json bodies distinct, 296 of 349 less.
*Retracts a standing brief figure:* "~80% of piece bodies are option-invariant" —
measured on the emitted assembly, the invariant fraction is **39–48%, not ~80%**.
*Near-miss:* a first run read a 19× inlining collapse that was entirely an
artifact of anonymous function expressions vanishing from the trace.
*Killed legs:* css and graphql were deliberately killed at loadavg 20 to protect
another lane's timing floor — the seven-wiring byte table is json-only.

**`exp/mixture` — per-construct {shared driver, specialised} sweep.** The brief's
requested `table` vs `src/compiler/codegen.ts` axis **does not exist at this SHA**;
sweeping it would have measured the presence of `new Function`.
*Concluded, bytes only:* all-specialised → all-shared is an **8.2×–9.9× size
lever** (css 1,021→125 KB, less 1,986→218, scss 1,369→138, jess 1,443→160).
CHOICE/SEQV/NODE/REPV/OPT/RX carry 77% of recoverable bytes on less.
*Prediction refuted:* forward and reverse sweeps were predicted to disagree.
"On the byte axis they do not disagree at all" — they agree to the byte.
*Explicit non-result:* **"NO TIMING TAKEN … Do not quote a speed conclusion from
this file; there isn't one in it yet."** Every `timing` field is `null`; the box
was at loadavg 10.7 against a ceiling of 6. **"A 9× size lever is not a
recommendation."**
*Controls that caught real defects:* a row counter firing before the override
seam mis-charged 104,891 phantom NODE driver rows; the mechanism control priced
the per-dialect mixture constant at +28,764 B.
*Unusable data, called out rather than published:* jess's row-count column —
`benchmark.jess` is 124 B and densities read in tens of thousands.

**`design/balance` — the piece library design.** Supersedes
`notes/DESIGN-child-kind-specialisation.md` and its three reviews; that design's
central inference is "measured wrong in this document, at §1". Stated law as
measured: *a call site inlines iff the callee's bytecode is under ~460 bytes AND
exactly one FunctionLiteral is executed there AND the receiver carries no more
than four distinct hidden classes. Closure count does not matter. Wiring does not
matter. Bound data does not matter.* Calls have **no polymorphic tier** — "'V8
tolerates a few shapes at a call site' is true of property access and false of
calls."
*Self-retractions, all of its own inventions:* **"There is NO 460–4,600 dead
zone. I invented it and it does not exist"** (920 and 4,600 are caller-side
budgets, not callee sizes); H-1's cumulative-budget mechanism superseded; D6 and
D7 killed (`d026e56`); the `09f3452` inflation caveat "retracted entirely … That
caveat was speculation and it was wrong."
*Discipline note worth keeping:* "the fastest response would have been to retract
89%, and that would have thrown away a correct measurement. **Reconcile before
retracting.**"

**`lane/capoff` — the labelled-trivia scanner fix. A NULL, and the null is the
point.** `bccc32f` vs `6bc265f`, one file, git-toggled by SHA in one directory,
**3 interleaved base/fix rounds × 2 dialects = 12 legs**, each waiting for load
< 4, no `PM_FORCE`, three-way agreement YES on every leg.
*Concluded:* every delta (−2.1% … +0.7%) is inside its own base-to-base spread
with inconsistent signs. The fix is **not** inert — `triviaScanLowered` verified
flipping `[false×4]`→`[true×4]` in the emitted table. **"Therefore trivia
scanning was not 28% of parse time, and the coarse-interval self-time attribution
that produced that figure is wrong by more than an order of magnitude."** This
refutes `lane/emitprofile`'s 28.4% / 27.5% attribution.
*Also null:* allocation, css 34.68 → 34.29 MB/parse, less 64.48 → 64.56. Should
land as a **correctness fix with no perf claim**.
*Two harness facts established:* the `fixture.ts` mislabelling (§0 above), and
that `fixture.ts` shows **no `interleave()` order effect** across 21 CONTROL rows
(−1.5%..+1.9%) — the +12–15% belongs to `g5-ms.ts`'s own contest wiring.
*Self-correction:* "An earlier draft of this note blamed the composition tax for
the gap. **That was wrong and this run's own data refutes it.**"

**`lane/capoff` second output — `rawChildren` is collected and never read.**
Every AST parse maintains two parallel child collectors; `rawChildren` can only
be read by a CST host or a 4-arity build reducer and neither exists in any
shipping grammar. `buildReadsRaw` is exported and never called; there is no flag
bit for raw in the encoder. **OPEN, deferred out of 0.47.** Honest self-limit:
the arity walker "under-reaches" (7 defs for css against 131 `OP_NODE` sites) —
"treat the arity result as a strong indication, not a census." Negative controls
recorded: not the cap-site labels, not the `buf` axis, not the stale-assembly
defect.

**`lane/linker-engine` — which engine actually runs on the shipped paths.**
`65fc9a4`: `compose()`/`fuse()` and the variant fold **ran the reference bytecode
interpreter**, because `src/table/exec.ts` and `src/table/index.ts` both export
`tableRules` with identical signatures. `table/fold.ts` — a shipped product path,
since `emit.ts` writes `import { tableVariants }` into every folded artifact —
and `compiler/linker.ts:334`, the only engine selection on the compose/fuse path,
both bound the wrong one. `src/table/index.ts`'s own header claim that `exec.ts`
is "not on the product path and nothing emitted imports it" was **false in both
halves**. `249cbd9` is the measurement in §1b.

**`lane/no-new-function` — the macro artifact must never reach `Function`.**
`d63f915`: two shipped documentation statements ("No `new Function`, no `eval` in
the emitted code") were **false** — the first `parse()` built the emitted assembly
with `new Function`. The new property test proxies `globalThis.Function` for both
construct and apply and asserts zero calls: **on unmodified `6bc265f`, 9 of 10
RED.** "The one green was the static text scan — which is exactly why a scan
alone is not the gate."
*Negative side priced honestly:* pre-compiling is a speed option and stays **off
by default** — json module 1,382 → 58,823 B (**42.6×**), css 8,987 → 341,517 B
(**38.0×**). "Defaulting it on would hand back the 14× size win the table
lowering exists for."
*Also:* `e143848` — `parser(opts, root)` read fixed options nine times per scope
entry, fixed by link-time variant selection and gated by new INV-7, proven to
have teeth. `44a02f7` — pre-compiled-vs-constructed identity sweep, 26/26
identical, digest including `expected` "because six of them hid there during
0.47", each row printing which engine each leg ran so that "two dead legs agree
perfectly" cannot be reported as agreement. Deliberately made RED first.

### 3c. Lanes not in the brief that carry results

| branch | what it concluded |
|---|---|
| `lane/emitprofile` (`c274a04`) | Profiled the 0.47 regression on the shipping engine; ~40.8%/40.9% of it is in files 0.46 never enters. Dead hypotheses recorded: deopts are not the mechanism (4 vs 3 post-warm), emitted-body size is not the mechanism, the brief's size figures were wrong by 5.3–7.2×. **Its 28.4%/27.5% trivia share is refuted by `lane/capoff`; its 46.3/26.8 MB/parse is retracted.** |
| `lane/floorprobe` (`bce95b0`) | json's ~137% floor ≈ per-op closure graph (81% of isolated delta) + **cross-grammar deoptimisation (+33% table, 0% reference)**. css/less excess is three costs, not one. **Both brief hypotheses dead by counting.** One previously-refuted hypothesis — megamorphic dispatch — "is alive after all." |
| `verify/jess-ab` (`4f3ce6e`) | Adversarial verification of "0.47 beats 0.46". **"The claim does not survive. It is inverted."** 2.01×–3.78× slower; the 0.47 column reproduces, the 0.46 column does not. |
| `design/child-kind`, `-v2`, `review/{predictions,law,coverage}` | The **superseded** design and its three adversarial reviews, which "upheld the FeedbackCell mechanism but nobody tested the conclusion drawn from it." |

### 3d. The null and negative ledger

Several of these are worth more than the positive results, and all of them are
load-bearing:

- capoff trivia-scanner fix: **NULL** — and it refutes the 28% self-time attribution.
- capoff allocation: **NULL** — 34.68 → 34.29 MB/parse.
- cliff capture count 0→8: **NULL**, inside the floor.
- cliff `--no-polymorphic-inlining`: **NULL**, inside the floor.
- cliff call-chain compounding: **NULL** — +21.8% vs +22.0%.
- the "460–4,600 dead zone": **DOES NOT EXIST**, retracted by its own author.
- cliff `many`-wrapper recovery: **harness artifact**, retracted; D7 gets nothing.
- wiring's 19× inlining collapse: **artifact** of anonymous function names, caught.
- mixture forward-vs-reverse ranking disagreement: **predicted, did not occur**.
- mixture time axis: **not measured at all** — the 9× size lever is unpaired.
- per-`node()` capture allocation (~291k allocs/parse), predicted 1.5–3.0 ms: **zero**. V8 already absorbs young-gen non-escaping allocation.
- CST mark protocol, one `_cstBuf` load instead of three, predicted 0.5–0.9 ms: **zero**. V8 already inlines it.
- labelled-trivia char scanner, predicted 1.2–1.6 ms: **−0.8 ms, real** (16/16 wins, ±1% control) — the one that paid.
- `benchmark.jess` is **not a fixture** — 124 B, consumes 0 of its 124 bytes while returning `ok: true`, on 0.46 and 0.47 alike.
- **`*-lines` variants have no baseline at all** — stack-overflow on every file of every corpus. `trackLines` is unmeasured, not clean.

**The methodological lesson the cycle keeps re-teaching**, in the target doc's own
words: three successive drafts named a priority from a bench that could not
answer the question. The third had numbers, a control and three-way agreement and
was still wrong, because the *legs* were wrong. **A control proves the box was
quiet. It does not prove the two sides are different builds. Check what a harness
builds before quoting what it prints.** §0 of this report is the same failure,
still live on the release branch.

### 3e. A stale artifact worth fixing

`notes/results/README.md` states "Five builds, 31,207 records" and adds that an
earlier "three builds, 19,859 records" note is stale. The actual
`notes/results/parse-consumed.jsonl` is **11 distinct `parsemanSha`s / 87,947
rows**, including two builds absent from the README's table. The README's two
documented traps still hold: `consumed` is meaningless when `ok` is false, and
everything is `variant: 'ast'` because the `*-lines` variants stack-overflow.

---

## 4. How many experiments are on the to-try list

### The answer you should act on

**The backlog cannot be counted honestly, and that is the finding.** The eleven
files use **six mutually incompatible status vocabularies**, and — this is the
part that makes automation impossible — **the same glyph means different things
in different files and sometimes in the same file.**

The decisive case: `~~strikethrough~~` means

- **LANDED** in `PERF_IDEAS.md` — `### ~~1. Choice fast paths disabled in CST grammars~~ ✅`
- **REJECTED** in `INTERPRETER_PERF_IDEAS.md` — `### ~~6. Avoid throwaway trivia contexts~~ ❌`
- **"someone else fixed it, do not chase"** in `PERF_IDEAS.md` idea #3 — `~~ensureProv…~~ ✅ FIXED BY CORE`

Three meanings, two of them wearing the identical `~~…~~ ✅` glyph pair.
`PERF_IDEAS.md` alone carries **nineteen distinct status spellings**.

Marker census:

| file | ✅ | ❌ | `~~` | `- [ ]` | `⬜` |
|---|--:|--:|--:|--:|--:|
| `PERF_IDEAS.md` | 20 | 2 | 21 | 0 | 0 |
| `INTERPRETER_PERF_IDEAS.md` | 5 | 1 | 6 | 0 | 0 |
| `size-reduction.md` | 1 | 0 | 7 | 11 | 0 |
| `CODEGEN-FAST-PATHS.md` | 5 | 0 | 0 | 0 | 1 |
| `RELEASE-0.48-TARGET.md` | 0 | 0 | 0 | 0 | 0 |
| `TOKEN-STREAM-GROUNDWORK.md` | 0 | 0 | 0 | 0 | 0 |
| `REVIEW-parseman-perf-proposals.md` | 0 | 0 | 0 | 0 | 0 |
| `native-lowering-investigation.md` | 0 | 0 | 0 | 0 | 0 |
| `PERF-RANKING` / `PERF-dispatch` / `PERF-node` | 0 | 0 | 0 | 0 | 0 |

**Seven of eleven files carry no status glyph at all.** In
`RELEASE-0.48-TARGET.md` §9 you must read four paragraphs before learning the
section describes an accidental deletion rather than a planned task.

### The range, with its method stated

**28 – 46 distinct untried performance experiments. Best single estimate ~34, ±6.**

| bound | method |
|---:|---|
| **28** | parse-speed only; `Remaining:`/`Next:`/`Follow-on:` residuals excluded; discouraged items excluded; containers counted once; full cross-file dedup |
| **~34** | parse-speed only; residuals **included**; discouraged items included but counted once; containers counted once; cross-file dedup applied |
| **46** | as above **plus** `size-reduction.md`'s 9 size items and sub-variant expansion (`§7c` → 5, `§5` wiring steps → 6) |
| ~~55~~ / ~~64~~ | naive sum with no dedup, perf-only / including size. **Distrust this number** |

The spread is not imprecision — it is four judgement calls that would otherwise
be made silently: whether residuals hanging off `✅` items are backlog (±8),
whether "untried but actively discouraged" counts as queued (±6), whether size
items are perf experiments (±9), and whether containers like `§7c` are one idea
or five (±5).

### Per file

| file | total units | landed | partial | rejected | **untried** | ambiguous |
|---|--:|--:|--:|--:|--:|--:|
| `PERF_IDEAS.md` | ~95 | ~22 distinct (35 raw) | 9 | 12 | **32** | 8 |
| `INTERPRETER_PERF_IDEAS.md` | ~25 | 13 | 1 | 5 | **5** | 1 |
| `REVIEW-parseman-perf-proposals.md` | 5 | 1 | 0 | 0 | **4** | 1 |
| `CODEGEN-FAST-PATHS.md` | 7 distinct (8 raw) | 5 | 0 | 0 | **2** | 0 |
| `RELEASE-0.48-TARGET.md` | ~27 | 3 | 1 | 7 | **4** perf (+3 non-perf) | ~9 |
| `TOKEN-STREAM-GROUNDWORK.md` | ~14 | 0 | 1 | 1 | **5 distinct** (6 raw) | 4 |
| `size-reduction.md` | ~24 | 8 | 1 | 6 | **9** (size, not speed) | 3 |
| `PERF-RANKING-regex-vs-rest.md` | 4 | 1 | 0 | 0 | **0 unique** | 0 |
| `PERF-dispatch-vs-choice.md` | 0 | — | — | — | **0** — not a backlog file | 0 |
| `PERF-node-project.md` | 1 | 0 | 0 | 0 | **1** (a measurement task) | 0 |
| `native-lowering-investigation.md` | 1 | 0 | 0 | 0 | **1**, explicitly de-queued | 1 |

### Duplicates — why naive summing is wrong

**18–24 of the ~55 naive untried items are restatements — 30–40% overlap.**

| cluster | appears in | ×|
|---|---|--:|
| first-char / dispatch specialisation | `PERF_IDEAS` §7b+§7c, `INTERPRETER` §3, `CODEGEN-FAST-PATHS`, `PERF-dispatch-vs-choice`, `RELEASE-0.48` §6, `TOKEN-STREAM` §2+§5 | **6** |
| trivia-skip / `_tf0` call-site reduction | `PERF_IDEAS` IDEA#5 + Q-40 #3 + Jess-host 3, `REVIEW` 2.2, `PERF-RANKING` #3 | **5** |
| regex / scan lowering | `PERF_IDEAS` §8+§8a–i, `INTERPRETER` §1, `PERF-RANKING` #4, `RELEASE-0.48` §9, `TOKEN-STREAM` §0.4 | **5** (contradictory status) |
| trivia fast-path / scanner | `PERF_IDEAS` §6+§6b, `INTERPRETER` §4, `CODEGEN-FAST-PATHS`, `RELEASE-0.48` §3+§9 | **5** |
| single-frame node-scope save/restore | `PERF_IDEAS` §2 rejected table + Q-40 §4a + Jess-host 4, `REVIEW` 2.3 | **4** (§4a **landed** while `REVIEW` still lists it open) |
| kind-filtered trivia capture | `PERF_IDEAS` ×3, `REVIEW` 2.5 | **4** |
| collapse `children`/`rawChildren` | `PERF_IDEAS` IDEA#2 + Jess-host 2, `REVIEW` 2.1, `PERF-RANKING` #1 | **4** |

**Two whole files contribute zero unique backlog.**
`REVIEW-parseman-perf-proposals.md` restates `PERF_IDEAS.md`'s Jess-builder-host
section, which itself opens by saying it is that document reshaped.
`PERF-RANKING-regex-vs-rest.md` is a *ranking* of items `PERF_IDEAS.md` owns.

Within-file duplication before you even reach cross-file: 13 `PERF_IDEAS.md`
headings are "Moved to Already landed" pointers to bullets already counted, and
its "Top ideas in one line each" restates IDEA #1–#7 verbatim.
`size-reduction.md` lists "Hash-cons identical lowered rule bodies" **twice
adjacently, once `- [x]` and once `- [ ]`, both struck through**.

### Three load-bearing contradictions to resolve before any planning pass

These are not untidiness — each is a case where two files at the same commit
disagree about whether work exists.

1. **Is fuse-time first-set dispatch shipped or open?** `size-reduction.md` has
   it as an open `- [ ]` and calls it "the real perf lever"; `PERF_IDEAS.md`
   IDEA#6 says it shipped in release/0.15.0 with a ~30% jess win and is working
   end to end.
2. **How much of `RELEASE-0.48` §9's six deleted fast-path modules is genuinely
   back?** §9 lists all six to recover; `TOKEN-STREAM-GROUNDWORK.md` §0.4 says
   the largest is already restored as `scan-shapes.ts` (1,578 vs 1,627 lines) and
   live on the shipping path.
3. **Does `CODEGEN-FAST-PATHS.md` describe a live engine?** All five of its `✅`
   marks describe `src/compiler/codegen.ts`, **deleted at 0.47**, with nothing in
   the file saying so. `REVIEW`'s #1 open recommendation has the same problem in
   the other direction — it landed as `_triviaCaptureMask` and the file does not
   know.

If you want a single working number, use **~34**, and treat `PERF_IDEAS.md` as
the sole source of truth — it owns roughly 32 of them, and every other file is a
subset, an expansion, or a stale restatement of it.

---

## Open items this report leaves

1. **THE HEADLINE NUMBER IS MISSING.** `benchmark.css` and `benchmark.less`,
   shipped path, absolute milliseconds at a stated SHA, with 0.46 alongside.
   Protocol in §1c. Take it after `lane/macro-lowering` lands, on a quiet box.
2. **The cost of the encoder defect is unpriced.** §1b establishes that the macro
   route emits 318 unread sequence tuples and 90 unread repeat arrays per
   execution and gates 195 of 562 choice arms it should gate 103 of. Nobody has
   measured what that is worth in milliseconds on a shipping configuration.
   `pnpm size:jess` before/after against §2b is the cheap half of the answer.
3. **`48ac5f1` is unmerged.** Until `lane/name-collision` lands, the release
   branch ships `fixture.ts` with two wrong engine names and `lane/capoff`'s
   refutation of them sitting in the same tree.
4. **`design/balance:notes/DESIGN-piece-library.md:40`** — the live, unretracted
   re-entry point for the 2.0–2.3× figure, attributing it to a "fully abstract
   closure table" that `c274a04` never measured. One line, still quotable.
5. **`notes/results/README.md`** — stale by 6 builds and 56,740 rows.
6. **No HEAD-vs-0.46 allocation ratio survives.** 34.7 MB/parse is HEAD-side
   only; a 0.46 counterpart has to be re-measured before any ratio is quoted.
7. **Three backlog contradictions** (§4) must be resolved before planning, not
   during it.
8. **`*-lines` variants stack-overflow on every corpus file.** `trackLines` is
   unmeasured, not clean — and it is the variant `valueUnused` actually bites in.

---

## Appendix A — `macro-vs-assembled.ts` raw numbers, and what its legs are

**Nothing in the body of this report rests on these numbers.** They are recorded
so the measurement is not repeated, and so the protocol is not re-derived. **Read
the leg description before reading the table.**

### What the two legs are

| leg | what it builds | shipping? |
|---|---|---|
| `macro` | `import('pm-macro:<grammar>')` — the macro-fused artifact, which emits `import { tableRules } from 'parseman/table'` | **yes**, real product path |
| `assembled` | loads the grammar module **without** the macro, takes the interpreted fuse, then calls `encodeTable(g.rules, {})` **directly** — bypassing `compile()`, with **empty settings** — and hands the result to `assembledRules` (`macro-vs-assembled.ts:54-57`) | **NO.** No product path performs this. It is the no-build inspection route ~20 bench harnesses and two differential-gate legs use |

Both legs run the **same engine**. The variable is which route produced the table
data, and one of the two routes is bench-only.

**So the ratio below is not a product measurement, and this report does not say
what it means.** An earlier draft framed it as macro-vs-`compile()` and as "two
encode routes that should agree". Both framings were wrong — the reference leg
never calls `compile()` and passes settings no shipping configuration passes —
and they are recorded here as retracted rather than quietly deleted.

The evidence that the macro route's table is genuinely wrong is in **§1b** and
does not depend on this harness at all: deterministic opcode counts, reproducible,
converging exactly after the fix, no wall clock involved.

### The numbers

At `67478722cc33fd6654fb44a48fd460a1ad5ced34`, `benchmark.less` 106,802 B,
`hostMode: 'ast'`, node v24.11.1. Identity verified every round —
`assembled === macro artifact`, both `ok=true consumed=106802`, 278 rules each
side. Balanced instance use: each side one instance used twice and one used once.

| round | `assembled` (bench-only) | `macro` (shipped) | ratio | CONTROL asm/asm | load start → end |
|---|---:|---:|---:|---:|---|
| 1 | 28.85 ms | 56.44 ms | 1.956× | +1.6% | 3.57 → 4.01 |
| 2 | 28.90 ms | 56.98 ms | 1.971× | +0.7% | 3.74 → 6.10 |
| 3 | 28.80 ms | 56.43 ms | 1.960× | −1.6% | 3.88 → 4.55 |
| median | 28.85 ms | 56.44 ms | **1.960×** | 1.6% worst | |

Ratio reproduces to 0.8% against a worst control of 1.6%; the macro side loses
0 of 48 pairings. Round 3 waited **750 s** at the load gate rather than being
forced. `CONTROL macro/macro` is degenerate — node caches the module, so it is the
same instance on both sides — and the harness prints it as such.

A previous reading of the same harness at `249cbd9` recorded 28.03 / 27.65 ms
against 36.05 / 35.91 ms, ratio 1.286× / 1.299×. The harness is byte-identical
between the two SHAs. **What that difference means is unknown**, and it is not
worth settling while the reference leg is bench-only.

### The toggle protocol, if anyone wants it later

Set up, then abandoned when the framing above was corrected. Recorded because the
setup work is most of the cost:

- **one directory** — a detached, clean worktree; `git checkout --detach <sha>`
  between legs, refusing to run if the tree is ever dirty. Never a second
  directory: cross-worktree comparisons carry their own bias.
- **`249cbd9` ↔ `6747872`**, three rounds, **order alternated per round**
  (A-B, B-A, A-B), so run position cannot favour one side.
- **each of the six legs independently gated** on 1-minute load average under 4.0,
  waiting rather than forcing. No `PM_FORCE`, no `SKIP_PERF_GUARD`.
- **two preconditions verified before it is valid**, both confirmed here:
  `bench/jess/macro-vs-assembled.ts` is byte-identical between the two SHAs
  (`git diff 249cbd9 6747872 -- bench/jess/macro-vs-assembled.ts` is empty), and
  `package.json` + `pnpm-lock.yaml` are identical, so no reinstall is needed
  between legs and neither the harness nor the dependency tree is a variable.

Script at `scratchpad/toggle.sh`; leg logs at `scratchpad/legs/`.

### A naming fix this harness needs

Its columns print as `assembled` and `macro artifact (SHIPPED)`. Neither name says
what differs, and "SHIPPED" on one row implies the other is also a deployment
option. If this harness survives, the labels should name the **route**, not the
implementation — and `48ac5f1` relabelled `fixture.ts` and 18 other harnesses
without touching this one or `bench/jess/size.ts`, which still prints `codegen`
for a lowering deleted at `37c57b5`.
