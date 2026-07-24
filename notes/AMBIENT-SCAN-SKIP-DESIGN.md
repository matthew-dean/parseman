# Ambient scan-skip — closing the raw-`scanTo` footgun class

Status: proposal + implementation (branch `feat/ambient-scan-skip`, off `main` @ 0.32.0)

## The footgun

`scanTo(sentinel, { skip })` walks the input one char at a time looking for
`sentinel`, taking a `skip: Combinator[]` list to jump over "opaque" regions
(strings, comments, balanced brackets) so their contents are never mistaken for
the sentinel. The `skip` list is **opt-in per call site**. Authors forget it, and
the scan then matches a sentinel that lives inside a string or a comment.

Confirmed instance: jess `less-parser` `directFunctionConditionAhead`
(`grammar.ts:2021`) scans a value looking for a boolean operator and matched the
`or` **inside the quoted string** `"@{u} or x"` — so `error("@{u} or x")` failed
to parse. Every raw `scanTo` (27 across the four jess grammars) is a latent
instance of the same bug class.

## Root observation — trivia is already ambient; scan-skip is not

Whitespace/comment trivia is **not** opt-in per call. It is declared once at the
grammar level (`rules({ trivia }, factory)`), stamped onto every rule's
`_meta.grammarTrivia` (`parser.ts:108-116`), threaded into `ctx.trivia` at every
parse entry (`grammar.ts` `parse()`, `functional/run.ts`, `parser()` scope,
language-service, `doc.ts`), and baked as the seed `activeTrivia` in the compiled
path (`codegen.ts` grammar-seed sites). Sequence/repeat/sepBy consult `ctx.trivia`
automatically between terms. "Set once, inherited everywhere."

The fix mirrors that pattern for scanning. Two layers, kept as **separate
categories** because they mean different things:

- **trivia** = insignificant *everywhere* (skipped between terms already).
- **scanSkip** = significant, but *atomic during a scan* (a string is a value, but
  a `{`/`or`/`,` inside it must not be seen while scanning to a sentinel).

## Layer 1 — `scanTo` skips ambient trivia by default

The scan loop consults the already-ambient `ctx.trivia` (interpreter) /
`activeTrivia` (compiled) as an implicit leading skipper. Nearly free — reuses the
existing threaded value; no new plumbing on the trivia side.

- Whitespace trivia: **byte-identical**. `scanTo` returns `input.slice(pos, cur)`
  and `cur` is a position; skipping a whitespace run atomically lands `cur` at the
  exact same offset as walking it one char at a time. The returned text is
  unchanged.
- Comment trivia: a sentinel hidden inside a comment is no longer matched — the
  intended fix. Only inputs that previously mis-stopped inside a comment change.

## Layer 2 — ambient `scanSkip` for opaque non-trivia units

New grammar-level declaration, mirroring `trivia` exactly:

```ts
rules(g => ({ ... }), { trivia: rw, scanSkip: [stringLit, balanced('(', ')'), balanced('[', ']')] })
```

- New `RulesOptions.scanSkip?: Combinator[] | null`.
- Stamped onto every non-trivia rule's `_meta.grammarScanSkip` in `rules()`
  (mirrors the `grammarTrivia` loop; `null`/absent stores nothing).
- New `ParseContext.scanSkip?: Combinator[]`, seeded from `grammarScanSkip` at
  the same entry points that seed `ctx.trivia`.
- New codegen `Ctx.activeScanSkip`, seeded at the same grammar-seed sites that
  seed `activeTrivia`, so the compiled path bakes the same list.

## Effective skip resolution (identical in both paths)

Explicit per-call `skip` **extends** the ambient default (it does not replace it):

```
raw === true → []                                       (hard opt-out)
else         → [ ...ambientTrivia?, ...ambientScanSkip?, ...explicitSkip ]
```

- `ambientTrivia?` = `ctx.trivia` (one entry) when present; `ambientScanSkip?` =
  `ctx.scanSkip` (the grammar's opaque-unit list) when present.
- The sentinel is still checked **before** any skipper each iteration, so a
  sentinel that also starts a skip region wins (unchanged priority). This is what
  protects the sites where a comment is itself a scan *sentinel* (e.g. CSS
  at-prelude stop): at a comment the sentinel matches first, so ambient
  trivia-skip never fires there.

Why **extend**, not replace: the audit showed per-site skip lists vary — some are
deliberately narrower (comment used as a sentinel), and no site ever wants to scan
*into* a string. So the always-safe ambient set is **strings** (never a sentinel
in any dialect) plus **trivia** (already ambient). Making those apply everywhere,
with each site appending only the extra balanced/interpolation units its scan
needs, is byte-identical for every already-safe site AND closes the footgun for
the bare/under-skipped ones — without a single default having to reproduce every
site's exact list.

### The `raw` opt-out

`scanTo(sentinel, { raw: true })` restores the pre-0.33 byte-walk: no trivia, no
scanSkip, no skip. For the rare site that genuinely wants to scan through
comments/strings literally. The audit found no such site (the one raw-scan site,
less ast:2021, is a bug).

## `balanced()`

`balanced(open, close)` builds its interior eagerly (`many(choice(self, ...skips,
contentRun))`, with the content regex's negated class derived from the skip
first-sets) so its predictive no-char-walk interior can be compiled to plain
combinators. That eager construction happens inside the grammar factory, *before*
`rules({ scanSkip })` options are applied, so a bare `balanced()` cannot see the
ambient list at build time, and it has no `scanTo`-style def tag the codegen can
re-resolve.

Decision:
- **Interpreter**: `balanced()` with no explicit skip consults `ctx.scanSkip` at
  parse time (rebuilds+caches its interior against the ambient list on first use).
- **Compiled / eager path**: a bare `balanced()` bakes no skip. jess `balanced`
  call sites therefore pass the **shared `SCAN_SKIP` const explicitly** — the same
  array they hand to `rules({ scanSkip })`, so it is a named reference, not a
  duplicated literal, and carries zero redundancy. `scanTo` is the site class the
  footgun is actually about (all 27 raw sites + the bootstrap bug), and it is
  fully ambient in both paths.

This keeps the guarantee where it matters (every `scanTo`, both paths) without a
new deferred-construction combinator, and is flagged for the owner.

## Version

New ambient option (`scanSkip`) **plus** a default-behavior change (`scanTo` now
skips ambient trivia). Under the repo's pre-1.0 convention that a default-behavior
change is a minor, this is a **0.33.0 minor**, not a fold into the unreleased
0.32.0. Flagged for the owner — do not decide unilaterally.

## Byte-identity contract for the jess migration

Every currently-passing corpus fixture stays byte-identical. The only intended
behavior change: bootstrap-class inputs that currently ERROR (sentinel hidden in a
string/comment) now parse. Proof case: `error("@{u} or x")` /
`bootstrap-less-port/_rfs.less`.
