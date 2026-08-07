# FINDING: the three `trackLines` divergence figures are not in conflict — they have different denominators

Lane `exp/cliff`. **No measurement was run for this.** It is a provenance trace plus an
arithmetic consistency check, done entirely by reading, while the timing floor was held.
Everything below was verified by me directly, not taken from a subagent's summary.

## The situation as handed to me

Three figures for "what fraction of piece bodies change under `trackLines`":

| figure | source as relayed |
|---|---|
| 16–21% | relayed by the coordinator, provenance lost, treated as dead |
| 66.3% / 48.6% | design lane, two toy fixtures |
| 52–61% | `exp/wiring`, byte-diffing emitted assembly via `setWiring()` |

I was asked to arbitrate. The useful contribution turned out not to be a fourth number.

## The 16–21% figure has a real source, and it is not measuring bodies

`/Users/matthew/git/oss/jess/docs/state/GRAMMAR-SIZE-FACTS.md:1177-1185`, quoted verbatim:

> **The duplication is available**: the four bodies are **77–82% line-identical**
> after normalising generated variable numbering.

| variant | bytes | shared with `ast` |
| --- | ---: | ---: |
| ast | 63,965 | — |
| ast + trackLines | 68,392 | **82.3%** |
| cst | 68,120 | 82.5% |
| cst + trackLines | 72,539 | 77.3% |

The `trackLines` row is **82.3% line-identical ⇒ 17.7% of LINES differ**. That sits
squarely inside the relayed 16–21% band, and the band's width matches the 77.3–82.5%
spread across the other variants.

**So the denominator of 16–21% is LINES, not bodies.** The design lane's and
`exp/wiring`'s figures count **BODIES** — a body is divergent if *any* line in it
differs. Those measure different things, and the body figure must be the larger of the
two for any artifact with more than one line per body.

## Consistency check

If divergent lines were spread evenly across bodies at rate p = 0.177, the fraction of
bodies containing at least one divergent line is `1 − (1 − p)^L` for a body of L lines:

| L (lines/body) | 3 | 4 | 5 | 6 | 8 |
|---|---:|---:|---:|---:|---:|
| bodies touched | 44% | 54% | 62% | 69% | 79% |

The measured body-divergence band of **48–66%** corresponds to bodies of roughly **3.5–5.5
lines** — an entirely ordinary size for an emitted `_pf` body. The figures are not merely
compatible; they are close to what you would predict from each other.

This is a consistency check, not a proof — real divergence is clustered, not independent
per line, so the true mapping depends on how the changes distribute. It is enough to show
the three figures do not contradict each other.

## Two corrections that matter more than the reconciliation

**1. The 16–21% figure was measured on a lowering path that no longer exists.** Verified:

```
$ git log --oneline --diff-filter=D -- src/compiler/codegen.ts
37c57b5 feat!: delete the source lowering — one architecture
$ git cat-file -e HEAD:src/compiler/codegen.ts
fatal: path 'src/compiler/codegen.ts' does not exist in 'HEAD'
```

At `release/0.47.0` there is one lowering path, and emitted `_pf` bodies come from
`src/table/emit-assembly.ts`. Any `codegen.ts:NNNN` citation in either repo's notes points
at a deleted file. So 16–21% should not be carried forward *whatever* its denominator —
not because it was wrong, but because its artifact is gone.

**2. `trackLines` changes far more than the four `_TRACK` opcodes**, which is why the body
figure is as high as it is. `src/table/emit-assembly.ts:371`:

```js
const swapLegal = !cfg.trackLines
```

used at `:508` and `:938-941` to gate a trivia-scan swap resolved at emit time. So
`trackLines` (a) swaps `OP_LIT/OP_LIT_CI/OP_RX/OP_NODE` for their `_TRACK` twins, (b)
emits `_trackLines(ctx, input, e)` calls, **and** (c) disables a structural optimisation
that reshapes bodies well beyond the terminal rows. A model of "`trackLines` swaps four
opcode rows" predicts a *small* divergence and is why a low number looks plausible; (c) is
why the real body figure is half the artifact.

Also relevant to the denominator: `rules({ trackLines: true }, …)` **replaces every map
entry** with `parser({ trackLines: true }, entry)` (`src/table/encode.ts:192-193`), so
every site is inside a tracking scope — the ON leg is not partial.

## Recommendation

Stop arbitrating. Two lanes measuring **bodies** agree at 48–66%; the third figure
measures **lines**, is arithmetically consistent with them, and is obsolete regardless
because its artifact was deleted. Use the body figure, and state the denominator whenever
it is quoted — the whole disagreement was one unlabelled denominator.

I did **not** run the emit-based measurement. If it is ever wanted, the entry point is
`emitAssemblySource(t, prog, cfg, extraIps)` at `src/table/emit-assembly.ts:364`, driven
from a single `loadGrammar(dialect, 'ast')` graph with `VARIANT_SETTINGS` supplying the
ON/OFF pair (the trick `bench/jess/fold-size-one.ts:44-46` already uses to avoid the
export/settings agreement check at `src/table/encode.ts:589`). It needs `pnpm install` in
this worktree and one dialect per process. Note `notes/RELEASE-0.48-TARGET.md:571-578`
reports the `*-lines` variants cannot parse anything — static emission is fine, runtime
identity on that leg is not.
