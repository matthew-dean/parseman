# 0.48 table performance experiment ledger

This is the live working view for 0.48 performance work. The canonical design and
implementation order are in
[`docs/design/parseman-0.48.md`](../docs/design/parseman-0.48.md). Historical
evidence and retractions remain in `RELEASE-0.48-TARGET.md`; this file alone
answers what is active, why, and what result would keep it.

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

The ledger uses a Pareto gate, not a fixed headline threshold. A repeatable,
control-adjusted improvement above 1% is eligible to land when artifact/package and
maintenance cost are negligible and no release fixture materially regresses. Small
orthogonal wins are banked and remeasured cumulatively on the integrated head. As size,
runtime surface, or semantic risk grows, the required payoff grows with it.

## External Jess base and delegation

The primary orchestrator is responsible for keeping Jess `origin/dev` current and for
the base used by delegated work. The approved head is presently
`93c67d0ae7be0360a6db35f0cfa055043bca8025`. Agents must create or refresh isolated Jess
worktrees from that exact remote head; a stale preserved worktree may support historical
analysis but may not support a new production claim. Every external census or timing
banner must print the Jess remote SHA, dirty state, root and source realpaths, and the
Parseman SHA/realpath. Moving `origin/dev` invalidates dependent performance evidence
until external build, macro/compose, full-consumption, and result-identity gates rerun.

## Correctness blocker

| ID | Defect | Handoff | Status |
| --- | --- | --- | --- |
| C01 | A successful nullable sequence term can produce a zero-width node, field, error, or trivia entry without advancing `EC.e`. The sequence must remove only ambient-scan trivia while preserving the child's nodes, raw children, fields, errors, and later trivia. | Fixed all four twins with pre/post trivia-sink marks and allocation-free in-place range compaction. `test/parity/nullable-node-trivia-rollback.test.ts` proves interpreter, reference exec, runtime compile, actual compact macro, emitted diagnostic assembly, real preceding trivia, recovery errors, and child-added trivia. Feature commit `9a5d52d`; merged into `release/0.48.0` as `b938fa4`. | LANDED — full suite 3,869 passed / 3 skipped / 22 todo; typecheck, lint, invariants, size guard, macro/emission parity, and CSS/Jess-facing tests pass |
| C02 | Synthetic rule-entry and scoped-reference trivia scopes were encoded with the 3-word historical row while `OP_SCOPE` readers required a fourth policy word, so the next opcode could become policy and selected root trivia failed on real Jess Less. | `82069ab` adds a width-stable 3-word `OP_SCOPE_PLAIN` for synthetic policy-zero scopes and permanently pins authored `OP_SCOPE` at four words. Interpreter, closure, emitted, reference, and precompiled paths share the contract; RED tests exercise following-opcode policy teeth. | LANDED — zero CSS/Less program-word growth; actual Jess CSS and Less fully consume and preserve selected root comment maps; the isolated candidate passed full Parseman correctness, size, package, and strict differential gates before integration |

## Active experiments

| ID | Priority | Hypothesis / mechanism | Required evidence | Owner lane | Status |
| --- | --- | --- | --- | --- | --- |
| T01 | P0 | Specialize linked sequence/choice pieces by child shape so literal, regex, rule, and node children do not all cross the same opaque call boundary. Avoid multiplying parent function-literal shapes. | CSS/Less/generated-Less vs 0.46 and clean 0.48; JSON medium/large; macro size; full parity. | `codegen_audit` | LANDED / CONTINUING — raw `NODE→RX` recognition duplication was flat, but the bounded direct terminal-node materializer removes the capture frame and downstream child plumbing and moved actual Jess CSS about 5–6% net. It remains replaceable by a future pending token result. Remaining composite boundaries require their own bounded pieces and evidence. |
| T02 | P0 | Select fixed shared pieces for dominant regex families (identifier runs, numeric runs, quoted strings, and single-class runs). Do not interpret the recursive `ScanShape` IR per match. | Same production A/B; direct regex-position oracle; opcode/grammar eligibility census; artifact delta; size guard. | `codegen_audit` | CONVERGED INTO T09/T01 — standalone correct numeric recognition and raw `NODE→RX` duplication both measured flat. Any fixed recognizer must now prove value as the shared raw/seeded/token kernel consumed by composite pieces, not as another isolated regex body. |
| T03 | P0 | Profile the shipped compact closure path and identify the actual V8 inlining, IC, allocation, scope, sequence, capture, and rollback costs before choosing the next structural cut. | CPU/allocation/optimization evidence on all three production fixtures plus quiet same-source controls. | `perf/0.48-profile-hotpath` | COMPLETE EVIDENCE |
| T04 | P0 | Prove arm effects at encode time and omit rollback marks/calls where an arm cannot mutate CST buffers, trivia, fields, errors, or live captures. | Effect proof tests; adversarial rollback parity; production A/B; no new per-parse branch. | `perf/0.48-effect-proof` | MEASURED NULL — rejected prototype retired |
| T05 | P0 | Fuse common sequence/scope/sentinel transitions into smaller reusable pieces that stay inside V8's inlining budget, prioritizing already-value-elided `SEQV`. | `--trace-turbo-inlining` or equivalent evidence; production A/B; piece-count and size deltas. | `perf/0.48-sequence-fusion` | MEASURED NULL — rejected prototype retired |
| T06 | P1 | Premerge or copy-on-write expected sets so terminal failure avoids repeated array allocation/copy while preserving order, duplicates, and diagnostics. | Expected-set differential matrix; failure-heavy grammar gate; production A/B and allocations. | unassigned | QUEUED |
| T07 | P1 | Reduce CST child/raw materialization and defer objects/arrays that the selected output mode never observes. | AST/CST/fields/trivia parity; allocation profile; CSS/Less A/B; stable object shapes. | unassigned | QUEUED |
| T08 | P1 | Hoist `when(matches(...))` RegExp construction to table construction and reuse stable non-`g`/non-`y` regexes. | Dispatch matcher parity; matcher-heavy benchmark; prove relevance before production claim. | unassigned | QUEUED |
| T09 | P0 | Build virtual tokenized PEG: classify reusable integer token ids and source ranges at the current cursor/context; reject impossible arms; let compatible arms continue ordered trial and consume the same pending range. Support lazy single-lead and bounded multi-token admission, prioritizing Less `Value` and mixin-declaration/call/ruleset triage. Disjoint character gates may seed recognition. Do not allocate token objects, copy strings, or make LL(k)/ALL(*) semantics implicit. | Frequency-weighted census on exact macro artifacts; boundary/language overlap proofs; arm-entry and nested-row elimination by token depth; result reuse rather than scan-then-rescan; proven-RED `a|ab`/`ab|a`, same-token, attempt/commit, gate, probe, recursion, reentrancy and recovery semantics; CSS/Less/generated-Less A/B; cache high-water, memory, artifact, and package deltas. | `json_fixed_regex` planner/wire; `codegen_audit` runtime; `css_less_hotspots` Jess contract; primary integration | ACTIVE — full end-to-end implementation is now the leading lane, not another admission bridge. All owners branch from pushed Parseman `5aacee8` and Jess `origin/dev` `93c67d0`. The compiler lane owns canonical global families/outcomes plus compact site routes; the runtime lane owns the allocation-free range cursor and closure/emitted/precompiled consumers; the Jess lane owns actual decision-path/view/refusal contracts and permanent cross-engine fixtures. Completion requires a production Jess dispatch to classify before branch selection and every selected consumer to reuse that same range. Earlier eager native-regex, trie/gate, OP_TOKEN_LEX-only, choice-admission, route-once, direct-outcome, identifier-stream, and numeric-family checkpoints remain evidence inputs, not landed substitutes. |
| T10 | P2 | Specialize site-local trivia/range/lead scans without generic runtime option branches. | Track-lines/trivia/host/recovery matrix; production A/B; size guard. | unassigned | QUEUED |
| T11 | P0 | Reject impossible speculative arms from first-set/table metadata before node, repeat, attempt, rollback, and sequence setup. Less currently spends 46.0% of encoded work inside failed ungated arms; generated Less spends 42.7%. | Map hot arms to source/table sites; preserve diagnostics/commit/recovery identity; failure-heavy gate; production A/B and size. | `css_less_hotspots` | LANDED / BOUNDED — size-neutral optional-repeat item guard in `11dd984` remains; broader assembly-derived class coverage measured flat/slower and was rejected. Follow-up work moves to token-compatible terminal-node materialization under T01. |
| T12 | P1 | Encode a bounded set of reducer/callback shapes as compact operands handled by shared pieces, recovering useful 0.46 callback fusion without embedding arbitrary source. | Reducer-shape census; closure-capture refusal; GraphQL and production A/B; artifact size and callback parity. | `codegen_audit` | LANDED / BOUNDED — exact direct-child array projections now use the existing `OP_SEQX` operand, remove the reducer/value-array path, and cost zero table words. JSON improved decisively; GraphQL stayed flat. Other reducer shapes remain queued behind their own census/payoff proof. |
| T13 | P2 | After tokenized PEG has a production baseline, test whether bounded integer-keyed LL(k) or ALL(*)-style adaptive prediction removes additional shared-token speculation without prediction machinery becoming the workload. | Separate semantic proposal; proven-RED overlap differentials; no stringified paths/stacks/config sets; hard state/byte ceiling and tokenized-PEG fallback; cold build, warm parse, configuration/cache high-water marks, artifact bytes, and production A/B. | unassigned | QUEUED — explicitly not part of T09 or a 0.48 prerequisite |
| T14 | P0 | Let direct terminal negative lookahead consume the shared scalar recognizer instead of entering and rolling back a terminal piece. This is a token-compatible consumer, not a competing scanner. | Interpreter/reference/closure/emitted/precompiled identity; proven-RED assertion directions; probe/expected/commit/sink/coverage/tracked semantics; unchanged program words; canonical CSS/Less/generated A/A+A/B and package cost. | `css_less_hotspots`, independently reviewed by `codegen_audit` | LANDED as `1deecee` — five independent exact-Jess `f3b4c3f` passes banked control-adjusted gains of 1.3–1.6% on benchmark Less, 1.8–1.9% on generated Less, and 1.2–1.4% on CSS. The mechanism costs 3,673 packed bytes (+0.117%), shrinks emitted CSS/Less by 15,884/33,537 bytes, and adds zero program words. Permanent tests prove real emitted/precompiled modules under CSP, compact fold/unfold, full RunResult, classified/root trivia, CST, completions, shared-RegExp reentrancy, word/keyword boundaries, zero-width regexes, and behavior-bearing RED plants. Integrated focused/typecheck/lint/invariants/build/size/strict-differential gates and exact Jess build/macro/four-engine full identity are green. |

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
| T01b | Retired prototype; no commit | A static shipping-grammar census found 238 direct literal and 122 direct regex children among Less's 927 sequence slots. Inlining all direct literals preserved emitted/closure identity over all 314 Less corpus rows and shrank uncompressed emitted source by 6,981 B for Less and 8,641 B for CSS. Against exact parent `2c3fb4f`, the five-pass production gate was flat: Less stylesheet −1.3%…+1.4%, Less mixins −3.7%…−0.1%, CSS −0.9%…+1.8%, GraphQL +1.2%…+3.0% (2/5 breaches), JSON −3.6%…+0.4%; controls were mostly within 1.9%, with one noisy JSON control pass. Position splits were worse on the shipping Less macro: first-only +1.0%/+2.0% and later-only +3.0%/+3.0% on benchmark/generated Less. Adding direct regex bodies grew Less emitted source by 56,745 B and slowed those fixtures +2.7%/+1.3%. | REJECTED. The literal-only size reduction is under 1% of the emitted assembly, duplicates terminal semantics, carries a possible small GraphQL cost, and recovers no release shelf; regex inlining is strictly larger and slower. The prototype and census were removed. Child-shape work must reuse compact fixed pieces without inflating hot parent bodies. |
| T01c | `d9c60e7` (feature lane `19b64c4`) | A strict-AST direct builder node over one untracked literal/regex now consumes a shared pure scalar terminal result and materializes its leaf, `children`, `rawChildren`, span, and outer capture without opening the generic node capture frame. Eligibility requires a direct builder, flags 0, no projection, and a direct terminal; CST hosts, tolerant recovery, completion probe, coverage, and line tracking retain the generic node. Actual Jess CSS executes 9,704 eligible successful materializations per parse. Three independent two-graph processes measured pooled deltas −8.0%/−6.9%/−4.1% (center −6.9%) with matching A/A −1.6%/−0.5%/+2.9%; the defensible net signal is about 5–6%. Less was flat, matching only 383 hits. Program words were unchanged; emitted CSS/Less source shrank 7,872/17,166 bytes. On the feature base npm pack grew 22,316 bytes (+0.72%). Permanent tests pin interpreter/reference/closure/emitted parity, semantic raw-child RED, pooled-spec sharing, tracked-row refusal, coverage/CST/tolerant/probe bypass, and the appended recognizer argument through a precompiled factory. Full coverage (3,884 tests), coverage guard, typecheck, lint, invariants, size guard, and all six strict differentials passed before integration; the combined head's 45 overlapping focused tests and typecheck passed after cherry-pick. | LANDED. This is the first decisive CSS-specific composite/materialization win. The raw recognizer remains a replaceable scalar seam, so future tokenization can publish the same end position without undoing the materializer. It is not a Less release-bar mechanism. |
| T01d | `/tmp/parseman-redundant-scope-elision-rejected.patch`; evidence in `/tmp/parseman-redundant-scope-elision-evidence.md` | Site labels selected a direct child whenever a plain policy-0 `OP_SCOPE` provably reinstalled the exact ambient trivia state. The closure and emitted paths removed 12,942 wrapper calls on actual benchmark Less, 34,791 on generated Less, and 1,857 on CSS with zero program words and byte-identical displayed artifacts. Interpreter/reference/closure/emitted identity, tolerant/CST variants, and a capture-scope RED plant passed. Three valid exact-parent passes nevertheless centered at benchmark Less −1.3%, generated Less −0.8%, and CSS +0.8%, all inside unstable matching controls (up to +3.4% Less and −2.9% CSS). The much larger hot shared/public NODE→SCOPE population loses ambient-state proof and was deliberately not inferred. | REJECTED. Exact direct same-state scope aliasing is too small to separate from noise even at zero artifact cost. Reaching the larger ceiling requires a distinct context-specialized node/scope mechanism, not widening the site-label proof. Worktree restored clean at `d9c60e7`. |
| T01e | Evidence in `/private/tmp/parseman-clear-scope-seq2-screen.md` | A closure-only mechanism screen fused semantic `noTrivia` `OP_SCOPE(ki=-1) → SEQV(n=2)` while preserving save/clear/restore and calling the existing child pieces. Actual Jess CSS had 15,579 eligible attempts / 9,316 successes; a deliberate dropped-second-term plant reduced identity to 68/87. A 96-pair high-sample CSS screen measured candidate −0.91% center / −0.57% paired median versus A/A −0.45% / −0.10%, a net about −0.46% inside broad dispersion. An earlier 48-pair screen was likewise flat. One noisy Less screen was not promoted. Program words stayed at 6,130 CSS / 11,215 Less. | REJECTED / FAMILY RETIRED. The scope/sequence boundary is optimized away or too small beside surrounding work. Do not implement the emitted twin, full NODE fusion, or Declaration expansion from this mechanism. The isolated worktree was restored clean at `d78ea9f`. |
| T01f | `c02eb535` | A bounded closure-only screen replaced direct untracked literal/regex children inside `SEQ`/`SEQV` with scalar terminal bodies, removing 14,020 child-piece edges in CSS, 41,163 in benchmark Less, and 125,676 in generated Less. The census was RED-proven and every timed leg proved source/reference/base/candidate identity plus literal EOF on exact Jess `origin/dev` `43cda8b`. Despite the large static ceiling, valid control-adjusted paired centers regressed CSS +0.31%, benchmark Less +1.68%, and generated Less +3.35%; both Less fixtures recorded 0/16 faster candidate rounds. Focused 76/76, typecheck, lint, invariants, and diff-check remained green. | REJECTED. Removing this opaque child boundary worsens both Less workloads, so no emitted twin or package surface was built. The checkpoint is evidence only; do not repeat direct sequence-terminal substitution without a materially different parent shape. |
| T01g | `2815c5fc` (fixes atop `fe377fe`) | A current-head node-only numeric materializer recognized the exact CSS/Less Dimension and Percentage node shapes through the shared scalar terminal pool and directly built the number/unit leaves, removing generic scope/sequence/optional/node capture work without token metadata, new opcodes, or pending caches. Two independent reviews found and permanently fixed scope-policy bypass and observable `children`/`rawChildren` aliasing. Focused 100 tests, strict differentials, exact Jess `origin/dev` `43cda8b` five-engine identity, CSP modules, fold/unfold, cold modes, trivia, reentry, and full CSS/Less/generated consumption passed. It covered 3,186 CSS, 2,797 benchmark-Less, and 9,251 generated-Less builds, kept program words/constants/functions unchanged, and shrank emitted CSS/Less source 9,609/4,986 bytes, but grew npm pack 19,563 bytes (+0.62%). Two matching high-sample passes centered at only about 0.35% faster benchmark Less and 1.2% faster generated Less; nominal CSS gains were invalidated by paired-vs-alone disagreement. | HOLD / DO NOT INTEGRATE. Correctness is approved, but one weak >1% fixture does not repay the package surface. Preserve the checkpoint as evidence; revisit only if a smaller shared composite-materialization implementation absorbs it. |
| T02a | Reverted prototype; no commit | A shared recursive `ScanShape` interpreter preserved JSON identity/full consumption but moved the pinned-0.46 gap from +93.1% median / +94.8% min to +432.1% / +460.7%. The existing oracle still lowers 45/59 workload regexes with zero mismatches over 2,764,636 position checks. | REJECTED. Recognition alone is insufficient; use a small fixed family of straight-line pieces. |
| T02b | Retired prototype; no commit | A single-range fixed regex piece appeared to improve JSON by 8–15% in short screens, but an eligibility audit proved that it never recognized JSON's actual number regex: the apparent win was harness noise. A correct bounded JSON-number `charCodeAt` scanner was then tested against exact parent `44f6393`; production identity and focused sticky-prefix number cases matched after fixing the `0.5` zero-fraction edge. The full five-pass JSON gate was flat: median −1.1%…+1.5%, min −0.7%…+1.3%, 0/5 breaches; reference/reference control worst median +0.3%, load 4.84→4.89. | REJECTED. Standalone numeric recognition does not justify another scanner body. Resume only for a structural boundary/value-fusion cut that removes work beyond native sticky `RegExp`, not another regex variant. The worktree was restored clean and its untracked `dist` link removed. |
| T03 | Evidence only; no code commit | Exact macro profiles put about 24–26% of Less/generated-Less CPU in two shared sequence bodies; generic dispatch/child/regex/rollback plumbing follows. GC is 2.5%, and allocation is only 9–10% above 0.46. Most hot sequence work is already value-elided. Failed nonexclusive arms drag 46.0% of Less rows, 42.7% generated Less, but only 8.5% CSS. | LANDED AS DIRECTION. Prioritize sequence call plumbing across dialects and residual speculation for Less; do not claim arrays, GC, trivia, or one deopt explains the gap. Quiet canonical timing is still required for release proof. |
| T04a | Retired prototype; no commit | A memoized table-IR effect proof removed a non-exclusive choice's mark/rollback when no arm could publish state before failure. Its first model went RED on the real emitted-vs-closure Less corpus: `at-rules.less` and `css-3.less` matched on value/span/expected/tree but leaked balanced-scan errors through a failed `node()`, proving that node-private CST/fields do not make `_errors` private. Propagating opaque error effects restored exact identity for all 16 CSS/Less/SCSS/Jess × AST/AST-lines/CST/CST-lines corpus lanes, including 2,408 SCSS files, and shrank emitted source by 1.51–2.77%. The first timing pass changed only that diagnostic emitter and was therefore correctly discarded as out of scope: canonical `compile()` and macro artifacts carry `asm:[]` and run closures. A shared analysis was then wired into BOTH closure and emitted assembly, with focused effect/error rollback tests (148/148) and the full 16-lane corpus still green. That meaningful exact-parent `5b8efa8` production A/B was flat with zero breaches: Less stylesheet -2.0%…+0.6%, Less mixins -1.3%…+0.5%, CSS -2.0%…+0.4%, GraphQL -2.2%…+0.8%, JSON -3.6%…+2.3%; load 5.35→4.36. The intended rollback-density rows were also flat with zero breaches: none -0.5%…+1.2%, sparse -1.0%…+2.9%, medium +0.0%…+2.5%, dense -0.5%…+2.4%; load 4.09→5.97. | REJECTED. Canonical parse time and every shelf stayed flat. The transient source reduction does not pay for a second subtle sink-effect lattice, its demonstrated error-state hazard, and permanent twin maintenance. The prototype and focused test were removed cleanly. |
| T05a | Retired prototype; no commit | Splitting `nextTerm` into a 117-byte dispatcher plus bare/untracked/tracked shared bodies made V8 inline the first layer but created a 724-byte nested-inline budget cliff. Full Less digest/consumption matched. Authoritative paired run: prototype 39.74 ms vs clean 39.45 ms (+0.7% slower); solo +0.3%. | MEASURED NULL / REJECT exact split. The prototype and temporary probe were removed; a follow-up must avoid the nested-inline explosion. |
| T05b | Retired prototype; no commit | Extending the closure assembler's fixed sequence pieces from arity 1–3 to 1–4 preserved focused sequence, table, emission, and nullable-effect parity (47/47) and passed typecheck. Against exact parent `19ade17`, it REGRESSED both Less production rows: stylesheet median +0.6%…+4.0% with 4/5 breached passes, and mixins +2.1%…+5.1% with 5/5 breached passes. Reference/reference controls were tight (worst median +0.8% / +2.1%); load was 3.81→6.11, but the paired sign was consistent across 57/60 and 59/60 comparisons respectively. CSS stayed -0.1%…+2.0%, GraphQL -3.3%…+0.3%, and noisy JSON +0.7%…+11.0%. | REJECTED. The generic loop is better for the documented wider Less sequences; static arity-4 site counts do not justify a larger fixed shared closure. The prototype was removed cleanly. |
| T09a | Retired prototype; no commit | A semantics-correct all-compatible-view oracle retained every prefix/same-token match in PEG order with zero winner mismatches. It found 140/4,167 prior failures eliminable on CSS (0.5% of actual entries), 8,170/23,856 on benchmark.less (9.4%), and 27,137/65,059 on generated Less (11.0%); the hot `Value` choice alone covered 7,734/7,927 and 27,119/30,430. A bounded canonical-closure prototype cached every matching row/end with no per-match object and unchanged Less `TableProgram` words, reducing that choice's retries to 193/3,311. Exact-parent two-graph timing nevertheless regressed benchmark.less +2.5% paired / +4.4% solo and generated Less +1.9% paired / +0.4% solo. A deliberate longest-only plant changed `a | ab` consumption 1→2 and broke probe; the corrected adversarial suites passed. | REJECTED IMPLEMENTATION, NOT ARCHITECTURE. Looping over existing native regex recognizers costs more than the eliminated wrappers. Retire the patch and require a shared fixed/trie/seeded kernel before another tokenized-PEG timing prototype. |
| T09b | Retired prototype; no commit | A seeded hot-`Value` kernel continued its exact-literal trie after the enclosing character gate's already-read lead, retained compatible prefix/equal accepts in PEG order, and let selected terminal pieces consume cached ends. It removed 3,846/28,665 literal calls, reduced trie continuation to 915/7,716 character steps, gated 5,166/17,629 other matcher calls, and reduced the hot mixin native regex from 5,338→172 / 17,641→12 on benchmark/generated Less. Sound-first-set and intermediate-accept plants made the oracle go RED; corrected suites, actual detached `origin/dev` Jess `build:release`, zero-fallback `check:macro`, and CSS/Less/generated full consumption passed. Three fresh processes × two parser graphs nevertheless measured benchmark Less +2.8%, +2.8%, +1.9% (center +2.8%, faster 0/3), generated +0.9%, +1.3%, +0.5% (center +0.9%, faster 0/3), and CSS flat with no selected site. TableProgram words were unchanged, but duplicated assembly analysis grew the package by 69,058 packed bytes (+2.24%). | REJECTED IMPLEMENTATION, NOT ARCHITECTURE. Correct seeding and wrapper elimination do not repay site-local trie/gate machinery. The next attempt must reuse existing terminal class operands and one fixed recognizer across raw, seeded, pending-result, and composite-node paths; no duplicate scanner metadata. |
| T09c | `/private/tmp/parseman-shared-escaped-ident-kernel-rejected.patch`; evidence in `/private/tmp/parseman-shared-escaped-ident-kernel-evidence.md` | One pure raw/seeded escaped-CSS-identifier recognizer used the existing regex constant index as its spec id, returned only an end position, and reread zero known-prefix characters on the seeded path. It matched native sticky-regex ends in 4,181,464 comparisons; capping hex escapes at five made the oracle go RED on `\\abcdef `. It replaced 5,350 native matcher calls on actual Jess CSS, 5,135 on Less, and 13,464 on generated Less, while every other regex retained the native fallback and `TableProgram` words stayed unchanged. Three fresh actual-Jess graph passes with matching controls nevertheless measured CSS +0.1% (0/3 faster), benchmark Less +0.9% (1/3), and generated Less −0.8% (2/3), all inside A/A movement. The package grew 12,656 packed and 60,326 unpacked bytes across three entries. | REJECTED IMPLEMENTATION, NOT ARCHITECTURE. Removing native recognition calls alone is flat and too large. Preserve the pure recognizer/pending-scalar interface for composite consumers, but require the consumer to remove downstream materialization or wrapper work before paying for another fixed kernel. The worktree was restored clean at `6a41da6`. |
| T09d | Evidence only; no production edit | A RED-proven exact f478/Jess93 closure census reconciled the dominant Less `Value` choice against current first-character gating with full source/reference/instrumented identity. Existing gates already avoid 15,452 / 69,428 earlier-arm entries. A complete direct `.`/`#` proof for the open `attempt(MixinReference)` arm can remove another 5,083 / 17,629 successful retries. The compatible-view TOKEN result removes a disjoint additional 2,651 / 9,490 and leaves 193 / 3,311 compatible retries, versus 2,844 / 12,801 for the complete CHARACTER candidate. | EVIDENCE / NO WINNER YET. Build both complete replacement bodies. TOKEN must reuse the lead as a seed, share fixed identifier/escape/interpolation, literal/sigil, color/keyword and numeric/dimension kernels, retain every accepting prefix, and pass cached ends to selected and rollback-later consumers. CHARACTER keeps the cheaper direct gate. Only production timing after semantic identity may select one. |
| T10a | CHOICE `d959883d`; combined DISPATCH `9ff15d7b` | Universal fixed-tuple binding replaced parse-time `arms[i]`, per-arm expected/gate/routed arrays and matcher arrays with direct scalar closure captures or hygienic emitted identifiers at every CHOICE and DISPATCH arity. Input-keyed character masks and exact/fold maps remain dynamic; their result selects a direct switch/chain. Emitted expected catch-up is one site-local O(n) fallthrough; n>32 constructs no mask body; malformed dispatch/mask plans refuse in closure, emitter and precompiled paths. Full tests, strict differentials, exact Jess CSS/Less/generated source/reference/closure/emitted identity and CSP/module/fold/reentry/cut/sink teeth passed. Combined package cost versus f478 is +37,823 packed / +299,743 unpacked bytes. A RED-proven isolated one-graph closureArtifact benchmark.less gate (16 alternating A/A+A/B pairs, exact SHAs/realpaths, 106,802-byte consumption and full digest/TableProgram identity) was statistically flat: aggregate control-adjusted +0.448% slower, paired control-adjusted −0.891% faster, with overlapping dispersion and contradictory reducers. | STRUCTURAL FOUNDATION / MEASURED NULL STANDALONE. The result does not justify package cost or a SEQ expansion by itself, but it also does not reinstate fixed grammar arrays: preserve the direct-binding checkpoint for the replacement-only TOKEN integration, where a classified token can enter its fixed target without another indexed lookup. Re-evaluate the combined artifact after retry elimination; do not land or claim a speed win from T10a alone. |
| T11-map | Retired diagnostic; no production commit | A captured-macro harness printed both engine/source realpaths, proved full consumption and digest identity, and was shown RED by replacing the reference entry with `OP_EMPTY` (0/106,802 bytes consumed). The exact Less macro had 171 choices/562 arms/459 classed/103 open, 741,758 rows, 98,647 ordered arm entries, 55,964 failures, and 340,522 rows inside failed arms. The hottest IP was `blockBody` at 104,476 failed rows; its `atStatement` arm's eleven independently exact, nonnullable `@` choices collapsed to `any`/nullable because the first-set `seen` set confused a completed shared DAG node with a recursive back-edge. | DIAGNOSTIC COMPLETE. The counters and harness were removed after identifying a source-level cause; keep the exact production fix and its permanent tests, not the instrumentation. |
| T11a | `531116c`, size follow-up `3095619`, merged as `5901774` | Treating `seen` as an active recursion stack preserved safe fail-closed handling of real back-edges while classifying shared DAGs exactly. On the same captured Less macro, classed arms rose 459→479, open arms fell 103→83, rows fell 741,758→682,870 (-7.9%), failures fell 55,964→36,906, and failed-arm rows fell 340,522→201,951 (-40.7%); full consumption and digest stayed exact. Forced-load, interleaved two-graph screening against the exact parent measured benchmark Less -9.7% and generated Less -11.6%, with same-source drift about 0.5–2.4%; these relative numbers are integration evidence, not the quiet canonical release proof. A compact emitted class pool then made all 24 size cases pass and banked 298 raw bytes overall, while some gzip rows rose slightly. Full tests, typecheck, lint, invariants, build, size guard, and all six strict planted differentials passed. | LANDED. Deterministic work reduction, material relative wins, raw-size improvement, and stronger first-set correctness justify the change even under a loaded-machine timing caveat. Residual overlap stays in T11 and the 0.46 release bar remains open. |
| T11b | `11dd984` | Separator-less optional repeats now reuse ip+7 and an already-pooled exact finite/nonnullable item class (index <100) to reject excluded leads before marks, child entry, or token work. Row width, program words, and runtime table bytes are unchanged; 13/45 CSS and 25/110 Less repeat sites bind. Exact-parent five-pass CSS was flat (−1.9%…+4.3%, 1/5 breaches; control worst +2.9%). Less stylesheet was −15.0%…+2.1% with 54/60 paired wins and 0/5 breaches; mixins −11.3%…−4.9% with 55/60 wins and 0/5; controls +2.1/+2.0%. Generated Less was suggestive −3.5% under moving load, not a release claim. The permanent six-test suite proves structural binding/declines, row width, tolerant/probe bypass, AST/CST/trivia/expected/commit parity across emitted/closure/reference, and includes a cloned-artifact RED plant. Size guard remained 24/24 green. | LANDED. This is a size-neutral, token-compatible Less win and a port of the old generated repeat-loop first-set check. It is intentionally bounded: both the broader +1-word form (size failure) and the artifact-neutral derived-class form (flat timing, T11c) were rejected. |
| T11c | Retired prototype; no commit | A zero-word `-2` operand derived exact repeat-item classes once at assembly from closed dispatch metadata, expanding separator-less CSS guard coverage from 13/32 to 24/32 while keeping 6,066 words and 109 classes. The stabilized three-pass workload screen rejected both shapes: broad derivation measured CSS +1.5%, Less stylesheet +1.1%, mixins +0.2%; restricting to nonexclusive child choices measured CSS +1.4%, Less stylesheet −0.1%, mixins −1.2%. Actual Jess table-reference screens were flat/small (CSS −1.6% versus A/A +2.9%, benchmark Less −0.9%, generated Less −1.9% versus A/A −0.7%); macro source A/B failed before timing at the independently recorded `composeLeaf` precondition and was not replaced with a stale number. Size guard, focused parity/recovery tests, and invariants were green. | REJECTED. Additional repeat coverage is exact and size-neutral but does not move CSS or either Less release bar. Keep the simpler pooled-class guard; do not add derived dispatch plumbing for a flat result. |
| T12a | `d78ea9f` (feature lane `61c73a1`) | The encoder recognizes only an exact array-destructuring child projection such as `([, value]) => value` and stores `~childIndex` in the existing `OP_SEQX` reducer operand. Reference exec, closure assembly, and emitted assembly return the already-parsed child without allocating the reducer input array or calling a callback; all other callback syntax declines. JSON covered one static site / 3,303 calls (23.4% of callbacks), retained 138 words, and reduced its function pool 9→8. GraphQL covered six sites / 1,176 calls, retained 495 words, and reduced 27→21 functions. Five independently recompiled passes measured JSON −4.1% median / −4.2% min, faster 5/5 with 59/60 paired wins versus A/A +0.6%/+0.4%; GraphQL was flat at −0.1%/−0.5%. The tightest GraphQL comparison margin remained 1.56× over Chevrotain against a 1.05× floor. Built main/table ESM each grew 1,525 raw bytes; npm pack grew 8,265 bytes (+0.267%). A wrong-index plant returned the wrong child; permanent tests pin interpreter/reference/closure/emitted/macro identity and refusal cases. Full 3,890-test, typecheck, lint, invariants, and all six strict differential gates passed. | LANDED. This is a bounded secondary JSON win with zero program-word cost and neutral GraphQL behavior. It does not move CSS/Less release bars and does not change their priority. |

## Current production-shaped 0.46 shelf audit — actual Jess at `f3b4c3f`

The fresh release checkpoint measured source-identical Parseman
`0385764da4c8cf2aa00bb970d7a4420f1fab7d5e` and
`2a8c381fb056f57f8d8ba515d7e9c781ec377357` against pinned 0.46
`a5dc9bd20a5cc509eb516c36cc46ca10c00c82f3`
on exact Jess `f3b4c3fa1917bc2a1b4e5bd7f0e4b7992b64a002`. The timing checkout was
detached `/private/tmp/parseman-048-pinned-baseline`; the only commits between its
`0385764da4c8cf2aa00bb970d7a4420f1fab7d5e` and the current
`2a8c381fb056f57f8d8ba515d7e9c781ec377357` changed
these evidence documents, with no `src/` diff. Node was v24.11.1 on darwin/arm64.

The authoritative `bench/jess/ab.ts --two-graph` release A/B built exactly two
independent grammar graphs and interleaved adjacent, order-alternated pairs. Both
sides requested the shipping macro: HEAD realized `macro→closure-table`; 0.46
realized `macro→source`. That is intentionally a release comparison of what each
version ships, not an engine-held-still attribution. Each result is the median of
16 samples (eight rounds × two runs), each sample the median of five one-parse
timings after three warmups. Matching `--self --two-graph` runs supplied the A/A
floor without adding a confounding third graph.

| Fixture | HEAD / 0.46 | ratio | paired-round median and range | HEAD wins | matching A/A |
| --- | ---: | ---: | ---: | ---: | ---: |
| CSS `benchmark.css` (123,029 B) | 13.84 / 5.56 ms | **2.488x (+148.8%)** | 2.488x; 2.046–2.631x | 0/8 | 1.004x (+0.4%); paired 0.993x, 0.953–1.046x |
| Less `benchmark.less` (106,802 B) | 33.79 / 17.98 ms | **1.879x (+87.9%)** | 1.898x; 1.658–1.934x | 0/8 | 1.020x (+2.0%); paired 1.020x, 0.997–1.029x |
| generated Less (275,211 B) | 94.89 / 49.56 ms | **1.915x (+91.5%)** | 1.917x; 1.875–1.955x | 0/8 | 1.017x (+1.7%); paired 1.020x, 1.007–1.029x |

Both legs parsed each literal fixture in full: 123,029/123,029,
106,802/106,802, and 275,211/275,211 bytes respectively. The fixture SHA-256
values were `5e6bf8603c661099f1f4b1988441fdfa96da2f784654027f945f7b76c027ed74`,
`abe392656c8a50e9d175c3b0e60415893a8eb7bfe9050518227391430d3a3d48`, and
`e605bdb1b6d46ab1c4e117cab434d6e4b3fc9e463aba56a2b70bce871aecd945`.
The generated fixture was reproduced with the checked-in `gen-workload.mjs`
defaults before measurement.

The printed source realpaths were
`/private/tmp/parseman-048-pinned-baseline/src` and
`/private/tmp/parseman-048-pinned-baseline/.cache/jess-ab-a5dc9bd/src`.
Jess resolved to `/private/tmp/jess-token-stream-origin-dev`; its CSS and Less
`grammar.ts` files and `packages/parser-shared/src` resolved under that same root.
The preflight proved `@jesscss/core` source/lib agreement across 104 runtime
exports. A/A loads were 5.13→5.76 for CSS and 5.62→4.74 for the two Less rows;
A/B loads were 4.07→3.91 and 3.99→5.02. All starts were below the ceiling of 6,
and the paired/solo cross-check emitted no pairing-artefact warning.

The exact Parseman/Jess pins were also run through Node 24
`check:differentials --strict`; all six registered differentials caught their
planted defects, including the `exec-node-span` Jess oracle and the
short-consumption `interp-many-cap` sweep. The plants restored cleanly. The
two-graph timing deliberately does not add an interpreter graph, so this block
claims full acceptance/consumption and RED-proven harness teeth, not a new
three-way semantic-identity result.

All three production-shaped shelves remain. The current gaps are materially
smaller than the earlier roughly 3.2–3.4x standard-workload checkpoint, but none
is close to the 1.0x release bar and no named 0.47 shelf is removed.

## Historical standard-workload 0.46 shelf audit — literal EOF corrected at `e5247da`

`5fee4ef`, integrated as `e5247da`, repaired the standard workload instrument
before this audit. The CSS and Less document roots now consume their permitted
trailing trivia, and one shared fail-closed validator rejects a failed parse, a
missing span, a non-zero start, a non-null `unconsumedFrom`, or a span that does
not end at the literal input length. It runs outside the timers on **every fresh
reference, candidate, calibration, and pass instance**. The corrected lengths are
53,483/53,483 for Less stylesheet, 60,638/60,638 for Less mixins, 65,554/65,554
for CSS, 49,762/49,762 for GraphQL, and 60,323/60,323 for JSON on both legs.

The historical canonical result for that standard-workload checkpoint is the
unmodified primary `e5247da` gate against pinned
0.46 `a5dc9bd`: five independently recompiled passes, four rounds × three runs,
six warmups + eleven timed samples, paired and order-alternated, with a same-position
reference/reference control. Head loaded `src/table/compile.ts` and
`src/table/assemble.ts`; reference loaded `.cache/workload-perf-guard-a5dc9bd/src/compiler/codegen.ts`;
both loaded byte-identical copied `bench/workloads/index.ts` and example grammars.
Every candidate row lost 0/12 pairs in every pass and breached 5/5. Load was
4.25→6.63. These are historical release-audit figures, **not** lower baselines,
shelf ceilings, or the current actual-Jess checkpoint above.

| Surface | Canonical `e5247da` center (median / min) | Five-pass range (median / min) | Same-source A/A | Disposition |
| --- | ---: | ---: | ---: | --- |
| production `less/stylesheet` | +219.5% / +231.2% | +210.7%…+227.4% / +215.5%…+235.8% | 36/60 control wins; worst median −0.1% | Shelf remains; roughly 3.2× 0.46. |
| production `less/mixins` | +226.8% / +225.7% | +210.7%…+235.9% / +213.5%…+232.9% | 33/60; +0.8% | Shelf remains; roughly 3.3× 0.46. |
| production `css/stylesheet` | +238.9% / +305.3% | +175.1%…+303.9% / +192.8%…+312.0% | 25/60; +17.4% | Shelf remains. The all-loss result is decisive; the absolute center is not sharp. |
| production `graphql/document` | +106.1% / +108.2% | +91.0%…+112.3% / +106.3%…+113.4% | 32/60; +1.5% | Shelf remains; roughly 2.1× 0.46 in this run. |
| production `json/document` | +123.3% / +121.7% | +119.6%…+124.4% / +120.2%…+130.2% | 29/60; +1.2% | Shelf remains; roughly 2.2× 0.46. |
| density rollback axis (`5901774` audit) | median +135.5%…+273.2%; min +144.4%…+293.6% | — | — | All four named rows remain strict regressions, inside their ceilings. |
| density expected axis (`5901774` audit) | median +80.2%…+152.8%; min +105.1%…+157.2% | — | — | All three named rows remain strict regressions, inside their ceilings. `expected/wide` improved most from its 0.47 +373.2%…+424.5% envelope. |
| toy CSS compiled bars (`5901774` audit) | `decls` +67.3%; `selector` +104.0% | — | — | Both original-baseline shelves remain. |

### Provenance-rich raw replication

A second, print-only run used detached `/private/tmp/parseman-shelf-raw-e524` at
the same `e5247da`. Its only change printed provenance and the already-produced
`passRows`; it changed no grammar, compiler, timing loop, thresholds, or ordering.
Before any number it resolved Node to
`/opt/homebrew/Cellar/node/25.9.0_3/bin/node` (v25.9.0), the loader to
`/Users/matthew/git/oss/parseman/node_modules/.pnpm/tsx@4.22.5/node_modules/tsx/dist/esm/index.mjs`,
head to `src/table/compile.ts` + `src/table/assemble.ts`, reference to
`.cache/workload-perf-guard-a5dc9bd/src/compiler/codegen.ts`, and each workload
module to its corresponding `bench/workloads/index.ts` realpath. Load was
3.45→3.44; calibrated repetitions were 1/2/4/10/16 in table order. All rows again
lost 0/12 in every pass and breached 5/5.

| Surface | Per-pass median deltas | Per-pass min deltas | Replication center |
| --- | --- | --- | ---: |
| `less/stylesheet` | +225.93, +219.28, +212.22, +227.93, +231.12% | +232.87, +222.76, +226.74, +240.56, +237.04% | +225.9% / +232.9% |
| `less/mixins` | +223.68, +222.01, +207.77, +225.41, +230.18% | +227.49, +226.99, +210.85, +225.73, +226.85% | +223.7% / +226.9% |
| `css/stylesheet` | +300.43, +299.15, +161.83, +293.26, +290.01% | +309.20, +312.39, +201.24, +316.93, +311.30% | +293.3% / +311.3% |
| `graphql/document` | +75.67, +83.99, +78.80, +73.34, +78.74% | +78.55, +81.20, +76.39, +76.74, +79.91% | +78.7% / +78.5% |
| `json/document` | +120.54, +117.74, +120.88, +117.33, +118.35% | +118.89, +120.18, +118.77, +123.85, +123.84% | +118.3% / +120.2% |

Replication controls were 32/60 wins and +2.4% worst median for Less stylesheet,
31/60 and +0.4% for mixins, 21/60 and +6.5% for CSS, 27/60 and +0.4% for
GraphQL, and 25/60 and +1.3% for JSON. CSS's center moved +238.9→+293.3%
between complete runs and GraphQL moved +106.1→+78.7%, so neither absolute
center is release-grade precision. That does **not** weaken the conclusion:
across the two corrected runs each lost 120/120 pairs and breached 10/10 passes.

### Retired partial-span rows — historical direction only

The earlier `282c978` headline (+216.9% Less stylesheet, +226.5% mixins,
+252.0% CSS, +103.4% GraphQL, +129.9% JSON) and code-equivalent
`60610fc`/`aae9b30` replicates (Less stylesheet +213.2/+224.6 and
+216.3/+220.4%; mixins +221.9/+222.0 and +228.6/+228.2%; CSS
+289.6/+305.8 and +286.7/+286.7%; GraphQL +99.5/+107.5 and
+101.1/+104.2%; JSON +125.1/+127.3 and +124.5/+125.9%) passed only
cross-leg result equality. Less stylesheet stopped at 53,482/53,483, mixins at
60,637/60,638, and CSS at 65,553/65,554 on **both** legs. Those rows remain
historical evidence that every shelf pointed in the same direction; they are not
absolute measurements, release proof, baselines, ceilings, or inputs to a
replicate-center midpoint.

An exact-parent attribution gate compared integrated `aae9b30` directly with
pre-projection/materializer `6f34165` on these same five standard workloads, again
with five independent recompiles and the same then-current identity check (including
the three one-byte trailing-newline failures above). It measured CSS **+1.0%**,
Less stylesheet **+0.9%**, mixins **+1.3%**, GraphQL **−1.0%**, and JSON **−2.2%**.
Thus the integrated pair is flat on the standard CSS/Less surfaces and gives a small
consistent JSON win; the larger terminal-node result remains specific to the actual
Jess CSS grammar where its eligible population is much denser. This attribution is
mechanism evidence, not a new baseline and not a substitute for the absolute rows.

No one of the fourteen 0.47 shelf entries is eligible for removal yet. The
shared-DAG/repeat, direct projection, and terminal-node changes are retained for
their exact work reduction, correctness, bounded relative wins, and/or size effects,
not because any one of them meets the absolute release bar. At `e5247da` this
corrected standard-workload audit was a checkpoint, not final release proof:
scope correctness/performance work was still pending, and its five-row gate did
not contain Jess `benchmark.less` or the separate generated-Jess fixture. The
fresh actual-Jess audit above now supplies those production-shaped rows without
deleting or relabelling this historical standard-workload evidence.

## Handoff worktrees

| Worktree | Branch / base | Preserved state | Next action |
| --- | --- | --- | --- |
| `/private/tmp/parseman-048-early-reject` | `perf/0.48-early-reject` at `9a5d52d` | Clean committed C01 fix and regression matrix; integrated into `release/0.48.0` by merge `b938fa4`. | Preserve as the reviewed correctness lane; performance work may now integrate independently. |
| `/private/tmp/parseman-048-sequence-fusion` | `perf/0.48-sequence-fusion` at `ac1bf7b` | Clean; rejected assembly prototype and temporary probe removed. | Keep only as historical branch context or remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-ungated-map` | `perf/0.48-ungated-map` at `3095619` | Clean; production first-set and compact-class-pool commits integrated into `release/0.48.0`; diagnostic counters and captured-macro probe retired. | Preserve through review, then remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-terminal-inline` | `perf/0.48-terminal-inline` at `2c3fb4f` | Clean; rejected literal/regex sequence-child inline prototypes and temporary census removed. | Keep only as historical branch context or remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-effect-proof` | `perf/0.48-effect-proof` at `5b8efa8` | Clean; rejected rollback-effect prototype removed after full emitted/closure corpus identity and exact-parent timing. | Keep only as historical branch context or remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-seq-arity4` | `perf/0.48-seq-arity4` at `19ade17` | Clean; rejected arity-4 fixed sequence prototype removed after a paired production regression. | Keep only as historical branch context or remove the worktree during release cleanup. |
| `/private/tmp/parseman-048-fixed-rx` | `perf/0.48-fixed-rx` at `44f6393` | Clean; both the ineligible single-range screen and the correct but measured-null JSON-number scanner were removed with no commit. | Reused only as the owner lane for the separate token-cursor feasibility audit; do not revive the fixed-regex prototype. |

## Updating this ledger

- `RUNNING`: an isolated lane exists and has an owner.
- `MEASURED WIN`: paired evidence beats clean 0.48 and moves toward or beyond
  0.46 without violating correctness, architecture, or size constraints.
- `MEASURED NULL`: result is inside the same-source noise envelope.
- `REJECTED`: slower, incorrect, too large, or violates the canonical path.
- `LANDED`: merged into `release/0.48.0` with gates and evidence.

Do not delete rejected rows or silently relax the required evidence.
