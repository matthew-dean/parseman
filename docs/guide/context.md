# Context-sensitive parsing

Some grammars are not context-free: `return` is only legal inside a function body; a
here-doc's terminator depends on its opening line; indentation changes meaning. Parséman
handles these with `withCtx` and `guard`, **without mutating shared state** — so
incremental re-parsing can replay the exact context a node was parsed under.

## `withCtx` and `guard`

- **`withCtx(extra, combinator)`** merges `extra` into the user context (`ctx.state`) for
  the duration of `combinator`, restoring it on exit.
- **`guard(predicate)`** succeeds (consuming nothing) only when `predicate(ctx.state)`
  returns true, gating a rule behind runtime context.

```ts
import { rules, withCtx, guard, many, sequence, choice, literal, regex, trivia, parser } from 'parseman'
import type { Combinator } from 'parseman'

const ws = trivia(regex(/\s*/))

export const { Program } = rules<{ Program: Combinator<unknown> }>(g => {
  const expr = regex(/[a-z]+/)
  const ret  = sequence(guard((ctx: { inFn?: boolean }) => ctx.inFn === true), literal('return'))
  const stmt = choice(ret, expr)
  const body = withCtx({ inFn: true }, many(sequence(stmt, ws)))
  return { Program: parser({ trivia: ws }, many(body)) }
})
```

`return` is only reachable inside a body because `guard` rejects it when `inFn` is not set.
Outside a body, the `ret` arm fails at the guard and `choice` falls through to `expr`.

## Why not just mutate a variable?

Because incremental re-parsing needs to re-run a single rule in isolation, later, on a
different doc. A mutated module-level variable wouldn't hold the right value at re-parse
time. Instead, each node records the `ctx.state` snapshot active when it was parsed (the
`state` field on `NodeLike`), and `edit()` replays it — so a context-sensitive rule
re-parses under exactly the context it originally saw.

## Gated choice arms

For the common case of "only try this alternative when the context allows it," `choice`
accepts **gated arms** directly, which reads better than a `guard` inside a `sequence`:

```ts
import { choice } from 'parseman'

const stmt = choice(
  { gate: (state) => state.inFn === true, combinator: returnStmt },
  exprStmt,
)
```

The gated arm is skipped entirely unless its gate returns true. See
[Ordered choice & keywords](./keywords#gated-alternatives).

## How this compares

Expressing context *in the grammar* is a real dividing line between parsers. Parséman,
[Peggy](https://peggyjs.org/), [Parsimmon](https://github.com/jneen/parsimmon), and
[Chevrotain](https://chevrotain.io/) all let the grammar consult parse-time state. The
incremental editor parsers — [Lezer](https://lezer.codemirror.net/) and
[tree-sitter](https://tree-sitter.github.io/tree-sitter/) — are context-free at the
grammar level: context needs a hand-written external tokenizer (JS) or scanner (C).
Parséman is unusual in combining in-grammar context *with* incremental re-parse, because
each node snapshots the context it parsed under and [`edit()`](./incremental) replays it.
See [How Parséman compares](./comparison#the-context-sensitivity-axis) for the full matrix.
