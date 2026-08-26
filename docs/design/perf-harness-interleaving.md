# Single-process interleaving, and when it lies

## 0.50 macro-architecture experiment protocol

The high-ceiling 0.50 programs in [`notes/PERF_IDEAS.md`](../../notes/PERF_IDEAS.md)
U-57…U-61 use the existing Jess macro A/B path as their production decision
instrument. A number counts only when both legs are ordinary shipping macro
artifacts, the banner identifies the realized engine and source realpath, the
input is fully consumed, and successful output identity is checked. Build-time
dynamic generation is allowed; neither emitted leg may call `eval` or
`new Function` at parse time.

Keep the reference in a nearby worktree and run candidate/reference legs in
alternating, adjacent rounds. Run an identical-code worktree comparison in the
same load window and normalize the candidate result against it. This is required
even for a large apparent win: background load on this machine can create stable
within-run bias rather than ordinary zero-centered noise.

Architectural lanes may analyze and compile in parallel, but **production timing
is serialized**. Two agents benchmarking at once are not independent evidence;
they are each other's workload. Before retaining a result, repeat it with no
other lane compiling or timing, record load at both ends, and use the existing
two-graph/interleaved harness rather than constructing a new benchmark wrapper.
Macro source size, npm-pack size where relevant, and the bytecode size of hot
bodies around V8's measured 460-byte inlining cutoff travel with the timing.

The purpose of an early ceiling probe is falsification, not release readiness.
It may temporarily suppress or replace work to price an architecture, but it
must preserve successful parse value and consumption before its speed is
interpretable, must say which contracts it intentionally omits, and must be
reverted if the ceiling cannot plausibly produce a 15% whole-workload gain. Only
a semantically complete version may be committed as a retained win.

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

```text
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

```sh
pnpm perf:xproc --ref=<sha> --head-ref=<sha> --case=<substring> --rounds=9 --reps=40
```

It is **not a gate and must not become one.** A cross-process comparison carries
the between-launch term the interleaved harness exists to eliminate — this
hardware has produced 9.4 ms and 26 ms for the same case in consecutive launches.
Read the win rate across rounds; a single round means nothing. Its job is to
answer one question — "is this case slower when the two builds have never shared
a heap?" — and a neutral answer there against a confident red in the gate is
enough to stop treating the red as a regression.

## `perf:workloads` shows the same shape — and its `--self` check cannot see it

`bench/workload-perf-guard.ts` is also single-process, and it runs five workloads
together. It shows the same bimodality: on one change, `css/stylesheet` breached
3/3 and, on the identical working tree twenty minutes later, breached 0/3. On CI
the same branch read `breached 1/3` in one run and passed outright in another.
The `main` control stayed flat throughout, and the generated code for that branch
was **10,734 bytes smaller** with one fewer property chain per node and no dead
branch — that is, strictly less work, measured slower.

### It failed THIS pull request, which changes no runtime code at all

The strongest instance is the PR that added this document. Its diff is:

```text
 bench/xproc-ab.ts                        | 236 +++++++++++++++++++++++++++
 docs/design/perf-gates.md                |  33 +++
 docs/design/perf-harness-interleaving.md | 207 +++++++++++++++++++++++
 package.json                             |   1 +
```

No file under `src/`. The compiled parsers are byte-identical to the base commit —
`bench/xproc-ab.ts` is a new standalone script that no gate imports, and the
`package.json` line is a script entry. There is no mechanism by which this change
can alter parse throughput.

`workload-perf` failed it anyway, on an idle CI runner (load 0.80):

```text
FAIL  json/document  59 KB  median +1.7% … +3.7%  min +1.5% … +3.9%
                            won 2/12 0/12 0/12   breached 3/3
```

Breaching **all three** passes, with win rates of 2/12, 0/12 and 0/12 — the exact
signature the gate documents as "a real regression loses every pair". Every other
workload in the same run read flat.

This is worth more than the synthetic control above, because it is not a control:
it is the gate's ordinary operation, on an ordinary PR, in CI. A gate that fails a
documentation change will fail real ones, and the win-rate rule that is supposed to
separate noise from signal did not separate this.

### A second defect, and what it does to the record

Reviewing the cross-process script surfaced a bug in the gates themselves. Both
`materialise()` implementations — `bench/grammar-perf-guard.ts` and the shared one
in `bench/ab-harness.ts` — decided a cached reference worktree was reusable by
testing that `.cache/<gate>-<sha>/src/index.ts` **exists**. Existence proves a
worktree is there. It does not prove which commit it holds. The sha appears in the
directory *name*, and nothing ever checked the contents against it.

So a worktree left behind by an interrupted run, or one someone checked out to a
different revision, was reused silently — and the gate benchmarked **a different
commit from the one it named in its own output**, with no warning. Both now verify
`git rev-parse HEAD` against the requested sha and rebuild on mismatch.

This is worth stating plainly rather than filing as a fixed bug:

> **It retroactively weakens every number these gates have produced.** Any past
> result whose reference side came from a reused `.cache/` directory may have been
> measured against the wrong commit, and there is no way to tell after the fact
> which ones were — the output recorded the sha it *intended*, not the sha it
> *used*. Historical readings from `perf:guard:grammars` and `perf:workloads`
> should be treated as indicative, not as evidence, unless they were produced from
> a clean `.cache/`.

Combined with the interleaving artifact above, the honest summary is that these
gates have two independent ways of producing a confident wrong number, one of
which is invisible in their output. Both are fixed; neither fix recovers the
historical record.

### The named limitation: a clean `--self` is not a trust signal here

`pnpm perf:workloads --self` reads clean on `css/stylesheet` (±0.8%). That is
**not** evidence the gate's A/B readings are sound, because `--self` cannot
reproduce this failure mode by construction:

> `--self` compares a commit against **itself**. Both sides are the same code, so
> both sides compile to the same-sized code image. The artifact appears to need two
> **differently-sized** images sharing one heap and one JIT profile — which is
> exactly the situation `--self` removes.

So the self-check is sound for what it measures (machine noise, timer
granularity, GC drift) and blind to the thing that actually fires this gate. A
clean `--self` says "the harness is not noisy today". It does not say "this A/B
number is real".

This is the same shape as the `analyzeGating` defect fixed in 0.37.0: a check that
reported success because it could not see the failure, and whose passing result
was therefore indistinguishable from a genuine pass. Treat "the self-check was
clean" the same way — as the absence of one class of evidence, never as the
presence of another.

### What to do instead

Confirm cross-process (`pnpm perf:xproc`, above). Where a workload rather than a
grammar-density case is in question, the equivalent recipe is one fresh process
per side, order alternated per round, at least a dozen rounds — the same design,
applied to the workload's own grammar and corpus. On the change described above
that gave **+2.0% median, +1.0% min, winning 5 of 14**, against the same gate's
`+15 … +29%`.

## A related blind spot, in the correctness gates rather than the perf ones

The same failure shape — a check reporting clean because it cannot see the class of
defect in question — has now appeared in the equivalence checking too, and it is
worth recording next to this because the lesson is identical.

An **AST-only differential cannot see CST movement.** Comparing parseman 0.32.0
against the host-mode change over a real corpus, the eval-AST aggregate was **identical across 707
files** — genuinely zero movement — while the positioned-CST aggregate moved on **68**.

An earlier evaluation had reported "zero AST movement across 3,053 file-parses" as
its strongest evidence. That statement was true, and reconfirmed. It was also not
evidence about the CST.

> **A second lesson, from getting this wrong.** The first reading of that CST movement
> called it "55 source tokens dropped" — because it compared **leaf counts per file**.
> A count delta cannot distinguish *a duplicate was removed* from *a token was lost*,
> and the truth was the former: 0.32.0 leaked duplicate leaves (compiled `not()` relied
> on a rollback that fires only on the inner-*failure* path, so a successful probe left
> its captured leaves for an enclosing `optional`/`many` to absorb), and host mode removes
> them. Diffing as a **per-offset multiset** shows every 0.32.0-only leaf sitting at an
> offset the host-mode tree still covers.
>
> So: compare trees **per offset**, not by count. And when a differential moves, the
> baseline-free invariant — does the concatenation of leaves reconstruct the source? —
> settles which side is wrong without needing to trust either version.

So: **every equivalence claim gated on the AST aggregate alone has a known blind
spot**, and the two aggregates are not substitutes. A differential oracle should
carry BOTH as a matter of course, and any spec that depends on one should say which.

Two cheap invariants would have caught these at the commit that introduced them,
and neither requires a reference version to compare against:

- **Token coverage.** The concatenation of a CST's leaves, in source order, must
  reconstruct the input. A dropped token fails this immediately and locally.
- **No structural node flattened.** A rule that declares a node type must not yield a
  bare leaf where it previously yielded a node.

Both are properties of a single parse, which is what makes them stronger than a
differential: they hold without a baseline, so they cannot go stale.

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
