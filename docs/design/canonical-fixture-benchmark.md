# The canonical fixture benchmark — `pnpm bench:less`

> ## ⚠ THE COLUMN NAMES ON THIS PAGE ARE WRONG. THE NUMBERS ARE REAL.
>
> Every `codegen` and `table` column below was taken from `bench/jess/fixture.ts`
> under labels that named the wrong engines. Corrected:
>
> | printed as | is actually |
> | --- | --- |
> | `codegen` | **`assembled (shipped)`** — the `pm-macro:` artifact, which imports `tableRules` from `parseman/table` — the shipped engine, declared in `src/table/assemble.ts`. `src/compiler/codegen.ts` was **deleted in `37c57b5`**; no harness has measured a source lowering since. |
> | `table` | **`exec (reference)`** — `execRules(encodeTable(…))`, the reference bytecode INTERPRETER. Nothing ships on it. |
> | `interpreter` | unchanged — the combinator graph. |
>
> The cause: `src/table/exec.ts` and `parseman/table` both exported a function
> called `tableRules`, with the same signature. The import path was the only
> thing selecting an engine, and it type-checked either way. The reference
> export is now `execRules`, `bench/jess/fixture.ts` prints the corrected names,
> and `scripts/check-invariants.mjs` **INV-11** fails any specifier that lets one
> engine answer to the other's name.
>
> **What this does and does not invalidate.** The measurements are sound: the
> harness timed exactly what it built, and the composition, batching and load
> findings below are properties of the instrument, not of the engine labels — they
> stand. What does NOT stand is any reading of a `codegen` vs `table` ratio as
> "source lowering vs table lowering". It was never that. It is assembler vs
> reference interpreter, and **that comparison is not the one this project cares
> about** — the reference interpreter is a bisection oracle, not a shipping
> alternative. Re-taking these figures under the corrected legs is an owner call
> and has not been done here.

The table lowering's target is stated in **absolute milliseconds** against a
named fixture. This page is how that number is taken, and it exists because the
same fixture had two remembered baselines **27% apart**:

| lane | codegen | table | interpreter | control | loadavg |
| --- | --- | --- | --- | --- | --- |
| A | 17.41 ms | 46.86 ms | 99.68 ms | ±1.2% | quiet |
| B | 22.17 ms | 49.72 ms | 111.33 ms | +3.9% | **7.0** |

The ratios agreed (2.69× vs 2.24×). The absolutes did not, and the target is an
absolute — so a lane reporting "23 ms" could not be told from a lane reporting
"17 ms" on a slower box.

## The cause: **two different harnesses, and composition is a first-order term**

The two figures did not come from the same instrument.

- Lane A ran `bench/jess/fixture.ts` (`pnpm fixture:jess`). Three legs: codegen
  via `pm-macro:`, table, interpreter, plus a table/table control. One parse per
  sample.
- Lane B ran **`bench/jess/table-less-ms.ts`**, its own harness on branch
  `diag/table-penalty-attribution`. **Four** legs: codegen via `compose()`,
  `table-` (`leafSwap: false`), `table`, interpreter, plus a compose/compose
  control. `targetSampleMs: 60`, so ≈3 parses batched per sample.

That is not a cosmetic difference. Every leg lives in **one heap**, by design —
`bench/ab-harness.ts` interleaves them precisely so they share GC state, cache
state and run position. The consequence nobody had priced: **a leg that
allocates heavily taxes its neighbours' samples**, so the *set of legs in the
run* is itself an input to the absolute milliseconds.

Measured on this branch, `benchmark.less`, two shapes back-to-back in one
process, control ±0.5%:

| run shape | codegen | table | ratio |
| --- | --- | --- | --- |
| codegen + table + control (2 legs) | 17.11 ms | **38.80 ms** | 2.27× |
| … + interpreter (3 legs, the pinned shape) | 16.38 ms | **45.92 ms** | 2.80× |

**One extra leg moved the table 18%, and left codegen alone.** The interpreter
allocates ~6× what the table does per parse; the table is the allocation-heavier
of the two survivors, so it absorbs the garbage.

Two smaller terms, both measured, both pointing the way the composition finding
predicts:

- **Sample batching.** reps=3 (lane B's shape) reads **+6.7%** slower per parse
  than reps=1 (lane A's), macro codegen 18.88 vs 17.69 ms.
- **The codegen leg itself.** `compose()` — runtime fusion of the combinator
  graph, lane B's leg — is **10% FASTER** than `pm-macro:` build-time lowering,
  15.94 vs 17.69 ms. So the leg swap works *against* lane B's higher number and
  cannot be the explanation; it makes the composition and batching terms larger,
  not smaller.

**Load is real but is not the driver here.** Lane B's own commit (`85d4594`)
records codegen at **22.17 → 22.22 ms across two separate runs at loadavg 6.5** —
stable to 0.2%. A box whose load explained a 27% spread would not reproduce to
two decimal places. Lane B had in fact already reached the right conclusion and
written it down: *"ABSOLUTES ARE HARNESS-RELATIVE."* The defect was that nothing
made that impossible to ignore.

So both fixes are needed, and both landed:

1. **Composition is pinned and printed** as part of the protocol, with the
   interpreter-free figure reported alongside so the tax is visible instead of
   baked in silently.
2. **The load ceiling is shared.** It was a private `const LOAD_CEILING = 6` in
   `speed.ts` and nowhere else; `fixture.ts` — the harness that produces the
   figures people quote — printed the load average and measured anyway. It now
   lives in `bench/jess/grammars.ts` as `LOAD_CEILING` / `assertQuiet()`, so a
   ceiling guards the harness that is actually quoted.

Ruled out, so it does not get re-litigated:

- **`run()` on the measured path.** It is on the measured path, on **all three
  sides identically** — `fixture.ts` invokes every engine through `run()`. Its
  per-parse overhead is three `Object.defineProperty` calls in
  `guardRemovedFields` (`src/functional/run.ts`), a fixed cost of order a
  microsecond: ~0.01% of a 17 ms parse. The sibling lane's 36.9% is a real
  finding about *small* parses and has nothing to do with a 107 KB fixture.
- **AST vs CST, or `trackLines`.** Both runs were `hostMode: 'ast'`,
  `trackLines: false`; the harness pins them and prints them.
- **Different reducers.** Every engine in both harnesses is built from the *same*
  rules map loaded from jess's shipping grammar module.

## The protocol

The script prints this block above every run, so a pasted result carries its own
provenance. Restated here so a lane can check a number it was handed:

| | |
| --- | --- |
| fixture | a named file under jess's `packages/jess/benchmark`, read verbatim, byte size printed |
| path | `hostMode: 'ast'`, `trackLines: false` — the AST path, canonical by owner ruling |
| engines | **assembled (shipped)** (the `pm-macro:` artifact of the shipping grammar module, which imports `tableRules` from `parseman/table`, the shipped engine declared in `src/table/assemble.ts`), **exec (reference)** (`encodeTable` + `execRules` over the same rules — the bytecode INTERPRETER, which nothing ships on), **interpreter** (the combinator graph). These are TWO TABLE ENGINES plus the graph, not a source lowering versus a table: `src/compiler/codegen.ts` was deleted in `37c57b5`. The in-harness proof is a SHAPE check only — assembled must be a function, interpreter must not be — and it cannot distinguish the two table engines, which is why they are imported under distinct names and gated by INV-11. |
| entry | every engine invoked through `run()`, identically, so `run()`'s own cost cannot favour one |
| process | ONE process, engines interleaved in adjacent order-alternated pairs (`bench/ab-harness.ts` `interleave`). Separate process launches on this hardware read 9.4 ms and 26 ms for the same case. |
| composition | **PINNED** at exactly three legs plus the control, in that order. Load-bearing, not a detail — the legs share one heap, so adding or removing one moves the others by ~18%. A harness with a different leg set produces different absolutes from identical code. |
| warmup | 3 parses per side before any sample is kept |
| sampling | 8 rounds × 2 runs = **16 samples per side**. ONE parse per repetition, so the reported millisecond *is* one parse; each sample is itself the median of 5 timed repetitions. |
| statistic | **median** of the 16. Not the min, not the mean. |
| control | an in-run **table-vs-table** contest — two independently built instances of the same engine. Its delta is the run's noise floor. |
| load ceiling | **refused above a 1-minute load average of 6.** `PM_FORCE=1` overrides and marks every figure `FORCED`. |
| provenance | parseman version + short HEAD sha (`+dirty(src)` if `src/` is modified), node version, platform/arch, cpu count, loadavg at START **and** END |

**A figure is quotable only with that block.** A gap smaller than the control is
not a result in either direction, and a run whose END load is far off its START
load measured a moving box, ceiling or no ceiling.

## The command

```
pnpm bench:less
```

`less` dialect, both canonical less fixtures. `pnpm fixture:jess <dialect>` is
the same harness aimed elsewhere.

## Never a second harness

This is an extension of `bench/jess/fixture.ts`, which is itself built on
`bench/ab-harness.ts` `interleave`. **Do not write another one.**

That is not style advice. A rival harness measuring something slightly different
is worse than no number at all, and the measurement above is why: run composition
alone is worth 18%, so two harnesses with different leg sets report different
absolute milliseconds *for identical code* — and neither one is wrong, so no
amount of care in either lane reconciles them. `bench/jess/table-less-ms.ts` is
the harness that produced the second baseline; whatever a lane needs, add it here
so every lane's output changes with it.

A diagnostic that answers one question and is deleted is fine. A second harness
that anyone quotes a millisecond from is not.

## `benchmark.less` is an assembled-outlier, and a timing fixture only

The reference interpreter and the combinator graph agree on `benchmark.less`;
the **shipped assembler** is the odd one out — note that this makes the outlier
the engine that actually ships, which is the more serious reading of the same
observation — on the `value` and `span` facets. The harness reports
that, names the facets, and times it anyway — it is the fixture that gets asked
about by name, and "not measured" is a worse answer than a measured number with
its caveat attached.

The caveat now carries a **magnitude**: the harness prints each engine's node
count and serialized size, and the count of minimal differing subtrees. A caveat
without one licenses reading the whole gap as an artefact of the divergence, or
none of it.

`benchmark.less` is exempt from byte-identity by standing rule. Nothing here
compares its tree to an expected output; it is a timing fixture.

## Do not optimise into one file

Always read the second fixture. The penalty tracks which constructs a file
exercises, **not its size**: `gen-workload.less` (275 KB) and `benchmark.less`
(107 KB) are the same dialect and do not sit at the same ratio. `pnpm bench:less`
prints both, in that order, for that reason.
