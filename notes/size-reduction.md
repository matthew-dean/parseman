# Macro-compiled parser size reduction

Tracking the effort to shrink the size of macro-compiled parsers. Reference target:
the Jess `less-parser`, which was **5.30 MB** and is now **1.07 MB (−79.8%)**.
Grammar *source* (the `rules()` the macro compiles) is ~32 KB, so we've gone from
~166× source to ~38× source. Aim: keep pushing toward 5–7× without wrecking parse
speed (currently ~12% under the pre-hoist baseline — the accepted hoist trade —
still 6–7× faster than the interpreter).

All sizes below are `less-parser/lib/index.js` (the ESM the jess stack resolves).
**Environment note:** jess resolves `parseman` from `node_modules/.pnpm/parseman@*/…`
(a real copy, not a symlink). After `node scripts/build.mjs`, sync it:
`for pv in 0.16.0 0.14.0; do d=jess/node_modules/.pnpm/parseman@$pv/node_modules/parseman/dist; rm -rf "$d" && cp -R dist "$d"; done`

## Current byte map (less-parser, 1.07 MB, gzip ~175 KB)

| region | bytes | notes |
|---|---:|---|
| `src/grammar.ts` (**executable fused grammar**) | **982 KB (~92%)** | the lowered `_r_<Name>` fns — the dominant cost |
| `src/builders.ts` | 81 KB | hand-written AST builders (kept — functional parser + scss use it) |
| carried IR (`{ns, ir}`) | 30 KB | was ~1 MB of lowered source before carry-IR |
| tokens / runtime / rest | ~25 KB | |
| ~~`productions/*` (legacy class parser)~~ | ~~133 KB~~ | **removed** — tree-shaken (Landed #7) |

The carried-source problem is **solved** (30 KB) and the legacy parser is **gone**.
The frontier is now essentially the single **982 KB executable fused grammar**.

---

## ✅ Landed

| # | technique | commit | impact (less) | perf |
|---|---|---|---|---|
| 1 | **Identity-hoist shared combinators** — emit a multiply-referenced compound once as a `_pf` fn instead of pasting it at every reference (killed the 786 KB `calcBody` explosion) | `8b2f375` | 5.30 → 2.50 MB | −11% (the one-time hoist cost) |
| 2 | **Strip carried-pieces indentation** — dead pretty-printer whitespace in machine-consumed source | `2a9140f` | 2.50 → 2.29 MB | free |
| 3 | **Live-spread ancestor pieces** — reference an imported grammar's pieces off its live binding (`[...cssGrammar[Sym], delta]`) instead of re-serializing; works in interpreted + macro mode | `3c7edcf` | 2.29 → 1.98 MB | free |
| 4 | **Carry compact IR** — carry the `rules(g=>…)` combinator expression (`{ns, ir}`) and re-lower at fuse, instead of ~1 MB of lowered `_r_` source | `cfa50d7` | 1.98 → 1.22 MB | free (build-time only) |
| 5 | **Drop `_pfok` flag from named-fn wrappers** — direct `return value` on success, fall-through `_pfFail` on failure | `a9137f6` | 1.22 → 1.21 MB | neutral |
| 6 | **Intern identical `_mf` map closures** — dedup by source so every `balanced()` merge closure shares one `_mf` slot (40 → 2) | `dfd07c4` | −5.8 KB | free |
| 7 | **Stop exporting the legacy Chevrotain parsers** (jess-side) — drop the `*RecursiveParser`/`*ParserChevrotain` re-exports so the bundler tree-shakes the old parsers out. less: `f1fc4aaff` (−133 KB); scss: `28e028bf1` (−97 KB). jess already Chevrotain-free. **css blocked** — see follow-up. | jess `f1fc4aaff`, `28e028bf1` | **−230 KB** | free |
| 8 | **Module-level hoist of byte-identical fused declarations** — each `compose()`/`composeLeaf()` lowered to a self-contained IIFE, so a content-addressed recognition namespace was emitted N times, under the SAME names, in N sibling scopes. Emit each distinct declaration ONCE at module scope (`src/compiler/module-hoist.ts`) | 0.46.0 | `probe/variants-2` −22.9%, `probe/variants-4` −35.5% | predicted neutral-or-better; **not measured** — see below |
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
- [x] ~~**Hash-cons identical lowered rule bodies**~~ — the CROSS-SCOPE half is **DONE**
  (Landed #8). Everything measured below was recovered in full:
  `probe/variants-2` 39,284 → 30,303 B (−8,981, −22.86%), `probe/variants-4`
  77,732 → 50,174 B (−27,558, −35.45%). (Measured on top of the cold-capture-helper
  commit `0665871`, which had already taken those fixtures from 41,448 / 82,060 B; the
  ratio is unchanged, the absolute residual is smaller.) The other 22 gated fixtures
  stayed at EXACTLY their committed ceiling — none composes more than once, which is
  exactly why the 1/2/4 ladder had to exist for this lever to be visible at all.
  `variants-4` now costs 2.53x `variants-1` for the same grammar (was 3.92x), and
  `test/unit/size-guard.test.ts` gates that ratio in the improved direction instead of
  asserting the defect.

  How the two hazards below were settled: the hoist keys its decision on the declared
  NAME and hoists a name only when EVERY declaration of it in the module is
  byte-identical, so `_pfFail` is removed from all scopes or none and a mix is
  unrepresentable — there is no code path that removes one occurrence and keeps
  another. `_wcf<N>` falls out for free: two artifacts declaring `_wcf0` with different
  bodies give that name two texts, so it is never hoisted, and a free-variable fixpoint
  (over-approximating references via `\bNAME\b`, so it can only ever BLOCK a hoist)
  stops anything that references it from being hoisted either. The missing insertion
  point is now `ms.appendLeft(anchor.start, prelude)` in `src/plugin/index.ts`, anchored
  at the earliest top-level statement whose replacement actually claimed declarations —
  not the earliest replacement of any kind, which would emit the prelude ahead of a
  `const ws = trivia(…)` it may read.

  **Still open** (this pass dedups EXACT text across sibling scopes only): near-identical
  bodies that differ in a variable index; duplication WITHIN one IIFE; and the
  `compile()` inline path, where a module with several plain compiled grammars still
  pays a `_pfFail`/`_pfEnd`/`_EMPTY_TL` preamble per parser. Also disabled under
  `grammarCoverage`, because the coverage denominator is read back out of the emitted
  replacement text (`emittedCoverageDefinitions`) and a hoisted declaration is no longer
  inside it.

  The original measurement that justified building it:
- [ ] ~~**Hash-cons identical lowered rule bodies.**~~ Some rules lower to byte-identical
  or near-identical fn bodies (at-rule blocks, selector variants); emit once + alias.
  Needs a post-codegen dedup pass. Risk: medium. **MEASURED 2026-07-30 — the estimate
  this was shelved on was wrong by ~4x.** 0.45 put the recoverable residual at 20.8%
  (probe) / 8.7% (jess), and the item was nearly dropped as not worth it. Re-measured on
  `probe/variants-4` by parsing the emitted artifact and keying top-level declarations on
  their exact body text:

  | unit | IIFEs | gen B | decls | byte-identical dedup | same-name/different-body |
  |---|---|---|---|---|---|
  | variants-1 | 1 | 20,901 | 93% | 0 B (0.0%) | 0 B |
  | variants-2 | 2 | 41,446 | 96% | 9,557 B (**23.1%**) | 18,640 B (45.0%) |
  | variants-4 | 4 | 82,058 | 98% | 29,286 B (**35.7%**) | 37,933 B (46.2%) |

  The premise holds exactly as designed: of the five `_r_` rule functions in
  `variants-4`, four (`_r_Word`, `_r_Num`, `_r_Atom`, `_r_List` — 33,492 B) are emitted
  4x with **one distinct body each**. Only `_r_Doc`, the rule that actually varies with
  `hostMode`/`trackLines`, has 4 distinct bodies. So the recognition piece IS shareable
  and it is roughly half the artifact by bytes.

  **The `_pfFail`/`_pfEnd` question is ANSWERED** (it was the stated blocker):
  - `_pfEnd` (`let`, `src/compiler/linker.ts:286`) is a single-slot out-parameter, not
    state. The write is the last statement before `return` (`src/compiler/codegen.ts:755`)
    and the read is the statement immediately after the call
    (`src/compiler/codegen.ts:775`, `:4373`) — nothing intervenes, and a failed callee
    returns `_pfFail` so the caller never reads it on that path. Safe to share
    unconditionally.
  - `_pfFail` (`const … = {}`, `src/compiler/linker.ts:285`) is an identity sentinel
    compared with `===` (`src/compiler/codegen.ts:770`, `:4372`). Safe to share ONLY if
    hoisted **atomically**: exactly one module-level pair, with `linker.ts:285-286`
    no longer emitting per-IIFE copies. A mix is the worst failure available here — a
    hoisted `_r_X` returns the module-level sentinel, an IIFE-local caller compares
    against a different object, and a parse FAILURE reads as success with value `{}`.

  Two hazards remain before building. `_wcf<N>` (`src/compiler/codegen.ts:4336`) is
  un-namespaced and counter-derived, so two IIFEs' `_wcf0` can carry different bodies
  under one name — a name-keyed hoist collides; key on body text and refuse any name
  with ≥2 distinct bodies. And `emitFusedSource` (`src/compiler/linker.ts:457`) returns a
  self-contained expression spliced into a `const X = …` initializer, so there is no
  module-level insertion point today: this needs a cross-call accumulator plus a new
  splice site in `src/plugin/index.ts`. Landing it moves `bench/size-baseline.json` and
  therefore needs a deliberate rebaseline.
- [ ] **Minify the carried IR further.** The 30 KB IR is a readable `rules(…)`
  expression; a name-preserving minify (it's re-`eval`'d, not read) could ~halve it.
  Small absolute win (30 KB) — low priority.
- [x] ~~Intern the 40 identical `_mf` merge closures~~ — **DONE** (see Landed #6, −5.8 KB).
- [ ] **De-duplicate regex triple-encoding.** ~~Est. 20–40 KB~~ — **measured: only ~4 KB.**
  The `_fx` first-set arrays are already interned by `expectedMap` (5.3 KB total, 65
  regex entries); only the regex *source* inside those 65 duplicates the `_re` literal.
  Deriving `_fx` from `_re.source` at load would save ~4 KB for added runtime concat.
  **Low priority** (not worth the complexity).
- [ ] **Shorter ns-hash prefix.** `_<8hex>_` (~10 chars) is on ~3080 identifiers in less
  (~34 KB raw; gzips well). A 4-hex prefix is still collision-safe for a handful of
  artifacts and byte-stable (module-derived). Est. ~12 KB raw. Low risk, low priority.
- [ ] **Ship a minified build.** `tsdown` currently emits unminified. Minifying the
  executable (names + whitespace) could take ~982 KB → ~500 KB *raw* (gzip already
  captures most). Won't touch the IR strings. Cheap; changes the shipped artifact's
  readability. Consider a separate `.min` entry.

### ~~High — the 123 KB legacy class parser~~ → DONE (Landed #7)

- [x] ~~Stop shipping the Chevrotain parsers~~ — **less & scss DONE** (−230 KB). The AST
  builder chain is `ScssGrammar → LessGrammar → CssParser` (a standalone class in css
  `builders.ts`, NOT the Chevrotain parser), so the old parsers are pure dead weight.
- [ ] **css Chevrotain un-export — BLOCKED on source deletion.** Removing css's
  `cssRecursiveParser`/`cssParser`/`productions` exports drops another **−105 KB** and
  the functional stack is fine — BUT the still-present dead source files
  (`less/scss/src/*RecursiveParser.ts` + `productions/*`) `import { CssRecursiveParser }`
  from css, so un-exporting it breaks *their* typecheck + tests. **Unblock:** delete
  the dead Chevrotain source + its tests across css/less/scss (they're dead weight
  anyway), THEN un-export css. That's the "remove fully" step, deferred for now.

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

## 📏 On measuring the hoist's speed

Predicted neutral-or-better: it is a pure hoist — the same functions, called the same
way, resolved in an enclosing scope instead of their own. Less source for V8 to parse
and compile at import, and nothing added on the parse path.

**That prediction was NOT verified.** The machine was at load average 38–63 on ~14 cores
while this landed, with ~10 lanes running; a lane measured five consecutive runs of one
workload on a BYTE-IDENTICAL tree at +29.4 / +15.8 / +76.5 / +29.6 / +43.7% — a 61-point
spread against a 15% tolerance. Contention that severe is a bias, not zero-mean noise,
so more samples do not fix it and no wall-clock number from that window is worth
reporting. The evidence banked here is deterministic instead: emitted bytes, gzip bytes,
identical-body counts, `pnpm size:guard`. Codegen output is byte-identical across runs
AND processes (pinned by `test/unit/size-guard.test.ts`), so the noise floor on those is
exactly 0.

## ⛔ Investigated & not worth it / moot

- **Dead `else { _cfx }` first-set branches** — 0 remain (hoist + carry-IR + fuse-time
  `@FS` resolution eliminated them). No action.
- **Sidecar for carried pieces** — moot: carry-IR shrank the carry to 30 KB.
- **Threshold tuning of the hoist** (`HOIST_MIN_SUBTREE`) — doesn't recover perf (the
  cost is the call, not small-node hoisting); 3 is the size-minimizing sweet spot.
- **Dispatch tables to recover the ~12% hoist perf** — parseman already switch-dispatches
  disjoint choices; the residual cost is call overhead, not dispatch. Micro-opts (a)+(b)
  confirmed no measurable recovery.
