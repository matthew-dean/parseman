# PROBE — where the 0.47 regression lives, ON THE ENGINE THAT SHIPS

HEAD `90e115c` (`lane/emitprofile`, off `origin/release/0.47.0`) against `a5dc9bd`
(0.46.0). node v24.11.1, darwin/arm64, 14 cpus.

Every previous profile of this regression was taken on `src/table/exec.ts` — the
opcode loop — because that is where `PM_TABLE_COUNT` instruments. `exec.ts` is not
what ships and is not what `bench/jess/ab.ts` measures. The macro at HEAD routes
`compileLinkableTable` → `compileRuleMapRunnable` → `assembledRules` → the EMITTED
ASSEMBLY (`src/table/emit-assembly.ts`), and 0.46's macro lowers to source
(`src/compiler/codegen.ts`). This probe profiles that pair.

**This is an attribution, not an optimisation.** `src/` is unchanged. The one
instrument added is `bench/jess/emit-profile.ts`, which builds ONE leg and is
committed alongside this note.

## 0. Load caveat, stated once

The box was NOT quiet for any of this: 1-minute load average ran 5.7–27.9 across
the session, other lanes live. **No millisecond here is a canonical figure.** What
the probe rests on instead:

- **presence/absence** — a file one side executes and the other does not at all,
- **counts** — GC byte deltas, emitted-text construct counts, deopt counts,
- **shares** — the same attribution reproduced on two dialects and at two sampler
  intervals.

Absolute times appear only to show the gap reproduced. They did, consistently, at
every load level sampled.

## 1. The gap is not an `ab.ts` artefact

One leg, one process, no pairing, no control — `bench/jess/emit-profile.ts`:

| fixture | 0.46 `macro→source` | HEAD `macro→emitted` | ratio |
|---|---:|---:|---:|
| benchmark.css 123,029 B | 6.47 / 6.39 / 5.87 ms | 13.86 / 13.00 / 13.75 ms | 2.14–2.34× |
| benchmark.less 106,802 B | 18.12 ms | 36.59 ms | 2.02× |

Three independent css runs per side at different loads. The A/B's 2.641× and
2.221× reproduce outside the A/B, so the regression can be profiled one side at a
time and the process-global instruments (`--cpu-prof`, `--trace-gc`,
`--trace-deopt`) attribute to one engine each.

## 2. Deopts are NOT the mechanism — hypothesis dead

`--trace-deopt`, 20 parses of benchmark.css, counted after a `### WARM ###` marker:

| | total bailouts | post-warm | reasons |
|---|---:|---:|---|
| HEAD | 197 | **4** | 4 × wrong map |
| 0.46 | 271 | **3** | 3 × wrong map |

All four post-warm HEAD bailouts are in jess's own AST builders
(`withAuthoredSeparators`, `authoredText`, `oe` in `packages/core/lib/nodes.js`) —
the same functions that deopt on 0.46. **Not one is in an emitted body.** A
repeatedly-deoptimising emitted body would show here and does not.

## 3. Emitted-body size is NOT the mechanism either — and the brief's sizes are wrong

Captured by intercepting the global `Function` constructor (`assemble.ts:2536`
builds the factory with `new Function(...EMITTED_PARAMS, source)`):

| dialect | emitted factory | `function _pf<n>` | largest single `_pf` body |
|---|---:|---:|---:|
| css | **1,136,493 B** | 1,304 | 17,413 B |
| less | **2,118,741 B** | 2,256 | 31,683 B |

The brief says "css 157 KB, less 397 KB". Measured at this anchor they are 7.2×
and 5.3× that. But the size hypothesis is misdirected regardless: the megabyte is
the ONE-SHOT FACTORY, run once at run start. V8's optimisation unit is the 1,304
(css) inner `_pf` declarations, the largest of which is 17 KB of source — nowhere
near a budget cliff — and §2 shows them running as optimised code. No evidence of
an optimisation or inlining budget being exceeded.

## 4. THE ATTRIBUTION

`--cpu-prof --cpu-prof-interval=2000`, samples before the warm marker discarded.
Self-time, ms per parse. The coarse interval is deliberate: at the default 200 µs
the profiler inflated HEAD by 55% and 0.46 by only 11% (21.44 vs 13.86; 7.21 vs
6.47), which would have skewed every share. At 2000 µs the profiled totals match
the unprofiled medians to within 5% on both sides, so these shares are trustworthy
in a way the fine-grained ones are not.

**benchmark.css, 400 parses per side**

| mechanism | 0.46 | HEAD | delta | share of regression |
|---|---:|---:|---:|---:|
| PARSER BODY (`_r_<Name>` vs `_pf<n>`, + host reducers) | 4.847 | 8.652 | +3.805 | 49.0% |
| **TRIVIA scan/classify** | **0.000** | **2.206** | **+2.206** | **28.4%** |
| **CST capture buffer** | **0.000** | **0.966** | **+0.966** | **12.4%** |
| GC | 0.564 | 1.111 | +0.547 | 7.0% |
| AST builders (jess core) | 0.261 | 0.357 | +0.096 | 1.2% |
| RegExp engine | 0.411 | 0.475 | +0.064 | 0.8% |
| `src/table/run-support.ts` | 0.000 | 0.048 | +0.048 | 0.6% |
| **TOTAL** | **6.246** | **14.011** | **+7.765** | 2.243× |

**benchmark.less, 200 parses per side**

| mechanism | 0.46 | HEAD | delta | share |
|---|---:|---:|---:|---:|
| PARSER BODY | 16.292 | 26.756 | +10.464 | 57.6% |
| **TRIVIA scan/classify** | **0.000** | **4.997** | **+4.997** | **27.5%** |
| **CST capture buffer** | **0.000** | **2.441** | **+2.441** | **13.4%** |
| RegExp engine | 0.594 | 0.800 | +0.206 | 1.1% |
| GC | 0.988 | 1.101 | +0.113 | 0.6% |
| AST builders | 0.849 | 0.707 | −0.142 | −0.8% |
| **TOTAL** | **19.258** | **37.420** | **+18.163** | 1.943× |

Two dialects, two fixtures: **40.8% and 40.9%** of the regression is in files 0.46
does not enter at all. That agreement is the load-bearing result, and it is a
presence/absence fact, not a sampling judgement — 0.46's self-time in
`src/cst/trivia-charscan.ts`, `src/cst/trivia-kinds.ts`,
`src/combinators/trivia-skip.ts` and `src/cst/capture-buffer.ts` is exactly zero,
in both dialects, at both sampler intervals.

`src/cst/trivia-charscan.ts` and `src/cst/root-trivia-scope.ts` do not exist at
0.46. `trivia-kinds.ts` and `capture-buffer.ts` do, and are never called.

## 5. GC: the sampled row is WRONG, and the allocation delta is the real number

`--trace-gc`, 100 parses of benchmark.css, post-warm window only, allocation
computed as Σ(heap-before[i] − heap-after[i−1]):

| | scavenges | mark-compacts | allocated | GC wall time |
|---|---:|---:|---:|---:|
| HEAD | 79 | 2 | 4,629 MB = **46.3 MB/parse** | 0.828 ms/parse |
| 0.46 | 53 | 2 | 2,679 MB = **26.8 MB/parse** | 0.605 ms/parse |

**GC wall-time delta is +0.22 ms/parse — under 3% of the regression.** The css
sampled GC row says +0.547 (2.5× high); the less sampled row says +0.113. Once
again a `--trace-gc` byte/time delta contradicts a sampled GC row, and once again
the sampled number is the wrong one. Do not spend anything on GC.

What IS real is the **allocation volume: +19.5 MB per parse, 1.73×**. That cost is
charged to the mutator, so it is hiding inside the PARSER BODY / TRIVIA / CST rows
above, not in the GC row. Note that 26.8 MB/parse for a 123 KB input is already
extreme on 0.46 — 218 bytes allocated per input byte — and HEAD makes it 376.

The identified allocator: `scanWithLabels` (`src/combinators/trivia-skip.ts:128`)
allocates, PER TRIVIA GAP, up to three row arrays (`fullRows`, `rootRows`,
`cstRows`), a `{ end, commit }` record, and **a closure capturing six variables**.
`trivia-charscan.ts`'s own header counts 31,758 labelled-trivia gaps in one parse
of benchmark.less.

## 6. The trivia and CST work produces NOTHING 0.46 does not already produce

`pnpm bench:jess:ab css` in rich mode, HEAD vs `a5dc9bd`:

```
engine: DIFFERENT — head macro→emitted, ref macro→source
three-way agreement (HEAD macro / HEAD interpreter / a5dc9bd macro): YES
facets: value, span, expected, expected-order, errors, rootTrivia
whole-RunResult digest differs — container HEAD RunResultRecord vs a5dc9bd Object.
```

**All six facets agree, `rootTrivia` included.** 0.46 computes the identical
trivia record with one fused trivia regex — its whole RegExp bucket is 0.411
ms/parse, of which the trivia pattern is 0.099 — and never touches
`analyzeLabeledTrivia`, `pushCstChild` or the capture buffer.

HEAD runs the trivia regex too (0.475 ms/parse, same order) AND, on top of it, the
labelled char-scan, the per-gap `analyzeLabeledTrivia`, and the CST capture buffer.
The emitted `_skipTrivia` prelude
(`emit-assembly.ts` `RUNTIME_PRELUDE`) shows the switch:

```js
if(s!==null&&ctx._triviaLog===undefined&&!(ctx.captureTrivia===true&&(ctx._cstBuf!==undefined||ctx._cstTriviaLog!==undefined)))return s(input,cur)
```

The fast arm is skipped, so `_cstBuf` is defined and/or `_triviaLog` is set during
an AST-mode parse (`hostMode: 'ast'`, `trackLines: false` — jess's canonical
variant). Confirmed at runtime by non-zero self-time in `pushCstChild`,
`rollbackBufList`, `demoteCapturedToRaw` and the emitted `_rbBuf` / `_pushLeafBuf`,
all of which are unreachable unless the buffer exists. One jess reducer,
`bodySpanFromRaw`, appears ONLY on HEAD (0.058 ms/parse) — it reads raw CST
children, so the CST is not merely built, it is read.

## 7. The mark/rollback tax inside PARSER BODY — a LOWER bound, counted not timed

The 41% above excludes the CST bookkeeping that `emit-assembly.ts` INLINES into
`_pf` bodies (`emitMark`/`emitRollback`), which the profile charges to PARSER BODY.
Counted in the emitted text:

| | css | less |
|---|---:|---:|
| `const b=ctx._cstBuf` mark prologues (5 length loads each) | 473 | 862 |
| of which the "capture state unknown" form | 84 | 68 |
| `ctx._triviaLog` length reads | 471 | 860 |
| `ctx._rootTriviaLog` length reads | 471 | 860 |
| `_rbBuf(ctx,…)` rollback sites (CST-buffer form) | **692** | **1,618** |
| `rollbackTriviaAt(ctx,…)` sites (no-buffer form) | 247 | 312 |
| `_pushLeafBuf` / `_pushLeaf` / `pushCstChild` sites | 206 / 177 / 131 | 391 / 175 / 259 |
| mark+rollback text as a share of the factory | 108,135 B / 9.5% | 186,544 B / 8.8% |

`site-labels.ts` concluded CAP_ON — CST buffer definitely present — at 74% (css)
and 84% (less) of marked sites. So **41% is a floor**, not the whole CST/trivia
share.

## 8. What is accounted for, and what is NOT

| | share of the regression | evidence class |
|---|---:|---|
| Trivia classification + CST capture, in files 0.46 never enters | **41%** (css 40.8, less 40.9) | presence/absence — strongest |
| GC | ~3% | `--trace-gc` counts |
| AST builders, RegExp, run-support | ~2% | sampled |
| Mark/rollback bookkeeping inlined into `_pf` | **unquantified**, ≥0; 9% of emitted text | counted, not timed |
| **Residual PARSER BODY** | **~45–55%** | **NOT EXPLAINED** |

Stated plainly: **I can account for about 44% with confidence, bound a further
slice I could not time, and I cannot explain roughly half.** After the inlined
bookkeeping is set aside, the emitted per-site pieces are still slower per unit of
matching than 0.46's `_r_<Name>` rules, and I did not isolate why. Ruled out along
the way: deopts (§2), emitted-body size / optimisation budgets (§3), GC (§5).

One unexplained sub-fact worth recording, because it constrains any future
hypothesis: the **author reducers in jess's `grammar.ts` are the same source on
both sides** and still move — css 1.304 → 1.720 ms/parse (1.32×), less 3.411 →
4.438 (1.30×). Identical code, 30% slower under the emitted engine. Only 0.058 of
the css delta is the head-only `bodySpanFromRaw`. Either the emitted engine calls
those reducers more often, or it calls them with worse inline-cache feedback. That
is the thread I would pull next, and it is a differential that can be settled by
COUNTING calls rather than timing them.

## 9. What I would fix first, and what it is worth

**Stop the emitted engine entering the labelled-trivia + CST-capture path when the
run's consumers cannot observe either.** §6 is the whole argument: the six output
facets are byte-identical without it, so on this configuration the work is
unobservable.

Worth, by direct subtraction of §4:

- benchmark.css 14.011 → ~10.84 ms/parse, **2.243× → ~1.73×**
- benchmark.less 37.420 → ~29.98 ms/parse, **1.943× → ~1.56×**

plus an unmeasured part of §7's inlined bookkeeping, plus most of the +19.5
MB/parse of allocation, which is charged to rows this subtraction does not touch.
So ~1.7× is a conservative landing point, not the floor.

Two things it is NOT: it is not a GC fix (§5), and it is not a fix to the emitted
lowering as such — `emit-assembly.ts` is faithfully emitting what `site-labels.ts`
told it, so the decision to investigate is **why CAP_ON is concluded at 74–84% of
sites for a `hostMode: 'ast'` parse whose result carries no CST.**

## 10. Corrections to the brief this probe was written from

1. **Emitted sizes are wrong** — css is 1,136,493 B not 157 KB; less 2,118,741 B
   not 397 KB (§3). json not checked.
2. **The size/optimisation-budget hypothesis is misdirected** (§3). The megabyte is
   a one-shot factory; the optimisation units are ≤32 KB inner functions and they
   optimise fine.
3. **`notes/PROBE-remaining-floor.md` is not on `release/0.47.0`.** It exists only
   on `bce95b0`. Anyone re-reading the "wrong engine" optimisation queue has to go
   to that commit for it.
4. **`--heap-prof` does not answer the allocation question.** Node's
   `--heap-prof` reports SURVIVING allocations: it accounted for 15 MB against a
   measured 9.2 GB of churn over the same run. `--trace-gc` byte deltas do answer
   it (§5).
5. The brief's framing "profile the emitted engine" implies the harness had to be
   reused for timing. It did not: the gap reproduces at 2.0–2.3× in a ONE-LEG
   process (§1), which is what makes the process-global instruments usable at all.

## Reproducing

```
node --import ./bench/jess/ab-register.mjs bench/jess/emit-profile.ts --side=head --dialect=css --n=200
node --import ./bench/jess/ab-register.mjs bench/jess/emit-profile.ts --side=ref  --dialect=css --n=200
#   --dump=<file>   capture the emitted factory source (§3, §7)
#   PM_MARK=1       print the ### WARM ### marker; the profile is cut at __PM_WARM_MARK__
```
