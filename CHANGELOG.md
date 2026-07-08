# Changelog

All notable changes to **Parseman** are documented here, grouped by minor version
(newest first). This project is pre-1.0, so minor bumps may carry breaking changes.

## 0.18.2 — 2026-07-08

- **Interpreter hot-path pass.** Faster regex/literal matching, choice dispatch,
  trivia skipping, wrapper combinators, and optional misses improve interpreted
  parser timings across the example grammars.
- **Benchmark guard cleanup.** The perf guard now checks actual median speed
  regressions instead of treating a smaller compiled-vs-interpreted ratio as a
  failure when the interpreter gets faster.
- **Benchmark refresh.** Updated README/docs and SVG charts for the refreshed
  parser and CST comparison numbers.

## 0.18.1 — 2026-07-07

- **Friendlier labeled failures.** `label()` now controls the expected text for
  normal parse failures in both interpreter and compiled modes, so user-facing
  errors can say `string` or `number` instead of leaking raw regex source.
- **Diagnostics parity coverage.** Added interpreter-vs-compiled tests for
  expected sets, literal quoting, custom `expect()` labels, and `recover()`
  parse-error spans.

## 0.18.0 — 2026-07-07

- **`token()` combinator.** Treat a contiguous parser region as one source-text token:
  internal trivia is disabled, the value is the matched source string, and `node()`
  captures one CST leaf for the full span. The macro compiler can collapse safe
  nullable terminal runs inside `token()` (`many`, `optional`, `sepBy` over
  literals/regexes) to one regex, while keeping the one-token value/CST contract.
- **`expect()` derives literal labels.** `expect(literal('}'))` now derives the same
  expected text you would have written by hand; custom labels remain unquoted
  user-facing labels. The old `staticExpected` export was removed from the public API;
  expected-label derivation is internal.

## 0.17.0 — 2026-07-06

Theme: **macro-compiled parser size reduction.** Reference target is the Jess
`less-parser`, which fell from **5.30 MB to 1.07 MB (−79.8%)** across this line of
work — the fused `rules()` source it compiles is only ~32 KB, so this closes most of
the gap between compiled artifact and grammar source. Parse speed sits ~12% under the
pre-hoist baseline (the accepted hoist trade) and is still 6–7× the interpreter; the
full Jess CSS parse measured **~24% faster than 0.16.0** on a 220-file / 492 KB
corpus.

- **Identity-hoist shared combinators.** A compound combinator referenced from many
  places is now emitted once as a shared `_pf` fn and referenced, instead of pasted
  inline at every reference — killing the worst inlining explosions (e.g. the 786 KB
  `calcBody` blowup in Less). less-parser 5.30 → 2.50 MB. Costs a one-time ~11% parse
  hit (the hoisted call); gated by `test/unit/hoist-shared-explosion.test.ts`, which
  trips if expansion regresses from ~2× back toward the old ~19×.
- **Carry compact IR, re-lower at fuse.** `compose()`d artifacts now carry the
  compact `rules(g => …)` combinator expression as `{ ns, ir }` and re-lower it at
  fuse time, instead of carrying ~1 MB of already-lowered `_r_<Name>` source. Two
  supporting pieces: an IR serializer for rule maps, and emitting shared consts
  *inside* the `rules()` factory scope so the round-trip is self-contained
  (`test/unit/ir-serialize.test.ts`). less-parser 1.98 → 1.22 MB — build-time only,
  no runtime cost.
- **Live-spread ancestor pieces.** An imported grammar's compose-pieces are now
  referenced off its live binding (`[...cssGrammar[Sym], delta]`) rather than
  re-serialized into the deriving grammar; works in both interpreted and macro mode.
  less-parser 2.29 → 1.98 MB, free.
- **Strip carried-pieces indentation.** Dead pretty-printer whitespace in the
  machine-consumed carried source is dropped. less-parser 2.50 → 2.29 MB, free.
- **Drop `_pfok` flag from named-fn wrappers.** A named-fn wrapper now returns the
  value directly on success and falls through to `_pfFail` on failure, instead of
  threading a `_pfok` success flag. Neutral perf.
- **Intern identical `_mf` map closures.** `balanced()` merge closures with
  byte-identical source now share one `_mf` slot (40 → 2 in Less) instead of emitting
  one per call site. Free.
- **fix: recover first-char dispatch from a deep, ref-resolving first-set.** A
  `choice` arm whose first-set is only knowable after resolving through a chain of
  rule references used to fall back to an `any` first-set (every token tried). The
  compiler now resolves through the reference chain and recovers the dispatch guard.
  Correctness + dispatch fix; +2 tests.

## 0.16.0 — 2026-07-06

- **Case-insensitive (`/i`) regex lowering.** The scannable fast path (regexes that
  compile to a `charCodeAt` scan instead of `RegExp.exec`) now covers `/i`. Two
  extensions: (1) keyword-plus-boundary regexes under `/i` — e.g. an
  `/(if|else)(?!\w)/i` keyword set — now lower to a scan, where previously only a
  pure case-insensitive *literal* (`litFold`, e.g. CSS `url(`) did. (2) the case-fold
  itself is now a branch-free ASCII bit-OR (`c | 0x20`) rather than `toLowerCase` /
  `Intl.Collator` — **`Intl.Collator` is removed from the codegen path entirely**.
  ~1.75× on `litFold` scans. (`/i` on char *classes* — folding `[a-z]`↔`[A-Z]`
  ranges — still declines to `exec`; that's the remaining `/i` gap, tracked as §8d.)
- **Switch-dispatch for scannable alternations.** A `choice`/alternation whose arms
  are all scannable now compiles to a `switch` (jump table) on the first code point
  instead of trying each arm in sequence: disjoint scannable alts dispatch straight
  to the one matching arm, and an alt-of-`litFold` (case-insensitive keyword set)
  folds each arm's first char before the switch. ~2.4× on alt-of-`litFold`.
- **Codegen: arity-gated CST/trivia bookkeeping in structural `node()`.** The
  `_cstTriviaLog` append and parse-state capture inside a structural `node()` are now
  emitted only when the node's arity actually needs them — a node that can't carry
  trivia or child state no longer pays for the bookkeeping.
- **Plugin: opt-in un-lowered-regex warning.** The bundler plugin can now warn when a
  `regex()` in your grammar falls back to `RegExp.exec` instead of lowering to a
  `charCodeAt` scan — a diagnostic for finding fallback hot spots (e.g. a pattern
  that would lower if respelled). **Default off**; enable it via the plugin option.

## 0.15.0 — 2026-07-05

- **Grammar rule names must be valid JS identifiers.** They compile to `_r_<Name>`
  functions and dispatch guards, so a non-identifier key (e.g. `'my-rule'`) is now
  rejected at compile time with a clear error instead of being silently mangled to
  `_r_my_rule` (which could collide with a real `my_rule` rule). Only affects
  grammars that used non-identifier rule names — none in practice.
- **First-char dispatch for composed grammars.** A `choice` arm that references a
  rule in another `compose()`d artifact used to carry an `any` first-set, so every
  arm was tried per token (a value/selector rule walked all its alternatives). The
  compiler now emits a fuse-time-resolved dispatch guard for such arms — resolved
  against the **winning** rule's first-set, so it stays correct even when a later
  artifact **overrides** a rule with a different first-set (open recursion). Each
  linkable artifact carries a per-rule first-set table; `fusedBody` substitutes the
  guards at fuse time. Measured ~30% faster parse on a macro-compiled Less grammar
  (15-arm value rule + many selector choices); see `bench/compose-dispatch.ts`.
- **fix: sound sequence first-set.** `sequence()` computed its first-set from the
  first term alone, ignoring that a **nullable leading term** (`optional(…)` /
  `many(…)`) lets a later term's first char start the whole sequence. That
  under-approximated the first-set, so first-char dispatch could silently drop a
  valid parse (e.g. a Less `@{x}{}` interpolated selector). Now unions through the
  nullable prefix (`matchesEmpty` + `sequenceFirstSet`), a sound over-approximation.
- **perf: dead-value elision.** A `many` / `oneOrMore` / `sequence` whose aggregate
  value is only discarded under a `node()` (which builds from captured children) no
  longer builds that array/tuple — on both the interpreter and the compiled path
  (shared `markUnusedValues` analysis). Trees are identical; ~7% less transient
  allocation on a real Less parse. (`optional` builds no aggregate, so it's a
  no-op there — but a `many`/`sequence` *inside* an `optional` under a node still
  elides.)

## 0.14.1 — 2026-07-05

- `run()` throws a clear `TypeError` when the start production isn't a rule
  (e.g. a missing grammar rule name resolves to `undefined`), instead of the
  opaque "Cannot read properties of undefined (reading 'parse')".

## 0.14.0 — 2026-07-04

- **`compose()` is the one composition API — no base source needed.** A grammar
  carries its compiled, composable "pieces" **on the exported value** (under a
  well-known symbol), so `import { grammar }` is all a downstream package needs.
  The macro fuses `compose([...])` at build time into static, `eval`-free source
  (open-recursive override, `pick()` à la carte); chains are re-composable.
- **Removed fragment-spread composition** (added in 0.13.0). `...frag(g)` spreads
  and the build-time **source resolver** that read a fragment's `.ts` are gone —
  `compose()` replaces both. `linkable()` is internal, not a public API.
- **Rule ABI / build-time linker.** Rule-map rules compile to canonical
  `_r_<Name>` functions with a dependency manifest, fused into one closure of
  direct calls. All hoisted names (incl. trivia fns) are namespaced per piece so
  two composed grammars can't collide.
- **`run(entry, input, opts?)`** — a generic driver: invoke a compiled-fn or
  combinator entry, thread the framework ctx, and report unconsumed input after
  the grammar's own trivia. Closes the "run a rule + require full input" gap.
- **Structural `node()`** — the `build` callback is optional; omit it to build via
  the injected `ctx.build` host (one grammar → its own AST or a positioned CST).
  `pick()` now accepts grammars.
- **Sound incremental re-parsing.** `parseDoc().edit()` re-enters at rule
  boundaries with a lookahead guard and is capped at roughly one full reparse
  (near-whole-document edits skip re-entry). Backed by a new
  trivia-offset-inference model that uses the positioned tree as its index.
  Still marked **experimental**.
- **Modes** via a `ctx.build` host with runtime callback injection; `parseDoc`
  threads the build host through three CST drivers.
- `regexp-tree` isolated behind a first-set analyzer seam.
- perf: lower trailing non-disjoint-alt groups (§8h).

## 0.13.0 — 2026-07-03

- **Grammar composition in the macro** — inline fragment spreads.
- Renamed `makeFunctionalDoc` → `parseDoc`.
- Unit coverage ratcheted to ~97% with a CI guard.
- CI/build hardening: build `dist` via `prepare` on install, build before
  typecheck, pin pnpm via `packageManager`, add MIT `LICENSE`.

## 0.12.0 — 2026-07-03

- **codegen:** lookahead boundaries, alt/choice dispatch optimization, and a
  keywords fast path.
- Failure-diagnostics parity between interpreted and compiled paths.
- Generalized regex lowering to `seq` chains (with CI); raised the literal
  `charCodeAt` chain threshold to 16 chars.
- docs: Chevrotain comparison page, pronunciation guide, import-attributes note.

## 0.11.0 — 2026-07-02

- **CST walk & list-recovery combinators.**
- Benchmarks: incremental re-parse vs Lezer, macro output-size docs.
- Node arity elision now sees through TS parameter annotations.
- Favicons, parser-comparison page.

## 0.10.0 — 2026-07-02

- VitePress documentation site and refreshed benchmarks.
- **Node arity elision** — a wrapper rule collapses to its single child.
- Optimized trivia choice paths.

## 0.9.0 — 2026-07-01 → 0.8.1

- Fast char-scan trivia path generalized to derive from regex *structure*
  rather than hardcoded shapes, extended to any scannable-shape set.
- codegen: share one codegen pass across a `rules()` map; inline single-use refs.
- Restored tight compiled trivia/CST output (reverted a ~2.3× regression).

## 0.8.0 — 2026-06-26

- **`expect()`** required-token combinator with derived expected labels and
  furthest-fail reporting.
- **`balanced()`** is now predictive: it cuts after the open delimiter and
  reports an unmatched close instead of char-walking via `scanTo`.
- Machine-independent perf-ratio guard, enforced as a pre-commit hook.

## 0.7.0 — 2026-06-25

- **`noTrivia()`** combinator; fixed CST-capture rollback on failed parses.
- Fixed nested balanced braces (0.7.1).

## 0.6.0 — 2026-06-25

- **Breaking:** removed the class-based `Parser` API in favor of
  macro-compilable grammars.
- Documented `compile()` CSP limits; expanded Chevrotain benchmark output.

## 0.5.0 — 2026-06-24

- Large API cleanup and removal of the class pattern.
- Compiled node builds: inline `transform()` callbacks and `mk()` node
  construction at compile time; specialize compiled trivia to `charCodeAt` scan
  loops for the CSS read-write shape.
- Interpreted/compiled `_triviaLog` parity; CSS perf harness;
  parseman-wide perf tracking with a baseline and history.

## 0.4.0 — 2026-06-24

- Reworked `word()` API and cleaned up docs.
- String-optimization tuning to beat Peggy; Chevrotain JSON comparison benchmark.

## 0.3.0 — 2026-06-23

- Flat-array trivia log with `word()`/`wordContext()` helpers.
- CST-capture bug fixes; `node()` save/restore context instead of spreading.

## 0.2.0 — 2026-06-23

- Macro plugin inlines `transform()` callbacks.
- Honest benchmark modes (macro build / with `.compile()` / no compile), with
  stacked bars showing parse vs compile overhead; performance parity with Peggy.
- GraphQL parsing examples.

## 0.1.0 — 2026-06-21

- Initial implementation: parser-combinator runtime, compiler, line/column
  tracking, and the unplugin-based build pipeline.
- Macro plugin with `sepBy` inlining and `oxc-parser` migration.
- CST `rawChildren`/trivia and a benchmark suite. Renamed to **Parséman**.
