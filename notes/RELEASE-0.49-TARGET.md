# 0.49 release target — close the remaining canonical-TableProgram gap

## Objective

0.49 owns the performance work explicitly carried forward from 0.48. It must bring the
production-shaped CSS, benchmark Less, and generated Less fixtures to parity with or
faster than pinned Parseman 0.46 without restoring a direct-source parser or splitting
the runtime into parallel semantic engines.

This is not permission to lower the baseline. The reference remains
`a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3`, with literal full consumption,
complete result-facet identity, independent two-graph compilation, paired interleaving,
same-source A/A controls, printed engine/source realpaths, and a quiet-host load gate.

## Accepted 0.48 starting point

The retained 0.48 checkpoint is
`77cd124e13ce326e001d38fa24e5239bb24f9498`. One clean Node 24.11.1 bracket on exact
Jess `f3b4c3fa1917bc2a1b4e5bd7f0e4b7992b64a002` measured:

| workload | 0.48 | pinned 0.46 | raw ratio | approximate A/A-adjusted ratio | absolute deficit |
| --- | ---: | ---: | ---: | ---: | ---: |
| CSS `benchmark.css` | 6.34 ms | 5.26 ms | 1.177x | 1.19x | 1.08 ms |
| Less `benchmark.less` | 17.92 ms | 15.76 ms | 1.122x | 1.12x | 2.16 ms |
| generated Less | 46.75 ms | 45.93 ms | 1.027x | 1.03x | 0.82 ms |

These are the accepted 0.48 release numbers, not a five-pass parity result. 0.49 must
run the full five-pass bracket on its final integrated SHA before claiming closure.

The broad `perf:workloads:peak` guard has a different job and a different corpus. Its
seeded 0.45 record measured the accepted 0.48 runtime roughly 98–249% slower across
Less, CSS, GraphQL, and JSON. 0.48 therefore resets that operational guard to
`bf03092`; future PRs must not regress more than 5% from the released TableProgram
runtime. That reset does **not** lower this document's pinned-0.46 Jess target. The
historical broad-workload drawdowns remain quoted in the 0.48 changelog, while 0.49
still owns the 1.19x / 1.12x / 1.03x production-shaped gaps above.

## Constraints inherited from 0.48

- One compact `TableProgram` remains the serialized semantic authority.
- Assembly-time body selection is allowed; a second source parser, parse-time generic
  IR interpreter, per-site factory inventory, and multi-megabyte grammar expansion are
  not.
- Runtime compile, macro, compose/fuse, rule-map/linkable, folded, closure, emitted,
  precompiled, reference, CST, tolerant, probe, coverage, and line-tracked variants
  remain semantically aligned.
- The ESM-only package topology and synchronous `require(esm)` Node floor remain.
- Package growth is judged against measured payoff; a few kilobytes are not a blocker
  for a material common win.
- Ordinary supported contexts must remain correct. Proxy trap-sequence compatibility
  is not an optimization requirement.
- Every differential or timing harness must be deliberately shown RED before its green
  result is evidence.

## Starting frontier

The final 0.48 profile is distributed rather than dominated by one helper. The retained
node/capture projections already cover almost every sampled NODE body; generated Less
is within one ordinary tranche, while CSS is the critical shelf. 0.49 should begin with
fresh final-SHA CPU/allocation profiles and admit only mechanisms that remove real work
across CSS and both Less fixtures.

Do not repeat the closed 0.48 mechanisms as parameter tuning: the rejected direct-source
backend, generic region fusion, owned-context mirror/projection, expected-set shortcuts,
trivia result-shape/binding variants, leaf-publication duplication, positive-width
sequence metadata, singleton choice switches, empty-key dispatch lookup, repeat
dead-branch cleanup, or BMP-only `lead()` conversion. Their RED proofs and timings live
in the frozen 0.48 experiment ledger.

The first 0.49 design checkpoint should therefore explain a broader canonical body
projection or work-removal mechanism, show a credible ceiling against the 1.08/2.16/
0.82 ms deficits above, and preserve the architecture before implementation timing.

## Release gates

0.49 is complete only when:

- all three production-shaped fixtures are at or below 1.00x pinned 0.46 after the
  five-pass A/A adjustment;
- Jess CSS/Less corpora fully consume and match all result facets across supported
  engines and artifact variants;
- supported Node, CSP, type, lint, invariant, strict differential, coverage, full test,
  build, package, docs, size, and external comparison-margin gates pass on the final
  integrated SHA;
- the package and generated artifacts remain within explicitly reported size bounds;
- no accepted mechanism creates a parallel parser implementation.
