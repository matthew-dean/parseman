# REVIEW — child-kind specialisation, lens 1 of 3: SHAPE COVERAGE

Reviewing `notes/DESIGN-child-kind-specialisation.md` @ `eb516a4` (branch `design/child-kind`).
Reference tree: `archive/codegen-fastpaths`, tag object `ad3c06f`, commit `3d4dac6` — both
confirmed by `rev-parse`; the design's header is accurate.

**Mandate.** This is not a review that asks whether the work should happen. It asks whether the
proposed piece taxonomy can *express* the constructs the deleted engine actually handled. Every
criticism below carries the piece or axis that fixes it.

**Priority applied**, per the owner's ranking: **speed first, size second, tests third.** Holes are
ranked in §9 by *speed lost*, not by shape count. Where a fix costs emitted bytes I say so and
propose it anyway. Where a fix would break a test that pins an assembler internal or a byte count,
I name that as a stale test, not as a constraint.

**Method — what I threw at the taxonomy.** All 9 `ScanShape` variants and all 3 `SeqPart` variants
(`archive:src/compiler/scannable-run.ts:43-81`), read against `emitShapeMatch`'s actual emission
(`:1244-1595`); all 40 opcodes in `src/table/ops.ts`; the full `emit*` inventory of
`archive:src/compiler/codegen.ts` (6310 lines, ~60 emitters); the four trivia tiers of
`archive:src/compiler/trivia-fast-path.ts`; `inline-build.ts`, `inline-callback.ts`,
`module-hoist.ts`; and `sharedPrefix` against `src/table/encode.ts:668-676`. Nothing was sampled.

Read-only on `src/`. No benchmark was run. No number below is measured.

---

## 1. The stated cutoff rule is false, and taken literally it deletes U3 entirely

**SPEED IMPACT: highest. This rule decides whether the nine leaf bodies exist at all.**

The design's cutoff (§2.3):

> a child kind earns an inlined body when its entire matcher is **branch-free straight-line code**
> with no call into another piece and no allocation.

Now the emission every one of the nine shapes actually produces
(`archive:src/compiler/scannable-run.ts`):

| shape | line | control flow it emits |
|---|---|---|
| `chars` | :1358-1369 | `while` loop |
| `ident` | :1371-1384 | `if` + `while` |
| `seq` | :1386-1459 | `do { … } while (false)` with a `break` per part; nested `while` per run; recursive group loop `while (true)` at :1444 |
| `litFold` | :1461-1476 | one `if` |
| `until` | :1478-1515 | `if` + `while` (or `indexOf`, a **builtin call**, at :1499) |
| `string` | :1517-1555 | `if` + `while` + 3 inner `if`s + `continue` |
| `delimited` | :1557-1594 | `if` + `while` (or `indexOf` call at :1576) |
| `alt` | :1275-1356 | `switch` jump table (:1294, :1316), or `if/else if` chain (:1334), or a **labeled block with `break _alt`** (:1347-1352) |
| `lookahead` | :1251-1273 | `if` |

**Zero of the nine are branch-free. Two emit a builtin call.** The design's own §2.3 table says all
nine paste — and that table is right. The *rule* is wrong.

This matters beyond pedantry because the rule is what a reviewer or implementer will apply to a
shape the table does not list. Applied literally it rejects every shape including `chars`, and U3
collapses to nothing.

**FIX — restate the cutoff as codegen's actual rule**, which is readable off its behaviour:

> A child pastes when its matcher is **self-contained**: it needs no call into another *piece*, it
> allocates nothing, and it exposes no backtrack point to its parent — it either consumes a span or
> reports `end === start`. Internal branching and looping are irrelevant and expected.

`emitShapeMatch`'s own contract states exactly the third clause and it is the load-bearing one:
":1201-1203 — **Invariant:** `end === start` whenever there is no progress … so the trivia loop can
gate purely on `end > start`." That is the property that makes a paste safe. "Branch-free" is not.
Builtin calls (`indexOf`) are also fine and are a *measured* 4.3× win (:1484-1491) — the rule must
not exclude them.

Cost of the fix: one paragraph. Bytes: zero.

---

## 2. `ScanShape` is a recursive tree. "Nine piece bodies" is not a body set, and it forces U3 after U4

**SPEED IMPACT: highest. This is the sequencing error in the plan.**

The design says (§4, and U3 in §6):

> `emitShapeMatch` (lines 1154–1627, the emission half) → **nine piece bodies**, one per `ScanShape`
> variant, selected by `link` from the recognised shape.

`ScanShape` is not a nine-member enum. It is a **recursive type** with three self-referential
constructors (`archive:src/compiler/scannable-run.ts:43-81`):

- `alt.arms: ScanShape[]` (:81) — recursed at :1319, :1333, :1349
- `lookahead.inner: ScanShape` (:72) — recursed at :1252
- `seq.parts: SeqPart[]` where `SeqPart` has its own three variants (`lit` / `run` / `group`, :43-50)
  and **`group.inner` is any `ScanShape`** (:50) — recursed at :1432

So the number of distinct bodies is the number of distinct shape *trees* in the grammar — unbounded
— not nine. `emitShapeMatch` is not a selector over nine bodies; it is a **recursive source emitter**
returning `{ setup: string[]; ok: string; end: string }` (:1208), i.e. *code strings*, threaded
through a `Mint` gensym (:1191) so spliced fragments do not collide.

**And the recursion is not the whole problem. The constant-folding is.** Every shape's speed comes
from baking its ranges and code points into the *source*:

- `classCond` (:1163-1166) emits `(c >= 97 && c <= 122) || c === 45` — an inline compare chain.
- `litCond` (:1169-1176) and `foldEq` (:120-124) do the same for literals and the ASCII fold.

A *static runtime piece* cannot do this. It must close over a `ranges` array and loop it — which is
precisely `inRanges` in the current tree (`src/combinators/trivia-skip.ts:391-397`, called per
character at :405, :459, :478; the same function again at `src/combinators/regex.ts:34` and
`src/cst/trivia-charscan.ts:35`). U3's stated deliverable is to replace "`inRanges`' per-character
range loop in favour of an inline `classCond` chain" — **but an inline `classCond` chain is emitted
source.** As a static piece, U3 reproduces `inRanges` and delivers approximately nothing.

**This inverts the plan's ordering.** U3 is scheduled at position 3, U4 (emitted source) last, with
the note that U1–U3 "*reduce the size of U4*". For U3 that is backwards: **U3 has no mechanism until
U4 exists.** U1 and U2 genuinely are U4-independent (U1 is explicitly so, and correctly). U3 is not.

**FIX — three parts, all cheap:**

1. **Reorder: U4 before U3.** U3 becomes "populate the emitter with the nine shape emitters", which
   is what it always was — `emitShapeMatch` ports across essentially verbatim onto a source emitter,
   and that is where the archive saves the most work.
2. **If U3 must precede U4** (schedule pressure), scope it to the *non-recursive, non-range-loop*
   subset where a closure specialisation still wins: `litFold` and `delimited` with a
   single-code-point open, and `until`/`delimited` under `indexOf`. `delimited` is the css case
   (§0.6) and its win is the SIMD `indexOf`, not the class chain — so it *does* survive without an
   emitter. That is a real, small, correct U3′.
3. **Split the classifier from the emitter in the unit description.** `parseScanShape` /
   `scanShapeFromRegex` (the analysis half, :1-1152, ~71% soundness proofs) genuinely is
   assembly-time and U4-independent. Port it early — it is the expensive half and it de-risks U4.
   Only `emitShapeMatch` needs U4.

Bytes: U4-before-U3 changes no byte total, only the order the bytes arrive in.

---

## 3. The missing fourth axis: **inherited site attributes**

**SPEED IMPACT: high — it is the axis `sharedPrefix`, `OP_ADJ` and CST leaf capture all need.**

The design's key is `(option × arity × child-kind)`. All three are properties of the parent's
options, the parent's shape, or the child's **own opcode**. Codegen had a fourth input that none of
these captures: facts pushed **down** from an ancestor into a descendant's emission.

The design meets exactly one instance of this and solves it correctly — §2.1's trivia site label,
where it observes that `ctx.trivia` presence "can be lifted to **the site**, which is strictly
better", computed by "a downward pass over the code array", and notes this "is what codegen did
(`ctx.activeTrivia`, `codegen.ts:1774`)". That reasoning is right. **The design then treats it as a
one-off subtlety rather than as one member of a family.** From the archive, the family has at least
eight more members:

| inherited fact | archive site | what it changes in the descendant |
|---|---|---|
| `ctx.activeTrivia` | `codegen.ts:1774` | **handled** by the design's site label |
| `ctx.leafBufLit` / `ctx.rawBufLit` | set `codegen.ts:4189-4192` (in `emitNode`), read `emitLeafCapture:848` | picks **one of four** CST-leaf capture shapes in every terminal at arbitrary depth below the node |
| `ctx.replayPrefix` / `replayUsed` / `replayOwner` | `emitSharedPrefix:2871-2910`, consumed `emitReplayPrefixLeaf:2921` | replaces an arm's leading terminal with a **no-scan replay** — see §5 |
| `ctx.routedLocal` | installed `emitDispatchCombinator:2296`, read `emitRouted:3706` | which of two forms `routed()` emits |
| `ctx.inlineLeft` | budget `INLINE_MAX_NODES = 1000` (:5036), charged `emitLazy:4367-4372`, reset at every function boundary (:4399, :4572, :4817, :6042) | paste vs `_pfN` call |
| `ctx.failLabel` | threaded throughout | which label a failure breaks to |
| `ctx.capAsTrivia`, `ctx.noHoist` | `ensureTriviaFn:1044`; probe clones `emitScanTo:3557`, `emitPeek:3690` | suppresses capture and hoisting in a whole subtree |
| **placement of `OP_ATTEMPT`** | `src/table/ops.ts:362-371` | see §4.3 — the row's *body* differs by grandparent |
| **placement of `OP_ADJ`** | `src/table/ops.ts:226-251` | see §4.1 — must run before the parent's trivia scan |

**FIX — promote the site label to a general inherited-attribute vector.** The design already
proposes exactly the machinery: one downward pass over the code array during `encode`, at the point
the scope wrapper is emitted (`src/table/encode.ts:520`). Generalise its output from a single
`trivia: none | slot-N` operand to a small **site-attribute record** carrying, at minimum:
`trivia` (already proposed), `cstLeafShape`, `replaySlot`, `routedLocal`. Selection key becomes
`(site-attrs × option × arity × child-kind)`.

This is a strict generalisation of something already in the plan, not a new mechanism, and the
design's own §2.1 argument for why the trivia label belongs at the site is verbatim the argument for
the other three. **It is also the change that makes §5 possible at all.**

Bytes: the design already predicts +40–80 B json / +200–400 B css for the trivia operand alone (U2).
A packed 4-field attribute record encoded as one integer operand costs the *same* one operand —
these are all small enumerations and pack into a single int. **So the generalisation is byte-free
over what U2 already budgets.** Worth stating in the PR, because it makes U2's ratchet break buy
four axes instead of one.

**Note the design's own evidence points here and is misread.** §2.3 cites
`assemble.ts:1385` — `for (let i = 1; i < n; i++) if (code[code[base + i]!] === OP_ADJ) …` — as proof
that "child opcode is already visible to the parent, no encoder change required". True, and useful.
But that specific line exists because `OP_ADJ` is a fact the *parent* must act on, at a position
*before* the ambient trivia scan. It is evidence for the inherited axis, not only for the child-kind
axis.

---

## 4. Opcode sweep — all 40 in `src/table/ops.ts` against the taxonomy

The design's §2.3 table ends with "everything else (24 opcodes) | no — call". Enumerating the 40
actually present, five break the dichotomy and two block U4 outright. The rest are clean.

### 4.1 `OP_ADJ` (`ops.ts:252`) — the design places it in the wrong bucket

Design §2.3 row: "`OP_EMPTY`, `OP_ADJ` | **yes** [paste] | zero-width, already trivial."

`ops.ts:226-251` says otherwise, in terms:

> A BOUNDARY TEST, NOT A TERM … It asks whether trivia sat between the PREVIOUS term and here, so it
> must be evaluated at the sequence cursor — **BEFORE the ambient trivia scan** that precedes an
> ordinary non-first term. A piece handed the post-scan position would find the gap already consumed
> and answer "adjacent" every time, **silently**: `adjacent()` would become a no-op and
> `notAdjacent()` a guaranteed failure.

And:

> The kind filter is resolved against the ACTIVE trivia table **at parse time** … a scope can swap
> the table, so it is **not an assembly-time fact**.

Three consequences the design does not carry:

1. `OP_ADJ` is **not** a child that pastes at its own term position. It changes the *parent's*
   term-boundary emission — i.e. it is an inherited-axis construct (§3), and it multiplies U2's
   per-position term bodies by a third variant (`adjacent-checked`) on top of the
   `no-trivia` / `scan-trivia` pair.
2. Its kind filter is a **runtime lookup against the active trivia table**, so a pasted body is not
   option-free. This is a genuine runtime read that survives selection — like `cstCaptureActive`,
   it needs the §3.3 paragraph, and the design does not give it one.
3. The failure mode is **silent wrong output**, not slowness (`adjacent()` becomes a no-op). That
   puts it in §9.5's risk class, not in "already trivial".

**FIX.** Move `OP_ADJ` out of the paste row. Give U2's term-body selection a third value in the
trivia enum — which §8b.1 *already recommends creating* for token streaming ("make the site's trivia
label an enum with room for a third value rather than a boolean"). Same enum, one more member: this
costs nothing extra if U2 takes 8b.1's advice. The kind-filter lookup stays runtime and gets a
documented justification.

Bytes: zero beyond U2's existing operand. Speed: preserves a correctness invariant U2 would
otherwise break.

### 4.2 `OP_LIVE` (`ops.ts:360`) and the live-predicate rows — these **block U4**

`OP_LIVE` runs a hand-written foreign combinator through its own `.parse` (`ops.ts:333-359`). The
design never mentions it. The blocking sentence is `ops.ts:351-354`:

> a live combinator is not data, so a program holding one is `runtimeOnly` — it runs, and
> `emitTableModule` **refuses to print it BY NAME**. Codegen degrades identically (a non-empty
> `runtimeParsers` makes `inlineExpression` null).

Confirmed on the archive side: `emitRuntimeFallback` (`codegen.ts:4305`) emits `_rp[i].parse(...)`,
and its presence disqualifies the artifact from inlining and linking (`codegen.ts:5501`, `:6074`).

`OP_GUARD` (`ops.ts:224`) and `OP_ARMGATE` (`ops.ts:332`) are the same class — `ops.ts:329-331`:
"The predicate is a live function, like `OP_GUARD`'s, so a grammar using one is **runtime-only for
`emitTableModule` unless `fnSources` are supplied**."

**U4 is "the per-grammar artifact becomes generated wiring". For any grammar containing one of these
three rows, there is no artifact to generate.** The design's discriminator hides this: §6 notes json
has "zero `OP_LIVE`", so the workload that drives every prediction is the one workload that cannot
surface the gap.

**FIX.** U4 must state a degradation policy, and there is a good one available — the design's own
`link`/`make` shape already supplies it. Codegen's answer (disable the *whole* artifact) is the bad
one and should not be copied. Instead: `link` resolves a live row to a **bound interpreter piece**,
exactly as it resolves any other binding; the emitted module takes those combinators as a
constructor parameter rather than printing them. The grammar still emits; only the live rows stay
closures. That is strictly better than codegen and it falls out of `link` for free.

Speed: unblocks U4 for every real-world grammar containing a `gate()` — which per `ops.ts:220-222`
is a documented and used API surface. Bytes: one parameter per module.

### 4.3 `OP_ATTEMPT` (`ops.ts:385`) — the body depends on the **grandparent**

`ops.ts:363-368`:

> WAS A TRANSPARENT WRAPPER … which is correct for exactly one placement — **an arm of an
> `OP_CHOICE`**, whose per-arm loop already saves and restores the eight capture sinks. Anywhere else
> — a `sequence()` term, a repeat item, a `node()` body — a failed transaction left its CST leaves,
> raw children, fields, recovery diagnostics and trivia-log entries behind.

So the cheap body is correct under a choice parent and *wrong* elsewhere. This is not
`(option × arity × child-kind)` — the child-kind is `OP_ATTEMPT` in both cases and the arity is the
parent's. It is placement, i.e. §3's inherited axis again.

**FIX.** `attempt-under-choice` and `attempt-elsewhere` are two bindings selected by the site-attribute
record. This is a **speed win, not just a correctness note**: under a choice parent the eight-sink
save/restore is redundant work the parent already does, and today it is paid twice or the row is
wrong. Bytes: zero (selection only).

### 4.4 `OP_GREEDY` (`ops.ts:283`) and `OP_REJECT` (`ops.ts:307`) — unaccounted, and both are hot

Neither appears anywhere in the design. §8b.3 gets adjacent to `OP_GREEDY` and explicitly declines to
check it: "codegen's `greedyClassify` … should be checked against `OP_DISPATCH`'s current dispatch
selection before U5 is scoped. I did not check it and am not claiming it is missing." Checked here:

**`OP_GREEDY`** is the identifier-vs-keyword shape — `choice()` auto-selects it (`ops.ts:256-257`,
`choice.ts:186-202`), so it appears in essentially every real language grammar, css and less included.
It is not a choice: a regex arm runs, the match is **re-attributed by string equality**, and the
winning literal arm is **re-run at `pos`** with a capture-sink rollback to a pre-`sup` mark
(`ops.ts:268-277`). Codegen pasted this as one super-regex plus a string-equality classify
(`emitGreedyClassify:2472`) and it is **sibling-dependent** — the emission reads every literal arm.

**`OP_REJECT`** is `autoNot`: checks that run *after* an arm succeeded and can still reject it
(`ops.ts:285-306`). The checks are a **variable-length `(kind, operand)` pair list walked at parse
time** — that is an array index on the parse path, i.e. it violates the design's own proposed
`INV-7` (§5, item 3). Codegen pasted them inline (`emitFirstMatch`'s `_carej`, `codegen.ts:2620`).

**FIX.** Both are **whole-choice shapes**, selected by the choice's *strategy*, not by any one
child's kind. Add a fifth selection input the design half-has already: the design's §8b.3 concedes
"a `sharedPrefix` choice is a **choice-kind child shape**". Generalise that to a
**choice-strategy axis** with the values already present in the tree: `ordered` (`OP_CHOICE`),
`disjoint-dispatch`, `greedyClassify` (`OP_GREEDY`), `literalsLongestFirst`, `sharedPrefix`. Each is
one emitted body family, and codegen already has all five (`emitFirstMatch:2589`,
`planDisjointDispatch:1185`, `emitGreedyClassify:2472`, `emitLiteralsLongestFirst:2543`,
`emitSharedPrefix:2871`). `OP_REJECT`'s check list unrolls into the arm body at emission, which
removes the array walk and satisfies `INV-7`.

Speed: `OP_GREEDY` is on the keyword path of every css/less parse; the unrolled form removes a
per-arm string-equality loop. `OP_REJECT`'s unroll removes a per-arm array walk. Bytes: the unroll
is per-arm-per-check, small — call it +100–300 B on `example/css`. Worth it.

### 4.5 What passed cleanly

Demonstrating the sweep found real negatives, not only positives:

- **`OP_COV` (`ops.ts:424`) is not a hole — it is a precedent that *supports* the design.**
  `ops.ts:410-412`: "`on` … is read at ASSEMBLY TIME, never per parse: `assemble.ts` picks one of two
  closures from it, **exactly as it picks pieces from `RunCfg`**." That is the design's law already
  implemented. §8b.2's proposal to make trace another `RunCfg` bit is the same move and is sound.
- **`OP_WITHCTX` (`ops.ts:210`)** — save/restore wrapper, falls cleanly in the call bucket. Codegen
  agreed: always hoisted to `_wcfN` and called (`codegen.ts:4794-4808`).
- **`OP_LABEL` (`ops.ts:399`)**, `OP_EXPECT`, `OP_FIELD`, `OP_XFORM`, `OP_OPT`, `OP_NOT`, `OP_PEEK`,
  `OP_TOKEN`, `OP_LEAF`, `OP_SCOPE`, `OP_SCOPE_CAP`, `OP_SCAN`, `OP_ROUTED`, `OP_GATE`, `OP_RULE`,
  and the `_TRACK` variants — all wrappers or compounds with internal control flow; the call bucket
  is correct for each and the design's blanket row covers them.
- **`OP_EMPTY` (`ops.ts:92`)** — genuinely zero-width and trivial; the paste row is right. (It is
  `OP_ADJ`, bracketed with it in the same row, that is misplaced.)
- **`OP_DISPATCH` (`ops.ts:436`)** — call bucket, correct. Codegen's `emitDispatchCombinator:2196` is
  the heaviest emitter in the archive; nothing about it suggests a paste.
- The design's **arity** axis survives contact: `emitSeqValues` (`codegen.ts:1739`) is per-term and
  unrolled, matching §2.2, and the arity-4 proposal is supported by css declarations being 5-ary.
- The design's **`alwaysConsumes`** selection (§4) is real and correctly located:
  `codegen.ts:1785` decides the trivia rollback quartet per term on exactly that predicate.
- **§9.3 (`SCAN === null` for css) is confirmed statically** — the design flags it as unverified and
  asks for a one-line check. Two independent rejection points, no execution needed:
  `altStarSource` (`src/combinators/trivia-skip.ts:520-522`) requires the *whole* source to match
  `^\(\?:(.*)\)[*+]$`, and `splitTopLevelAlts` returns `null` on a nested `(`
  (`:504`) — css's comment regex `/\/\*(?:[^*]|\*(?!\/))*\*\//` contains one. `classifyTriviaArm`
  handles only `class` and line-leader arms. **css has no fast trivia scanner. U3's premise holds.**

---

## 5. `sharedPrefix` — the taxonomy cannot express scan-once, and the fix is §3

**SPEED IMPACT: medium-high on css/less, unquantified.**

The design's §8b.3 diagnosis is correct and I confirm the comment it criticises verbatim at
`src/table/encode.ts:668-674` — "ORDER is the only thing they change" — and that `sharedPrefix` is
encoded as a plain declared-order choice (`:675-677`). Semantics preserved, optimisation discarded.

**Can the proposed taxonomy express scan-once? No — and §8b.3's own proposed placement does not work
either.** It says: "a `sharedPrefix` choice is a **choice-kind child shape**, selected at link time
from a table-recorded prefix, with a body that matches the prefix once and then dispatches."

That describes the *parent* correctly and omits the hard half. Codegen's mechanism
(`archive:src/compiler/codegen.ts:2871-2931`): `emitSharedPrefix` registers `ctx.replayPrefix`,
`ctx.replayUsed` and `ctx.replayOwner`, then delegates to `emitFirstMatch`; each arm's **leading
terminal** is then emitted by `emitReplayPrefixLeaf:2921` as a *replay* — it consumes the
already-matched span **without scanning**. So the arm's leading child gets a different body because
of a fact its **ancestor** installed. That is §3's inherited axis, and it is the only way the win is
realised: a parent that matches the prefix once but whose arms still re-scan it has bought nothing.

This is also the design's sharpest correctness exposure. `codegen.ts:582-590` documents a real
miscompile from getting the per-arm `replayUsed` reset wrong: input `1-2` parsed as `['1','-','1']`
with span 0-1. The reset is per-arm and performed only by the owning choice (`emit:4514`,
`emitFirstMatch:2634`).

**FIX.** `replaySlot` becomes a field of §3's site-attribute record: the choice row records the
prefix, and each arm's leading-terminal site carries a `replaySlot` that selects the replay body
instead of the scan body. Port `emitSharedPrefix`'s ownership discipline **with** its reset rule and
its regression case — that miscompile is exactly the artefact worth carrying across, and it should
become a case in `test/parity/failure-diagnostics.test.ts`.

Bytes: one operand on the choice row plus one on each arm's leading terminal — tens of bytes per
`sharedPrefix` site. Speed: removes a full re-scan of the shared prefix per arm tried. Propose it.

**Also correct the comment at `encode.ts:668-676` now**, independent of any unit. As the design says,
it currently reads as though the strategy were fully accounted for and will stop the next reader
looking. That is a two-line docs change with no risk.

---

## 6. `triviaCapture` is a lattice, not a bit

**SPEED IMPACT: medium — it is a per-trivia-token cost on every css/less parse.**

§2.1 adds `triviaCapture` as **one** `RunCfg` bit, justified as "`_triviaLog`/`_rootTriviaLog`
presence is fixed before the parse". Reading what the capture tail actually touches —
`archive:src/compiler/scannable-run.ts:1612-1626` (`scanBranchLabeled`) — the fields are:

`_ctx._triviaLog`, `_ctx._rootTriviaCapture`, `_ctx._rootTriviaLog`, `_ctx._rootTriviaKindIndex[label]`,
`_ctx.captureTrivia`, `_ctx._triviaCaptureMask`, `_ctx._cstTriviaLog`, `_ctx._cstRawChildren`, and the
`_cap` parameter — which is **three-valued**, not two (`0` skip-only, `1` full CST, `2` root-log-only;
`archive:src/compiler/trivia-fast-path.ts`, and `_cap === 1` gates the CST push at :1621).

Two specific problems:

1. **One bit does not cover a 3-valued `_cap` plus six independent presence flags.** Some of these
   are per-parse-fixed and belong in `RunCfg`; `_rootTriviaCapture` is *not* — it is swapped by an
   opaque scope (`codegen.ts:4747-4751` wraps it in `try/finally`), so it is a **site** property,
   like `ctx.trivia`. The design's own §2.1 distinction applies and was not applied here.
2. **`_ctx._rootTriviaKindIndex?.[label] ?? -1` is a string-keyed map lookup per trivia token**
   (:1619). Codegen left it at runtime, so this is not a regression — but it is a free selection win
   the design does not claim. `label` is a compile-time constant at every emission site; the index
   resolves at `link`.

**FIX.** Replace the single `triviaCapture` bit with: `cap` as a 2-bit `RunCfg` field (3 values);
`rootTriviaCapture` as a field of §3's site-attribute record; and resolve `_rootTriviaKindIndex[label]`
to an integer at `link`, so the emitted tail pushes a constant.

Speed: removes a string hash lookup and ~4 loads/branches per trivia token on labelled css/less
parses. Bytes: zero — it is fewer emitted characters, not more, because the constant replaces an
expression. **This is the cheapest speed item in the review.**

---

## 7. Two smaller coverage notes

- **`emitShapeMatch` pastes are fragments, not bodies.** They read a caller-supplied `firstChar`
  expression (:1205-1206 — "the trivia loop reads it once and shares it"), mint names into the
  caller's scope (:1191), and hand back `ok`/`end` as *variable names* (:1208). So "paste bodies are
  composed from `emitShapeMatch`" commits the piece library to a **calling convention over variable
  names**, not just a set of bodies. Worth stating explicitly in §2.3, because the `firstChar`
  sharing is a real per-token load saved and an implementer who wraps each shape in a function to
  keep things tidy will silently lose it — and will lose the paste, which is the whole unit.
- **`scanToIndexOfEnabled()` reads `process.env.PARSEMAN_SCANTO` on every emission**
  (`archive:src/compiler/scannable-run.ts:1161`, used :1495, :1574). Under the design this is a
  build-time selection, not a `RunCfg` bit — it changes emitted source, not parse behaviour. One
  line to settle in U3; flagging so it is not carried across as a runtime test into a piece body,
  which would be an `INV-6` violation on the hottest scan loop. Its default is OFF and the measured
  win is 4.3× on `until`/`delimited` (:1484-1491) — worth turning ON as part of U3 and gating on the
  identity sweep rather than leaving as an env A/B.

---

## 8. On tests, per the owner's ranking

Applying the third-place rule — the distinction is *stale encoding* vs *changed parse behaviour*:

- **Stale, do not preserve:** `bench/size-baseline.json` byte counts (U2 and U4 both break the
  ratchet by the design's own prediction; name and re-cut), and any assertion pinning
  `assemble.ts`'s internal piece structure — `nextTerm` ceases to exist under U2 by construction.
- **Not stale, these are gates:** anything comparing accept/reject, tree shape, or the `expected`
  set. §8's four instruments are the right set and the named gap is real — nothing A/Bs `expected`
  between `exec.ts` and `assemble.ts` at corpus scale
  (`bench/table-lowering-identity.ts` runs only `tableRules`). Every hole fixed above rewrites a
  failure site, so closing that gap is a genuine prerequisite for §4.4's unrolls and §5's replay in
  particular — the `1-2` → `['1','-','1']` miscompile is precisely a tree-shape divergence that a
  byte-count test would never see and an identity sweep would catch instantly.

---

## 9. The holes, ranked by speed lost

| # | hole | speed cost if unfixed | fix | bytes |
|---|---|---|---|---|
| **1** | **U3 has no mechanism before U4** (§2). `ScanShape` is recursive and every shape's win is constant-folded ranges; as static pieces the nine bodies reproduce `inRanges`. | **The entire css/less trivia term** — the design's own predicted 150–300 points. U3 as scheduled delivers ~nothing. | Reorder U4 before U3; or ship U3′ = `litFold` + `indexOf`-backed `until`/`delimited` only. Port the classifier half early regardless — it is U4-independent and it is the expensive half. | 0 (reordering) |
| **2** | **The cutoff rule as written excludes all nine shapes** (§1). | Blocks U3 by definition; misroutes every future shape decision. | Restate as *self-contained* — no piece call, no allocation, `end === start` on no progress. Branching and builtin calls are fine. | 0 |
| **3** | **No inherited-attribute axis** (§3). Nine facts codegen pushed down; the design handles one. | Blocks §5 (`sharedPrefix` scan-once), §4.1 (`OP_ADJ`), §4.3 (`OP_ATTEMPT` double rollback), and the 4-way CST leaf shape. | Generalise the proposed trivia site label into a packed site-attribute record; same downward encoder pass. | **0 over U2's existing operand budget** — the fields pack into the one int U2 already spends |
| **4** | **`OP_LIVE` / `OP_GUARD` / `OP_ARMGATE` block U4 emission** (§4.2). Invisible on json, which has zero. | U4 — the largest predicted win, 40–60% of json's floor — is unavailable for any grammar using `gate()`. | `link` binds live rows to interpreter pieces; the module takes them as a parameter instead of printing them. Strictly better than codegen's whole-artifact disable. | +1 param/module |
| **5** | **`triviaCapture` is one bit for a 3-valued `_cap` + 6 flags; `_rootTriviaKindIndex[label]` is a per-token string lookup** (§6). | ~4 loads/branches **and a string hash per trivia token** on labelled css/less. | 2-bit `cap` in `RunCfg`; `rootTriviaCapture` to the site record; resolve the label index at `link`. | **negative** (constant replaces expression) |
| **6** | **`OP_GREEDY` / `OP_REJECT` unaccounted** (§4.4). Both auto-selected by `choice()`, both on the css/less keyword path; `OP_REJECT` walks an array on the parse path, violating the design's own `INV-7`. | Per-arm string-equality loop + per-arm array walk on every keyword decision. | Add a **choice-strategy axis** (5 values, all already in the tree); unroll `autoNot` checks into the arm body. | +100–300 B on `example/css` |
| **7** | **`OP_ADJ` in the paste bucket** (§4.1). | Not primarily speed — **silent wrong output** if U2 hands it a post-scan position. | Third value in U2's trivia enum (§8b.1 already recommends making it an enum). | 0 |
| **8** | **`sharedPrefix` replay** (§5). | Full prefix re-scan per arm tried. Unquantified; the design correctly declines to invent a number and so do I. | `replaySlot` in the site record; port the ownership/reset discipline **and** the `1-2` regression case. | tens of B per site |

**Holes 1–3 are one story.** The taxonomy's two buckets and three axes are sound for what they
cover, and the option and arity axes survive the full inventory unchanged. What is missing is that
the third axis was drawn from the child's *own* opcode, when codegen's emission was equally a
function of what its ancestors told it. Adding the inherited axis costs one encoder pass the design
already proposes for trivia, and it is what makes `sharedPrefix`, `OP_ADJ`, `OP_ATTEMPT` and CST leaf
capture expressible at all.

**And the sequencing correction is the single highest-value change to the plan**: U3 before U4 is not
an ordering preference, it is a unit scheduled ahead of the mechanism it requires.

---

## 10. What I could not check

Stated so the next lens does not assume this was covered.

- **No execution.** §9.1's feedback-vector falsification (`--trace-turbo-inlining`) is untouched, and
  it remains the highest-value single check in the design. §9.3 I confirmed *statically* (§4.5); it
  did not need running.
- **I did not read all of `assemble.ts`** — I read the opcode set, `encode.ts`'s choice encoding, and
  `trivia-skip.ts`'s scanner surface. The design's own §9.6 admits the same gap. U0's extended
  checker remains the right instrument and the argument for landing it first is untouched by
  anything here.
- **No magnitude claims.** Every "speed cost" above is a mechanism, not a measurement. Where the
  design declines to invent a number (§5's `sharedPrefix`), so do I.
