# Performance gates

parseman has two performance gates. They answer different questions, and the
difference is the whole point.

| gate | asks | cost |
| --- | --- | --- |
| `pnpm perf:guard` | did parseman's own microbenchmarks move? | seconds |
| `pnpm perf:guard:grammars` | did the code parseman EMITS get slower on a grammar-shaped workload? | ~10 s |

Both run on every PR. Neither needs a checkout of any other repository, a
network fetch, or a setup step: `pnpm install && pnpm perf:guard:grammars` is the
whole contract.

## Why the second one exists

`perf:guard` measures `fixtures/css/decls.css` (47 bytes) and
`fixtures/css/selector.css` (34 bytes), in microseconds, against a committed
baseline. It is a good, cheap tripwire for a catastrophic codegen change.

It is not a gate on parseman's actual goal. During the 0.34.0 cycle it passed on
every PR. It passed at 0.34.0. And 0.34.0 made a downstream Less grammar parse
**25% slower** — discovered by the consumer instead of at the source.

The mechanism was `not()`'s probe-leak fix (correct, and kept) emitting six
**unconditional** capture-buffer `length` stores per probe. Assigning
`array.length` runs V8's length setter — a backing-store trim decision — and
costs the same whether or not the value changes. A rollback overwhelmingly
restores a length that never moved, so the store was pure overhead on the common
path.

The microbenchmarks execute `not()` about 20 times per KB and did not move. The
Less grammar executes it about 600 times per KB and moved 25%.

That gap — trigger versus goal — is what `perf:guard:grammars` closes.

## What it measures

Not a stylesheet. Two **sweeps** over one grammar shape
(`bench/grammar-density/grammar.ts`) and one ~38 KB input, each holding
everything constant except one axis.

**`rollback/*` — speculative probes per byte.** 0, 1, 4 and 16 negative
lookaheads in front of every value term. The conversion is MEASURED by
instrumenting the emitted artifact, not estimated: 3,556 / 14,224 / 56,896
`not()` executions over the 37.7 KB input, i.e. **94 per KB per guard** — 0 / 94
/ 377 / 1508. The real grammars in the 0.34.0 event measured css 20, jess 121,
less 599, so all three land inside the sweep and `dense` sits 2.5x above the
worst of them.

> An earlier revision of this document said `x 42`, which put `dense` at ~672/KB
> and made less (599) look like a grammar sitting at the very edge of the
> bracket. It was not, and a `rollback/extreme` case added to "extend the range"
> on that reading has been removed. If the input generator changes, re-measure
> this constant rather than scaling the old one.

**`expected/*` — derived expected-set width at a losing choice.** 0, 1 and 4
optional terms in front of every choice arm, all drawing on the same operand
alphabet, so deriving through the nullable prefix re-reaches the same tokens once
per term per arm. The emitted total-failure path is `_ctx._fx = [...arm0,
...arm1, …]`, and those arrays feed the enclosing choice's concat, so the cost
compounds up the nesting rather than adding.

`none` (0 terms) is a disjoint-arm baseline: with no nullable prefix its arms gate
on distinct first characters, so it differs from the other two in dispatch as well
as in width. `narrow` (1) and `wide` (4) both carry a prefix and so share a
dispatch shape, differing only in width — read the width axis across those two.

This second axis exists because the first version of this gate had only the
first, and 0.35.0 shipped a 32% Less regression straight through it — see
"Watching it go red" below. A gate parameterised on one axis only ever catches
that axis.

The point is not to look like CSS. It is to hold everything constant except the
axis under test, so the result is legible: a per-**execution** cost shows up as
an ordering across a sweep, and a per-site or per-input cost does not.

Every case builds nodes with trivia capture, which is load-bearing rather than
decorative: the emitted rollback is gated on `ctx.capturing`, and each truncation
is gated on its sink being non-null at run time. A grammar with no `node()`
compiles the rollback away and measures nothing.

The grammar also wraps its declaration rule in `attempt`, so the six-sink
transactional restore is exercised alongside `not`'s. The 0.34.0 fix touched 33
emission sites; a gate that watches only one of them will pass the next
regression in the other 32.

## How it measures

A/B against a **pinned reference commit of this repo**, both sides loaded and
**interleaved in one process**, rotating order per round.

Self-calibrating by construction: nothing machine-specific is stored, so it reads
the same on a laptop and on a shared CI runner. That matters more than it sounds
— comparing separate *processes* on this hardware produced 9.4 ms and 26 ms for
the same case in consecutive launches, and it is the reason the older nightly
proposal (`docs/design/perf-nightly.workflow.yml`) had to keep its timing
tolerance at 40%. An interleaved A/B has no cross-machine term at all.

The reference side is a `git worktree` at the pinned sha with this repo's
`node_modules` symlinked in — nothing needs a per-sha dependency tree, because
`src/index.ts` is loaded through tsx and tsx only transpiles. The grammar file is
**copied from the working tree** into that worktree, so both sides compile
byte-identical grammar input and the only difference is parseman itself. The gate
then asserts both sides produce the **same parse result** before timing either:
the cheapest way for one side to look fast is to stop doing work.

Repetitions per timed sample are **calibrated at startup** so every case's sample
lands near 4 ms. Without that the sparse cases run in ~0.5 ms, where timer
granularity and a single GC pause dominate — self-vs-self noise measured 3.5%
there against 0.4% on the dense case. Calibration runs on the reference side only
and the same count is applied to both, so it cannot favour one.

### Per-case, never aggregated

Replaying 0.34.0 against 0.33.0:

| case | probes/value | median delta |
| --- | --- | --- |
| `rollback/none` | 0 | **+1.2%** |
| `rollback/sparse` | 1 | **+54.9%** |
| `rollback/medium` | 4 | **+89.0%** |
| `rollback/dense` | 16 | **+112.8%** |

Any aggregate shows something mild. The **spread** is the finding: it says the
cost is per-execution, which is exactly how the real regression was diagnosed
(css 20 / jess 121 / less 599 `not()` per KB, ordering −1.6% / +6.6% / +25.5%).

Replaying the 0.35.0 regression — `--ref=9c6fee2 --head-ref=a464372`, the merge
of `fix(expect)` — reads the other way round, which is the whole argument for
having both axes. **Five** replay runs, because one is not a measurement:

| case | | median delta, 5 runs | pairs won |
| --- | --- | --- | --- |
| `rollback/none` … `rollback/dense` | 0–16 probes | −17.3% … +6.2%, no consistent sign | 0–12 / 12 |
| `expected/none` | 0 opt/arm | −0.7% … +1.2% | 5–9 / 12 |
| `expected/narrow` | 1 opt/arm | +1.8% … +21.1% | 0–3 / 12 |
| **`expected/wide`** | 4 opt/arm | **+6.9% … +39.3%, fired 5 of 5** | **0/12, every run** |

`expected/wide` is the only case that breaches on every run. `expected/narrow`
breaches on two of five, which is the right ordering — it carries a nullable
prefix too, just one term of it. The rollback sweep — the entire gate as first
landed — never fires consistently on a change that cost jess's Less grammar 32%
of its parse time.

> The wide spread inside each row is the machine, not the change. See the
> threshold caveat below: these runs were taken at load average ~5, where the
> harness's own self-vs-self floor measures far worse than the quiet-machine
> figure the thresholds were calibrated against.

### Median AND min AND win rate

A single median is not a measurement. The first attempt at measuring the real
regression produced a wrong number that way. The gate reports all three and
requires two independent signals to fire: a case fails only when it breaches the
median **or** min threshold **and** loses at least 3/4 of its interleaved pairs.

Win rate alone is lopsided even at noise-level deltas; a real regression loses
nearly every pair — the 0.34.0 replay won **0/12** on all three guarded cases.

### Thresholds, and where they came from

`medianPct: 6`, `minPct: 6`, `winRateCeiling: 0.25`.

Measured, not guessed. The **same build compared against itself** through this
harness (`--ref=<head-sha> --head-ref=<head-sha>`, 4 rounds × 3 runs, calibrated
samples, interleaved with per-round rotation) moved the per-case median by at
most **1.9%** and the min by at most **1.0%**. 6% is over 3× the worse of those.

### What it does NOT catch — read this before trusting a green

- **Below about 3% per case is under the harness's resolution.** More rounds
  would buy resolution at the cost of a slower gate, i.e. a gate that gets
  skipped. That trade was made deliberately.

- **It is amplified, not more sensitive in real terms.** The same 0.34.0 change
  that cost the real Less grammar +25.5% costs `rollback/dense` +112.8% —
  about 4.4×, because the synthetic case is almost nothing but probes. Read a
  number here as roughly a quarter of itself on a real grammar: a 6% breach is
  something like a 1.5% real-grammar regression. That amplification is the gate's
  value (it sees small things early) and its limit (it cannot tell you what a
  given delta costs a *particular* consumer). The `expected/*` amplification is
  milder — `expected/wide` read +25.6% on a change worth +49.6% to jess's Less
  grammar, so under 1×; a breach there is at least as bad in real terms.

- **It watches two axes, and only two.** `rollback/*` moves speculative probes
  per byte; `expected/*` moves derived expected-set width at a losing choice. A
  regression in trivia scanning, first-set dispatch, node construction or the
  interpreter can move every case in BOTH sweeps together — the gate will report
  that, but neither spread will explain it, because nothing is being held
  constant against it. `perf:guard`'s deterministic `composeLeaf` dispatch
  assertion still carries first-set-dispatch coverage.

  The history here is the argument for reading this bullet literally rather than
  as boilerplate: the gate shipped with one axis and a regression rode the other
  through it in the very next PR. A third axis is an entry in `DENSITY_CASES`;
  adding one is cheaper than the release that finds it for you.

- **The 1.9% / 1.0% noise floor is a QUIET-MACHINE figure.** Re-measured
  self-vs-self (`--ref=X --head-ref=X`) at load average ~5, the worst case moved
  the median 8.3% and the min 7.6% — past the 6% thresholds. Interleaving and
  per-round rotation cancel a steady load; they do not cancel a bursty one at
  ~3 ms samples. In practice this shows up as a case breaching once and not
  breaching on a re-run. **A single red run is not a regression.** Re-run it, and
  re-run self-vs-self alongside if the machine is busy; a real regression loses
  0-of-12 pairs every time, which is what distinguishes it from load.

- **The synthetic grammar is not a correctness corpus.** It asserts only that
  both sides parse identically; it says nothing about whether that parse is
  right.

## Running it

```sh
pnpm perf:guard:grammars                    # the gate
pnpm perf:guard:grammars --quick            # 2 rounds x 1 run — TRIAGE ONLY, does not gate

# Validate the gate itself. A gate nobody has watched fail is not known to work.
pnpm perf:guard:grammars --ref=7f1ddcd --head-ref=c7780e4   # 0.34.0 without the fix — expect RED
pnpm perf:guard:grammars --ref=7f1ddcd --head-ref=fdf4e90   # 0.34.0 with the fix    — expect GREEN
pnpm perf:guard:grammars --ref=<sha> --head-ref=<same sha>  # the noise floor
```

The reference sha lives in `bench/grammar-density/config.json`. Bump it to the
released sha **at every release, in the release PR**, with the numbers read in
that PR — an unbumped reference slowly turns into an archaeology exercise, and a
silently bumped one erases whatever it was hiding.

A missing reference commit is a **hard failure**, never a skip: CI checks out
with `fetch-depth: 0` so the pinned sha is present, and if it is not, the gate
says so and exits non-zero. "The gate did not run" must never render as green.

## When it fires

Do not widen the threshold to make a build pass. Either fix the regression, or
land it with the number visible and an explanation of why it is the price of
something. An honest "3% is the cost of correctness, 22% was avoidable" is a
result. "Should be faster now" is not.
