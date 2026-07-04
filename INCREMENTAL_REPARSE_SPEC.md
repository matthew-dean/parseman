# Spec: incremental reparse-and-resync for Parséman

## Goal

After a source edit, reparse **only the affected region** and **reuse untouched subtrees**
from the previous parse, instead of reparsing the whole document. Match the correctness of a
full reparse exactly, while doing meaningfully less work for a localized edit.

Correctness oracle (non-negotiable): for **any** old source + **any** edit, the incremental
result must be **structurally identical** to a full reparse of the new source (same tree
shape, same node types, same spans, same leaf values). Tests must assert this by deep-equality
against a fresh `parse(newSource)`.

## What already exists (build ON these — don't reinvent)

- **Per-node `state`** (`CSTNode.state`): "shallow clone of `ctx.state` at the moment this
  node's parse began — the re-entry point for incremental re-parsing. Only meaningful when
  `ctx.state` is primitives-only." This is the resume key.
- **`span` / offsets** on every node and leaf (`src/types.ts` `Span`).
- **The relative-spans model** (`src/cst/relative-spans.ts`): `relativize` / `absolutize` /
  `absoluteSpanAt` / `applyEdit(root, at, delta, stats)`. `applyEdit` shifts a relative tree
  after an edit while sharing every unaffected subtree by identity — use it to reposition the
  reused suffix so you never renumber offsets by hand.
- **The offset model** (`src/cst/offset-model.ts`): `OffsetIndex`, gap queries — useful for
  locating boundaries.
- Parser internals: `src/combinators/grammar.ts` (`parse`, `parser`), the combinator set, and
  the CST shape in `src/cst/types.ts` (`CSTNode { children, span, state }`, `CSTLeaf`, etc.).
  **Read these first** to learn how `parse` runs, how `ctx.state` is captured/threaded, and
  whether the driver can resume mid-stream.

## Edit model

`Edit = { start: number, deleted: number, inserted: string }` → `delta = inserted.length - deleted`.
New source = `old.slice(0,start) + inserted + old.slice(start+deleted)`.

## Algorithm (staged — land each stage green before the next)

**Stage 0 — reuse prefix + suffix only (simplest correct win).** Reparse the whole document
but splice in reused leaves/subtrees that are entirely before the edit (offsets unchanged) and
entirely after (offsets shifted by `delta`). Even without resuming the parser mid-stream, prove
the machinery: locating the edit, mapping old→new offsets, `applyEdit`-shifting the suffix.
(May be a stepping stone / correctness harness rather than a perf win.)

**Stage 1 — re-entry + convergence (the real thing).**
1. **Locate** the deepest old node whose span contains the edit range.
2. **Pick a re-entry point**: a node boundary at/before the edit whose stored `state` lets the
   parser resume. Restore `ctx.state` from that snapshot and set the input position there.
3. **Reparse forward** over the new source from the re-entry point.
4. **Detect convergence / resync**: stop when the reparse reaches a new-coordinate offset that
   maps to an old node boundary (`oldOffset + delta`) **with a matching `state`**. At that
   point splice the corresponding old subtree (offset-shifted) and stop.
5. Rebuild the tree: unchanged prefix + freshly-reparsed middle + reused (shifted) suffix.

**Stage 2 — reuse-validity under backtracking (the hard, essential guard).** A combinator/PEG
parser backtracks and looks ahead. A reused subtree is only sound if **no lookahead or backtrack
during the reparse depended on input across the edit boundary**. Track the maximum input offset
the reparse *inspected* (not just consumed); only reuse a boundary if the reparse's inspected
range stayed within it. If you can't prove it, widen the reparse region (fall back toward full).
Be conservative: correctness first, reuse fraction second.

## Deliverables

- `src/cst/incremental.ts` — `incrementalReparse(oldParse, oldSource, edit): { tree, reusedNodes, reparsedRange }`
  (and whatever internal helpers). Keep it additive; do not change existing parse semantics.
- Export from `src/index.ts`.
- `test/unit/incremental.test.ts`:
  - **Correctness fuzz**: deterministic PRNG (no `Math.random`), many seeds, random grammars +
    random edits (insert/delete/replace at random offsets), assert `incrementalReparse(...) ==
    parse(newSource)` structurally. This is the whole ballgame — make it broad.
  - **Reuse metric**: assert that for a localized edit, `reusedNodes` is a large fraction of the
    tree (i.e. we actually reused, didn't silently full-reparse). Log the fraction.
  - Edge cases: edit at offset 0, at EOF, spanning a node boundary, inside a leaf, an edit that
    changes structure (inserts `{`, a delimiter, a comment that ends a construct), empty edit.
- Update `INCREMENTAL_REPARSE_SPEC.md` with a short "Status / results" section (reuse fractions,
  what's proven, what's deferred).

## Working rules

- Work ONLY in this worktree (`/Users/matthew/git/worktrees/parseman-incremental`, branch
  `feat/incremental-reparse`). Run `pnpm install` first (worktrees have no node_modules).
- `npx vitest run test/unit/incremental.test.ts` to iterate; run the full `test/unit` suite
  before finishing to confirm no regression. Keep `npx tsc --noEmit` clean for new files.
- Commit incrementally with clear messages; author `Matthew Dean
  <matthew-dean@users.noreply.github.com>`, `--no-verify`.
- If the parser driver genuinely cannot resume mid-stream (no way to restore position+state),
  say so explicitly and deliver Stage 0 + a written analysis of exactly what parser-driver
  change would be needed — don't fake incrementality.

## Status / results

**Delivered:** `src/cst/incremental.ts` (`incrementalReparse`, exported from `src/index.ts`),
`test/unit/incremental.test.ts` (17 tests, all green; full `test/unit` suite: 54 files /
1146 tests green; `tsc --noEmit` clean).

### Driver constraint (the honest part)

The driver has **no reified continuation stack**. Every combinator's `parse(input, pos, ctx)`
runs to completion on the native JS call stack, so there is no way to resume in the *middle*
of a rule's continuation (e.g. after term 2 of a 5-term sequence — the remaining terms live on
the call stack, not in any snapshot). `CSTNode.state` snapshots only `ctx.state`
(grammar-author data), **not** the parse continuation.

The finest re-entry the driver *does* support is a **rule boundary**: a `node()` rule is a
complete, self-contained combinator, re-runnable at any position with a restored `ctx.state`.
So "resume mid-stream" is realized as **"resume at the deepest rule boundary at/around the
edit."** This is the same primitive `src/functional/doc.ts` (`parseDoc`) already uses for a
`rules()` registry; `incrementalReparse` brings it to the raw `parse(combinator, source)` CST
and **adds the Stage-2 lookahead guard that `parseDoc` lacks.**

To achieve *true* sub-rule mid-stream resume you would need to defunctionalize the driver into
an explicit CPS / continuation-stack machine (each combinator pushes a resumable frame instead
of recursing), and have `node.state` capture that frame stack. That is a full driver rewrite
and is **out of scope**; the rule-boundary strategy below is sound and gives ~98% reuse on
localized edits, so it was not pursued.

### Stages landed

- **Stage 0** (prefix/suffix reuse machinery) — subsumed: `graftAndShift` shares the prefix by
  identity, splices the reparsed middle, span-shifts the suffix by `delta`. `countShared`
  measures identity reuse.
- **Stage 1** (re-entry + convergence) — done. Locate deepest node containing the edit, re-run
  its own `node()` rule from `node.span.start` with restored `node.state`, widen through
  ancestors, accept only when the reparse ends exactly at `oldEnd + delta` (convergence).
- **Stage 2** (backtracking / lookahead reuse-validity guard) — done, via an **edit-sentinel
  probe** (`boundaryIsSafe`): re-run the candidate rule with the tail past the convergence
  boundary replaced by two distinct sentinels; if the produced node changes, some
  lookahead/backtrack read across the boundary, so the boundary is rejected and the algorithm
  widens toward a full reparse. Conservative by construction — any probe difference/failure ⇒
  no reuse. Correctness over reuse fraction.

Whenever reuse cannot be proven sound, `incrementalReparse` falls back to a full
`parse(newSource)` (`strategy: 'full'`), which is always correct.

### Correctness oracle & measured reuse

Deterministic fuzz (seeded mulberry32, **no `Math.random`**) over 3 grammars (nested bracket
lists, JSON-ish objects, flat token streams) + a lookahead grammar:

- **1300+ random-edit seeds** (400 × 3 grammars + 300 peek-grammar) — every incremental result
  is **structurally deep-equal** (tag/type/span/leaf-value) to `parse(newSource)`, or falls
  back to `'full'` when the new source doesn't parse. **0 mismatches.**
- **Localized in-value digit-edit fuzz: 300/300 converged on reentry with >50% reuse.**
- **Reuse fraction on a deep localized edit: 98.1%** (208/212 nodes reused), reparsing only the
  2-char edited region.
- On fully-random edits, reentry converges ~16–25% of the time; the rest correctly fall back to
  full (random edits frequently break structure or make the source unparseable — expected).

### Deferred

- Sub-rule mid-stream resume (needs the CPS/continuation-stack driver rewrite described above).
- Relative-spans (`applyEdit`) integration: the current graft uses absolute-span shifting
  (`graftAndShift`), which touches O(nodes-after-edit). Switching the suffix shift to the
  relative model would make the shift O(depth); left as a follow-up since it's a perf, not a
  correctness, refinement and the reuse fraction is already high.
- The Stage-2 sentinel probe re-parses the rule up to 2× for accepted boundaries (a bounded
  constant); a cheaper inline "max-inspected-offset" hook in the combinators would remove the
  extra parses but requires touching the whole combinator set (rejected as non-additive).
