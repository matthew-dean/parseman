# 0.48 table performance experiment ledger

This is the working view for 0.48 performance work. Historical evidence and
retractions remain in `RELEASE-0.48-TARGET.md`; this file answers what is being
tried now, why, and what result would keep it.

## Release criterion

0.48 does not ship until the canonical compact table path is at least as fast as
0.46 on all three production-shaped release fixtures: CSS, Less, and generated
Less. Each claim must compare against the pinned 0.46 build, parse the full
input, prove result identity, use paired runs, and include a same-source control.

The implementation must retain one `TableProgram` architecture for runtime
`compile()`, macro output, rule-map/linkable compilation, compose/fuse,
`run-tabled`, and folded variants. Runtime `new Function`, descriptor-based
shape mutation, `WeakMap` metadata, a second recognizer, downward baselines, and
static-factory artifact bloat are outside the design space.

## Correctness blocker

| ID | Defect | Handoff | Status |
| --- | --- | --- | --- |
| C01 | A successful nullable sequence term can produce a zero-width node, field, error, or trivia entry without advancing `EC.e`. The sequence must remove only ambient-scan trivia while preserving the child's nodes, raw children, fields, errors, and later trivia. | Fixed all four twins with pre/post trivia-sink marks and allocation-free in-place range compaction. `test/parity/nullable-node-trivia-rollback.test.ts` proves interpreter, reference exec, runtime compile, actual compact macro, emitted diagnostic assembly, real preceding trivia, recovery errors, and child-added trivia. Feature commit `9a5d52d`; merged into `release/0.48.0` as `b938fa4`. | LANDED — full suite 3,869 passed / 3 skipped / 22 todo; typecheck, lint, invariants, size guard, macro/emission parity, and CSS/Jess-facing tests pass |

## Active experiments

| ID | Priority | Hypothesis / mechanism | Required evidence | Owner lane | Status |
| --- | --- | --- | --- | --- | --- |
| T01 | P0 | Specialize linked sequence/choice pieces by child shape so literal, regex, rule, and node children do not all cross the same opaque call boundary. Avoid multiplying parent function-literal shapes. | CSS/Less/generated-Less vs 0.46 and clean 0.48; JSON medium/large; macro size; full parity. | unassigned | QUEUED |
| T02 | P0 | Select fixed shared pieces for dominant regex families (identifier runs, numeric runs, quoted strings, and single-class runs). Do not interpret the recursive `ScanShape` IR per match. | Same production A/B; direct regex-position oracle; opcode/grammar eligibility census; artifact delta; size guard. | unassigned | QUEUED |
| T03 | P0 | Profile the shipped compact closure path and identify the actual V8 inlining, IC, allocation, scope, sequence, capture, and rollback costs before choosing the next structural cut. | CPU/allocation/optimization evidence on all three production fixtures plus quiet same-source controls. | `perf/0.48-profile-hotpath` | COMPLETE EVIDENCE |
| T04 | P0 | Prove arm effects at encode time and omit rollback marks/calls where an arm cannot mutate CST buffers, trivia, fields, errors, or live captures. | Effect proof tests; adversarial rollback parity; production A/B; no new per-parse branch. | unassigned | QUEUED |
| T05 | P0 | Fuse common sequence/scope/sentinel transitions into smaller reusable pieces that stay inside V8's inlining budget, prioritizing already-value-elided `SEQV`. | `--trace-turbo-inlining` or equivalent evidence; production A/B; piece-count and size deltas. | `perf/0.48-sequence-fusion` | MEASURED NULL — rejected prototype retired |
| T06 | P1 | Premerge or copy-on-write expected sets so terminal failure avoids repeated array allocation/copy while preserving order, duplicates, and diagnostics. | Expected-set differential matrix; failure-heavy grammar gate; production A/B and allocations. | unassigned | QUEUED |
| T07 | P1 | Reduce CST child/raw materialization and defer objects/arrays that the selected output mode never observes. | AST/CST/fields/trivia parity; allocation profile; CSS/Less A/B; stable object shapes. | unassigned | QUEUED |
| T08 | P1 | Hoist `when(matches(...))` RegExp construction to table construction and reuse stable non-`g`/non-`y` regexes. | Dispatch matcher parity; matcher-heavy benchmark; prove relevance before production claim. | unassigned | QUEUED |
| T09 | P1 | Expand token-stream eligibility enough to amortize scanner setup and remove repeated terminal entry, using the preserved static token groundwork. | Eligibility census, boundary/language overlap proofs, production A/B, memory and artifact deltas. | unassigned | QUEUED |
| T10 | P2 | Specialize site-local trivia/range/lead scans without generic runtime option branches. | Track-lines/trivia/host/recovery matrix; production A/B; size guard. | unassigned | QUEUED |
| T11 | P0 | Reject impossible speculative arms from first-set/table metadata before node, repeat, attempt, rollback, and sequence setup. Less currently spends 46.0% of encoded work inside failed ungated arms; generated Less spends 42.7%. | Map hot arms to source/table sites; preserve diagnostics/commit/recovery identity; failure-heavy gate; production A/B and size. | `perf/0.48-ungated-map` | LANDED PARTIAL — shared-DAG false recursion fixed; residual overlap remains |
| T12 | P1 | Encode a bounded set of reducer/callback shapes as compact operands handled by shared pieces, recovering useful 0.46 callback fusion without embedding arbitrary source. | Reducer-shape census; closure-capture refusal; GraphQL and production A/B; artifact size and callback parity. | unassigned | QUEUED |

## Other performance and package ideas

These are useful but do not substitute for the P0 release criterion.

| ID | Idea | Decision needed | Status |
| --- | --- | --- | --- |
| P01 | Enable ESM code splitting so nine entry bundles share chunks. Prior experiment reduced packed size about 26.7% without changing CJS. | Repeat installed-tarball ESM/plugin/CLI smoke tests and verify source maps before landing. | QUEUED |
| P02 | Decide whether 0.48 still needs CJS now that Jess/Less use ESM-capable Node. | Gather real consumer/registry compatibility evidence; treat as public package-surface decision. | SHELVED DECISION |
| P03 | Implement `_grammarTrace` parity through assembly-selected instrumented pieces. | Correctness/API project; measure its size and speed cost independently. | QUEUED, NON-PERF BLOCKER ONLY IF PROMOTED |
| P04 | Improve the macro-artifact performance lane in CI so public runtime-compile bars cannot stand in for actual `pm-macro:` output. | Add small/medium/large composed grammar artifacts and production-shaped pinned comparisons. | QUEUED |

## Decision log

Record every completed experiment, including failures. A rejected experiment is
valuable when its exact patch, benchmark protocol, controls, and reason are
preserved.

| ID | Commit / patch | Result | Decision |
| --- | --- | --- | --- |
| T01a | Reverted prototype; no commit | Partitioning arity-2 `SEQV` parent closures by first-child opcode family preserved full/three-way identity but moved forced-load Less screening from 40.59 ms to 42.83 ms (+5.5%); control moved from −0.9% to +0.8%. | REJECTED. More parent function shapes made call-site stability worse; do not repeat this partition. |
| T02a | Reverted prototype; no commit | A shared recursive `ScanShape` interpreter preserved JSON identity/full consumption but moved the pinned-0.46 gap from +93.1% median / +94.8% min to +432.1% / +460.7%. The existing oracle still lowers 45/59 workload regexes with zero mismatches over 2,764,636 position checks. | REJECTED. Recognition alone is insufficient; use a small fixed family of straight-line pieces. |
| T03 | Evidence only; no code commit | Exact macro profiles put about 24–26% of Less/generated-Less CPU in two shared sequence bodies; generic dispatch/child/regex/rollback plumbing follows. GC is 2.5%, and allocation is only 9–10% above 0.46. Most hot sequence work is already value-elided. Failed nonexclusive arms drag 46.0% of Less rows, 42.7% generated Less, but only 8.5% CSS. | LANDED AS DIRECTION. Prioritize sequence call plumbing across dialects and residual speculation for Less; do not claim arrays, GC, trivia, or one deopt explains the gap. Quiet canonical timing is still required for release proof. |
| T05a | Retired prototype; no commit | Splitting `nextTerm` into a 117-byte dispatcher plus bare/untracked/tracked shared bodies made V8 inline the first layer but created a 724-byte nested-inline budget cliff. Full Less digest/consumption matched. Authoritative paired run: prototype 39.74 ms vs clean 39.45 ms (+0.7% slower); solo +0.3%. | MEASURED NULL / REJECT exact split. The prototype and temporary probe were removed; a follow-up must avoid the nested-inline explosion. |
| T11-map | Retired diagnostic; no production commit | A captured-macro harness printed both engine/source realpaths, proved full consumption and digest identity, and was shown RED by replacing the reference entry with `OP_EMPTY` (0/106,802 bytes consumed). The exact Less macro had 171 choices/562 arms/459 classed/103 open, 741,758 rows, 98,647 ordered arm entries, 55,964 failures, and 340,522 rows inside failed arms. The hottest IP was `blockBody` at 104,476 failed rows; its `atStatement` arm's eleven independently exact, nonnullable `@` choices collapsed to `any`/nullable because the first-set `seen` set confused a completed shared DAG node with a recursive back-edge. | DIAGNOSTIC COMPLETE. The counters and harness were removed after identifying a source-level cause; keep the exact production fix and its permanent tests, not the instrumentation. |
| T11a | `531116c`, size follow-up `3095619`, merged as `5901774` | Treating `seen` as an active recursion stack preserved safe fail-closed handling of real back-edges while classifying shared DAGs exactly. On the same captured Less macro, classed arms rose 459→479, open arms fell 103→83, rows fell 741,758→682,870 (-7.9%), failures fell 55,964→36,906, and failed-arm rows fell 340,522→201,951 (-40.7%); full consumption and digest stayed exact. Forced-load, interleaved two-graph screening against the exact parent measured benchmark Less -9.7% and generated Less -11.6%, with same-source drift about 0.5–2.4%; these relative numbers are integration evidence, not the quiet canonical release proof. A compact emitted class pool then made all 24 size cases pass and banked 298 raw bytes overall, while some gzip rows rose slightly. Full tests, typecheck, lint, invariants, build, size guard, and all six strict planted differentials passed. | LANDED. Deterministic work reduction, material relative wins, raw-size improvement, and stronger first-set correctness justify the change even under a loaded-machine timing caveat. Residual overlap stays in T11 and the 0.46 release bar remains open. |

## Current 0.46 shelf audit

Candidate `5901774` was measured against the pinned 0.46 reference on Node 25.9
with the repository's paired, order-alternated gates. Each production and density
row used five independently recompiled passes and 60 total A/B pairs. Load average
was 4.56→4.50 for the production gate and 4.18→4.05 for density. Every candidate
row lost 60/60 pairs, so the remaining gap is not a load artifact; the in-run
reference/reference controls determine the noise calibration. These are release
audit figures, not new baselines or shelf ceilings.

| Surface | Candidate range vs 0.46 | Disposition |
| --- | --- | --- |
| production `less/stylesheet` | median +149.1%…+251.4%; min +237.6%…+265.8% | Improved relative to the +332.3%/+348.5% shelf ceiling; shelf remains. |
| production `less/mixins` | median +228.9%…+237.4%; min +226.7%…+251.9% | Improved relative to the +329.8%/+344.3% shelf ceiling; shelf remains. |
| production `css/stylesheet` | median +150.4%…+297.1%; min +170.4%…+302.3% | Improved relative to the +309.6%/+333.2% shelf ceiling; shelf remains. |
| production `graphql/document` | median +78.6%…+107.9%; min +83.8%…+111.5% | Improved relative to the +124.7%/+129.6% shelf ceiling; shelf remains. |
| production `json/document` | median +117.3%…+140.2%; min +116.7%…+144.1% | Improved relative to the +145.8%/+146.9% shelf ceiling; shelf remains. |
| density rollback axis | median +135.5%…+273.2%; min +144.4%…+293.6% | All four named rows remain strict regressions, inside their ceilings. |
| density expected axis | median +80.2%…+152.8%; min +105.1%…+157.2% | All three named rows remain strict regressions, inside their ceilings. `expected/wide` improved most from its 0.47 +373.2%…+424.5% envelope. |
| toy CSS compiled bars | `decls` +67.3%; `selector` +104.0% | Improved from 0.47's approximately +343%/+386%; both original-baseline shelves remain. |

No one of the fourteen 0.47 shelf entries is eligible for removal yet. The
shared-DAG change is retained because it has exact deterministic work reduction,
correctness, raw-size, and material relative Less wins, not because it alone meets
the release bar.

## Handoff worktrees

| Worktree | Branch / base | Preserved state | Next action |
| --- | --- | --- | --- |
| `/private/tmp/parseman-048-early-reject` | `perf/0.48-early-reject` at `9a5d52d` | Clean committed C01 fix and regression matrix; integrated into `release/0.48.0` by merge `b938fa4`. | Preserve as the reviewed correctness lane; performance work may now integrate independently. |
| `/private/tmp/parseman-048-sequence-fusion` | `perf/0.48-sequence-fusion` at `ac1bf7b` | Clean; rejected assembly prototype and temporary probe removed. | Keep only as historical branch context or remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-ungated-map` | `perf/0.48-ungated-map` at `3095619` | Clean; production first-set and compact-class-pool commits integrated into `release/0.48.0`; diagnostic counters and captured-macro probe retired. | Preserve through review, then remove the worktree during release cleanup. |

## Updating this ledger

- `RUNNING`: an isolated lane exists and has an owner.
- `MEASURED WIN`: paired evidence beats clean 0.48 and moves toward or beyond
  0.46 without violating correctness, architecture, or size constraints.
- `MEASURED NULL`: result is inside the same-source noise envelope.
- `REJECTED`: slower, incorrect, too large, or violates the canonical path.
- `LANDED`: merged into `release/0.48.0` with gates and evidence.

Do not delete rejected rows or silently relax the required evidence.
