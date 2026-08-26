# Context-sensitive parsing

Some grammars aren't context-free: `return` is only legal inside a function body, a
here-doc's terminator depends on how it opened, and indentation changes meaning. Parséman
handles these with `withCtx` and `gate`, **without mutating shared state** — so incremental
re-parsing can replay the exact context a node was parsed under.

## `withCtx` and `gate`

- **`withCtx(extra, combinator)`** merges `extra` into the user context (`ctx.state`) for
  the duration of `combinator`, then restores it on exit.
- **`gate(predicate)`** succeeds, consuming nothing, only when `predicate(ctx.state)`
  returns true — it asserts something about the runtime context mid-sequence.

> `gate` names two related things: use the **arm field to select a branch**, and the
> `gate()` combinator to *assert* a predicate inside a sequence. `guard` is a deprecated
> alias of `gate`.

```ts
import { rules, withCtx, gate, many, sequence, choice, word, regex, trivia, parser } from 'parseman'
import type { Combinator } from 'parseman'

const ws = trivia(regex(/\s*/))

export const { Program } = rules<{ Program: Combinator<unknown> }>(g => {
  const expr = regex(/[a-z]+/)
  // Lead with the concrete terminal so the arm keeps first-char dispatch on 'r';
  // the gate ASSERTS the context after. (A leading gate() would make the arm's
  // first-set `any` and poison the choice — see the note below.) `word('return')`,
  // not `literal('return')`, so it won't match the 'return' prefix of `returnValue`.
  const ret  = sequence(word('return'), gate((ctx: { inFn?: boolean }) => ctx.inFn === true))
  const stmt = choice(ret, expr)
  const body = withCtx({ inFn: true }, many(sequence(stmt, ws)))
  return { Program: parser({ trivia: ws }, many(body)) }
})
```

The `ret` production only matches inside a body — outside one, `gate` rejects it and
`choice` falls through to the generic `expr` arm, which still accepts the bare text
`return` as an ordinary identifier. (A real grammar would exclude keywords like `return`
from `expr`; this toy example only demonstrates the gate.)

One catch: `gate()`'s first-set is `any`, since a runtime predicate can't be known at build
time. Put it as the leading term of a choice arm and you poison that choice's first-char
dispatch — keep it after a concrete leading terminal instead. If you just need to select a
branch by a cheap predicate, reach for the gated-arm field below; it preserves dispatch.

## Why not just mutate a variable?

Because incremental re-parsing needs to re-run a single rule in isolation, later, on a
different document. A mutated module-level variable won't hold the right value by then.
Instead, each node records the `ctx.state` snapshot that was active when it was parsed (the
`state` field on `NodeLike`), and `edit()` replays it — so a context-sensitive rule
re-parses under exactly the context it originally saw.

## Gated choice arms

For the common case — "only try this alternative when the context allows it" — `choice`
accepts gated arms directly. The arm field *selects* a branch (and keeps dispatch); the
`gate()` combinator *asserts* a predicate mid-sequence:

```ts
import { choice } from 'parseman'

const stmt = choice(
  { gate: (state) => state.inFn === true, combinator: returnStmt },
  exprStmt,
)
```

The gated arm is skipped entirely unless its gate returns true. See
[Ordered choice & keywords](./keywords#gated-alternatives).

Gating is cheap, as long as every arm has a disjoint first-set and none is nullable — the
choice keeps its O(1) first-char dispatch, and the gate only runs once the input is
actually at that arm's first character. A single nullable sibling forces the slower
first-match path even if the gated arm itself is disjoint. So gating a rare-token
alternative in an otherwise-disjoint choice — a nesting `&`, a mode-only keyword — costs
next to nothing on the hot path.

## Which tool: structure, options, recursion, or context

`ctx.state` should be your last resort, not your first. In a recursive-descent combinator
parser, the call stack already *is* a context stack, so most "context" is better expressed
by *where a rule sits* than by a runtime flag. Four tools, roughly in order of preference:

1. **Separate rules (structural).** When the distinction lines up with a rule boundary,
   make it two rules and read the difference at build time from the node type. A bare
   declaration is legal in a nested block but not at the top level, so a stylesheet's
   top-level rule and its block-body rule can simply be *different rules*. In CSS-ish
   languages, `/` only divides inside parentheses — and that reads naturally as one rule
   for top-level values and another for parenthesized ones, chosen by which rule the
   recursion is currently in. Zero runtime cost, first-char dispatch intact, macro-friendly.
2. **A document option.** When the mode is one setting for the whole document, put it in
   the resolved options, not the grammar — a CSS dialect's math mode (`always` vs.
   `parens-only`), strict math, the active `trivia`. Read it in a build callback.
3. **Recursion and `balanced`/`scanTo` (counting).** Depth *is* the call stack. Nested
   parens, function-call nesting, balanced delimiters — track these by recursing through
   the rule (or with `balanced()`), never with a counter in `ctx.state`. A state counter
   would just duplicate the stack you already have.
4. **`ctx.state` (`withCtx` / `gate` / gated arms).** Reach for this only when the *same*
   rule must behave differently depending on an ancestor that isn't a distinct rule on its
   path — so structure alone can't tell the cases apart. CSS's parent selector `&` is the
   canonical case: a selector is reached by the identical rule path whether it's written at
   the top level or nested inside a block, and the only difference is whether a block was
   entered above it. Wrap the block body in `withCtx({ inner: true }, …)` and gate the `&`
   arm on `inner`.

A quick test for which to use: if you can point at *which rule you're in* to tell the cases
apart, use structure. If it's *how deep you are*, use recursion. If it's *one setting for
the whole document*, use an option. Only if it's *what an ancestor did, at a point structure
can't distinguish*, reach for `ctx.state`.

## How this compares

Expressing context *in the grammar* is a real dividing line between parsers. Parséman,
[Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), and
[Chevrotain](https://chevrotain.io/) all let the grammar consult parse-time state. The
incremental editor parsers — [Lezer](https://lezer.codemirror.net/) and
[tree-sitter](https://tree-sitter.github.io/tree-sitter/) — are context-free at the grammar
level: context needs a hand-written external tokenizer (JS) or scanner (C) instead.
Parséman combines in-grammar context *with* incremental re-parsing: each node snapshots the
context it parsed under, and [`edit()`](./incremental) replays it. See
[How Parséman compares](./comparison#the-context-sensitivity-axis) for the full matrix.
