# 0.47 release verification ledger

This file is the release claim ledger. A claim is not valid merely because it was
observed in a chat or a one-off terminal run: it must name the code, comparison,
protocol, and status below. Update the row when the final candidate changes.

## Candidate identity

| Item | Value | Status |
| --- | --- | --- |
| Remote release base | `origin/release/0.47.0` at `9c3ce450ff7cd35efc0cdc76a5f27df65a9fad2b` | pinned |
| Code candidate | `fix/0.47-audit` at `a076972991316927af7d17d5c83da21a077ae4e9` | all final source/artifact gates below passed except the historical coverage ratchet |
| 0.46 comparison base | `a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3` (`v0.46.0`) | pinned |

## Correctness and API

| Claim | Evidence | Status |
| --- | --- | --- |
| Table/interpreter/closure parity audit | Targeted matrix suite: rule-map, closure engines, commitment, scan shape, trivia skip, linker state, fields, line index, reflection, functional driver, and dispatch matcher matrices | full suite passing (3,813 passed; 3 skipped; 22 todo) |
| Public table API contract | Compile options, host mode, host capability, line/recovery, Unicode class, rule-map isolation regressions | passing in final suite |
| Grammar analysis reaches every authored child | Dispatch matcher arms, `routed(fallback)`, grammar trivia, and recovery sentinel traversal regressions | passing in final suite |
| Trace | Table `_grammarTrace` rejects explicitly rather than silently reporting empty data | intentional 0.48 work; documented rejection |
| V8 construction shape | `src/table/**` contains no descriptor installation or `WeakMap`; table maps are born with metadata prototypes and macro metadata is never own/spread-visible | `INV-12` is a required CI invariant with planted descriptor and `WeakMap` failures; passing |

## Artifact size

| Comparison | Evidence | Result | Status |
| --- | --- | --- | --- |
| Generated grammar output | `pnpm size:guard`, 24 established fixtures versus v0.46 | Every fixture remains smaller; structural metadata/cache candidate is 8,385 raw bytes below its guard ceiling. | pass |
| Published package | `pnpm build && npm pack --dry-run --json --ignore-scripts`, v0.46 comparison | 0.47: 3,062,538 B tarball / 13,020,012 B unpacked; 0.46: 5,200,286 B / 19,958,344 B. 0.47 is 41.1% / 34.8% smaller. | pass |
| Package maps | Build maps exclude repeated `sourcesContent`; package ships `src/` once | 131 maps parse; zero missing mapped sources in package. | pass |

## Performance: never collapse these rows into one claim

| Comparison | Protocol | Observed result | Meaning | Status |
| --- | --- | --- | --- | --- |
| 0.47 table vs 0.46 on Jess/Less | Same-machine two-graph workload comparison | `benchmark.less`: 55.55 vs 17.35 (3.202x slower); generated workload: 162.81 vs 47.81 (3.405x slower) | A real production-shaped regression; 0.48 work, not hidden. | recorded |
| 0.47 table vs external parsers, JSON | Exact `a076972`, `pnpm bench:margin -- --charts json,csv,graphql`; fresh process/bar, 3 rotated rounds, all rivals 3/3 | PM/Chevrotain: small 0.555/0.952us (1.72x), medium 14.913/28.359us (1.90x), large 116.757/228.239us (1.95x); worst PM A/A 3.0% | External-parser win at every measured size. | pass |
| 0.47 table vs external parsers, CSV | same | PM: small 0.404us vs Peggy 1.847us (4.58x); large 70.575us vs Parsimmon 412.195us (5.84x); A/A 0.2–1.0% | External-parser win. | pass |
| 0.47 table vs external parsers, GraphQL | same | PM: small 0.649us vs Peggy 2.072us (3.19x); medium 5.134us vs Chevrotain 12.146us (2.37x); large 111.440us vs Peggy 320.380us (2.87x) | External-parser win at every measured size. | pass |
| Commented small rows: JSON/CSV/GraphQL | Same final-candidate protocol with all three normally-commented small groups enabled together | All reported above; tightest eligible margin JSON small at 1.72x, above the 1.05x floor. | Diagnostic rows retained; no selective omission. | pass |
| CST bars | Supporting/non-identical work (rich object CST vs Lezer compact tree / Chev conversion) | Not used in the final external-equivalence gate. | Do not turn into a headline claim. | recorded |

The 0.47 ship condition is **faster than the relevant external parsers on medium
and large equivalent workloads**, not parity with 0.46. The final candidate must
rerun the qualifying external charts after all source changes. Small-input rows
are reported as evidence but do not decide the gate.

## Release gate still open

`pnpm coverage:guard` is red against the historical `ed81612` baseline after a
successful final coverage run: lines `90.18%` vs `95.91%` (-5.73), statements
`87.95%` vs `92.12%` (-4.17), functions `91.25%` vs `96.55%` (-5.30); branches
improved to `86.61%` from `85.80%`. The baseline has not been rewritten and no
exclusions were added. `ed81612` predates the table cutover entirely (zero
`src/table` files); the candidate adds 21 table files / 13,631 lines, while the
coverage denominator includes 18 shipped table files at 87.64% lines. Even
theoretical 100% coverage of `assemble.ts` alone could only raise aggregate
lines to 92.96%, statements to 90.82%, and functions to 92.59%. The full suite
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
