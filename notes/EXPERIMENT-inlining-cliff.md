# EXPERIMENT: where is the inlining cliff for a shared piece body?

Lane `exp/cliff`. Measurement only — no source change, nothing merged.

## Provenance (read before the numbers)

| what | value |
|---|---|
| repo | `parseman` at `/Users/matthew/git/worktrees/exp-cliff` (worktree of `/Users/matthew/git/oss/parser-thing`) |
| branch | `exp/cliff`, branched from `origin/release/0.47.0` = `6bc265f5b854b256a2e8ea0df5522ca7cfd57770` |
| harness SHA | `bbacf3d9eb7b75167bd22971bd7223ba851ea73d` (stamped into every jsonl record) |
| node / v8 | `v24.11.1` / `13.6.233.10-node.28` |
| raw records | `notes/results/inlining-cliff.jsonl` (append-only, one record per configuration) |
| harness | `bench/experiments/cliff/{pieces,throughput,ic-probe,size-probe,run,analyze}.mjs` |

The measured pieces are faithful reductions of the strict paths of
`src/combinators/sequence.ts`, `src/combinators/choice.ts` (disjoint dispatch arm) and
`src/combinators/repeat.ts` (`many`). They are plain ESM, not TypeScript, so that no
tsx/esbuild transform sits between the authored body and the measured one. Nothing here
imports `src/`, so the harness needs no build and no `node_modules`.

**Not measured here:** the real emitted `_pf` bodies from the jess grammars (17.4 KB css
/ 31.7 KB less). Everything below is on modelled pieces whose callee bytecode size was
swept deliberately from 70 B to 52,188 B, which straddles the whole real range — but a
real-body confirmation is still owed.

## Instruments

`--trace-ic` **does not exist** in release Node v24.11.1 (`node: bad option: --trace-ic`).
`%DebugPrint` is available and is strictly better: it prints every feedback slot with its
IC state verbatim (`- slot #12 LoadProperty MEGAMORPHIC`), read out of the feedback vector
rather than inferred from a timing. Also used: `%GetOptimizationStatus` (tier reached),
`%HaveSameMap` (asserts the identical/distinct shape setup actually is what it claims),
`--trace-turbo-inlining` and `--trace-deopt` (both write to **stdout** in this build, not
stderr), and `--no-polymorphic-inlining` as a causal lever.

Dispatch slots are **identified from the data**, not hard-coded: within a series, the
slots whose IC state changes as the variable moves are by construction the ones fed by
the per-site callees. A hard-coded slot index would silently survive a bytecode change.

## Noise floor — state this before any delta

A/A control (identical config, re-measured three times, spread across the run):
**35.21 / 36.04 / 36.55 ns/op → 3.7% spread.**
Median within-config rep spread across all 131 timed configs: **7.5%**; 22 configs
exceeded 15%, always as a single high outlier against a stable min (GC / scheduler), which
the median-of-11 absorbs.

**Nothing below ~4% is reported as a signal below.** Every effect reported is ≥17%.

## Headline

**Sharing one FunctionLiteral across many call sites is not the problem. Three separate
things are, and only one of them is what the repo's design premise named.**

1. **Closure count is free.** 40 closures from one `CreateClosure` site, all sharing one
   FeedbackVector (`sharedFeedbackVector: true` verified by address equality in
   `%DebugPrint`), cost **nothing** when their callees share a hidden class: seq
   35.44→38.03, choice 7.58→10.83, many 50.83→70.17 from N=1 to N=40 — and the N=1→2
   step accounts for all of it (see 2). TurboFan **keeps inlining at every N**:
   `--trace-turbo-inlining` reports 3 considered / 3 inlined at N=1 *and* at N=40, in
   both shape regimes, monomorphic through megamorphic. **Inlining never stops with N.**
   This invalidates the "second closure ⇒ kManyClosures ⇒ megamorphic ⇒ per-site bodies"
   chain outright.

2. **The second distinct *executed* callee at a site costs, once, at N=2.** Not N=4.
   The slot that moves is a **Call** slot going MONOMORPHIC→POLYMORPHIC. It is a single
   step: N=2 and N=40 cost the same.

3. **The megamorphic map cliff is at 5 distinct receiver maps**, and is driven by map
   count, not by site count or closure count.

4. **Callee bytecode size is the sharpest cliff of the three, and nobody had measured
   it.** Observed boundary: **448 B inlines, 475 B does not.**

## 1. Sweep: ns/op by N (piece × shape policy)

`identical` = all sites' callees share one hidden class (what `literal()` actually
produces in parseman). `distinct` = each site's callees carry a uniquely named field.

| piece | shapes | N=1 | 2 | 3 | 4 | 5 | 6 | 8 | 12 | 20 | 40 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| seq | identical | 35.44 | 36.54 | 36.97 | 36.20 | 37.41 | 37.28 | 37.87 | 38.12 | 37.80 | 38.03 |
| seq | distinct | 35.53 | 37.71 | 37.90 | 38.28 | **45.01** | 45.95 | 47.14 | 46.97 | 45.52 | 46.41 |
| choice | identical | 7.58 | 10.43 | 10.47 | 10.35 | 10.36 | 10.34 | 10.20 | 10.42 | 10.42 | 10.83 |
| choice | distinct | 7.90 | 10.63 | 10.44 | 10.39 | **12.96** | 12.45 | 12.51 | 13.15 | 13.49 | 12.86 |
| many | identical | 50.83 | 70.05 | 71.26 | 72.27 | 70.39 | 71.80 | 70.09 | 70.19 | 69.87 | 70.17 |
| many | distinct | 50.94 | 71.39 | 72.04 | 72.80 | **91.09** | 91.45 | 90.22 | 89.46 | 91.43 | 89.99 |

## 2. Transition table

| piece | shapes | dispatch slots (from data) | mono→poly at N | poly→MEGA at N | cost of crossing to MEGA |
|---|---|---|---:|---:|---|
| seq | identical | 12:LoadProperty | — | **never** | — |
| seq | distinct | 12:LoadProperty | 2 | **5** | 38.28 → 45.01 = **+6.73 ns/op (+17.6%)** |
| choice | identical | 20:Call | 2 | **never** | — |
| choice | distinct | 18:LoadProperty, 20:Call | 2 | **5** | 10.39 → 12.96 = **+2.57 ns/op (+24.7%)** |
| many | identical | 12:Call | 2 | **never** | — |
| many | distinct | 10:LoadProperty, 12:Call | 2 | **5** | 72.80 → 91.09 = **+18.29 ns/op (+25.1%)** |

The **poly→MEGA at 5** transition is `kMaxPolymorphicMapCount = 4` for **property
access** — slot 12/18/10 is the `.parse` *load*. It is a map-count limit, and the
`identical` rows show it never fires when the callees share a map, at any N.

The **mono→poly at 2** transition is a **Call** slot, and it is the expensive one for
`choice` (7.58→10.43, **+37.6%**) and `many` (50.83→70.05, **+37.8%**) — under
*identical* maps, so it is not a map effect. For `seq` it is ~nil (35.44→36.54, +3.1%,
inside the 3.7% floor), because seq's callee arrives via `parsers[i]` — an array element
that was never a constant to begin with, so there was nothing to lose.

So calls do have a polymorphic feedback state (V8 prints `Call POLYMORPHIC` literally),
but it behaves as a **binary** one-callee/many-callee distinction, not a 4-wide tier —
which is why the step lands at N=2 and then stays flat to N=40.

**It is the executed callee count, not the closure count.** Memory control below is the
proof: 40 closures created, 1 exercised, stays MONOMORPHIC *and* stays fast.

## 3. Memory control — 40 sites BUILT, 1 EXERCISED

| piece | shapes | 40 built / 1 called | 40 built / 40 called | N=1 |
|---|---|---:|---:|---:|
| seq | identical | 36.53 | 38.03 | 35.44 |
| seq | distinct | 35.93 | 46.41 | 35.53 |
| choice | identical | 7.71 | 10.83 | 7.58 |
| choice | distinct | 7.68 | 12.86 | 7.90 |
| many | identical | 51.45 | 70.17 | 50.83 |
| many | distinct | 50.52 | 89.99 | 50.94 |

Building 40 sites costs nothing (all within the 3.7% floor of N=1). `kManyClosures` is
present in every one of these rows and is not itself a cost.

## 4. Callee bytecode size — the sharp cliff

N=1, identical shapes, so the size effect is not confounded with callee count. The
padding sits behind `if (pos < 0)`, which never runs and which TurboFan cannot fold, so
**bytecode grows while executed work stays constant**. Sizes are the real
`BytecodeArray[N]` lengths read out of a cold twin via `%DebugPrint`
(`bench/experiments/cliff/size-probe.mjs`); `inl` is
`inlinedParseIntoParse / consideredForInlining` from `--trace-turbo-inlining`.

| callee bytecode | inl | seq ns/op | choice ns/op | many ns/op |
|---:|:--|---:|---:|---:|
| 70 | 1/3 | 37.26 | 7.92 | 52.71 |
| 124 | 1/3 | 36.91 | 7.91 | 53.34 |
| 286 | 1/3 | 37.04 | 7.90 | 53.58 |
| 394 | 1/3 | 36.57 | 7.92 | 53.54 |
| 421 | 1/3 | 37.12 | 7.91 | 52.65 |
| **448** | **1/3** | **37.29** | **7.82** | **53.04** |
| **475** | **0/1** | **45.98** | **11.95** | **71.55** |
| 502 | 0/1 | 44.93 | 12.00 | 71.60 |
| 556 | 0/1 | 45.41 | 11.86 | 70.88 |
| 610 | 0/1 | 45.97 | 11.64 | 71.59 |
| 718 | 0/1 | 47.21 | 11.86 | 71.66 |
| 1,368 | 0/1 | 46.76 | 12.32 | 71.94 |
| 2,468 | 0/1 | 46.16 | 12.00 | 71.37 |
| 3,788 | 0/1 | 45.43 | 12.21 | 71.11 |
| 5,988 | 0/1 | 45.60 | 11.88 | 71.31 |
| 9,948 | 0/1 | 45.59 | 11.87 | 71.58 |
| 21,388 | 0/1 | 45.12 | 12.03 | 68.75 |
| 52,188 | 0/1 | 44.90 | 12.03 | 64.63 |

**The boundary is between 448 B and 475 B, identically for all three piece kinds.** That
brackets `--max-inlined-bytecode-size=460` to within 27 bytes. It is not just slower —
`consideredForInlining` drops from 3 to 1, so past 460 the callee is not even a candidate.

Cost of crossing: seq **+23.3%**, choice **+52.8%**, many **+34.9%**.

**There is no second step.** From 475 B to 52,188 B the curve is flat, across a range
that crosses `--max-inlined-bytecode-size-cumulative=920` and
`--max-inlined-bytecode-size-absolute=4600` several times over. The predicted "dead zone
at 460–4,600" is **not a zone** — 460 is a single edge, and everything past it is one
plateau. (The 920/4600 budgets govern cumulative and absolute inlining across a
compilation; they produce no additional step for a single callee.)

## 5. Per-site monomorphic wrapper — and the wiring control

`wrapCAP` = wrapper reaches its inner piece through a captured binding.
`wrapIND` = through an array element, so `inner` is not a constant TurboFan can fold.
Same per-site FunctionLiteral, same call depth, same generated bytes either way.

| piece | N (distinct) | shared only | + wrapCAP | + wrapIND | wrapper bytes |
|---|---:|---:|---:|---:|---:|
| seq | 1 | 35.53 | 36.87 | 37.21 | 149 |
| seq | 4 | 38.28 | 40.75 | 41.11 | 596 |
| seq | 5 | 45.01 | 48.79 | 49.16 | 745 |
| seq | 40 | 46.41 | 51.52 | 53.09 | 5,990 |
| choice | 1 | 7.90 | 8.15 | 8.65 | 147 |
| choice | 5 | 12.96 | 15.59 | 15.85 | 735 |
| choice | 40 | 12.86 | 16.41 | 15.89 | 5,910 |
| many | 1 | 50.94 | 51.61 | 51.79 | 145 |
| many | 5 | **91.09** | **65.61** | **66.25** | 725 |
| many | 40 | **89.99** | **67.54** | **67.79** | 5,830 |

Two results:

- **Wiring is irrelevant.** `wrapCAP` and `wrapIND` agree everywhere, within the noise
  floor. I predicted the capture-wired wrapper would win by constant-folding through
  `inner`; the indirect control **falsified that**, and independently confirms the design
  lane's point 4.
- **The wrapper does NOT recover anything for `seq` or `choice`** — it is pure cost
  (+1.3 to +3.6 ns/op) plus ~149 bytes per site, and the inner body stays MEGAMORPHIC
  under it. For those two pieces a per-site wrapper is byte cost for negative return.
- **For `many` it recovers the entire megamorphic penalty** (91.09 → 65.61, back to the
  `identical` level of 70.17 and below it), at 725–5,830 bytes. `many` is the only piece
  whose dispatch sits inside a hot inner loop with the callee in a captured variable.
  **The mechanism is OPEN** — the constant-folding explanation is falsified by wrapIND
  and I do not have a replacement I can evidence. Flagged, not guessed.

## 6. Captured-variable count — no effect

seq, ns/op:

| shapes | N | cap0 | cap1 | cap3 | cap8 |
|---|---:|---:|---:|---:|---:|
| identical | 1 | 36.15 | 35.90 | 36.50 | 36.47 |
| identical | 8 | 38.15 | 38.84 | 38.48 | 37.55 |
| distinct | 1 | 36.33 | 36.43 | 36.60 | 36.42 |
| distinct | 8 | 45.63 | 46.32 | 45.41 | 47.54 |

0 → 8 live captures: every delta inside the 3.7% floor, and the cliff does not move.

## 7. Call chain — the cliff does NOT compound

seq-of-choices (each term is itself a shared piece), ns/op:

| shapes | N=1 | 4 | 5 | 8 | 40 |
|---|---:|---:|---:|---:|---:|
| identical | 48.64 | 51.09 | 51.00 | 50.21 | 65.46 |
| distinct | 48.12 | 53.50 | 58.23 | 58.60 | 79.71 |

At N=40 the chained penalty is 79.71/65.46 = **+21.8%**, against **+22.0%** for the
unchained seq (46.41/38.03). Identical. The megamorphic access is paid once, at the site
that actually sees the many maps; pushing it a level down a call chain neither
multiplies it nor adds a second one.

## 8. Causal lever

seq, distinct shapes:

| config | N=1 | 2 | 4 | 5 | 8 | 40 |
|---|---:|---:|---:|---:|---:|---:|
| default | 35.53 | 37.71 | 38.28 | 45.01 | 47.14 | 46.41 |
| `--no-polymorphic-inlining` | 36.52 | 38.47 | 38.81 | 46.22 | 45.73 | 46.70 |

Every column inside the noise floor. The N=2..4 region is **not** being carried by
polymorphic inlining — turning it off changes nothing, so the flat 2..4 region is flat
for another reason, and the N=5 step is the map-count limit, not an inlining-policy
artefact.

Deopt reasons observed (`--trace-deopt`), constant at 2 per run at **every** N and in
both shape regimes — no deopt storm, no N-dependence:
`prepare for on stack replacement (OSR)` and
`Insufficient type feedback for generic named access`.

## What this means for the repo's designs

- The premise — shared FunctionLiteral ⇒ `kManyClosures` ⇒ megamorphic ⇒ must emit
  per-site bodies ⇒ must use `new Function` ⇒ CSP guarantee broken — **does not hold**.
  Closure count is free; inlining continues to N=40; and the CSP-breaking step was
  bought with nothing.
- What actually costs: (a) a second distinct executed callee at a site, once, at N=2,
  and only for pieces whose callee was a constant to begin with; (b) a fifth distinct
  receiver map, +17–25%; (c) crossing 460 B of callee bytecode, +23–53%.
- (c) is the one nobody was designing against, and it is the largest. It also cuts
  against per-site body emission directly: **making bodies bigger to specialise them can
  push them past 460 B and cost more than the specialisation buys.**
- A per-site monomorphic wrapper is not a general recovery. On `seq` and `choice` it is
  pure loss.

## Bearing on the jess author-reducer gap (1.30–1.32×, identical source, two engines)

The two candidate explanations were "more calls" and "worse IC feedback". Priced here:

| effect | measured ratio |
|---|---|
| one extra monomorphic call layer | +1.3 to +3.6 ns/op absolute → 1.02× (seq) to 1.33× (choice) |
| mono → megamorphic on an otherwise identical body | 1.19× (choice) – 1.28× (many) |
| one callee → two executed callees at a site | 1.03× (seq) – 1.38× (choice/many) |
| callee crossing 460 B of bytecode | 1.23× (seq) – 1.53× (choice) |

**Worse IC feedback is sufficient on its own** — the one-callee→two-callees step alone
reaches 1.37–1.38× on `choice`/`many`-shaped bodies, and the 460 B crossing reaches
1.23–1.53×. Extra calls are **not** required to explain 1.30–1.32×.

Discriminating test, cheap and deterministic, that would settle it outright:

1. `%DebugPrint` the reducer body under each engine and compare the Call-slot IC state.
   MONOMORPHIC under one and POLYMORPHIC under the other ⇒ explanation (b), and it means
   the emitted engine instantiates the reducer at 2+ sites where the other instantiates
   it at 1.
2. Read the reducer's `BytecodeArray` length under each engine. If one side is under 460
   and the other over, that alone is 1.23–1.53× and no further explanation is needed.
3. Only if both come back identical is "more calls" the live hypothesis — and then a
   plain invocation counter settles it.

Given the ratio is 1.30–1.32× and *stable* across reducers, my prior is (2): a size
threshold produces exactly that kind of flat, body-independent ratio, whereas a call-count
difference would vary with reducer complexity.

## Owed

- Real emitted `_pf` bodies (css 17.4 KB, less 31.7 KB) instead of modelled pieces. Note
  that both of those are far past 460 B, so on the size axis the real population sits
  entirely in the not-inlined plateau — which makes the 460 B result the one most likely
  to matter and the least likely to change.
- The mechanism behind `many`'s wrapper recovery.
