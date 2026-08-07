# The labelled-trivia scanner fix is a NULL, and that is the finding

**Change measured:** `bccc32f` against `6bc265f`, one file
(`src/combinators/trivia-skip.ts`).

**Protocol.** `bench/jess/fixture.ts`, one directory, git-toggled by SHA between
legs, 3 interleaved base/fix rounds × 2 dialects = 12 legs. Each leg waits for
the 1-minute load average to fall back under 4 before it starts — `fixture.ts` is
itself heavy enough to push the average over its own ceiling of 6, so
back-to-back invocation produces one clean leg and eleven `DEFERRED`s. No leg was
`PM_FORCE`d. Every leg reported three-way agreement YES.

## The result

Median per leg; `base-spread` is the max/min ratio across the BASE readings
alone, which is the floor an A/B across separate processes has to clear.

| fixture / engine | base | fix | delta | base-spread |
|---|---|---|---:|---:|
| benchmark.css / assembler | 12.40 12.57 13.08 | 12.55 12.19 12.58 | −0.2% | 5.5% |
| benchmark.css / interpreter | 20.79 21.05 20.77 20.88 21.52 21.31 | 20.37 20.37 20.45 20.44 20.64 20.76 | −2.1% | 3.6% |
| benchmark.less / assembler | 33.48 34.30 33.79 | 34.04 34.17 | +0.7% | 2.4% |
| benchmark.less / interpreter | 54.63 56.65 56.08 56.85 55.35 56.93 | 55.64 56.67 55.67 58.44 | −0.7% | 4.2% |
| gen-workload.less / assembler | 101.14 103.13 101.86 | 102.58 103.68 | +0.7% | 2.0% |
| gen-workload.less / interpreter | 162.55 163.13 164.78 164.07 164.82 165.86 | 164.29 164.41 167.16 168.05 | +0.2% | 2.0% |

**Every delta is inside its own base-to-base spread, and the signs are
inconsistent across dialects.** This is a null.

Worth recording how it looked before the third round: at 10 legs the css
assembler read −3.0% and looked like a small win. The third base reading (13.08)
widened the base spread to 5.5% and the delta collapsed to −0.2%. An A/B stopped
at two rounds would have published a 3% improvement that does not exist.

## Why the null is the interesting part

The fix is not inert. It changes `triviaScanLowered` from
`[false,false,false,false]` to `[true,true,true,true]` for every dialect, which
means every trivia gap in the parse stops going through the per-character
labelled classifier (`src/cst/trivia-charscan.ts`) and starts going through a
fused scanner. That is verified in the emitted table, not inferred.

The parse does not measurably move. Therefore **trivia scanning was not 28% of
parse time**, and the coarse-interval self-time attribution that produced that
figure is wrong by more than an order of magnitude. This is the failure mode the
lane brief itself warned about: sampled self-time over-credits frequent cheap
frames, and a sampled css GC row had already been caught reading 2.5× high
against `--trace-gc`.

## What the change is still worth

It is a correctness fix and should land on that basis alone, with no perf claim:

- `regexTriviaScanner` required `_def.tag === 'regex'` and declined
  `label(name, regex)` on the **wrapper**, though every arm body was already a
  plain regex — `encode.ts:288` reads them back out as `[label, source, flags]`.
- Identity: 4 dialects × 4 variants × both engines = 32 legs, 2837 corpus files
  per engine-leg, all six digest facets including `expected` and `rootTrivia` —
  all identical. Plus `capoff-kinds-identity.ts` for the kinds-observable branch
  the sweep structurally cannot reach. Plus 193/193 test files.
- Allocation, `--trace-gc`: css 34.68 → 34.29 MB/parse; less 64.48 → 64.56.
  Not an allocation fix either.

## Two harness facts established on the way, both load-bearing for other lanes

**1. `fixture.ts`'s columns are mislabelled.** The "codegen" column is the
pm-macro leg, which resolves `parseman/table` through `bench/jess/hooks.mjs:75`
to `src/table/index.ts:28` — `export { assembledRules as tableRules, … }` — i.e.
the shipped ASSEMBLER. The "table" column is a direct `src/table/exec.ts` import,
i.e. the reference INTERPRETER, which `src/table/index.ts:24-26` states is "not
on the product path". `src/compiler/codegen.ts` was deleted in `37c57b5`. So
`tableRules` names two different engines depending on the import path, with the
same type signature. Found by `lane/linker-engine`; recommended as a separate
follow-up rather than landed here, because changing those column names changes
what every published figure in this release cycle means.

**2. `fixture.ts` shows no `interleave()` order effect.** Its 21 `CONTROL
table/table` rows across these 12 legs span −1.5% to +1.9%, centred on zero.
`g5-ms.ts` reports +12-15% on the same shared `ab-harness.ts`, so the cause is
that file's contest wiring rather than the shared harness.

## What is NOT established

The 24% disagreement between this harness's assembler leg (33.5-34.3 ms on
`benchmark.less`) and `g5-ms.ts`'s (27.3 ms) is **unexplained**. An earlier draft
of this note blamed the composition tax; that is wrong, and this run's own data
refutes it. `fixture.ts` re-runs each fixture with the interpreter leg dropped,
and the assembler moved **−1.5% on css and +7.0% on less** — not −24%, and not
consistently in either direction. `fixture.ts:277-281` says the same thing
directly: dropping the interpreter leg moved *the table* by 18% *"while codegen
did not move at all"*.

The live hypothesis is that the two harnesses build different artifacts —
`fixture.ts` measures the macro-fused shipping module, `g5-ms.ts` measures
`assembledRules` over the interpreted fuse's realised rule map — and that the
legs which agree (both `exec`, both from `encodeTable`) are the identically-built
ones. Untested here.

Consequently the circulating **2.0-2.3×** table-vs-codegen figure is
**unexamined**, not refuted and not corroborated. The 1.61-1.63× this harness
prints is a ratio between two mislabelled columns and should not be quoted
against it.
