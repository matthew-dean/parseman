# `examples/css`: interpreter and compiled disagree on `trivia.entries`

Status: CONFIRMED, unfixed, **pre-existing on `origin/release/0.47.0`** (`f2b0e44`).
Not caused by, and not fixed by, `lane/disjoint-fix`.

Found inside the CONTROL run of that lane's rejected-input probe
(`scratchpad/leftfactor/rejected-payload.ts`), which is why it is filed separately —
it would otherwise stay buried as a residual in someone else's report.

## What happens

`examples/css/parser.ts` exposes `parseCss` (interpreted) and `parseCssCompiled`. Over a
real CSS corpus they return the same tree and the same errors, but a different
`trivia.entries` count:

    extend-exact.css @44B   root.trivia.entries: 0 VS 3
    extend-exact.css @55B   root.trivia.entries: 0 VS 4
    extend-exact.css @66B   root.trivia.entries: 0 VS 6
    extend-exact.css @77B   root.trivia.entries: 0 VS 8
    extend-exact.css @88B   root.trivia.entries: 0 VS 9

Interpreted reports 0; compiled reports a growing count. The parse TREE agrees — only
the trivia bookkeeping diverges.

## Scale

Corpus: 110 real `.css` files. 18,602 derived inputs (truncations at ~40 boundaries per
file, plus single-character corruptions with `{ } ( ) " ' ; : @ \`), of which 15,546 are
rejected.

    mismatched 8,966 of 18,602   (48%)

Identical count on clean `origin/release/0.47.0` and with `lane/disjoint-fix` applied,
which is what establishes it as pre-existing.

## Likely cause, not yet confirmed

`test/parity/helpers/engine-parity.ts` documents a legitimate asymmetry in this area: a
compile whose grammar contains no `node()` emits NO capture code at all, while the
interpreter captures whenever the ctx carries the sinks. `examples/css` builds its own
trivia summary via `buildLazyTriviaMap` in `stub-build.ts` rather than going through
that helper, so it does not get the helper's normalization.

That makes the most likely reading "the example's harness, not the engines". It is NOT
confirmed, and the alternative — a real trivia-log divergence that the parity suite
does not reach because no fixture drives `examples/css` this way — is the one worth
ruling out, because that would be an engine defect.

## Why it matters even if it is only the example

`examples/css` is a size-guard fixture and a perf-guard workload, and it is the grammar
this repo reaches for when demonstrating the compiler. A 48% whole-result divergence
between its two engines is either a real defect or a misleading demo, and both deserve
closing.

## Reproduce

    npx tsx scratchpad/leftfactor/rejected-payload.ts

on `lane/disjoint-fix`. The probe asserts the DELTA against a control constant rather
than an absolute, so it stays green while this defect is open — see its header.
