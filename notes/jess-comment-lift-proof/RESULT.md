# Proof: replace Jess's hand-rolled comment scan with parseman's comment-only capture

**Question:** do the new parseman trivia-kind-filter features let Jess replace its
whitespace/comment helpers WITHOUT harming parser performance?

**Answer: yes — proven, at neutral perf.** The replacement produces byte-identical
output and neither the comment-only capture nor the log-walk lift regresses parse time —
including the whitespace-capture regression (15–25%) that killed the earlier naive attempt.

## What was replaced

`packages/css-parser/src/builders.ts` `_liftStandaloneComments` → `_scanStandaloneComments`
re-scanned `this._source` char-by-char in every Stylesheet/Ruleset body gap to find the
standalone comments to lift into `Comment` nodes (the 8.6%-self-time hotspot in the parse
profile). Now the inter-node gaps read parseman's **comment-only per-node `triviaLog`**
instead of re-scanning source. The single trailing gap still uses the source scan (run()
consumes trailing trivia with a throwaway ctx, so it isn't in the per-node log).

## How the parseman feature makes it safe

Enabling per-node trivia capture for `Stylesheet`/`Ruleset` naively logs **every whitespace
run** → the reverted 15–25% regression. The fix is the per-node-type kind filter:

- `_triviaCaptureMask` (bitmask over `triviaKindLabels`) filters the per-node CST log;
  global `_triviaLog` stays complete.
- `_parsemanTriviaKinds(type)` host hook sets that mask **per node type** — so `Ruleset`/
  `Stylesheet` capture comments-only while `CompoundSelector` still gets the whitespace it
  needs to detect a descendant combinator (`.a .b`). Scoped per node, restored on exit;
  interpreter + compiled parity.
- `commentMask = triviaKindMask(labels, labels.filter(l => l !== 'whitespace'))` keeps every
  non-whitespace kind (block + line comments), so `//` comments come along for free.

## Measurements (macro-compiled CSS grammar)

Real corpus — 220 files / 492 KB, median parse over 100 iters:

| Config | median |
|---|---|
| baseline (main parseman, re-scan lift) | 11.98 ms |
| feature parseman swapped in, mask off (unchanged behaviour) | 11.62 ms |
| **Exp 1**: comment-only capture ON for Stylesheet/Ruleset, re-scan lift kept | 11.75 ms |
| **Exp 2**: log-walk lift (re-scan removed for inter-node gaps) | 11.43 ms |

All within run-to-run noise (±0.3 ms) — **no harm**. Errors count unchanged (1, pre-existing).

Comment-DENSE microbench — 85 KB synthetic, 1600 comments, all 1600 lifted, median over 120 iters (×3 runs):

| Config | median |
|---|---|
| OLD (source re-scan) | 2.63 / 2.76 / 2.64 ms |
| NEW (log-walk from parseman) | 2.68 / 2.81 / 2.77 ms |

**Neutral** even where comments dominate — because the *current* re-scan is already well
optimized (tight `charCodeAt`, `_sameLine` scans only the small span, not O(n²)). The
parseman capture cost the log-walk adds ≈ the re-scan cost it removes.

## Correctness

Full `@jesscss/css-parser` suite: **193 passed, 17 skipped** (byte-identical AST/trivia
output). Comment-dense fixture: 1600/1600 standalone comments lifted, matching the re-scan.

## Verdict

The win is **architectural, not a speedup**: Jess stops re-deriving comment positions it
already handed parseman, which is the stated principle ("do the fast thing in parseman, don't
hand-roll in Jess") — and the new kind-filter proves that doing so costs nothing, where the
naive version cost 15–25%. If a *naive* hand-rolled scan is what's in a parser today (the
"fell off a cliff" case), this replaces it with parseman's authoritative, already-fast trivia.

Files: `jess-comment-lift-via-parseman.patch` (the css-parser diff), `comment-dense-bench.mts`
(the A/B microbench). The patch is css-parser only; less/scss share the same
`_liftStandaloneComments` and would follow identically (their trivia adds a `lineComment`
label the mask already keeps).
