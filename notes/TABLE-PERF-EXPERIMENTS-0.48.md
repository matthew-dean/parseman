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

## Active experiments

| ID | Priority | Hypothesis / mechanism | Required evidence | Owner lane | Status |
| --- | --- | --- | --- | --- | --- |
| T01 | P0 | Specialize linked sequence/choice pieces by child shape so literal, regex, rule, and node children do not all cross the same opaque call boundary. Avoid multiplying parent function-literal shapes. | CSS/Less/generated-Less vs 0.46 and clean 0.48; JSON medium/large; macro size; full parity. | unassigned | QUEUED |
| T02 | P0 | Select fixed shared pieces for dominant regex families (identifier runs, numeric runs, quoted strings, and single-class runs). Do not interpret the recursive `ScanShape` IR per match. | Same production A/B; direct regex-position oracle; opcode/grammar eligibility census; artifact delta; size guard. | unassigned | QUEUED |
| T03 | P0 | Profile the shipped compact closure path and identify the actual V8 inlining, IC, allocation, scope, sequence, capture, and rollback costs before choosing the next structural cut. | CPU/allocation/optimization evidence on all three production fixtures plus quiet same-source controls. | `perf/0.48-profile-hotpath` | RUNNING |
| T04 | P0 | Prove arm effects at encode time and omit rollback marks/calls where an arm cannot mutate CST buffers, trivia, fields, errors, or live captures. | Effect proof tests; adversarial rollback parity; production A/B; no new per-parse branch. | unassigned | QUEUED |
| T05 | P0 | Fuse common sequence/scope/sentinel transitions into smaller reusable pieces that stay inside V8's inlining budget, prioritizing already-value-elided `SEQV`. | `--trace-turbo-inlining` or equivalent evidence; production A/B; piece-count and size deltas. | `perf/0.48-sequence-fusion` | RUNNING |
| T06 | P1 | Premerge or copy-on-write expected sets so terminal failure avoids repeated array allocation/copy while preserving order, duplicates, and diagnostics. | Expected-set differential matrix; failure-heavy grammar gate; production A/B and allocations. | unassigned | QUEUED |
| T07 | P1 | Reduce CST child/raw materialization and defer objects/arrays that the selected output mode never observes. | AST/CST/fields/trivia parity; allocation profile; CSS/Less A/B; stable object shapes. | unassigned | QUEUED |
| T08 | P1 | Hoist `when(matches(...))` RegExp construction to table construction and reuse stable non-`g`/non-`y` regexes. | Dispatch matcher parity; matcher-heavy benchmark; prove relevance before production claim. | unassigned | QUEUED |
| T09 | P1 | Expand token-stream eligibility enough to amortize scanner setup and remove repeated terminal entry, using the preserved static token groundwork. | Eligibility census, boundary/language overlap proofs, production A/B, memory and artifact deltas. | unassigned | QUEUED |
| T10 | P2 | Specialize site-local trivia/range/lead scans without generic runtime option branches. | Track-lines/trivia/host/recovery matrix; production A/B; size guard. | unassigned | QUEUED |
| T11 | P0 | Reject impossible speculative arms from first-set/table metadata before node, repeat, attempt, rollback, and sequence setup. Less currently spends 46.0% of encoded work inside failed ungated arms; generated Less spends 42.7%. | Map hot arms to source/table sites; preserve diagnostics/commit/recovery identity; failure-heavy gate; production A/B and size. | `perf/0.48-early-reject` | RUNNING |
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

## Updating this ledger

- `RUNNING`: an isolated lane exists and has an owner.
- `MEASURED WIN`: paired evidence beats clean 0.48 and moves toward or beyond
  0.46 without violating correctness, architecture, or size constraints.
- `MEASURED NULL`: result is inside the same-source noise envelope.
- `REJECTED`: slower, incorrect, too large, or violates the canonical path.
- `LANDED`: merged into `release/0.48.0` with gates and evidence.

Do not delete rejected rows or silently relax the required evidence.
