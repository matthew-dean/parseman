# Layered "C+B" error recovery

A layered recovery model gated behind a run-level `tolerant` flag. The default
(strict) path is completely untouched: recovery is a **cold path** that runs only
when a list element fails, and only when `ctx._tolerant` is set.

## Two layers

- **C — local structural inference (free, no annotation).** The sync point (where
  to resume after a bad element) is derived from the immediate enclosing combinator:
  - `sepBy(elem, sep)` always knows its **separator** — the natural resync token.
  - A list nested inside a `sequence(open, body, close)` learns the **enclosing
    delimiter** because `sequence`, in tolerant mode only, publishes the first-set of
    its *following* terms into `ctx._sync` while parsing each term. The inner list
    reads `ctx._sync` and resyncs to it. No global FOLLOW-set fixpoint — purely the
    local sequence's own next-term first-set.
- **B — external override.** Recovery policy never rides on the combinators. There is no
  inline `{ recover }` hint; the grammar is pure structure. Where inference is too coarse
  or an editor wants richer behaviour, the [`languageService`](./guide/editor-integration)
  layer wraps the grammar with a config keyed by rule name — outside the grammar entirely.
  Inference (C) covers the list shapes an editor cares about; the service layer is where
  domain policy lives.

## API (all additive)

- `RunOptions.tolerant?: boolean` — run-level gate. Sets `ctx._tolerant = true`.
  Default unset ⇒ strict, byte-identical to today.
- No new option on `many`/`oneOrMore`/`sepBy` — their signatures are unchanged. Sync is
  inferred from structure; recovery is engaged only by the run-level `tolerant` flag.
- `completionsAt(target, input, offset, { tolerant? })` — `target` is an interpreter
  combinator or a `compile(g, { recovery: true })` grammar; `tolerant: true` engages
  recovery so a failure at the cursor is recorded even when a permissive top rule would
  otherwise "succeed" with an unconsumed tail.
- New `ParseContext` fields (framework-internal): `_tolerant?: boolean`,
  `_sync?: Combinator<unknown> | undefined`.
- Error node: the **existing** `ParseError` (`_tag: 'parseError'`, `span`, `expected`),
  pushed to `ctx._errors`, placed in the result array, AND — when a CST host is active —
  embedded as a `parseError` child in the tree (via the shared `_rec.capture`, so
  interpreter and compiled emit identical trees). Having the error IN the tree is what
  lets an incremental `parseDoc` document carry diagnostics across edits.

## Mechanics

- **Shared cold scan** (`recover-scan.ts`): scan forward from the failure position
  until the sync sentinel matches (or EOF), emit a `ParseError` over the skipped span,
  push to `ctx._errors`. During the scan `ctx._probe` is suppressed so probing the
  sentinel does not pollute `completionsAt`'s furthest-failure set.
- **Loop guard (must consume ≥1 token):** `many` breaks (no error) when the sync
  matches at the current position — that is a clean list end, not junk — otherwise the
  scan advances ≥1 char, guaranteeing progress. `sepBy` progress is driven by the
  separator: a zero-width error is emitted for a missing element (`a,,b`) and the next
  iteration consumes the separator, so it can never spin.

## Adversarial invariant check

1. **Strict byte-identical.** Every new behavior sits under `if (ctx._tolerant)`, which
   is unset on the default path. The strict loops of `many`/`oneOrMore`/`sepBy`/`sequence`
   are literally the previous code. *Threat:* accidentally reordering the strict loop →
   avoided by adding the tolerant branch at the existing failure/break points only.
   (Every prior test stays green with no change to its expectations except the tests of
   the removed list-recovery combinators, which are deleted; their behavioral coverage is
   re-expressed against the C+B API in `test/unit/recovery.test.ts`.)
2. **Zero happy-path cost.** Strict: one added boolean check (`ctx._tolerant`) on the
   cold failure/break edge — no per-token work. Tolerant mode adds `_sync` save/set/restore
   per `sequence` term (cheap, comparable to the existing `ctx.trivia && i>0` per-term
   check) and nothing per element until an element fails. *Honest note:* tolerant mode is
   the editor path; the strict compiler path is the one held to "one cold branch."
3. **Additive.** New optional options/fields/exports; no existing signature changes.
   The `_def` shape is unchanged — the B hint rides the closure, not `ParserDef`, so the
   compiler is unaffected.
4. **`.edit()` ≡ full-reparse oracle.** Untouched: the incremental suite runs strict; the
   new fields default-off. *Threat:* a stray field on the hot path → none added to the
   strict path.
5. **Typecheck/lint clean, no `as any`.** New code uses typed guards.

## Surface

List recovery is the `tolerant` run flag plus the **inferred** sync on
`many`/`oneOrMore`/`sepBy` — no inline hints; external policy lives in
[`languageService`](./guide/editor-integration). `isParseError` is the
guard for the emitted error nodes. `expect` (required-token, in-place) and
`scanTo`/`balanced` remain distinct primitives — they are not list recovery.

Tolerant recovery + the completions probe run on **both** paths. The interpreter path
is always available. The compiled (`compile()`) path emits them under an opt-in gate —
`compile(g, { recovery: true })` (or the `parseman({ recovery: true })` macro option) —
so the published compiled artifact recovers and answers completions on the fast path,
while a default compile emits **zero** recovery code (byte-identical, macro-inlinable).
The compiled path reuses the exact interpreter recovery functions via `ctx._rec`, so
the two are byte-for-byte at parity. See [Editor / language-server integration](./guide/editor-integration).
