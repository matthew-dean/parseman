# Performance ideas (codegen / macro)

Library-level opportunities for faster compiled parsers. Grammar authors can only reach some of these via hand-merging or collapsing shapes (see README § "collapse opaque shapes into one regex").

## Already landed

- **Flat trivia log** — `_cstTriviaLog` as `[start, end, insertIdx, …]` triples; no per-run `CSTTrivia` objects.
- **`node()` ctx save/restore** — mutate `_ctx` fields instead of spreading a new `ParseContext` per call.
- **Fast non-capturing trivia** — `_tfN` returns a position number, not `{ ok, value, span }`.
- **Choice fast paths (non-CST)** — `greedyClassify`, `literalsLongestFirst`, disjoint first-char dispatch, `autoNot` for `firstMatch`.

---

## High priority

### 1. ~~Choice fast paths disabled in CST grammars~~ ✅

`emitGreedyClassify` / `emitLiteralsLongestFirst` now emit `emitLeafCapture` and run in capturing compiles. `emitGreedyClassify` no longer uses nested `return { ok: true }` (assigns to result vars instead).

Measured: CSS bootstrap4 compiled ~18–22ms (CST + `_triviaLog`, stub nodes) vs interpreted ~35ms. Still faster than jess ~33ms because we skip full Jess AST construction. Prior ~20ms figure omitted trivia capture.

---

### 2. `node()` per-invocation overhead

Collapsing rules (e.g. selector hierarchy) still allocate `children[]`, `rawChildren[]`, `triviaLog[]` on every call — interpreter and `emitNode`.

**Ideas:**

- Lazy array allocation (allocate on first push).
- Single-child fast path when exactly one capture occurred.
- Compile-time transparent-wrapper elimination when `buildSrc` is `(c) => c[0]` (or equivalent).

Save/restore is done; lazy alloc + single-child are the remaining levers.

---

### 3. Log-only compiled trivia capture

Interpreter `scanTrivia` already short-circuits when `ctx._triviaLog` is set (flat offsets, no object capture). Compiled `_tcN` still runs the full trivia parser tree via `emit(trivia)` with `capAsTrivia`, then pushes flat triples at the end.

**Fix:** When `_ctx._triviaLog !== undefined` and rawChildren trivia isn't needed, emit a dedicated scan-and-log loop (or reuse `_tfN` + push offsets). Skip `_cstTriviaLog` / capture machinery on that path.

---

## Medium priority

### 4. Fuse `sequence` + `transform`

`transform(sequence(a, b, c), ([x, y, z]) => …)` currently builds `_arr = [v0, v1, v2]` then calls `_mf[i]`. Pattern-match at compile time: straight-line locals + inline transform body. No array, no indirect call.

### 5. Inline transforms and builds at call sites

Macro already captures `fnSrc` / `buildSrc` into `_mf` / `_build` arrays. For simple, closure-free bodies, paste the function body directly instead of `_mf[n](val, span)` / `_build[n](…)`.

### 6. Trivia loop specialization

When `parser({ trivia: ws }, root)` is macro-compiled and trivia is a simple `regex(/…*/)` or literal run, inline a tight `charCodeAt` skip loop instead of calling `_tfN` / `_tcN` between every sequence term.

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

- `pnpm bench` — JSON, CSV, GraphQL, CST JSON, **combinator inlining**, **CSS (jess grammar port)**.
- `test/perf/css-parser.test.ts` — CSS correctness + bootstrap timing when fixture available.
- `test/parity/compiler-capture-choice.test.ts` — capturing choice fast-path parity.
- `test/unit/codegen-output.test.ts` — snapshot guard on emitted JS shape.
- `test/parity/compiler.test.ts` — correctness after codegen changes.

Fixtures: `fixtures/css/` (small); bootstrap4 via `CSS_FIXTURE_ROOT` or less.js test-data path.

**CSS perf baseline** (`parseCss` / `parseCssCompiled`): jess `parseCssFn` shape — `_triviaLog` on ctx, CST `node()` build, `buildLazyTriviaMap`. Uses lightweight CST nodes, not Jess AST. Compare compiled vs interpreted medians on bootstrap4 (~30ms class, not the ~20ms no-trivia shortcut).
