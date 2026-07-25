# Single-process interleaving, and when it lies

`pnpm perf:guard:grammars` loads both sides of its A/B into ONE process and
interleaves them. That is deliberate, and [perf-gates.md](./perf-gates.md)
explains why: it removes the cross-machine term entirely, which is the term that
made an earlier separate-process proposal need a 40% tolerance. It is fast, it
needs nothing but this repository, and it has caught real regressions — the
0.34.0 rollback event lost **0 of 12** pairs on all three guarded cases.

Keep it. This page is about a narrow failure mode it has, how to recognise it,
and what to run before you believe a red.

## The failure mode

Both sides' compiled parsers live in one heap, one module registry and one JIT
profile. A case sitting near an inlining or optimization cliff can therefore be
pushed to a different optimization outcome by the **presence** of the other
side's code — including by code that case never executes, because V8's inlining
decision is bytecode-size based and a dead branch still has bytecode.

Interleaving and per-round rotation defend against *drift*: a machine getting
busier over the run, a thermal ramp, a background job that starts halfway. They
do nothing about this, because this is not drift. It is a fixed, structural
difference between the two sides that happens to have nothing to do with the
change under test, and it is stable across rounds — which is exactly what makes
it look convincing.

### It has been observed at gate-firing magnitude

The investigation that found this was looking at a change whose emitted code
differed from the reference **only inside a branch the case never enters** — a
`_ctx.build?._parsemanCstOutput === true ? … : …` host branch, with no host
installed. That was established by diffing the emitted source of every entry in
`DENSITY_CASES` between the two commits, which is the decisive check: if the
generated code cannot reach the case, no reading about that case is about the
change.

The gate read `expected/narrow` at **+21.9% … +26.2% median, winning 0 of 12
pairs**, across multiple runs. Cross-process — one fresh `node` per side,
alternating order per round, 9 rounds — the same two commits read neutral:
reference mean **0.4874 ms** versus branch mean **0.4873 ms**, the branch
winning 5 of 9, with the branch's *minimums* consistently lower.

### And it reproduces with no change at all

The strongest form of the evidence needs no commit pair. Comparing a build
against **itself** — identical source on both sides — reproduces the same
reading on the same case.

Four runs of `pnpm perf:guard:grammars --ref=d4f107f --head-ref=d4f107f` on a
machine at load average ~5:

| run | `expected/narrow` median | min | pairs won | verdict |
| --- | --- | --- | --- | --- |
| 1 | **+25.0%** | **+21.2%** | **0 / 12** | **FAIL** |
| 2 | +0.4% | −3.0% | 6 / 12 | ok |
| 3 | −1.3% | −0.7% | 8 / 12 | ok |
| 4 | +0.0% | +2.5% | 6 / 12 | ok |

Run 1 is a gate failure, at a magnitude and a win rate that satisfy both of the
gate's independent signals, on a comparison where the two sides are byte-identical.
There is no regression there to find.

The same runs show it in the other direction, on a different case:

| run | `rollback/none` median | min | pairs won |
| --- | --- | --- | --- |
| 1 | **−19.6%** | −18.8% | **12 / 12** |
| 2 | **−9.1%** | −9.5% | **12 / 12** |
| 3 | +0.1% | −0.2% | 6 / 12 |
| 4 | +0.0% | −2.8% | 7 / 12 |

A clean 12-of-12 sweep, twice, for identical code. The gate does not fail on
those because it only tests one direction — but a change that genuinely cost
`rollback/none` 15% would have been masked outright in either of those runs. The
same investigation also saw a case swing between −19% and +74% between runs.

The magnitudes are not noise-shaped. Timer granularity and GC produce a spread
around zero; this produces a *stable* offset within a run that changes state
between runs. Runs 3 and 4 above sit inside ±2.6% on every case, which is the
harness's real floor. Run 1 is not the floor being exceeded, it is a different
phenomenon.

Cross-process, that same self-versus-self pair reads neutral —
`pnpm perf:xproc --ref=d4f107f --head-ref=d4f107f --case=expected/narrow`,
9 rounds, on the same machine at the same time:

```
neutral   median-of-rounds 0.5439 → 0.5633 ms (+3.6%)   mean 0.5928 → 0.6014 ms (+1.4%)
          best min 0.4526 → 0.4628 ms (+2.3%)   head won 5/9 rounds
```

## How to tell

None of these is conclusive alone. Together they are.

- **The reading is bimodal across runs.** Not a wide spread — two modes. A case
  that reads +25%/0-of-12 and then +0.4%/6-of-12 is not a case with a 25%
  regression measured noisily.

- **The case measures clean alone and dirty in a batch**, or the other way
  round. The interference is between sides *and* between cases in one process.

- **A large median delta with a small min delta.** The min is the sample least
  disturbed by a burst; a real per-execution cost moves it too. (Note this cuts
  the other way in run 1 above, where the min moved +21.2% — a clean min is
  evidence, a dirty one is not counter-evidence.)

- **Decisively: diff the generated code.** Compile every entry in
  `DENSITY_CASES` on both sides and diff the emitted source. If the change
  cannot reach the case — no textual difference, or a difference confined to a
  branch that case never enters — the reading is not about the change, and
  nothing else needs deciding.

## What to do about it

**Before calling a `perf:guard:grammars` result a regression, confirm it across
processes.**

```sh
# 1. Re-run the gate. A single red run has never been a regression here.
pnpm perf:guard:grammars

# 2. Run the control at the same time, on the same machine. If a case fires with
#    identical code on both sides, that case's reading is worthless this session.
pnpm perf:guard:grammars --ref=<head-sha> --head-ref=<head-sha>

# 3. Confirm the suspect case across processes.
pnpm perf:xproc --ref=<ref-sha> --head-ref=<head-sha> --case=expected/narrow

# 4. If steps 2 and 3 disagree with the gate, diff what the change actually
#    emitted for that case before spending any more time on it.
```

`pnpm perf:xproc` (`bench/xproc-ab.ts`) materialises its reference side exactly
the way the gate does — a `git worktree` at the pinned sha under `.cache/`, this
repo's `node_modules` symlinked in, the working tree's `grammar.ts` copied over
the top — so the two tools compare the same two things. It then runs **one fresh
process per side per round**, alternating which side launches first, and prints
each round's median and min for both sides plus a summary with the win rate.

```
pnpm perf:xproc --ref=<sha> --head-ref=<sha> --case=<substring> --rounds=9 --reps=40
```

It is **not a gate and must not become one.** A cross-process comparison carries
the between-launch term the interleaved harness exists to eliminate — this
hardware has produced 9.4 ms and 26 ms for the same case in consecutive launches.
Read the win rate across rounds; a single round means nothing. Its job is to
answer one question — "is this case slower when the two builds have never shared
a heap?" — and a neutral answer there against a confident red in the gate is
enough to stop treating the red as a regression.

## The same question applies to `perf:workloads`, unconfirmed

`bench/workload-perf-guard.ts` is also single-process, and it runs five
workloads together. In the same investigation a workload measured clean under
`--only=css` and breached when run alongside the other four in one process.

That is one observation and it has no control behind it — nothing there is as
strong as the identical-code control above, and there are ordinary explanations
(the workloads allocate heavily, and `--only` changes the GC history a workload
inherits, which is the reason that gate measures in adjacent order-alternated
pairs in the first place). Treat it as a question worth answering rather than a
known defect. If someone wants to settle it, the shape of the experiment is the
one above: run `pnpm perf:workloads --self` with and without `--only`, several
times, and see whether a workload is bimodal between the two.

## What this does not mean

It does not mean the gate is unreliable in general. Three of the four control
runs above sat inside ±2.6% on every case, which is close to the 1.9%/1.0%
quiet-machine figure the thresholds were calibrated against. It does not mean
the thresholds are wrong; widening them would not fix a +25% artifact and would
blind the gate to the band it exists to watch. And it does not mean a red should
be dismissed — the 0.34.0 replay's 0-of-12 was real, and so was 0.35.0's.

It means one specific thing: a per-case reading from this harness is a claim
about two builds *sharing a process*, and on a case near an optimization cliff
that is not always the same claim as "this build is slower". The cost of
checking is one command.
