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
- **`\s` as a fixed code-point set** — `\s`/`[\s…]` now lower to a `charCodeAt` scan (`SPACE_RANGES` next to `shorthandRanges`'s `\d`/`\w`), same as `\d`/`\w`. `\s`'s set (WhiteSpace + LineTerminator) is fixed regardless of the `u` flag, so no ambiguity guard was needed. Unblocks `lang` `\s*` trivia, `graphql` ws, and any `\s`-based `seq` (e.g. `[^)"'\s]+`-style `urlInner`). See `test/unit/scannable-regex.test.ts` (`\s+` parity + codegen-uses-scan assertion) and `test/unit/trivia-fast-path.test.ts`.
- **Recalibrated `literal()` charCodeAt/startsWith crossover (4 → 16 chars)** — `emitLit`/`emitLiteralCondition` were switching to `input.startsWith()` above 4 chars, but measurement (see below) shows the unrolled `charCodeAt` chain is actually faster or tied all the way out to ~256 chars, with `startsWith` only winning on raw runtime past ~256–512. The `4` threshold meant almost every real literal (`important`, `instanceof`, HTTP header names, …) was silently taking the slower path. Moved to `CHARCODE_CHAIN_MAX = 16` instead of raising all the way to the runtime crossover, because the unrolled chain's *generated source* grows ~4–30× faster than `startsWith`'s near-constant call site — 16 caps worst-case codegen bloat while still covering every literal that appears in this repo's example grammars (longest: `important`, 9 chars) with room to spare. See `test/unit/codegen-output.test.ts` (pins the exact 16/17-char crossover), `test/unit/macro-transform.test.ts`, `test/parity/compiler-capture-choice.test.ts`.
- **Trailing lookahead boundary guard `(?!class)`/`(?=class)`** — a token followed by a char-class lookahead lowers to a post-match `charCodeAt(end)` check (new `lookahead` `ScanShape`), unlocking `lang`'s five keyword boundaries (`if(?!\w)`, `then(?!\w)`, `else(?!\w)`, `true(?!\w)`, `false(?!\w)` — verified directly, not just by analogy). CSS `colorHex`/`Num` still fall back to `exec` since their bases need `{n,m}` bounded repeat (§8c) / groups (§8f), which don't exist yet — that's a real, expected gap, not a regression. **Important correctness finding beyond the original idea write-up:** a naive "lower the inner shape, then check once" is NOT always safe when the inner shape ends in an unbounded/optional run — real backtracking can rescue a shorter match that a one-shot check would miss (verified empirically: `/^[0-9]+(?=[5-9])/.exec('12345')` returns `["1234"]`, not a total failure). Added `lookaheadUnambiguous` (mirrors `seqIsUnambiguous`'s reasoning): safe iff the inner shape's trailing backtrackable class is a **subset** of the operand (negative lookahead) or **disjoint** from it (positive lookahead); shapes with no trailing quantifier at all (pure literals, `litFold`) are unconditionally safe. `until`/`delimited`/`string`/nested-`lookahead` bases are declined outright (unmodeled backtracking semantics) rather than risk an unproven guard. Verified with 140k randomized fuzz inputs against native `RegExp` (0 mismatches) plus a deliberate bypass-the-guard case that DOES mismatch (proving the guard is load-bearing, not just defensive). See `test/unit/scannable-regex.test.ts` (`§8b` describe blocks). Closed the follow-on gap too — see the `emitKeywordsFast` entry below.
- **`keywords()`/`word()`/`makeWord()` compiled fast path (`emitKeywordsFast`)** — closes the gap the §8b lookahead work deliberately left open. Every word is a fixed literal (optionally wrapped in the shared boundary lookahead), so this reuses the exact `seq`/`litFold`/`lookahead` `ScanShape` machinery instead of building one `RegExp.exec` alternation — unconditionally ambiguity-safe, since `trailingBacktrackClass` treats a single-literal `seq`/`litFold` as fixed-length (nothing for a backtracker to shrink), so wrapping either in a lookahead is safe for ANY boundary class. Real, measured impact: GraphQL's `kw('true')`, `kw('false')`, `kw('null')`, `kw('on')`, `kw('fragment')`, and `keywords(['query','mutation','subscription'], …)` all now compile to `charCodeAt` dispatch instead of a sticky regex — confirmed directly against the real grammar (`examples/graphql/parser.ts`), not just in isolation. Declines to the regex fallback for: an empty-string keyword, a keyword containing an astral code point (same BMP-only limitation as the rest of this file — caught by fuzzing an emoji keyword, which silently failed to match before the guard was added), an unparseable boundary class, and `caseInsensitive` + a boundary together (would need ASCII-folding the boundary ranges too, i.e. the general §8d problem — left on the safe path rather than risk narrowing which chars the boundary excludes). **Bugs caught by fuzzing before landing:** (1) the first version returned the canonical keyword string as the matched value instead of `input.slice(pos, end)`, which is wrong whenever `caseInsensitive` lets the actual input differ in case from the keyword (e.g. matching `"ABC"` must return `"ABC"`, not `"abc"`) — fixed. (2) the astral-code-point gap above. Verified with 120k+ randomized fuzz inputs against native `RegExp` across keyword sets with shared prefixes (`instanceof`/`in`), case-insensitivity, and boundaries (0 mismatches after both fixes). See `test/unit/keywords.test.ts`, `test/unit/macro-transform.test.ts`.
- **Top-level alternation `A|B|C` → dispatch (§8e)** — a new `alt` `ScanShape`: split a regex source on top-level `|` (outside any `[]`/`()`, one redundant whole-string `(?:…)` wrapper stripped first so `(?:a|b)`-style patterns split too), lower each arm independently via the existing recognizers (so an arm can itself be a `seq`/`chars`/`ident`/`lookahead`/…), and decline the WHOLE alternation if any single arm doesn't lower (e.g. an arm with its own nested group — §8f). Two dispatch strategies, chosen by comparing every pair of arms' first-char sets (`shapeFirstAccept`/`classDisjoint`, reusing the same subset/disjoint math as §8b's lookahead guard): **disjoint** → an if/else-if chain keyed on each arm's first-char class, straight to the one matching arm (no ordering to preserve); **overlapping** → an ordered labeled-block trying each arm in turn, taking the first that succeeds — which is regex `|`'s ACTUAL semantics (first alternative to match at all wins on its own greedy length; verified directly against native `RegExp`, e.g. `/^a|ab/.exec('ab')` → `"a"`, not `"ab"` — it is NOT longest-match). A shape that can match empty (`[x]*` with no `+`) degrades its first-set to "any", forcing ordered dispatch rather than falsely claiming disjointness. Real motivating CSS patterns: `anyValueTok` (`[+\-*/=<>|~^]+|[^\s;{}\[\]()'",!]+` — clean 2-arm overlapping case, exercises both the literal-`|`-inside-a-bracket-class and escaped-bracket-inside-a-negated-class edges of the splitter) and `Dimension`'s trailing `-?ident|%` (clean disjoint case) both now fully lower. `basicSel`/`nth`/`numPart` correctly still decline — each has an arm with its own nested `(?:…)` group, which needs §8f too; this is an expected, documented gap, not a bug. Verified with 30k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches) across both dispatch strategies, plus full `compile()`-pipeline parity tests (interpreter vs `compile()`; macro mode blocked in this sandbox by an unrelated pre-existing `oxc-parser` native-binding issue, confirmed to affect even already-landed macro tests identically). See `test/unit/scannable-regex.test.ts` (`§8e` describe blocks).
- **Non-capturing groups `(?:…)`, `(?:…)?`, `(?:…)*`, `(?:…)+` → nested `seq` (§8f)** — a new `group` `SeqPart`: `parseSeqParts` recognizes `(?:…)` (paren-depth-tracked, bracket-classes skipped atomically), recursively lowers the body via `parseScanShape` (so a group's own content can be a `seq`, another nested group, or an alternation via §8e), and only accepts it when `groupInnerSafe` holds. **Key correctness finding:** a group's body may only be treated as an atomic "resolve once, never reconsider" unit when it's a `chars`/`ident`/`seq`/`litFold` (already proven to have exactly one valid greedy match) or a **disjoint** `alt` — a non-disjoint alt inside a group (`(?:a|ab)`) is declined outright, because real backtracking CAN switch to a different arm if something after the group fails (verified: `/^(?:a|ab)c/.exec("abc")` matches via the SECOND arm, only because the first arm's match left "c" unsatisfied — our ordered-dispatch codegen resolves once and never reconsiders, so this case is genuinely unsound to lower and must fall back to `exec`). The same hazard applies to `trailingBacktrackClass` (§8b's lookahead-composition guard), extended here to handle a trailing `group` part and a top-level `alt` shape — again requiring disjointness before trusting the wiggle-room class. **Also generalized `seqIsUnambiguous`** from "check only the immediate next sibling part" to "check against `seqFirstAccept` of everything that follows, through a chain of optionals" — needed because JSON/GraphQL's number pattern has **two consecutive** optional groups (`(?:\.\d+)?(?:[eE][+-]?\d+)?`), and the old immediate-neighbor-only rule would have rejected this chain outright even though each part is provably disjoint from everything that could follow it. This is a strict generalization (verified: every previously-accepted lit/run-only pattern still accepts, plus adversarial genuinely-ambiguous chains still correctly decline). Real, measured wins: the number pattern shared by JSON and GraphQL (`-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?` and its float-arm-nested-group variant) now fully lowers to `charCodeAt` dispatch — this was previously the single largest un-lowered hot path across the example grammars — and CSS's `basicSel` (a 3-arm top-level alternation where one arm has its own optional group) now fully lowers too. CSS's `numPart`/`Num` correctly still decline *here*: their alternation's arms overlap on the leading digit class, so `groupInnerSafe` conservatively declines rather than risk the arm-switching hazard. **(Update: `numPart` now lowers — the overlapping-arm group is safe in the *trailing* position; see §8h below. `Num`'s trailing lookahead still declines.)** Verified with 40k+ randomized fuzz inputs per pattern against native `RegExp` (0 mismatches, including multiple adversarial chained-optional-group and overlapping-group cases designed specifically to stress the generalized ambiguity check), full `compile()`-pipeline parity (interpreter vs `compile()`), and an end-to-end regression sweep across all 6 example grammars (json/graphql/css/lang/toml-ish/csv) confirming no behavior change outside the newly-unlocked patterns. See `test/unit/scannable-regex.test.ts` (`§8f` describe blocks).
- **Trailing non-disjoint-alt group → ordered-commit (§8h-alt)** — closes the gap the §8f entry above explicitly left open (CSS `numPart`/`Num`). A group whose body is a NON-disjoint (overlapping-arm) alternation was declined outright by `groupInnerSafe`, because ordered-choice-commit can pick a shorter arm that a continuation later rejects (`/^(?:a|ab)c/` needs the SECOND arm). **Key finding:** that hazard requires a continuation — when the group is the *trailing, matched-exactly-once* part of its `seq`, nothing follows to force an arm switch, so ordered-commit provably equals the engine. Two-part change: `groupInnerSafe` now admits a non-disjoint `alt` inner, and `seqIsUnambiguous` gates it to the trailing-once position (a trailing *optional/repeated* group, or any non-trailing one, still declines — the "drop the group" / "repeat" choices reintroduce the hazard). Also tightened `shapeFirstAccept` for `alt`: it now returns the true *union* of arm first-sets even when the arms overlap (the `disjoint` flag governs dispatch, not what the shape can start with) — needed so `numPart`'s leading `[+-]?` proves disjoint from the group's `{., digits}` first-set instead of hitting the old blanket `'any'`. This is why the CSS number token — the single biggest un-lowered value-path terminal — now fully lowers as-written (no grammar respelling). CSS `numPart` (`[+-]?(?:\d*\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?|\d+)`) is `sequence(numPart, unit)`'s first arm and is attempted on *every* numeric value, so this is a hot path. **`Num`/`numTok` (numPart + trailing `(?![a-zA-Z-￿%])`) still declines — correctly**: its lookahead genuinely needs backtracking (`/…(?!…%)/.exec("50%")` matches `"5"` via a shrunk `\d+`), which a one-pass scan can't reproduce, so `trailingBacktrackClass(number-ish trailing group)` stays `'unsupported'` and the whole lookahead declines to `exec`; the fast `numPart` scan still runs first inside `Dimension`. Verified: 371k exhaustive short-input differential (compiled scan vs native `RegExp`, 0 diffs), full suite (1248 tests) + typecheck, and a controlled A/B on the real `examples/css` grammar over `bootstrap4.css` — full compiled parse **7.31 → 6.21 ms median (~15%)** from this terminal alone. See `test/unit/scannable-regex.test.ts` (`§8h` describe blocks).
- **Non-trailing overlapping-alt groups + group trailing-exposure soundness fix (§8i)** — generalizes §8h beyond the trailing-once position, and in doing so fixes a **pre-existing §8f soundness bug** it uncovered. **The bug:** `seqIsUnambiguous` only ever checked a part's *first*-set against what follows, and only for *skippable/repeated* parts — so a **required-once** `group` whose body ends in an unbounded run, followed by a continuation that overlaps that run, was lowered but is UNSOUND. `(?:\d+)\d` on `"12"`: greedy `\d+` swallows both digits, the trailing `\d` fails, and a one-pass scan reports no-match — but the engine backtracks the run and matches `"12"`. Caught only by differencing against the **compiled** output (the interpreter trivially equals `RegExp`, which is why the earlier §8h `parse()`-based differential missed it); 189 diffs over a short-input sweep. **The fix:** a new `groupPartExposure(part)` computes a group's full right-edge exposure (its body's own trailing wiggle via `trailingBacktrackClass`, plus the drop-exposed first-set when optional/repeated), factored out of `trailingBacktrackClass`'s trailing-group branch so both sites share it. `seqIsUnambiguous` now runs this for **every** `group` part at any position: a concrete exposure class must be disjoint from `seqFirstAccept` of everything that follows (so `(?:\d+)\d` now declines; the JSON-number and CSS-`numPart` groups still lower, their digit exposure being disjoint from the `.`/`e`/unit continuations); an `'unsupported'` exposure keeps the §8h trailing-once gate. **The feature:** a non-disjoint alt whose arms are **fixed-length and pairwise mutually exclusive** (`altFixedMutuallyExclusive` / `fixedClassSeq` — no arm's match can be a prefix, proper or equal-length-overlap, of another's, so at most one arm matches any input and the group has a single fixed end) now reports `null` (no wiggle) from `trailingBacktrackClass`, so it lowers at **any** position — `(?:ab|ac)x`, `(?:foo|barn)z`, `(?:ax|ab)c`. A non-disjoint alt where one arm *is* a prefix of another (`(?:a|ab)`) is not mutually exclusive → stays `'unsupported'` → still gated to trailing-once (§8h), because the engine genuinely arm-switches when the continuation rejects the shorter match. This is the conservative Approach A from the §8h follow-up (fixed-length mutual-exclusivity, not the full prefix-language/divergence-set analysis or `regexp-tree` left-factoring of Approach B — left as future widenings). Verified: **183.7M-input** randomized-pattern differential (compiled scan vs native `RegExp`, 0 diffs across 1037 lowered `X(?:…)Y` patterns), a compiled-output exhaustive differential for `(?:ab|ac)x`, full suite (1263 tests) + typecheck, and a neutral A/B on `examples/css`/`bootstrap4.css` (off the hot path by design — `numPart` still lowers, the 4 remaining fallbacks are the pre-existing i-flag/`{n,m}`/backtracking-lookahead declines, unchanged). **Separately found (out of scope, pre-existing, NOT fixed here):** the `delimited` recognizer (`<open>(?:…)*<close>`) unsoundly shadows any `X(?:alternation)*Y` before the seq/group path — `z(?:a|[0-2]+)*a` mis-lowers — flagged for a follow-up. See `test/unit/scannable-regex.test.ts` (`§8i` describe blocks).

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

**Rejected micro-tweak (measured, do not retry):** inlining `input.charCodeAt(_e)` at each dispatch branch instead of hoisting `const c = input.charCodeAt(_e)` once per loop iteration. This was an attempt to apply the "repeated inline access beats a hoisted local" finding (the recalibrated-literal / charCodeAt-hoisting result) to the trivia loop. Measured the *opposite* here via an isolated in-process A/B recompiling the real CSS grammar both ways: **hoisting wins** — inline was 0.7–5% slower on bootstrap4 across 4 runs, never faster, and tied-or-slower on selector/decls. The finding doesn't generalize because in this loop `c` is compared across *several distinct branch sites* per iteration (ws class ranges, comment open literal), not two `charCodeAt` calls fused in one boolean expression in a single basic block (where V8's CSE reliably dedups). The hoisted form is already optimal.

### 6b. Generalize the trivia fast-path to value-capturing positions — MED

`trivia-fast-path.ts`'s own doc comments (and `scannable-run.ts`'s: "Trivia … is just the value-discarded instance of this; nothing here is trivia-specific") already claim the underlying dispatch-loop technique is general-purpose — but that generalization only ever happened *within* trivia (see the file's git history: several rounds of "generalize to any scannable-shape set," all still inside the trivia codegen path). Today a plain, ordinary (value-capturing) `oneOrMore(choice(regex(...), regex(...)))` or `many(choice(...))` sitting in a normal grammar position gets **none** of this treatment — `scannable-terminal.ts` only fast-paths a single regex per call site, not a multi-arm choice-loop, and `trivia-fast-path.ts`'s builders (`buildFastTriviaFnDecl`, `buildLabeledScannableTriviaFnDecl`, …) are hardcoded to discard the match and return only the end position (`return _e`).

The reusable ~60–70%: `analyzeTriviaFastPath`'s recognition logic (minus the trivia-specific unwrap) and `composeFastLoop`'s loop skeleton, plus all of `scannable-run.ts`'s shape/branch machinery (`scanShapeFromRegex`, `scanBranch`, `emitShapeMatch`) — none of that is trivia-specific already. The net-new ~30–40%: an emit path that builds a value (`input.slice(start, _e)`) or CST node per matched run instead of discarding it, threading capture-buffer/CST child-append calls per arm the way `emitLeafCapture`/`inline-build.ts` already do elsewhere — essentially a `buildValueScanFnDecl` sibling to `buildFastTriviaFnDecl`. **Guard:** identical to what's already proven for the trivia loop (`scanBranch`'s completion semantics: only advance/log on real progress) — no new ambiguity analysis needed, this is a codegen-target change, not a new safety proof. **Measure:** any grammar with a hot value-capturing `oneOrMore(choice(...))` of scannable regexes — CSS's `anyValueTok`-adjacent value-list loops are a plausible candidate once profiled.

### 7. Common-prefix choice factoring

Arms like `ident '(' …` vs bare `ident` can't use disjoint dispatch. Generalize the CSS grammar hand-merge: parse shared prefix once, branch on lookahead. Complements existing `autoNot` (suffix rejection) but doesn't replace it.

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

#### 8c. Bounded repeat `{n}` / `{n,}` / `{n,m}` on a class/literal — MED

A counted run: `while (count<max && cls) { end++; count++ }; if (count<min) fail`. Unblocks CSS `colorHex` `[0-9a-fA-F]{3,8}` and the `\uXXXX` escapes inside JSON/GraphQL string bodies (`u[0-9a-fA-F]{4}`). Fits as a third `run` quantifier in `seq` (`min`, `max`). **Guard:** same greedy-disjoint rule as unbounded runs when followed by another segment. **Measure:** CSS `Color`; JSON/GraphQL string-heavy.

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

- `pnpm bench` — external parser comparison (Peggy, Parsimmon, Chevrotain, Nearley, Jison) **plus** Parseman interpreted vs compiled across all example grammars (with baseline Δ).
- `pnpm bench:compile-grammars` — regenerate precompiled Peggy, Nearley, and Jison parsers in `bench/` after editing `bench/*.pegjs` or `bench/vendor/`.
- `pnpm bench:svg` — chart-only benchmarks (JSON/CSV/GraphQL/CST-JSON) + regenerate `assets/bench-*.svg` for the README. Much faster than `pnpm bench`; init bars stay pinned in `bench/chart-types.ts`.
- `pnpm bench:baseline` — refresh `bench/parseman-baseline.json` **and append** a snapshot to `bench/parseman-history.jsonl` (commit both to track the needle over time).
- `test/perf/parseman-perf.test.ts` — smoke + CSS tight speedup-ratio guard (8%, robust median) + full-suite gross guard (30%, single-pass). Excluded from default `pnpm test` (heavy by design); run via `pnpm test:perf`.
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

**Parseman history** (`bench/parseman-history.jsonl`): append-only time series (one JSON line per `bench:baseline`). `pnpm bench` reports Δ vs baseline plus Δc↓prev / Δc↓origin from history. `printHistoryIndex()` lists bootstrap4 compiled µs across all snapshots.
