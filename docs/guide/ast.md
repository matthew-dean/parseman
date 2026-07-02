# CST / AST nodes

For grammars that produce a typed syntax tree, support incremental re-parsing, or care
about trivia, wrap each rule in `node(type, combinator, build, opts?)`.

Parséman captures the rule's terminals into `children` / `rawChildren` and records trivia
as flat `[start, end, insertIdx, …]` entries in `triviaLog`, then hands all of it to your
`build` callback. **Capture is the library's job** — you don't wrap terminals to recover
their spans, and you don't reconstruct trivia. It's collected as the parser runs, in both
the interpreter and the compiled build.

```ts
import { rules, parser, node, regex, literal, sequence, many, trivia } from 'parseman'
import type { Combinator } from 'parseman'

// Any node shape works as long as it satisfies NodeLike (see below).
type N = { _tag: 'node'; type: string; span: { start: number; end: number }; state: unknown; children: unknown[] }
const ws = trivia(regex(/\s+/))

export const { Expr, Num } = rules<{ Expr: Combinator<N>; Num: Combinator<N> }>(g => {
  const num = node('Num', regex(/[0-9]+/),
    (children, raw, span) => ({ _tag: 'node', type: 'Num', span, state: null, children: [...children] }))

  const expr = node('Expr',
    parser({ trivia: ws }, sequence(g.Num, many(sequence(literal('+'), g.Num)))),
    (children, raw, span) => ({ _tag: 'node', type: 'Expr', span, state: null, children: [...children] }))

  return { Expr: expr, Num: num }
})

Expr.parse('1 + 2 + 3', 0, { trackLines: false })
// value is a Node whose children are the captured Num sub-nodes and '+' leaves
```

## What `build` receives

`build(children, rawChildren, span, triviaLog, state)`:

- **`children`** — structural items in source order: spanned `CSTLeaf` terminals
  (`{ _tag: 'leaf', value, span }`) and sub-nodes (whatever a nested `node()`'s `build`
  returned). A `build` that returns a bare string is recorded by the parent as a spanned
  leaf, so single-item "collapsing" rules keep their source span.
- **`rawChildren`** — structural children only (same items as `children`, without trivia
  tokens).
- **`triviaLog`** — flat `[start, end, insertIdx, …]` entries for whitespace/comments
  consumed between terms. `insertIdx` is the `rawChildren` index before which the trivia
  was consumed. Pass the tree to `buildTriviaIndex(tree, input)` for a `before`/`after`
  map — useful for whitespace-sensitive syntax (e.g. CSS `div p` vs `div.p`).
- **`state`** — a snapshot of `ctx.state` at parse time (see
  [Context-sensitive parsing](./context)).

Wrap a rule's inner combinator in `parser({ trivia }, combinator)` so trivia-skipping is
baked in regardless of which rule you start from; the macro compiles the wrapper (and all
capture) away to flat JS.

> `transform(p, fn)` is still the tool for plain value-mapping (no children/trivia).
> `node()` is for CST/AST rules — it adds the capture `transform` doesn't. Both compile
> under the macro.

## Collapsing wrapper rules

Layered grammars accumulate "wrapper" rules that exist only for structure — an expression
precedence ladder (`Sum` → `Product` → `Primary`), or a selector-list rule that wraps a
single selector. When such a rule matches just **one** child, the wrapper node is noise:
you want to *be* that child, not box it.

The `collapse` option does exactly that. With `{ collapse: true }`, a **one-child** match
returns that child directly and `build` is **not called**; zero or two-plus children go
through `build` as normal.

```ts
import { node, choice, sequence, literal, regex } from 'parseman'

// A precedence level that's transparent when there's no operator.
const sum = node('Sum',
  sequence(product, many(sequence(literal('+'), product))),
  (children, raw, span) => ({ _tag: 'node', type: 'Sum', span, state: null, children: [...children] }),
  { collapse: true },
)
```

| Children captured | Result |
| --- | --- |
| **0** | `build` runs normally |
| **1** | `build` **skipped** — the single child is returned directly (a leaf unwraps to its string value; a sub-node is returned as-is) |
| **2+** | `build` runs normally |

So `2` parses to a bare `Product` node (no redundant `Sum` wrapper), while `2 + 3`
produces a real `Sum` node with its children. You get readable layered rules without
paying a `build` call per collapsing layer — and without hand-writing
`if (children.length === 1) return children[0]` in every wrapper builder.

`collapse` has full **interpreter, `.compile()`, and macro** parity: the compiled output
emits a `children.length === 1 ? <unwrap> : build(…)` ternary, and the plugin reads a
static `{ collapse: true }` literal as the 4th argument.

::: tip Two different "collapses"
This option is about **tree shape**. There's a separate, unrelated *performance* technique
also called collapsing — folding a fixed multi-token shape into a single `regex` to cut
combinator boundaries. That one is covered in [Performance](./performance#collapse-opaque-shapes-into-one-regex).
:::

## The `NodeLike` contract

Any AST your `build` callbacks produce participates in incremental re-parsing as long as
it satisfies `NodeLike` — that's the whole contract:

```ts
type NodeLike = {
  readonly _tag: 'node'
  readonly type: string          // the rule name — used as the registry key on re-parse
  readonly span: Span
  readonly state: unknown        // ctx.state snapshot at parse time; replayed on edit
  readonly children: ReadonlyArray<{ readonly _tag: string }>
}
```

`children` only needs items carrying a `_tag` so traversal can tell sub-nodes
(`_tag: 'node'`) from anything else. The `type` string must match the rule name in the
registry so [`edit()`](./incremental) can re-parse the right rule.

The built-in CST leaf/node/error shapes are also exported as types — `CSTNode`,
`CSTLeaf`, `CSTError`, `CSTTrivia` — if you'd rather use them directly. See the
[types reference](../reference/types#cst-types).

## Next

- Wire your rule registry into a live-editing document in
  [Incremental re-parsing](./incremental).
- Thread parse-time context through nodes in [Context-sensitive parsing](./context).
