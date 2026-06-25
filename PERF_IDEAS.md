# Performance ideas (codegen / macro)

Library-level opportunities for faster compiled parsers. Grammar authors can only reach some of these via hand-merging or collapsing shapes (see README § "collapse opaque shapes into one regex").

## Already landed

- **Flat trivia log** — `_cstTriviaLog` as `[start, end, insertIdx, …]` per trivia entry; no per-entry `CSTTrivia` objects.
- **`node()` ctx save/restore** — mutate `_ctx` fields instead of spreading a new `ParseContext` per call.
- **Fast non-capturing trivia** — `_tfN` returns a position number, not `{ ok, value, span }`.
- **Choice fast paths (non-CST)** — `greedyClassify`, `literalsLongestFirst`, disjoint first-char dispatch, `autoNot` for `firstMatch`.
- **Choice fast paths in CST grammars** — `emitGreedyClassify` / `emitLiteralsLongestFirst` with `emitLeafCapture` in capturing compiles.
- **Log-only compiled trivia capture** — merged `_tcN` into `_tfN(…, cap?)`; ~6% bootstrap4 vs duplicate-tree `_tc`.
- **Interpreter `node()` lazy capture** — `capture-buffer.ts`: defer `children`/`raw`/`tl` array alloc until first push; single-child scalar fast path.
- **Trivia loop specialization** — `trivia-fast-path.ts`: hand-rolled `charCodeAt` loop for `oneOrMore(choice(ws, blockComment))` and ASCII ws-only trivia; CSS bootstrap4 compiled **−52%** (25.8→12.3ms).
- **Transform / build inlining** — `inline-callback.ts`: paste unary and `sequence`+destructure transform bodies at call sites; GraphQL large compiled **−6%**. `inline-build.ts`: emit `mk()` CST nodes literally (CSS-neutral).
- **Labeled trivia kind capture** — `label(name, parser)` on trivia `choice` arms records per-chunk kind indices in `_triviaLog` / per-node `triviaLog`; `triviaEntries()` resolves kinds and text lazily. Interpreter + compiled parity in `test/parity/trivia-kinds.test.ts`.

---

## High priority

### ~~1. Choice fast paths disabled in CST grammars~~ ✅

Moved to **Already landed**.

---

### ~~2. `node()` per-invocation overhead~~ (partial — interpreter only)

**Landed (interpreter):**

- Lazy array allocation + single-child scalar (`capture-buffer.ts`).

**Rejected (compiled — do not retry without a new approach):**

| Attempt | Result |
|---------|--------|
| Runtime helper prelude (`_cstPushLeaf`, `_cstSaveMark`, …) | CSS compiled **+~50%** (bootstrap4 25.8→39ms) |
| Inline lazy buf in `cst-capture-codegen.ts` (no helper calls) | CSS compiled **+~32–47%** (bootstrap4 25.8→38ms) |

Eager `[], [], []` in `emitNode` remains faster — branchy inline push costs more than the array alloc it avoids on typical CST shapes.

**Remaining:**

- Compile-time transparent-wrapper elimination when `buildSrc` is `(c) => c[0]` (or equivalent).

---

### ~~3. Log-only compiled trivia capture~~ ✅

Moved to **Already landed**.

---

## Medium priority

### ~~4. Fuse `sequence` + `transform`~~ (partial ✅)

`transform(sequence(a, b, c), ([x, y, z]) => …)` with destructure-array `fnSrc` / arrow `toString()` now emits straight-line locals + inlined body — no `_arr`, no `_mf[n]`. Unary transforms (`s => parseInt(s, 10)`, object literals, etc.) also inline when closure-free.

**Result:** GraphQL large compiled **−6%** (~149→~142µs); medium **−5%**. Remaining: transforms whose body references outer scope or non-destructure params.

### ~~5. Inline transforms and builds at call sites~~ (partial ✅)

Macro `fnSrc` / `buildSrc` and runtime `toString()` for arrow builds. Landed: transform inlining (§4), CSS `mk(type,…)` literal emission (`inline-build.ts`, **neutral** on bootstrap4 — removes `_build` indirection but no measurable CSS win). Remaining: general `buildSrc` object-literal inlining for non-`mk` grammars.

### ~~6. Trivia loop specialization~~ ✅

When trivia is `oneOrMore(choice(ws, blockComment))` (CSS `rw`) or ASCII ws-only, emit a hand-rolled `charCodeAt` scan in `_tfN` instead of regex / combinator dispatch. Single alternation regexes are excluded — one `RegExp.exec` matches only one arm per call.

**Result:** CSS bootstrap4 compiled **−52%** (25.8→12.3ms); selector/decls **−43–47%**. See `src/compiler/trivia-fast-path.ts`, `test/unit/trivia-fast-path.test.ts`.

### 7. Common-prefix choice factoring

Arms like `ident '(' …` vs bare `ident` can't use disjoint dispatch. Generalize the CSS grammar hand-merge: parse shared prefix once, branch on lookahead. Complements existing `autoNot` (suffix rejection) but doesn't replace it.

### 8. Simple regex lowering

Patterns like `\d+`, `[A-Za-z_]\w*`, single char classes — emit hand-rolled scan loops instead of `RegExp.exec` when `regexp-tree` analysis proves it's safe.

---

## Lower priority / cleanup

| Target | Issue | Fix |
|--------|-------|-----|
| `emitSkip` | Still uses `try/catch {}` | `emitFallible` |
| `withCtx` | `{ ..._ctx, state: … }` allocates | Save/restore `_ctx.state` |
| ASCII-only grammars | `codePointAt` in disjoint dispatch | `charCodeAt` when first-set proves BMP-only |
| Dense disjoint choices | Long `if/else if` chains | `switch` or lookup table |
| `makeWord()` at macro time | Expands to regex per keyword | Expand to charCode / `literal+not` where cheap |
| Macro build time | Sequential `compile()` per rule | Parallel compile; cache by combinator-tree hash |

---

## Measuring

- `pnpm bench` — external parser comparison (Peggy, Parsimmon, Chevrotain, Nearley, Jison) **plus** Parseman interpreted vs compiled across all example grammars (with baseline Δ).
- `pnpm bench:compile-grammars` — regenerate precompiled Peggy, Nearley, and Jison parsers in `bench/` after editing `bench/*.pegjs` or `bench/vendor/`.
- `pnpm bench:svg` — regenerate `assets/bench-*.svg` for the README (update µs values in `bench/gen-svg.ts` from `pnpm bench` output first).
- `pnpm bench:baseline` — refresh `bench/parseman-baseline.json` **and append** a snapshot to `bench/parseman-history.jsonl` (commit both to track the needle over time).
- `test/perf/parseman-perf.test.ts` — smoke + compiled absolute (25%) and speedup-ratio (15%) regression guard vs baseline (interpreted absolute skipped in CI — vitest/JIT noise).
- `test/perf/css-parser.test.ts` — CSS correctness + bootstrap timing when fixture available.
- `test/parity/trivia-kinds.test.ts` — labeled trivia kind indices: interpreted vs compiled parity.
- `test/parity/trivia-log-regression.test.ts` — interpreted/compiled `_triviaLog` golden parity.
- `test/parity/compiler-capture-choice.test.ts` — capturing choice fast-path parity.
- `test/unit/codegen-output.test.ts` — snapshot guard on emitted JS shape.
- `test/parity/compiler.test.ts` — correctness after codegen changes.

**Parseman baseline** (`bench/parseman-baseline.json`): CI regression anchor — median µs/op for interpreted **and** compiled on JSON, CSV, GraphQL, TOML-ish, lang, and CSS fixtures. Updated deliberately when you accept a new perf level.

**Parseman history** (`bench/parseman-history.jsonl`): append-only time series (one JSON line per `bench:baseline`). `pnpm bench` reports Δ vs baseline plus Δc↓prev / Δc↓origin from history. `printHistoryIndex()` lists bootstrap4 compiled µs across all snapshots.
