# Performance ideas (codegen / macro)

Library-level opportunities for faster compiled parsers. Grammar authors can only reach some of these via hand-merging or collapsing shapes (see README § "collapse opaque shapes into one regex").

Interpreter-side ideas are split out to [`INTERPRETER_PERF_IDEAS.md`](./INTERPRETER_PERF_IDEAS.md) so this file can stay focused on compiled/macro output.

## Already landed

- **Flat trivia log** — `_cstTriviaLog` as `[start, end, insertIdx, …]` per trivia entry; no per-entry `CSTTrivia` objects.
- **`node()` ctx save/restore** — mutate `_ctx` fields instead of spreading a new `ParseContext` per call.
- **Fast non-capturing trivia** — `_tfN` returns a position number, not `{ ok, value, span }`.
- **Choice fast paths (non-CST)** — `greedyClassify`, `literalsLongestFirst`, disjoint first-char dispatch, `autoNot` for `firstMatch`.
- **Choice fast paths in CST grammars** — `emitGreedyClassify` / `emitLiteralsLongestFirst` with `emitLeafCapture` in capturing compiles.
- **Log-only compiled trivia capture** — merged `_tcN` into `_tfN(…, cap?)`; ~6% bootstrap4 vs duplicate-tree `_tc`.
- **Trivia loop specialization** — `trivia-fast-path.ts`: hand-rolled `charCodeAt` loop for `oneOrMore(choice(ws, blockComment))` and ASCII ws-only trivia; CSS bootstrap4 compiled **−52%** (25.8→12.3ms).
- **Transform / build inlining** — `inline-callback.ts`: paste unary and `sequence`+destructure transform bodies at call sites; GraphQL large compiled **−6%**. `inline-build.ts`: emit `mk()` CST nodes literally (CSS-neutral).
- **Labeled trivia kind capture** — `label(name, parser)` on trivia `choice` arms records per-chunk kind indices in `_triviaLog` / per-node `triviaLog`; `triviaEntries()` resolves kinds and text lazily. Interpreter + compiled parity in `test/parity/trivia-kinds.test.ts`.
- **`\s` as a fixed code-point set** — `\s`/`[\s…]` now lower to a `charCodeAt` scan (`SPACE_RANGES` next to `shorthandRanges`'s `\d`/`\w`), same as `\d`/`\w`. `\s`'s set (WhiteSpace + LineTerminator) is fixed regardless of the `u` flag, so no ambiguity guard was needed. Unblocks `lang` `\s*` trivia, `graphql` ws, and any `\s`-based `seq` (e.g. `[^)"'\s]+`-style `urlInner`). See `test/unit/scannable-regex.test.ts` (`\s+` parity + codegen-uses-scan assertion) and `test/unit/trivia-fast-path.test.ts`.
- **Recalibrated `literal()` charCodeAt/startsWith crossover (4 → 16 chars)** — `emitLit`/`emitLiteralCondition` were switching to `input.startsWith()` above 4 chars, but measurement (see below) shows the unrolled `charCodeAt` chain is actually faster or tied all the way out to ~256 chars, with `startsWith` only winning on raw runtime past ~256–512. The `4` threshold meant almost every real literal (`important`, `instanceof`, HTTP header names, …) was silently taking the slower path. Moved to `CHARCODE_CHAIN_MAX = 16` instead of raising all the way to the runtime crossover, because the unrolled chain's *generated source* grows ~4–30× faster than `startsWith`'s near-constant call site — 16 caps worst-case codegen bloat while still covering every literal that appears in this repo's example grammars (longest: `important`, 9 chars) with room to spare. See `test/unit/codegen-output.test.ts` (pins the exact 16/17-char crossover), `test/unit/macro-transform.test.ts`, `test/parity/compiler-capture-choice.test.ts`.
- **Trailing lookahead boundary guard `(?!class)`/`(?=class)`** — a token followed by a char-class lookahead lowers to a post-match `charCodeAt(end)` check (new `lookahead` `ScanShape`), unlocking `lang`'s five keyword boundaries (`if(?!\w)`, `then(?!\w)`, `else(?!\w)`, `true(?!\w)`, `false(?!\w)` — verified directly, not just by analogy). CSS `colorHex`/`Num` still fall back to `exec` since their bases need `{n,m}` bounded repeat (§8c) / groups (§8f), which don't exist yet — that's a real, expected gap, not a regression. *(Update: both landed — §8f groups and §8c bounded-repeat; CSS `colorHex` now fully lowers, this lookahead included.)* **Important correctness finding beyond the original idea write-up:** a naive "lower the inner shape, then check once" is NOT always safe when the inner shape ends in an unbounded/optional run — real backtracking can rescue a shorter match that a one-shot check would miss (verified empirically: `/^[0-9]+(?=[5-9])/.exec('12345')` returns `["1234"]`, not a total failure). Added `lookaheadUnambiguous` (mirrors `seqIsUnambiguous`'s reasoning): safe iff the inner shape's trailing backtrackable class is a **subset** of the operand (negative lookahead) or **disjoint** from it (positive lookahead); shapes with no trailing quantifier at all (pure literals, `litFold`) are unconditionally safe. `until`/`delimited`/`string`/nested-`lookahead` bases are declined outright (unmodeled backtracking semantics) rather than risk an unproven guard. Verified with 140k randomized fuzz inputs against native `RegExp` (0 mismatches) plus a deliberate bypass-the-guard case that DOES mismatch (proving the guard is load-bearing, not just defensive). See `test/unit/scannable-regex.test.ts` (`§8b` describe blocks). Closed the follow-on gap too — see the `emitKeywordsFast` entry below.
- **`keywords()`/`word()`/`makeWord()` compiled fast path (`emitKeywordsFast`)** — closes the gap the §8b lookahead work deliberately left open. Every word is a fixed literal (optionally wrapped in the shared boundary lookahead), so this reuses the exact `seq`/`litFold`/`lookahead` `ScanShape` machinery instead of building one `RegExp.exec` alternation — unconditionally ambiguity-safe, since `trailingBacktrackClass` treats a single-literal `seq`/`litFold` as fixed-length (nothing for a backtracker to shrink), so wrapping either in a lookahead is safe for ANY boundary class. Real, measured impact: GraphQL's `kw('true')`, `kw('false')`, `kw('null')`, `kw('on')`, `kw('fragment')`, and `keywords(['query','mutation','subscription'], …)` all now compile to `charCodeAt` dispatch instead of a sticky regex — confirmed directly against the real grammar (`examples/graphql/parser.ts`), not just in isolation. Declines to the regex fallback for: an empty-string keyword, a keyword containing an astral code point (same BMP-only limitation as the rest of this file — caught by fuzzing an emoji keyword, which silently failed to match before the guard was added), an unparseable boundary class, and `caseInsensitive` + a boundary together (would need ASCII-folding the boundary ranges too, i.e. the general §8d problem — left on the safe path rather than risk narrowing which chars the boundary excludes). **Bugs caught by fuzzing before landing:** (1) the first version returned the canonical keyword string as the matched value instead of `input.slice(pos, end)`, which is wrong whenever `caseInsensitive` lets the actual input differ in case from the keyword (e.g. matching `"ABC"` must return `"ABC"`, not `"abc"`) — fixed. (2) the astral-code-point gap above. Verified with 120k+ randomized fuzz inputs against native `RegExp` across keyword sets with shared prefixes (`instanceof`/`in`), case-insensitivity, and boundaries (0 mismatches after both fixes). See `test/unit/keywords.test.ts`, `test/unit/macro-transform.test.ts`.
- **Top-level alternation `A|B|C` → dispatch (§8e)** — a new `alt` `ScanShape`: split a regex source on top-level `|` (outside any `[]`/`()`, one redundant whole-string `(?:…)` wrapper stripped first so `(?:a|b)`-style patterns split too), lower each arm independently via the existing recognizers (so an arm can itself be a `seq`/`chars`/`ident`/`lookahead`/…), and decline the WHOLE alternation if any single arm doesn't lower (e.g. an arm with its own nested group — §8f). Two dispatch strategies, chosen by comparing every pair of arms' first-char sets (`shapeFirstAccept`/`classDisjoint`, reusing the same subset/disjoint math as §8b's lookahead guard): **disjoint** → an if/else-if chain keyed on each arm's first-char class, straight to the one matching arm (no ordering to preserve); **overlapping** → an ordered labeled-block trying each arm in turn, taking the first that succeeds — which is regex `|`'s ACTUAL semantics (first alternative to match at all wins on its own greedy length; verified directly against native `RegExp`, e.g. `/^a|ab/.exec('ab')` → `"a"`, not `"ab"` — it is NOT longest-match). A shape that can match empty (`[x]*` with no `+`) degrades its first-set to "any", forcing ordered dispatch rather than falsely claiming disjointness. Real motivating CSS patterns: `anyValueTok` (`[+\-*/=<>|~^]+|[^\s;{}\[\]()'",!]+` — clean 2-arm overlapping case, exercises both the literal-`|`-inside-a-bracket-class and escaped-bracket-inside-a-negated-class edges of the splitter) and `Dimension`'s trailing `-?ident|%` (clean disjoint case) both now fully lower. `basicSel`/`nth`/`numPart` correctly still decline — each has an arm with its own nested `(?:…)` group, which needs §8f too; this is an expected, documented gap, not a bug. Verified with 30k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches) across both dispatch strategies, plus full `compile()`-pipeline parity tests (interpreter vs `compile()`; macro mode blocked in this sandbox by an unrelated pre-existing `oxc-parser` native-binding issue, confirmed to affect even already-landed macro tests identically). See `test/unit/scannable-regex.test.ts` (`§8e` describe blocks).
- **Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)*`, `(?:…)+` → nested `seq` (§8f)** — a new `group` `SeqPart`: `parseSeqParts` recognizes `(?:…)` (paren-depth-tracked, bracket-classes skipped atomically), recursively lowers the body via `parseScanShape` (so a group's own content can be a `seq`, another nested group, or an alternation via §8e), and only accepts it when `groupInnerSafe` holds. **Key correctness finding:** a group's body may only be treated as an atomic "resolve once, never reconsider" unit when it's a `chars`/`ident`/`seq`/`litFold` (already proven to have exactly one valid greedy match) or a **disjoint** `alt` — a non-disjoint alt inside a group (`(?:a|ab)`) is declined outright, because real backtracking CAN switch to a different arm if something after the group fails (verified: `/^(?:a|ab)c/.exec("abc")` matches via the SECOND arm, only because the first arm's match left "c" unsatisfied — our ordered-dispatch codegen resolves once and never reconsiders, so this case is genuinely unsound to lower and must fall back to `exec`). The same hazard applies to `trailingBacktrackClass` (§8b's lookahead-composition guard), extended here to handle a trailing `group` part and a top-level `alt` shape — again requiring disjointness before trusting the wiggle-room class. **Also generalized `seqIsUnambiguous`** from "check only the immediate next sibling part" to "check against `seqFirstAccept` of everything that follows, through a chain of optionals" — needed because JSON/GraphQL's number pattern has **two consecutive** optional groups (`(?:\.\d+)?(?:[eE][+-]?\d+)?`), and the old immediate-neighbor-only rule would have rejected this chain outright even though each part is provably disjoint from everything that could follow it. This is a strict generalization (verified: every previously-accepted lit/run-only pattern still accepts, plus adversarial genuinely-ambiguous chains still correctly decline). Real, measured wins: the number pattern shared by JSON and GraphQL (`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?` and its float-arm-nested-group variant) now fully lowers to `charCodeAt` dispatch — this was previously the single largest un-lowered hot path across the example grammars — and CSS's `basicSel` (a 3-arm top-level alternation where one arm has its own optional group) now fully lowers too. CSS's `numPart`/`Num` correctly still decline *here*: their alternation's arms overlap on the leading digit class, so `groupInnerSafe` conservatively declines rather than risk the arm-switching hazard. **(Update: `numPart` now lowers — the overlapping-arm group is safe in the *trailing* position; see §8h below. `Num`'s trailing lookahead still declines.)** Verified with 40k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches, including multiple adversarial chained-optional-group and overlapping-group cases designed specifically to stress the generalized ambiguity check), full `compile()`-pipeline parity (interpreter vs `compile()`), and an end-to-end regression sweep across all 6 example grammars (json/graphql/css/lang/toml-ish/csv) confirming no behavior change outside the newly-unlocked patterns. See `test/unit/scannable-regex.test.ts` (`§8f` describe blocks).
- **Trailing non-disjoint-alt group → ordered-commit (§8h-alt)** — closes the gap the §8f entry above explicitly left open (CSS `numPart`/`Num`). A group whose body is a NON-disjoint (overlapping-arm) alternation was declined outright by `groupInnerSafe`, because ordered-choice-commit can pick a shorter arm that a continuation later rejects (`/^(?:a|ab)c/` needs the SECOND arm). **Key finding:** that hazard requires a continuation — when the group is the *trailing, matched-exactly-once* part of its `seq`, nothing follows to force an arm switch, so ordered-commit provably equals the engine. Two-part change: `groupInnerSafe` now admits a non-disjoint `alt` inner, and `seqIsUnambiguous` gates it to the trailing-once position (a trailing *optional/repeated* group, or any non-trailing one, still declines — the "drop the group" / "repeat" choices reintroduce the hazard). Also tightened `shapeFirstAccept` for `alt`: it now returns the true *union* of arm first-sets even when the arms overlap (the `disjoint` flag governs dispatch, not what the shape can start with) — needed so `numPart`'s leading `[+-]?` proves disjoint from the group's `{., digits}` first-set instead of hitting the old blanket `'any'`. This is why the CSS number token — the single biggest un-lowered value-path terminal — now fully lowers as-written (no grammar respelling). CSS `numPart` (`[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)`) is `sequence(numPart, unit)`'s first arm and is attempted on *every* numeric value, so this is a hot path. **`Num`/`numTok` (numPart + trailing `(?![a-zA-Z-￿%])`) still declines — correctly**: its lookahead genuinely needs backtracking (`/…(?!…%)/.exec("50%")` matches `"5"` via a shrunk `\d+`), which a one-pass scan can't reproduce, so `trailingBacktrackClass(number-ish trailing group)` stays `'unsupported'` and the whole lookahead declines to `exec`; the fast `numPart` scan still runs first inside `Dimension`. Verified: 371k exhaustive short-input differential (compiled scan vs native `RegExp`, 0 diffs), full suite (1248 tests) + typecheck, and a controlled A/B on the real `examples/css` grammar over `bootstrap4.css` — full compiled parse **7.31 → 6.21 ms median (~15%)** from this terminal alone. See `test/unit/scannable-regex.test.ts` (`§8h` describe blocks).
- **Non-trailing overlapping-alt groups + group trailing-exposure soundness fix (§8i)** — generalizes §8h beyond the trailing-once position, and in doing so fixes a **pre-existing §8f soundness bug** it uncovered. **The bug:** `seqIsUnambiguous` only ever checked a part's *first*-set against what follows, and only for *skippable/repeated* parts — so a **required-once** `group` whose body ends in an unbounded run, followed by a continuation that overlaps that run, was lowered but is UNSOUND. `(?:\d+)\d` on `"12"`: greedy `\d+` swallows both digits, the trailing `\d` fails, and a one-pass scan reports no-match — but the engine backtracks the run and matches `"12"`. Caught only by differencing against the **compiled** output (the interpreter trivially equals `RegExp`, which is why the earlier §8h `parse()`-based differential missed it); 189 diffs over a short-input sweep. **The fix:** a new `groupPartExposure(part)` computes a group's full right-edge exposure (its body's own trailing wiggle via `trailingBacktrackClass`, plus the drop-exposed first-set when optional/repeated), factored out of `trailingBacktrackClass`'s trailing-group branch so both sites share it. `seqIsUnambiguous` now runs this for **every** `group` part at any position: a concrete exposure class must be disjoint from `seqFirstAccept` of everything that follows (so `(?:\d+)\d` now declines; the JSON-number and CSS-`numPart` groups still lower, their digit exposure being disjoint from the `.`/`e`/unit continuations); an `'unsupported'` exposure keeps the §8h trailing-once gate. **The feature:** a non-disjoint alt whose arms are **fixed-length and pairwise mutually exclusive** (`altFixedMutuallyExclusive` / `fixedClassSeq` — no arm's match can be a prefix, proper or equal-length-overlap, of another's, so at most one arm matches any input and the group has a single fixed end) now reports `null` (no wiggle) from `trailingBacktrackClass`, so it lowers at **any** position — `(?:ab|ac)x`, `(?:foo|barn)z`, `(?:ax|ab)c`. A non-disjoint alt where one arm *is* a prefix of another (`(?:a|ab)`) is not mutually exclusive → stays `'unsupported'` → still gated to trailing-once (§8h), because the engine genuinely arm-switches when the continuation rejects the shorter match. This is the conservative Approach A from the §8h follow-up (fixed-length mutual-exclusivity, not the full prefix-language/divergence-set analysis or `regexp-tree` left-factoring of Approach B — left as future widenings). Verified: **183.7M-input** randomized-pattern differential (compiled scan vs native `RegExp`, 0 diffs across 1037 lowered `X(?:…)Y` patterns), a compiled-output exhaustive differential for `(?:ab|ac)x`, full suite (1263 tests) + typecheck, and a neutral A/B on `examples/css`/`bootstrap4.css` (off the hot path by design — `numPart` still lowers, the 4 remaining fallbacks are the pre-existing i-flag/`{n,m}`/backtracking-lookahead declines, unchanged). **Separately found (pre-existing, since fixed):** the `delimited` recognizer (`<open>(?:…)*<close>`) unsoundly shadowed any `X(?:alternation)*Y` before the seq/group path — `z(?:a|[0-2]+)*a` mis-lowered. Fixed on `release/0.14.0` (`fix(scannable): tighten delimited recognizer to block-comment idiom only`): `parseDelimited`/`delimitedBodySound` now only lower a body that provably can't contain the close (the block-comment idiom `[^l0]` / `[^l0]|l0(?!l1)`); every other `X(?:…)*Y` declines to `RegExp.exec`. Verified by a compiled-vs-native differential over a randomized `X(?:alt)*Y` family (0 diffs). See `test/unit/scannable-regex.test.ts` (`§8i` describe blocks).
- **Bounded counted repeat `{n}` / `{n,}` / `{n,m}` on a run (§8c)** — generalizes the `seq` `run` part from `min: 0|1; unbounded: boolean` to a real `min: number; max: number` (`Infinity` = unbounded), so a counted class/shorthand run lowers to a `charCodeAt` loop (`while (cnt < max && cls) { end++; cnt++ } if (cnt < min) break`) instead of `RegExp.exec`. The four legacy quantifiers map as `+`→`{1,∞}` `*`→`{0,∞}` `?`→`{0,1}` bare→`{1,1}`; the emitter is **purely additive** — existing shapes emit byte-identically (a new counted-loop branch only for finite `max ≥ 2`, and the unbounded branch's min-check generalizes from `=== s` to `- s < min` only when `min > 1`). **The soundness story is one clean predicate:** a greedy one-pass scan of a run has wiggle a backtracker could exploit **iff `max > min`** — which unifies `?`/`*`/`+` and bounded `{n,m}` (`m>n`) under the *existing* `seqIsUnambiguous` disjoint-from-continuation guard, while a **fixed** `{n}` run (`max === min`) has no wiggle and needs no guard at all (it lowers even when the next segment overlaps its class, e.g. `[0-9]{2}[0-9]`). `trailingBacktrackClass` (§8b's lookahead-composition guard) and `fixedClassSeq` (§8i's mutual-exclusivity check) both generalized the same way (wiggle ⟺ `max > min`; a `{n}` run is `n` fixed positions). **Real win:** CSS `colorHex` (`#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])`) now **fully lowers** — the `{3,8}` run *plus* its trailing negative lookahead (§8b composes automatically: the run's wiggle class `[0-9a-fA-F]` is a subset of the lookahead operand, so `lookaheadUnambiguous` proves it safe) — previously entirely on `exec`. The isolated `\uXXXX` body `u[0-9a-fA-F]{4}` also lowers; the full JSON/GraphQL *string* pattern still declines for independent reasons (its outer `(?:alt)*` structure is §8g/delimited territory, unaffected by this change). **Correctly declines:** `[0-9]{2,4}[0-9]` (bounded wiggle overlaps the continuation — greedy would overshoot, the engine backtracks) stays on `exec`; degenerate `{0}`/`{0,0}` (max < 1, matches empty) decline in the parser. Verified: compiled-scan-vs-native-`RegExp` differentials (0 diffs over ~2M inputs incl. the real colorHex-with-lookahead and `u{4}` patterns, plus adversarial decline cases), full suite (1651) + typecheck, CSS perf-guard neutral-or-better. Note the codegen-A/B exec oracle moved from `{1,}`/`{0,}` (which now lower) to the same pattern under the `u` flag (lowering is disabled for `u`). See `test/unit/scannable-regex.test.ts` (`§8c` describe block).
- **Per-node trivia capture kind-filter (`_triviaCaptureMask`)** — the fix that lets a host (jess) get *comments only* out of a node's `triviaLog` without paying to log every whitespace run, so it never has to hand-roll a comment re-scan. A **general kind filter**, not a comment special case: `ctx._triviaCaptureMask` is a bitmask over the active `triviaKindLabels` indices (bit `k` = "record kind `k`"; `undefined` = record all, the default). It gates ONLY the per-node CST trivia log (the `triviaLog` arg a `node()` builder sees); the global `_triviaLog` stays complete, so a downstream trivia map is untouched. Interpreter: one filter point in `recordTriviaChunks` (`src/cst/trivia-kinds.ts`) — global push unconditional, per-node `pushCstTriviaEntry` gated on `mask === undefined || (mask & (1<<kind))`. Compiled: the three labeled trivia emitters (`scanBranchLabeled`, `buildLabeledRegexTriviaFnDecl`, `buildLabeledRuntimeTriviaFnDecl`) wrap the `_cstTriviaLog.push` in `_ctx._triviaCaptureMask === undefined || (_ctx._triviaCaptureMask & <1<<k>)` where `k`/`1<<k` are **compile-time constants** — so a filtered-out kind costs one integer AND, and a captured kind is unchanged. **Zero overhead when per-node capture is off** (the check sits behind the existing `_cstTriviaLog !== undefined` guard, which short-circuits). Wiring: `parser({ trivia, captureTrivia: true, captureTriviaKinds: ['comment'] })` (interpreter, resolves names→mask via the trivia labels), `run(entry, input, { triviaCaptureMask })` (compiled host), the **`_parsemanTriviaKinds(type)` build-host hook** for a PER-NODE-TYPE mask (returns a mask per node type, `undefined` = all; scoped to the node and restored on exit — this is what real grammars need, e.g. `Ruleset`→comments-only while `CompoundSelector`→all so it keeps the whitespace that marks a descendant combinator), or set `ctx._triviaCaptureMask` directly; build a mask with the exported `triviaKindMask(labels, keep)`. The per-type hook is threaded in both the interpreter (`node.ts`) and compiled (`codegen.ts` node scope, alongside the existing `_parsemanCaptureTrivia` gate) paths; interpreter⇔compiled parity in the test. **Proven end-to-end** replacing Jess's `_liftStandaloneComments` source re-scan with a comment-only log-walk: byte-identical output (193 css-parser tests), parse-neutral on both real and comment-dense corpora, no whitespace-capture regression (see `notes/jess-comment-lift-proof/`). This is the parseman-side realization of the "don't overfit `hasComment`" design note below — the primitive stays a general per-kind filter, so a future erasable-but-meaningful trivia kind (pragma, significant-newline) is one more label, not a new capture mode. Interpreter⇔compiled parity + global-log-completeness in `test/parity/trivia-capture-mask.test.ts` (7 cases); full suite (1545) + CSS perf-guard neutral. **Supersedes** the reverted jess-side `_liftStandaloneComments`-off-the-log attempt (which regressed 15–25% because per-node capture logged every whitespace run — exactly what this filter removes).

---

## High priority

### ~~1. Choice fast paths disabled in CST grammars~~ ✅

Moved to **Already landed**.

---

### ~~2. `node()` per-invocation overhead~~ (partial — interpreter only)

Interpreter-only `node()` capture work moved to [`INTERPRETER_PERF_IDEAS.md`](./INTERPRETER_PERF_IDEAS.md).

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

**Rejected micro-tweak (measured, do not retry):** inlining `input.charCodeAt(_e)` at each dispatch branch instead of hoisting `const c = input.charCodeAt(_e)` once per loop iteration. This was an attempt to apply the "repeated inline access beats a hoisted local" finding (the recalibrated-literal / charCodeAt-hoisting result) to the trivia loop. Measured the *opposite* here via an isolated in-process A/B recompiling the real CSS grammar both ways: **hoisting wins** — inline was 0.7–5% slower on bootstrap4 across 4 runs, never faster, and tied-or-slower on selector/decls. The finding doesn't generalize because in this loop `c` is compared across *several distinct branch sites* per iteration (ws class ranges, comment open literal), not two `charCodeAt` calls fused in one boolean expression in a single basic block (where V8's CSE reliably dedups). The hoisted form is already optimal.

### 6b. Generalize the trivia fast-path to value-capturing positions — MED

`trivia-fast-path.ts`'s own doc comments (and `scannable-run.ts`'s: "Trivia … is just the value-discarded instance of this; nothing here is trivia-specific") already claim the underlying dispatch-loop technique is general-purpose — but that generalization only ever happened *within* trivia (see the file's git history: several rounds of "generalize to any scannable-shape set," all still inside the trivia codegen path). Today a plain, ordinary (value-capturing) `oneOrMore(choice(regex(...), regex(...)))` or `many(choice(...))` sitting in a normal grammar position gets **none** of this treatment — `scannable-terminal.ts` only fast-paths a single regex per call site, not a multi-arm choice-loop, and `trivia-fast-path.ts`'s builders (`buildFastTriviaFnDecl`, `buildLabeledScannableTriviaFnDecl`, …) are hardcoded to discard the match and return only the end position (`return _e`).

The reusable ~60–70%: `analyzeTriviaFastPath`'s recognition logic (minus the trivia-specific unwrap) and `composeFastLoop`'s loop skeleton, plus all of `scannable-run.ts`'s shape/branch machinery (`scanShapeFromRegex`, `scanBranch`, `emitShapeMatch`) — none of that is trivia-specific already. The net-new ~30–40%: an emit path that builds a value (`input.slice(start, _e)`) or CST node per matched run instead of discarding it, threading capture-buffer/CST child-append calls per arm the way `emitLeafCapture`/`inline-build.ts` already do elsewhere — essentially a `buildValueScanFnDecl` sibling to `buildFastTriviaFnDecl`. **Guard:** identical to what's already proven for the trivia loop (`scanBranch`'s completion semantics: only advance/log on real progress) — no new ambiguity analysis needed, this is a codegen-target change, not a new safety proof. **Measure:** any grammar with a hot value-capturing `oneOrMore(choice(...))` of scannable regexes — CSS's `anyValueTok`-adjacent value-list loops are a plausible candidate once profiled.

### 7. Common-prefix choice factoring

Arms like `ident '(' …` vs bare `ident` can't use disjoint dispatch. Generalize the CSS grammar hand-merge: parse shared prefix once, branch on lookahead. Complements existing `autoNot` (suffix rejection) but doesn't replace it.

#### 7a. NEXT UP — factor `Dimension`/`Num` into one numeric node (grammar-side; verified 2026-07-16) — SMALL perf + a correctness fix

**Verified against the real jess CSS grammar** (`@jesscss/core` `packages/css-parser/src/grammar.ts`), not projected:

```js
57:  const numPart = regex(/[+-]?(?:\d*\.\d+…|\d+…|\d+)/);
163: const value = choice(g.Dimension, g.Num, g.Color, …);          // Dimension BEFORE Num
186: const Dimension = node(sequence(numPart, regex(/…unit…|%/)));  // number + REQUIRED unit
262: const numTok   = regex(/…numPart…(?![a-zA-Z-￿%])/); // numPart + negative lookahead
267: const Num      = node(numTok);
```

`Dimension` and `Num` are separate ordered `choice` arms that BOTH start with `numPart`, so they
share a first-set → the disjoint-dispatch fast path can't split them → ordered `firstMatch`,
Dimension tried first. **The waste, per unitless number** (`16`, `1.5`, `0` — opacity/line-height/
z-index/flex/calc operands, i.e. very common): enter the `Dimension` `node()` **capture frame** →
scan `numPart` → fail the required unit → **roll the frame back** → enter `Num` → scan `numPart`
**again** + run the `(?!unit)` lookahead. The re-scan is cheap (numPart lowers to a charCodeAt
loop); the **failed-capture-frame enter+rollback** is the real cost, and it lands in the #1-hot
value rule, in the 30%-capture phase — i.e. this removes WORK, not allocation (the class that has
actually moved time; allocation-shaped ideas all measured 0% — see zero-copy / dead-value / §1).

**Fix — one numeric node, unit as an optional glued continuation** ("a Dimension is just a Number
that continues into a unit"):

```js
const numeric = node(noTrivia(sequence(numPart, optional(unitRegex))));
// builder: unit leaf present → Dimension, else → Num
```

- `numPart` scanned once; one capture frame; zero rollback on the common (unitless) path.
- **The `(?!unit)` lookahead disappears** — `optional(unit)` greedily takes an adjacent unit, so
  `16px`→Dimension / `16`→Num disambiguate structurally.
- **Use `noTrivia`, NOT `token`** (`src/combinators/grammar.ts` vs `src/combinators/token.ts`):
  `_buildDimension` reads number and unit as TWO leaves (grammar comment at :185); `token` flattens
  to one `Combinator<string>` and loses the split. `noTrivia` preserves the leaves while killing
  inter-element trivia.

**This is also a CORRECTNESS fix (red test first).** Current `Dimension` is a BARE `sequence`
under the grammar's ambient trivia (`rules({ trivia: rw })` → `sequence` skips trivia between
elements dynamically). So today `16 /* c */ px` and `16   px` skip the trivia and parse as ONE
`Dimension`, when they must be `Num(16)` + a separate `px` token. The `Num` arm's `(?!unit)` only
guards the immediately-adjacent case; it does NOT stop the Dimension arm from eating trivia. So:
- **RED on current grammar / GREEN after `noTrivia`:** `16 /*c*/ px` and `16 px` ⇒ `Num` + separate
  token, not `Dimension`. `16px` ⇒ `Dimension`. `16` ⇒ `Num`. (Exact-equality asserts, no substring.)

**Scope:** Jess-grammar + builder change (`grammar.ts` collapses the two arms; `builders.ts` picks
Dimension/Num by unit-leaf presence). NOT a Parseman-core change — but it's the concrete instance of
the generic §7 factoring; teaching Parseman to detect shared-prefix arms and factor them
automatically is the reusable follow-on (§7c richer dispatch). **Magnitude: honestly single-digit**
overall (numeric tokens are a subset; numPart is cheap) — worth doing for the capture-frame removal
on the hot path AND because it makes the grammar correct and match how it reads. Measure on
value-dense CSS via `pnpm bench:parseman -- --only=css` + a Jess CSS/Less A/B; guard with `perf:guard`.

### 7b. Partial first-char choice dispatch (switch + fallback)

**Problem:** `choice(quotedField, unquotedField)` in CSV is *not* marked `disjoint` because
`unquotedField`'s first set (`[^,\r\n]*`) includes `"` — same as `quotedField`'s leading
literal. So codegen emits **`firstMatch`**: on every unquoted field it still enters the full
`quotedField` arm, fails at `charCodeAt !== 34`, records the miss, then tries `unquotedField`.
That's correct PEG semantics but wasteful on the hot path (almost every field is unquoted).

**Already landed for the fully-disjoint case:** `emitChoice` → `planDisjointDispatch` emits a
`switch (codePointAt(pos))` (or `if/else if` range chain) when *all* arms have pairwise-
disjoint first sets. Keyword/operator grammars get O(1) dispatch today.

**Idea (circle back after CSV perf is stable):**

1. **Partition arms** by first-set overlap:
   - **Unique keys** — exactly one arm can start at code point `c` → `switch` case → try only that arm.
   - **Ambiguous / wide-class arms** — collect into a small fallback `firstMatch` (or `greedyClassify`) subset.
2. **Second-char refinement** — when two arms share a first char but diverge on the second
   (e.g. `\r\n` vs `\n`), nest a switch on `charCodeAt(pos+1)` inside the first-char case.
3. **CSV-specific win without new machinery:** at `"` → quoted only; else → unquoted only.
   Semantically safe: non-`"` inputs never succeed on `quotedField` anyway.

Complements §7 (shared-prefix factoring) and `autoNot` (suffix rejection). Does **not**
replace them — handles the "wide regex arm overlaps a literal-prefix arm" pattern common in
data grammars (CSV, config, log formats).

**Measure:** `csv/small` + `csv/large` speedup ratio; `test/unit/choice-dispatch.test.ts` +
`test/parity/failure-diagnostics.test.ts` for parity.

### 7c. Richer dispatch structures (beyond the flat first-char `switch`)

Today `planDisjointDispatch` emits a `switch (codePointAt)` / `if-else` chain keyed on **one** first code point. Several grammars want more than that:

1. **Keyword trie / char-by-char `switch`** — `choice(literal('||'), literal('>'), literal('+'), literal('~'), literal('|'))` (CSS `combinator`), `choice(kw('fragment'), kw('query'), …)` (GraphQL), `lang` keyword set. Build a small trie and emit nested `switch (charCodeAt(pos + k))`; leaves confirm the full literal. This is the runtime form of `makeWord()` (see cleanup table) and the *literal-alternation* case of 8e — `regex(/even|odd/)` and `choice(literal('even'), literal('odd'))` should share the emitter.
2. **Second-char refinement** (already noted in §7b step 2) — nest `switch (charCodeAt(pos+1))` when arms collide on the first char (`\r\n` vs `\n`, `::` vs `:`, `>=` vs `>`).
3. **Length + `switch` for fixed-width token sets** — when all arms are fixed-length keywords, switch on length first, then compare (branch-free memcmp-style). Good for large keyword tables.
4. **Binary-search range dispatch** — for many *wide-char-class* arms (can't be a jump table), emit a sorted range `if` tree (O(log n)) instead of a linear `if-else if` chain. Helps grammars with dozens of class-keyed arms.
5. **Perfect-hash for large keyword sets** — when a `choice`/alternation has many (>~16) distinct keywords, a generated perfect hash on (length, chars) can beat a deep trie. Measure before adopting; tries usually win at these sizes.

**Guard:** all forms must preserve PEG ordered-choice semantics for overlapping arms (unique-key cases only for the O(1) paths). **Measure:** GraphQL (keyword-dense), CSS `combinator`/`pseudoColon`, `lang`.

### 8. Simple regex lowering ✅ (partial)

`scanShapeFromRegex` shapes lower terminal `regex()` to `charCodeAt` scan loops in `emitRegex` (`scannable-terminal.ts`); trivia uses the same shapes via `trivia-fast-path.ts`. Supported:

- `[X]+` / `[X]*` char-class runs (`chars`)
- `\d`/`\w`/`\s` runs and `\d`/`\w`/`\s` **inside** classes (e.g. `[\d.]+`, `[\s,]+`)
- `[head][tail]*` identifier runs (`ident`), incl. shorthand head/tail
- `<lit>[^X]*` open-until-terminator (`until`) and `<open>…<close>` delimited tokens
- escape-aware quoted strings `<q>(?:[^q\\]|\\.)*<q>` (`string`), incl. `\uXXXX` in classes
- **general linear chains** (`seq`): any sequence of literal segments (required or `x?` optional) and char-class runs (positive/negated, `?`/`*`/`+`). This is the categorical generalization that covers CSS/Less `ident` (`-?[…][…]*`), `customProp` (`--[…]*`), `atKeyword` (`@-?[…][…]*`), `pseudoColon` (`::?`), bare negated runs (`[^…]+`), and non-escaped quoted tokens (`"[^"]*"`) — with **no hardcoded byte values**. A `seq` is only lowered when greedy one-pass scanning provably equals the engine's backtracking (`seqIsUnambiguous`: optional segments must be disjoint from what follows; greedy unbounded runs must be disjoint from the next segment's first-set).
- pure-literal case-insensitive tokens under `/i` (`litFold`, ASCII case-fold), e.g. CSS `url(`

Lowering is disabled for `m`/`s`/`u` flags and for `/i` on anything but a pure literal (case-folding a char class isn't a fixed code-point scan).

**Still open — concrete classes (ordered by payoff × frequency across the example grammars).** Each is a self-contained shape or `seq` extension; the guard column is what keeps a greedy code-point scan provably equal to the engine.

#### ~~8a. `\s` as a fixed code-point set (trivia hot path)~~ ✅

Moved to **Already landed**.

#### ~~8b. Trailing lookahead boundary guard `(?!class)` / `(?=class)`~~ ✅

Moved to **Already landed**.

#### ~~8c. Bounded repeat `{n}` / `{n,}` / `{n,m}` on a class/shorthand run~~ ✅

Moved to **Already landed**.

#### 8d. `/i` on char classes (ASCII case-fold ranges) — MED

Generalize `litFold` from literals to classes: for each range, add its ASCII-folded twin (`[a-z]→+[A-Z]`, etc.), then scan the widened range set. Unblocks CSS `attrMod` `[is]/i` and lets `/i` idents/keywords lower. **Guard:** only fold ASCII `A–Z`/`a–z`; a non-ASCII range under `/i` (Unicode case-fold, e.g. `ß`, `ﬀ`) stays on `exec`. **Measure:** CSS `AttributeSelector`.

#### ~~8e. Top-level alternation `A|B|C` → ordered / first-char dispatch~~ ✅

Moved to **Already landed**.

#### ~~8f. Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)+` → nested `seq`~~ ✅

Moved to **Already landed**.

#### 8g. Lazy-delimited `<open>[\s\S]*?<close>` — LOW

`jsonc` block comment `/\*[\s\S]*?\*/` is "scan to first `<close>`" — the same core as `delimited` but lazy `*?` instead of the negated-body form. Recognize `<lit>[\s\S]*?<lit>` (and `.*?`) as a `delimited` variant. **Measure:** `jsonc` comment-heavy.

#### ~~8h. Trailing non-disjoint-alt group → ordered-commit~~ ✅

Moved to **Already landed** (closes the CSS `numPart` gap §8f left open).

**Next (non-trailing overlapping alternations):** the general form — a non-disjoint-alt group in *non*-trailing position, or an overlapping top-level alternation followed by more — needs a soundness gate (the alt's inter-arm *divergence set* must be disjoint from the continuation's first-set) or an automatic left-factoring pass over `regexp-tree`'s AST at macro time (subsumption + suffix-factor + prefix re-partition into a disjoint form). Bigger, and off the current hot path; deferred. Related cleanup surfaced while scoping this: `regexp-tree` is a compile-time analysis library but was imported by the *runtime* `regex()` combinator — **done**, see below.

#### ~~Runtime `regex()` no longer statically depends on `regexp-tree`~~ ✅

`regexp-tree` was ~264 KB of `regex.ts`'s 271 KB runtime import graph (measured: bundling `regex.ts` alone = 271 094 B; with `regexp-tree` external = 7 148 B). Two changes: (1) **deleted `optimizeRegex`** outright — it did essentially nothing (only trivial char-class reordering; verified it leaves `abc|abd` and the CSS number regex unchanged) and additionally dragged in `regexp-tree`'s `optimizer`/`generator`/`transform` submodules. The now-redundant `_def.optimizedSource` field (always `=== source`) is dropped; codegen uses `def.source` directly. (2) **`firstSetFromRegex` moved to `src/combinators/regex-analyze.ts`** (the sole `regexp-tree` importer), reached from `regex.ts` through a `RegexFirstSetAnalyzer` injection seam (`registerRegexAnalyzer`). `index.ts` registers it as an import side-effect, so **every real code path — interpreter, JIT `compile()`, and the macro (its evaluator does `import * as parseman from '../index.ts'`) — gets byte-identical first-sets**. A consumer importing `regex` from the combinator subpath *without* the entry gets a permissive `any()` first-set (the same value `firstSetFromRegex` already returned on an unparseable pattern) — this only disables choice-dispatch fast paths, never changes a match. **Result:** `regex.ts` bundles to 2 527 B with `regexp-tree` absent; a lean `import { regex }` consumer tree-shakes it to 2 471 B / 0 B of `regexp-tree`; `index.ts` still bundles it (interpreter needs it). Full suite (1248) + typecheck pass. **Next (drop it for interpreter users too):** replace the `regexpTree.parse` call in `regex-analyze.ts` with a hand-rolled first-set parser producing the same AST shape `extractFirstSet` consumes — the injection seam means nothing else changes, and `regexp-tree` becomes a dev-only differential-test oracle.

---

## Lower priority / cleanup

| Target | Issue | Fix |
|--------|-------|-----|
| `emitSkip` | Still uses `try/catch {}` | `emitFallible` |
| `withCtx` | `{ ..._ctx, state: … }` allocates | Save/restore `_ctx.state` |
| ASCII-only grammars | `codePointAt` in disjoint dispatch | `charCodeAt` when first-set proves BMP-only |
| ~~Dense disjoint choices~~ ✅ | ~~Long `if/else if` chains~~ | `switch` jump table when arms key off ≤48 discrete first code points; if/else kept for wide char-class arms (`emitChoice` → `planDisjointDispatch`) |
| ~~`makeWord()` at macro time~~ ✅ | ~~Expands to regex per keyword~~ | Moved to **Already landed** — `emitKeywordsFast` |
| Macro build time | Sequential `compile()` per rule | Parallel compile; cache by combinator-tree hash |

---

## Measuring

- `pnpm bench` — external parser comparison only (Peggy, Parsimmon, Chevrotain, Nearley, Jison, native JSON).
- `pnpm bench:parseman` — Parseman interpreted vs compiled across all example grammars (with baseline Δ). For tweak loops, narrow it: `pnpm bench:parseman -- --only=json --scale=0.5 --samples=7`.
- `pnpm bench:literal` — literal-match A/B (`slice` vs `startsWith(value, pos)` vs `charCodeAt`) for interpreter `literal()` work.
- `pnpm bench:codegen` — codegen A/B micro-benchmarks.
- `pnpm bench:compile-grammars` — regenerate precompiled Peggy, Nearley, and Jison parsers in `bench/` after editing `bench/*.pegjs` or `bench/vendor/`.
- `pnpm bench:svg` — chart-only benchmarks (JSON/CSV/GraphQL/CST-JSON) + regenerate `assets/bench-*.svg` for the README. Much faster than `pnpm bench`; init bars stay pinned in `bench/chart-types.ts`.
- `pnpm bench:baseline` — refresh `bench/parseman-baseline.json` **and append** a snapshot to `bench/parseman-history.jsonl` (commit both to track the needle over time).
- `test/perf/parseman-perf.test.ts` — smoke + CSS tight speed regression guard (robust median) + full-suite gross guard (single-pass). Excluded from default `pnpm test` (heavy by design); run via `pnpm test:perf`.
- `pnpm perf:guard` — pre-commit: CSS-only robust guard (~2s). `pnpm perf:guard --all` — every grammar.
- `test/perf/codegen-ab.test.ts` + `bench/codegen-ab.ts` — within-process A/B that isolates the two codegen optimizations (machine-independent, no old-git-state needed):
  - **regex scan lowering** — a scannable `+`/`*` terminal (charCodeAt) vs the SAME grammar with `{1,}`/`{0,}` (identical matches, stays on `RegExp.exec`). Realistic many-short-token regime: **~2.3× faster**. Single very long token: scan loses to native exec (~0.3×, printed as contrast, not asserted). Uses `__setForceDisjointIf` / semantic-equivalent quantifiers so no production code changes.
  - **switch vs if/else disjoint dispatch** — same choice compiled both ways via `__setForceDisjointIf`. ~1.0× (neutral; switch is cleaner for many arms, no perf cost).
- `test/perf/css-parser.test.ts` — CSS correctness + bootstrap timing when fixture available.
- `test/parity/trivia-kinds.test.ts` — labeled trivia kind indices: interpreted vs compiled parity.
- `test/parity/trivia-log-regression.test.ts` — interpreted/compiled `_triviaLog` golden parity.
- `test/parity/compiler-capture-choice.test.ts` — capturing choice fast-path parity.
- `test/unit/codegen-output.test.ts` — snapshot guard on emitted JS shape.
- `test/parity/compiler.test.ts` — correctness after codegen changes.

**Parseman baseline** (`bench/parseman-baseline.json`): CI regression anchor — median µs/op for interpreted **and** compiled on JSON, CSV, GraphQL, TOML-ish, lang, and CSS fixtures. Updated deliberately when you accept a new perf level.

**Parseman history** (`bench/parseman-history.jsonl`): append-only time series (one JSON line per `bench:baseline`). `pnpm bench:parseman` reports Δ vs baseline plus Δc↓prev / Δc↓origin from history. `printHistoryIndex()` lists bootstrap4 compiled µs across all snapshots.

---

# Jess parser hotspots (from @jesscss render profiling) — 2026-07-05

> ⚠️ **STALE PROFILE — re-measure before trusting any number below.** This
> profile was taken `2026-07-05` against jess core `parseman 0.14.0` compiled
> grammars. It has since been partly invalidated by core changes on the SAME
> day and after — most visibly the **#2 hotspot `ensureProv` is GONE**: jess
> `2b39c8072` (2026-07-05) inlined the node span onto `Node` and killed the PROV
> WeakMap, `311cf9232` left only sparse slot-spans in flag-gated WeakMaps, and
> `cc9888e29` deleted dead provenance CST plumbing. So the #2/#3 rows are dead
> and the #1 reify (61.9%) / trivia shares can no longer be assumed to hold their
> proportions. **Numbers here are a stamped snapshot, not current truth.** Before
> ranking any idea off this table, re-run a fresh profile on current jess core —
> `run(entry, input, { profile: true })` (added parseman 0.27.0) gives the
> recognizer / structuralCapture / hostConstruction phase split; add a V8 CPU
> sample for self-time. Then correct the rows IN PLACE (strike them), don't append.

**Source of this section:** the @jesscss/core render re-profile flagged PARSE as
the #1 render hotspot (~42% of a render). Investigating *inside* the parser
subsystem (parseman 0.14.0 compiled grammars + the @jesscss builder hosts) to
find where that parse time goes, with measured evidence. **Ideas only — nothing
here has been implemented.** Owner: leave core alone; these are parser-team
candidates.

## Honesty caveat: parse-once vs parse-per-render

`@jesscss` `Compiler.render()` **re-parses the source on every render**
(`Compiler.render` → `context.parseString(...)`; no AST cache keyed by input —
`packages/jess/src/index.ts:1026`). So the render re-profile that put PARSE at
~42% is measuring parse-per-render. Real-world usage parses a stylesheet **once**
and can render/re-render the AST many times; against a parse-once/render-many
baseline, parse's amortized share is far lower. **Treat the numbers below as the
per-parse cost, not the steady-state render weight** — they matter most for
cold-start / single-render / watch-mode-edit-a-file scenarios, and for the
`Compiler` re-parse itself (an AST cache would erase most of it, but that's a
jess-side change, out of scope for the parser team).

## Measurement setup

- Corpus (Less): `packages/jess/benchmark/benchmark.less` — 106,802 chars,
  **12,984 AST nodes** (~8.2 source chars / node), ~8.8 MB retained AST / parse.
- Corpus (CSS): synthetic value/selector-dense sheet, 248,040 chars.
- Driver: functional Less/CSS parser (`parseLessFn` / `parseCssFn`) run under
  parseman's macro register hook (`--import scripts/parseman-macro-register.mjs`),
  V8 CPU sampling profiler (50 µs interval, 40 parses), `--trace-gc`, and the
  compiled-grammar source (via `parseman/plugin` `transform`) for static
  allocation-site counts.
- Parse median: **Less 55.6 ms** (106 KB), **CSS 58.5 ms** (248 KB).

## Aggregate self-time split (Less benchmark.less, 40 parses)

| Bucket | self-time | % |
|--------|-----------|---|
| **reify `_r_*` (compiled grammar rule fns)** | **2400 ms** | **61.9%** |
| provenance `ensureProv` (per-node WeakMap side-table) | 280 ms | 7.2% |
| GC (garbage collector) | 277 ms | 7.1% |
| build\* (CST→AST host: `buildNode`/`_dispatchBuild`/`_build*`) | 271 ms | 7.0% |

The compiled reify layer dominates. On the value/decl-dense **CSS** corpus the
mix shifts: **GC 28.2%**, **`ensureProv` 12.5%**, reify 35.6%, `_dispatchBuild`
2.4% — i.e. the per-node allocation + side-table cost climbs sharply when nodes
are small and numerous (Num/Dimension/Color).

## Hotspot ranking with evidence

Self-time %, from the Less CPU profile unless noted. `_r_<Rule>` = the compiled
reify function parseman emits for that grammar rule.

| # | fn | self % | where | note |
|---|----|--------|-------|------|
| 1 | `_r_value` | 6.3% | less `grammar.ts:249` region / css `grammar.ts:152` | value disjunction `choice(Dimension,Num,Color,Url,CalcCall,Call,Paren,Quoted,anyValue)` run per value token |
| 2 | `ensureProv` | 5.6% (Less) / 12.5% (CSS) | core `provenance.ts:46` | **per-node `{}` alloc + `WeakMap.set`** via `setSourceSpan` in every Node ctor |
| 3 | `_r_InterpolatedSelector` | 4.9% | less `grammar.ts:249` | `sequence(optional(regex),many(regex),lessInterp,many(choice(...)))` — two `many` arrays + interp scan per interpolated selector |
| 4 | `_r_ComplexSelector` | 3.8% | less `grammar.ts` selectors | combinator run |
| 5 | `_1533bf42__tf0` | 3.2% | compiled trivia-skip fn | whitespace/comment skip called at every `many`/`sequence` boundary |
| 6 | `_r_LessAmpersand` | 2.9% | less `grammar.ts:247` | `sequence(ampToken, optional(sequence(literal('('), scanTo(...), literal(')'))))` per `&` |
| 7 | `_r_simpleSelector` / `_r_CompoundSelector` | 2.8% / 2.2% | less selectors | inner selector-run reifiers |
| 8 | `_r_topProduct` / `_r_topSum` | 2.7% / 2.2% | less math | operation folding per value |
| 9 | `_r_PseudoSelector`, `_r_SelectorList`, `_r_AttributeSelector`, `_r_Declaration`, `_r_Ruleset`, `_r_Dimension`, `_r_Call`, `_r_Reference`, `_r_valueList`, … | 0.9–2.5% ea. | grammar | the long reify tail — collectively the bulk of the 61.9% |
| 10 | `buildNode`/`_dispatchBuild`/`_buildLessDeclaration`/`_buildDeclaration` | ~7% combined | less+css `builders.ts` | CST→AST host; per-node `loc` + filtered child arrays |

### Static allocation-site counts in the compiled Less grammar (3.99 M chars emitted)

| pattern | count | meaning |
|---------|-------|---------|
| `const _arr = []` | 465 | a fresh array per `many(...)` / repetition, even when 0–1 matches |
| `.push(` | 2520 | per-child CST collection |
| `.build(` | 207 | AST node construction call sites |
| `_cstRawChildren?` length marks | 1810 | CST raw-child bookkeeping |
| `_cstLeaves?.` length marks | 1052 | CST leaf bookkeeping |
| `_triviaLog?` length marks | 1105 | trivia-log bookkeeping |
| `charCodeAt` | 5213 | scan sites (mostly fine; noted for scale) |

`--trace-gc` shows a Scavenge roughly every ~33 ms during a parse loop
(reclaiming ~58 MB each) — confirming the transient CST allocation is the GC
driver, on top of the ~8.8 MB retained AST.

## Optimization IDEAS (evidence-backed; NOT implemented)

1. **Reify per-`many` array pre-sizing / lazy alloc.** Every `many(...)` emits
   `const _arr = []` then `.push()` per match (465 arrays, 2520 pushes in the Less
   grammar). For the *common* selector/value runs the arity is 0, 1, or 2. IDEA:
   emit a lazy/scalar fast path in `emitMany`/`emitSequence` — keep a single-element
   scalar until a 2nd match forces array promotion. Sub-idea: when a `many` feeds
   directly into a `.build()` whose builder only iterates, pass the CST child cursor
   range (start/end indices into a shared buffer) instead of materializing a fresh
   array — no intermediate array at all.

   **⚠ MEASURED OUTCOME (2026-07-05): the *dead-value* subset of this — eliding the
   aggregate array/tuple of a `many`/`sequence`/`optional` whose value is only ever
   discarded under a `node()` — has LANDED (parseman `markUnusedValues`, both the
   interpreter and the compiled emitter; see `src/compiler/value-usage.ts`). On the
   real macro-compiled Less grammar it cut `const _arr = []` 258→172 (−33% of the
   value arrays) but moved transient allocation only 47.3 → 43.9 MB/pass (~7%) and
   parse time NOT AT ALL (57 ms both). So the value-array building is NOT the 61.9%
   — it is a small slice of allocation and off the hot CPU path. The reify self-time
   is dominated by choice dispatch, trivia-skip, and CST-buffer bookkeeping (see #2,
   #5, #6), NOT array construction. Do not expect a big win from the remaining
   lazy/scalar-promotion part of this idea either.** The full lazy/scalar promotion
   would only help the arrays that ARE consumed-but-tiny; given the dead ones gave
   ~7% alloc / 0% time, size the expectation accordingly.

2. **Pool/reuse the CST bookkeeping marks.** ~3967 `_cstRawChildren?` /
   `_cstLeaves?.` / `_triviaLog?` length-mark reads per compiled grammar, each a
   property-existence check + length read at every rule entry/backtrack point.
   IDEA: hoist the three length snapshots into locals once per rule frame
   (many are re-read inside the same `many` loop body), and/or skip the
   raw-children/leaf tracking entirely for rules whose builder never consults
   `rawChildren` (a compile-time flag per `node()` — many builders use only
   `children`). This is the parseman-side complement to the `_dispatchBuild`
   host cost.

   **⚠ LARGELY LANDED (verified in `src/compiler/codegen.ts`, 2026-07-11) — do not
   treat as an available "cheap, broad" win.** Both halves of this idea now exist:
   the **skip** half is `armNeedsRollback = ctx.capturing && (mayLeavePartialCapture(p)
   || (armHasAutoNot && capturesLeaf(p)))` (`codegen.ts:1387`) — the leaf/raw/trivia
   marks are only *emitted* when the arm can actually leave a partial capture — plus
   the builder-consults-it gates `capturesTrivia`/`buildReadsTrivia` and the runtime
   `_hostReads(build, n)` arity probe and the per-type `_parsemanCaptureTrivia` hook.
   The **hoist / don't-read-`?.length`-4×-on-the-hot-path** half was also already
   done and is documented in the `captureRestoreBody` comment (`codegen.ts:564-583`):
   the exact regression this idea fears ("reading `_x?.length ?? 0` four times per
   fallible block … compiled CSS regressed ~2.3×") was found and fixed by gating the
   whole save/restore on a single boolean and only reading when a buffer is live.
   What remains unlanded is a marginal intra-frame **buffer-reference** hoist (`const
   _rc = _ctx._cstRawChildren` to cut repeated `_ctx.` reads) — but the length itself
   mutates as children push, so only the *reference* is hoistable, and it only touches
   the **cold CST-capture path** (most runtime callers request only the value, no CST).
   Micro-opt, not the broad lever the ~3967-count implied.

3. ~~**`ensureProv` per-node allocation (2nd-ranked; 5.6%→12.5%).**~~ ✅ **FIXED BY
   CORE — do not chase.** The profile above (2026-07-05) caught the OLD shape:
   every node did `ensureProv(node)` → allocate a `{}` Provenance + `WeakMap.set`,
   12,984 allocs + WeakMap inserts/parse, and it was the #1 GC driver. **That was
   re-architected the same afternoon.** jess `2b39c8072` ("inline source-span
   provenance onto Node, kill PROV WeakMap") moved the node-level span to inline
   monomorphic Node fields (`_spanStart`/`_spanEnd` + `F_HAS_SPAN` bit); `311cf9232`
   left only the SPARSE per-slot value/field spans in flag-gated WeakMaps. The `{}`
   alloc and per-node WeakMap insert are gone; `ensureProv` no longer exists. The
   inline-fields solution is strictly better than the "defer / dense-array-by-index"
   idea this entry used to propose — that idea is moot. **Lesson: this hotspot's
   numbers here are stale; re-profile current jess core before ranking provenance
   against anything.** (Core owner already handled it; nothing for the parser team.)

4. **`buildNode` host: kill the per-node `loc` object and per-build filtered
   arrays.** `_dispatchBuild` calls `spanToLocation(span)` → `{start,end}` per
   node (12,984/parse), and `nodeChildren`/`leafText` do `children.filter(...)`
   (fresh array) per build (css/less `builders.ts:102-113,366`). IDEA: pass
   `span.start`/`span.end` as two numbers into the node ctors (no wrapper
   object), and replace `.filter()` child partitioning with a single pass that
   the reifier already knows the shape of (the grammar knows which children are
   leaves vs nodes at compile time — emit typed positional access instead of a
   runtime filter). This is a jess-builders change but is driven entirely by how
   parseman hands children to `ctx.build`, so it's worth co-designing.

5. ~~**Trivia-skip fn (`_tf0`, 3.2%) call-site reduction.**~~ ⚠️ **EXPLORED
   2026-07-16 — real but SMALL, no free redundancy; deprioritized.** Read the
   compiled less grammar (`@jesscss/less-parser/lib/grammar.js`): 394 `_tf0` call
   sites. Findings: (a) **no double-skip** — rule bodies do NOT skip leading trivia
   on entry (they open with the per-`node()` capture-frame setup, not `_tf0`), so
   the caller's skip + a rule-entry skip never stack; (b) **no back-to-back `_tf0`**
   anywhere, so no adjacent-redundant-skip to delete; (c) the elidable subset is
   narrow **because CSS/Less are whitespace-permissive** — trivia is legal at nearly
   every boundary, and the genuinely-glued spots (number→unit, `::`, `funcname(`)
   are already single regexes or (post-§7a) `noTrivia`-wrapped, which already omit
   the call. Per-call empty-path cost is low (call + 2–3 `charCodeAt` + return). Net
   ceiling is well under the 3.2% (most of which is calls that DO skip real trivia).
   Capturing even the tail needs manual `noTrivia` (author work) or an automatic
   trivia-forbidden first-set proof (real feature + soundness burden). **Not worth
   prioritizing ahead of §7a.** Same conclusion applies to Q-40 candidate #3
   ("explicit no-trivia boundaries"). **Two bigger things seen while reading:**
   (i) the per-`node()` capture-frame header (6 ctx-field saves + buffer installs +
   `_hostReads`/`_parsemanCaptureTrivia` gate computations, ×~22.6k nodes) is the fat
   part of node entry — this is the "per-node scope save/restore" lever flagged as
   unmeasured in [[zero-copy-range-builder-negative]], higher-risk (adjacent runtime-
   indirection attempts measured +32–50%, see §2), but where capture-phase time
   actually is; (ii) the 0.27.0 profiling boundary now emits `_ctx._pmProfile?.phase`
   checks inline in every node header — cheap (undefined short-circuit off-profile)
   but NOT zero-codegen-overhead; wants an A/B to confirm no measurable per-node cost.

6. ~~**`_r_value` disjunction ordering / first-char dispatch.**~~ ✅ **ANSWERED
   (verified 2026-07-16) — dispatch IS firing; residual = §7a, not dispatch.**
   Read the actual compiled value choice in BOTH `@jesscss/css-parser/lib/grammar.js`
   (monolithic) and `@jesscss/less-parser/lib/grammar.js` (composed/fused): each arm
   is first-char guarded off one `codePointAt` (`_chcode`), 0 unresolved `@FS`
   placeholders — the fuse-time first-set dispatch shipped on parseman release/0.15.0
   (~30% jess win) is working end-to-end. Disjoint arms (`Color` `#`, `Quoted`,
   `Paren`) are correctly skipped. The ONLY residual waste is the OVERLAPPING arms:
   Dimension and Num carry the **identical** guard (`43 || 45..46 || 48..57`), so a
   unitless number passes the Dimension guard, enters+fails `_r_Dimension`, then
   enters `_r_Num` — the double-entry §7a fixes. First-char dispatch structurally
   CANNOT separate same-first-char arms; only §7a common-prefix factoring can. So
   there is no "sub-dispatch keyed on the char after the numeric run" to add here —
   the fix is §7a's structural collapse. (CalcCall/Call is the same story on the
   ident-led arms — §7 idea #2.) See [[macro-firstset-dispatch-unsound]].

7. **Value / math-expression precedence-chain descent cost (operator-precedence rules).**
   *Parked — a bounded constant-factor parse win, not the dominant scaling cost.*

   **Evidence (distinct from the `benchmark.less` profile above).** A controlled
   CPU profile (`node:inspector`, 50 µs sampling interval) of **jess-alpha
   `bb3b31863` compiling the real Less `functions.less`**, compared against
   Less 4.6.7, ranks the value-expression grammar rules very differently from the
   `benchmark.less` run in the hotspot table (§ "Hotspot ranking with evidence",
   where `_r_value` was #1 and `_r_topProduct`/`_r_topSum` sat at #8, 2.7%/2.2%).
   On this value/function-heavy file:

   - **`_r_topSum` (grammar.js) and `_r_topProduct` are the #1 and #2 hottest
     self-time functions in the *entire* jess compile.** `_r_value` and the
     condition-arg rules (`_r_CondArgAndOp` / `_r_CondArgAnd` / `_r_CondArgTermOp`)
     are close behind.
   - On value/function-heavy Less this value-expression grammar is **~30–40% of
     parse time** (and parse is ≈ 60% of a small-file compile).

   This is workload-dependent: the same rules are a modest slice on selector-heavy
   `benchmark.less` but dominate on value-dense `functions.less`.

   **What the cost actually is (NOT backtracking).** The precedence chain is
   `sequence(base, many(sequence(opParser, base)))` stacked N levels deep — the
   `leftAssoc` shape, identical to this repo's `examples/lang/parser.ts` (7 levels:
   `unary→mul→add→cmp→eq→and→or`). On the overwhelmingly common **bare value with no
   operator**, a token descends *every* level, and at each one pays: enter a
   rule/node scope, allocate an empty `_arr` for the `many`, try the operator
   `choice` (fails on the **first char**), then fold the transform over an empty
   `rest`. That is a **fixed-depth descent with a single failed first-char lookahead
   per level**, not retry/backtracking — each position is parsed at most once on the
   success path. It tops the profile because it runs once per value token on
   value-dense input (O(tokens)), not because of superlinear re-derivation. The cost
   is the per-level node scope + empty-array + fold — the same reify/CST-bookkeeping
   story as #2/#5, restricted to the value path.

   **Why parked (not urgent).** Parse cost is roughly **LINEAR** in input size
   (~6–7× Less 4.x, and flat) — so this is a bounded constant-factor win, not the
   dominant scaling cost. The dominant scaling cost is eval, not parse (see the
   cross-reference below). Worth doing eventually; not the strategic lever.

   **Directions to explore (options, not prescriptions):**

   - **Collapse the no-operator level — the real lever.** When
     `many(sequence(opParser, base))` provably matches zero times (the operator
     `choice`'s first-char set is absent) and the level's transform is identity on
     the single-operand case, the whole level should collapse to its `base`: no node
     scope, no empty `_arr`, no fold. This is **§2.3 "compile-time transparent-wrapper
     elimination when `buildSrc` is `(c) => c[0]`"** combined with a first-set-guarded
     no-op `many` elision — a pure shape-collapse guarded by first-set disjointness
     (the same proof discipline §8 already uses), reusable across *every* precedence
     grammar, not jess-specific.
   - ~~Memoize / packrat the descent to cut backtracking.~~ **Rejected direction** —
     there is no re-derivation at a position to memoize; a clean precedence descent
     visits each position once per level. A memo table would put per-position writes
     on a path that already visits each position once → net-negative, exactly the
     "helper prelude / table indirection" class measured at **+32–50%** in §2. Don't.
   - Profile whether the condition-arg rules (`_r_CondArg*`) can **share** the
     value descent instead of re-deriving it.
   - Compare against **Less 4.x's** cheaper `expression` / `operand` / `addition`
     scanner approach. Note that Less 4.x's parser matches regexes against source
     slices and builds the AST directly (**no separate CST-capture layer**), which
     is a large part of why its value/math path is far cheaper in absolute terms —
     any parseman equivalent still pays the CST-capture bookkeeping (§2, §5).

   **Local measurement target.** The jess-alpha profile isn't reproducible in this
   repo, but `examples/lang/parser.ts` has the identical 7-level `leftAssoc` chain
   and is value/expression-heavy — use it (not the retired alpha) as the in-repo A/B
   for any implementation of the level-collapse above.

   **Cross-reference.** This is the **parse-side** lever. The bigger strategic
   target is the **eval-side** allocation/GC gap (~85× Less 4.x), which is being
   worked separately on the jess core side (object-reduction / spine render
   architecture) — not here.

   ---

   **TESTED — negative result (2026-07, branch `perf/precedence-collapse`, not landed).**
   Built the level-collapse as a real, shared-tag `precedence()` combinator (both the
   interpreter and codegen recognize `{ tag: 'precedence' }`) and A/B'd it against the
   existing `leftAssoc` shape on the real `examples/lang` grammar. **It does not help.**

   *The shape built.* A precedence-table combinator, tightest-row first, stacking
   handled internally so the ladder reads declaratively:

   ```ts
   precedence(unary, [ ['*','/'], ['+','-'], ['<=','>=','<','>'], ['==','!='], ['&&'], ['||'] ])
   ```

   Bare op strings auto-wrap to `literal`; a default combine builds
   `{ type:'binary', op, left, right, span }` (per-node spans — a correctness upgrade
   over `leftAssoc`, which stamps every node with the whole-chain span). Designed row
   vocabulary: `assoc:'left'|'right'|'none'` and `mixing:false` (homogeneous run — the
   jess/media `and`/`or`-can't-mix rule) and `{ prefix:[…] }` (unary, e.g. `not`, `-`).
   Only left-assoc infix was implemented (enough to A/B). Both paths guard the loop on
   the operator's first-set, so the no-operator case returns the operand directly — no
   array, no `combine` — with identity-on-empty true **by construction** (no sentinel
   probe needed). Correct: interpreter ≡ compiled structurally, full suite green.

   *Why it doesn't help — the measurement.* The scaffolding the collapse removes (the
   `sequence` tuple + empty `many` array + fold) is **not** the per-level bottleneck on
   a realistic grammar:

   | scenario | leftAssoc | precedence | result |
   |---|---|---|---|
   | synthetic chain, no trivia, **trivial `ident` operand** | 123 ns | 29.5 ns | 4.2× |
   | **real lang grammar**, no trivia | 17.7 µs | 18.3 µs | 0.96× (noise) |
   | real lang grammar, trivia on | 32.3 µs | 32.0 µs | 1.01× (noise) |

   The 4× only appears when the operand is a **straw** (`ident`), which inflates the
   scaffolding's share. With a realistic operand (`unary→call→atom→ident`), parsing the
   operand dwarfs the per-level array/tuple/fold, and V8 escape-analyzes the scaffolding
   away regardless. Trivia scanning per level piles on identically for both shapes.

   *Correction to the framing above.* The "§2.3 transparent-wrapper elimination +
   first-set no-op `many` elision" lever is real but its payoff is bounded by *operand
   triviality*, not just chain depth — and real operands are never trivial. The profile's
   `_r_topSum`/`_r_topProduct` #1/#2 self-time is therefore most likely **inlined-operand
   time attributed to the fold frame**, or genuine operator-dense folding (which both
   shapes do equally), **not** removable no-op scaffolding. Do not re-chase this as a perf
   lever. (`precedence()` may still be worth having as an ergonomics/correctness feature —
   readable table, correct per-node spans — but that's a DX decision, not a perf one.)

   *Method lesson.* A single A/B on the **real grammar** answers "does it help?" in one
   step. Microbenchmarks that model the *mechanism* (here, a chain over a trivial operand)
   share confounds and gave three false positives before the real grammar exposed them.
   Measure the real thing first; drop to microbenchmarks only to *explain* a real delta.

### Top ideas in one line each

- **#1 lazy/scalar `many` in the compiled reifier** — ⚠ the dead-value part landed
  and measured at only ~7% alloc / 0% time; array building is NOT the 61.9%. Not
  the big lever. The real reify cost is dispatch + trivia + CST bookkeeping (#2/#5/#6).
- **#2 hoist/skip CST length-mark bookkeeping** for builders that ignore
  `rawChildren` — ⚠ **largely LANDED** (`mayLeavePartialCapture`/`capturesTrivia`/
  `_hostReads` skip + the single-boolean save/restore gate in `codegen.ts`); only a
  cold-path buffer-reference hoist remains. NOT an available cheap/broad win.
- ~~**#3 defer/dense-array `ensureProv`** — 12,984 per-node `{}`+WeakMap inserts is
  the 2nd hotspot and the main GC driver (worse on CSS: 12.5%).~~ ✅ **DONE BY CORE**
  — jess `2b39c8072` inlined the node span onto `Node` (monomorphic fields +
  `F_HAS_SPAN`), killed the PROV WeakMap; only sparse slot-spans remain (flag-gated).
  `ensureProv` deleted. The dense-array idea is moot — inline fields beat it. (verified 2026-07-16)
- **#4 drop per-node `loc` object + filtered child arrays in `buildNode`.**
- **#7 value/math precedence-chain descent** (`_r_topSum`/`_r_topProduct`) — #1/#2
  self-time on value-heavy Less (`functions.less`); ~30–40% of parse. Fixed-depth
  descent + one failed first-char lookahead per level (NOT backtracking). ❌ **TESTED
  and SHELVED** (branch `perf/precedence-collapse`): built as a real `precedence()`
  combinator; the collapse is 4× only over a *trivial* operand, noise on the real
  grammar (real operands dominate; V8 eats the scaffolding). Not a perf lever — see
  the TESTED block under §7. Don't re-chase.
- Remember the **parse-once/render-many** caveat: an AST cache in `Compiler` (jess
  side) would amortize all of the above for the common re-render case.

## Q-40 follow-up queue: fresh Parseman-versus-Less flow evidence

Added 2026-07-14 after tracing the generated Parseman flow against Less 4.x.
This section is a ranking and an agent handoff, not an implementation claim.
The current detailed phase baseline is Parseman recognizer-only `12.784 ms`,
structural capture `28.873 ms`, and CSS-CST host construction `37.558 ms`,
versus Less 4.6.3 native AST parse `4.417 ms` on the same 106,797-byte fixture,
Node v24.11.1, 12 warmups, and 45 samples. A later equal-contract run measured
Parseman recognizer-only `12.58 ms` and Less parse `6.01 ms`; reconcile the
fixture/node-count difference before treating either as a new gate.

The important attribution is that Parseman's current "recognizer-only" mode is
the normal generated structural parser with output suppressed at runtime. It
still executes structural collector save/install/restore, profile/output
branches, rollback checks, trivia checks, and named-rule call ladders. That is
generic Parseman work. Less's mutable cursor/save stack is part of its lower
cost, but Less also benefits from declaration-before-ruleset dispatch and a
raw `anonymousValue()` path taken by 2,024/2,902 benchmark declarations
(69.7%). Those latter choices belong to the Less grammar/host, not Parseman.

### Experimental result — compile-time stripped recognizer (2026-07-15; unpublished)

The first generic implementation proof now exists on local branch
`feature/true-recognizer-20260715`, commit `c84d777`. It adds an opt-in
`compile(..., { mode: 'recognizer' })` code-generation contract that emits only
acceptance, end-offset, and failure-cursor data. It removes collector
setup/restore, CST/raw/trivia/field capture, host/node construction,
output-only profile branches, dead output temporaries, and output-state
cloning, while retaining lookahead, guards, context operations, rollback,
consumed offsets, and diagnostics. This is generic Parseman behavior; it does
not know about CSS, Less, or comments.

The isolated equal-contract result was positive: JSON-like input improved
`0.180875→0.095291 ms` (`−47.32%`) and the real `106,802`-byte Less grammar
improved `7.38425→5.534 ms` (`−25.06%`), with p95 and GC neutral-or-better.
Focused contract coverage was `39/39`, perf coverage `5/5`, and typecheck,
build, and lint passed. The full Parseman suite still has the unrelated
baseline source-shape failure at `test/unit/build-arity.test.ts:116`
(`1,735` passed, `1` failed). The branch could not be pushed because SSH
credentials were unavailable; no published package or default parser behavior
changed.

Jess adoption was tested separately and rejected for now: the disposable
candidate reduced parse+render by `4.95%` but increased render-only by `1.09%`,
and the current Jess grammar does not opt into the recognizer mode. Both
phases were byte-identical at `131,578` bytes (SHA-256
`98a0536086c7e555b1a98e2372ad4000d51e25f1418c6345b6b8a9a97d80972f`). Keep
this as an unpublished architecture proof, not as a Jess or Parseman release
claim. (It was once framed as not replacing "the zero-copy structural-builder
target below" — but that target has since been built through the fused path and
measured neutral; see candidate #2, now shelved.)

### Ranked candidates

1. **Compile-time output-contract variants — highest generic leverage.**
   Generate separate recognition, ordinary-value, structural-capture, and
   host-building variants from one grammar, instead of making every generated
   rule test a runtime phase flag. The recognition variant should omit
   collector setup, CST/raw/trivia buffers, host calls, node construction,
   profile branches, and output-only state cloning while retaining lookahead,
   guards, context operations, rollback, consumed offsets, and diagnostics.
   This is the clean generic answer to the proven structural-protocol cost; it
   must not know anything about CSS, comments, or Less values. It is a parser
   architecture experiment, not permission to weaken the existing capture
   contract.

2. **Zero-copy structural builder input — ❌ TRIED THROUGH THE FUSED PATH; NEUTRAL, DON'T SHIP.**
   The real profile's largest avoidable family is per-node CST/raw-child
   materialization, not value arrays: raw/child/trivia bookkeeping was measured
   as a 28–51% ceiling in isolated capture probes, while dead value-array
   elision produced about 7% allocation relief and 0% parse-time change. The
   idea was an opt-in generic builder contract that pushes children onto a
   shared arena and hands the host a windowed `CstRangeView` instead of
   allocating a fresh `children`/`rawChildren` array per node.

   **This was built end-to-end and measured neutral.** Branch
   `feature/parseman-zero-copy-builder-20260715` (worktree
   `/private/tmp/parseman-zero-copy-builder-20260715`) carried it past the POC:
   `950e8b4` prototype range builders → `53a5bfb` arena-as-stack (killed the
   POC's 4 wrapper objects/node) → `04c0573` **wired the range runtime through
   the `compileLinkable`/fused path** (closing the "Jess adoption blocked, proof
   only wires `compile()`" gap this entry used to name) → `b395706` widened
   `CstRangeView` to the array-read methods real hosts use (filter/map/find/
   some/slice/iterator).

   **The earlier "parse-time win" was a measurement artifact — do NOT trust the
   old `10.97 ms → 4.35 ms` number.** That was a single-process A/B: array mode
   ran first and made the host's `children.filter(...)`/`.length`/`for..of` call
   sites monomorphic for `Array`, then range mode fed them a `CstRangeView` →
   megamorphic deopt/recompile. Whichever mode ran **second** ate the penalty;
   the delta followed run-order, not the representation. Redone correctly
   (separate process per mode, bootstrap4.css, 22.6k nodes, 3 runs): **array
   ~26.9 ms vs range ~26.8 ms (indistinguishable), transient ~50 vs ~51 MB
   (indistinguishable).** The "−13% memory" claim was the same single-process
   GC-timing artifact.

   **Why it's structurally neutral (not just noisy):** phase decomposition is
   recognize 34% / capture-bookkeeping 30% / host-builder 36%. Zero-copy only
   removes the array-alloc *slice* of the 30% capture — and per the dead-value
   elision finding, array building is ~0% of capture **time** (the cost is
   trivia/raw/span bookkeeping). There is no time sitting in those arrays to
   reclaim, so even a perfect `(buffer, start, end)` primitives contract can't
   beat neutral. **Verdict: do not ship** — not because it regresses, but
   because a provably-neutral feature with real added surface (arena lifecycle,
   view/primitives contract, builder rewrites) is complexity for nothing. The
   branch stays as an architecture reference, not a shippable path.

   *Caveat on "tried": this settles the range-view-through-the-fused-host shape.
   A different shape — e.g. partition-at-capture so builders skip the
   `filter(isLeaf)`/`filter(isNode)` split — was separately sized and is also a
   small, **conditional** prize (breaks builders needing ordered interleaved
   `children[i]` access), so it's declined on the no-conditional-wins rule, not
   because it was benchmarked. The one clean bit there is a Jess-side
   single-pass-builder fix (~0.6–1 ms), which needs no Parseman change.*

3. **Explicit no-trivia boundaries — safe call-site reduction.** Add a generic
   `noTrivia`/adjacent-token contract (or equivalent grammar metadata) that
   lets codegen omit the trivia-skip call where whitespace/comments are
   semantically forbidden. Do not infer this from CSS or from a weak first-set
   guess. Prove the boundary in interpreter and compiled modes, including
   comments and rollback failures. The current `_tf0` profile share is about
   3.2%, so this is a bounded follow-up, not the primary capture fix.

4. **Capture-plan specialization.** Replace the remaining per-node runtime
   feature checks with a compile-time capture plan describing whether a node
   needs semantic children, raw children, trivia, fields, state, and rollback
   marks. This should consolidate the already-landed arity/trivia gates rather
   than add another hook or reflection path. Measure generated code size and
   both capture and non-capture parses; do not land a frame object or side map
   without a whole-parser A/B.

   #### 4a. SCOPED 2026-07-16 — the per-`node()` scope save/restore (the last unmeasured capture lever)

   **Target (concrete):** `emitNode` (`src/compiler/codegen.ts:2134-2171`) emits, per
   `node()`, an **unconditional** save of 6 `_ctx` fields (`_sc/_sl/_sr/_st/_stl` +
   `_smk`), an install of fresh capture buffers, and a restore of all 6 on exit — so
   ~12 `_ctx` property ops **per node × ~22.6k nodes/parse**. Confirmed by reading the
   compiled less header (every `_r_*` opens with exactly this). This is DISTINCT from
   (and unaffected by) the already-gated **fallible-block** restore (`captureRestoreBody`,
   `codegen.ts:597-644` — "gate the whole save/restore on a single boolean"): that fix
   covers sequence-term rollback, NOT the node-scope frame.

   **Rule OUT first (don't re-chase):** the two array allocs (`_ch`/`_raw`) are ~0% time
   ([[dead-value-elision-landed]]); the gate computations are memoized (`??=`) so cheap
   after node 1; profile-phase checks short-circuit off-profile. The only candidate cost
   is the 6 saves + 6 installs + 6 restores themselves.

   **Direction (the ONLY safe one):** a compile-time capture-plan that emits **fewer
   save/install/restore lines** for a node whose SUBTREE provably never touches a given
   field — e.g. a leaf whose subtree never trivia-captures skips `_st/_stl/_smk`; one
   whose subtree never reads rawChildren skips `_sr`. This is compile-time line-selection,
   **NOT** a runtime frame object / depth-indexed stack — that shape was rejected TWICE
   (§2: +50% and +32-47%), and "eager `[],[],[]` beat branchy indirection." Runtime
   indirection is off the table; only emitting-less-code is on it.

   **Soundness burden (the real cost):** "node N needn't save field X" requires proving
   **no descendant rule reachable from N modifies X** — a whole-subtree reachability pass
   over the grammar (does the subtree contain any `node()`/trivia/field-capturing construct
   that writes X?). Conservative default: save unless proven-clean. Composed grammars
   complicate it (an overridden rule's subtree can change) — must resolve at fuse time like
   the §FS first-set dispatch, or stay conservative across compose boundaries.

   **MEASURE BEFORE BUILDING (discipline — this family has over-projected every time):**
   step 1 is NOT the analysis. It's a throwaway codegen variant that drops the 6-field
   save/restore for a hand-picked always-safe leaf rule (or globally, accepting
   incorrectness, purely to time it), A/B'd separate-process on bootstrap4 + benchmark.less.
   **Kill condition:** sub-1% delta → DROP (it joins zero-copy / host-filter / trivia-elision
   / dead-value in the "mechanism looked big, measured single-digit" pile). Only a real
   multi-% delta justifies building the whole-subtree capture-plan. **Prior: LOW** — but it
   is the last un-measured item in the 30% capture phase, and unlike the others it is cheap
   to falsify before committing. See [[zero-copy-range-builder-negative]] (flagged this exact
   lever as "one unmeasured possibility that could still matter … don't chase without building").

5. **Host-boundary allocation contract.** Keep this explicitly parser-adjacent,
   not a generic Parseman semantic change: measure an opt-in builder path that
   receives span start/end numbers instead of a per-node `loc` object and uses
   positional/range access instead of `children.filter(...)`. The profile
   attributes roughly 7% combined to `buildNode`/dispatch/host work. This needs
   Jess/CSS host ownership and exact AST/output/CST parity, so it should follow
   the generic range experiment rather than be mixed into it.

6. **Late value materialization and Less dispatch.** Keep this outside Parseman:
   test declaration-before-ruleset candidate ordering and broaden Less's
   authored scalar/opaque-value path for colors, decimals, units, and multi-token
   values with explicit type tags. This is potentially valuable for Jess but
   cannot be used to justify a generic Parseman optimization or a string-only
   parser contract.

7. **Do not prioritize more regex lowering or value-array cleverness.** Regex
   execution is only about 2.6% of the measured CSS parse, and prior keyword/
   escape-identifier lowering moved whole-parse time by 0%. Dead-value array
   elimination already measured allocation relief without parse-time movement.
   These remain valid future work only when a new profile identifies a target.

### Host-integration proof — DONE, and it is what settled the neutral verdict

The host-integration proof this section used to request as future work **was
carried out** (commits `04c0573`/`b395706` above): the range-view runtime was
wired through the actual `compileLinkable`/fused host contract used by Jess and
A/B'd on the real Jess CSS/Less host. Under a correct separate-process
methodology the parse-time "win" did **not** survive — it was array-vs-view
inline-cache poisoning in a single process — and the array/range paths are
indistinguishable on both time and transient heap. That is precisely why
candidate #2 above is now shelved rather than promoted. Do not re-run this as an
open question; the answer is neutral.

Any future agent must NOT re-propose as new wins: this range-view/zero-copy
builder (settled neutral through the fused path), partition-at-capture (small +
conditional), the rejected trivia-call guard, the recognizer-only node-frame
bypass, the raw-child alias proof, the precedence-chain collapse, or a
CSS-specific comment mode. Landed gates to compose with, not reinvent, live in
`src/compiler/codegen.ts`: `capturesTrivia`, `buildReads*`,
`mayLeavePartialCapture`, and the rollback marks.

## Jess builder-host proposals (from jess `docs/future/parseman-perf-proposals.md` — reshaped/corrected)

Parseman-side changes proposed by the jess side to cut the `builders.ts` + capture
cost, reviewed against the measured findings above and reshaped. Each still needs an
A/B (neutral-or-better) + all-four-parser-suites-green + CST byte-identity before landing.

- **Comment-lift without the whitespace-capture regression — ✅ LANDED** as the per-node
  trivia capture kind-filter (see Already-landed). The jess proposal's "comment-only
  capture *mode*" (`kindIndex === blockComment`) was **reshaped to a general per-kind
  filter** (`_triviaCaptureMask`), so it doesn't overfit the primitive to comments and
  also carries `//` line comments for free (a `blockComment`-only branch would have
  dropped them). Recovers most of `_liftStandaloneComments`' host-side cost.

- **Collapse `children`/`rawChildren` when a node captures no trivia — real, but bank it
  as allocation/GC, not wall-clock.** This is the same insight as idea #2 above ("skip
  raw-child bookkeeping for builders that ignore `rawChildren`"). The jess doc grades it
  "highest-value / halves per-node cost"; **temper that** — dead-value elision already
  removed 33% of value arrays for **~7% alloc / 0% time** (idea #1's measured outcome),
  and reify self-time is dispatch + trivia + CST bookkeeping, not array construction. Do
  it (low risk, gated on the existing `capturesTrivia` compile-time flag), expect GC
  relief. Note the aliasing invariant: pass one collector as both `children` and
  `rawChildren` only where they provably never diverge (jess gates divergence to
  `CompoundSelector`).

- **Fused trivia-skip + first-token dispatch (`_tf0`).** Split into two:
  - *(b) per-call-site skip-only vs skip+log* — worth doing; aligns with the landed
    `_tfN(…, cap?)` merge and the kind-filter (which is the per-kind instance of this).
  - *(a) fuse the post-`_tf0` `charCodeAt`+bounds read into the skip's return* —
    **speculative; measure with low expectation.** This is the same micro-tweak class
    measured *neutral-to-negative* twice (the trivia-loop "inline vs hoist `charCodeAt`"
    rejection in §6, and the recalibrated-literal charCodeAt finding). A likely-bigger
    `_tf0` lever the jess doc omits is idea #5: **elide the trivia call entirely** where
    the grammar proves adjacent terms can't be trivia-separated (`noTrivia` / first-set
    proof) rather than calling `_tf0` to have it return the same position.

- **Single-frame node-scope save/restore — highest regression risk of the set; prototype-
  gate.** The per-call `ParseContext` spread is *already gone* (landed: "mutate `_ctx`
  fields instead of spreading"); what remains is ~6 field writes. Bundling them into a
  frame object / depth-indexed stack is exactly the shape rejected twice under §2
  ("Runtime helper prelude" +50%, "Inline lazy buf" +32–47%; eager `[],[],[]` beat
  branchy indirection). Only land behind a genuinely neutral-or-better A/B on the full
  CST byte-identity suite; be ready to bin it.

- **Declarative host-capture descriptor (drop the `_hostReads` `toString`/regex) —
  cleanliness, not perf.** Memoized to ~once-per-arity-per-parse, so not hot. Fold into
  the children/rawChildren collapse as hygiene; never land standalone for perf.

## Design note: Trivia API — don't overfit `hasComment` (owner-flagged)

**Status (parseman side): the capture primitive now honours this** — per-node trivia
capture filters by a general **kind mask** (`_triviaCaptureMask` / `triviaKindMask`), never
a hardcoded "comment" branch (see Already-landed). The guidance below still governs the
*jess-core* `hasComment` boolean and any future classification field.


**Not a perf item.** A design caution for whoever evolves the trivia primitive.

`makeTrivia` (jess core `packages/core/src/tree/util/trivia.ts:52`) derives
`hasComment` as "the run contains any non-whitespace char" — a `charCodeAt` scan
that trips on the first char that isn't space/`\t`/`\n`/`\r`/`\f`. So it is really
**`hasNonWhitespace`**; it only *equals* "has a comment" by virtue of the grammar
invariant that `trivia = whitespace | comment` (nothing else can appear in a
trivia run today).

Why that's a lossy bit to build on:

- It **cannot distinguish `//` line comments from `/* */` block comments**. That
  matters for output: `printableTriviaText` (`trivia.ts:86`) blanket-strips
  `//[^\n\r]*` whenever `hasComment` is set in a compressed context — because a
  `//` can't survive line-collapse, whereas an inline `/* */` can. One bit can't
  carry that distinction; it works only because the strip regex happens to be a
  no-op on block comments.
- It would **mislabel any future erasable-but-meaningful trivia as a "comment"** —
  e.g. a directive/pragma trivia, a preserved-annotation token, or a
  significant-newline marker — the moment the grammar admits trivia that isn't
  purely whitespace-or-comment. Consumers keying off `hasComment` would then
  silently mis-handle it.

**Guidance (owner): don't overfit the trivia primitive to "comment."** We don't
yet know what trivia consumers will want to skip vs. preserve vs. classify. Keep
it general:

- The run already exposes **position + raw range** (`{ start, end, src }`) — that
  is the durable, lossless contract; let consumers classify the slice themselves
  when they need to.
- If a classification bit/field is warranted, carry a **`kind`** (or per-segment
  kinds, matching the labeled-trivia-kind capture already landed for `_triviaLog`)
  rather than a boolean that conflates categories.
- Treat the existing boolean as **`hasNonWhitespace`** semantically (rename or at
  least document it as such), and don't add new call sites that assume
  `hasComment === "there is a comment here"`.

This keeps the trivia layer forward-compatible with trivia kinds the grammar
doesn't emit yet, instead of baking today's `ws|comment`-only assumption into the
API surface.
