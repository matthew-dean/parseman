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

Not a stylesheet. A **rollback-density sweep**: one grammar shape
(`bench/grammar-density/grammar.ts`), one ~38 KB input, instantiated at four
densities of speculative probe — 0, 1, 4 and 16 negative lookaheads in front of
every value term, which on this input is roughly 0 / 42 / 168 / 672 probes per
KB. That brackets the 20 / 121 / 599 `not()`-per-KB measured across the three
real grammars in the 0.34.0 event.

The point is not to look like CSS. It is to hold everything constant except the
one axis the regression rides on, so the result is legible: a per-**execution**
cost shows up as an ordering across the four, and a per-site or per-input cost
does not.

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
  given delta costs a *particular* consumer).

- **It watches the rollback/speculation axis specifically.** A regression in
  trivia scanning, first-set dispatch, node construction or the interpreter can
  move all four cases together, which the gate will report but the spread will
  not explain. `perf:guard`'s deterministic `composeLeaf` dispatch assertion
  still carries first-set-dispatch coverage.

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
