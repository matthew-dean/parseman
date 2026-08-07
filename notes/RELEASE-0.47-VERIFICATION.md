# 0.47 release verification ledger

This file is the release claim ledger. A claim is not valid merely because it was
observed in a chat or a one-off terminal run: it must name the code, comparison,
protocol, and status below. Update the row when the final candidate changes.

## Candidate identity

| Item | Value | Status |
| --- | --- | --- |
| Remote release base | `origin/release/0.47.0` at `9c3ce450ff7cd35efc0cdc76a5f27df65a9fad2b` | pinned |
| Audit candidate | `fix/0.47-audit` worktree; uncommitted while audit is active | not final |
| 0.46 comparison base | `a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3` (`v0.46.0`) | pinned |

## Correctness and API

| Claim | Evidence | Status |
| --- | --- | --- |
| Table/interpreter/closure parity audit | Targeted matrix suite: rule-map, closure engines, commitment, scan shape, trivia skip, linker state, fields, line index, reflection, functional driver, and dispatch matcher matrices | passing; rerun after final integration |
| Public table API contract | Compile options, host mode, host capability, line/recovery, Unicode class, rule-map isolation regressions | passing; nested `execRules` host re-entry fix and public `BuildHost` compatibility are pending final rerun |
| Grammar analysis reaches every authored child | Dispatch matcher arms, `routed(fallback)`, grammar trivia, and recovery sentinel traversal regressions | passing; rerun after final integration |
| Trace | Table `_grammarTrace` rejects explicitly rather than silently reporting empty data | intentional 0.48 work; documented rejection |

## Artifact size

| Comparison | Evidence | Result | Status |
| --- | --- | --- | --- |
| Generated grammar output | `pnpm size:guard`, 24 established fixtures versus v0.46 | Every fixture smaller. Weakest: probe/trivia-off 11,483 B -> 2,052 B raw (5.60x); 2,613 B -> 829 B gzip (3.15x). | pass; rerun final candidate |
| Published package | `pnpm build && npm pack --dry-run --json --ignore-scripts`, v0.46 comparison | 0.47: 3,042,406 B tarball / 12,964,682 B unpacked; 0.46: 5,200,286 B / 19,958,344 B. 0.47 is 41.5% / 35.0% smaller. | pass; rerun final candidate |
| Package maps | Build maps exclude repeated `sourcesContent`; package ships `src/` once | 131 maps parse; zero missing mapped sources in package. | pass |

## Performance: never collapse these rows into one claim

| Comparison | Protocol | Observed result | Meaning | Status |
| --- | --- | --- | --- | --- |
| 0.47 table vs 0.46 on Jess/Less | Same-machine two-graph workload comparison | `benchmark.less`: 55.55 vs 17.35 (3.202x slower); generated workload: 162.81 vs 47.81 (3.405x slower) | A real production-shaped regression; 0.48 work, not hidden. | recorded |
| 0.47 table vs external parsers, JSON medium | `pnpm bench:margin -- --charts json` at exact 9c, isolated bars, 3 rotated rounds, A/A control 2.9% | PM macro 15.485us; nearest Chevrotain 29.745us (1.92x faster) | External-parser medium win. | reference only; rerun final candidate |
| 0.47 table vs external parsers, JSON large | same | PM macro 123.160us; nearest Chevrotain 240.960us (1.96x faster) | External-parser large win. | reference only; rerun final candidate |
| External CSV/GraphQL medium and large | same | not yet measured for this audit | Required before external-performance claim. | pending |
| Commented small rows: JSON/CSV/GraphQL/CST | Same protocol with every small group enabled together in isolated worktree | not yet measured for this audit | Diagnostic only; excluded from ship threshold because ~1us fixed overhead/noise may dominate. Must be recorded, never selectively omitted. | pending |

The 0.47 ship condition is **faster than the relevant external parsers on medium
and large equivalent workloads**, not parity with 0.46. The final candidate must
rerun the qualifying external charts after all source changes. Small-input rows
are reported as evidence but do not decide the gate.

## Release gates still open

- Inspect and deliberately integrate or reject every material post-`9c3ce45`
  release-line descendant; no blind merge.
- Rerun all correctness suites and full preflight after those decisions.
- Run coverage serially and retain the historical ratchet honestly; do not
  regenerate the baseline or add broad exclusions to manufacture green.
- Rerun generated/package size checks on the final candidate.
- Rerun external parser charts on the final candidate, including the full
  small-input diagnostic set.
- Update this ledger and the 0.48 performance handoff with final numbers.
