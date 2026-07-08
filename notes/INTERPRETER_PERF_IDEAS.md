# Interpreter performance ideas

Library-level opportunities for faster interpreted parsers. Keep this separate from `PERF_IDEAS.md`: that file is mostly about generated code shape, while this one is about the runtime combinators in `src/combinators/*`, `src/cst/*`, and `src/functional/run.ts`.

## Already landed

- **`node()` lazy capture** — `capture-buffer.ts` defers `children` / `rawChildren` / `triviaLog` array allocation until the first push, with a scalar fast path for one child. This is interpreter-specific and should stay here, not in the macro backlog.
- **Dead aggregate elision** — `markUnusedValues()` marks `sequence` / `many` / `oneOrMore` values that are only used for CST capture; the interpreter skips those arrays. Measured from the compiled Less work: this saved allocation but did not move parse time much, so do not expect it to be the main interpreter lever either.
- **Arity-gated node work** — `node()` disables per-node trivia capture when the build callback does not read the trivia argument, and skips state cloning when the build does not read state.
- **Runtime choice strategies** — `choice()` already has disjoint first-set dispatch, `greedyClassify`, `literalsLongestFirst`, and `autoNot`. The interpreter is not purely naive ordered choice anymore.
- **Short-run regex scanner for char-class runs** — `regex()` now recognizes only simple `[class]+/*` and `\d`/`\w`/`\s` run shapes locally, with a 64-char cutoff back to native `RegExp.exec`. Same-session `pnpm bench:parseman -- --only=json,csv,graphql,toml,lang,css --scale=0.2 --samples=7` before → after: JSON large **493→422µs**, TOML medium **78→68µs**, CSV large **363→352µs**, GraphQL large **592→598µs** (noise/slight loss), lang medium **21.3→20.1µs**, CSS bootstrap **54.0→52.7ms**, CSS decls **25.1→23.6µs**. A broader recursive `ScanShape` interpreter was tried first and rejected: measured against the committed baseline it regressed many interpreter rows, especially CSS, and importing `scannable-run.ts` bloated a lean `regex` bundle to ~28 KB, so this landed as the smaller local chars-only version (~5.5 KB lean bundle, no `regexp-tree`).
- **Literal/choice/trivia wrapper pass** — `literal()` now uses `startsWith(value, pos)` for case-sensitive probes and slices only after success; `choice()` precomputes an ASCII dispatch table for already-disjoint arms; unlabeled trivia gets a tiny cached scanner for whitespace and CSS block comments; wrapper spreads in `transform()` / `skip()` / failed `label()` are explicit objects now. Fresh baseline before this pass → kept set: JSON large **433→369µs**, TOML medium **68.2→62.6µs**, GraphQL large **604.6→589.8µs**, CSS bootstrap **54.3→52.8ms**, lang medium **20.45→20.34µs**, CSV large **357→360µs** (noise/slight loss).

## High priority

### ~~1. Interpreter regex scan lowering~~ (partial ✅)

Compiled parsers lower many `regex()` terminals to direct `charCodeAt` loops via `scannable-terminal.ts` and `scannable-run.ts`; the interpreter now does this for short simple char-class runs only.

Landed: at `regex()` construction time, recognize only simple positive char-class/shorthand runs locally (`[class]+`, `[class]*`, `\d+`, `\s*`, etc.) and store a tiny runner next to the sticky regexp. `parse()` tries that runner first and falls back to `exec` when the shape is not supported or the run reaches 64 chars.

Why this shape only: it reuses the already-proven soundness work without carrying a full recursive runtime matcher. The broader version was slower; the chars-only version measured as a win on the main interpreter suites.

Guard: only use shapes the compiler already accepts; keep native `RegExp.exec` as the fallback and as the differential-test oracle. Long runs bail out to native exec.

Remaining: maybe add more shape-specific runners later (`seq` number tokens, string bodies), but only with fresh before/after `bench:parseman` numbers. Do not resurrect the generic recursive matcher without a new measurement story.

Rejected follow-up (2026-07-08): negated runs (`[^,\r\n]*`), required literal prefix + run (`#[^\n\r]*`), and optional literal prefix + run (`-?[0-9]+`) were tried together in the tiny runtime scanner. Fresh same-session baseline before the change, same command after: `pnpm bench:parseman -- --only=csv,toml,json,graphql,lang,css --scale=0.2 --samples=7`. It regressed the intended rows: CSV large **348→389µs**, TOML medium **67→73µs**, JSON large **422→446µs**, lang medium **19.9→21.5µs**, GraphQL large **585→630µs**, CSS bootstrap **52.6→54.1ms**. Leave them on native `RegExp.exec` unless a narrower single-shape experiment proves otherwise.

### ~~2. Fast literal matching without `slice`~~ ✅

`literal()` currently builds `input.slice(pos, end)` before comparing, then allocates a leaf object on success. Compiled output uses char-code checks for short literals because that already measured faster up to the current codegen crossover.

Idea: compare short case-sensitive literals with `charCodeAt` before slicing. Only slice after the match succeeds, because the successful value and CST leaf still need the matched text.

Guard: keep the current path for long literals and case-insensitive literals until measured. The compiler crossover is source-size constrained; the interpreter crossover is not, so measure independently.

Landed: case-sensitive `literal()` now probes with `input.startsWith(value, pos)` and slices only after a match succeeds. `charCodeAt` was tried too and lost to `startsWith` on the parser suite.

Measure: `pnpm bench:literal` still compares `slice(pos,end)`, `startsWith(value,pos)`, and `charCodeAt`; keep it for future crossover checks.

### ~~3. Reuse first-char dispatch plans in `choice()`~~ ✅

`choice()` has disjoint dispatch, but the interpreter still scans parsers linearly to find the matching first set. The compiler has richer planning in `emitChoice` / `planDisjointDispatch`.

Idea: build a compact runtime dispatch plan once when the `choice()` is constructed: discrete code-point map for small exact sets, range list for wide classes, and fallback to the current loop for `any` / complex overlap.

Guard: preserve PEG order for non-disjoint choices. This is only for arms already proven disjoint, or for unique-key partitions that can skip impossible arms.

Landed: for already-disjoint choices, build a 128-entry ASCII table once and fall back to the old first-set loop for non-ASCII or unmapped starts. No PEG-order change.

## Medium priority

### ~~4. Interpreter fast trivia scanner~~ ✅

Compiled trivia has `trivia-fast-path.ts`; interpreted `advanceTrivia()` usually calls the trivia combinator, which recursively creates normal parse results just to skip whitespace/comments.

Idea: detect the same common trivia shapes at `trivia()` / `parser()` construction time and attach a direct scanner to the trivia combinator metadata. `advanceTrivia()` and `scanTrivia()` use it when no labeled trivia capture is needed.

Guard: labeled trivia already has `tryFastLabeledScan`; do not duplicate that path. Start with unlabeled ASCII whitespace and block-comment trivia only.

Landed: `advanceTrivia()` / no-capture `scanTrivia()` use a cached exact-shape scanner for unlabeled whitespace runs and CSS block comments. Labeled trivia stays on the existing labeled fast path. No generic regex analyzer was added to runtime.

### ~~5. Result-object churn in wrapper combinators~~ ✅

`transform()`, `skip()`, `label()`, `optional()`, `sequence()`, and repetition combinators allocate fresh `{ ok, value, span }` objects on hot paths. Some wrappers also spread result objects.

Idea: remove the obvious spreads first (`transform`, `skip`, failed `label`) and return explicit objects. Bigger result pooling is probably not worth the complexity unless profiles prove object allocation dominates.

Guard: do not mutate child results in-place; failed parse objects are used for diagnostics and probe tracking.

Landed: removed the obvious object spreads in `transform()`, `skip()`, and failed `label()`. Stopped there; no result pooling.

### ~~6. Avoid throwaway trivia contexts~~ ❌

`advanceTrivia()` and `scanTrivia()` call `triviaP.parse()` with fresh tiny context objects. In trivia-heavy grammars that is one allocation per boundary.

Idea: add a parse-scoped scratch trivia context on `ParseContext`, mutate its `trackLines` / `state` fields before calling trivia, and reuse it.

Guard: only for no-capture trivia scans. Capture/logging paths need the real context because they commit side effects.

Rejected: a parse-scoped scratch context for no-capture trivia was tried after the trivia scanner. It regressed CSS and GraphQL (`css/bootstrap4` **52.8→57.4ms**, GraphQL large **589.8→620.3µs**) while only preserving the JSON/TOML wins from the scanner, so it was backed out.

## Low priority / probably skip

| Idea | Why not first |
|------|---------------|
| Lazy/scalar arrays for consumed `many()` values | The dead-value subset already saved allocation but not time. Do this only if an interpreter profile shows consumed tiny arrays are hot. |
| Full result pooling | Easy to break diagnostics/backtracking and hard to make ergonomic in TypeScript. Try explicit object returns first. |
| New regex analysis | The compiler already has the hard correctness work. Reuse it before writing a second analyzer. |
| New public API for interpreter tuning | No knobs until a measured hot path needs one. |

## Measuring

- `pnpm bench:parseman` — check interpreted and compiled rows together; interpreter wins must not quietly regress compiled output.
- `pnpm test:perf` — smoke perf guards.
- `test/parity/compiler.test.ts` and `test/parity/failure-diagnostics.test.ts` — sanity that interpreter/compiler behavior stayed aligned after runtime fast paths.
- For any regex/literal scanner change, add one differential test that compares the fast path to native `RegExp` / current `literal()` behavior on adversarial inputs.
