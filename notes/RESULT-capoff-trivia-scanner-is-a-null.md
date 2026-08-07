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

## The cross-harness gap — RESOLVED, and it is not a harness fault

This section previously read "unexplained". `lane/linker-engine` settled it in
`249cbd9`, and the answer is that **neither harness was wrong: they measure
different artifacts.**

- `g5-ms.ts` measures `tableRules` over the **interpreted fuse's** realised
  rule map (`grammars.ts:75-85`).
- `fixture.ts` measures the **macro-fused shipping artifact** (`import('pm-macro:…')`).

Both built in one process, same grammar, same 278 rules, identical tree, identical
106802 bytes consumed, `benchmark.less`:

| leg | run 1 | run 2 |
|---|---:|---:|
| `assembled` (interpreted fuse) | 28.03 ms | 27.65 ms |
| macro artifact (SHIPPED) | 36.05 ms | 35.91 ms |
| ratio | 1.286× | 1.299× |
| macro wins | 0/16 | 0/16 |
| CONTROL assembled/assembled | 1.8% | −0.1% |

So the shipping artifact is ~29% slower than the same engine over the interpreted
fuse. That is why this file's assembler leg reads 33.5-34.3 ms where `g5-ms.ts`
reads 27.3 — and it is a real defect on the path every consumer ships, not a
measurement artefact.

An earlier draft of this note blamed the composition tax for the gap. **That was
wrong and this run's own data refutes it**: `fixture.ts` re-runs each fixture with
the interpreter leg dropped, and the assembler moved −1.5% on css and +7.0% on
less — not −24%, and not consistently signed. `fixture.ts:277-281` says it
directly: dropping the interpreter leg moved *the table* by 18% *"while codegen
did not move at all"*.

The circulating **2.0-2.3×** table-vs-codegen figure remains **unexamined** —
neither refuted nor corroborated. The 1.61-1.63× this harness prints is a ratio
between two mislabelled columns and must not be quoted against it.
