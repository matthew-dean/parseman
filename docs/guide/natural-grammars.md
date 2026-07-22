# Grammars the way you'd write them anyway

Most parser generators ask you to meet the tool halfway: left-factor your rules,
compute FIRST/FOLLOW sets, resolve shift/reduce conflicts, or hand-order a lexer so the
fast path is fast. Parséman's aim is the opposite — you write the grammar the natural
way, in priority order, with the alternatives spelled out plainly, and the compiler
works out the machinery that makes it fast. This page walks through the places where
"the obvious way to write it" and "the fast way to run it" are the same thing, and
names the mechanism doing the work so you can reason about its limits.

Nothing here is something you turn on. It's what `compile()` (and the macro build) do to
the grammar you already wrote.

## Ordered choice just works (PEG)

You list alternatives in the order you want them tried. First one that matches wins.

```ts
const value = choice(Dimension, Number, Color, Keyword)
```

That's the whole contract — [PEG ordered choice](https://en.wikipedia.org/wiki/Parsing_expression_grammar).
There is no separate grammar-ambiguity phase, no conflict to resolve, and you do not have
to left-factor two arms that happen to start the same way to keep the grammar *correct*.
If two arms can both match at a position, the earlier one wins, full stop. When the arms
*don't* overlap, Parséman notices and speeds things up (next section) — but that's an
optimization layered on top of semantics you already control by ordering, not something
you have to arrange by hand.

What you avoid: computing FIRST/FOLLOW sets yourself, and rewriting `choice(a·x, a·y)`
into `a·(x | y)` just to satisfy the tool. Write the arms; order them; done.

## Automatic first-set dispatch

When the alternatives in a `choice` start with **distinct characters**, trying them in
order would mean "test arm 1's first char, miss, test arm 2's first char, miss, …"
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
  correct, just not O(1)); see the fail-fast and shared-prefix sections for how the
  overlap case is made cheap anyway.
- No arm may match the empty string. A nullable arm matches at *any* position, so
  first-char dispatch can't represent it; such a choice stays on `firstMatch`.
- The **`switch` jump-table** form is used only when the arms key off a few discrete code
  points (roughly ≥3 and ≤48 cases total — `SWITCH_MIN_CASES`/`SWITCH_MAX_CASES`/
  `SWITCH_RANGE_LIMIT` in `codegen.ts`). A wide char-class arm like `[a-z]+` would explode
  into dozens of `case` labels, so those keep the `if/else` range-comparison form instead.

## Fail-fast without hand-optimizing

Ordered PEG has a reputation for doing wasted work: a "try this, else that" grammar
speculatively enters an arm, does some setup, then discovers on the first byte that it
never had a chance. Parséman removes that cost for you, so you can write the natural
`choice(a, b)` without pre-optimizing away the misses.

As of **0.29.0**, a speculative construct rejects on its **first character — before it
allocates or mutates anything**. Concretely the guards live in:

- `emitMany` — a `many`/`oneOrMore` loop, at the iteration that terminates it, checks the
  body's first set *before* allocating the iteration's collector arrays.
- `emitNode` — a `node()` capture rejects on the first byte *before* swapping in the
  CST-capture context and allocating its child/leaf/trivia buffers.
- `emitAttempt` — an `attempt(inner)` checks first *before* taking its rollback marks.

The guard is only emitted when it's **sound**: the body must have a discrete (non-`any`)
first set and be unable to match empty, so a first-set miss genuinely *cannot* match —
bailing early is behavior-identical, and it records the same expected token a normal
start-failure would, so your error messages don't change. It is also skipped under
error-recovery mode, where a swallowed failure still needs to feed the completions probe.

Unlike the shared-prefix optimization, **this one is in the interpreter too.** The
runtime `many`/`oneOrMore`/`node`/`attempt` combinators (and `optional`, which already
did) apply the same first-set fail-fast on the same soundness condition — a doomed body
is never entered, no capture frame is allocated, no rollback marks are taken — skipped
identically under a completions probe / tolerant recovery. So the interpreter and the
compiled output skip the *same* doomed setup, and the parity suites hold the two
byte-identical.

## Literal-heavy choices collapse to one scan

Write a pile of keyword alternatives the obvious way and Parséman recognizes the shape
and collapses the whole choice to a single scan-and-classify — no arm-by-arm
backtracking. Two shapes are detected (`detectStrategy`):

**All arms are literals → `literalsLongestFirst`.** Sorted longest-first (so `>=` beats
`>`), tried without re-scanning shared prefixes.

```ts
const op = choice(literal('<='), literal('<'), literal('>='), literal('>'))
```

**One regex arm subsumes a set of literal arms → `greedyClassify`.** You have a general
token (say an identifier regex) plus a few keywords that are special cases of it.
Parséman runs the regex **once**, then classifies the matched text by string equality
against the literals — one parse call total, zero backtracking.

```ts
// `ident` matches everything the keywords match, and more:
const word = choice(literal('true'), literal('false'), ident)
// → run `ident` once; if the text is exactly "true"/"false", it's that arm, else ident.
```

The detection is conservative: `greedyClassify` requires exactly one regex arm that
provably matches every literal arm's value exactly, with all other arms literals;
anything else falls back to ordered `firstMatch`.

## Shared leading prefixes

Sometimes several alternatives genuinely begin with the **same** token — and in a real
grammar that shared prefix is usually buried inside your ordinary `node(...)`, trivia
(`parser({ trivia })`), and helper wrappers, not exposed as a bare literal. The classic
example is a CSS pseudo-selector, where two arms both open with `:` or `::`:

```ts
// Both arms start by scanning `::?` — but each is wrapped in its own node + trivia:
const FunctionalPseudo = node('FunctionalPseudo',
  parser({ trivia }, sequence(regex(/::?/), name, literal('('), args, literal(')'))),
  buildFunctional)

const SimplePseudo = node('SimplePseudo',
  parser({ trivia }, sequence(regex(/::?/), not(reserved), name)),
  buildSimple)

const pseudo = choice(FunctionalPseudo, SimplePseudo)
```

Their first sets overlap (both start with `:`), so disjoint dispatch can't split them.
Left to a naïve ordered `firstMatch`, every pseudo would enter the first arm's `node()`
frame, scan `::?`, discover it isn't functional, roll back, enter the second arm, and
**scan `::?` again**.

Parséman detects this shape automatically (the `sharedPrefix` strategy in
`detectStrategy`) and **recognizes the shared prefix once**, then lets each arm *replay*
that already-recognized token instead of re-scanning it. You keep the two readable arms;
the compiler does the factoring — you never rewrite them into `::?·(functional | simple)`
with a hand-merged builder.

**This is a scan *dedup*, not a guaranteed speed-up.** How much it saves scales with how
expensive the shared prefix is and how many arms would otherwise re-scan it. For a cheap,
short prefix like the CSS pseudo `::?` (two character comparisons) the saving is below the
noise floor — measured *no* parse-time win on a real stylesheet workload. It becomes worth
something only when the shared prefix does real work (a long literal, or a regex that scans
a meaningful token run) *and* several arms would re-scan it before one wins. Treat it as a
correctness-preserving factoring that removes redundant work where redundant work is
actually expensive — not as a blanket optimization.

**What it sees through.** To find the shared leading term the detector peels the wrappers
that don't consume input or skip trivia before the sequence's first term — `node`,
`parser`/`grammar` (any `trivia`/`captureTrivia` config), `transform`, and `label`. So
all of these group when their inner sequences share a leading terminal:

```ts
choice(sequence(regex(/::?/), a), sequence(regex(/::?/), b))                 // bare
choice(node('A', sequence(regex(/::?/), a), rA), node('B', sequence(regex(/::?/), b), rB))
choice(node('A', parser({ trivia }, sequence(regex(/::?/), a)), rA),        // node + trivia
       node('B', parser({ trivia }, sequence(regex(/::?/), b)), rB))
choice(transform(sequence(literal('--'), a), fA), sequence(literal('--'), b))
```

**How it stays byte-identical.** Only the *scan* is shared. Each arm is otherwise emitted
by the ordinary `firstMatch` machinery, unchanged — it enters its own `node()` frame,
runs its own trivia, builds its own subtree, and rolls back on failure exactly as before.
The one difference is that the arm's leading terminal replays the once-computed end
position and value, and pushes an identical leaf into that arm's own capture scope. The
result is that your reducer's `children[0]` (value **and** span), the node's trivia log,
every other span, and the choice's failure `expected` set are all bit-for-bit what the
un-factored grammar produced — in both the interpreter and the compiled output.

**Where the dedup applies.** It's a **compiled-output** transform (both `compile()` and
the macro build). The **interpreter runs the ordinary `firstMatch` loop** and re-scans the
prefix per arm — identical output, natural authoring, no dedup — because replaying the
prefix at runtime would mean threading a cache through the core `parse()` dispatch of every
combinator, and the free byte-identity of the `firstMatch` fallback is worth more than a
runtime win on a path that exists mainly for tests and REPLs. And because the strategy is a
faithful specialization of `firstMatch`, compiles that carry extra per-arm bookkeeping —
coverage tracing, error-recovery, and linkable/compose fusion — also transparently fall
back to plain `firstMatch`.

**Honest limits — what it conservatively skips.** Correctness comes first, so the detector
only fires where the factoring is provably behavior-identical:

- **Every** arm must peel to a `sequence` of ≥2 terms whose first term is a **bare,
  case-sensitive** `literal` or a `regex`. If any arm doesn't (e.g. a bare literal arm, a
  quoted-string alternative, an arm wrapped in `attempt`/`optional`/`many`/`choice`), the
  whole choice stays on `firstMatch`.
- Arms group only when their leading terms are **byte-equal** — the same literal string,
  or the same regex source and flags.
- **Differently-spelled-but-equivalent** prefixes are *not* unified. `regex(/::?/)` in one
  arm and `choice(literal('::'), literal(':'))` in a sibling accept the same strings, but
  proving that equivalence (and that both produce the same leaf) is not attempted — those
  arms are left on `firstMatch`. Likewise a cluster that shares only a first *character*
  through differently-spelled tokens (e.g. an `@`-led at-rule family, one arm
  `literal('@')`, another `regex(/@media…/)`) is not factored.
- Prefixes hidden **behind a rule reference** (`choice(g.RuleA, g.RuleB)`, where the
  shared leading terminal lives one level down inside each referenced rule) are not
  factored — the detector runs at grammar-construction time and does not resolve refs.
- Arms that would compile into **separate function bodies** are not factored. The prefix
  is recognized once into a variable in the *choice's* function; if a grouped arm is a
  shared subtree hoisted into its own `_pf` function, or a named rule in the linkable/fused
  form, its replayed prefix would reference that variable out of scope. So the strategy
  fires only for **self-contained, single-function** shared-prefix choices (the pseudo case
  is one); when the arms span a function boundary the choice falls back to `firstMatch`.

These are places the factoring is skipped, not places where output could diverge — anything
the detector isn't sure about falls back to the ordered `firstMatch` you'd have had anyway.
