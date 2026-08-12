# Grammars the way you'd write them anyway

> **DRAFT — for coordinator review.** Not published. See the "Open / unverified"
> callouts and the TODO in the last section before shipping. One section
> (**Shared leading prefixes**) describes work that is **not yet in the codebase** —
> it is a design note, flagged as such.

Most parser generators ask you to meet the tool halfway: left-factor your rules,
compute FIRST/FOLLOW sets, resolve shift/reduce conflicts, or hand-order a lexer so
the fast path is fast. Parséman's aim is the opposite — you write the grammar the
natural way, in priority order, with the alternatives spelled out plainly, and the
compiler works out the machinery that makes it fast. This page walks through the
places where "the obvious way to write it" and "the fast way to run it" are the same
thing, and names the mechanism doing the work so you can reason about its limits.

Nothing here is something you turn on. It's what `compile()` (and the macro build) do
to the grammar you already wrote.

## Ordered choice just works (PEG)

You list alternatives in the order you want them tried. First one that matches wins.

```ts
const value = choice(Dimension, Number, Color, Keyword)
```

That's the whole contract — [PEG ordered choice](https://en.wikipedia.org/wiki/Parsing_expression_grammar).
There is no separate grammar-ambiguity phase, no conflict to resolve, and you do not
have to left-factor two arms that happen to start the same way to keep the grammar
*correct*. If two arms can both match at a position, the earlier one wins, full stop.
When the arms *don't* overlap, Parséman notices and speeds things up (next section) —
but that's an optimization layered on top of semantics you already control by
ordering, not something you have to arrange by hand.

What you avoid: computing FIRST/FOLLOW sets yourself, and rewriting `choice(a·x, a·y)`
into `a·(x | y)` just to satisfy the tool. Write the arms; order them; done.

## Automatic first-set dispatch

When the alternatives in a `choice` start with **distinct characters**, trying them
in order would mean "test arm 1's first char, miss, test arm 2's first char, miss, …"
Parséman does that for you at compile time instead: it computes each arm's first set,
confirms they're pairwise-disjoint, and emits **single-code-point disjoint dispatch** —
one `input.codePointAt(pos)` read and a jump straight to the only arm that can match.

```ts
// You write ordinary ordered alternatives:
const combinator = choice(literal('>'), literal('+'), literal('~'), literal('|'))
```

```js
// Codegen emits one read + a jump table (planDisjointDispatch):
const _code = pos < input.length ? (input.codePointAt(pos) ?? -1) : -1
switch (_code) {
  case 62: /* > */ ...
  case 43: /* + */ ...
  case 126: /* ~ */ ...
  case 124: /* | */ ...
  default: /* fail */
}
```

You didn't design a lexer, and you didn't write a dispatch table — you wrote four
alternatives. The interpreter builds the same thing at runtime as a 128-entry ASCII
table (`buildAsciiDispatch`); the compiler bakes it into a `switch` or an `if/else`
range chain.

**When it kicks in, and the honest limits:**

- The arms must have **pairwise-disjoint first sets** — no two arms can start with the
  same character. If they overlap, the choice stays on ordered `firstMatch` (still
  correct, just not O(1)); see the fail-fast section for how the overlap case is made
  cheap anyway.
- No arm may match the empty string. A nullable arm matches at *any* position, so
  first-char dispatch can't represent it; such a choice stays on `firstMatch`.
- The **`switch` jump-table** form is used only when the arms key off a few discrete
  code points (roughly: each arm's first set is a handful of points, ≥3 and ≤48 cases
  total — `SWITCH_MIN_CASES`/`SWITCH_MAX_CASES`/`SWITCH_RANGE_LIMIT` in `codegen.ts`).
  A wide char-class arm like `[a-z]+` would explode into dozens of `case` labels, so
  those keep the `if/else` range-comparison form instead. Same dispatch idea, form
  chosen to fit the arms.

## Fail-fast without hand-optimizing

Ordered PEG has a reputation for doing wasted work: a "try this, else that" grammar
speculatively enters an arm, does some setup, then discovers on the first byte that it
never had a chance. Parséman removes that cost for you, so you can write the natural
`choice(a, b)` without pre-optimizing away the misses.

As of **0.29.0**, a speculative construct rejects on its **first character — before it
allocates or mutates anything**. Concretely the guards live in:

- `emitMany` — a `many`/`oneOrMore` loop, at the iteration that terminates it, checks
  the body's first set *before* allocating the iteration's collector arrays.
- `emitNode` — a `node()` capture rejects on the first byte *before* swapping in the
  CST-capture context and allocating its child/leaf/trivia buffers.
- `emitAttempt` — an `attempt(inner)` checks first *before* taking its rollback marks.

```ts
// Less-style interpolation: `@{name}` inside a value, tried at every `@`.
const interp = node(sequence(literal('@{'), name, literal('}')))
```

Without the guard, every stray `@` that isn't `@{` would enter the `node()` frame,
allocate capture buffers, fail at the second byte, and roll all of it back. With it, a
non-`@{` byte is rejected by a single comparison and nothing was set up to undo. (On
Less's `benchmark.less` this exact case fired ~56k times per parse with ~26 real
matches — the guards cut ~11% off parse.)

The guard is only emitted when it's **sound**: the body must have a discrete
(non-`any`) first set and be unable to match empty, so a first-set miss genuinely
*cannot* match — bailing early is behavior-identical, and it records the same expected
token a normal start-failure would, so your error messages don't change. It is also
skipped under error-recovery mode, where a swallowed failure still needs to feed the
completions probe. You get the speed without having to reason about any of that.

## Literal-heavy choices collapse to one scan

Write a pile of keyword alternatives the obvious way and Parséman recognizes the shape
and collapses the whole choice to a single scan-and-classify — no arm-by-arm
backtracking. Two shapes are detected (`detectStrategy`):

**All arms are literals → `literalsLongestFirst`.** Sorted longest-first (so `>=`
beats `>`), tried without re-scanning shared prefixes.

```ts
const op = choice(literal('<='), literal('<'), literal('>='), literal('>'))
```

**One regex arm subsumes a set of literal arms → `greedyClassify`.** You have a
general token (say an identifier regex) plus a few keywords that are special cases of
it. Parséman runs the regex **once**, then classifies the matched text by string
equality against the literals — one parse call total, zero backtracking.

```ts
// `ident` matches everything the keywords match, and more:
const word = choice(literal('true'), literal('false'), ident)
// → run `ident` once; if the text is exactly "true"/"false", it's that arm, else ident.
```

You wrote alternatives; you did not write a scanner or a keyword hash. The detection is
conservative: `greedyClassify` requires exactly one regex arm that provably matches
every literal arm's value exactly, with all other arms literals; anything else falls
back to ordered `firstMatch`.

## Shared leading prefixes

> **⚠️ Design intent — NOT yet implemented. Do not ship this section as fact.**
> As of this draft there is **no `sharedPrefix` strategy in the codebase**; the choice
> strategies that exist are `greedyClassify`, `literalsLongestFirst`, and `firstMatch`
> (`ChoiceStrategy` in `src/types.ts`). What follows is the *intended* behavior,
> described from the design notes in `notes/PERF_IDEAS.md` (§7, §7c). It is included so
> the coordinator can finalize wording once the work lands — see the TODO below.

The centerpiece of "supports the natural way you write grammars" is the case where
several alternatives genuinely begin with the same token or sub-production — and, in a
real grammar, that shared prefix is usually wrapped in your ordinary `node(...)`,
trivia, and helper productions, not a bare literal. The classic example is a numeric
value:

```ts
// Two arms that both start by scanning a number:
const Dimension = node(sequence(numberPart, unit))   // 16px, 1.5rem
const Number    = node(numberPart)                   // 16, 1.5, 0
const value     = choice(Dimension, Number, /* … */)
```

Both arms start with `numberPart`, so their first sets overlap → today this stays on
ordered `firstMatch`, and every unitless number (very common: opacity, line-height,
z-index, calc operands) enters the `Dimension` `node()` frame, scans the number, fails
the required unit, rolls the frame back, then enters `Number` and scans the number
again.

**The intent:** teach Parséman to detect that the arms share a leading prefix — even
through the `node(...)`/trivia wrappers — parse that prefix **once**, and branch on
what follows, so you get the hand-left-factored performance *without* rewriting your
grammar into `number·(unit | ε)` and a hand-written builder. You keep writing the two
readable arms; the compiler does the factoring.

**Honest limits (as designed):** this is opt-in/conservative by nature — it must
preserve PEG ordered-choice semantics exactly, so it can only apply where factoring the
shared prefix is provably behavior-identical. The design notes treat the automatic
detection as a follow-on to the manual grammar-level fix, and estimate the standalone
win as single-digit percent on value-dense input, so it is a correctness-and-ergonomics
lever as much as a speed one.

> **TODO (coordinator):** before publishing, replace this section's specifics with the
> actual landed behavior — the real strategy/API name, exactly which wrappers the
> detector sees through, whether it's automatic or opt-in, and any measured numbers.
> Do not assert switch-once/branch behavior as fact until it's in `choice.ts` +
> `codegen.ts` with tests. Everything above this section is verified against current
> source; this section is not.

---

## Accuracy notes for review (delete before publishing)

Verified against current source:

- **Ordered choice / `firstMatch`** — `src/combinators/choice.ts` (firstMatch loop),
  `ChoiceStrategy` in `src/types.ts`. ✅
- **Disjoint single-code-point dispatch** — `areDisjoint` + non-nullable requirement
  (`choice.ts` L35), `buildAsciiDispatch` (interpreter), `planDisjointDispatch` +
  `emitChoice` switch/if-else (`codegen.ts`), `SWITCH_RANGE_LIMIT=4` /
  `SWITCH_MAX_CASES=48` / `SWITCH_MIN_CASES=3`. ✅
- **0.29.0 fail-fast guards** in `emitMany` / `emitNode` / `emitAttempt`, soundness
  conditions, recovery-mode skip, ~11% figure and the ~56k/26 `@{` example — all from
  `notes/CODEGEN-FAST-PATHS.md` (its "Where this guard is applied" table + "Measured
  impact"). ✅ (Figures are that doc's, on `benchmark.less`; re-confirm they're current
  if publishing numbers.)
- **`greedyClassify` / `literalsLongestFirst`** — `detectStrategy` in `choice.ts`,
  emitters in `codegen.ts`. ✅ The `greedyClassify` subsumption requirement (exactly one
  regex arm matching every literal exactly) is from `detectStrategy` L184-200.

Unverified / flagged:

- **`sharedPrefix`** — **NOT in the code.** Only a design note in
  `notes/PERF_IDEAS.md` §7 (§7a is the concrete Jess `Dimension`/`Number` instance,
  which is described there as a *grammar-level* fix, with "teaching Parseman to detect
  shared-prefix arms and factor them automatically" as the reusable follow-on; §7c
  covers richer dispatch structures). The whole "Shared leading prefixes" section is
  written at intent level and boxed accordingly.
- The `benchmark.less` measurement numbers are from the notes doc, not re-run here.
- CSS `combinator` example (`> + ~ |`) is representative of the disjoint-literal shape;
  the exact production isn't asserted from a specific grammar file.
