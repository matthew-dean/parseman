# Macro-compiled parser size reduction

Tracking the effort to shrink the size of macro-compiled parsers. Reference target:
the Jess `less-parser`, which was **5.30 MB** and is now **1.21 MB (−77%)**.
Grammar *source* (the `rules()` the macro compiles) is ~32 KB, so we've gone from
~166× source to ~38× source. Aim: keep pushing toward 5–7× without wrecking parse
speed (currently ~12% under the pre-hoist baseline — the accepted hoist trade —
still 6–7× faster than the interpreter).

All sizes below are `less-parser/lib/index.js` (the ESM the jess stack resolves).
**Environment note:** jess resolves `parseman` from `node_modules/.pnpm/parseman@*/…`
(a real copy, not a symlink). After `node scripts/build.mjs`, sync it:
`for pv in 0.16.0 0.14.0; do d=jess/node_modules/.pnpm/parseman@$pv/node_modules/parseman/dist; rm -rf "$d" && cp -R dist "$d"; done`

## Current byte map (less-parser, 1.21 MB, gzip 199 KB)

| region | bytes | notes |
|---|---:|---|
| `src/grammar.ts` (**executable fused grammar**) | **982 KB (81%)** | the lowered `_r_<Name>` fns — now the dominant cost |
| `src/builders.ts` | 81 KB | hand-written AST builders |
| `productions/*` (legacy class parser) | 123 KB | `LessRecursiveParser` — separate, still exported |
| carried IR (`{ns, ir}`) | 30 KB | was ~1 MB of lowered source before carry-IR |
| tokens / runtime / rest | ~25 KB | |

The carried-source problem is **solved** (30 KB). The frontier is now the **982 KB
executable** and the **123 KB legacy parser**.

---

## ✅ Landed

| # | technique | commit | impact (less) | perf |
|---|---|---|---|---|
| 1 | **Identity-hoist shared combinators** — emit a multiply-referenced compound once as a `_pf` fn instead of pasting it at every reference (killed the 786 KB `calcBody` explosion) | `8b2f375` | 5.30 → 2.50 MB | −11% (the one-time hoist cost) |
| 2 | **Strip carried-pieces indentation** — dead pretty-printer whitespace in machine-consumed source | `2a9140f` | 2.50 → 2.29 MB | free |
| 3 | **Live-spread ancestor pieces** — reference an imported grammar's pieces off its live binding (`[...cssGrammar[Sym], delta]`) instead of re-serializing; works in interpreted + macro mode | `3c7edcf` | 2.29 → 1.98 MB | free |
| 4 | **Carry compact IR** — carry the `rules(g=>…)` combinator expression (`{ns, ir}`) and re-lower at fuse, instead of ~1 MB of lowered `_r_` source | `cfa50d7` | 1.98 → 1.22 MB | free (build-time only) |
| 5 | **Drop `_pfok` flag from named-fn wrappers** — direct `return value` on success, fall-through `_pfFail` on failure | `a9137f6` | 1.22 → 1.21 MB | neutral |
| 6 | **Intern identical `_mf` map closures** — dedup by source so every `balanced()` merge closure shares one `_mf` slot (40 → 2) | (pending) | −5.8 KB | free |
| — | (deep first-set, `a1cd248` — a *correctness* fix, +2 tests, not size) | | | |

CI gate: `test/unit/hoist-shared-explosion.test.ts` trips if the inlining explosion
regresses (19× vs 2× expansion). Round-trip gate: `test/unit/ir-serialize.test.ts`.

---

## 🔲 To explore (grounded in the current byte map, ranked by impact)

### High — the 982 KB executable

- [ ] **Factor invariant CST-capture scaffolding into shared runtime helpers.**
  252 `if (_ctx._cstLeaves) {…}` leaf-capture blocks + 196 checkpoint save/restore
  clusters (`_cstLeaves?.length ?? 0` ×4 + restores) are inlined per node. Extract
  the **cold** paths (checkpoint save/restore on backtrack) into `_ctx`-passed
  helpers. **Caveat:** the *leaf-push* variant was tried and reverted — it put a
  call on the hot capturing path (~5% perf). Restrict to backtrack/restore (cold).
  Est. ~50–100 KB. Risk: medium (capture correctness).
- [ ] **Hash-cons identical lowered rule bodies.** Some rules lower to byte-identical
  or near-identical fn bodies (at-rule blocks, selector variants); emit once + alias.
  Est. unknown until measured; needs a post-codegen dedup pass. Risk: medium.
- [ ] **Minify the carried IR further.** The 30 KB IR is a readable `rules(…)`
  expression; a name-preserving minify (it's re-`eval`'d, not read) could ~halve it.
  Small absolute win (30 KB) — low priority.
- [x] ~~Intern the 40 identical `_mf` merge closures~~ — **DONE** (see Landed #6, −5.8 KB).
- [ ] **De-duplicate regex triple-encoding.** Each terminal regex appears as a compiled
  `/…/y` literal, an escaped `_fx` first-set string, and inside rule bodies; derive the
  `_fx` string from `.source` at load. Color-name alternation still appears 3×. Est.
  ~20–40 KB. Low risk.
- [ ] **Ship a minified build.** `tsdown` currently emits unminified. Minifying the
  executable (names + whitespace) could take ~982 KB → ~500 KB *raw* (gzip already
  captures most). Won't touch the IR strings. Cheap; changes the shipped artifact's
  readability. Consider a separate `.min` entry.

### High — the 123 KB legacy class parser

- [ ] **Split / lazy-load `LessRecursiveParser`.** `productions/*` (123 KB) + much of
  `builders.ts` are the legacy class-based recursive parser, still bundled and
  exported. If the functional (macro) parser is the primary path, move the recursive
  parser behind a separate entry (`@jesscss/less-parser/recursive`) so `import { LessParser }`
  (functional) doesn't pull it. Est. up to ~123 KB off the default bundle. Risk: API
  shape / consumer coordination.

### Medium — structural / cross-package

- [ ] **Module-level delta compilation (#9).** A descendant's executable RE-lowers the
  full fused ancestor set (css+less inlined into less's 982 KB). Instead, have less
  *import* css-parser's compiled `_r_` fns and emit only the delta + overrides, so CSS
  ships once (in css-parser). Big potential on scss/jess (which inline css+less[+scss]).
  Risk: high — changes the exec fusion model (currently fully inlined for speed).
- [ ] **Shorter generated identifiers.** The 8-char ns hash prefix (`_50af116e__`) is on
  thousands of identifiers. Load-bearing for collision-free fusion and gzips well, so
  low priority — but a shorter stable scheme (2–3 chars, per-artifact counter) is safe.

### Perf (not size, but unblocks un-hoisting)

- [ ] **Fuse-time first-set dispatch for composed grammars.** 32 rule-ref choice arms in
  less lose dispatch (first-set `any`) because deep first-sets can't be carried
  per-artifact (unsound under override). Carry-IR now provides the combinator trees at
  fuse, so we can compute a deep first-set over the *fused winning set* soundly. Would
  speed up the composed less/scss/jess parsers. Needs a fuse-pipeline restructure +
  a jess parse benchmark to measure. This is the real perf lever.

---

## ⛔ Investigated & not worth it / moot

- **Dead `else { _cfx }` first-set branches** — 0 remain (hoist + carry-IR + fuse-time
  `@FS` resolution eliminated them). No action.
- **Sidecar for carried pieces** — moot: carry-IR shrank the carry to 30 KB.
- **Threshold tuning of the hoist** (`HOIST_MIN_SUBTREE`) — doesn't recover perf (the
  cost is the call, not small-node hoisting); 3 is the size-minimizing sweet spot.
- **Dispatch tables to recover the ~12% hoist perf** — parseman already switch-dispatches
  disjoint choices; the residual cost is call overhead, not dispatch. Micro-opts (a)+(b)
  confirmed no measurable recovery.
