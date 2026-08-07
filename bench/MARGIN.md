# The comparison-chart margin, and how to check your change against it

**The bar, in the owner's words:** *"Still fastest (compiled) JS parser in the SVG
tests (not the incremental parsing one, the other ones)."*

That is the whole gate. It is a **rank** bar, not a speed bar. Parséman getting
slower than a previous Parséman is **explicitly acceptable** provided it stays
fastest in these comparisons, and a small startup cost is fine. What is not
acceptable is a competitor overtaking it in any bar of `assets/bench-*.svg`.

So the number that matters when you are weighing a size/speed trade is not "how
much did I lose" — it is **"how much headroom was there"**. Losing 8% of a 3.6×
margin is nothing. Losing 8% of a 1.1× margin is the whole gate.

## Run it

```sh
pnpm bench:margin                                   # 3 rounds, all four charts
pnpm bench:margin -- --rounds 5                     # tighter, ~2× the time
pnpm bench:margin -- --charts graphql               # just the chart you moved
pnpm bench:margin -- --rounds 5 --out /tmp/mine.json
```

Exit codes:

| code | verdict | meaning |
| --- | --- | --- |
| 0 | **BAR HELD** | Parséman leads every competitor, in every group, by at least the floor |
| 1 | **BAR BROKEN** | some competitor is within the floor — or ahead |
| 2 | **INDETERMINATE** | the run could not resolve its own claim; see *self-calibration* below |

**Exit 2 is not a pass.** A gate that only distinguishes "good" from "bad" will
report "good" when it is simply blind, which is how most of a benchmark's life is
actually spent. Treat 2 as "re-run it", never as "it was fine".

### The floor

The verdict is not `ratio >= 1`. It is `ratio >= MIN_MARGIN`, currently **1.05×**,
applied to every competitor in every group of every chart.

That constant is **absolute and deliberately loose**, and it is set from the
*harness's resolution*, not from today's margin. The bar is a rank bar — a
Parséman that got slower is fine as long as it stays in front — so pinning the
floor near the currently-measured 1.79× would silently convert it into the
differential gate this is explicitly not. 1.05× is just "a lead this instrument
can tell apart from a tie" (see the interpretation table below).

**Changing `MIN_MARGIN` is an owner decision**, on the same footing as a perf
rebaseline. Do not move it to make a lane green.

### Excluded from the verdict (measured and printed anyway)

| bar | why it cannot break the bar |
| --- | --- |
| `JSON.parse (native)` | C++ inside the engine, not a JS parser generator |
| `parseman-interp` | Parséman's own interpreter build — not a competitor |

The interpreter used to count as a competitor, which meant a build where the
interpreter happened to beat the runtime-compiled table artifact would report the bar BROKEN. That is
a false failure, not a rank loss.

### Artifact evidence

Every run prints, before any timing, the **resolved path and version of every
artifact it measured** — Parséman's own version and commit SHA (and a loud
warning if the worktree is dirty), each competitor package's version and resolved
directory, and for Peggy/Nearley/Jison the **sha256 and mtime of the generated
parser that actually ran**, because those bars execute a checked-in generated
file rather than the generator. A stale generated parser and a current one
produce equally plausible tables; only the hash tells them apart.

If a measured artifact is missing from disk, the run aborts instead of reporting.
If a bar is charted but has no provenance entry, the run aborts too — an
unmeasured bar must not read as "covered everything".

A full 3-round run over all four charts takes roughly 15–20 minutes and spawns
~90 child processes. **Do not run anything else on the box while it runs**, and
do not run two of them concurrently — they will contaminate each other, and the
contamination is uneven across bars, which is exactly the bias the chart harness
was rebuilt to remove.

## What it reports, and why not a median

`bench:svg` renders the published pictures and reduces each bar to a **median**
over rounds, discarding the per-round samples. That is right for a picture and
wrong for a gate: a median cannot distinguish a real 4% regression from this
box's noise. `bench:margin` keeps every round and reports three things.

- **min** — the fastest observed µs. Every sample is the true cost *plus*
  interference, so the distribution has a hard floor and a long right tail. The
  minimum is the closest available estimate of the underlying cost, and it is
  what the harness leads with. A median drifts when the machine gets busier; the
  min largely does not.
- **win-rate** — of R rounds, how many did Parséman win? Rounds are **paired**:
  within a round the two bars are measured seconds apart under the same machine
  conditions. That makes this a sign test over paired samples, and it survives
  drift that would swamp a ratio of independent means.
- **CONTROL** — an A/A pair. `parseman-runtime` is measured a **second** time each
  round, in its own process, under a separate slot. It should read ~1.00× with a
  win-rate near 50%. It is measured in the **same run** as everything else, so it
  prices *that run's* noise floor rather than a remembered one.

**The control is enforced, not advisory.** A margin smaller than the control's
spread is not a margin, and the harness now acts on that itself rather than
leaving it to whoever reads the table:

- control spread ≥ the tightest claimed margin → **exit 2**, INDETERMINATE
- control spread ≥ the floor → **exit 2**, because a run that loose could not
  have *failed* a borderline case either, so a pass from it would be unearned

This is the part that was missing. The control was measured and printed from the
start, and the exit code ignored it — so a run whose A/A pair disagreed by 250%
still reported the bar HELD, on ratios that were mostly noise. Verified: at
`--rounds 1` on this box the control reads **+257%**, and the gate now returns 2
where it previously returned 0.

If you want to watch it fail on demand, `--assert-floor <N>` overrides the floor
for one run. `--assert-floor 1000` demands a 1000× lead, which nothing has, so a
healthy harness must report BROKEN. It does not change `MIN_MARGIN`, and every
run that uses it is stamped as a verification run in the banner, in DROPPED, and
in the verdict.

The measurement protocol underneath is deliberately **identical** to the
published charts': same `bench/measure-bar.ts` child, one process per bar, same
rotated sweep order. See the comments in `bench/collect-charts.ts` for why both
of those are load-bearing — measuring all bars in one process inflated Parséman's
compiled GraphQL by ~60%, and inflated each library by a *different* amount.

## Interpreting your result

| Control reads | You can trust a claimed change of |
| --- | --- |
| ≤ 1.02× | ~5% and up |
| 1.02–1.05× | ~10% and up |
| > 1.05× | re-run; report nothing below ~20% |

If a competitor's ratio drops toward 1.0× in any row, that row is the gate and
your change needs a number on both sides before it lands, not after.

## The margin as of `f78bc9b` (0.46.0, pre-lane)

3 rounds, rotated, one process per bar. Every in-run control read 0.98–1.03×, so
the noise floor for this run was ~±3%; every competitor row won 3/3 paired
rounds. Ratios are `competitor_min / parseman_macro_min` — how many times faster
Parséman is.

| workload | Chevrotain | Lezer | Peggy | Jison | Parsimmon | Nearley | pm interp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| JSON small | **1.79×** | — | 4.64× | 11.7× | 10.7× | 12.7× | 2.65× |
| JSON medium | **1.91×** | — | 4.36× | 13.0× | 12.0× | 19.4× | 2.74× |
| JSON large | **1.98×** | — | 3.86× | 13.5× | 11.7× | 20.6× | 2.97× |
| CSV small | 13.4× | — | 5.21× | — | 8.91× | 19.7× | 3.64× |
| CSV large | 13.5× | — | 5.96× | — | 5.69× | 36.9× | 3.30× |
| GraphQL small | **2.64×** | — | 2.81× | 8.25× | 13.9× | 8.02× | 2.70× |
| GraphQL medium | **2.22×** | — | 2.80× | 7.33× | 10.1× | 7.35× | 2.49× |
| GraphQL large | **2.44×** | — | 2.77× | 9.42× | 11.5× | 10.5× | 2.66× |
| CST small | 11.4× | 3.60× | — | — | — | — | 3.32× |
| CST medium | 11.7× | 3.51× | — | — | — | — | 3.75× |
| CST large | 11.4× | 3.66× | — | — | — | — | 3.10× |

**The binding constraint is Chevrotain on JSON, and it is the only bar under 2×.**
JSON small at **1.79×** is the tightest row in the whole set: a change that costs
Parséman 44% on small-JSON parse loses the gate outright. GraphQL-vs-Chevrotain
(2.22–2.64×) is second. Everything else has 3.3× or more of headroom, and CSV and
CST are not close to contested.

For reference, `JSON.parse` (native C++, excluded from the bar) is 3–4× faster
than Parséman on the same inputs — 0.169 µs vs 0.554 µs on small JSON.

## What these charts CANNOT read

The four charts run four grammars: `examples/json`, `examples/csv`,
`examples/graphql`, and the JSON CST build. A change that does not reach those
grammars will read as a flat null here, and a null here is **not** evidence the
change is free.

The sharpest current example is `dispatch()`. Grep the repo: no chart grammar
uses it. The only benchmark that exercises `dispatch()` at all is the
`pnpm bench:dispatch` microbenchmark (`bench/dispatch-vs-choice.ts`). So a
dispatch-codegen change is invisible to `bench:margin` *by construction*, and
also to `pnpm perf:workloads` — its Less workload mentions dispatch only in a
comment. If your change targets `dispatch()`, say which harness read it; the
charts did not.

Before trusting a null from this harness, check that your change is on a path
one of the four chart grammars actually takes.
