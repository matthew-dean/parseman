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
- For an ASCII case-insensitive keyword (CSS at-keywords, function names, units —
  case-insensitive PER SPEC), pass the option:
  `word('media', 'A-Za-z0-9_-', { caseInsensitive: true })`, never `regex(/media/i)`.
  Its first-set is ASCII case-FOLDED, so the arm still gates.
- A separated list of ONE OR MORE is `oneOrMoreSep(item, sep)`, **not** `sepBy`.
  Plain `sepBy` is `(item (sep item)*)?` — it MATCHES THE EMPTY STRING, which makes
  the arm nullable and kills the whole choice's dispatch. Reach for `sepBy` only
  when the empty list is genuinely legal.
- Need a positive lookahead? `peek(X)` — zero-width, and it CARRIES X's first-set,
  so `sequence(peek(regex(/[.#]/)), broadThing)` still first-char-dispatches.
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
  automatic; just lead with the terminal — and where a real positive lookahead IS
  needed, use **`peek(X)`**, which is zero-width like `not(not(X))` but carries X's
  first-set instead of poisoning dispatch. (Warning: `anti-pattern [double-not]`.)
- DON'T lead a `choice` arm with `not(...)`. `not()`'s first-set is `any` and
  poisons the whole choice's dispatch. Keep `not(...)` as a TRAILING boundary
  (`sequence(literal('true'), not(/\w/))`). (Warning: `anti-pattern [leading-not]`.)
- DON'T lead a `choice` arm with `optional`/`many`/`gate`/`guard`/plain `sepBy` —
  all are NULLABLE and widen the first-set. Put a concrete terminal first, or use
  the non-nullable form (`many(x, { min: 1 })` / `oneOrMore`, `oneOrMoreSep`).
- DON'T put a leaf-only "fast path" arm ahead of a structured one that builds the
  SAME `node()` type. On every input both accept, the fast path wins and yields
  that node over bare leaves — the parse succeeds, the span is right, the text
  round-trips, and only the TREE moved, so no test and no output diff reports it.
  Either the structured tree is the contract (delete the fast arm) or the flat one
  is (make it flat for every input of that shape). (Warning:
  `BUG [structure-loss]`, from `analyzeDuplication`.)
- DON'T wrap a spaced region in `noTrivia` and hand-roll `optional(ws)` back in to
  exclude comments. `noTrivia` clears trivia, so a matched `regex(/\s+/)` is
  CONTENT — the whitespace lands in the node's children as a value leaf. An inner
  trivia scope says it in one place: `parser({ trivia: wsOnly }, …)` (innermost
  wins). Reach for `noTrivia` only for a genuinely GLUED run.
- DON'T reach for `ctx.state` (`withCtx`/`gate`) when structure (separate rules),
  a document option, or recursion/`balanced` would express the distinction. See
  `docs/guide/context.md` § "Which tool".

## The two lookaheads

Both are zero-width — they assert and consume nothing.

- **`not(X)`** — NEGATIVE lookahead (PEG `!X`). Succeeds when X does NOT match.
  Its first-set is `any` (it cannot know what it forbids), so keep it as a TRAILING
  boundary, never leading an arm.
- **`peek(X)`** — POSITIVE lookahead (PEG `&X`). Succeeds when X DOES match. It
  carries X's first-set, so a LEADING `peek()` is fine — it narrows the arm's first
  chars instead of widening them. (A nullable X constrains nothing and reports
  `any`.)

## The four repetition combinators

Named combinators are sugar for the common option combinations. Opts are LAST on
all four; `min`/`max` count ITEMS, and `trailing` is separated-only (it is
meaningless without a separator).

| | nullable (min 0) | non-empty (min 1) |
|---|---|---|
| plain | `many(item, opts?)` | `oneOrMore(item, opts?)` |
| separated | `sepBy(item, sep, opts?)` | `oneOrMoreSep(item, sep, opts?)` |

- `oneOrMore(x)` **is** `many(x, { min: 1 })`; `oneOrMoreSep(i, s)` **is**
  `sepBy(i, s, { min: 1 })` — the same combinator, not a lookalike.
- `{ min: n }` is what makes a repeat NON-NULLABLE, which is what lets an arm led
  by it gate. `{ max: n }` never affects nullability.
- `{ trailing: 'forbid' | 'allow' }` (default `'forbid'`) decides what happens to a
  separator with no item after it: leave it for the enclosing rule, or consume it.
  There is deliberately no "require a separator after EVERY item" mode — that is not
  a separated list (n separators for n items, not n-1). Spell it
  `many(sequence(item, term))`.

## Naming

- `gate(predicate)` is the state-assertion combinator (formerly `guard()`, kept as
  a deprecated alias). Its name matches the `gate:` field on a gated choice arm:
  **arm field = SELECT a branch; `gate()` combinator = ASSERT a predicate.**

## Where the options object goes

**Opts go FIRST when they configure a SCOPE; LAST when they modify THIS
combinator.**

- Scope (opts first): `rules(opts, factory)`, `parser(opts, root)`. The config
  governs everything inside, so it reads as a preamble.
- Local (opts last): `literal(v, opts?)`, `word(s, boundary?, opts?)`,
  `keywords(words, opts?)`, `scanTo(sentinel, opts?)`, `balanced(open, close,
  opts?)`, `node(c, build?, opts?)`, `many`/`oneOrMore`/`sepBy`/`oneOrMoreSep`.
  Note `node` puts opts AFTER its `build` callback — "callbacks trail" is not the
  rule; scope-vs-local is.

Practical test for a new signature: **does omitting the opts still leave a sensible
call?** If yes → trailing sugar, opts last. If the config is the point of the
wrapper → opts first.

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
