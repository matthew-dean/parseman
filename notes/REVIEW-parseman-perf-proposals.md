# Review — jess `parseman-perf-proposals.md` vs parser-thing PERF ideas

Reviewer pass over `~/git/oss/jess/docs/future/parseman-perf-proposals.md`, cross-checked
against `notes/PERF_IDEAS.md` + `notes/INTERPRETER_PERF_IDEAS.md` and the live trivia source
(`src/combinators/trivia-skip.ts`, `src/cst/trivia-kinds.ts`, `src/cst/trivia-entries.ts`).


---

## STATUS CONVENTION (repo-wide, adopted 2026-08-07)

`LANDED` · `MEASURED-NULL` · `REJECTED` · `QUEUED` · `UNMEASURED` · `REFERENCE`.
Definitions and the repo-wide picture: `PERF_IDEAS.md` § STATUS CONVENTION AND
COUNTS. Strikethroughs and "partial ✅" are retired; a compound item carries one
marker per part. `UNCLASSIFIABLE` is used where an item genuinely does not fit,
with the reason stated — it is not a sixth bucket, it is an admission.

## COUNTS — 8 items

| marker | count |
|---|---:|
| `LANDED` | 2 |
| `REJECTED` | 3 |
| `QUEUED` | 2 |
| **`UNMEASURED`** | **1** |
| `UNCLASSIFIABLE` | 1 |

> ### **Untried in this file: 3 — and 2 of the 3 are already tracked elsewhere.**
> - `2.1` collapse `children`/`rawChildren` when no trivia captured — `QUEUED` = **`PERF_IDEAS.md` U-29**
> - `2.2(b)` per-call-site skip-only vs skip+log — `QUEUED` = **`PERF_IDEAS.md` U-30**
> - *One cheaper alternative worth pricing first* — a range query (binary search on the flat global log) filtered to comment kinds, needing **no new capture mode at all** — `UNMEASURED`, **file-local, not in any other backlog.** The file's only concrete finding on it is that the source doc's zero-cost premise is false: "So 'just read the free global log' isn't free as stated."

**Per-item markers.** `2.1` `QUEUED` (= U-29; the file's "Real, but oversized"
means *do it, bank it as allocation/GC, not wall-clock*) · `2.2` **`UNCLASSIFIABLE`
as one row** — the file itself splits it: **(b)** `QUEUED` (= U-30), **(a)**
`REJECTED`, and note *why* (a) is rejected, because it matters: it is
pre-discounted by analogy to a *class* of micro-tweak measured neutral-to-negative
twice, not by a measurement of this tweak · `2.3` single-frame node-scope
save/restore `REJECTED` — the file schedules it last and prototype-gated, but the
grounds cited are two prior measured regressions of the analogous shape
(+50%, +32–47%), so honest reading is queued-to-be-killed · `2.4` declarative
host-capture descriptor `REJECTED` *as a perf item* (memoized, not hot), retained
as hygiene riding along with 2.1 · `2.5` comment-lift and `## The trivia/comment
concern` (its reshape into a kind-filtered capture) are both **`LANDED`** — they
shipped as `_triviaCaptureMask` / `triviaKindMask`; see `PERF_IDEAS.md`
"Already landed" · `idea #5` (trivia-call elision by a no-trivia-possible proof)
`REJECTED` — its home is `PERF_IDEAS.md` §5 / Q-40 #3, where it was scoped and
deprioritized · `## Recommended re-ordering` and `## Corrections to fold back into
the jess doc` are `REFERENCE` (a priority ordering and five documentation-edit
instructions against another repo's file; neither is a proposal).

> ### PROVENANCE WARNING FOR THIS FILE
> **Its code citations are rigorous and its measurement citations are not**, and
> that asymmetry is the file's most notable property. Every number in it is a
> second-hand citation with no fixture, harness, command or commit: "~7% alloc /
> 0% time", "+50%", "+32–47%", "−52%", "8.6% host cost", "the 10× work". Source
> references (`trivia-skip.ts:89`, `node.ts:129/132`, `src/cst/trivia-kinds.ts`)
> are precise and can be trusted. **Quote the file for what the code does, never
> for what it costs.**

## TL;DR verdict

| # | Proposal | Win? | Reconciliation with parser-thing evidence |
|---|----------|------|--------------------------------------------|
| 2.1 | Collapse `children`/`rawChildren` when no trivia captured | **Real, but oversized** | It's the same insight as parser-thing idea **#2** ("skip raw-child bookkeeping for builders that ignore `rawChildren`"), which is graded *cheap, broad* — NOT "highest value". Dead-value elision (removed 33% of value arrays) already measured **~7% alloc / 0% time**. Do it, but bank the win as *allocation/GC*, not wall-clock. |
| 2.2 | Fused trivia-skip + first-token dispatch | **(b) yes, (a) speculative** | (b) skip-only vs skip+log split aligns with the landed `cap`-flag work and idea **#5**. (a) fusing the post-`_tf0` `charCodeAt` is exactly the micro-tweak class parser-thing measured *neutral-to-negative* twice (inline-vs-hoist charCodeAt). Measure (a) with low expectation; **idea #5 (elide the trivia call entirely where grammar proves no trivia can intervene) is the better lever** and isn't in the jess doc. |
| 2.3 | Single-frame node-scope save/restore | **Likely neutral-or-worse** | The spread is *already gone* (landed: "mutate `_ctx` fields instead of spreading"). What's left is 6 field writes. Bundling into a frame object/stack is precisely the shape parser-thing **rejected twice** (runtime-helper prelude +50%, inline lazy buf +32–47%; "eager `[],[],[]` remains faster — branchy indirection costs more than the alloc"). Keep it prototype-gated and be ready to bin it. |
| 2.4 | Declarative host-capture descriptor (drop `_hostReads` reflection) | **Cleanliness, not perf** | Doc already says memoized→not hot→bundle only. Agreed. Fine as hygiene riding along with 2.1. |
| 2.5 | Comment-lift without the whitespace-capture regression | **Real win — but reshape the API** | This is the one the owner flagged. The win is genuine and achievable *at full scan speed*; the "comment-only capture **mode**" framing is the overfit. See below. |

## The trivia/comment concern — you're right, and the fix is cleaner than the proposal

Your instinct is correct, and parser-thing's own `PERF_IDEAS.md` already carries an
owner-flagged design note saying the same thing ("**Design note: Trivia API — don't overfit
`hasComment`**", end of the file). Proposal 2.5 as written walks straight into that note: it
proposes a per-node **"comment-only capture mode"** with a hardcoded `kindIndex === blockComment`
branch. That bakes today's `ws|comment`-only grammar assumption into the capture primitive.

Here's the thing though — **the generality already exists in parseman, so the overfit is
avoidable at zero cost to the win.** Grounded in source:

- Trivia is already **kind-labeled**: `label(name, parser)` on trivia arms records per-chunk
  `kindIndex`, and `triviaEntries()` (`src/cst/trivia-entries.ts`) exposes `kind(i)`/`kindIndex(i)`
  over a `labels` array. Comments are not special — they're just one label.
- There is already a **fast labeled scanner** — `tryFastLabeledScan` /
  `scanFastWsCommentsChunks` (`src/cst/trivia-kinds.ts`) — that keeps `charCodeAt` speed *and*
  emits per-chunk kind indices. So capturing kinds does **not** inherently cost the −52% fast
  trivia loop.

**What actually caused the jess-side regression (precise mechanism, from `trivia-skip.ts`):**
enabling per-node capture flips two switches. (1) `scanTrivia` routes through
`scanWithLabels` → `recordTriviaChunks`, which **allocates a chunks array per gap and records
every chunk — including every whitespace run** (the "10× work"). (2) Note line 89:
`const fast = !ctx.triviaKindLabels ? fastTriviaScanner(triviaP) : null` — with kind labels on,
the plain fast path is bypassed. So the regression is **recording volume + per-gap allocation**,
not scanning — and `scanFastWsCommentsChunks` already tells ws chunks from comment chunks by
`kindIndex`.

**So the right shape of 2.5 is a *kind-filtered* capture, not a comment mode:**

- Host advertises *which kinds it wants logged* (a kind-set / small predicate), defaulting to
  "all" (today's behaviour). The scanner still runs at full `charCodeAt` speed; it just
  **skips the push for chunks whose kind isn't wanted**. Whitespace overhead disappears because
  ws chunks aren't recorded, not because "comment" is special-cased.
- Comments fall out as `kinds ⊇ {blockComment, lineComment}`. Line comments come along for free
  — the `blockComment`-only branch in the proposal would have silently dropped them, which is
  exactly the lossy-bit failure mode the owner note warns about.
- This composes with 2.2(b)'s "skip-only vs skip+log per call-site" split — kind-filtered
  capture *is* the fine-grained version of that flag.

Same measured win the doc claims (recovers most of `_liftStandaloneComments`' 8.6% host cost,
no whitespace-capture regression), but the primitive stays general and forward-compatible with
trivia kinds the grammar doesn't emit yet.

### One cheaper alternative worth pricing first

The doc's own "companion" — consume the trivia log at `build()` time instead of a new per-node
capture — is *architecturally* the cleanest (no per-node capture path at all): `build` is called
inline at each `node()` return (`src/combinators/node.ts:129/132`), so the log is already
complete for that node's own `[start,end]` range. A range query (binary search on the flat log)
filtered to comment kinds would need no new capture mode whatsoever.

**Caveat — the doc overstates this one.** It claims the global log "is populated at zero added
cost regardless." Source says otherwise: the global `_triviaLog` is **opt-in**
(`needsDeferredTriviaCommit` is false unless `_triviaLog`/`_cstBuf`/`_cstTriviaLog` is set), and
turning it on re-enables the same deferred-commit + record-every-chunk machinery. So "just read
the free global log" isn't free as stated. If you go this route, the global log still needs the
kind-filtered recording above to avoid logging all whitespace — at which point it's the same
core change, just keyed to the global log instead of a per-node view. Either target works; the
**kind-filter is the load-bearing part**, not where the filtered log lives.

## Recommended re-ordering

1. **2.5, reshaped as kind-filtered trivia recording** (general, not comment-only). Highest
   *host-side* payoff (the 8.6% `_liftStandaloneComments`), directly answers the scold-the-agent
   motivation ("the fast Parseman thing must exist so nobody hand-rolls a comment scan"), and the
   fast labeled scanner to build on already exists.
2. **2.1** (collapse dual child arrays) — low risk, real *allocation/GC* win; don't promise
   wall-clock. Fold **2.4** in as hygiene.
3. **2.2(b)** (per-call-site skip-only vs skip+log) + evaluate **idea #5** (elide the trivia call
   where grammar proves no trivia can intervene) — likely a bigger `_tf0` lever than 2.2(a).
4. **2.2(a)** and **2.3** last, both prototype-gated and both fighting prior negative
   measurements — land only if the A/B is genuinely neutral-or-better.

## Corrections to fold back into the jess doc

- 2.5: reframe "comment-only capture mode / `kindIndex === blockComment`" → **kind-filtered
  capture** (host-specified kind-set; comments = `{blockComment, lineComment}`). Cite the
  existing labeled-kinds machinery + owner design note.
- 2.5 companion: strike "global log is populated at zero added cost regardless" — it's opt-in and
  carries recording cost when on (`trivia-skip.ts` `needsDeferredTriviaCommit`).
- 2.1: temper "highest-value / halves cost" → "low-risk allocation/GC win; measured sibling
  (dead-value elision) gave ~7% alloc / 0% time — expect GC relief, not speed."
- 2.3: note the spread is already eliminated; the remaining target is 6 field writes, and
  frame-object indirection is in the twice-rejected class — highest regression risk of the five.
- Add idea #5 (trivia-call elision by no-trivia-possible proof) as a peer to 2.2.
