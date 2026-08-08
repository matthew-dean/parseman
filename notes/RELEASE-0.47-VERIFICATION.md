# 0.47 release verification ledger

This file is the release claim ledger. A claim is not valid merely because it was
observed in a chat or a one-off terminal run: it must name the code, comparison,
protocol, and status below. Update the row when the final candidate changes.

## Candidate identity

| Item | Value | Status |
| --- | --- | --- |
| Remote release base | `origin/release/0.47.0` at `9c3ce450ff7cd35efc0cdc76a5f27df65a9fad2b` | pinned |
| Code candidate | `fix/0.47-audit` at `3e91d6e` | canonical `a:[]` compiler/macro/fold artifact; every public construction route is covered by the no-`Function` contract |
| 0.46 comparison base | `a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3` (`v0.46.0`) | pinned |

## Correctness and API

| Claim | Evidence | Status |
| --- | --- | --- |
| Table/interpreter/closure parity audit | Targeted matrix suite: rule-map, closure engines, commitment, scan shape, trivia skip, linker state, fields, line index, reflection, functional driver, dispatch matcher matrices | full suite passing (3,837 passed; 3 skipped; 22 todo); ordinary-host re-entry restores all assembly slots on return and throw |
| Public table API contract | Compile options, host mode, host capability, line/recovery, Unicode class, rule-map isolation regressions | passing in final suite |
| Grammar analysis reaches every authored child | Dispatch matcher arms, `routed(fallback)`, grammar trivia, and recovery sentinel traversal regressions | passing in final suite |
| Trace | Table `_grammarTrace` rejects explicitly rather than silently reporting empty data | intentional 0.48 work; documented rejection |
| V8 construction shape | `parseman/table`'s complete local import graph contains no import-time descriptor installation or `WeakMap`; table maps are born with metadata prototypes and macro metadata is never own/spread-visible | `INV-12` traverses the entry graph; a fresh built-package import spy observes zero `WeakMap` and zero `Object.defineProperty` calls; passing |

## Artifact size

| Comparison | Evidence | Result | Status |
| --- | --- | --- | --- |
| Generated grammar output | `pnpm size:guard`, 24 established fixtures versus v0.46 | Every fixture remains smaller; structural metadata/cache candidate is 8,385 raw bytes below its guard ceiling. | pass |
| Published package | `pnpm build && npm pack --dry-run --json`, v0.46 comparison | 0.47: 3,075,840 B tarball / 13,076,481 B unpacked; 0.46: 5,200,286 B / 19,958,344 B. 0.47 is 40.9% / 34.5% smaller. | pass |
| Package maps | Build maps exclude repeated `sourcesContent`; package ships `src/` once | 131 maps parse; zero missing mapped sources in package. | pass |

## Performance: never collapse these rows into one claim

| Comparison | Protocol | Observed result | Meaning | Status |
| --- | --- | --- | --- | --- |
| 0.47 table vs 0.46 on Jess/Less | Exact `82f6e8e` vs `a5dc9bd`, **macro→closure-table** against macro→source, Node 25.9.0, `bench/jess/ab.ts --two-graph` | `benchmark.less`: 39.60 vs 16.93 ms (2.340x slower); generated workload: 110.18 vs 42.13 ms (2.615x slower); CSS: 15.28 vs 5.37 ms (2.845x slower). Full consumption; self checks 0.980-1.027x. | A real production-shaped regression; 0.48 work, not hidden. | recorded |
| Historical external-parser rows | Exact `82f6e8e`, prior `bench:margin` | The formerly reported 1.69–5.81× bars measured runtime `compile()`'s old emitted-assembly path while labeling it macro output. | They do **not** prove macro-artifact performance and are not current release evidence. | invalidated |
| Current candidate, JSON external gate | `3e91d6e` code path (`8a40705`), fresh process/bar, 3 rotated rounds | PM/Chevrotain: medium 28.955 / 29.202 µs (1.009×); large 236.858 / 246.124 µs (1.039×). PM won each paired round; A/A control spread was up to ~5%. | Reproducible small medium/large lead. The release owner explicitly accepts a lead below the general 1.05× confidence cushion for 0.47; the global cushion is unchanged. | **pass — 0.47 owner exception** |
| Current candidate, CSV and GraphQL external gate | Fresh complete rerun after the canonical artifact correction | Not yet recorded; the first full sweep was stopped when JSON failed its qualifying margin. | Must be measured from the final head. | pending |
| Commented small rows | Same final-candidate protocol with all three normally-commented small groups enabled together | Not run on the canonical candidate. | Diagnostic only; never selects rows for the release gate. | pending |
| CST bars | Supporting/non-identical work (rich object CST vs Lezer compact tree / Chev conversion) | Not used in the final external-equivalence gate. | Do not turn into a headline claim. | recorded |

The 0.47 ship condition is **faster than the relevant external parsers on medium
and large equivalent workloads**, not parity with 0.46. For this release the
owner accepts a reproducible small lead; this does not change the repository's
general 1.05x confidence cushion. Small-input rows are reported as evidence but
do not decide the gate.

## Release gate still open

`pnpm coverage:guard` is red against the historical `ed81612` baseline after a
successful final coverage run: lines `90.14%` vs `95.91%` (-5.77), statements
`87.96%` vs `92.12%` (-4.16), functions `91.58%` vs `96.55%` (-4.97); branches
improved to `86.27%` from `85.80%`. The baseline has not been rewritten and no
exclusions were added. `ed81612` predates the table cutover entirely (zero
`src/table` files); the candidate adds 21 table files / 13,631 lines, while the
coverage denominator includes 18 shipped table files at 87.64% lines. Even
theoretical 100% coverage of `assemble.ts` alone could only raise aggregate
lines to 92.97%, statements to 90.86%, and functions to 92.81%. The full suite
already added net 19,285 test lines over the baseline. This needs an explicit
release-owner exception or a substantial new test campaign; it is the only
remaining release decision.

The reported `assemble.ts` aggregate also understates its exercised closure
fallback: the dedicated module-reloaded fallback matrix runs 328 behavior
assertions with `PM_TABLE_EMIT=0` and reports 87.22% line coverage for that
module in isolation. V8's module-reset accounting does not preserve that work
in the aggregate report. This is not a reason to exclude code or waive the
gate automatically; it is evidence that adding coverage-padding tests would
not improve release confidence.
