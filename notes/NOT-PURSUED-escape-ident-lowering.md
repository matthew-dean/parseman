# Not pursued: escape-aware ident run (§8k) — tried, measured, reverted

**Status: IMPLEMENTED, MEASURED, then REVERTED.** Two reasons, either sufficient:

1. **No measurable gain.** It lowered `ident`/`basicSel`/`propName` (RegExp.exec
   paths roughly halved: css 30→16, less 189→93), and was hard-differential-tested
   vs the engine (escapes / boundaries / greedy-hex / non-BMP, all passing). But a
   real CSS parse did **not** get faster (bootstrap4.css ≈ 7.9ms either way):
   V8's JIT-compiled `RegExp.exec` is already fast for these patterns, and the
   parse bottleneck is parser overhead (trivia scanning, node/CST building), not
   regex matching. Policy: a lowering that shows no gain in parseman profiling OR
   the css/less benchmarks gets thrown out.
2. **Overfitted to CSS.** The recognizer hard-coded CSS's exact escape syntax
   (`\` + 1–6 hex + optional whitespace, or `\` + one non-newline char) as a
   string constant (`CSS_ESCAPE_SRC`) plus a `matchCssEscapeClassAlt` helper —
   parseman (a general parser generator) taking on CSS-parser structure. Even if
   it had paid off, this shape doesn't belong here as written; a general
   "class-or-escape run" would need to parse the escape body generically (and
   also lower `{n,m}` bounded quantifiers), which is more than the payoff justifies.

## Contrast: what WAS kept (proven, general)

These stayed because they show real gains in the fold microbenchmark AND are
general (not CSS-shaped):

- **bit-OR case fold** — `(c | 32) === lower` for ASCII letters (~1.8× vs the
  two-compare form).
- **switch-dispatch** for an alt-of-litFold and for disjoint scannable alts
  (~2.4× vs the ordered/if-else chain) — a general dispatch improvement.
- **`/i` keyword+boundary lowering** — `<literal-or-alt>(?![boundary])/i` (the
  regex form of `makeWord`); general, not CSS-specific.

None of those moved the *css/less full-parse* benchmark either (same reason: the
bottleneck isn't regex matching) — they're kept on the strength of the
microbenchmark gain + generality + being optimizations of pre-existing paths.

## If revisited later

The original design (escape-aware `run` SeqPart: class-char OR `\`+escape scan
loop) is sound and was correct in tests — see git history for commit
`feat(scannable): lower escape-aware ident runs (§8k)` and its revert. But do NOT
re-add it CSS-specifically, and only if a real parse benchmark shows it pays.
