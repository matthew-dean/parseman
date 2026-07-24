# Parseman grammar authoring — rules for LLM agents

Crisp, machine-readable rules for writing FAST, CORRECT parseman grammars. These
target the mistakes LLMs actually make (pattern-matched from other parsers). The
build enforces most of them: `compile()` emits a gating WARNING by default when you
break a rule below. Read the warning; it names the arm and the fix.

Full docs: `docs/guide/first-char-gating.md`, `docs/guide/combinators.md`,
`docs/guide/context.md`.

## The one rule that matters most: every hot `choice` must first-char-gate

A `choice` compiles to O(1) character dispatch ONLY when every arm starts with a
disjoint, finite set of first characters. Otherwise it degrades to ordered
first-match: every input position speculatively enters each arm. This is correct
but slow, and nothing but the build warning tells you.

## DO

- Use `word('kw', boundary)` or `keywords([...], { boundary })` for keywords.
  They have an EXACT first-set and gate. `word('color', '-\\w')`, not
  `regex(/color/)`.
- Use `literal('...')` for fixed punctuation/operators with no word boundary.
- Let each `choice` arm LEAD with a concrete terminal (`literal`/`word`/`keywords`/
  a narrow `regex`). First-char dispatch is then automatic.
- To pick a branch by runtime context, use the gated-arm FIELD:
  `choice({ gate: s => cond, combinator: arm }, other)`. It keeps dispatch.
- Left-factor arms that share a leading terminal: make them bare `sequence`s with
  the same first term (parseman auto-detects `sharedPrefix`), or restructure.
- Accept a deliberately non-gating choice (e.g. one with a `scanTo` recovery
  fallback) by listing its printed `id` in the gating snapshot allowlist
  (`compile(g, undefined, { gating: { level, accept: ['<id>'] } })`) — the single
  suppression mechanism. Prefer fixing the gating over accepting it.
- Use `gate(predicate)` (the ASSERT combinator) only AFTER a concrete leading
  terminal inside a `sequence`, never as a leading arm term.

## DON'T

- DON'T use `regex(/keyword/)` for a keyword → use `word()`/`keywords()`.
  (Warning: `anti-pattern [keyword-regex]`.)
- DON'T hand-roll first-char gating with `not(not(...))`. It miscompiles among
  shared-first-char sibling arms and its first-set is `any`. First-char gating is
  automatic; just lead with the terminal. (Warning: `anti-pattern [double-not]`.)
- DON'T lead a `choice` arm with `not(...)`. `not()`'s first-set is `any` and
  poisons the whole choice's dispatch. Keep `not(...)` as a TRAILING boundary
  (`sequence(literal('true'), not(/\w/))`). (Warning: `anti-pattern [leading-not]`.)
- DON'T lead a `choice` arm with `optional`/`many`/`gate`/`guard` — all widen the
  first-set. Put a concrete terminal first.
- DON'T reach for `ctx.state` (`withCtx`/`gate`) when structure (separate rules),
  a document option, or recursion/`balanced` would express the distinction. See
  `docs/guide/context.md` § "Which tool".

## Naming

- `gate(predicate)` is the state-assertion combinator (formerly `guard()`, kept as
  a deprecated alias). Its name matches the `gate:` field on a gated choice arm:
  **arm field = SELECT a branch; `gate()` combinator = ASSERT a predicate.**

## How to check your grammar

```ts
import { analyzeGating, formatGatingWarnings } from 'parseman'
console.log(formatGatingWarnings(analyzeGating(myEntryRule)).join('\n'))
// empty output = every hot choice gates. Non-empty = fix what it names.
```

`compile(myGrammar)` prints the same warnings by default. `compile(g, undefined,
{ gating: { level: 'error', accept: [...] } })` fails the build on any ungated hot
choice whose `id` is not in the accepted snapshot allowlist — use it in CI once
you've reviewed and accepted the genuinely-unavoidable ones.
