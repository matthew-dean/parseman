# Changelog

All notable changes to **Parseman** are documented here, grouped by minor version
(newest first). This project is pre-1.0, so minor bumps may carry breaking changes.

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

- **`expect()`** required-token combinator with `staticExpected` and
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
