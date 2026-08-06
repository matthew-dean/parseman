# PROBE — where the remaining time actually goes

**Base.** `lane/floorprobe`, cut from `origin/lane/u1literals` @ `91d2adf`
(capturing-trivia fix `ff47156`, then `OP_GATE` resolution + length-keyed
literals). Reference side: `a5dc9bd` (v0.46.0), materialised by
`bench/ab-harness.ts`'s `materialise(GATE, ROOT, REF, COPY)` — the same worktree
the gate uses, not a hand-rolled checkout.

**This is an investigation. Nothing in `src/` changed.** Two probe harnesses are
added under `bench/`; the counting instrument was a temporary patch to
`assemble.ts`, reproduced verbatim in §7 and reverted before this commit.

**Method.** Node v24.11.1, `--experimental-strip-types` rather than `tsx` (same
timings to within 0.3%, and it preserves source positions so `--cpu-prof` frames
resolve to real lines). One side per process so profiles and `--trace-*` output
attribute to that side alone; every headline number is a HEAD-vs-REF pair taken
back to back and repeated at least twice.

**Machine.** Load average 3.1 at the start, 8.0 at the end (a desktop app woke up
mid-session). Every conclusion below rests either on a COUNT — which has no noise
floor — or on a HEAD/REF ratio measured in adjacent processes, with the reference
side acting as the control for machine load. The two ratio results that carry
weight (§4) were reproduced three times, and in every repetition the reference
side stayed flat while the head side moved.

---

## 0. TL;DR

| | attributed | mechanism |
|---|---|---|
| **json ~137% floor** | ~99% of the measured delta | **two costs, roughly half each.** (a) executing the parse as a graph of per-op closures instead of fused straight-line source — 81% of the ISOLATED delta; (b) **cross-grammar deoptimisation** — a second grammar in the same process costs the table engine +33% and the reference exactly 0%. |
| **css/less excess** | ~93% of the measured delta | **not one shared cost — three.** (a) the same per-piece cost as json, at 1.7× the call density per byte; (b) the capture/trivia path executed as out-of-line functions (`trivia-skip.ts` + `cst/capture-buffer.ts`): 18.7% of head css, 27.6% of head less, 0.15% of head json, ~0% of the reference — this is the genuinely SHARED css/less cost; (c) css only: the table dropping back into the **interpreter combinators** for `OP_SCAN`, 5.9% of head css and 0.12% of head less. |

**Both remaining hypotheses in the brief were checked and both are dead by
counting:** GC/allocation is not in the delta on either workload (§3), and
per-leaf literal work is bounded at ≤4% (§2). One hypothesis the brief recorded
as refuted — **megamorphic dispatch — is alive after all, in a form the previous
measurement could not have seen** (§4).

---

## 1. The differential, isolated

`bench/floorprobe.ts`, 20 warmup parses then N timed, three runs per side.

| workload | head ms/parse | ref ms/parse | delta |
|---|---|---|---|
| `json/document` (60 KB) | 0.826 / 0.830 / 0.864 | 0.463 / 0.463 / 0.480 | **+79%** |
| `css/stylesheet` (65 KB) | 4.640 / 4.689 / 4.688 | 1.910 / 1.886 / 1.401 | **+148%** (ref median) |
| `less/stylesheet` (53 KB) | 15.289 | 3.864 | **+296%** |

The json number is well below the gate's ~137%. That gap is not noise and it is
not a different instrument — it is §4.

## 2. Where the time is: CPU profile, bucketed by file

`--cpu-prof --cpu-prof-interval=100`, self time, every sample bucketed (not a
top-N — the long tail is inside these totals).

### json/document, 1500 parses

head loop 1272.9 ms, ref loop 724.1 ms, **Δ 548.8 ms**.

| bucket | head | ref | Δ |
|---|---|---|---|
| engine (`src/table/*` + trivia-skip + cst + other src) | 926.0 | 482.6 | **+443.4** (81%) |
| grammar reducers (`examples/json/parser.ts`) | 229.5 | 175.0 | +54.5 (10%) |
| RegExp | 108.6 | 76.2 | +32.4 (6%) |
| GC (sampled — see §3) | 29.2 | 18.3 | +10.9 (2%) |
| interpreter fallback | 5.7 | 4.8 | +0.9 |
| | | **accounted** | **542.1 / 548.8 = 98.8%** |

The reducer row is real and is a CODEGEN advantage, not an engine one: the
reference inlines `mapFn` sources into the generated function, so json's small
arrows (`s => parseFloat(s)`, `([key, val]) => …`) cost 66.6 ms at head and
23.6 ms at the reference. `objectFromPairs`, which is too big to inline, costs
132.0 vs 123.2 — i.e. the same.

### css/stylesheet, 400 parses

head loop 2037.7 ms, ref loop 566.1 ms, **Δ 1471.6 ms**.

| bucket | head | ref |
|---|---|---|
| engine: `src/table/*` | 1277.4 | — |
| engine: `src/combinators/trivia-skip.ts` | 341.7 | — |
| engine: `src/cst/capture-buffer.ts` | 87.7 | 1.5 |
| engine: **INTERPRETER combinator fallback** | 134.9 | 5.2 |
| engine: other `src/` | 2.6 | 23.2 |
| REF generated source (`_pf0…_pf16`, `_tf0`) | — | 578.8 |
| **engine total** | **1844.3** | **608.7** |
| grammar reducers | 70.2 | 0.4 |
| RegExp | 73.9 | 6.2 |

Parse-relevant Δ = 1988.4 − 615.3 = **1373.1 ms, i.e. 93% of the measured
1471.6**; the engine is **90% of what is accounted for**. The residue is GC,
`(program)`, and wasm frames from the loader.

### The shape of head's engine time is FLAT, not peaked

json head, top engine frames of 926.0 ms: `PM_SEQ3` body 182.8 · `PM_SEQ2` body
168.9 · `OP_RX` 154.3 · generic `OP_REP` 138.3 · `nextTerm` 85.0 · `OP_LIT`
len-1 45.3 · `OP_OPT` 32.8 · the `OP_RULE` trampoline `fwd` 27.4 · `markCst`
24.2 · `OP_XFORM` 22.4 · dispatch choice 20.2 · `OP_LIT` len-3 13.5.

Nothing is above 13% of the total. **The delta is spread thin across every
piece.** Deleting `markCst` outright buys ≤1.7%; deleting the entire `OP_LIT`
body buys ≤4%. There is no single frame to fix — which is the answer to "is the
delta concentrated or spread", and it is the same answer the deleted engine's
shape predicts: the reference does all of this inside **7 functions** for json
(16,208 bytes of generated source) and **17** for css.

## 3. Allocation and GC are NOT in the delta — counted, not sampled

`--trace-gc`, summing every reported pause.

| | scavenges | scavenge ms | other GC | peak heap |
|---|---|---|---|---|
| json head, 420 parses | 68 | 14.0 | 1 / 0.9 ms | 81.7 MB |
| json ref, 420 parses | 63 | 9.7 | 1 / 1.2 ms | 51.1 MB |
| **css head, 400 parses** | 93 | **87.4** | 6 / 14.3 ms | 275.5 MB |
| **css ref, 400 parses** | 83 | **155.9** | 11 / 13.8 ms | 306.8 MB |

json: 5 extra scavenges and 4.3 ms over 420 parses, against a 154 ms delta.
css: head GC totals **101.7 ms against the reference's 169.7 ms — head is
CHEAPER.**

The sampled profile disagrees: it credits head css with 190.9 ms of
`(garbage collector)` against the reference's 43.2 ms. **The sampled number is
wrong and the counted one is right** — this is exactly the over-crediting
`RELEASE-0.48-TARGET.md` §3 warns about, caught in the act. Any plan built on
that 8.3% row would have measured zero.

`OP_RX` does execute 6,005 rows per json parse (12.9% of piece invocations) and
each `re.exec` does allocate a match array — but the reference executes the same
6,005 and its scavenge count is within 8%. **That cost was equally present at
`a5dc9bd`. It is not in the delta.**

## 4. Cross-grammar deoptimisation — the half of the json floor nothing had seen

`bench/floorshare.ts`. Identical to `floorprobe.ts` except it optionally builds
and warms the OTHER workloads on the same side before timing the target one —
which is the condition `workload-perf-guard.ts` actually measures under, because
it loads all five workloads into one process.

```
head json alone   0.826  0.830  0.895   |  ref json alone   0.485  0.488  0.463
head json + 4     1.096  1.115  1.055   |  ref json + 4     0.479  0.455  0.575
                  ------ +33% ------                        ------ ~0% ------
```

Three independent repetitions. **The table engine loses 33% when a second
grammar shares the process. The reference loses nothing.** One extra grammar is
enough — with graphql alone, head goes 0.895 → 1.087 (+21%) and 0.806 → 1.038
(+29%) while the reference sits at 0.470 → 0.478 and 0.488 → 0.478.

`--trace-deopt`, json, same 400 parses:

| | total deopts | `wrong call target` | `wrong map` |
|---|---|---|---|
| head, isolated | 16 | **0** | 4 |
| head, 5 grammars | 95 | **24** | 27 |

The `wrong call target` victims are the entire hot set:
`nextTerm`, `skipTrivia`, `skipTriviaScanned`, `re`, `spec`, `armCls`, `k0`,
`fwd`, `runTerms`, `values`, `s`.

**Mechanism.** Every piece in `assemble.ts` is minted from a fixed set of
FunctionLiterals SHARED by every grammar compiled in the process. A call site
inlined against grammar A's child closure is invalidated by grammar B's closure
arriving at the same site. The reference's generated source is per-grammar, so
its call sites never see a second grammar.

**This reconciles the two numbers.** Isolated json is +79%; json with the other
four grammars live is **+130%**, which is the gate's ~137%. So of the floor,
roughly **78pp is the isolated per-piece cost and ~55pp is contamination.**

**Why the earlier refutation missed it.** D0 measured json ALONE: 2 arity-2
closures minted, 77/77 inlining candidates reporting one target. That was
correct — and `--trace-deopt` confirms it, with **zero** `wrong call target`
deopts isolated. The megamorphism is not intra-grammar. It is cross-grammar, and
it cannot be observed by looking at one grammar.

**This is not a benchmark artefact.** A downstream host that compiles more than
one dialect — which is the stated shape of the consumer — is in the contaminated
condition permanently.

**One thing here I could NOT explain.** Under the same sharing, css behaves
oppositely: head css is unmoved (4.87 → 4.82, and it has **0** `wrong call
target` deopts isolated — it has no inlining left to lose), while the REFERENCE
css gets 57% slower (1.36 → 2.13/2.27). I have no mechanism for the reference's
loss, my warmup is much heavier than the gate's, and the gate's css row matches
my ISOLATED ratio (+253% vs the gate's +254%), not my shared one. **Do not build
on the shared-css number.** The json result stands on its own: three
repetitions, a flat control, and a deopt count that names the functions.

## 5. Counting the work: what head executes per parse

Instrument in §7. Counts are per parse, taken on the second parse.

| | json/document | css/stylesheet |
|---|---|---|
| op-piece invocations | 46,393 | 104,677 |
| `nextTerm` | 18,616 (**100% slow path**) | 18,748 (**100% slow path**) |
| `markCst` | 19,668 (**100% returning FALSE**) | 51,849 (100% returning true) |
| `skipTrivia` | 25,970 | 30,989 |
| **total engine calls** | **110,647** | **206,263** |
| bytes | 60,323 | 65,554 |
| **calls per byte** | **1.83** | **3.15** |

json's op mix: `OP_LIT` 19,966 (43%) · `OP_SEQX` 12,611 · `OP_RX` 6,005 ·
`OP_CHOICE` 4,204 · `OP_XFORM` 1,502 · `OP_OPT` 1,052 · `OP_REP` 1,052 ·
`OP_SCOPE` 1.

Two things fall out.

**(a) json's `markCst` is 19,668 calls per parse that cannot ever return true.**
The context is `{ trackLines: false }`: `_cstBuf`, `_cstLeaves`,
`_cstRawChildren`, `_cstTriviaLog`, `_fields`, `_errors`, `_triviaLog`,
`_rootTriviaLog` are all undefined, so every call performs ten property loads,
writes three zeroes and returns false. ~197,000 dead loads per parse. It is the
canonical §"no option consulted per term" violation — and its measured self time
is 24.2 ms of 1421.8, **1.7%**. Bound it before believing it: fixing this is a
compliance win, not a performance one.

**(b) css is not "the same cost, more of it".** Per piece invocation the delta is
7.9 ns on json and 12.4 ns on css — css pays 1.6× more per piece AND runs 1.7×
more calls per byte. Both terms are real; §6 says what the extra per-piece cost
is.

## 6. The css/less excess is three costs, not one

Bucketing all three head profiles the same way:

| bucket, % of head profile | json | css | less |
|---|---|---|---|
| `src/table/*` | 64.8% | 55.5% | 65.4% |
| **`trivia-skip.ts`** | 0.04% | **14.9%** | **19.4%** |
| **`cst/capture-buffer.ts`** | 0.1% | **3.8%** | **8.2%** |
| **INTERPRETER combinator fallback** | 0.4% | **5.9%** | 0.12% |
| grammar reducers | 16.1% | 3.1% | 0.0% |

On the reference side all four of those rows are ~0: css ref is 70.8% "generated
source" and less ref is 81.2%, with `cst capture` at 0.09–0.18% and the
interpreter fallback at 0.29–0.63%. **The reference fuses trivia, capture and
reducers into the emitted function; head calls out to them.**

**(1) The shared css/less cost is the capture/trivia path.** trivia-skip +
capture-buffer is 18.7% of head css and 27.6% of head less, against 0.15% of head
json and ~0% of both reference sides. That is the cost the two stylesheet rows
have in common and json does not, and it is the one whose magnitude tracks the
excess. Concretely: `markCst` returns TRUE on css/less, so `nextTerm` takes
**seven** marks per non-first term (`MRAW`/`MTL`/`MLV` plus `_fields`, `_errors`,
`_triviaLog`, `_rootTriviaLog` lengths) and can call `rollbackTriviaAt`
(115.8 ms, 5.0% of head css). The reference emits, per site, only the marks that
site's sinks need — one read:

```js
const _tlg64 = _ctx._triviaLog
const _mklg62 = _tlg64 !== undefined ? _tlg64.length : 0
const _sne63 = _tf0(input, _cur17, _ctx, _tlg64 !== undefined ? 2 : 0)
…
if (_sea67 > _sne63) _cur17 = _sea67; else { if (_tlg64 !== undefined && _tlg64.length !== _mklg62) _tlg64.length = _mklg62 }
```

**(2) A css-only defect: the table calls back into the interpreter.** 134.9 ms,
5.9% of head css, in `src/combinators/choice.ts:86` (52.4), `scanTo.ts:113`
(24.4), `token.ts:21`, `map.ts:15`, `literal.ts:71`, `regex.ts:149`,
`repeat.ts:217`, `sequence.ts:167`, `first-set.ts`. Source: `case OP_SCAN` binds
a `Combinator` on first execution and calls its `.parse()` — 2,974 `OP_SCAN`
executions per css parse. **less/stylesheet shows 0.12% here**, so this is NOT
the shared cost and it is not what makes the three stylesheet rows move together.
It is a straightforward "no external refs" violation with a bounded price.

**(3) Per-scope option save/restore.** `scopePiece` (`assemble.ts:1173`) 60.3 ms
and the root-policy wrapper (`:471`) 41.5 ms — 4.4% of head css, doing nothing
but saving and restoring `ctx.trivia` / `ctx.triviaKindLabels` / `SCAN` /
`_rootTriviaCapture` across **12,801 `OP_SCOPE` entries per parse**.

## 7. The counting instrument (temporary; reverted)

Applied to `src/table/assemble.ts`, gated on `PM_COUNT`, removed before this
commit. Reproduced so the §5 counts can be re-derived.

```diff
   function link(ip: number): Piece {
-    const piece = lower(ip)
+    let piece = lower(ip)
+    if (process.env.PM_COUNT !== undefined) {
+      const inner = piece
+      const opName = String(code[ip])
+      piece = (input, pos, ctx) => {
+        const g = globalThis as unknown as { __pmCount?: Map<string, number> }
+        g.__pmCount ??= new Map<string, number>()
+        g.__pmCount.set(opName, (g.__pmCount.get(opName) ?? 0) + 1)
+        return inner(input, pos, ctx)
+      }
+    }
```

plus the same three-line counter at the head of `nextTerm` (keyed on
`ctx.trivia === undefined`), `markCst` (keyed on whether any sink is live) and
`skipTrivia`. Driven by a throwaway `bench/floorcount.ts` that builds one
workload, parses once to warm, clears the map, and parses once more.

## 8. What I would fix first, and what each is worth

Bounded, in the order the evidence supports. Every number below is a CEILING
taken from a measured share, not a prediction of a win.

1. **Emit source, or otherwise give each grammar its own FunctionLiterals (U4).**
   Worth up to **55pp of json's 137%** on its own — the contamination is pure
   loss, since the work is identical and only V8's inlining changes. It is also
   the only item that addresses the flat 926 ms engine profile of §2, where no
   individual frame exceeds 13%. This probe is evidence FOR U4, not against it:
   every cheaper intervention below is bounded in the low single digits.
2. **Fuse the capture/trivia path into the piece bodies, and mark only the sinks
   a site has.** Ceiling **18.7% of head css / 27.6% of head less**. This is the
   one cost the two stylesheet rows genuinely share.
3. **Kill `OP_SCAN`'s interpreter fallback.** Ceiling **5.9% of head css**, ~0
   elsewhere. Cheap, self-contained, and it is a standing "no external refs"
   violation independent of its price.
4. **Resolve the scope option save/restore at assembly.** Ceiling **4.4% of head
   css** over 12,801 scope entries per parse.
5. **`markCst`'s dead path** (json: 19,668 calls/parse, ~197k dead property
   loads). Ceiling **1.7%**. Do it for the design criterion; do not expect time.

**Do NOT spend effort on:** allocation or GC (§3 — counted, head is level with
or cheaper than the reference on both workloads), per-leaf literal comparison
(§2 — ≤4% for the whole `OP_LIT` body, and the previously measured 1.3 ns/call
puts the realistic figure at ~2%), and the sampled `(garbage collector)` row on
css, which is an artefact.

## 9. What I could not account for

- **6% of the json delta** sits in `RegExp` frames (108.6 ms head vs 76.2 ms ref)
  for the same 6,005 execs of the same regexes. I have no mechanism.
- **7% of the css delta** is unattributed after §2's buckets — GC, `(program)`
  and loader wasm frames, none of which I can separate from process startup.
- **The shared-process behaviour of css** (§4): head flat, reference 57% slower.
  Not explained, not reproduced against the gate's own warmup shape, and
  deliberately not built on.
- **Whether the harness's css row (+254…331%) is measured under the contaminated
  or the isolated condition.** My isolated ratio matches its low end exactly and
  my shared ratio does not, which is the opposite of what json shows. Until that
  is resolved, treat §4's result as established for json/graphql and unproven for
  css/less.
