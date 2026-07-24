# DX package: first-set gating diagnostics + primitive discoverability

Status: DESIGN + survey. Nothing here is implemented (a throwaway Part-1 analyzer
prototype was stood up to prove the data is reachable — output in §1.7). API
names are provisional.

## The problem, stated once

Parseman is scannerless PEG: a `choice` is correct **regardless of arm order or
whether it first-char-gates**. Dispatch is *implicit in first-sets*, not declared
by a lexer (the Chevrotain contrast — Part 3). So when a hot `choice` fails to
gate — every non-matching input position speculatively ENTERS a doomed arm (ctx
save/restore + child array + recognizer + rollback) instead of being skipped by a
cheap first-char test — **nothing tells the author.** The grammar still passes
every test. The only symptom is a V8 CPU profile.

The four jess parsers were hand-optimized 25–48% by finding exactly these ungated
hot choices and the specific arm poisoning each. Every win rediscovered something
the compiler *already knows statically*:

- `choice.ts:35` computes `disjoint` for every choice at construction.
- `first-set.ts` + `codegen.ts:leadingFirstSetRecipe` already compute each arm's
  first-set, resolve refs (`firstSetOf`), and attribute the poison sources
  (leading `not`, nullable prefix, cross-artifact ref, broad recognizer).

The knowledge exists; it is never surfaced. This package surfaces it — and closes
the *discoverability* gap that made authors hand-roll workarounds for primitives
that already ship.

### A note on scope (why this collapsed from three parts to two)

While scoping this I twice proposed "add a primitive" (a `keyword()` helper, then
an `ahead()`/`gate()` commit combinator) and twice found — by reading
`src/index.ts` and `src/types.ts` — that the capability already ships. That
episode is not an aside; it **is the case for Part 3.** The grinds' hand-rolled
`regex(/@supports(?![-\w])/i)` and `not(not(literal))` idioms are the same
mistake at grammar-author scale. So:

- **Part 1 — the static gating diagnostic** is the real deliverable.
- **Part 2 — inventory of the existing gating/recognition primitives**, with a
  proof (against the first-set machinery) that no NEW combinator is warranted, and
  a mapping from each hand-rolled idiom to the tool it should have used. This is
  the raw material Part 1's fix-suggestions and Part 3's guide draw on.
- **Part 3 — the discoverability guide.**

The four causes of an `any`/over-broad arm first-set (task + confirmed in source):
1. a leading zero-width `not(...)` poisoning a sequence first-set (`not.ts:16`
   reports `firstSet: any()`) — mitigated for sequences by `isZeroWidthAssertion`
   (`first-set.ts:122`), fixed at recipe level in 0.31.1;
2. a cross-composition `g.Foo*` ref resolving to `any` across the `composeLeaf`
   artifact boundary — fixed by the pending 0.32.0 ordered-chain recipe
   (`codegen.ts:14-45`, `linker.ts:fusedBody`);
3. a leading `optional`/`many`/nullable prefix widening the union
   (`sequenceFirstSet`, `first-set.ts:135`);
4. a genuinely broad recognizer (`scanTo`, an `any`-first-set `regex`, `guard`).

---

## Part 1 — Static gating diagnostic (highest priority, lowest risk)

### 1.1 What it answers

For every `choice` reachable from a grammar entry: **does it first-char-gate?**
If not — which arm has an `any`/over-broad first-set (or which two arms overlap),
*why*, and *what existing primitive to reach for*. Output must let the author jump
straight to the poisoning arm — the thing each grind found by hand.

### 1.2 The data already exists at compile time — reuse, don't rebuild

Concrete hooks to build ON TOP of (file:line), rather than from scratch:

| Need | Existing surface |
|---|---|
| "does this choice gate?" | `def.disjoint` — `choice.ts:35`, `areDisjoint` `choice.ts:398` |
| per-arm first-set | `arm._meta.firstSet`; deep/ref-resolving `firstSetOf` `first-set.ts:157` |
| combined first-set | the `choice`'s own `_meta.firstSet` `choice.ts:38-46` |
| nullable prefix / chain stop | `matchesEmpty` `first-set.ts:61`, `canMatchEmptyAtStart` `codegen.ts:1313` |
| leading-`not` handling | `isZeroWidthAssertion` `first-set.ts:122` |
| cross-artifact ref cause | `leadingFirstSetRecipe` `codegen.ts:46`; `FirstSetSeg.ref` `codegen.ts:42` |
| fuse-time resolved first-set | `fusedBody` fixpoint `linker.ts:311-320` (`finalFS`) |
| per-rule recipe/first-set/nullable already emitted | `LinkablePieces.{firstSets,firstSetRecipes,nullable}` `codegen.ts:3931-3948` |
| chosen strategy | `def.strategy` (`firstMatch`/`greedyClassify`/`literalsLongestFirst`/`sharedPrefix`) `choice.ts:51` |
| state-gated arm concept | `GatedArm` (`types.ts:384`), `def.gates` `types.ts:51` |
| runtime dispatch-hit tracing (validation) | `createGrammarTraceSink` / `GrammarTraceEvent` / `GrammarTracePhase` (`coverage.ts`, exported `index.ts:61-62`) |
| phase timing (validation) | `run(entry, input, {profile:true})` → `RunProfile` `run.ts:87`, `index.ts:60` |
| regex first-set (broad-lead detail) | `firstSetFromRegex` `regex/first-set.ts`, wired `index.ts:13-15` |

Two crucial subtleties the analyzer must model — both already in the codebase:

- **Shallow-any vs deep-any.** A choice built over `ref()`s caches `any` in
  `_meta.firstSet` at construction (refs bake `any` until `define()`), so
  `disjoint` is `false` — yet the *monolithic* compile recovers a real guard via
  `firstSetOf` (`codegen.ts:1674-1677`) and the *compose* path recovers it at fuse
  time (`linker.ts:311`). So a choice can be `disjoint:false` and STILL gate in
  the emitted code. The report MUST compute the deep/fuse-resolved first-set and
  label such choices **"ungated at construction, RECOVERABLE by deep/fuse
  resolution"** — not a real regression. (The prototype found `simpleSelector` is
  exactly this: arms `[`, `:`, ident — deep-disjoint, shallow-ungated.)
- **`any`-arm vs overlap.** `disjoint:false` has two distinct causes needing
  different fixes: (a) one arm's first-set is `any`/over-broad (poisons the whole
  choice → §1.5 suggestions 1/3/4); (b) two arms have *finite but intersecting*
  first-sets (a shared prefix, e.g. `Dimension` vs `Num` both leading with the
  number regex → §1.5 suggestion 5 / `sharedPrefix` strategy / left-factor). The
  report lists both, separately.

### 1.3 Report shape (per choice)

```ts
type GatingReport = {
  totalChoices: number
  gated: number                    // emit O(1) first-char dispatch
  recoverable: number              // shallow-ungated, deep/fuse-resolvable
  ungated: ChoiceGating[]          // genuinely no first-char dispatch
}
type ChoiceGating = {
  rule: string                     // nearest enclosing _ruleName
  path: string                     // structural path within the rule, for jump-to
  strategy: 'firstMatch' | 'greedyClassify' | 'literalsLongestFirst' | 'sharedPrefix'
  gates: 'yes' | 'recoverable' | 'no'
  combinedFirstSet: { shallow: FirstSet; deep: FirstSet }
  anyArms: {                       // arms whose (deep) first-set is any/over-broad
    index: number
    cause: 'leading-not' | 'nullable-prefix' | 'cross-artifact-ref'
         | 'broad-recognizer' | 'opaque-wrapper' | 'ref-cycle'
    detail: string                 // e.g. "via ref g.anyValue → regex first-set any"
    shallowAnyOnly: boolean        // deep-resolvable ⇒ not a real problem
    suggestion: string             // §1.5, names an EXISTING primitive
  }[]
  overlaps: { a: number; b: number; on: FirstSet; suggestion: string }[]
}
```

`FirstSet` is already exported (`index.ts:1`), so consumers render ranges however
they like.

### 1.4 Attributing the cause — the load-bearing walk

`leadingFirstSetRecipe` (`codegen.ts:46`) *already* walks the leading-term chain,
tags refs (`FirstSetSeg.ref`), collapses inner choices, and forces nullable
through `optional`/`many`. The analyzer runs the same walk but, instead of
building a first-set, **stops at the first term that contributes `any` and records
which construct it was** (`not` / `scanTo` / `guard` / broad `regex` / unresolved
ref / nullable-prefix-to-broad-term). This is ~40 lines mirroring an existing,
tested traversal — the prototype's `whyBroad()` is exactly this and worked first
try (§1.7). Deep-resolve each arm with `firstSetOf` so a `shallow-any` that is
really finite is reported as recoverable, not as a cause.

### 1.5 Fix suggestions (the piece that makes it a checklist)

Each `anyArm`/`overlap` carries a suggestion pointing at an EXISTING primitive
(Part 2 is the inventory these draw from — no new API is proposed):

| Cause | Suggestion |
|---|---|
| broad `regex` lead (`/@supports(?![-\w])/i`, hand-copied) | "Use `word('@supports','-\\w')` or a `makeWord('-\\w')` factory (`keywords.ts`). `first-set.ts:165` (`case 'keywords': cached set is exact`) shows they gate exactly, and `emitKeywordsFast` (PERF_IDEAS 'Already landed') lowers them to the SAME `charCodeAt` boundary scan as the hand regex." |
| leading `not(...)` poison | "The arm should lead with its actual consuming terminal — first-sets gate it automatically (`sequenceFirstSet` `first-set.ts:135` unions to the first consuming term). Reorder so the terminal leads; keep `not(...)` only as a TRAILING boundary. Do NOT hand-roll `not(not(...))` to fake gating — it poisons sibling dispatch (Part 2.3)." |
| cross-artifact `g.Foo*` ref → any | "parseman ≥0.32.0 resolves the ref's real first-set at fuse time (`linker.ts:311`, ordered-chain recipe). If still `any`, the TARGET rule is itself ungated — analyze it. Ensure the target is non-nullable with a concrete lead." |
| nullable prefix widens union | "A leading `optional`/`many` lets a later, broad term start the arm. Split the empty case into its own arm, or gate the choice on the prefix's own first char." |
| finite overlap (shared prefix) | "Arms share a first char — left-factor. parseman auto-detects the `sharedPrefix` strategy for bare sequences (`choice.ts:245`) and parses the prefix once; if arms aren't bare sequences, restructure so they are. See PERF_IDEAS §7a (`Dimension`/`Num`)." |

### 1.6 Invocation + jess integration

Three surfaces, cheapest first:

1. **`analyzeGating(entry: Combinator | RuleMap): GatingReport`** — a pure
   function over the combinator tree (no compile needed). Walk from an entry (or a
   `rules()` record via `RULE_ORDER`, `parser.ts:10`) collecting `choice` nodes,
   dedup by identity, resolve refs once. This is the prototype. Zero risk — reads
   only `_def`/`_meta`. Ship this first.
2. **`compile(g, { gatingReport: true })`** — attach the report (plus the
   fuse-resolved `finalFS`, which only the compose path knows) to the
   `CompiledParser`. Here "recoverable vs genuinely-ungated" becomes exact,
   because it reads `LinkablePieces.firstSetRecipes` + runs the `fusedBody`
   fixpoint. Additive; default off ⇒ byte-identical output.
3. **A `parseman analyze <grammar>` CLI / vitest matcher** for CI. The jess build
   already compiles each parser via the macro; add a step that fails (or warns)
   when a choice on a **budget list of hot rules** newly drops from
   `gated`/`recoverable` to `ungated`. This is the regression teeth: `value`,
   `simpleSelector`, `ComplexSelector`, `Declaration`, `Ruleset` are the hot ones
   (PERF_IDEAS hotspot table, `_r_value` #1). A snapshot of `{rule → gates}`
   checked into the jess repo turns "a refactor silently ungated a hot choice"
   from a multi-day profile hunt into a red diff.

Integration with the 0.32.0 cross-artifact fix makes surface #2 strictly more
accurate: before 0.32.0 a `g.Foo`-led arm always looked `any`; after, the report
shows the fuse-resolved first char and flags only genuinely-ungated arms — fewer
false positives on composed grammars (less/scss over css).

### 1.7 Prototype result (real, on `examples/css`)

`node --import tsx scratch-gate-analyze.ts` (throwaway; ~140 lines; imports only
`firstSetOf` + `leadingFirstSetRecipe`) walked the CSS example: **10 choices, 2
gated, 8 ungated.** It localized every cause with no hand-tuning:

- **`value = choice(Dimension, Num, Color, Url, Call, Paren, Quoted, anyValue)`**
  (the #1 hotspot, PERF_IDEAS `_r_value` 6.3%): flagged `arm[7] any → via ref
  g.anyValue → broad recognizer (regex)` AND the exact `Dimension∩Num` numeric
  overlap on `+ - . 0-9` that PERF_IDEAS §7a documents as a hand-found grind.
- **`Url`**: `arm[2] any → broad recognizer (regex)` (the `urlInner` scan).
- **`Stylesheet` / `declarationList` / `pseudoArg` / `atRuleBody`**: each flagged
  its `scanTo(...)` arm as the `any` poison, plus the `@`-shared at-rule overlaps.
- **`simpleSelector`**: no deep-`any`, no deep overlap → correctly identified as
  **recoverable** (deep-disjoint on `[` `:` ident; only shallow-ungated because
  its arms are refs). A naive "disjoint==false ⇒ regression" check would have
  false-flagged this; the deep-resolution step is what makes the report
  trustworthy.

That is the whole thesis demonstrated: the compiler already knows which arm
poisons which hot choice, and ~140 throwaway lines print it.

---

## Part 2 — Existing primitives inventory (no new combinator needed)

Read `src/index.ts` (full export list) and `src/types.ts` as the source of truth.
The relevant, already-shipping surface:

**Recognition (each exposes a precise, gating first-set):**
- `literal`, `regex` (with `firstSetFromRegex` analyzer wired at `index.ts:13-15`),
  `token`, `leaf`.
- `word(str, boundary)`, `keywords(words, opts)`, `makeWord(boundary)`
  (`keywords.ts`) — the word-boundary keyword recognizers. `first-set.ts:165`:
  their cached first-set is EXACT; `emitKeywordsFast` lowers them to `charCodeAt`.
- `scanTo(term, opts)` / `balanced` — deliberately broad (first-set `any`); the
  legitimate "skip to a delimiter" tool, and a legitimate `any`-arm when it is the
  last/fallback arm.

**Gating / commit (all already present):**
- **State-gated choice arms** — `GatedArm = { gate: (state)=>boolean, combinator }`
  (`types.ts:384`), `choice({ gate, combinator }, otherArm)`. Evaluated cheaply
  before the arm is attempted; false ⇒ arm skipped (`choice.ts:99`). Among
  disjoint non-nullable arms the gate is checked *inside* the dispatched branch
  (`choice.ts:26-34`), so it composes with first-char dispatch.
- **`guard(predicate)`** (`guard.ts`) — a standalone zero-width state assertion for
  use inside `sequence`.
- **`withCtx`** — set the state the gates/guards read.
- **`not(combinator)`** (`not.ts`) — negative lookahead; the correct tool for a
  TRAILING boundary (`literal('true'), not(regex(/\w/))`).
- **`attempt`** — backtracking wrapper.
- **First-char dispatch itself is AUTOMATIC** — computed from first-sets at
  construction (`areDisjoint` `choice.ts:398`) and recovered deeply/at fuse time
  (`firstSetOf`, `fusedBody`). This is what 0.31.1 / 0.32.0 fixed.

**Instrumentation (reuse for Part 1 validation, not new work):** `GrammarTrace*`
+ coverage collectors (`index.ts:61-62`), `RunProfile`/`RunProfilePass`
(`run.ts:87`), `completionsAt`.

### 2.1 Why NO new primitive is warranted (proof against the machinery)

I proposed two and retracted both after reading the types:

- *A `keyword()` helper* — already exists as `word`/`keywords`/`makeWord`, already
  with an exact first-set (`first-set.ts:165`). The grinds' hand-copied
  `regex(/@supports(?![-\w])/i)` should have been `word('@supports','-\\w')`. Pure
  discoverability gap.
- *A positive-lookahead `ahead()`/`gate(signal, arm)` commit combinator* that
  contributes its signal's first-set to the enclosing choice — **genuinely not
  needed.** The capability it would add already exists structurally: an arm that
  leads with a concrete terminal (even one nested behind a `ref`) already has that
  terminal's first char unioned into the choice's dispatch, because
  `sequenceFirstSet`/`leadingFirstSetRecipe` (`first-set.ts:135`, `codegen.ts:46`)
  union through the nullable prefix to the first CONSUMING term, and `fusedBody`
  resolves refs at fuse time (`linker.ts:311`). So "commit this arm on lookahead
  X" is expressed by simply *letting the arm consume X* (or leading it with the
  rule that does) — first-char dispatch is then automatic. There is nothing a
  positive zero-width lookahead adds for DISPATCH that consuming the same terminal
  does not already give, and the first-set intersection math for a hypothetical
  positive lookahead is even pre-written as a comment (`first-set.ts:113-120`)
  precisely to note it would only ever TIGHTEN, never enable, dispatch.

### 2.2 The `not(not(...))` miscompile — retire the idiom via better first-sets + diagnostic

The scss grind hand-rolled `not(not(literal))` to fake first-char commitment among
sibling arms sharing a first char; it MISCOMPILED (silently dropped an
at-rule-nested-in-at-rule-block). Root cause is exactly the poison in this design:
`not(...)` reports `firstSet: any()` (`not.ts:16`), so the double negation gives
the arm an `any` first-set, defeating `areDisjoint`, forcing ordered `firstMatch`,
and interacting with `autoNot`/rollback to drop a valid arm. The fix is NOT a new
primitive — it is (1) don't fake gating: let the arm lead with its real terminal
so first-sets dispatch it, and (2) **Part 1 flags precisely this** (`leading-not`
cause + "reorder" suggestion), so the idiom is caught before it ships. Add a
regression test reproducing the scss drop.

---

## Part 3 — Discoverability guide (outline)

A concise `docs/gating.md`. The framing driver: *this very design process* — a
coordinator and an agent repeatedly "discovering" primitives that already ship —
is the evidence that the primitives exist but aren't findable. The grinds'
hand-rolled workarounds are the same failure at author scale.

Sections:

1. **The mental model.** Every hot `choice` should first-char-gate. Dispatch is
   *implicit in first-sets* — there is no lexer to force it. A gated choice is
   O(1); an ungated one speculatively enters doomed arms at every position.
   Correctness never tells you which you have — the diagnostic does.
2. **What poisons a first-set** (the four causes): leading `not`, nullable prefix,
   cross-artifact ref, broad recognizer. Each with a 3-line before/after.
3. **How to read the Part-1 diagnostic.** `gated`/`recoverable`/`ungated`;
   `anyArm` cause + suggestion; `overlap` = shared prefix. Worked on the real
   `value` output (§1.7).
4. **Which EXISTING primitive to reach for** (Part 2 inventory): over-broad
   `regex` lead → `word`/`keywords`/`makeWord`; need a boundary → trailing `not`;
   state-conditional arm → `GatedArm` gate / `guard` + `withCtx`; skip-to-delimiter
   → `scanTo`; shared prefix → let `sharedPrefix` auto-factor or restructure. And
   the anti-patterns to STOP doing: hand-copying `regex(/…(?!…)/)`, `not(not(...))`.
5. **Chevrotain vs scannerless framing.** Chevrotain forces explicit token-type
   dispatch via a lexer — the cliff is impossible to hit, but the grammar is less
   flexible (no scannerless overlap, no per-position re-lexing). Parseman's
   dispatch is implicit in first-sets: more flexible, but hides the cliff. Part 1
   buys back Chevrotain's "you can't forget to dispatch" guarantee without the
   lexer.
6. **Worked examples = the real wins.** `value`'s `anyValue`/`Dimension`-`Num`
   split (PERF_IDEAS §7a); `@supports` hand-regex → `word()`; the scss at-rule
   `not(not())` miscompile → reorder + diagnostic; the 25–48% jess grind framed as
   "what Part 1 would have printed on day 1."

---

## Delivery order, quick-wins vs deeper changes, risks

**Order (Part 1 first — highest leverage, lowest risk):**

1. **`analyzeGating()` pure function** (§1.6 surface 1). Quick win — the prototype
   already works; productionizing is ~1 day: formalize the report type, the cause
   walk (mirror `leadingFirstSetRecipe`), and the deep/recoverable distinction.
   Read-only; cannot change any parse.
2. **`compile(g, { gatingReport: true })`** + fuse-resolved accuracy (§1.6 surface
   2). Deeper — reuses `LinkablePieces.firstSetRecipes` + the `fusedBody` fixpoint
   (`linker.ts:311`); default-off so output stays byte-identical.
3. **CI budget snapshot in the jess build** (§1.6 surface 3). Quick win once 1–2
   land. The regression teeth.
4. **Guide** (Part 3) — write alongside, cite the real reports. No code.
5. **Regression test** reproducing the scss `not(not())` drop (Part 2.2), pinned
   so the diagnostic's `leading-not` flag stays honest.

No new combinator ships. If a future need genuinely can't be met by
`word`/`keywords`/`GatedArm`/`guard`/`not`/first-sets, THEN propose one — with an
explicit proof against this machinery, the way Part 2.1 disproves the two I tried.

**Risks:**
- *False positives* on shallow-`any` ref choices — mitigated by the mandatory
  deep/fuse-resolution step (§1.2); do not ship a report that flags
  `simpleSelector`. The 0.32.0 cross-artifact resolution makes this strictly more
  accurate for composed grammars.
- *Budget-list staleness* — the CI snapshot must track the hot-rule set; tie it to
  the PERF_IDEAS hotspot table and re-derive from `run({profile:true})` phase
  splits, not a hand-list that rots.
- *Guide rot* — the guide must name the CURRENT primitives; a stale guide that
  omits `makeWord`/`GatedArm` recreates the exact discoverability gap it exists to
  fix. Regenerate its primitive list from `index.ts` exports.
- *Perf neutrality* — Part 1 is compile/analysis-time only (zero runtime cost);
  nothing here touches the hot path.

## Appendix — prototype

The throwaway analyzer lived at repo-root `scratch-gate-analyze.ts` (deleted after
capturing §1.7). Core: import `firstSetOf` (`first-set.ts`) +
`leadingFirstSetRecipe` (`codegen.ts`); walk from `Stylesheet` collecting `choice`
nodes; per choice report `def.disjoint`, `def.strategy`, shallow vs deep combined
first-set, deep-`any` arms with a `whyBroad()` cause walk, and deep finite-overlap
pairs. It reproduced the hand-found `value` grind (anyValue + Dimension/Num) with
no tuning — proof the data is reachable and the report is buildable today.
