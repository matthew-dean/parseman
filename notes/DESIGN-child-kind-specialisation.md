# DESIGN — child-kind specialisation, or: how the table gets codegen's shape back

**Base.** `design/child-kind` cut from `origin/release/0.47.0` @ `382c4424a4dca58a6066476f53f5de8ff4736401`.
Reference tree for the deleted engine: `archive/codegen-fastpaths` (tag object `ad3c06f`, commit `3d4dac6`).
Design only. No `src/` change. No benchmark was run for this document; every number
below labelled PREDICTED is a prediction to be measured against, not a measurement.

## REVISION — this document has been through three adversarial reviews

**This is the single source of truth.** The reviews are folded in; do not plan off
them separately, and do not plan off the pre-review revision (`eb516a4` / `5bef2fc`).

| review | branch | what it changed here |
|---|---|---|
| SHAPE COVERAGE | `review/coverage:notes/REVIEW-child-kind-coverage.md` | §2.3's cutoff rule (restated), §2.4 (new inherited-attribute axis), §2.5 (new choice-strategy axis), §4's reading of `scannable-run.ts`, U3's position in §6 |
| LAW COMPLIANCE | `review/law:notes/REVIEW-child-kind-law.md` | §0.3 (narrowed and now VERIFIED), §0.6 (per-term cost), §2.1 (`triviaCapture` was **unsound**), all of §5, §8 |
| PREDICTION DEFENSIBILITY | `review/predictions:notes/REVIEW-child-kind-predictions.md` | every number in §6, the unit boundaries of U1/U3, §6.2 (new residual-ordering rule), U4's size range |

**What survived and what did not.** The MECHANISM reasoning largely survived: §0.3's
FunctionLiteral argument was independently verified under `--trace-turbo-inlining`
and is now the plan's strongest claim, and the §0.6 split model (json floor ≠ css/less
term) survived intact. **The STAGING did not.** Three of the original five predictions
were aimed at code that cannot produce them — most consequentially U3, which was
scoped against css/less and measures **zero** there. Every re-aimed unit carries its
revision inline, with the reviewer's number, marked **REVISED**.

**Where two reviews disagree, both numbers are printed and the disagreement is named.**
§6.4 collects them. Nothing was silently picked.

**Work already in flight — do not re-design it.** `lane/triviacost`, cut from
`release/0.47.0`, is implementing (a) the capturing trivia lowering — the recognisers
`prefixRunSource` and `delimitedSource` plus `delimitedBodySound`, ported from
`scannable-run.ts` into `src/combinators/trivia-skip.ts` — and (b) the corpus-gate
engine fix (§8, `bench/table-lowering-identity.ts:19`). Those are **G1** and **U3a**
in §6 and they are marked IN FLIGHT. The remaining units are written to be consistent
with the lane landing. **The lane owns the box: run no benchmark against this
document.**

### The plan, in three sentences

The table engine lost 137% on json and 500–835% on css/less against the deleted
source-emitting engine, and the cause is that **every option — trivia, capture, probe,
tolerance, host — is still consulted on the parse path**, while every child call goes
through a handful of shared closures that V8 therefore treats as megamorphic and never
inlines. **The fix is to resolve all of it once, at run start** — options into
`RunCfg`, per-region facts into labels the encoder stamps on each site, and each child
into a named binding — and then to **emit source**, because a distinct call site
requires a distinct FunctionLiteral and no rearrangement of `assemble.ts` can produce
one. Emitting source (U4) is the only step that fully satisfies that; everything before
it is cheap, independently valuable amortisation that shrinks the emitter's surface,
and one unit of it — the css/less capturing-trivia lowering — is already in flight.

**Unless every path/line reference below is checked against the tree, treat this
document's numbers as bounded predictions, not results.** Nothing here was timed.

---

## THE PURPOSE — and it is a pass/fail criterion, not a goal

> **The purpose of this linking is to resolve logic paths at runtime ONLY ONCE, and
> NOT per combinator / rule at parse time.**
>
> — the owner, verbatim in substance

**Stated as the test this document is held to:**

> ## Any consulting of options at parse time, per rule or per combinator, is a FAIL.

Not a cost. Not a smell. Not "acceptable where cheap." **A fail.** That framing is the
point, because every violation now in the tree survived by being individually
defensible as cheap: `nextTerm`'s `if (ctx.trivia === undefined)` is one predictable
branch; `OP_LIT`'s `ctx._probe !== undefined` is one property load;
`AssemblyCache.forCtx(ctx)` is a cached lookup. Each is negligible alone. Together
they are the architecture. **A criterion that admits "cheap enough" readmits all of
them**, which is exactly how they got in.

### What "once" is scoped to

**ONCE PER RUN. Not once per parse, and not once per rule entry.** A second parse with
the same options must re-resolve nothing.

The current code gets this subtly wrong in a way that reads as fine.
`AssemblyCache.forCtx(ctx)` (`assemble.ts:2409-2420`) is called from `runRule` on
**every rule entry** (`:2443`) and does, each time: five `ctx` property reads, a call
to `cstOutputHost(host)`, four ternaries, a bitwise fold, an array index. Its own
doc comment (`:2404`) calls it *"THE ONLY CONFIG READ ON THE RUN PATH"* and defends it
as cheap and allocation-free — which is true, and which is the wrong defence.
**Cheap-because-cached is not resolved-once.** The decision still lives on the parse
path; it has merely been made inexpensive. The design does not settle for that.

### What "not per combinator / per rule" forbids, with the canonical violations

| the rule | the violation in the tree |
|---|---|
| no option consulted per **term** | `nextTerm`'s `if (ctx.trivia === undefined)` — `assemble.ts:526`, on every non-first term of every sequence |
| no option consulted per **leaf** | `OP_LIT`'s `if (ctx._probe !== undefined)` — `assemble.ts:665`, on every literal failure; and the same test at 5 further sites |
| no option consulted per **rule entry** | `cache.forCtx(ctx)` — `assemble.ts:2443` |
| no option consulted per **scope entry** | `skipTrivia`'s three-clause capture test — `assemble.ts:460-462`, on every term |

### Elimination, not amortisation

A resolved path contains **no residue of the decision**: no flag read, no cached
lookup, no branch that always goes the same way, no memo hit. The operational test:

> **If a reader can ask "how expensive is that check?", the check should not be there
> at all.**

Caching, hoisting to a per-parse latch, and folding four branches into one are all
*amortisation*. They are legitimate intermediate steps and this document proposes
several — but a unit that only amortises has **not** satisfied the criterion, and
§6.1 marks each unit accordingly rather than letting "faster" read as "done."

### How this document is held to it

1. **No unit is described as done while its parse path still consults an option.**
   §6.1 is the compliance table and it reports partial results honestly.
2. **§5 and U0 make it mechanically enforceable.** The checker's job is exactly this
   criterion — *no option-derived value read on a parse path* — and the reason the
   existing `INV-6` cannot express it is spelled out in §5.
3. **Exceptions are declared or they are defects.** §5.4 is the exception list. It has
   one entry. A criterion with no declared exceptions and three undeclared ones is
   worse than one with a documented exception list.

---

## 0. Corrections to the brief, before anything is built on it

I was asked to correct the framing where the tree disagrees with it. Six places do.
Three of them change the design.

### 0.1 — `expected` IS in the identity digest. `notes/RELEASE-0.48-TARGET.md`'s closing section is stale.

`bench/table-lowering-identity.ts:57-62`:

```ts
return digestValue({
  ok: r.ok,
  value: r.value,
  unconsumedFrom: r.unconsumedFrom,
  expected: r.ok ? undefined : [...(r.expected ?? [])].sort(),
})
```

Added by `71bf4bc` ("digest failure"). The brief is right and
`RELEASE-0.48-TARGET.md:437-444` is wrong — it was not updated after that commit.
Two other sites carry the same stale claim and should be corrected when this lands:
`test/parity/table-lowering-gaps.test.ts:4-5`, and (as past-tense narration, so
harmless) `src/table/encode.ts:1199`.

What the digest still does *not* cover: failure **position**, `errors`, `rootTrivia`,
`committed`, and `expected` **order** (it sorts). §8 names what fills those gaps.

### 0.2 — §8's "the real gap is 4–9%" is not a measurement of this gap at all. Delete it.

`notes/RELEASE-0.48-TARGET.md:287-304` reports `bench/jess/fixture.ts` measuring
css 1.09× / less 1.05× "table at HEAD against the `ref|` leg (the shipped engine at
the pinned reference commit)". There is no pinned reference commit in that file.
`bench/jess/fixture.ts:263` reads `ref|` out of the contest labelled
`'compiled -> table'` (:254), whose `compiled` leg is `import('pm-macro:...')`
(:195-197) — the macro lowering **as it exists in the working tree**. And in this
tree `src/plugin/index.ts:28` imports `compileTable` and nothing else;
`src/compiler/codegen.ts` does not exist.

**So `bench/jess/fixture.ts` measures table-emitted-module against
table-assembled-in-process.** Both legs are the table. Its 4–9% is a plumbing delta,
not a codegen delta. §9's third candidate explanation
(`RELEASE-0.48-TARGET.md:412-414`) is the correct one, and the "UNRECONCILED"
standoff is resolved in favour of the CI numbers.

`bench/workload-perf-guard.ts` is sound by contrast: `bench/ab-harness.ts:214-256`
`materialise()` does `git worktree add --detach` at `a5dc9bd` and builds that
checkout's own `src/`, with `bench/workloads` and `examples` copied over **both**
sides so only `src/` differs. That leg genuinely is the pre-deletion engine.

**Consequence for this design:** the +137% / +500-835% figures stand as the target,
and there is no counter-evidence suggesting the gap is small. Nobody should size
this work off the 4–9%.

### 0.3 — Term 0 of an unrolled sequence is NOT monomorphic either. This is the load-bearing correction.

The brief (and `assemble.ts:1252-1256`) rests on: `nextTerm` is megamorphic because
the piece arrives as an argument, whereas `k0(input, pos, ctx)` at `assemble.ts:1494`
is a bound closure variable and therefore monomorphic and inlinable.

That reasoning holds for *source* text. It does not hold for closures, because V8
attaches inline-cache feedback to the **FunctionLiteral**, not to the closure instance.
Each `CreateClosure` bytecode owns one `FeedbackCell` in the enclosing function's
feedback vector. The cell transitions `kNoClosures → kOneClosure → kManyClosures`;
once a second closure is created from that same literal, the cell is shared and every
closure minted there **shares one feedback vector**, hence one set of ICs.

Trace it here. `assemble()` (`assemble.ts:268`) is a top-level function, created once,
so its vector is shared across every `assemble()` call in the process. `link`
(`:632`) is created from one `CreateClosure` site inside it — shared cell. The
arity-2 piece at `:1493` is created from one `CreateClosure` site inside `lower`.
Therefore **every 2-ary sequence piece in every grammar in the process shares one
feedback vector**, and the `k0(input, pos, ctx)` site inside it sees `OP_LIT` pieces,
`OP_CHOICE` pieces, `OP_RULE` pieces, `OP_NODE` pieces — all of them.

`k0(...)` is megamorphic for exactly the same reason `nextTerm`'s `child(...)` is.
Binding to a named `const` moved the array read earlier; it did not create a call site.

This is why the owner says *"we should still be codegenning"* and *"they're static
bindings."* **A distinct call site requires a distinct FunctionLiteral, and the only
way to get one per grammar site is to emit source.**

### VERIFIED — and the absolute phrasing is narrowed

**REVISED (law review §5).** The mechanism claim and its consequence were both
executed under `node --trace-turbo-inlining`, `node v24.11.1`, as inlining-decision
observations, not timings.

- **Test A — is the FeedbackVector shared?** One `CreateClosure` site minting four
  closures, each binding a different callee. TurboFan reported the **same feedback
  vector object at all four call sites** (`0xc590631e8 {<FeedbackVector[2]>}`).
  `kManyClosures` sharing **confirmed**.
- **Test C vs D — does the sharing block inlining?** Identical programs, 24 pieces,
  6 distinct callee shapes, reached through a varying array index. **C**
  (`assemble.ts`'s shape, one FunctionLiteral): the `k0(input, pos)` site was
  **never inlined** — no callee was ever considered. **D** (U4's shape, 24 distinct
  FunctionLiterals each naming one binding): **20+ `Inlining <callee> into <q0N>`
  lines** — every emitted piece got its callee inlined, each with its own vector.

**The narrowing, which strengthens the claim rather than weakening it.** In Test A,
where the closure was a *constant* (module-level array, 4 entries, TurboFan-visible),
V8 recovered the callee anyway by context specialisation — it inlined the piece with
a known `Context` and constant-folded the `k0` slot. So *"no rearrangement of
`assemble.ts` can produce a monomorphic call site"* is true of the IC and **slightly
too strong of the outcome**. The precise statement, which is the one to quote:

> The shared FeedbackVector makes the IC at `k0(…)` megamorphic. The callee is
> recovered **only when TurboFan inlines the piece with a concrete,
> statically-known closure** — which requires **≤4 targets at the calling site and a
> constant-foldable reference**. At 2,241 reachable sites reached through `kids[i]`,
> `arms[i]`, and a `child` *parameter*, neither condition holds anywhere in a real
> grammar.

Stated this way it survives the strongest available attack and it stops a future
reader from "falsifying" it with a four-piece toy.

**Two corollaries, both of which strengthen U4:**

1. **The megamorphism does not need multiple grammars in the process.** Within a
   *single* `lower` closure the arity-2 `CreateClosure` site fires once per 2-ary
   sequence in that one grammar. **The second 2-ary sequence is enough.** A
   single-grammar, single-cfg process is already `kManyClosures`.
2. **U4's per-piece win is *inlining*, not merely a cheaper call.** Test D's callees
   were inlined into their pieces. That is the mechanism behind the "48 ns/piece
   against codegen's ~28 ns, ~20 ns of *work*, nobody has located it" figure — see
   §6.3 on that number's (absent) provenance.

**Does U4's call side reintroduce megamorphism at scale?** No. A grammar with 200
rule references emits **200 distinct call sites, each naming one binding** — 200
monomorphic sites, not one 200-way megamorphic site. The trade is honest: feedback-vector
*size* grows linearly with grammar size (one IC slot per emitted site) — that is
memory, priority 2. And **a rule-reference callee is a large function and will not be
inlined**; the win there is the monomorphic call only. The inlining win is for the
**scannable leaves**, which is exactly where §2.3 puts the paste side of the
paste-vs-call dichotomy. **The dichotomy is correctly placed** — §2.3 now says so
rather than leaving a reader to infer that all 200 sites get inlined.

Any staged unit whose payoff is claimed to be "now this call is monomorphic" while
still living inside `assemble.ts` is claiming something the runtime cannot deliver.
§9.1 is retained as the record of what was checked and how.

### 0.4 — The hottest piece in the engine carries two runtime option tests. `OP_LIT`.

`assemble.ts:657-668`, the whole of it:

```ts
case OP_LIT: {
  const s = k[code[ip + 1]!] as string
  const len = s.length
  const xf = fx[code[ip + 2]!] as string[]
  return (input, pos, ctx) => {
    if (input.startsWith(s, pos)) {
      const e = pos + len
      if (cstCaptureActive(ctx)) pushLeaf(ctx, s, pos, e)
      END = e
      return s
    }
    ctx._fe = pos; ctx._fx = xf
      if (ctx._probe !== undefined) failAt(ctx, xf, pos)
    return FAIL
  }
}
```

Three separate defects against the target, in the piece that runs most:

1. **`input.startsWith(s, pos)` for every literal length.** Codegen never emitted
   this for a literal under 17 characters. `emitLit` (`codegen.ts:1379-1428`) had
   four forms keyed on length, `CHARCODE_CHAIN_MAX = 16` (`:1377`): length 1 was a
   bare `input.charCodeAt(pos) !== 123`; lengths 2–16 were an unrolled OR-chain of
   `charCodeAt` compares behind one bounds check; only `> 16` reached `startsWith`.
   Every literal in `examples/json/parser.ts` is 1–5 chars — `{`, `}`, `[`, `]`,
   `,`, `:`, `"`, `null`, `true`, `false`. **The json workload takes the
   `startsWith` builtin call on every literal where codegen took one inline
   integer compare.** The brief's claim that codegen emitted
   `input.startsWith('@media', pos)` is wrong in the direction that matters: it
   emitted six `charCodeAt` compares.
2. **`ctx._probe !== undefined` is an option test — but on the FAILURE path, and
   the census missed the one site that is not.** **REVISED (predictions review
   finding 3, law review O4).** All six leaf sites (`assemble.ts:669, 687, 706,
   726, 749, 763`) sit **after** the success `return`. The original claim here —
   "a load and a branch on every leaf of every parse" — and U1's "one of very few
   instructions in the success path" were both **false**. json reaches that line
   **1,052 times against 19,966 literal executions (5.3%)**, with `ungatedFails=0`.
   The `_probe` bit is therefore worth ≈ **0.05%**, not the 5% originally
   apportioned.

   **The site that does matter, and that the census missed: `OP_GATE`,
   `assemble.ts:803`.** It reads `ctx._probe === undefined && !ctx._tolerant &&
   !classHas(…)` on the **success** path of every first-set-gated child. `_tolerant`
   is **already a `RunCfg` field**, so this is a live `INV-6` violation on a hot
   path *today*. Per repo memory first-set gating is the parse lever (25–48%
   landed), so this is the `_probe` site that ranks. css has 13 `GATE` rows, less
   22; **json has none**, which is why a json-first reading missed it entirely.

   The fix at this site is a selection, not a bit test: at `link`,
   `if (cfg.tolerant || cfg.probe) return child` — the gate is already a no-op
   under both, so the tolerant/probe assemblies drop the closure **and its call
   frame**, and the strict assembly gets a body that is one `classHas`.

   Codegen resolved all of this at build time: `probeUpdate`
   (`codegen.ts:694-699`) emits **the empty string** when recovery is off. The
   `_probe` → `RunCfg` move is still right — it is nearly free and it is what makes
   `OP_GATE:803` fixable — it is simply not worth the points originally claimed.
3. **`END = e` is a store into a closure Context cell**, not a local. `END`
   (`assemble.ts:322`) is a `let` in `assemble()`'s scope captured by all ~29 piece
   kinds. Codegen's inlined leaves wrote SSA locals (`const ev = pos + len`,
   `codegen.ts:1424`) and only touched the module slot `_pfEnd` when actually
   crossing a real function boundary (`:793-798`). The table pays a heap-cell
   store at every leaf; codegen paid it at function boundaries only.

`cstCaptureActive(ctx)` is legitimately runtime (per-`node()` state, correctly
excluded from `RunCfg` at `:212-214`) — but see §3.4, it can still be selected
against once `hostCst` is false.

**Counts across `assemble.ts` — REVISED, and the two reviews that counted disagree.**
The original line read "6 `_probe`, 9 `cstCaptureActive`, 7 `ctx.captureTrivia`,
1 `ctx.trivia === undefined`, 9 `ctx._tolerant`". Three of five were wrong.

| symbol | as written | predictions review | law review |
|---|---|---|---|
| `ctx._probe` | 6 | **7** (6 leaf-failure + `OP_GATE:803`) | **9** (`inv6x.mjs`) |
| `ctx._tolerant` | 9 | **4** in code (9 counted prose in doc comments) | — |
| `cstCaptureActive` | 9 | not re-counted | not re-counted |
| `ctx.captureTrivia` | 7 | not re-counted | not re-counted |
| `ctx.trivia === undefined` | 1 | 1 (`:526`) | **3** reads (`:526`, `:1922`/`:2009` `OP_REP`, `:2231` `OP_NODE`) |

**Named disagreement, not resolved here.** Predictions counts **7** `_probe`
member expressions in `assemble.ts`; law counts **9** via its `inv6x.mjs`
re-implementation with a widened `isPiece`. The two runs used different `isPiece`
predicates and law's also widened module scope, so the numbers are not measuring the
same set. **U0 settles it by producing the number, and U0's acceptance criterion is
"the checker emits a count and the count is written down" — not "the count matches a
prediction."**

### 0.5 — `INV-6` exists and would catch most of this. It has THREE holes, and the biggest one is FILE SCOPE.

`scripts/check-invariants.mjs:548-613`. The rule is exactly the standing law
("no assembled PIECE body may read a per-parse CONFIG field") and its rationale
is stated correctly. **REVISED — the original text named two holes and missed the
largest.**

- **HOLE 1 — FILE SCOPE. The biggest, and it was not in the original draft.**
  `ASSEMBLER = 'src/table/assemble.ts'` (`check-invariants.mjs:587`) is the *only*
  file scanned. So **10 reads of `ctx.trackLines` — a field that is ALREADY in
  `CONFIG_FIELDS` — sit on the hot parse path with the gate green**:
  `src/combinators/trivia-skip.ts:88, 192, 196, 199, 226, 240, 254, 257` and
  `src/recovery/scan.ts:117, 118`. The gate's own field list already forbids these.
  Law review measured **57 config reads inside piece-internal bodies** across the
  parse-path module set while `node scripts/check-invariants.mjs` reports
  `105 modules examined, 0 findings`. **No new rule semantics are needed to catch
  36 of those 57 — only scope.** This is the highest speed-per-line-of-checker
  change available.
- **HOLE 2 — `isPiece` excludes `FunctionDeclaration`, and the arity is NOT the
  cause.** **REVISED (predictions review §2 U0, law review §4).** The original text
  blamed the 3-parameter constraint. That is wrong: `nextTerm(child, input, cur,
  ctx)` is invisible because `isPiece` rejects `FunctionDeclaration` nodes outright,
  and `nextTerm` is one. `names[1]` is already unconstrained, so the originally
  proposed `pos|cur` broadening is a **no-op**. The checker additionally requires
  `names[0] === 'input' | '_input'`.

  And the originally proposed replacement — "any function whose parameter list
  *ends* in `(input, pos|cur, ctx)`" — **has a hole shaped like the other half of
  the same defect**: it does not match `runTerms(input, pos, ctx, values)`,
  `runSyncTerms`, or `runAdjTerms`, where `ctx` is not last. Those three are exactly
  the loop bodies holding `kids[i](…)` and `runners[i](…)`. §5.1 now adopts the law
  review's arity- and order-free form instead.
- **HOLE 3 — the field list is two entries long.** `CONFIG_FIELDS = new Set(['trackLines',
  'build'])`. `_probe` and `_tolerant` are per-parse-fixed and absent. That is why
  §0.4's `_probe` tests survive in the hottest piece with the checker green.
  **`trivia` is NOT in this class** and must not be added — see §5.2/§5.3.

The same shape defect that hides `nextTerm`'s call from TurboFan hides its branch
from the invariant checker. That is not a coincidence — both are asking "is this one
specialised body?" and both get "no".

### 0.6 — The css/less 6–9× second term is locatable statically, and it is not the same defect as the json floor.

The brief asked me to say in advance which unit addresses which term. The evidence:

**Two citation defects, corrected in place.** The original draft wrote
`src/table/trivia-skip.ts` throughout; **that file does not exist** — it is
`src/combinators/trivia-skip.ts`, and the line numbers were right. And it analysed
`examples/css/parser.ts` for all three css/less rows: `css/stylesheet` does use it
(`bench/workloads/index.ts:43`), but **`less/stylesheet` and `less/mixins` use
`bench/workloads/less.ts`** — a file the original never opened, and the two worst
rows in the set (+765…+844%). Its trivia is
`trivia(oneOrMore(choice(ws, lineComment, blockComment)))`
(`bench/workloads/less.ts:60-63`) — **one extra arm**. The diagnosis transfers (less
was executed and also returns null), but a patch validated only against
`examples/css/parser.ts` misses the `//` arm.

`skipTrivia` (`assemble.ts:458-471`) takes the fast scanner **only** when
`ctx._triviaLog === undefined` and no CST trivia capture is live. The
`less/stylesheet`, `less/mixins` and `css/stylesheet` workloads are all built
`withCapture` (`bench/workloads/index.ts:104-106, 113-133`) — `_triviaLog: []` is set.
`graphql/document` and `json/document` are `withoutCapture`.

### The two conditions are INDEPENDENT, and that is what re-aims U3

**REVISED — this is the correction that moves the most budget in the document.**
The original draft treated `SCAN === null` as *the* css/less defect. It is one of
two, and it is the one that does not bind.

1. **`fastTriviaScanner` is null for css AND for less.** Confirmed three ways:
   statically (coverage review §4.5 — `altStarSource` requires the whole source to
   match `^\(\?:(.*)\)[*+]$` and `splitTopLevelAlts` returns null on a nested `(`,
   which `/\/\*(?:[^*]|\*(?!\/))*\*\//` has), and by **execution** in both the law
   and predictions reviews. json and graphql are non-null. §9.3 is **RESOLVED**.
2. **`skipTrivia:461` ALSO requires `ctx._triviaLog === undefined`**, and
   `scanTrivia:228`'s own fast guard requires `log === undefined`. The css/less
   workloads set `_triviaLog: []`. **So a restored recogniser is unreachable on
   those rows no matter what.**

**Consequence: "block comments lost their recogniser" is the wrong statement of the
defect.** The correct one is: **the capture-on trivia path has no lowered form at
all.** A recogniser alone measures zero on css/less; a capture tail alone has no loop
to live in. **Both halves are one unit** — that is U3a in §6, and it is what
`lane/triviacost` is building.

### The per-term cost is bigger than "two allocations" by roughly an order of magnitude

**REVISED (law review O1, predictions review §1).** On css/less every non-first
sequence term runs `nextTerm` → `skipTrivia` → `needsDeferredTriviaCommit(ctx)` true
→ `scanTrivia(input, cur, ctx)` → `.commit()` → discard. What `scanTrivia`
(`src/combinators/trivia-skip.ts:219-293`) actually does per term:

- 8 config reads (`trivia`, `_triviaLog`, `_rootTriviaLog`, `captureTrivia`,
  `_cstBuf`, `_cstTriviaLog`, `trackLines`×2, `triviaKindLabels`×4) plus a `WeakMap`
  lookup;
- **`createDetachedParseContext` (`parse-context.ts:86`) — a whole fresh
  `ParseContext`, ~30 slots**;
- **a full `triviaP.parse` re-entry into the combinator interpreter**, i.e. the
  entire `oneOrMore(choice(ws, comment))` graph, at `trivia-skip.ts:239`;
- a `ParseResult` + span, the `{ end, commit }` object, and a `commit` closure.

**≥5 allocations plus a detached context plus an interpreter re-entry, per sequence
term, on a 64 KB input.** The original "two allocations per sequence term" understated
it by roughly an order of magnitude, and the understatement matters because it made
the cost look like a young-generation-pressure story. It is not. **The dominant cost
is a full interpreted combinator parse per term**, which is a categorically larger
thing than allocation and does not depend on any escape-analysis argument — see §9.2,
which is now *stronger* than the argument it replaces.

**Neither U2 nor U3a alone removes the interpreter re-entry.** It dies only when a
real scanner exists **and** the capture tail lives inside the loop. Stated explicitly
so that a reader who lands U2, sees css move less than predicted, and concludes the
model failed, is instead reading the plan correctly.

`scannable-run.ts` handled the shape: `delimited` is one of its nine `ScanShape`
variants, with a soundness proof (`delimitedBodySound`, `:967`) and an emitted form
(`emitShapeMatch` `delimited`, `:1557`). `src/combinators/trivia-skip.ts` is what
survived the cutover, and it is a small fraction of that coverage.

**The split model, RESTATED — it survived review; only the unit boundaries moved:**
- The **json/document +137% floor** is the per-leaf and per-term *shape* cost:
  `startsWith` for short literals, the `END` cell, megamorphic dispatch, the mark
  protocol's config loads, and — newly, and larger than the design credited —
  **6,005 `OP_RX` executions per parse, 12.9% of all rows**, each entering the regex
  engine and allocating a match array.
- The **css/less extra 6–9×** is the trivia path: capture forcing a detached-context
  interpreter re-entry per term, with no lowered scan loop to fall into.
- **css/less ALSO pay the json floor.** They execute the same `OP_LIT`/`OP_RX`
  bodies and the same megamorphic dispatch. The original draft's css/less budget
  omitted this and consequently did not close — see §6.2.
- These remain **different defects**. A unit that fixes one will not move the other.

**The precedent that cuts against the trivia predictions, now engaged rather than
left unaddressed.** `RELEASE-0.48-TARGET.md:72-78` records the labelled-trivia char
scanner predicted at 1.2–1.6 ms and delivered **−0.8 ms**, with the lesson *"the
trivia scanner profiled at ~7.3% of parse self-time and was worth ~3.4%. Bound before
building, and expect the profile to overstate."* That is the closest measured bound in
the repo to trivia-path work, and it does not refute U3a — the css/less path is a
**combinator re-entry**, categorically larger than a scanner tuning — but the
distinction is the reason the prediction stands, and it is now stated rather than
assumed.

---

## 1. What the target shape is

Three artefacts, kept strictly separate. The design's whole discipline is that
nothing leaks between them.

> **PSEUDO-CODE — ILLUSTRATIVE, NOT LITERAL.** The block below sketches the owner's
> statement of the shape. It is not the emitted form, not an API, and not a naming
> proposal. `link`, `make`, `_s0` and `opts` are stand-ins for *roles* — resolve a
> binding, compose the bindings, a bound child, the resolved option set — and the
> real spellings, signatures and emission strategy are what §2–§5 work out. Do not
> implement this block; implement the units.
>
> What IS load-bearing here, and survives whatever the spelling turns out to be:
> each child is a **named binding, not an array slot**; the option branch happens
> **once, at resolve time**, never on the parse path; and each call site names
> **one** binding in emitted source so it is a distinct FunctionLiteral (§0.3).
>
> **§1.1 replaces these two spellings with the names the repo already uses.**
> `link` and `make` are retired from the rest of this document except where they
> refer to real in-tree identifiers.

```
_s0 = link('s0', opts)      // resolve this binding to a static piece — ONCE, at run start
_s1 = link('s1', opts)
_s2 = link('s2', opts)
_s3 = link('s3', opts)
_r1 = make(_s0, _s1, _s2, _s3)
_r1.parse(input)
```

**1. The piece library.** Fixed, generated, static functions. Emitted once, shared by
every grammar in the bundle. Its cost is source size and maintenance, not per-grammar
bytes. This is the superset §2 enumerates.

**2. Binding resolution.** Runs once at startup. **Every** option branch is paid here
and nowhere else: trivia present or absent, CST or AST, line tracking, tolerance,
probe. It returns the piece; the piece does not know the option exists.

**3. Rule composition.** Composes resolved bindings into the rule's parse function.

After composition, the parse path holds no option test, no array index, no lookup —
and, per §0.3, each call site names one binding **in emitted source**, so it is a
distinct FunctionLiteral with its own feedback vector.

**Where the per-grammar artifact ends up.** It stops being pure data and becomes
generated wiring: a static binding per node plus a rule function naming its children.
A line or two per node, **not** an inlined body per node. That is the middle ground
— codegen's shape without codegen's bulk. §6 puts a predicted byte figure on each
stage against `bench/size-baseline.json` (`example/json` 1,336 B; `example/css`
9,229 B; ceiling 10, `ratchetSlackPct` 0.1).

---

### 1.1 Naming and prior art — mined, not invented

The owner's instinct was right on both counts: `link`/`make` were off-the-cuff, and
the shapes already exist. They exist in **two** places, and the second is the
surprise — **the linkable/fuse vocabulary is not archived, it is live in this tree.**

| role in this design | existing name | where | status |
|---|---|---|---|
| resolve one site to a static body, memoised, cycle-safe | **`link(ip)`** | `src/table/assemble.ts:632` — **live**, returns `Piece`, memoised by code offset, stubs back-edges | **The role already has this name.** The design does not introduce it; it changes what `link` *returns* (an emitted binding rather than a closed-over closure) and what it *resolves against* (child kind as well as option and arity). |
| the per-rule surface siblings call by name | **`_r_<Name>`** | `codegen.ts:424-439` — *"the composition surface (intended collision = override)"*, never inlined so it stays addressable, never namespaced | This is what my `make(...)` produces. Adopt verbatim. |
| the hoisted declaration block an artifact contributes | **`prelude`** | `LinkablePieces.prelude`, `codegen.ts:5851` — *"namespaced hoisted decls (regexes, expected, `_mf`/`_build`, and private `_pf` helper fns)"* | This is where the static bindings go. Adopt verbatim. |
| per-artifact namespace for hoisted names | **`ns`** | `codegen.ts:433-442`; **live** at `linkable()` (`src/compiler/linker.ts:40`) and `LinkableTable.ns` | Adopt verbatim, including its rule: hoisted names are prefixed, `_r_<Name>` is not. |
| hoisted pools | **`_re<N>`** regexes, **`_fx<N>`** expected sets, **`_pf<N>`** private parse fns, **`_mf`** map fns, **`_build`** build fns | `codegen.ts:631-633`, `675-683`, `793-798` | Adopt verbatim. See below — this answers the `_s0` question outright. |
| public per-rule entry | **`wrappers`** | `LinkablePieces.wrappers` | Adopt. |
| the emitted expression for a compiled program | **`replacement`** | `LinkableTable.replacement` — **live**, `src/compiler/compile-linkable-table.ts` | U4's emitted wiring belongs here. There is already a field for it. |
| combining independently-compiled artifacts | **`fuse` / `fusedBody()` / `compose()`** | `src/compiler/linker.ts:695` (`compose`), `:743` (`composeLeaf`), `:934` (`fuseInterpreted`) — **live** | Not this design's operation. See the collision note. |
| deferring a decision to artifact-combination time | **"fuse time"**, via a `/*@FS:rule:codevar@*/true` placeholder rewritten by `fusedBody()` | `codegen.ts:446-451`, `:2640-2641` | Codegen's own "resolve later, branch never" mechanism. Directly relevant prior art for §3's selection — it deferred a *first-set dispatch condition* into emitted text and substituted it when the winning rule was known. |
| artifact version lock | **`v`** | `LinkablePieces.v`; **live** at `LinkableTable.v` | Any emitted form from U4 must stamp it. Named here so U4 does not rediscover it. |

**`link` is the wrong name at the emitted level, for a reason worth stating.**
In this repo *linking* already means **fusing independently-compiled artifacts** —
`linkable()`, `LinkableTable`, `linker.ts`, `fusedBody()`. That is an
artifact-to-artifact operation. Resolving one node's binding for one option set is a
different, smaller thing, and it already has a name one level down (`assemble.ts`'s
`link(ip)`) where the collision is contained because it is module-private. Promoting
that spelling into emitted source would put two meanings of "link" in the same
generated file. **Keep `link` as the internal resolver name it already is; do not
emit it.**

**`make` is wrong twice.** It collides with `_r_<Name>`, which already occupies the
role and comes with a documented override semantics; and it collides with the bench
harness's own `make` (`bench/workloads/index.ts:102`, `make: () => { parse: … }`) —
the very `w.make()` that §8b and the perf-guard analysis refer to as being outside
the timed region. Two different `make`s in one discussion is how the "per-parse
assembly" mechanism got proposed and killed twice.

**`_s0` needs no new name.** A bound node body hoisted into the prelude is exactly
what `_pf<N>` already is: a private, hoisted, namespaced parse function.
`pushNamedFnDecl` (`codegen.ts:800-824`) mints them, `emitNamedFnCall`
(`:826-840`) calls them, `ns` namespaces them, and `LinkablePieces.prelude`
documents them as belonging there. **Adopt `_pf<N>`.** I proposed `_s<N>` and it was
an invention with no advantage.

**The one divergence I want to justify rather than smuggle.** Codegen's `_pf<N>` is a
hoisted function whose *body is emitted per site*. This design's `_pf<N>` is a hoisted
binding whose *value is selected from the shared library*. Same name, same namespace
rule, different provenance — and the divergence is deliberate, because sharing the
body is what keeps `example/css` near 16-24 KB instead of 224,100 B. It is safe for
the property §0.3 cares about (the **call site** `_pf3(input, pos, ctx)` is still a
distinct site in emitted source with its own feedback) but see §1.2 for the limit.

### 1.2 What the naming pass forced out: which bodies may be shared, and which must be emitted

Adopting `_pf<N>` as a *binding to a shared body* rather than an *emitted body* has a
consequence that only became visible once the two were named the same thing, and it
sharpens §2.3's cutoff:

- A body with **no internal call site** — every scannable leaf — may be a shared
  library reference. Its callers each get their own feedback; it has no ICs of its own
  to pollute. `_pf7 = _lib.litLen1(123, _fx4)`.
- A body **with** internal call sites — every sequence, choice, repetition, node —
  **must be emitted per site**, because §0.3 applies recursively: a shared arity-2
  body reintroduces exactly the shared feedback vector the design exists to remove.
  Sharing it would move the megamorphism from `assemble.ts` into the library and
  change nothing.

So the "piece library" is a **leaf** library, and the composite shapes are
**emitters** — which is precisely codegen's split (`emitLit`/`emitShapeMatch` paste;
`emitSeq`/`emitChoice` emit per site). I had this as an efficiency argument in §2.3;
it is actually a correctness argument for the design's central claim, and the
vocabulary is what surfaced it.

**REVISED — a reviewer did attack it, and it DOES change the staging.** The original
concluded "this does not change the staging; U1–U3 remain leaf and term work inside
`assemble.ts`; U4 remains the emitter." U1′ and U2′ genuinely are U4-independent. **U3
is not**: per §4.0, `emitShapeMatch` is a recursive *source* emitter whose speed comes
from constant-folding ranges into source, so as static pieces its bodies reproduce the
`inRanges` loop they exist to remove. **U3 was a unit scheduled ahead of the mechanism
it requires**, which is why §6 splits it — U3a (whose win is `indexOf`, not the class
chain, and which therefore survives without an emitter) and U3b (whose emitter half
follows U4).

**And one correction to §1's illustration, from the same reading.** `_r1 = make(_s0,
_s1, _s2, _s3)` shows one `make` per *rule*. `example/json` and `example/css` have
**exactly one rule each**, so as illustrated `make` would take 28 and 165 arguments and
could not express a tree. **`make` is per-SITE.** §1 is the picture a reader sizes the
unit from, so the mismatch matters even though the block is explicitly illustrative.

---

## 2. The piece taxonomy

The superset is over **emitted body shapes**, indexed by `(option × arity × child-kind)`.
It is finite, emitted once, and generated — but it is not free to author or maintain,
and that maintenance cost is the real constraint on how far specialisation goes.

### 2.1 The option axis — already solved, keep it exactly as is

`RunCfg` (`assemble.ts:193-236`) plus `cfgKey` (`:239-241`) is the correct mechanism
and the correct argument for it. Four bits, sixteen assemblies. The design **adds two
bits and no new mechanism**:

| bit | today | after |
|---|---|---|
| `hostCst` | `RunCfg` | unchanged |
| `trackLines` | `RunCfg` | unchanged |
| `tolerant` | `RunCfg` | unchanged |
| `coverage` | `RunCfg` | unchanged |
| **`probe`** | per-leaf `ctx._probe !== undefined` | `RunCfg` bit (§0.4, and codegen's `probeUpdate` precedent) |
| **`cap`** | per-term inside `skipTrivia` | **2-bit `RunCfg` field, 3 values** — see the correction below. NOT a `triviaCapture` bit. |
| **`_errors` presence** | 14 reads in the mark protocol | `RunCfg` bit, or a `begin`-latched boolean since only *presence* is consulted |

`RunCfg`'s existing doc discipline — *state why the field cannot change during a
parse* — must be extended to every new field, and each must survive the same
scrutiny that rejected `cstCaptureActive` at `:212-214`.

**`probe`'s doc paragraph must name its own sentinel window.** `recovery/scan.ts:29`
does `ctx._probe = undefined; ctx._errors = undefined` and restores at `:40` — the
same window `RunCfg.tolerant`'s doc already addresses. State it by line number or the
next reader will find it and reasonably conclude the bit is unsound.

**`_errors` qualifies by exactly the argument already written for `_tolerant`.** It is
written only by `run.ts:391` and `compile.ts:224` before the parse, and by
`recovery/scan.ts:29/40`'s sentinel save/restore, which `RunCfg.tolerant`'s own doc
(`assemble.ts:204-210`) already argues no piece runs under. `nextTerm` alone reaches
these reads **>200,000×/parse** (`assemble.ts:372`).

### `triviaCapture` as a single `RunCfg` bit is UNSOUND — it would produce wrong output

**REVISED (law review §2.1). This is one of two proposals in the original draft that
would have shipped a wrong tree, not a slow parse.**

The original justification was *"`_triviaLog`/`_rootTriviaLog` presence is fixed
before the parse"*. **It is not.**

- `assemble.ts:1168-1169` (`OP_TOKEN`) and `:1209` (`OP_LEAF`) set
  `ctx._triviaLog = undefined` / `ctx._rootTriviaLog = undefined` for the duration of
  the boundary and restore in `finally` (`:1183-1184`, `:1220`). **This is exactly
  the pattern that made this document correctly refuse to lift `ctx.trivia` to
  `cfgKey`**, and the same reasoning applies unchanged.
- The bit also silently absorbed `ctx.captureTrivia`, which is written by
  `OP_SCOPE_CAP` (`:1016`, restored `:1018`) and by **`OP_NODE` on every node**
  (`:2218`, restored `:2243`). That is per-*node*, i.e. the exact class `RunCfg`'s own
  doc rejects at `:212-214`.

A piece selected for capture and reached under an `OP_TOKEN` boundary would capture
trivia the interpreter does not.

**The correct form, and it is cheap because the machinery is already being built.**
`_triviaLog` presence is a **per-REGION** fact whose boundary is a static table
property — the nearest enclosing `OP_TOKEN`/`OP_LEAF`. It gets the *same* treatment
`ctx.trivia` gets: **a site label from the same downward encoder pass §3.2 already
specifies, with a second label value.** Not a seventh bit. So:

- **§3.2's operand is two small enums, not one** (trivia-in-scope × logging-in-region).
  §8b.1 already asks for the trivia label to be an enum with room to grow; **it needs
  room for two axes, not one.**
- **`captureTrivia` stays runtime** and is covered by neither.
- What *does* belong in `RunCfg` is **`cap`, a 2-bit field with three values** —
  `0` skip-only, `1` full CST, `2` root-log-only — matching the archived
  `_cap` parameter's actual arity (`trivia-fast-path.ts`; `_cap === 1` gates the CST
  push at `scannable-run.ts:1621`). One bit never covered it.
- **`_rootTriviaCapture` is a SITE property, not a bit** — it is swapped by an opaque
  scope (`codegen.ts:4747-4751` wraps it in `try/finally`). It joins the
  site-attribute record of §2.4.
- **`_rootTriviaKindIndex[label]` is a per-trivia-token string-keyed map lookup**
  (`scannable-run.ts:1619`). `label` is a compile-time constant at every emission
  site, so **the index resolves to an integer at `link`** and the emitted tail pushes
  a constant. Codegen left it at runtime, so this is not a regression — it is a free
  selection win at **negative byte cost** (a constant replaces an expression), and it
  is **the cheapest speed item found in any of the three reviews**.

**Net effect on the plan:** U2's body-variant count at each term position goes from 2
to 4 (trivia × logging). Still finite, still generated.

**`ctx.trivia` presence is the one that does NOT become a bit,** and this is the
subtlety the design has to get right. `OP_SCOPE` swaps `ctx.trivia` mid-parse
(`assemble.ts:1014`, `:1019`, `:1029`, `:1161`, `:1176`) — `rules({ trivia })` is
per-scope, not per-parse. So `nextTerm`'s `if (ctx.trivia === undefined)` cannot be
lifted to `cfgKey`.

It can be lifted to **the site**, which is strictly better. Whether a given `OP_SEQ`
sits under a trivia-bearing scope is a static property of the encoded table: it is
the nearest enclosing `OP_SCOPE`/`OP_SCOPE_CAP`, and `encode.ts:520` already emits
that wrapper with the trivia slot. A downward pass over the code array labels each
sequence site `trivia: none | slot-N`. That is an **encoder-side** analysis, resolved
before resolution ever runs, and it makes the trivia decision a child of the *site* rather
than of the *options* — which is what codegen did (`ctx.activeTrivia`,
`codegen.ts:1774`).

### 2.2 The arity axis — already solved, extend the ceiling once and stop

`assemble.ts:1467-1560` unrolls 1/2/3 and falls to `runTerms`. That is the right
mechanism and the right cutoff argument. In emitted form the same cutoff applies:
generate unrolled bodies for arity 1–4, generic loop above. Arity 4 is worth adding
because css declarations (`sequence(ident, ':', valueList, optional(important),
optional(';'))`) are 5-ary and less rules are wider; I would **not** go past 4
without a measured row histogram, which `src/table/inspect.ts:48` (`reachableOps`)
can produce without timing anything.

### 2.3 The child-kind axis — the missing third

This is the new work. A child's opcode is **already visible to the parent at
assembly time** — `assemble.ts:1385` does exactly this today:

```ts
for (let i = 1; i < n; i++) if (code[code[base + i]!] === OP_ADJ) { hasAdj = true; break }
```

`code[base + i]` is the child's ip; `code[<ip>]` is the child's opcode. **No encoder
change is required to see child kind.** That is a significant de-risking of the
staging: selection is available today, only the pieces are missing.

**The child shapes that earn a dedicated body**, and the cutoff rule.

**The cutoff rule — RESTATED. The original wording was false and, taken literally,
deleted U3 entirely.**

The original rule read *"branch-free straight-line code with no call into another
piece and no allocation."* **Zero of the nine `ScanShape` emissions are branch-free**
(coverage review §1, enumerated against `scannable-run.ts`): `chars` emits a `while`;
`ident` an `if` + `while`; `seq` a `do {…} while (false)` with a `break` per part and
a recursive group loop; `litFold` an `if`; `until` an `if` + `while` **or a builtin
`indexOf` call**; `string` an `if` + `while` + 3 inner `if`s + `continue`;
`delimited` an `if` + `while` **or `indexOf`**; `alt` a `switch` jump table, an
`if/else if` chain, or a labelled block with `break _alt`; `lookahead` an `if`. The
§2.3 table below — which says all nine paste — was right. **The rule was wrong**, and
applied literally it rejects even `chars`.

The correct rule, read off codegen's actual behaviour and off `emitShapeMatch`'s own
documented contract:

> **A child pastes when its matcher is SELF-CONTAINED: it needs no call into another
> *piece*, it allocates nothing, and it exposes no backtrack point to its parent — it
> either consumes a span or reports `end === start`. Internal branching and looping
> are irrelevant and expected. Builtin calls are fine.**

The third clause is the load-bearing one and it is `emitShapeMatch`'s own invariant,
stated at `scannable-run.ts:1201-1203`: *"`end === start` whenever there is no
progress … so the trivia loop can gate purely on `end > start`."* That is the property
that makes a paste safe. "Branch-free" is not. And the builtin-call carve-out is not a
concession — `indexOf` is a **measured 4.3× win** on `until`/`delimited`
(`scannable-run.ts:1484-1491`); a rule that excluded it would exclude the best shape
in the set.

This rule is what a reviewer or implementer applies to a shape the table does not
list, which is why the wording is load-bearing rather than pedantic.

The cutoff is codegen's own rule, read off its behaviour.
`emitLit`, `emitRegex`-when-scannable, and `emitShapeMatch` all paste; `emitLazy`
pastes only under a node budget (`INLINE_MAX_NODES = 1000`, `codegen.ts:5036`) and
otherwise calls `_pfN`; named rules **never** inline (`:4349-4352`); multi-use
subtrees over `HOIST_MIN_SUBTREE = 3` nodes hoist to a call (`:4545-4585`,
`:5002`). Codegen bounded its own explosion with a node budget and a use-count
threshold, and inlined nothing that had internal control flow of its own.

**Every row cites the codegen emitter that already produced that shape.** Reusing a
proven emitted shape is cheaper and less risky than authoring one, and an existing
emitter is the strongest available evidence that a piece is well-formed — it means
the shape has already passed the identity sweep against the interpreter. **No row in
this table is a new invention.** Where a row has no prior art I say so.

| child kind | opcode | inline into parent? | body | codegen prior art |
|---|---|---|---|---|
| literal, len 1 | `OP_LIT` | **yes** | `input.charCodeAt(p) !== 123` | `emitLit` `codegen.ts:1401-1406` |
| literal, len 2–16 | `OP_LIT` | **yes** | bounds check + unrolled `charCodeAt` OR-chain | `emitLit` `:1407-1414`, pivot `CHARCODE_CHAIN_MAX = 16` `:1377` |
| literal, len > 16 | `OP_LIT` | **yes** | `input.startsWith(s, p)` | `emitLit` `:1415-1421` |
| literal, case-insensitive | `OP_LIT_CI` | **yes** | ASCII bit-OR fold chain | `emitLit` `:1386-1398`, via `foldEq` `scannable-run.ts:120` |
| literal, as a pure condition (choice arm) | — | **yes** | same 16-char pivot, no fail branch | `emitLiteralCondition` `:3005-3016` |
| regex with a `ScanShape` | `OP_RX` | **yes** | the nine `emitShapeMatch` forms — chars, ident, until, delimited, string, seq, litFold, lookahead, alt | `emitRegex` `:1681-1697` → `emitScannableTerminal` (`scannable-terminal.ts`) → `emitShapeMatch` `scannable-run.ts:1244-1595` |
| regex without a `ScanShape` | `OP_RX` | **yes** | hoisted sticky `_re<N>` + `exec`, still straight-line | `emitRegex` `:1698-1724`, hoist `:1703-1710` |
| char class | (a `chars` `ScanShape`) | **yes** | `while` + `classCond` | `emitShapeMatch` `scannable-run.ts:1358-1369`; `classCond` `:1163-1166` |
| trivia scan | site property, not a child | **yes** | the specialised scan loop, spliced per term position | `ensureTriviaFn` `:1044-1130`, `trivia-fast-path.ts` `composeFastLoop` `:88-97`, splice `emitSeqValues` `:1774-1878` |
| `OP_EMPTY` | | **yes** | zero-width, already trivial | — |
| `OP_ADJ` | `OP_ADJ` | **NO — parent-side, see below** | third value in the term-position trivia enum | `emitAdjacency` `:1003-1141` |
| `OP_GREEDY`, `OP_REJECT` | | **whole-choice shape, see §2.5** | selected by choice *strategy*, not child kind | `emitGreedyClassify` `:2472`, `emitFirstMatch`'s `_carej` `:2620` |
| rule reference | `OP_RULE` | **no — call** | `_r_<Name>(input, p, ctx)` | `emitLazy` `:4343-4434`; named rules never inline `:4349-4352` |
| nested seq / choice / rep / opt / node | `OP_SEQ`… | **no — call** *(or paste under a budget)* | hoisted `_pf<N>` | `emitSeq` `:1888`, `emitSeqValues` `:1739`, `emitChoice` `:2065`, `emitMany` `:3018`; hoist rule `:4545-4585`, `HOIST_MIN_SUBTREE = 3` `:5002` |
| everything else (24 opcodes) | | **no — call** | hoisted `_pf<N>` | `pushNamedFnDecl` `:800-824`, `emitNamedFnCall` `:826-840` |

**Two divergences from codegen's convention, stated rather than quietly renamed.**

1. **Codegen pasted composite bodies under a node budget; this design does not.**
   `emitLazy` inlined a single-use private ref when `sizes <= ctx.inlineLeft` with
   `INLINE_MAX_NODES = 1000` (`:5036`), and `emit()` hoisted only shared subtrees of
   3+ nodes. That budget is most of the 224,100 B `example/css`. **Divergence
   justified by the size mandate**: this design hoists to `_pf<N>` at a much lower
   threshold and accepts the call, because the middle ground is the requirement.
   §6/U4's byte predictions assume this and would be wrong under codegen's budget.
2. **Codegen had no shared leaf library — it pasted leaves inline everywhere.**
   This design allows a leaf to be a shared library reference (§1.2). **Divergence
   justified by §1.2's rule**, and bounded by it: only bodies with no internal call
   site may be shared. Where a leaf is a *child of a sequence being emitted per
   site*, pasting it inline as codegen did remains available and is strictly better;
   the shared-library form is for leaves reached through a binding.

**No prior art, flagged as genuinely new:** the per-site trivia label (§3.2) has no
codegen equivalent, because codegen carried `ctx.activeTrivia` in the emitter's own
recursion (`:1774`) and never needed to record it in an artifact. It is new because
the table separates encode from assemble and codegen did not. Proposed name follows
the encoder's existing operand convention, not a new vocabulary.

**So the taxonomy is small.** Two child classes: *scannable leaves*, which paste;
and *everything else*, which becomes a named static binding called from a distinct
site. The apparent combinatorial explosion `(option × arity × child-kind)` does not
materialise, because:

- the option axis is resolved into `cfgKey` before body selection, and the trivia
  variant is a site label, so it multiplies the *selection table*, not the *body set*;
- the child-kind axis has **two** values at each term position (paste / call), not
  seven, so an arity-`n` sequence has 2^n body variants in principle — and here the
  bound bites: **only the paste bodies are generated, and they are generated by
  composing the leaf emitters, exactly as `emitSeqValues` did.** There is no
  hand-written piece per combination. `emitShapeMatch` (`scannable-run.ts:1244`) is
  the single source of truth for nine shapes and is consumed by both the terminal
  emitter and the trivia loop precisely so the two can never disagree; that
  composition property is what keeps the library authorable.

**Where specialisation stops:** at anything that is not self-contained by the rule
above — a choice arm, a repetition body, a `node()`. These get a binding and a call.

**And the size lever originally claimed here is INERT — corrected rather than
deleted.** The original text read: *"the difference here is that codegen also pasted
whole rule bodies under a 1000-node budget, and we do not. That single decision is
most of the 224,100 → target gap."* **`example/json` and `example/css` have exactly
ONE rule each** (`r:{"Entry":134}` / `r:{"Entry":878}`, predictions review §3). There
is no rule-body inlining to decline on either fixture used to size the work. Codegen's
541 B/node (json) and 1,358 B/node (css) *are* the cost of per-site bodies for 28 and
165 nodes — and U4 emits per-site bodies for 28 and 165 nodes. The real byte lever is
what the table's pools still deduplicate (chiefly the `e:` expected-set pool, 39% of
`example/css`) plus the hot-site emission threshold of §6/U4 — **not** a declined
inline budget. §6/U4's size range is re-derived accordingly.

**A note the paste/call dichotomy needs, so a reader does not over-read §0.3.** Under
U4, a *rule-reference* callee is a large function and will **not** be inlined; the win
at those sites is the monomorphic call only. The **inlining** win verified in §0.3's
Test D is for the self-contained leaves — the paste side of this dichotomy. The
dichotomy is correctly placed, and that is *why* it is placed there.

---

### 2.4 The fourth axis the taxonomy was missing — INHERITED SITE ATTRIBUTES

**NEW (coverage review §3).** The key was `(option × arity × child-kind)`. All three
are properties of the parent's options, the parent's shape, or the child's **own**
opcode. Codegen had a fourth input none of these captures: **facts pushed DOWN from an
ancestor into a descendant's emission.**

The original draft met exactly one instance and solved it correctly — §2.1's trivia
site label, lifted to the site by "a downward pass over the code array", explicitly
noting *"this is what codegen did (`ctx.activeTrivia`, `codegen.ts:1774`)"*. **It then
treated that as a one-off subtlety rather than as one member of a family.** The family
has at least eight more members:

| inherited fact | archive site | what it changes in the descendant |
|---|---|---|
| `ctx.activeTrivia` | `codegen.ts:1774` | the trivia label — already in the plan |
| `_triviaLog` presence per region | `assemble.ts:1168`, `:1209` | the second label axis (§2.1's correction) |
| `ctx.leafBufLit` / `rawBufLit` | set `codegen.ts:4189-4192`, read `emitLeafCapture:848` | picks **one of four** CST-leaf capture shapes in every terminal at arbitrary depth below the node |
| `ctx.replayPrefix` / `replayUsed` / `replayOwner` | `emitSharedPrefix:2871-2910`, consumed `emitReplayPrefixLeaf:2921` | replaces an arm's leading terminal with a **no-scan replay** — see §8b.3 |
| `ctx.routedLocal` | installed `emitDispatchCombinator:2296`, read `emitRouted:3706` | which of two forms `routed()` emits |
| `ctx.inlineLeft` | `INLINE_MAX_NODES = 1000` (`:5036`), charged `emitLazy:4367-4372` | paste vs `_pfN` call |
| `ctx.failLabel` | threaded throughout | which label a failure breaks to |
| `ctx.capAsTrivia`, `ctx.noHoist` | `ensureTriviaFn:1044`; `emitScanTo:3557`, `emitPeek:3690` | suppresses capture and hoisting in a whole subtree |
| `_rootTriviaCapture` | `codegen.ts:4747-4751` (`try/finally`) | per-region, not per-parse (§2.1) |
| **placement of `OP_ADJ`** | `src/table/ops.ts:226-251` | must run *before* the parent's trivia scan |
| **placement of `OP_ATTEMPT`** | `src/table/ops.ts:362-371` | the row's *body* differs by grandparent |

**The mechanism is already in the plan.** Generalise §3.2's single
`trivia: none | slot-N` operand into a small **packed site-attribute record** carrying
at minimum `trivia`, `logging`, `cstLeafShape`, `replaySlot`, `routedLocal`,
`rootTriviaCapture`. Selection key becomes:

```
(site-attrs × option × arity × child-kind)
```

**Byte cost: zero over what U2 already budgets.** These are all small enumerations and
pack into the single integer operand U2 already spends. Worth naming in the PR,
because it makes U2's ratchet break buy four axes instead of one.

**Two constructs this axis exists to make expressible, both currently mis-filed:**

- **`OP_ADJ` is not a paste child.** `ops.ts:226-251`: it is *"A BOUNDARY TEST, NOT A
  TERM … it must be evaluated at the sequence cursor — **BEFORE the ambient trivia
  scan**… A piece handed the post-scan position would find the gap already consumed
  and answer 'adjacent' every time, **silently**."* So it changes the *parent's*
  term-boundary emission — a third value in the term-position trivia enum, on top of
  `no-trivia` / `scan-trivia`. Its kind filter is additionally *"resolved against the
  ACTIVE trivia table at parse time … not an assembly-time fact"*, so it is a genuine
  runtime read that survives selection and needs the §3.3 paragraph, which it did not
  have. **The failure mode is silent wrong output** (`adjacent()` becomes a no-op,
  `notAdjacent()` a guaranteed failure) — this belongs in §9.5's risk class, not in
  "already trivial".
- **`OP_ATTEMPT`'s body depends on the GRANDPARENT.** `ops.ts:363-368`: the
  transparent-wrapper form is correct for exactly one placement — *an arm of an
  `OP_CHOICE`*, whose per-arm loop already saves and restores the eight capture sinks.
  Anywhere else — a `sequence()` term, a repeat item, a `node()` body — a failed
  transaction leaves CST leaves, raw children, fields, recovery diagnostics and
  trivia-log entries behind. `attempt-under-choice` and `attempt-elsewhere` are two
  bindings selected by the site-attribute record. **This is a speed win as well as a
  correctness one**: under a choice parent the eight-sink save/restore is redundant
  work the parent already does.

**The draft's own evidence pointed here and was misread.** §2.3 cites `assemble.ts:1385`
— `if (code[code[base + i]!] === OP_ADJ)` — as proof that child opcode is visible to
the parent with no encoder change. True, and useful. But that line exists *because*
`OP_ADJ` is a fact the **parent** must act on at a position before the trivia scan. It
is evidence for the inherited axis, not only for the child-kind axis.

### 2.5 The fifth axis — CHOICE STRATEGY. `OP_GREEDY` and `OP_REJECT` were unaccounted.

**NEW (coverage review §4.4).** Neither opcode appears anywhere in the original draft,
and §8b.3 explicitly declined to check `OP_GREEDY` (*"I did not check it and am not
claiming it is missing"*). Checked:

- **`OP_GREEDY`** (`ops.ts:283`) is the identifier-vs-keyword shape, and `choice()`
  **auto-selects it** (`ops.ts:256-257`, `choice.ts:186-202`), so it appears in
  essentially every real language grammar — css and less included. It is not a choice:
  a regex arm runs, the match is **re-attributed by string equality**, and the winning
  literal arm is **re-run at `pos`** with a capture-sink rollback to a pre-`sup` mark
  (`ops.ts:268-277`). It is additionally **sibling-dependent** — the emission reads
  every literal arm — so it cannot be a child-kind decision. Today it also does
  `byWord.get(input.slice(pos, end))` (`assemble.ts:1794`): **a string allocation per
  greedy execution**, then a `Map` lookup, then a megamorphic `lit(…)`.
- **`OP_REJECT`** (`ops.ts:307`) is `autoNot`: checks that run after an arm succeeded
  and can still reject it. The checks are a **variable-length `(kind, operand)` pair
  list walked at parse time** — an array walk on the parse path, i.e. **a violation of
  this document's own proposed `INV-7`**. Codegen pasted them inline
  (`emitFirstMatch`'s `_carej`, `codegen.ts:2620`).

**Both are whole-choice shapes, selected by the choice's STRATEGY.** §8b.3 already
half-has this, conceding that *"a `sharedPrefix` choice is a choice-kind child shape"*.
Generalise it to a **choice-strategy axis** whose values are all already in the tree:
`ordered` (`OP_CHOICE`), `disjoint-dispatch`, `greedyClassify` (`OP_GREEDY`),
`literalsLongestFirst`, `sharedPrefix`. Codegen has an emitter for each
(`emitFirstMatch:2589`, `planDisjointDispatch:1185`, `emitGreedyClassify:2472`,
`emitLiteralsLongestFirst:2543`, `emitSharedPrefix:2871`). `OP_REJECT`'s check list
unrolls into the arm body at emission, which removes the array walk and satisfies
`INV-7`.

Speed: both sit on the keyword path of every css/less parse. Bytes: the unroll is
per-arm-per-check — call it **+100–300 B on `example/css`**. Worth it.

---

## 3. Selection — how assembly picks a body without a runtime test

### 3.1 What is already available

- **Child opcode:** `code[code[base + i]!]`, no encoder change (§2.3).
- **Literal length:** `(k[code[kidIp + 1]!] as string).length`, no encoder change.
- **Regex source and flags:** `k[code[kidIp + 1]!]` is the `RegExp`; `.source` /
  `.flags` feed `scanShapeFromRegex` directly. No encoder change.
- **Option set:** `RunCfg` / `cfgKey`, plus the two new bits.

### 3.2 What the encoder must add

One thing, and it is an analysis rather than a new opcode:

**A per-site attribute record** (§2.4), of which the trivia label is the first field.
Each `OP_SEQ`/`OP_SEQV`/`OP_SEQX`/`OP_REP`/`OP_REPV` **and — REVISED (law review O7) —
`OP_NODE`/`OP_NODE_TRACK`** row gains one packed integer operand. Computed by one
downward walk during `encode`, where the scope wrapper is already emitted
(`encode.ts:520`, `:1160`). This is what turns `nextTerm`'s
`if (ctx.trivia === undefined)` into a selection.

**`OP_NODE` was omitted from the original list and it is the highest-volume site.**
`assemble.ts:2231` reads `ctx.trivia !== undefined` **per node** — 145,512 nodes/parse
on `benchmark.less`. `OP_REP`/`OP_REPV` (`:1922`, `:2009`) read it per repetition
entry. One line of encoder change, already being written.

**Minimum field set:** `trivia` (none | slot-N | adjacency-checked — §2.4's `OP_ADJ`
correction needs the third value, and §8b.1's token-streaming note needs a fourth, so
**make it an enum from the start**), `logging` (the `_triviaLog`-presence region axis
that §2.1's correction demands instead of a `RunCfg` bit), `cstLeafShape`,
`replaySlot`, `routedLocal`, `rootTriviaCapture`. All small enumerations; one integer.

**Three further per-node option reads that a site label does NOT fix, and their
cheaper answer** (law review O8–O10). `assemble.ts:2227` reads
`host?._parsemanTriviaKinds !== undefined` — an optional chain plus a property load
**off a `JSFunction` object**, per node; `:2260`/`:2263` do the same for
`_parsemanCstCollapse`; `:2267`/`:2271`/`:2277` test `host !== undefined` three times
per node when, in the `hostCst` assembly, it is **provably true** (`cfgKey` derives
`hostCst` from `host !== undefined && cstOutputHost(host)`, `:2411`). The first two are
per-parse VALUES, not bakeable facts, so they get the treatment `HOST`/`COV` already
get: **latch them in `begin`** (`let HOSTKINDS`, `let HOSTCOLLAPSE`) by the argument
already written at `assemble.ts:483-496`. The third is a straight selection on
`hostCst` at `link`, as `OP_SCOPE_CAP` already does at `:1007` — two node bodies, no
test.

Optionally, a **precomputed `ScanShape` id** per `OP_RX` row, so `parseScanShape`
runs at encode time and the shape is table data rather than re-derived per assembly.
I would defer this: `scanShapeFromRegex` is memoisable on the `RegExp` object
(`fastTriviaCache` already demonstrates the pattern at `trivia-skip.ts:34`) and
assembly runs once per grammar per cfg. Adding it to the table costs bytes for no
parse-path benefit.

### 3.3 The one thing selection must not do

It must not consult anything that varies during a parse. The four rejected candidates
are already documented and the reasoning is correct and reusable: `cstCaptureActive`
(`assemble.ts:212-214`), `ctx._cstBuf` (`:227-229`), the capture sinks
(`check-invariants.mjs`'s RUNTIME column), and the position. Any new bit must come
with the same paragraph.

### 3.4 `cstCaptureActive` — selectable in the common case even though it is runtime

`cstCaptureActive(ctx)` appears 9 times and is genuinely per-node. But when
`RunCfg.hostCst` is false **and** the grammar has no `OP_LEAF`/CST-capturing scope
reachable from a site, capture can never become active there. That is a reachability
fact the assembler can compute from the code array. The AST-host assembly then
selects leaf bodies with no capture test at all — which is what codegen emitted,
since it generated per-host-mode variants.

I am moderately confident in this and it is the sort of claim that produces a silent
wrong-output bug if the reachability analysis is wrong. It should land **after** the
cheap units and behind the §8 gates, not before.

---

## 4. The archived capabilities, as pieces

Per the owner's clarification: recover the **capabilities**, not the modules. No file
is restored to `src/compiler/`. `codegen.ts` does not come back as a shipping engine;
it is the reference for the shapes, and `a5dc9bd` remains reachable as a measurement
leg through `bench/ab-harness.ts`'s `materialise`.

| archived capability | becomes | why |
|---|---|---|
| `scannable-run.ts` — `parseScanShape` / `scanShapeFromRegex` (lines 1–1152, the analysis half) | **encoder-side or assembly-side analysis, not a piece.** Ported as a shape recogniser consumed by `link(ip)` (`assemble.ts:632`) at resolve time. | It is a *classifier*: regex source → one of nine shapes. Nothing about it runs at parse time. ~71% of the file is soundness proofs (`seqIsUnambiguous`, `trailingBacktrackClass`, `allPairsDisjoint`, `delimitedBodySound`) answering "does greedy one-pass scanning provably equal the backtracking engine" — that is exactly the correctness argument the new pieces need, and re-deriving it is the largest avoidable cost in this project. |
| `scannable-run.ts` — `emitShapeMatch` (lines 1154–1627, the emission half) | **a recursive SOURCE emitter, not nine bodies.** See the correction below. | `chars`, `ident`, `until`, `delimited`, `string`, `seq`, `litFold`, `lookahead`, `alt`. `delimited` is the one css/less need back (§0.6). |
| `scannable-terminal.ts` (31 lines) | **the composition rule**, not a piece. | Correcting the brief: this file contains no classification. It is a five-line wrapper — run `emitShapeMatch`, fail if `ok !== 'true'`, slice the value. Its value is its header claim: terminal and trivia share **one** match core so they can never disagree about an incomplete token. That invariant must be preserved by construction in the new library. |
| `trivia-fast-path.ts` (296 lines) | **trivia-scan piece bodies, spliced per term position**, selected by the site's trivia label × the capture bit. | Four tiers: unlabeled scannable, labeled scannable, labeled all-regex arms, labeled runtime arms (`ensureTriviaFn`, `codegen.ts:1044-1130`). The capture tail (`CAP_RECORD`, `:74-79`) is **part of the loop body**, which is how it captures with zero allocation — versus today's `{end, commit}` object per term (§0.6). Note it never emitted inline into the sequence body either: it built a whole `_tfN` function and the sequence called it. That is a real precedent for a *call* being acceptable here, and it is why §6's U2 targets the option branch and the allocation rather than the call. |
| `trivia-fast-path.ts` — the commit-only-if-the-term-consumed rule (`codegen.ts:1785`, `:1832`) | **selection**: when `alwaysConsumes(term)` is statically true, emit no marks and no rollback at all. | This is `nextTerm`'s `if (END > scanEnd) … else rollbackTriviaAt(…)` (`assemble.ts:545-549`) turned into a compile-time fact. `alwaysConsumes` is derivable from the child opcode. Free win on every term whose child is a literal or a `min>=1` regex. |
| `module-hoist.ts` (221 lines) | **encoder-side decision.** | `HOIST_MIN_SUBTREE = 3` plus a use count. The table already memoises by code offset (`assemble.ts:632-650`), so subtree sharing exists; what is missing is the *threshold*, i.e. deciding when a shared subtree should be a named binding rather than pasted. That is precisely the size lever in §6. |
| `inline-build.ts` (111), `inline-callback.ts` (105) | **encoder-side decisions.** | Both are analyses answering "may this reducer/build call be pasted". They inform `OP_SEQX` fusion, which the table already has. Port the analysis; there is no piece. |
| `line-index.ts` | **reference only.** | §4 of `RELEASE-0.48-TARGET.md` is the open item (`TODO(table/expect-span-lines)`); it is a correctness gap, not a speed one, and orthogonal to this design. |
| `codegen.ts` | **reference only. Recommend it does not come back.** | Owner decision, flagged. My recommendation and its cost are in §4.1. |

### 4.0 `emitShapeMatch` is a recursive SOURCE emitter — "nine piece bodies" was wrong, and it re-orders the plan

**REVISED (coverage review §2). This is the sequencing correction in the document.**

`ScanShape` is **not** a nine-member enum. It is a **recursive type** with three
self-referential constructors (`scannable-run.ts:43-81`):

- `alt.arms: ScanShape[]` (`:81`), recursed at `:1319`, `:1333`, `:1349`
- `lookahead.inner: ScanShape` (`:72`), recursed at `:1252`
- `seq.parts: SeqPart[]` where `SeqPart` has its own three variants (`lit`/`run`/`group`,
  `:43-50`) and **`group.inner` is any `ScanShape`** (`:50`), recursed at `:1432`

So the number of distinct bodies is the number of distinct shape *trees* in the
grammar — **unbounded** — not nine. `emitShapeMatch` returns
`{ setup: string[]; ok: string; end: string }` (`:1208`), i.e. **code strings**,
threaded through a `Mint` gensym (`:1191`) so spliced fragments do not collide.

**And the recursion is not the whole problem. The constant-folding is.** Every shape's
speed comes from baking its ranges and code points **into the source**: `classCond`
(`:1163-1166`) emits `(c >= 97 && c <= 122) || c === 45`, an inline compare chain;
`litCond` (`:1169-1176`) and `foldEq` (`:120-124`) do the same for literals and the
ASCII fold. **A static runtime piece cannot do this.** It must close over a `ranges`
array and loop it — which is precisely `inRanges` in the current tree
(`src/combinators/trivia-skip.ts:391-397`, called per character at `:405`, `:459`,
`:478`; again at `src/combinators/regex.ts:34` and `src/cst/trivia-charscan.ts:35`).

The original U3 promised to replace *"`inRanges`' per-character range loop in favour
of an inline `classCond` chain"* — **but an inline `classCond` chain IS emitted
source.** As static pieces, the nine bodies reproduce the very loop U3 exists to
remove.

**Consequences for the plan:**

1. **The classifier half and the emitter half are separate units.**
   `parseScanShape` / `scanShapeFromRegex` (`:1-1152`, ~71% soundness proofs) genuinely
   is assembly-time and **U4-independent**. It is the expensive half, it de-risks U4,
   and it should be ported early. **Only `emitShapeMatch` needs U4.**
2. **The full `classCond` win is a U4 deliverable, not a pre-U4 one.** §6 places the
   emitter half after U4 accordingly.
3. **A real, small pre-U4 subset survives**, and it is what `lane/triviacost` is
   building: the shapes whose win is **not** constant-folded ranges — `litFold`,
   and `until`/`delimited` under `indexOf` (a measured 4.3×, `:1484-1491`), plus the
   `prefixRun` line-comment shape. `delimited` is the css/less case and **its win is
   the SIMD `indexOf`, not the class chain — so it does survive without an emitter.**

**A calling-convention note that must not be lost.** `emitShapeMatch` pastes are
**fragments, not bodies**: they read a caller-supplied `firstChar` expression
(`:1205-1206` — *"the trivia loop reads it once and shares it"*), mint names into the
caller's scope (`:1191`), and hand back `ok`/`end` as **variable names** (`:1208`). So
"paste bodies are composed from `emitShapeMatch`" commits the piece library to a
**calling convention over variable names**, not merely to a set of bodies. An
implementer who wraps each shape in a function to keep things tidy silently loses the
shared `firstChar` load — and loses the paste, which is the whole unit.

**One build-time flag to settle rather than carry across.**
`scanToIndexOfEnabled()` reads `process.env.PARSEMAN_SCANTO` **on every emission**
(`scannable-run.ts:1161`, used `:1495`, `:1574`). Under this design that is a
build-time selection, not a `RunCfg` bit — it changes emitted source, not parse
behaviour. Carrying it across as a runtime test would be an `INV-6` violation on the
hottest scan loop. Its default is OFF and its measured win is 4.3×: **turn it ON and
gate on the identity sweep**, rather than leaving it as an env A/B.

### 4.1 On `codegen.ts` specifically — recommendation, with the tradeoff stated

**Recommend: do not restore it as a shipping engine.** Reasons, in order of weight:

1. Restoring it restores *two* recognisers, and the entire cost of 0.47 was paid to
   have one. Every divergence class that `bench/jess/digest.ts` and
   `test/parity/*` exist to catch would double.
2. Its bulk is the thing being rejected: `example/css` 224,100 B against 9,229 B.
   The middle ground is not reachable by keeping the high end and adding a low end.
3. Its emitted shapes are what this design reconstructs. Once they are reconstructed,
   the emitter is redundant by construction — and if it is *not* redundant, that is
   a coverage bug in the new library which having the old emitter around would hide.

**The tradeoff, honestly:** restoring it is the only way to get the old numbers back
*immediately*, and this design is a multi-stage project whose later stages are the
expensive ones. If the release schedule cannot absorb that, restoring codegen as a
temporary opt-in engine buys time at the cost of maintaining two recognisers for the
duration. **Design so either answer works:** nothing in §2–§3 depends on codegen's
absence, and `a5dc9bd` stays reachable through `materialise` regardless, so the
measurement leg does not depend on this ruling either.

---

## 5. The criterion, and how a reviewer detects a violation

**This section is the enforcement half of the PURPOSE statement at the top of the
document.** Restating the test it enforces:

> **Any consulting of options at parse time, per rule or per combinator, is a FAIL.**
> Resolution happens ONCE PER RUN — not per parse, not per rule entry, not per
> combinator. Elimination, not amortisation: a resolved path holds no flag read, no
> cached lookup, no branch that always goes the same way.

Its structural twin, which `INV-7` covers — **RESTATED**: no parse path resolves a
callee from anything but a lowering-scope `const` or an imported module function.
(The original "no parse path indexes an array to find a child" both leaks and is
noisy; see §5.1.)

**How each proposal moves toward it.** Note the fourth column — three of these
proposals do not improve compliance at all, and §6.1 is where each unit's overall
verdict lands.

**REVISED.** The original had this table twice, in two inconsistent versions, and both
credited a `triviaCapture` bit that §2.1 shows is unsound. One table, corrected:

| proposal | option consults it removes from the parse path | new tests | compliance or work? |
|---|---|---|---|
| `_probe` → `RunCfg` | 6 leaf-**failure** sites + `OP_GATE:803` (success path) | none | **compliance**, worth ≈0.05% |
| `OP_GATE` selected at `link` | `_tolerant` — **already a `RunCfg` field**, a live `INV-6` violation | none | **compliance — a bug fix** |
| site label, trivia axis | `nextTerm:526`, `OP_REP:1922`/`:2009`, `OP_NODE:2231` | none | **compliance** |
| site label, logging axis (**replaces the `triviaCapture` bit**) | `skipTrivia`'s capture clauses, per term | none | **compliance**, and the bit form was **unsound** |
| `cap` as a 2-bit `RunCfg` field | the 3-valued capture mode | none | **compliance** |
| `_errors` latched in `begin` | 14 mark-protocol reads, >200,000×/parse | none | **compliance** |
| `HOSTKINDS`/`HOSTCOLLAPSE` latched in `begin` | `OP_NODE`'s 2 `JSFunction` property loads per node | none | **compliance** |
| `hostCst` selection in `OP_NODE` | 3 provably-true `host !== undefined` tests per node | none | **compliance** |
| `alwaysConsumes` at selection | mark block + `END > scanEnd` + rollback, per term | none | **compliance** |
| AST-host capture elision (§3.4) | `cstCaptureActive` on the AST assembly | none | **compliance**; **the leaf-only half is safe and moves to U1′** |
| emitted `_pf<N>` bindings (U4) | `AssemblyCache.forCtx` per rule entry; every non-provenanced callee | none | **compliance — the only full pass** |
| `INV-6a` file scope | 10 `ctx.trackLines` reads outside `assemble.ts` | none | **compliance — no new rule semantics** |
| length-keyed literal bodies | none | none | **work only** — and it is U1′'s headline |
| `ScanShape` terminal bodies | none (`re.exec` → scan loop is work) | none | work only |
| `_rootTriviaKindIndex[label]` → constant at `link` | a **string hash per trivia token** | none | work only, at **negative** byte cost |
| shared-prefix scan-once (§8b.3) | none | none | work only |
| `OP_REJECT` unrolled into the arm body | none (an array walk, not an option) | none | work only — but it is what makes `INV-7` satisfiable |

### 5.1 Detection — three mechanisms, in increasing strength

The checker's job is to make the PURPOSE criterion mechanically enforceable:
**no option-derived value read on a parse path, full stop.** `INV-6` was written for
exactly that and cannot currently express it.

**REVISED — the three original mechanisms have become six rules, ranked by the speed
each protects. Two of the three original forms were both leaky and noisy.**

**INV-6a — SCOPE. #1 by speed protected, and it needs no new rule semantics at all.**

> Replace `const ASSEMBLER = 'src/table/assemble.ts'`
> (`check-invariants.mjs:587`) with a **parse-path module set**. Seed it statically:
> `src/table/assemble.ts`, `src/combinators/trivia-skip.ts`,
> `src/cst/capture-buffer.ts`, `src/combinators/adjacency.ts`,
> `src/combinators/probe.ts`, `src/recovery/scan.ts`, `src/combinators/node.ts`,
> `src/combinators/literal.ts`, `src/combinators/dispatch.ts`,
> `src/compiler/fields.ts`, `src/line-index.ts`.
> Maintain it by a second check: any module `assemble.ts` imports a *function* from,
> that is called inside a piece-internal body, must be in the set or the gate fails
> naming it.

Protects the **10 `ctx.trackLines` reads the gate's own field list already forbids**
(§0.5, hole 1) plus §0.6's whole `scanTrivia` read chain. **This is the single
highest-value line of checker in the plan.**

**INV-8 — PIECE-AS-PARAMETER. #2.** *(new — nothing in the original draft states the
law's dispatch half.)*

> No function may accept a parameter whose declared type is `Piece`, `TermRunner`, or
> `Combinator<…>` **and call it**, unless that function is itself a value returned
> from `lower`. Decidable from the TS annotation plus a `CallExpression` whose callee
> is that identifier.

Protects `nextTerm` — the headline defect — and forbids its reintroduction.

**INV-7 (RESTATED) — CALLEE PROVENANCE. #3. Replaces "no parse-path array index".**

> Inside a piece-internal body, the callee of every `CallExpression` must be
> **either** (a) an identifier bound by a `const` in an enclosing *lowering* scope
> (inside `lower`, outside the returned closure), **or** (b) an imported module-level
> function. A callee that is a computed member expression (`kids[i]`, `arms[i]`,
> `runners[i]`, `matchFn[i]`, `scans[si]`), a parameter, or an assembly-scope mutable
> slot (`SCAN`, `COV`, `HOST`) is a finding.

The original form — "no computed member expression on a `Piece[]`-typed binding" —
**leaks and is noisy in both directions**:

- it **misses** `skipTrivia`'s `s(input, cur)` at `:463` (the `SCAN` slot — *no index
  at all*, and one FunctionLiteral's call site seeing every `FastTriviaScanner` in
  the process), `link`'s cycle stub `target!(…)` at `:639` (*no index at all*, one
  FunctionLiteral for every recursive rule in the process), and `scans[si]` at `:963`
  (typed `Combinator<unknown>[]`, **not** `Piece[]`);
- it would **fire on** `ascii[c]`, `mask[c]`, `hi[i]`, `starts[mid]`, `strs[i]`,
  `clss[i]`, `armFx[j]`, `syncs[i]`, `routed[arm]` — every one a scalar or typed-array
  load that V8 handles for free and that this design **wants**. That is exactly the
  noise profile that left `INV-6` untightened in the first place;
- and as a *type*-keyed rule it is fragile: rename the type and it stops firing. The
  checker uses `oxc-parser` with **no type checker** (`check-invariants.mjs:205`), so
  "`Piece[]`-typed" is not even decidable.

`COV` is a **deliberate allowlisted exception** — `assemble.ts:509` argues it
correctly: one slot, one `begin` write, no shape variation. Allowlist it with that
sentence.

**INV-6d — `isPiece` BY `ctx`, NOT BY ARITY. #4.**

> Replace `if (!p || p.length !== 3) return false` with: a function is
> **piece-internal** iff its parameter list contains an identifier named `ctx` or
> `_ctx`. **No arity constraint, no ordering constraint, and `FunctionDeclaration`
> admitted.**

Rationale in one line: *the piece signature's `ctx` is what makes a body
piece-internal; arity is not.* Catches `nextTerm(child, input, cur, ctx)` **and**
`runTerms(input, pos, ctx, values)` / `runSyncTerms` / `runAdjTerms`, which the
originally proposed trailing-`(input, pos|cur, ctx)` suffix rule **misses** (§0.5,
hole 2). Note that admitting `FunctionDeclaration` — not the arity — is what makes
`nextTerm:526` and `skipTrivia:458` visible at all.

**INV-6b — CONFIG FIELD LIST. #5.**

> `CONFIG_FIELDS = { trackLines, build, _probe, _tolerant, _errors }`.

**`trivia`, `triviaKindLabels`, `_triviaLog`, `_rootTriviaLog` and `captureTrivia`
are deliberately NOT here** — see INV-6c and §5.3.

**INV-6c — REGION FIELDS: READS ARE FINDINGS, WRITES ARE NOT. #6.**

> `REGION_FIELDS = { trivia, triviaKindLabels, _triviaLog, _rootTriviaLog,
> captureTrivia }`. A **read** of one of these inside a piece-internal body is a
> finding whose message names the site-label mechanism as the fix. An **assignment
> target** is not a finding. Decision procedure: collect `AssignmentExpression.left`
> nodes first; skip any member expression identical to one.

This is the rule that keeps the gate quiet on `OP_SCOPE`'s and `OP_TOKEN`'s
legitimate save/restore (`assemble.ts:1009, 1014, 1019, 1025, 1029, 1032, 1153, 1161,
1176`) — 16 sites of pure noise — while still firing on `nextTerm:526`,
`OP_REP:1922`/`:2009`, `OP_NODE:2231` and §0.6's read chain. **It is also the rule
that would have caught §2.1's unsound `triviaCapture` bit**, by refusing to let
`_triviaLog` join `CONFIG_FIELDS`.

**INV-9 — ALLOCATION ON THE TERM PATH. #7. Reporting-only, lower confidence.**

> An `ObjectExpression`, `ArrayExpression`, or `ArrowFunctionExpression` evaluated
> inside a piece-internal body in a module in the INV-6a set, where the body is
> reachable per-term. Report, do not fail.

"Reachable per-term" is not syntactically decidable without a call graph, so seed it
with a declared hot-function list (`nextTerm`, `skipTrivia`, `scanTrivia`,
`advanceTrivia`, `markCst`, the `OP_SEQ`/`OP_REP` bodies). **It is the only rule that
would have caught §0.6's `scanTrivia` cost** — the largest single finding in any of
the three reviews, which no option-test rule and no dispatch rule can see. Worth
building at reporting-only strength for that reason alone.

**Not proposed:** a rule about `END`/`TERMV` Context-cell stores (§0.4.3). Real, but
it is a property of `assemble.ts` existing at all, U4 removes it wholesale, and a gate
for it would fire on every piece and be switched off within a week.

A reviewer handed a unit and asked "does this pass" runs these three, then asks, for
every remaining `ctx.` read inside a piece, *when can this field change*. **An answer
of "never during a parse" is a FAIL, not a justification.** The `RunCfg` doc comments
(`assemble.ts:198-235`) are the model for a correct answer.

### 5.2 What `CONFIG_FIELDS` must contain — audited against `ParseContext`

`createParseContext()` (`src/parse-context.ts:42-77`) is the canonical literal and
lists 33 fields in declaration order. Partitioned by **when the field can change**:

**REVISED — the original table put five region fields in the CONFIG column. Three
of them are provably not config, and adding them would have made the gate unable to go
green without an exemption the design forbids.**

**CONFIG — fixed before the parse, belongs in `CONFIG_FIELDS` (INV-6b):**

| field | fixed by |
|---|---|
| `trackLines` | run options — **already in the list, and already violated 10× outside `assemble.ts`** (§0.5, hole 1) |
| `build` | run options (the host) — already in the list |
| `_tolerant` | `parseWithErrors` / `completionsAt` — argued per-parse-fixed at `assemble.ts:198-216` |
| `_probe` | IDE/recovery entry — doc paragraph must name the `recovery/scan.ts:29/40` sentinel window |
| `_errors` | **ADDED (law review O11).** Written only by `run.ts:391`, `compile.ts:224` before the parse, and the same `recovery/scan.ts:29/40` sentinel window. **14 reads** in the mark protocol; `nextTerm` alone reaches them >200,000×/parse. Only *presence* is consulted, so a `begin`-latched boolean is cheaper still than a bit. |
| `_grammarCoverage` | `createGrammarInstrumentationContext` — argued per-parse-fixed at `:217-235` |
| `_grammarTrace` | instrumentation entry |

**REGION — option-derived but swapped mid-parse. `REGION_FIELDS` (INV-6c), NOT
`CONFIG_FIELDS`. Reads are findings; writes are not.**

| field | swapped by |
|---|---|
| `trivia` | `OP_SCOPE` (`:1014, 1019, 1029, 1161, 1176`) — see §5.3 |
| `_triviaLog`, `_rootTriviaLog` | `OP_TOKEN` (`:1168-1169`, restored `:1183-1184`), `OP_LEAF` (`:1209`, restored `:1220`) — **this is what makes a `triviaCapture` bit unsound (§2.1)** |
| `captureTrivia` | `OP_SCOPE_CAP` (`:1016`/`:1018`) and **`OP_NODE` on every node** (`:2218`/`:2243`) — per-node, the class `RunCfg` rejects at `:212-214` |
| `triviaKindLabels` | travels with `trivia` |
| `_rootTriviaCapture` | opaque scope, `try/finally` (`codegen.ts:4747-4751`) — a §2.4 site attribute |

**UNVERIFIED, and U0 must settle them before the list is enforced:** `scanSkip` and
`_triviaCaptureMask` were classified as option-derived on the strength of where they
are *set*, not by an exhaustive writer search. See §9.8 — this is unchanged and still
owed.

**RUNTIME — varies during a parse, must stay OUT of the list.** Adding any of these
would be a *correctness* error, not merely over-strict: `state`, `_errors`, `_sync`,
`_rec`, `_fe`, `_fx`, `_fc`, `_cstChildren`, `_cstLeaves`, `_cstRawChildren`,
`_triviaLog`, `_rootTriviaLog`, `_rootTriviaKindIndex`, `_rootTriviaStrictScopes`,
`_rootTriviaCapture`, `_cstTriviaLog`, `_fields`, `_cstBuf`, `_routed`, `_lineStarts`,
`_lineIndex`, `_lineScannedTo`.

**Note the trap in the coordinator's suggested list:** `_errors` is a **sink**, not an
option — `node()` and recovery append to it mid-parse, and `nextTerm` marks its length
for rollback (`assemble.ts:538`). It must **not** go in `CONFIG_FIELDS`. What *is* an
option is whether error recovery is enabled at all, and that is `_tolerant`. Coverage
likewise: `_grammarCoverage` the *field* is per-parse-fixed and belongs in the list;
the counter it holds is a value, which is why `assemble.ts:498-509` latches it into
`COV` at the boundary rather than reading it per piece.

**Two of these are `_`-prefixed and one is not**, so the checker must key on an
explicit list, not on a naming convention.

### 5.3 The one field that resists — `trivia`, and why it is a site label not a bit

`trivia` is option-derived but **not per-parse fixed**: `OP_SCOPE` swaps it mid-parse
(`assemble.ts:1014`, `:1019`, `:1029`, `:1161`, `:1176`) because `rules({ trivia })`
is per-scope. So it cannot join `cfgKey`.

It still must not be *consulted* per term. §3.2's per-site label is how the criterion
is satisfied without a bit: the decision moves from the option set to the **site**,
which is strictly stronger — resolved at encode time, before resolution even runs.

**CORRECTED (predictions review finding 4, law review §2.1).** The original draft
concluded from this that *"putting `trivia` in `CONFIG_FIELDS` is therefore correct
and achievable"* — while §2.1 of the same document proves it is per-scope runtime
state. **That is self-contradictory and it would have shipped a checker that cannot go
green.** `INV-6` fires on member *expressions*, writes included, so adding `trivia`
produces **12 findings**, six of which are the `ctx.trivia = …` restores in the scope
pieces (`assemble.ts:1008-1033, 1152-1177, 2208-2243`) — **correct code**. §8 forbids
exemptions (*"a unit that needs an exemption is a unit that has misunderstood the
design"*), so the unit would have deadlocked against the document's own gate.

`trivia` goes in **`REGION_FIELDS` under INV-6c**, where a read is a finding and a
write is not. That catches `nextTerm:526` — the site the rule exists for — plus
`OP_REP:1922`/`:2009` and `OP_NODE:2231`, and leaves the scope pieces alone.

**The same treatment, for the same reason, now covers `_triviaLog`/`_rootTriviaLog`**
(`OP_TOKEN`/`OP_LEAF` boundaries) — see §2.1. The site label is **two axes, not one**.

### 5.4 The exception list — one entry, declared

A criterion with no declared exceptions and three undeclared ones is worse than one
with a documented exception list. There is exactly one construct I cannot resolve at
run start:

**`OP_LIVE` — the interpreter fallback.** `encode.ts:1035-1043` (a `ref()` used before
`.define()`) and `:1205-1207` (a hand-written combinator run through its own `.parse`).
Both delegate to a combinator the table never saw, so its internal option consulting is
outside this design's reach entirely. **Declared exception**, and it is a narrow one:
`encode.ts:1208-1213` deliberately refuses to widen anything else into `OP_LIVE`
(*"silently running it live would trade a build error for a permanent slow path nobody
would ever find"*), and the workloads carry 0–4 such rows, `json/document` zero.

**`OP_GUARD` (`ops.ts:224`) and `OP_ARMGATE` (`ops.ts:332`) are in the same class**
and were missing from this list. `ops.ts:329-331`: *"The predicate is a live function,
like `OP_GUARD`'s, so a grammar using one is **runtime-only for `emitTableModule`
unless `fnSources` are supplied**."*

### 5.4.1 — These three opcodes silently BLOCK U4, and the discriminator hides it

**NEW (coverage review §4.2).** U4 is "the per-grammar artifact becomes generated
wiring". For any grammar containing one of these three rows, **there is no artifact to
generate.** `ops.ts:351-354`: *"a live combinator is not data, so a program holding one
is `runtimeOnly` — it runs, and `emitTableModule` **refuses to print it BY NAME**.
Codegen degrades identically (a non-empty `runtimeParsers` makes `inlineExpression`
null)."* Confirmed on the archive side: `emitRuntimeFallback` (`codegen.ts:4305`)
emits `_rp[i].parse(...)` and its presence disqualifies the artifact from inlining and
linking (`codegen.ts:5501`, `:6074`).

**`json/document` has zero `OP_LIVE` rows — so the workload driving every prediction
in §6 is the one workload that cannot surface the gap.**

**U4 must state a degradation policy, and this design's own `link` supplies a better
one than codegen's.** Codegen disabled the *whole* artifact; do not copy that.
Instead: **`link` resolves a live row to a bound interpreter piece, exactly as it
resolves any other binding, and the emitted module takes those combinators as a
constructor parameter rather than printing them.** The grammar still emits; only the
live rows stay closures. Cost: one parameter per module. This unblocks U4 for every
real-world grammar containing a `gate()` — which per `ops.ts:220-222` is a documented,
used API surface.

**Everything else must resolve.** If a later unit finds a second construct that cannot,
that is a finding to write down here with its reason — not something to absorb
silently into a piece body.

---

## 6. Staging — RESTAGED after review

Ordered by evidence gained ÷ cost. None of these is measured. **Three of the original
five units were aimed at code that cannot produce their predictions**; each carries its
correction inline.

Discriminator is `json/document` throughout except where stated. **REVISED unit of
measure:** the original said "138 code rows". **138 is `prog.code.length` in Int32
WORDS.** The reachable instruction **row count is 28** (css: 885 words / **154 rows**,
165 assembly sites incl. scan subtrees). This document's own argument turns on
separating *sites* from *row executions*, so conflating the two in the sentence that
introduces the discriminator was a real hazard — for U4 in particular, where "one
binding per node" against 138 rather than 28 **overestimates the artifact by 4.9×**.

Baseline for size claims: `bench/size-baseline.json` — `example/json` 1,336 B,
`example/css` 9,229 B, ceiling 10, `ratchetSlackPct` 0.1. Note `size-guard.ts:263,
545, 637-640`: the true tolerance on json is **±1 B**.

### 6.0 The workload facts every prediction below is now derived from

Row-execution counts, one parse of the exact workload input, `PM_TABLE_COUNT=1`, **no
timing**:

```
json/document    60,323 B  totalRows=46,393  gatedEntries=4,204  ungatedEntries=0     ungatedFails=0
  LIT:19966  SEQX:12611  RX:6005  CHOICE:4204  XFORM:1502  REP:1052  OPT:1052  SCOPE:1
graphql/document 49,762 B  totalRows=53,706  gatedEntries=336    ungatedEntries=3,752 ungatedFails=952
  SEQX:14784 LIT:12096 OPT:10304 RX:8232 CHOICE:3976 REP:3641 XFORM:504 SEQ:168 SCOPE:1
```

json: **LIT 43.0%, RX 12.9%, SEQX 27.2%.** Of 19,966 literal executions, **19,516
(97.7%) are single-character**. These reconcile exactly with a census of the input, so
the model is derived rather than estimated. **Zero of the ~72 literals across
`examples/{json,css,graphql}` exceed 16 characters** — every one takes the `startsWith`
builtin where codegen took 1–9 inline `charCodeAt` compares.

**One asymmetry the original draft did not know about.** json's input contains
effectively **zero structural whitespace** (`JSON.stringify` output; its 1,350
whitespace chars are all inside string values). graphql is **40.3% whitespace**. The
two capture-off workloads treated as a matched pair **are not matched on the trivia
axis at all** — which is what makes graphql the right control for U2 and U3b.

### 6.2 The percentages are RESIDUAL-ORDERED, and the plan now says so

**NEW — the original draft quoted every unit as "% of the +137%" while U4 was
explicitly "the remaining". Those are not the same kind of number.**

> **RESTATEMENT RULE. Every percentage in §6 is a share of the excess REMAINING when
> that unit lands in the stated order. They are residual, not independent. Reordering
> the units invalidates the arithmetic and the new order's numbers must be re-derived
> before anything is measured against them.**

Three concrete dependencies:

1. **U4 SUBSUMES U1.** Both act on the same 19,966 literal executions: U1 removes the
   `startsWith` inside the leaf body; U4 removes the megamorphic call *to* that leaf
   and (per §2.3) pastes the leaf body into its parent. In the stated order the
   arithmetic holds. **If U4 moves earlier, U1's 10–30% collapses to near zero.**
2. **U2's "one fewer call frame" is in both budgets** — it is the same frame U4
   removes. ~18,000 × 1–2 ns ≈ 2%.
3. **The `alwaysConsumes` mark elision is in both U2 and U4** for the same
   statically-decided reason.

**And the css/less column, which the original draft did not account at all.** It
budgeted U2 200–400 + U3 150–300 = **350–700 points against a 500–835 regression** — at
the low end **150 points with no owner** — while crediting neither U1 nor U4 with any
css/less effect, although css/less execute the same `OP_LIT`/`OP_RX` bodies and the
same megamorphic dispatch. The correct statement:

> **css/less budget = the json-floor defects (U1 + U4, ≈137 points, since css/less pay
> them too) + the trivia defects (U3a, the balance).** This closes the arithmetic and
> it correctly predicts that the two terms are separable — which is §0.6's whole model.

### 6.3 One load-bearing number in this plan has NO provenance

`RELEASE-0.48-TARGET.md:80` — *"48 ns per piece invocation against codegen's ~28 ns
for the same logical work. That is ~20 ns of *work* per piece, not call overhead …
Nobody has located it."*

**No fixture, no commit, no harness is named for it anywhere.** It is not on §2's
retired-interpreter list, so it is not disqualified — but it is an unattributed number,
and **U4's largest prediction leans on it**. §0.3's Test D supplies a *mechanism* for
the missing ~20 ns (the callee body not being inlined, plus the `END` Context-cell
store) which is the best available explanation. **The figure itself must be re-derived
with a named fixture and harness, or dropped.** Until then it is marked UNSOURCED
wherever it appears and no unit's go/no-go may rest on it alone.

### 6.1 Compliance with the PURPOSE criterion — honest, and mostly partial

**Any consulting of options at parse time, per rule or per combinator, is a FAIL.**
Walking each unit against it. "Amortises" means the decision is made cheaper but is
still on the parse path — a legitimate intermediate step, labelled as one.

**REVISED for the re-aimed units. Still only one unit reaches a pass.**

| after this unit | still consults an option on the parse path? | what remains |
|---|---|---|
| **D0 / D1 / D2** | **YES — unchanged.** Diagnostics change no parse path. | Everything. Their value is that they bound U1 and U4 before either is funded. |
| **G1** (corpus gate) | **YES — unchanged.** A harness fix. | Everything. It is a *prerequisite*, not a step. |
| **U0′** | **YES — unchanged.** U0′ changes no parse path. | Everything. U0′ makes the violations *visible*, which is its whole value — and per §0.5 it now makes **36 more of them** visible than the original scope would have. |
| **U1′** | **YES — PARTIAL PASS, and smaller than claimed.** Removes 7 `_probe` consults (6 leaf-failure + `OP_GATE:803`) and `OP_GATE`'s already-a-`RunCfg`-field `_tolerant` read. | `nextTerm`'s `ctx.trivia` per term; `skipTrivia`'s capture test per term; `cstCaptureActive` per leaf; `forCtx` per rule entry; **10 `trackLines` reads outside `assemble.ts`**. The literal-length half of U1′ is **not** a criterion improvement at all — it is a work reduction. |
| **U2′** | **YES — PARTIAL PASS, largest pre-U4 step.** Removes the per-term `trivia` consult and the per-region `_triviaLog` consult (both by site label — **not** by a `RunCfg` bit, §2.1), the mark/rollback block wherever `alwaysConsumes` is statically true, `_errors`'s 14 reads, and `OP_NODE`'s host property loads. | `cstCaptureActive` per leaf; `forCtx` per rule entry. |
| **U3a** | **PARTIAL PASS on the css/less path only.** The capture tail moves inside the scan loop, so the per-term capture consults go; `_rootTriviaKindIndex[label]` resolves to a constant at `link`. | Everything on the non-trivia path. |
| **U3b** | **NO CHANGE to compliance.** Pure work reduction — regex-engine entry replaced by a scan. | Same as after U3a. Do not let its json number read as progress against the criterion; it is orthogonal. |
| **U4** | **PASS, and it is still the only unit that reaches it.** Bindings are emitted names resolved once per run; `forCtx`'s per-rule-entry resolve is replaced by binding at emit/startup; no array index survives (`INV-7`, restated as callee provenance, goes from reporting-only to enforcing). | Only the §5.4 exceptions — now **three** opcodes (`OP_LIVE`, `OP_GUARD`, `OP_ARMGATE`), and only under §5.4.1's bound-interpreter-piece policy. |
| **U5** | **Completes the leaf half.** AST-host capture elision removes the last `cstCaptureActive` consults on the AST assembly. | Only the §5.4 exceptions. |

**Four things this table makes visible that the prose did not:**

1. **No unit before U4 satisfies the criterion.** Everything earlier is amortisation
   and work reduction. They are worth landing — they are cheap, independently
   valuable, and they shrink U4 — but none is "done" in the criterion's terms.
2. **`AssemblyCache.forCtx` survives every unit until U4.** It is the resolve step
   that most looks solved (cached, allocation-free, its own comment defends it) and it
   is the last one standing.
3. **U1′'s headline half is not compliance work**, and the half that *is* compliance
   work is worth ≈0.05% (§0.4). Two different axes of goodness; the staging is ordered
   by measurement value, not by compliance, and the document must not let the ordering
   imply an answer to the compliance question.
4. **REVISED — U4's pass is now conditional on §5.4.1.** For any grammar carrying an
   `OP_LIVE`/`OP_GUARD`/`OP_ARMGATE` row there is no artifact to emit at all unless
   `link` binds those rows to interpreter pieces. json has zero such rows, which is
   exactly why the discriminator hid this.

---

### D0 — Run the §9.1 inlining trace. *Before anything, including U1′. Hours, no timing.*

**PROMOTED to first position (predictions review §7).** `--trace-turbo-inlining` /
`--trace-ic` on `json/document`, looking at (a) whether `k0(…)` inside the arity-2
piece reports megamorphic, and (b) whether `String.prototype.startsWith` is reduced at
the `OP_LIT` site. **One run bounds both U1′ and U4 — the two largest terms in the
plan.** The original draft called this "the highest-value single check in this
document" and then scheduled it before U4 rather than before the plan.

**Status: PARTLY DISCHARGED.** The law review executed the equivalent on minimal
programs and confirmed both the FeedbackVector sharing and the inlining block (§0.3,
Tests A/C/D). What remains is (b), and the same run on the *real* json workload rather
than a reproduction.

**Branch condition, decided now rather than after.** If D0 confirms megamorphism,
**U4 moves up** — it is 50–75% of the json budget, priority 1 is speed, and U1′/U2′
reduce the emitter's surface but are not prerequisites for measuring it. If D0 refutes
it, **U3b and U2′ absorb the budget and the residual diagnosis restarts from a
profile.** The original draft's contingency was "say so loudly", which is the right
instinct and not a plan.

---

### D1 — `fastTriviaScanner` null check. **DISCHARGED.**

Executed in two reviews: **null for css, null for `bench/workloads/less.ts`, non-null
for json and graphql.** §9.3 is closed. Combined with `_triviaLog: []` on the css/less
workloads (§0.6), **U3-as-originally-scoped was retired before a line was written** —
which is precisely what a zero-cost falsification is for.

---

### D2 — Count allocations; do not time them. *The cheapest discriminator not in the original plan.*

**NEW (predictions review §7).** `node --trace-gc` (or `bench/alloc-count.ts`'s
scavenge counter) over one parse of `css/stylesheet` at HEAD and at `a5dc9bd`,
materialised by `bench/ab-harness.ts:214-256`. **Counting scavenges is not timing** —
it is deterministic to the allocation — and it settles §9.2, the softest number in the
document, directly. It would also have caught the "two allocations" error (§0.6: the
real figure is ≥5 plus a full `ParseContext`). Run it before committing to any
css/less magnitude.

**Coordination note:** `lane/triviacost` owns the box. D2 is the lane's to run or to
hand back.

---

### G1 — Point the corpus identity gate at the shipping engine. **PREREQUISITE for U1′. IN FLIGHT on `lane/triviacost`.**

**RAISED from "extend it" to a hard prerequisite (law review §1.3, §8).**
`bench/table-lowering-identity.ts:19` imports `tableRules` from **`../src/table/exec.ts`**
— the bytecode interpreter — while `src/table/index.ts:28` ships
`assembledRules as tableRules`. **The ~2,800-file corpus identity sweep therefore never
executes `assemble.ts`.** Verified in this tree.

Every specialised leaf body this design adds would be gated by a harness that does not
run the engine the body is added to. **U1′ adds four literal bodies whose entire risk
is a changed `expected` set.** This is not a U2-onward concern; it gates the first
substantive unit.

Also owed an owner ruling, noted not resolved: `exec.ts` reaches production through
`src/table/fold.ts:1` and `src/compiler/linker.ts:24` — whether `fold.ts` may put the
interpreter on a shipped path.

---

### U0′ — Tighten the invariant checker. *Land after G1, alone, in reporting-only mode.*

**Change — REVISED on three counts (§5.1).** `CONFIG_FIELDS` becomes
`{ trackLines, build, _probe, _tolerant, _errors }` (INV-6b) — **`trivia` is NOT added**.
`REGION_FIELDS` becomes a distinct rule where reads are findings and writes are not
(INV-6c). `isPiece` matches on **any parameter named `ctx`, arity- and order-free, with
`FunctionDeclaration` admitted** (INV-6d). `ASSEMBLER` becomes a **parse-path module
set** (INV-6a) — the largest change and the one requiring no new rule semantics. `INV-7`
lands **restated as callee provenance**, reporting-only. `INV-8` (piece-as-parameter) and
`INV-9` (allocation on the term path, reporting-only) are new. Record the §5.4/§5.4.1
exceptions.

**Sequencing constraint, not a test problem (law review §6).**
`check-invariants.mjs:667` makes a **stale allowlist entry a hard failure**. Landing the
extended field list without either fixing the sites or adding entries turns the gate red
immediately. **The field-list extension needs reporting-only mode too**, not just
`INV-7` — the original draft said it for one and not the other.

**Hypothesis.** The checker currently green-lights the defects this design exists to
remove; making it red is how every later unit gets checked for free. **This unit is the
specification of the PURPOSE criterion in executable form.**

**PREDICTED effect — REVISED, and the two reviews report different numbers because they
used different scopes. Both are printed; neither is picked.**

| scope | `_probe` | `_tolerant` | `trivia` | total | source |
|---|---|---|---|---|---|
| original draft's prediction | ~6 | — | 1 | **~7** | as written |
| `assemble.ts` only, with `trivia` wrongly added | 7 | 3 | 12 | **22** | predictions review (simulated tightened run) |
| `assemble.ts` only, `trivia` correctly excluded | 7 | 3 | (+1 via INV-6c) | **11** | predictions review, revised |
| **parse-path module set (INV-6a)** | 9 | — | — | **57 config reads** | law review, `inv6x.mjs` |

**The original ~7 was wrong in every scope.** The 22 figure is what the *original spec*
would have produced — including six `ctx.trivia = …` restores in the scope pieces that
are **correct code**, which is why `trivia` moves to INV-6c. And note that **the one site
U0 exists to catch — `nextTerm:526` — is not in the 22 at all**, because `isPiece` rejects
`FunctionDeclaration`.

`INV-7` reporting-only: **5** genuinely dynamic `Piece[]` sites under the original
type-keyed form (`assemble.ts:1627, 1716, 1734, 1760, 2135`) — the original "~9" was
right by two cancelling errors (`runners[i]` at `:1351`/`:1418` sit in 4-param functions
the suffix test rejects; four of the nine that qualify are `kids[0]`, a constant index).
Under the **restated callee-provenance form** the population is larger and different: it
adds `s(…)` at `:463`, `target!(…)` at `:639`, `scans[si]` at `:963`, and it drops the
`ascii[c]`/`mask[c]`/`starts[mid]` noise the syntactic form would have generated.

**Acceptance criterion: the checker emits a count and the count is written down.** It is
NOT "the count matches a prediction" — three predictions disagree and the checker is the
arbiter.

**Measurement.** `node scripts/check-invariants.mjs`. No timing run.

**Cost.** Hours. **Evidence/cost: highest in the list.**

---

### U1′ — Length-keyed literal bodies. *(`_probe` demoted; `OP_GATE` and leaf capture elision added.)*

**Change.** `OP_LIT`/`OP_LIT_TRACK`/`OP_LIT_CI` select among four bodies by literal
length, per `emitLit`'s `CHARCODE_CHAIN_MAX = 16` pivot. Still inside `assemble.ts` —
this unit does **not** require emitted source.

**Three additions and one demotion, all from review:**

- **DEMOTED — `_probe` → `RunCfg`.** Keep it: it is nearly free and it is what makes
  `OP_GATE:803` fixable. But its predicted contribution drops from 5% to **≈0.05%**,
  because all six leaf sites are on the **failure** path (§0.4).
- **ADDED — `OP_GATE:803`.** Select at `link`: `if (cfg.tolerant || cfg.probe) return
  child`. The gate is already a no-op under both, so those assemblies drop the closure
  **and its call frame**; the strict assembly gets a body that is one `classHas`. This
  removes a **success-path** read of `_tolerant`, **already a `RunCfg` field** — a live
  `INV-6` violation, i.e. a bug fix rather than a feature. css has 13 `GATE` rows, less
  22, json none.
- **ADDED — leaf-only capture elision** (predictions review §2 U1). `cstCaptureActive(ctx)`
  runs on **every successful leaf**: 19,966 + 6,005 = **25,971 cross-module calls per
  json parse**, on a `withoutCapture` workload where it can only return false. §3.4
  defers capture elision to U5 because a *site-reachability* analysis can silently drop
  CST children — **but for a leaf that risk does not exist**: a leaf has no children to
  drop, and `RunCfg.hostCst` already exists. If `hostCst === false` alone is sufficient
  (this needs the same one-paragraph justification `RunCfg` demands of every field),
  the leaf-only form belongs here: same opcode family, same test surface, no
  reachability analysis, and it acts on 26k executions rather than 20k.
- **ADDED — `_errors` latch.** A `begin`-latched boolean removes 14 mark-protocol reads
  that `nextTerm` alone reaches >200,000×/parse. Cheap and adjacent.

**Hypothesis.** json's literals are 1–5 chars and its parse is literal-dominated. It
pays a `startsWith` builtin call per literal where codegen paid one to five inline
integer compares.

**PREDICTED — REVISED to 10–30% of json/document's +137%, essentially ALL of it from
the literal bodies.** 19,516 single-char `startsWith` per parse.
`String.prototype.startsWith` is a CSA builtin with **no general `JSCallReducer`
inlining path** (unlike `charCodeAt`, which lowers to a byte load); it pays argument
adaptation, receiver and searchString `ToString` checks, position clamping, then the
compare. Against an inlined `charCodeAt(p) !== 123` that is a realistic **7–23 ns**:

| delta | saved | share of the json excess |
|---|---|---|
| 7 ns | 137 µs | **11%** |
| 15 ns | 293 µs | **23%** |
| 23 ns | 449 µs | **35%** |

So the original headline range was roughly right **for the wrong reason**, and its
internal apportionment (20% literals + 5% `_probe`) was wrong.

**Kill threshold — RESTATED, because the original was set inside the noise of its own
mechanism.** The original said "kills the hypothesis if json moves less than 10%" —
but **11% is the low end of the mechanism working correctly**, so a genuine small win
would have been read as a kill. Revised:

> **<5% kills the leaf-work model. 5–12% is AMBIGUOUS and must not be read as a kill.
> \>12% confirms it.**

**Size.** Zero — no per-grammar bytes change; the bodies live in the runtime.

**Cost.** Small. Self-contained. **Still the first substantive unit** — see §7.

**Prerequisite: G1.** Four new literal bodies whose whole risk is a changed `expected`
set, against a corpus gate that does not currently run the engine they land in.

---

### U2′ — Inline `nextTerm` away: per-position term bodies, trivia and logging decided at the site.

**Change — REVISED.** The per-site **attribute record** (§2.4, §3.2) lands in the
encoder, on `OP_SEQ`/`OP_SEQV`/`OP_SEQX`/`OP_REP`/`OP_REPV` **and
`OP_NODE`/`OP_NODE_TRACK`**. `nextTerm` disappears as a shared helper; each unrolled
arity body inlines the term body at each position, in the variant the site's **two**
label axes select (trivia-in-scope × `_triviaLog`-presence-in-region) — **four variants
per position, not two, and NOT a `triviaCapture` `RunCfg` bit, which §2.1 shows is
unsound.** The `alwaysConsumes` selection removes the mark/rollback block wherever the
child cannot match empty. `_errors` and `OP_NODE`'s host property loads are latched in
`begin` (§3.2). **The trivia label's enum needs room for `OP_ADJ`'s
adjacency-checked value (§2.4) and 8b.1's stream-pre-classified value.**

**`skipTrivia` must be dissolved, not merely de-branched.** `assemble.ts:458` is a
module-level helper whose `s(input, cur)` at `:463` is **one FunctionLiteral's call
site seeing every `FastTriviaScanner` in the process** — structurally identical to
`nextTerm`'s defect, for scanners. If `skipTrivia` survives as a shared helper, U2′
removes the branch and keeps the megamorphism.

**Hypothesis — REVISED. The original stated cause for json was wrong; the prediction
was right anyway.** The mass in `nextTerm` on a `withoutCapture` parse is not the
removed `ctx.trivia` branch. It is **`markCst` (`:395-425`), which loads eight `ctx`
fields and returns false**, then four `need ?` ternaries, then `skipTrivia`'s three
further `ctx` loads plus a call to a `SCAN` that on json **scans zero characters**
because the input has no structural whitespace (§6.0). At ~18,000 non-first terms and
~10–15 ns of protocol each that is **160–270 µs = 12–21%**. `alwaysConsumes` —
statically true for every literal and every `min>=1` regex, i.e. most json terms — is
what removes the eight loads, with direct codegen precedent (`rewindable` gating in
archived `emitSeqValues`). **Keep the number; replace the reasoning.**

**PREDICTED — REVISED:**
- **json/document: 12–21%** of the +137%. (Was 10–20%; magnitude essentially
  confirmed, mechanism replaced.) No large monomorphism win is claimed here — per
  §0.3, inside `assemble.ts` the call site does not become monomorphic, it only
  disappears.
- **css/less STANDALONE: 40–150 points, not 200–400.** **The original mechanism does
  not exist.** U2′'s stated css/less lever was *"the capture tail moves into the scan
  loop, killing the `{end, commit}` object"* — but **there is no scan loop for css/less
  to move it into**: `buildFastTriviaScanner` returns null for both grammars, and even
  if it did not, `_triviaLog: []` bypasses it (§0.6). Without U3a, U2′ delivers only
  the `alwaysConsumes` mark elision and **2 of the ≥5 allocations per term**. The
  detached `ParseContext`, the `ParseResult`, and the full `oneOrMore(choice(…))`
  interpreter re-entry at `trivia-skip.ts:239` **all survive U2′ untouched — and those
  are the expensive part.**

**This is a SEQUENCING defect, not a magnitude error.** U2′ and U3a are one story on
css/less; see U3a, which merges them.

**Kills the hypothesis if:** json moves less than 5%. (The original threshold was
stated against css/less, which U2′ standalone can no longer be held to.)

**Size.** One extra packed operand per labelled row. PREDICTED `example/json` +40–80 B
(~3–6%), `example/css` +200–400 B (~2–4%). Both inside the ceiling of 10 but **outside
`ratchetSlackPct` 0.1** (true json tolerance ±1 B), so `size-guard` will fail and the
baseline must be re-cut with owner sign-off. Name it in the PR; do not smuggle it.
**The operand now buys six axes rather than one** (§2.4) at the same byte cost — say
so in the PR.

**Cost.** Medium — encoder analysis plus the body set.

---

### U3 was INVERTED IN BOTH DIRECTIONS and is split into U3a and U3b

**This is the most consequential correction in the document.** As originally written,
U3 was scoped to css/less, predicted "json essentially zero", and called that *"the
sharpest before/after prediction in the document"*. **Both halves are wrong, in
opposite directions**, and as specified U3 would have **consumed the largest budget in
the plan, measured ~0 on the rows it targets, and been read as falsifying §0.6's split
model — when the split model is right and only the unit boundary was wrong.**

- **css/less → 0, not 150–300 points.** The recogniser is null (confirmed), *and*
  `skipTrivia:461` requires `ctx._triviaLog === undefined`, *and* `scanTrivia:228`'s
  own fast guard requires `log === undefined` — and the css/less workloads set
  `_triviaLog: []`. **Restoring the recogniser makes a scanner exist that nothing on
  those workloads can reach.** A 1,627-line port measuring zero on the rows it was
  written for.
- **json → 10–25%, not zero.** json executes **6,005 `OP_RX` rows per parse (12.9% of
  all rows)** — 4,953 string-inner and 1,052 number matches — each doing
  `re.lastIndex = pos`, `re.exec(input)`, and **allocating a match array that is read
  once and discarded**. `emitShapeMatch`'s `alt` and `seq` variants are precisely what
  replaces that with an allocation-free char loop.
- And per §4.0, **the `classCond` constant-folding half has no mechanism before U4 at
  all** — as static pieces the nine bodies reproduce `inRanges`.

---

### U3a — The capturing trivia lowering. **THE ONLY WORK IN THE PLAN THAT TOUCHES +500–835%. IN FLIGHT on `lane/triviacost`.**

**Change.** Recognise only the shapes css/less actually need — `chars`, `altStar`,
**`prefixRun`** (for `bench/workloads/less.ts`'s `//` arm, which
`untilLineBreakScanner` at `trivia-skip.ts:411-422` cannot reach because it only ever
saw a *one-char* leader inside a `(?:…)*` group), and **`delimited`** (the block
comment) — and emit a scan loop **with the capture tail inside it**, selected by the
site's logging label. Both halves in one unit, because §0.6 shows neither works alone.

**Status.** `lane/triviacost` has `prefixRunSource`, `delimitedSource`,
`splitDelimArms` and `delimitedBodySound` in `src/combinators/trivia-skip.ts`, with the
soundness proof ported rather than re-derived, plus `parseClassOperand` /
`literalCodePoints` in `src/regex/classes.ts`. **Do not re-design this. Do not run a
benchmark against it — the lane owns the box.**

**Why this is the merge of "the useful half of U2 and the useful half of U3".** The
recogniser without the capture tail is unreachable; the capture tail without the
recogniser has no loop. Together they remove the **detached `ParseContext` +
`ParseResult` + `oneOrMore(choice(…))` interpreter re-entry** at
`trivia-skip.ts:239` — which §0.6 identifies as the largest single item in the largest
regression in the set, and which **no unit in the original plan owned**.

**It also disarms §9.7.** The four shapes it needs are the four least likely to be
superseded by token streaming.

**PREDICTED.** No number. The two reviews that examined this both declined to put one
on it, and the design's own precedent (`RELEASE:72-78`, the trivia scanner predicted
1.2–1.6 ms and worth −0.8 ms) says a profile overstates. What *is* claimed: **the
mechanism removed is an interpreted combinator parse per sequence term on a 64 KB
input, which is categorically larger than a scanner tuning.** D2 bounds it without
timing.

**Size.** Zero per-grammar bytes — recognisers live in the runtime.

**Cost.** Small fraction of 1,627 lines. **Evidence/cost: highest of the substantive
units, which is why it is already in flight.**

---

### U3b — `ScanShape` terminal bodies for `OP_RX`. *The json/graphql unit. After U4.*

**Change.** Port `parseScanShape` / `scanShapeFromRegex` and their soundness proofs
(`scannable-run.ts:1-1152`, ~71% proof) as an assembly-time classifier — **this half
is U4-independent, it is the expensive half, and it de-risks U4, so port it early
regardless of where the bodies land.** Then route `OP_RX` through `emitShapeMatch`,
preserving `scannable-terminal.ts`'s one-core invariant (terminal and trivia share one
match core so they can never disagree about an incomplete token).

**PREDICTED: 10–25% of the json excess** (6,005 executions × regex-engine entry + one
match-object allocation). graphql runs 8,232 and is the natural control.

**Placement — and the two reviews DISAGREE here; see §6.4.** The coverage review puts
the emitter half strictly after U4, because each shape's speed comes from
constant-folding ranges into *source* and a static piece must loop a `ranges` array
instead. The predictions review prices U3b at 10–25% standalone, on a mechanism that
does **not** require constant folding — a closure over ranges still beats entering the
regex engine and allocating a match array. **Both can be true**: a pre-U4 U3b captures
the regex-entry win and not the class-chain win. **The plan takes U3b after U4** so the
port is done once, and records that a pre-U4 U3b is a legitimate smaller unit if
schedule pressure demands it.

**Size.** Zero per-grammar bytes if the classifier runs at assembly; a `ScanShape` id
operand per `OP_RX` row if precomputed (§3.2 — recommended against).

**Cost.** Large. **This is where the archive saves the most work**, and — per §9.7 —
the unit most exposed to being partly redone if token streaming lands.

---

### U4 — Emitted source: a `prelude` of `_pf<N>` bindings and one `_r_<Name>` per rule.

**Change**, in the recovered vocabulary of §1.1. The per-grammar artifact grows a
`prelude` of namespaced hoisted `_pf<N>` bindings — one per node, resolved once at run
start — and one `_r_<Name>` per rule, the composition surface siblings call by name.
Composite bodies (sequence, choice, repetition, node) are **emitted per site** per
§1.2; scannable leaves may be library references. The emitted text lands in
`LinkableTable.replacement`, which already exists, and must carry the artifact version
stamp `v`. `kids`, `arms` and `runners` cease to exist on the parse path.

**This is the only unit that fully satisfies the purpose criterion** — see §6.1.

**Hypothesis.** §0.3 — inline-cache feedback is per-FunctionLiteral, so process-wide
megamorphism at every piece call site is unavoidable inside `assemble.ts` and can only
be fixed by emitting distinct sites.

**PREDICTED — REVISED UPWARD to the remaining 50–75% of json/document's +137%.** Once
U1′'s `_probe` component is corrected away, U1′ 10–30 + U2′ 12–21 leaves **50–75%** for
dispatch and the `END` Context-cell store, against the originally claimed 40–60. Under
speed-first priority **this is the largest term in the plan and the only unit that
addresses it.** Mechanism: a megamorphic call in V8 is a hash lookup in the megamorphic
stub cache with no inlining and no type feedback for the callee's body; §0.3's Test D
observed 20+ callee inlinings in the emitted shape against **zero** in the current
shape. Emitted bodies use SSA locals for `end` exactly as `codegen.ts:1424` did.

The "48 ns/piece against codegen's ~28 ns" figure is consistent with this and is
**UNSOURCED** — see §6.3. It may support the prediction; **it may not be the basis for
funding it.**

**U4 also kills a defect nothing else does:** `link`'s cycle stub at `assemble.ts:639`,
`const fwd: Piece = (input, pos, ctx) => target!(input, pos, ctx)` — **one
FunctionLiteral for every recursive rule in the process**, through which every
grammar's back-edges funnel. Under U4 the stub is unnecessary: emitted source hoists
`let _sN` and assigns after, so a back-edge is a direct binding reference with no
forwarding call. Name it as a U4 deliverable; it is invisible today because the *site*
count is small and the **sharing** is what costs.

**Blocked for some grammars until §5.4.1 lands.** `OP_LIVE`/`OP_GUARD`/`OP_ARMGATE`
make `emitTableModule` refuse to print the artifact by name. json has zero such rows,
so the discriminator hides it. `link` binding live rows to interpreter pieces, with the
module taking them as a parameter, is the policy — and it is strictly better than
codegen's whole-artifact disable.

**Kills the hypothesis if:** json moves less than 20% after U1′–U3a have landed. That
would mean the feedback-vector model is wrong **despite §0.3's trace**, and the
residual is somewhere nobody has looked — in which case say so loudly, because it
would be the third failed mechanism in a row for this gap and the diagnosis should be
restarted from a profile rather than a model. **D0 is what makes this a branch rather
than a discovery.**

**Size — REVISED, and the original range priced the wrong artifact.** Ground truth:

| | json | css |
|---|---|---|
| artifact today | 1,336 B | 9,229 B |
| `prog.code` **words** | 138 | 885 |
| **reachable rows / assembly sites** | **28** | **154 / 165** |
| **rules** | **1** | **1** |
| current cost per node | 47.7 B | 55.9 B |
| codegen | 15,138 B | 224,100 B |
| codegen per node | **541 B** | **1,358 B** |

Artifact composition (`src/table/emit.ts:174-185`) — what U4 can and cannot displace:
`c:` the code stream, **the only line U4 removes**, is 343 B (25.7%) json / 2,467 B
(26.7%) css; `e:` the expected-set pool **survives** at 348 B (26.0%) json / **3,601 B
(39.0%) css**.

**Four defects in the original estimate:**

1. **The stated model and the stated range disagreed.** "One ~25 B binding line plus
   one argument list per node" prices at **1,850–2,193 B** (json) and **11,831–14,298 B**
   (css) — *below* the predicted 2,200–3,000 and 16,000–24,000, css by 11–26%.
   Back-solving the ranges gives 31–89 B/node against a stated model of ~30 B/node.
   **The range was chosen first and the arithmetic attached after.**
2. **It priced the wrong artifact.** §0.3 requires a distinct FunctionLiteral per site
   and U4's own change text says "sequence bodies emitted per site". **A per-site
   emitted body is not a 25 B binding line.** The speed thesis needs bodies; the size
   thesis priced wiring.
3. **The claimed lever is inert** — one rule per fixture (§2.3).
4. **The ratio is directionally backwards.** Node ratio css/json = 165/28 = 5.89; byte
   ratio = 9,229/1,336 = 6.91. At any equal per-node cost, css must grow by a factor
   **1.17× smaller** than json's. The original gave css the larger factor at both ends.

**REVISED PREDICTION — this is the number to put in front of the owner:**

> **`example/json` 1,336 B → 4,000–8,000 B (3–6×). `example/css` 9,229 B →
> 40,000–110,000 B (4–12×).**

Derived as codegen's per-node cost minus what the table's pools still deduplicate —
chiefly the `e:` expected-set pool, which codegen re-listed as an array literal at
every failure site, plus the hoisted regex consts. Call that a 2–4× reduction against
codegen. Both remain **2–5× below codegen** and both stay under `ceiling: 10`
(`bytesRatio`: json 0.231 → ~0.7–1.4; css 0.950 → ~4.1–11.3 — **css's top end is the
only figure that touches the ceiling at all**).

**This is not an argument against U4.** Per the owner's priority, if the speed is real
the bytes are a named trade and the ratchet gets re-cut. The argument is that **a
ruling given on 16–24 KB and delivered at 80 KB stalls the unit mid-flight and reads as
a failure of the design rather than of the estimate.**

**The lever that actually bounds the bytes — the design owns the right tool and
mis-filed it.** `module-hoist.ts`'s use-count threshold, **inverted**: emit a distinct
FunctionLiteral per site only for sites whose **execution count** justifies one, and
leave cold sites on shared library pieces. Execution counts are obtainable with **zero
timing** — `bench/table-opcode-gaps.ts` with `PM_TABLE_COUNT=1` produced every number
in §6.0. For json, **43% of executions land on 11 `LIT` rows**; hot-site-only emission
captures most of the monomorphism win for a minority of the bytes, and it is
**decidable before the emitter is written.**

**One structural correction to §1's illustration.** It shows `_r1 = make(_s0, _s1, _s2,
_s3)` — one `make` per *rule*. With one rule per fixture, `make` would take 28 and 165
arguments and could not express a tree. **`make` is per-SITE, not per-rule.** Not fatal,
but §1 is the picture a reader sizes the unit from and it is not the artifact §6 prices.

**Cost.** Largest. Requires the emitter, and it changes what a shipped artifact is.

**Ordering note — REVISED.** U4 is where the biggest win is predicted. It is placed
after U1′/U2′/U3a because those are cheap, independently valuable, and *reduce the
size of U4*. **But per D0's branch condition, if the inlining trace confirms
megamorphism on the real workload, U4 moves up** — 50–75% of the budget under a
speed-first priority is not something to schedule behind three partial steps. U1′ and
U2′ reduce the emitter's surface; they are not prerequisites for measuring U4.

---

### U5 — Arity 4, AST-host capture elision (§3.4), `module-hoist` thresholds, the choice-strategy axis, `sharedPrefix` replay.

Deferred deliberately. Each is a modest win behind a correctness risk (the capture
elision especially — a wrong reachability analysis silently drops CST children, which
is exactly the failure class §8 is built to catch). PREDICTED: single-digit percent
each. Land them once the gates in §8 have proven themselves against U1′–U4.

**REVISED membership:**

- **The leaf-only half of capture elision is PROMOTED into U1′** — a leaf has no
  children to drop, so the analysis that carries the risk is not needed there.
- **ADDED — the choice-strategy axis (§2.5):** `OP_GREEDY`'s per-arm string-equality
  loop and its `input.slice()` allocation, and `OP_REJECT`'s per-arm array walk.
  Both sit on the css/less keyword path; `OP_REJECT` violates `INV-7`. +100–300 B on
  `example/css`.
- **ADDED — `sharedPrefix` replay (§8b.3),** which needs §2.4's `replaySlot` and the
  ported ownership/reset discipline.
- **ADDED — `OP_ATTEMPT` by placement (§2.4):** removes a redundant eight-sink
  save/restore under a choice parent.

---

### 6.4 Where the reviews disagree — printed, not resolved silently

| topic | position A | position B | how the plan proceeds |
|---|---|---|---|
| `_probe` member-expression count in `assemble.ts` | predictions: **7** (6 leaf-failure + `OP_GATE:803`) | law: **9** (`inv6x.mjs`, widened `isPiece` + widened module scope) | Not the same set. **U0′ produces the number**; neither is assumed. |
| `INV-6` finding count | predictions: **11** with `assemble.ts`-only scope and `trivia` excluded | law: **57 config reads** across the parse-path module set | Different scopes, not contradictory. The plan adopts law's **scope** (INV-6a) and predictions' **field list** (no `trivia`), so it expects a number **larger than 11**. Written down, not predicted. |
| `isPiece` fix | predictions: admit `FunctionDeclaration` | law: match on any parameter named `ctx`, arity- and order-free | **Law's is strictly stronger** and subsumes predictions'. Adopted as INV-6d. Predictions' point stands as the *diagnosis* — the arity was never the cause. |
| U3b before U4 | coverage: **no mechanism before U4** — the win is constant-folded ranges, which needs emitted source | predictions: **10–25% on json standalone** — the win is avoiding regex-engine entry and a match-array allocation, which a closure delivers | **Both can be true.** A pre-U4 U3b captures the regex-entry win and not the class-chain win. Plan takes U3b after U4; a smaller pre-U4 U3b is recorded as legitimate under schedule pressure. |
| U2′'s json magnitude | design/predictions: 12–21% | law: would rank it **higher**, because U2′ also removes `skipTrivia`'s megamorphic scanner call and the mark protocol's resolvable reads, which neither the design nor predictions counts | 12–21% kept as the number; law's extra mechanisms named in U2′'s change list so a *higher* result is not read as a surprise. **Both agree the ordering is U4 > U1′ ≳ U2′ for json.** |
| `triviaCapture` | coverage: one bit cannot cover a **3-valued `_cap` plus six presence flags** | law: one bit is **unsound** — `OP_TOKEN`/`OP_LEAF` clear `_triviaLog` mid-parse | **Compatible and both adopted.** §2.1 takes law's soundness argument for the region axis and coverage's `cap` arity for the `RunCfg` field. |

---

## 7. The one unit I would land first

**U1′ — after D0, G1 and U0′, none of which is a unit.**

**Two things must precede it and both are cheap.** **D0** (the inlining trace) bounds
U1′ and U4 in one run and costs no timing; per §0.3 it is already most of the way
discharged. **G1** (point the corpus identity gate at `assemble.ts` instead of
`exec.ts`) is a **hard prerequisite**, not a nicety: U1′ adds four literal bodies whose
entire risk is a changed `expected` set, against a ~2,800-file sweep that does not
currently execute the engine those bodies land in. It is in flight on
`lane/triviacost`.

**Then U1′.** Not because it is the biggest — U4 is, by a wider margin than the
original draft claimed (50–75%, revised up). Because it is the cheapest thing that
**discriminates between two live models of the json floor**: (a) per-leaf *work* —
`startsWith` where codegen had a compare; (b) *dispatch* — megamorphic piece calls and
`END` cell traffic, which only U4 fixes. They predict different outcomes for the same
small change, and U1′ costs a day.

The cross-workload arithmetic confirms it is a real discriminator rather than a
redundant one: json runs 331 LIT/KB and 769 rows/KB; graphql runs 243 LIT/KB and 1,079
rows/KB — **the two ratios point in opposite directions, yet both land in the same
+107…+138% band.** A two-term linear fit puts **65–85% of the excess on the
per-leaf-execution term** rather than on total rows. But that term contains *both* the
leaf body (U1′) *and* the megamorphic call into it (U4), so it cannot split them —
which is precisely the split U1′ exists to make.

**It is a ONE-SIDED discriminator, and that must be said.** A positive result confirms
leaf work. A **null result leaves U4's dispatch model and U2′'s per-term protocol
model entangled.** D0 splits them for free, which is the other reason D0 runs first.

It is also the unit where the archive is most clearly right and the tree most clearly
wrong: `emitLit`'s four-form length pivot is not a subtle optimisation, it is the
obvious thing, and the table simply does not do it. Even if model (b) dominates, U1′'s
change is correct on its own terms and stays.

**One honest caveat the original draft did not carry.** U1′ is no longer *fully*
self-contained: it now also carries `OP_GATE:803` (which touches css/less, where json
has zero `GATE` rows) and the leaf-only capture elision (which needs its own `RunCfg`
justification paragraph). Both are cheap and both are bug fixes against rules already
in force, but the unit is a little wider than "one opcode family".

**Said against the criterion rather than against the clock:** U1′ is a PARTIAL PASS
(§6.1) and its larger half is not compliance work at all, while its compliance half is
worth ≈0.05%. **If the question is "which unit should land first to satisfy the
purpose", the answer is not U1′ — it is U4, and nothing short of U4 reaches a pass.**
The ordering here is by evidence-per-cost because the +137% is unexplained and a cheap
discriminator is worth more right now than a partial step toward a criterion U4 will
satisfy wholesale. Those are two different questions and the document must not let the
ordering imply an answer to the second.

**And the one exception to that ordering, decided in advance:** if D0 confirms
megamorphism on the real workload, **U4 moves ahead of U2′ and U3b.** Priority 1 is
speed; 50–75% of the budget does not queue behind partial steps.

---

### 7.1 The revised staging table

| # | unit | status | json | css/less | size | notes |
|---|---|---|---|---|---|---|
| **D0** | inlining trace on the real workload | partly discharged (§0.3) | bounds U1′ **and** U4 | — | — | **runs before anything is funded**; its outcome is a scheduled branch, not a discovery |
| **D1** | `fastTriviaScanner` null check | **DISCHARGED** | — | retired U3-as-scoped | — | null for css *and* less; scanner unreachable anyway under `_triviaLog: []` |
| **D2** | scavenge count, HEAD vs `a5dc9bd` | proposed | — | bounds U3a | — | counting, not timing; lane owns the box |
| **G1** | corpus gate → `assembledRules` | **IN FLIGHT** (`lane/triviacost`) | — | — | — | **hard prerequisite for U1′** |
| **U0′** | invariant checker (INV-6a/b/c/d, 7, 8, 9) | — | 0% | 0% | 0 | reporting-only for the field list too; count is the deliverable |
| **U1′** | length-keyed literals + `OP_GATE` + leaf capture elision + `_errors` latch | — | **10–30%** | small (13/22 `GATE` rows) | 0 | kill: **<5%**; 5–12% AMBIGUOUS |
| **U2′** | `nextTerm` dissolved, site-attribute record, `skipTrivia` dissolved | — | **12–21%** | 40–150 pts standalone | +40–80 B / +200–400 B | ratchet fires; operand buys six axes |
| **U3a** | capturing trivia lowering (recogniser + capture tail, one unit) | **IN FLIGHT** (`lane/triviacost`) | ~0 | **the only work touching +500–835%** | 0 | no number claimed; D2 bounds it |
| **U4** | emitted source, per-site bodies, `link` binds live rows | — | **50–75%** | carries the json floor too | **4–8 KB / 40–110 KB** | the only PASS; needs §5.4.1 |
| **U3b** | `ScanShape` terminal bodies for `OP_RX` | — | **10–25%** | — | 0 | classifier half portable early; emitter half needs U4 |
| **U5** | arity 4, capture elision, choice-strategy axis, `sharedPrefix` replay, `OP_ATTEMPT` placement | — | single digits each | single digits each | +100–300 B | behind the §8 gates |

**Read the json column as residual-ordered (§6.2).** Read the css/less column as *json
floor (U1′ + U4) + trivia (U3a)*, which is the only accounting that closes.

---

## 8. Correctness gates

The failure class this design most plausibly produces is: **a specialised body that
accepts and rejects identically but reports a different `expected` set, or a
different failure position.** Length-keyed literal bodies, `ScanShape` leaf bodies,
and inlined term bodies each rewrite a failure site.

`bench/table-lowering-identity.ts` catches part of this and misses part of it
(§0.1): it digests sorted `expected` but not position, order, `errors`, or
`rootTrivia`. The full gate is four instruments, and all four must be named in
any PR from this design:

| instrument | what it catches | note |
|---|---|---|
| `bench/table-lowering-identity.ts` (~2,800 files) | accept/reject, value, `unconsumedFrom`, sorted `expected` | **CONFIRMED and RAISED: it imports `tableRules` from `../src/table/exec.ts` (`:19`) — the bytecode interpreter — while `src/table/index.ts:28` ships `assembledRules as tableRules`. The corpus sweep NEVER executes the shipping engine.** This is **G1**, a prerequisite for **U1′**, not for U2 onward. In flight on `lane/triviacost`. |
| `bench/jess/digest.ts` | `FACETS = ['value','span','expected','expected-order','errors','rootTrivia']`, per file per engine, three processes joined by `bench/jess/divergence.ts` | The **widest** instrument in the repo and the right one for this work. `expected-order` is the facet the identity sweep sorts away. |
| `test/parity/failure-diagnostics.test.ts` | `span.start`, `span.end`, sorted `expected`, interpreter vs table, plus a macro leg | The direct test for the failure class above. Every new leaf body needs a case here. |
| `test/parity/table-lowering-gaps.test.ts` | all three current engines (`interpreted`, `exec`, `assembled`) | Hand-written cases only. **The named gap: nothing A/Bs `expected` between `exec.ts` and `assemble.ts` at corpus scale.** Closing that is a prerequisite for U2 onward. |

**The semantic reference is the interpreter** (`test/parity/helpers/engine-parity.ts`,
header `:1-24`), and the rule there is right: compare **whole objects**, not a field
checklist, because a field checklist is how the `sepBy trailing:'require'`
divergence got through.

**Two gates specific to this design:**

- **Every unit that adds a leaf body adds a failure case** asserting the `expected`
  label is byte-identical to the unspecialised body. Codegen preserved this by
  construction (`emitLit` computes one `expectedStr` and feeds all four forms —
  `codegen.ts:1383`, used at `:1396`, `:1404`, `:1412`, `:1419`); the port must
  preserve it the same way, by deriving the label once above the length switch.
- **`scripts/check-invariants.mjs` as extended in U0′** runs in preflight on every
  unit. A unit that needs an exemption is a unit that has misunderstood the design.
  **Corollary the original draft missed:** because exemptions are forbidden, a field
  that produces findings on *correct code* cannot go in `CONFIG_FIELDS` — which is
  exactly why `trivia` does not (§5.3), and why U0′'s field-list extension must land
  reporting-only or land *with* its fixes (`check-invariants.mjs:667` makes a stale
  allowlist entry a hard failure).
- **A regression case that must be ported with the mechanism, not after it.**
  `codegen.ts:582-590` documents a real miscompile from getting `sharedPrefix`'s
  per-arm `replayUsed` reset wrong: input `1-2` parsed as `['1','-','1']` with span
  0-1. That is a **tree-shape divergence a byte-count test would never see and an
  identity sweep catches instantly**. It becomes a case in
  `test/parity/failure-diagnostics.test.ts` when §8b.3's replay lands.

**Test breakage, classified per the owner's third-place rule** — *stale encoding* vs
*changed parse behaviour*:

| fix | what breaks | class |
|---|---|---|
| U2′ dissolving `nextTerm` | any assertion pinning `assemble.ts`'s internal piece structure | **Stale.** `nextTerm` ceases to exist by construction. |
| U1′'s `OP_GATE` selection | a test counting `reached` sites (`test/unit/table-assemble-subset.test.ts`) may see a smaller set | **Stale**, and the *intended* direction — that test asserts `reached` is a strict subset when an option excludes something. Nothing behavioural changes: the gate is already a no-op under tolerant/probe. |
| deleting the redundant `_tolerant` reads inside `REC`-selected bodies (`assemble.ts:908`, `:1970`) | possibly a test asserting `assemble.ts` ≡ `exec.ts` line-for-line on the recovery path; the comment at `:294` cites identity-with-`exec` as the reason to keep them | **Stale.** Identity is gated by the *interpreter as semantic reference*, not by matching the interpreter's implementation. Failure-path only, so speed ≈ 0 — law hygiene, ranked last. |
| U2′ / U4 size | `size-guard` ratchet (`ratchetSlackPct` 0.1, true json tolerance ±1 B) | **Deliberate trade, owner ruling.** Priority 2 loses to priority 1. Name it in the PR; do not smuggle it. |
| `bench/size-baseline.json` byte counts | both U2′ and U4 break the ratchet by prediction | **Stale, re-cut with sign-off** — at the **revised** numbers (json 4–8 KB, css 40–110 KB), not the original 16–24 KB. |
| any new leaf body | `expected`-set drift | **Defect if it fires** — and it currently *cannot* fire at corpus scale. **Fix G1 first.** |

**A note on `check:control-bytes`:** per repo memory it is not in preflight and scans
tracked files only — re-run it after committing anything with generated source.

---

## 8b. Queued 0.48 work — does this architecture accommodate it?

Three items in `RELEASE-0.48-TARGET.md` interact with the piece library. The
question for each is whether it becomes a new **row** in the library or a second
architecture.

### 8b.1 Token streaming (§2) — a new axis, and the axis is already implied

`src/compiler/token-scanner.ts` (14,800 B), `token-alphabet.ts` (9,099 B) and
`token-dispatch.ts` (15,558 B) are in-tree, built and never wired, carrying `DEBT`
entries at `scripts/invariant-allowlist.mjs:111-116` pointing at
`docs/design/derived-tokenization.md`.

**Answer: yes, the axes accommodate it, and the accommodation is cheap — but it is a
fourth axis, not a value on an existing one.** The selection key becomes

```
(input-representation × option × arity × child-kind)
```

with `input-representation ∈ { chars, tokens }`. A char-consuming literal body and a
token-consuming literal body are two members of one family, chosen at resolve time, with no parse-path branch either way. That is exactly the property §2 is built
on and it holds without modification.

**What has to be true for that to work, and it is not free.** The piece signature
`(input: string, pos: number, ctx: ParseContext)` (`assemble.ts:174`) hard-codes the
representation in its first two parameters. A token-consuming body wants
`(stream, index, ctx)`. There are two ways out and they differ in cost:

- **Keep the signature, change what `input`/`pos` mean per assembly.** The token
  stream carries the source string; `pos` becomes a token index. Every piece in an
  assembly agrees on the interpretation because the assembly was selected for it.
  Cheap, type-hostile, and the type-hostility is the point at which it would want
  `any` — which is banned. It needs a genuine discriminated parameter type with two
  branches resolved at selection, not a widened one.
- **Two signatures, two families.** Honest, and doubles the library.

**I recommend deciding this now and doing nothing about it now.** The decision that
must be made today is only: *the piece signature is a type that can have two members*.
That costs one type alias and no code. Building token bodies today would be
overbuilding against the middle-ground mandate.

**Which staged units are token-neutral, and which are not:**

| unit | token-streaming impact |
|---|---|
| U0 (invariant checker) | **neutral.** It checks for option tests, which is representation-independent. |
| U1′ (length-keyed literals, `OP_GATE`, leaf capture elision) | **superseded, not reworked.** A token-consuming literal body is an integer compare on token kind — it replaces the `charCodeAt` chain rather than modifying it. The `_probe`/`OP_GATE`/capture-elision halves are neutral and survive. U1′ is a day's work, so losing half of it later is not a reason to defer it. |
| U2′ (`nextTerm` and `skipTrivia` dissolved) | **the one to design for.** If trivia is classified once by the stream, the per-term scan does not shrink — it *disappears*, because the stream has already skipped it. **The site label must be an ENUM from the start, and it needs FOUR values, not three:** `no-trivia`, `scan-trivia`, **`adjacency-checked`** (§2.4's `OP_ADJ` correction — a correctness requirement, not a future one), and later `stream-pre-classified`. It also needs its **second axis** (`_triviaLog` presence per region, §2.1). Costs nothing to provide now; costs a rewrite not to. |
| U3a (capturing trivia lowering) | **partly superseded, but it is the unit that must land anyway.** If tokens land, `delimited` and `prefixRun` become the *tokeniser's* job — `token-alphabet.ts` exists to classify exactly those. But U3a is a small fraction of 1,627 lines and it is **the only work in the plan touching +500–835%**, so the exposure is affordable. **This is what disarms §9.7:** the shapes U3a needs are the four least likely to be superseded. |
| U3b (`ScanShape` terminal bodies) | **the real exposure, and the strongest argument for sequencing it after U4.** The shape bodies are char-level recognisers, and it is the largest unit by cost (~71% soundness proofs). **If token streaming is in scope for 0.48, U3b should not be started.** Note the classifier half (`parseScanShape` / `scanShapeFromRegex`) is worth porting regardless — it is representation-independent analysis. |
| U4 (emitted source, static bindings) | **neutral, and it is the enabler.** The resolve step is representation-agnostic by construction. Whether a `_pf<N>` binding resolves to a char body or a token body is one more thing resolution decides. |

**The bound I am not allowed to use, and am not using.** `RELEASE-0.48-TARGET.md:32-45`
records ~1.4 ms for token scanning, ~1.6 ms for superoperators, ~10% for
materialisation, ~0.1 ms for builder megamorphism — all measured against the bytecode
interpreter, an architecture that no longer exists, and the token figure was
structurally blind to entry elimination. **None of them appear anywhere in this
document as evidence, and I make no prediction of token streaming's payoff.** The
correct next step for that is to re-derive a bound against the closure assembler,
which is a separate piece of work from this design.

### 8b.2 `_grammarTrace` parity (§1) — a clean variant, plus one honest caveat

Codegen emits the six trace phases at ~40 fine-grained sites. In this architecture
trace is **a clean additional variant**: one more `RunCfg` bit, and resolution selects
traced/untraced bodies exactly as it resolves probe/tolerant. That is the same law
this design already enforces, so trace costs no new mechanism.

The caveat is the multiplication. **REVISED count:** the four existing bits, plus
`probe`, plus `_errors`, plus `cap` (**2 bits, 3 values — §2.1; the `triviaCapture`
bit it replaces was unsound**), plus `trace` = **9 bits, 512 assemblies worst case.**
The region axes do **not** multiply `cfgKey` — they are site labels, which is the point
of §2.1's correction. The *cache* is fine — realised assemblies are what cost memory, and a
grammar realises two or three. The *library* is the question: a traced variant of
every body is a second copy of every body's source. **Recommendation: trace bodies are
generated from the untraced ones by the same emitter rather than hand-authored**, which
keeps the maintenance cost at one body per shape. This is the same discipline that
makes `emitShapeMatch` one source of truth for nine shapes and two consumers.

### 8b.3 `sharedPrefix` scan-once is unpaid-for in the table — add it to the mining list

`src/table/encode.ts:668-676`. The comment argues that arm ORDER is the only thing
`literalsLongestFirst` and `sharedPrefix` change, and that declared order is already
correct for `sharedPrefix` because `choice.ts:52` documents it as a `firstMatch`
specialisation. **The order argument is correct. The conclusion that nothing is owed
is not.**

`sharedPrefix` in codegen was not an ordering strategy, it was a **scan-once**
strategy: `emitNonDisjoint` (`codegen.ts:2933-2967`) dispatched to a `sharedPrefix`
emitter that matched the common prefix **one time** and then discriminated among the
arms from the position after it. Encoding the arms in declared order preserves
*semantics* and discards the *optimisation* — every arm re-matches the shared prefix
from scratch.

**CORRECTED (coverage review §5) — the original placement describes the parent
correctly and omits the hard half.** Calling it "a choice-kind child shape selected at
resolve time from a table-recorded prefix" describes a parent that matches the prefix
once. But codegen's mechanism (`codegen.ts:2871-2931`) is `emitSharedPrefix`
registering `ctx.replayPrefix` / `replayUsed` / `replayOwner` and delegating to
`emitFirstMatch`; **each arm's LEADING TERMINAL is then emitted by
`emitReplayPrefixLeaf:2921` as a *replay* — it consumes the already-matched span
without scanning.** So the arm's leading child gets a different body **because of a
fact its ANCESTOR installed** — §2.4's inherited axis. And it is the only way the win
is realised: *a parent that matches the prefix once but whose arms still re-scan it has
bought nothing.*

**Correct placement:** `replaySlot` becomes a field of §2.4's site-attribute record —
the choice row records the prefix, each arm's leading-terminal site carries a
`replaySlot` that selects the replay body instead of the scan body. Port
`emitSharedPrefix`'s **ownership discipline with its reset rule and its regression
case** (the `1-2` → `['1','-','1']` miscompile at `codegen.ts:582-590`; the reset is
per-arm and performed only by the owning choice, `emit:4514`, `emitFirstMatch:2634`).
Bytes: one operand on the choice row plus one on each arm's leading terminal — tens of
bytes per site.

It remains a **U5-class item**; no magnitude is claimed, and both reviews that looked
at it also declined to invent one. **The concrete deliverable now, independent of any
unit, is to correct the comment at `encode.ts:668-676`**, which currently reads as
though the strategy were fully accounted for and would stop the next reader from
looking. Two-line docs change, no risk.

**`greedyClassify` — CHECKED, and it IS missing.** The original text said *"I did not
check it and am not claiming it is missing."* The coverage review checked it (§2.5
above): `OP_GREEDY` is auto-selected by `choice()` (`ops.ts:256-257`,
`choice.ts:186-202`), appears in essentially every real language grammar including css
and less, re-attributes its match **by string equality** and **re-runs the winning
literal arm at `pos`**, and today additionally allocates a string per execution
(`byWord.get(input.slice(pos, end))`, `assemble.ts:1794`). `OP_REJECT` walks a
variable-length check list on the parse path. **Both are now §2.5's choice-strategy
axis and both are in U5.** Codegen's 4/48/3 switch-vs-if-chain plan
(`SWITCH_RANGE_LIMIT`, `SWITCH_MAX_CASES`, `SWITCH_MIN_CASES`, `codegen.ts:1163-1203`)
should still be checked against `OP_DISPATCH`'s current dispatch selection when U5 is
scoped; that specific comparison remains unmade.

---

## 9. What I am least sure of

Listed so a reviewer can attack the weak points rather than hunt for them.

**9.1 — RESOLVED IN FAVOUR OF THE DESIGN, with one narrowing.** The feedback-vector
claim (§0.3) was verified under `--trace-turbo-inlining` on `node v24.11.1`:
`kManyClosures` sharing confirmed (same `FeedbackVector` object address at four call
sites of one SFI), and the shared-literal form **never inlined its callee** while 24
distinct literals inlined all of theirs. **U4 is required; "just restructure
`assemble.ts`" is dead.** The narrowing: with **≤4 targets AND a constant-foldable
closure**, context specialisation recovers the callee anyway — so the absolute phrasing
is too strong of the *outcome* even though it is right about the IC. §0.3 now carries
the precise statement. **What remains owed is D0** — the same observation on the real
json workload rather than on minimal reproductions.

**9.2 — The css/less allocation story — the argument is REPLACED by a stronger one.**
The original claimed the `{end, commit}` pair plus the `commit` closure escape and
therefore cost, against `RELEASE-0.48-TARGET.md` §3's measured **zero** for ~291k
non-escaping `node()` allocations. Two of the five allocations do escape — but **the
real cost is not allocation at all: it is a full interpreted combinator parse, with a
freshly built `ParseContext`, per sequence term on a 64 KB input** (§0.6). That
reframing does not depend on escape analysis, which is fortunate, because the escape
argument is exactly the kind sampled profiling flatters. **D2 (scavenge counting, not
timing) settles what remains of it.**

**9.3 — RESOLVED. `fastTriviaScanner` is null for css AND for `bench/workloads/less.ts`,
non-null for json and graphql.** Confirmed statically in one review and by execution in
two. **And the check did its job in an unexpected direction:** it also surfaced that
`skipTrivia:461` requires `_triviaLog === undefined`, which the css/less workloads
violate — so the recogniser was never the binding constraint, and U3-as-scoped was
retired before a line was written. **This is the strongest argument in the document for
zero-cost falsifications.**

**9.4 — The magnitudes in §6 are apportionments, not independent estimates — and they
are now RESIDUAL-ORDERED, which the original draft did not say.** See §6.2 for the
restatement rule and the three concrete order dependencies. The original json column
summed to 70–110% of +137%, leaving ~30% (≈ +41%) unallocated at the low end with no
unit to own it; the revised column (U1′ 10–30 + U2′ 12–21 + U4 50–75 + U3b 10–25,
residual) closes. The css/less column now closes as *json floor + trivia* (§6.2). The
*ordering* (U4 > U1′ ≳ U2′ for json; U3a owns css/less) is what is defended; the
individual percentages remain softer than their precision suggests.

**9.4a — NEW: a plan that hits every prediction can still end above target, and that
must not read as failure.** The original arithmetic could legitimately land at +41%
with every unit succeeding. The revised numbers close, but they close *by residual
ordering*, so the first reordering re-opens the gap. §6.2's restatement rule is the
mitigation and it is a rule, not a caveat.

**9.4b — NEW: `graphql/document` now has a role, and still has no number.** graphql
has **3,752 speculative arm entries with 952 failures** where json has **zero**, and it
is **40.3% whitespace** where json is ~0%. It is the only workload exercising
backtracking and trivia scanning together with capture off, which makes it **the
natural control for U2′ and U3b**. It gets a measured row; it does not get a
prediction.

**9.5 — §3.4's capture-reachability elision** is the one proposal here that can
produce silently wrong output rather than a slow parse. I have put it in U5 for that
reason, and I would accept an argument that it should be dropped entirely.

**9.6 — I have not read all 2,457 lines of `assemble.ts`.** I read `OP_SEQ` in full,
the leaf terminals, `nextTerm`, `skipTrivia`, `markCst`, `link(ip)`, and `RunCfg`. The
choice/repetition/dispatch pieces I have only grepped for array indexing. There may be
further option tests on the parse path in the pieces I did not read — U0's extended
checker is precisely the instrument that would enumerate them, which is another reason
it goes first.

**9.7 — U3's exposure to token streaming (§8b.1) is the sequencing risk I would most
want an owner ruling on.** It is the most expensive unit in the plan and the one most
likely to be partly redone. If token streaming is in scope for 0.48, U3 should be cut
down to the trivia-path shapes only; if it is not, the full nine-shape port is right.
I cannot resolve that from the tree.

**9.8 — The `CONFIG_FIELDS` audit (§5.2) is a partition I made by reading
`createParseContext`, not by tracing every writer.** I am confident about
`trivia`, `trackLines`, `build`, `_probe`, `_tolerant`, `_grammarCoverage` — those
have explicit written arguments in `assemble.ts:198-235` or are demonstrated by the
scope-swap sites. I am **less** confident about `scanSkip`, `triviaKindLabels`,
`captureTrivia` and `_triviaCaptureMask`: I classified them as option-derived on the
strength of where they are set, not on an exhaustive writer search. If any of them is
mutated mid-parse the way `trivia` is, it belongs in §5.3's treatment rather than in
`CONFIG_FIELDS`, and adding it to the list would produce a *false* build failure that
someone would then "fix" by weakening the checker. **U0 must verify each of those four
against its writers before the list is enforced**, and that verification is part of U0,
not a follow-up.

**9.9 — I recommend adopting `_pf<N>` for node bindings and I have not proved the
namespace collision is safe.** Codegen minted `_pf<N>` for its own hoisted private
functions under `ns`. If U4's emitter also mints `_pf<N>` and both forms ever coexist
in one fused scope — during a migration, or in a mixed artifact — the counters must
share a minter or they will collide silently. Adopting an existing name inherits its
allocation discipline as well as its spelling, and I have not checked where that
counter lives.

**9.10 — The `graphql/document` +107–137% row is unexplained by my model — PARTLY
CLOSED.** graphql is `withoutCapture` like json and lands at the same floor, which is
consistent. Its literal-length distribution is now known (**zero literals across
`examples/{json,css,graphql}` exceed 16 chars**), so U1′'s mechanism does apply there.
What is *not* known is why two workloads with opposite LIT/KB and rows/KB ratios land
in the same band — §7's two-term fit is the best available answer and it cannot split
U1′ from U4. See 9.4b: graphql is a control, not a prediction.

**9.11 — NEW: the checker's own decidability limit.** `check-invariants.mjs:205` runs
`oxc-parser` with **no type checker**, so any rule keyed on a TypeScript type
(`Piece[]`, `Combinator<…>`) is not decidable and is fragile to a rename.
`INV-7`-as-restated is syntactic by construction. **`INV-8` is not** — it reads a
declared parameter type. If that proves undecidable in practice, INV-8 degrades to a
naming convention or is dropped; it is ranked #2 by value and #1 by implementation
risk.

**9.12 — NEW: `INV-9` is the only rule that catches the largest finding in the
reviews, and it is the least decidable.** "Reachable per-term" needs a call graph.
Seeding it with a declared hot-function list is a hand-maintained list, i.e. exactly
the kind of thing that rots. It is proposed at reporting-only strength anyway, because
nothing else can see §0.6's cost at all.

**9.13 — NEW: `_rootTriviaCapture`, `cstLeafShape` and `routedLocal` are asserted to
be static site properties on the strength of codegen's emitter, not on a writer trace
of the current tree.** §2.4 packs them into the site-attribute record. If any of them
turns out to vary within a region the way `captureTrivia` varies per node, it belongs
in `REGION_FIELDS` instead and the record shrinks. **U2′ must verify each against its
writers before the record's field set is frozen** — the same obligation §9.8 already
carries for `scanSkip` and `_triviaCaptureMask`.

**9.14 — NEW: U3a's soundness proofs are ported, and a ported proof is only as good as
its template.** `delimitedBodySound` proves "scan to the first close" equivalent to
`<open>(?:body)*<close>` **only for the delimiter-safe idiom**, and declines everything
outside it. That is sound by construction and it is the right shape — but it means the
coverage of the lowering is exactly the coverage of the template, and a grammar whose
block comment is spelled slightly differently silently falls back to the interpreter
with no signal. **A declined lowering should be observable**, not silent, or the next
css/less-shaped regression will be invisible for the same reason this one was.
