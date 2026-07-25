# Performance gates

parseman has three performance gates. They answer different questions, and the
difference is the whole point.

| gate | asks | cost |
| --- | --- | --- |
| `pnpm perf:guard` | did parseman's own microbenchmarks move? | seconds |
| `pnpm perf:guard:grammars` | did a known cost AXIS move? | ~10 s |
| `pnpm perf:workloads` | did realistic parsing get slower, on any axis at all? | ~50 s |

All three run on every PR, and all three are required. None needs a checkout of
any other repository, a network fetch, or a setup step: `pnpm install && pnpm
perf:workloads` is the whole contract.

The last two are not redundant, and which one you reach for depends on what you
are doing. `perf:workloads` is the one that FINDS a regression: it parses real
stylesheets and reports the time, so a cost on any axis — including one nobody
has thought of — shows up. `perf:guard:grammars` is the one that EXPLAINS it: it
holds everything constant except a named axis, so the spread across a sweep tells
you what kind of cost you are looking at.

Neither substitutes for the other, and the history says so in both directions.
The sweep read flat on `fix(expect)` when it had only one axis. The workload gate
reads a real +49.6% Less regression as +2%…+9%, because a realistic parse spends
most of its time on work the regression does not touch — which is exactly why the
amplifying sweep is worth keeping.

## The sweep gate — `pnpm perf:guard:grammars`

### Why it exists

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

- **Losing 0-of-12 pairs is not by itself proof either.** The two sides share a
  heap and a JIT profile, so a case near an optimization cliff can be pushed to a
  different optimization outcome by the mere PRESENCE of the other side's code —
  including by a branch it never executes. Compared against ITSELF at
  `d4f107f`, `expected/narrow` read **+25.0% median, +21.2% min, 0 of 12 pairs**
  in one run of four and sat inside ±2.6% in the other three; `rollback/none`
  won **12 of 12** twice in the same four runs, which would mask a real
  regression rather than invent one. Cross-process the same self-versus-self
  pair reads neutral. Before calling a red a regression, confirm it with
  `pnpm perf:xproc` — see
  [perf-harness-interleaving.md](./perf-harness-interleaving.md) for the tells
  and the recipe.

- **The synthetic grammar is not a correctness corpus.** It asserts only that
  both sides parse identically; it says nothing about whether that parse is
  right.

## The broad workload gate — `pnpm perf:workloads`

### Why a third gate exists

The sweep gate above is parameterised. That is its strength for attribution and
its structural limit for detection: a gate parameterised on one axis only ever
catches that axis.

This is not a theoretical worry. `perf:guard:grammars` landed with a
rollback-density sweep, and **the very next merge regressed a different axis and
went straight through it.** `fix(expect)` derived expectations through nullable
prefixes — a *correctness* fix, to error-message quality — and cost jess's Less
grammar 49.6% of its parse time, because expected sets are built on every failed
arm rather than only when an error is reported, so they sit in the hot path of a
backtracking parser. Nobody would have predicted that from the diff. That is
precisely the argument for a gate that is not targeted at anything.

So this gate is deliberately unparameterised. It parses realistic input with
realistic grammars and reports the time. A regression on any axis — one already
known, or the next one — shows up as time.

### What it measures

Five workloads, in `bench/workloads/`, each ~50 KB:

| workload | grammar | what it is there for |
| --- | --- | --- |
| `less/stylesheet` | `bench/workloads/less.ts` | high speculative rollback, wide derived expected sets, full CST with trivia capture |
| `less/mixins` | same grammar | the same grammar over input weighted towards mixin calls, guards and arithmetic — separates "the grammar got slower" from "this shape of source got slower" |
| `css/stylesheet` | `examples/css/parser.ts` | the same problem domain at LOW rollback density |
| `graphql/document` | `examples/graphql/parser.ts` | non-CSS, and non-CST: builds plain values through `transform`, so capture is off entirely |
| `json/document` | `examples/json/parser.ts` | the same, at a much simpler grammar shape |

The corpora are hand-authored (`bench/workloads/fixtures/app.less`,
`site.css`) and repeated with a per-copy identifier prefix to reach size. They
are not copied from any third-party project.

`less/stylesheet` versus `less/mixins` is the one pair that varies exactly one
thing — same grammar, different input mix. **The cross-dialect rows are not
controls**: `css/stylesheet` differs from `less/stylesheet` in both grammar and
input, so a difference between them narrows a cause but does not isolate one.
Isolation is what `perf:guard:grammars` is for; say what a row is before reading
it as a control.

### Everything it needs is in this repository

No sibling checkout, no clone, no network. An earlier attempt at this gate
cloned a downstream repository and was rejected for exactly that reason: a gate
a contributor cannot run is a gate that does not run.

Vendoring is the cost of that. `bench/workloads/less.ts` is a Less-dialect
grammar written for this purpose, in the same spirit as `examples/css/parser.ts`,
which is already an adaptation of the same downstream project's CSS grammar. It
is **not a conformant Less parser** and nothing asserts that it is. Its contract
is narrower and stated in the file: it must exercise the compiler the way a real
stylesheet grammar does.

### Per-workload, never aggregated

Replaying 0.34.0's `fix(not)`, `less/stylesheet` moves +41.8% and `css/stylesheet`
moves −0.5% in the same process. Any mean of those five rows is mild and passes.
Every row is thresholded on its own and the failure message names rows.

That ordering is also the check that the workloads are worth having: the real
event measured less +25.5% and css −1.6%, and the gate reproduces the sign and
the ordering, not just a number.

### How it measures

The same A/B machinery as the sweep gate — a pinned reference commit of THIS
repo, both sides in one process, no stored timings — factored into
`bench/ab-harness.ts` so the two gates cannot drift apart on the parts that make
a measurement a measurement. Two things are specific to this gate:

**Sides are measured in adjacent, order-alternated pairs.** Not as two blocks
with a rotation. This is not a refinement: measured the block way, the reference
side of a 50 KB CST workload read **38% slower than an identical build of
itself**. The workloads allocate heavily, whichever side runs first in a round
eats the previous side's garbage, and a rotation by one over ten entries never
moves a case far enough to cancel it. Directional bias of that size does not add
noise — it MASKS a regression on the head side. Pairing dropped the self-vs-self
floor from 38% to 2%.

**Three independent passes, majority verdict.** A workload fails only when a
strict majority of passes breach. This is the gate's answer to "regression, or
busy machine?", and it is enforced rather than documented — see the threshold
section.

### Thresholds, and where they came from

```
medianPct 5   minPct 5   winRateCeiling 0.25
signTest: winRateCeiling 0.25, medianPct 1.5, minPct 1.5
passes 3, majority required
```

Measured with `pnpm perf:workloads --self`, which runs the reference against
itself, **on a machine at load average 5–9** — because that is what a shared
runner looks like, and the quiet-machine figure is the one that gets a gate
laughed at the first time it false-fails:

- worst single-pass median **+9.9%**, worst single-pass min **+3.4%**
- worst absolute swing in either direction **12.3%**
- **passes that breached: 0 of 15.** No workload false-failed.

A 9.9% swing past a 5% threshold that does not breach is the design working. Every
breach rule requires the WIN RATE as well as a percentage, and a noise pass swings
its percentage while keeping its win rate near 50%. The percentage thresholds are
not what make this safe at 5%; the conjunction is.

### The sign test, and why it had to exist

The percentage rules alone caught `fix(not)` (+35–42%) and could **not** reliably
catch `fix(expect)`, which costs the realistic Less workloads +2%…+9% — genuinely
under a 5% threshold. Widening the threshold to reach it would have been exactly
backwards: it would blind the gate to the band it exists to watch, where 0.34.0's
css row moved −1.6% and 0.35.0's repayment was −12.3%.

What separated signal from noise in that data was not the magnitude, it was the
direction. Sides are measured in adjacent order-alternated pairs, so under the
null hypothesis "these two builds are the same" each pair is a coin flip. Across
the five `fix(expect)` replay runs the less/* rows lost 1–4 of 12 pairs, pass
after pass, while the unaffected rows sat at 5–9. Losing 3 of 12 has p ≈ 0.07 per
pass; required in a majority of three passes, roughly 1 in 500.

So a workload also breaches when it loses ≤ 25% of its pairs AND is ≥ 1.5% slower
on **both** median and min. Both a percentage floor and the win rate are needed,
so a build that is merely a consistent hair slower does not fail — it has to be
consistently slower and measurably slower on the min, which is the sample least
disturbed by a burst.

### Watching it go red

A gate nobody has watched fail is not known to work. All three known regressions,
five runs each, on a machine at load average 5–9.

#### 1. `fix(not)` — 0.34.0's unconditional rollback stores (+33.9% real)

```sh
pnpm perf:workloads --ref=3175734 --head-ref=fbeb43e --allow-parse-diff
```

| workload | median delta | pairs won | verdict |
| --- | --- | --- | --- |
| `less/stylesheet` | +37.2% … +43.9% | 0–2 / 12 | **FAIL, 5 of 5 runs, 3/3 passes every run** |
| `less/mixins` | +34.4% … +42.4% | 0–2 / 12 | **FAIL, 5 of 5 runs, 3/3 passes every run** |
| `css/stylesheet` | −3.3% … +2.2% | 2–9 / 12 | ok, 5 of 5 |
| `graphql/document` | −1.3% … +4.8% | 1–9 / 12 | ok, 5 of 5 |
| `json/document` | −0.9% … +0.7% | 5–11 / 12 | ok, 5 of 5 |

`--allow-parse-diff` is required here and only here: `fix(not)` fixed a
trivia-log rollback **leak**, so the pre-fix side genuinely records a different
trivia count. Refusing to measure that would mean the one replay that proves the
gate works is the one replay it cannot run. The flag is rejected outright unless
a pinned `--head-ref` is being replayed, so it can never soften a gating run.

#### 2. `fix(expect)` — 0.35.0's nullable-prefix derivation (+49.6% real)

This is the one `perf:guard:grammars` read flat on before its `expected/*` sweep
was added.

```sh
pnpm perf:workloads --ref=9c6fee2 --head-ref=a464372
```

| workload | median delta | pairs won | verdict |
| --- | --- | --- | --- |
| `less/stylesheet` | −2.3% … +8.5% | 0–10 / 12 | FAIL in 2 of 5 runs |
| `less/mixins` | −1.8% … +13.9% | 1–5 / 12 | FAIL in 3 of 5 runs |
| `css/stylesheet` | −13.5% … +51.1% | 3–10 / 12 | ok, 5 of 5 |
| `graphql/document` | −3.1% … +10.0% | 1–9 / 12 | ok, 5 of 5 |
| `json/document` | −8.2% … +4.8% | 1–11 / 12 | ok, 5 of 5 |

**At least one less/\* row failed in 4 of the 5 runs, with no false failure on
any other row.** State that honestly rather than as "caught": this is the weak
detection of the three, it sits near the gate's resolution floor, and one run in
five was green. If this were the only gate watching that axis it would not be
enough — which is why `expected/wide` in the sweep gate, which fires 5 of 5, is
not redundant with it.

#### 3. The fixed state — stays green

```sh
pnpm perf:workloads     # HEAD (with the fix(expect) dedup) vs the 0.35.0 reference
```

Three runs, `--ref=3562f78 --head-ref=e1b92e9` (0.35.0 as shipped, versus the same
tree with the dedup):

| workload | median delta | verdict |
| --- | --- | --- |
| `less/stylesheet` | −5.0% … +4.1% | ok, 3 of 3 |
| `less/mixins` | −4.2% … +7.3% | ok, 3 of 3 |
| `css/stylesheet` | −1.4% … +1.6% | ok, 3 of 3 |
| `graphql/document` | −3.0% … +0.8% | ok, 3 of 3 |
| `json/document` | −0.7% … +0.7% | ok, 3 of 3 |

Green on every row on every run. Two of the three runs read the less/* rows as an
**improvement** (−5.0% … −0.3% median, winning 8–11 of 12 pairs), which is the
expected sign: 0.35.0 shipped the regression and the dedup removes it. The third
run read them flat-to-slightly-positive without breaching — the honest reading of
that is that a 4-6% repayment is close enough to this gate's floor that it shows
up as "not slower" rather than as a clean win.

### What it does NOT catch — read this before trusting a green

- **Below roughly 1.5–2% per workload it reads green.** That is the sign test's
  percentage floor. There is no amplification here to buy resolution with: unlike
  the sweep, these are end-to-end parses of realistic input, so a reading IS the
  downstream cost rather than a multiple of it. The flip side is that a number
  here needs no translation.

- **A regression that shows up in only half the passes reads green.** That is the
  direct, deliberate cost of the majority rule, bought to stop false failures on
  a shared runner. A gate that false-fails gets ignored, and then the real
  failures get ignored with it.

- **It cannot attribute.** It says "less/* got 20% slower". It does not say why.
  That is `perf:guard:grammars`' job, and the two are meant to be read together.

- **The corpora are repeated, not 50 KB of unique source.** The construct mix is
  what the measurement depends on and that comes from the hand-authored corpus,
  but the repetition means branch predictors and inline caches see more regular
  input than a real 50 KB file would. A regression that only appears on genuinely
  irregular input would be understated.

- **Five workloads is five shapes.** Nothing here parses a template language, a
  programming language with real operator precedence, or anything with heavy
  `expect`/recovery use. A regression confined to those is invisible. Adding a
  workload is an entry in `buildWorkloads()`; adding one is cheaper than the
  release that finds it for you.

- **The vendored Less grammar is a benchmark, not a conformance corpus.** It
  asserts that both sides parse identically. It says nothing about whether that
  parse is correct.

- **This gate is single-process and multi-workload too, and it has not been
  audited for the interference documented in
  [perf-harness-interleaving.md](./perf-harness-interleaving.md).** One
  observation: a workload measured clean under `--only=css` and breached when
  run alongside the other four. That is a question, not a finding — there is no
  control behind it, and the pairing rule already exists because these workloads
  disturb each other through GC. Stated so nobody has to rediscover it.

- **A workload can be realistic and still structurally blind.** The first draft of
  `bench/workloads/less.ts` routed every value alternative through a named rule,
  which is a perfectly reasonable way to write a grammar — and it read FLAT on the
  `fix(expect)` replay, because a rule reference is a function boundary and the
  enclosing choice never sees the widened set. Same dialect, same vocabulary, same
  input, opposite answer, from nothing but where the rule boundaries were drawn.
  `bench/workloads/fxprobe.ts` measures that exposure directly; re-run it when the
  grammar changes, and do not assume a flat reading means a flat cost.

## Running them

```sh
pnpm perf:guard:grammars                    # the sweep gate
pnpm perf:workloads                         # the broad gate
pnpm perf:workloads --quick                 # 1 pass x 2 rounds — TRIAGE ONLY, does not gate
pnpm perf:workloads --only=less             # substring filter on workload id
pnpm perf:workloads:describe                # what each workload parses, and whether it reaches EOF
pnpm perf:guard:grammars --quick            # 2 rounds x 1 run — TRIAGE ONLY, does not gate

# Validate the gate itself. A gate nobody has watched fail is not known to work.
pnpm perf:guard:grammars --ref=7f1ddcd --head-ref=c7780e4   # 0.34.0 without the fix — expect RED
pnpm perf:guard:grammars --ref=7f1ddcd --head-ref=fdf4e90   # 0.34.0 with the fix    — expect GREEN
pnpm perf:guard:grammars --ref=<sha> --head-ref=<same sha>  # the noise floor

# Confirm a suspected regression ACROSS PROCESSES before believing it. Not a
# gate — see docs/design/perf-harness-interleaving.md.
pnpm perf:xproc --ref=<sha> --head-ref=<sha> --case=expected/narrow

# Same for the broad gate. `replay.sh` runs each five times, because one run is
# not evidence at this noise floor.
bench/workloads/replay.sh 3175734 fbeb43e 5 --allow-parse-diff   # fix(not)    — expect RED
bench/workloads/replay.sh 9c6fee2 a464372 5                      # fix(expect) — expect RED
pnpm perf:workloads --self                                       # the noise floor
```

The reference shas live in `bench/grammar-density/config.json` and
`bench/workloads/config.json`. Bump BOTH to the
released sha **at every release, in the release PR**, with the numbers read in
that PR — an unbumped reference slowly turns into an archaeology exercise, and a
silently bumped one erases whatever it was hiding.

A missing reference commit is a **hard failure**, never a skip: CI checks out
with `fetch-depth: 0` so the pinned sha is present, and if it is not, the gate
says so and exits non-zero. "The gate did not run" must never render as green —
and the `test` aggregate treats a SKIPPED perf job as a failure for the same
reason, unless `changes` said the PR was documentation-only.

## When it fires

Do not widen the threshold to make a build pass. Either fix the regression, or
land it with the number visible and an explanation of why it is the price of
something. An honest "3% is the cost of correctness, 22% was avoidable" is a
result. "Should be faster now" is not.
