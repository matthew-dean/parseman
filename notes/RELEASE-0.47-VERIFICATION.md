# 0.47 release verification ledger

This file is the release claim ledger. A claim is not valid merely because it was
observed in a chat or a one-off terminal run: it must name the code, comparison,
protocol, and status below. Update the row when the final candidate changes.

## Candidate identity

| Item | Value | Status |
| --- | --- | --- |
| Remote release base | `origin/release/0.47.0` at `9c3ce450ff7cd35efc0cdc76a5f27df65a9fad2b` | pinned |
| Code candidate | `fix/0.47-audit` at `a28404c` | canonical `a:[]` compiler/macro/fold artifact; strict example document helpers and exact chart-factory consumption gate included |
| 0.46 comparison base | `a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3` (`v0.46.0`) | pinned |

## Correctness and API

| Claim | Evidence | Status |
| --- | --- | --- |
| Table/interpreter/closure parity audit | Targeted matrix suite: rule-map, closure engines, commitment, scan shape, trivia skip, linker state, fields, line index, reflection, functional driver, dispatch matcher matrices | full suite passing (3,844 passed; 3 skipped; 22 todo); ordinary-host re-entry restores all assembly slots on return and throw |
| Public table API contract | Compile options, host mode, host capability, line/recovery, Unicode class, rule-map isolation regressions | passing in final suite |
| Grammar analysis reaches every authored child | Dispatch matcher arms, `routed(fallback)`, grammar trivia, and recovery sentinel traversal regressions | passing in final suite |
| Timed parser work is complete | Every enabled JSON/CSV/GraphQL `CHART_GROUPS` row runs through the exact `makeParse(chart, 'parseman-runtime')` factory and must succeed, consume the entire fixture, and equal `JSON.parse` / `parseCSV` / `parseGraphQL`; public JSON and GraphQL document helpers reject trailing syntax | passing; GraphQL still accepts legal trailing trivia/comments and low-level combinators remain prefix parsers |
| Trace | Table `_grammarTrace` rejects explicitly rather than silently reporting empty data | intentional 0.48 work; documented rejection |
| V8 construction shape | `parseman/table`'s complete local import graph contains no import-time descriptor installation or `WeakMap`; table maps are born with metadata prototypes and macro metadata is never own/spread-visible | `INV-12` traverses the entry graph; a fresh built-package import spy observes zero `WeakMap` and zero `Object.defineProperty` calls; passing |

## Artifact size

| Comparison | Evidence | Result | Status |
| --- | --- | --- | --- |
| Generated grammar output | `pnpm size:guard`, 24 established fixtures versus v0.46 | Every fixture remains smaller; 8,385 raw bytes of improvement across 16 structural fixtures were banked into tighter per-fixture ceilings. | pass |
| Published package | `pnpm build && npm pack --dry-run --json`, v0.46 comparison | 0.47: 3,075,840 B tarball / 13,076,481 B unpacked; 0.46: 5,200,286 B / 19,958,344 B. 0.47 is 40.9% / 34.5% smaller. | pass |
| Package maps | Build maps exclude repeated `sourcesContent`; package ships `src/` once | 131 maps parse; zero missing mapped sources in package. | pass |

## Performance: never collapse these rows into one claim

| Comparison | Protocol | Observed result | Meaning | Status |
| --- | --- | --- | --- | --- |
| 0.47 table vs 0.46 on Jess/Less | Exact `a28404c` source vs `a5dc9bd`, **macro→closure-table** against macro→source, Node 25.9.0, `bench/jess/ab.ts --two-graph` | CSS: 14.88 vs 5.44 ms (2.736× slower); `benchmark.less`: 39.39 vs 17.07 ms (2.308×); generated Less: 108.44 vs 42.39 ms (2.558×). Every leg parsed in full; same-source self controls were 0.975× / 0.988× / 1.011×. | A real production-shaped regression; explicitly disclosed and assigned to 0.48, not hidden or used to roll back the table cutover. | recorded |
| Historical external-parser rows | Exact `82f6e8e`, prior `bench:margin` | The formerly reported 1.69–5.81× bars measured runtime `compile()`'s old emitted-assembly path while labeling it macro output. | They do **not** prove macro-artifact performance and are not current release evidence. | invalidated |
| Current candidate, JSON external gate | `a28404c`, exact `measure-bar` factory in fresh processes, 3 paired/alternating rounds | PM/Chevrotain medians: medium 28.781 / 29.687 µs (PM 1.032× faster); large 236.421 / 247.103 µs (1.045×). PM won 3/3 paired rounds at both sizes; PM A/A range 1.6% / 1.5%. | Reproducible small medium/large lead. The release owner explicitly accepts a lead below the general 1.05× confidence cushion for 0.47; the global cushion is unchanged. | **pass — 0.47 owner exception** |
| Current candidate, CSV external gate | Same fresh-process protocol, 3 paired/alternating rounds; Peggy is nearest (Parsimmon large 530.1 µs) | PM/Peggy large: 118.231 / 439.000 µs (PM 3.71× faster), 3/3 rounds. PM A/A range 0.1%; Peggy 1.8%. CSV has no medium chart row. | Decisive lead on the established large CSV fixture. | pass |
| Current candidate, GraphQL external gate | Same fresh-process protocol, 3 paired/alternating rounds; Chevrotain is nearest (Peggy 15.41 / 356.58 µs; Parsimmon 59.12 / 1,632.22) | PM/Chevrotain: medium 8.655 / 13.075 µs (1.51×); large 210.228 / 349.298 µs (1.66×), 3/3 rounds at both sizes. PM A/A 1.8% / 2.2%; the bars remain non-overlapping despite Chevrotain's wider control range. | Decisive medium/large lead. | pass |
| Commented small rows | Same final-candidate protocol with all three normally-commented small groups enabled consistently | JSON: PM 1.0178 / Chevrotain 0.9956 µs (PM 2.2% slower, 0/3). CSV: PM 0.6933 / Peggy 1.9368 µs (2.79× faster, 3/3). GraphQL: PM 1.1900 / Chevrotain 2.2137 µs (1.86× faster, 3/3). | Diagnostic only; fixed call overhead dominates and these rows do not select the release gate. | recorded |
| CST bars | Supporting/non-identical work (rich object CST vs Lezer compact tree / Chev conversion) | Not used in the final external-equivalence gate. | Do not turn into a headline claim. | recorded |

The 0.47 ship condition is **faster than the relevant external parsers on medium
and large equivalent workloads**, not parity with 0.46. For this release the
owner accepts a reproducible small lead; this does not change the repository's
general 1.05x confidence cushion. Small-input rows are reported as evidence but
do not decide the gate.

## Release gate still open

`pnpm coverage:guard` is red against the historical `ed81612` baseline after a
successful final coverage run: lines `90.07%` vs `95.91%` (-5.84), statements
`87.88%` vs `92.12%` (-4.24), functions `91.58%` vs `96.55%` (-4.97); branches
improved to `86.24%` from `85.80%`. The baseline has not been rewritten and no
exclusions were added. `ed81612` predates the table cutover entirely (zero
`src/table` files); the candidate adds 21 table files / 13,631 lines, while the
coverage denominator includes 18 shipped table files at 87.50% lines. Even
theoretical 100% coverage of every remaining table line/function could only
raise aggregate lines to 93.92% and functions to 93.77%, still below the
historical ratchet. Raising `assemble.ts` alone to 100% would yield 92.61% lines,
90.45% statements, and 92.76% functions. The full suite
already added net 19,285 test lines over the baseline. This needs an explicit
release-owner exception or a substantial new test campaign; it is the only
remaining release decision.

The reported `assemble.ts` aggregate also understates its exercised closure
fallback: the dedicated module-reloaded fallback matrix runs 332 behavior
assertions (plus one todo) with `PM_TABLE_EMIT=0` and reports 87.04% line coverage for that
module in isolation. V8's module-reset accounting does not preserve that work
in the aggregate report. This is not a reason to exclude code or waive the
gate automatically; it is evidence that adding coverage-padding tests would
not improve release confidence.
