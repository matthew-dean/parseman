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

Exit code is **0 when Parséman is fastest in every measured comparison, 1 when it
is not**, so it can be used as a gate directly. `JSON.parse (native)` is excluded
from that verdict — it is C++ inside the engine, not a JS parser generator.

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
- **CONTROL** — an A/A pair. `parseman-macro` is measured a **second** time each
  round, in its own process, under a separate slot. It should read ~1.00× with a
  win-rate near 50%. It is measured in the **same run** as everything else, so it
  prices *that run's* noise floor rather than a remembered one.

**Read the control before you read anything else.** If the control reads 1.15×,
the run cannot resolve a 15% margin change and you should re-run on a quieter
box — not report the number. A margin smaller than the control's spread is not a
margin.

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
