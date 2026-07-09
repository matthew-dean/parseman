# CST / AST nodes

For grammars that produce a typed syntax tree, support incremental re-parsing, or care
about trivia, wrap each named rule in `node(combinator, build?, opts?)`. There are two ways
to get a tree out:

- **A plain CST** — omit `build` and let the library build a uniform positioned node for
  every rule. Fastest to write; see [Just want a plain CST?](#just-want-a-plain-cst) below.
- **Your own AST** — pass a `build` callback that constructs whatever node shape you want
  from the captured children. Covered first.

Either way, Parséman captures the rule's terminals into `children` / `rawChildren` and
records trivia as flat `[start, end, insertIdx, …]` entries in `triviaLog`. **Capture is
the library's job** — you don't wrap terminals to recover their spans, and you don't
reconstruct trivia. It's collected as the parser runs, in both the interpreter and the
compiled build.

```ts
import { rules, parser, node, regex, literal, sequence, many, trivia } from 'parseman'
import type { Combinator } from 'parseman'

// Any node shape works as long as it satisfies NodeLike (see below).
type N = { _tag: 'node'; type: string; span: { start: number; end: number }; state: unknown; children: unknown[] }
const ws = trivia(regex(/\s+/))

export const { Expr, Num } = rules<{ Expr: Combinator<N>; Num: Combinator<N> }>(g => {
  const num = node(regex(/[0-9]+/),
    (children, raw, span) => ({ _tag: 'node', type: 'Num', span, state: null, children: [...children] }))

  const expr = node(
    parser({ trivia: ws }, sequence(g.Num, many(sequence(literal('+'), g.Num)))),
    (children, raw, span) => ({ _tag: 'node', type: 'Expr', span, state: null, children: [...children] }))

  return { Expr: expr, Num: num }
})

Expr.parse('1 + 2 + 3', 0, { trackLines: false })
// value is a Node whose children are the captured Num sub-nodes and '+' leaves
```

## What `build` receives

`build(children, fields, span, rawChildren, triviaLog, state)`:

- **`children`** — structural items in source order: spanned `CSTLeaf` terminals
  (`{ _tag: 'leaf', value, span }`) and sub-nodes (whatever a nested `node()`'s `build`
  returned). A `build` that returns a bare string is recorded by the parent as a spanned
  leaf, so single-item "collapsing" rules keep their source span.
- **`fields`** — named captures from `field(name, parser)` inside this node, or
  `undefined` when the node has no captured fields or the build does not declare this
  parameter. A repeated field name becomes an array of captures.
- **`span`** — the full source span matched by this node.
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

### Capture follows your `build`'s arity {#capture-follows-arity}

Building `fields`, `triviaLog`, and cloning `state` per node isn't free — on a value-dense
grammar the per-token trivia-log push alone is a large slice of parse time. Parséman
**skips the capture your `build` never asks for**: a `build` that declares only
`(children)` gets no fields, trivia log, or state clone; `(children, fields, span)` gets
named fields and spans but still skips raw children, trivia, and state; declaring
`triviaLog` keeps the log; declaring `state` keeps the clone. This is inferred from the
function's parameter list at compile time — you don't opt in.

The same inference runs at **parse time** for a [structural `node(parser)`](#just-want-a-plain-cst)
whose AST is built by an injected [`ctx.build` host](#the-nodelike-contract): Parséman
reads the host's arity (`build(type, children, fields, span, rawChildren, triviaLog, state)`) and
elides the trivia/state/field capture the host doesn't take.

::: warning Keep build hosts plain-positional
The arity check is conservative-by-necessity: `Function.length` under-counts a **rest**
(`(...args) =>`) or **default** (`(a, b = 1) =>`) parameter, and can't see through a bound
function. Parséman detects rest/default params and `arguments` and falls back to **full
capture** (correct, just not the fast path). So a host written `(type, ...args) =>` that
reads `args[4]` still gets its trivia — but to keep the elision, declare plain positional
parameters and drop the ones you don't use.
:::

> `transform(p, fn)` is still the tool for plain value-mapping (no children/trivia).
> `node()` is for CST/AST rules — it adds the capture `transform` doesn't. Both compile
> under the macro.

## Just want a plain CST? {#just-want-a-plain-cst}

If you don't need a custom AST, **omit `build`**. A `node(combinator)` with no build
callback is *structural*: it constructs its node through a **host** you supply via
`ctx.build`, so the same grammar produces a plain CST for tooling (host set) and its own
AST for evaluation (host unset, or a `build` callback). Inside `rules()`, the object key is
the node type. Pass the built-in `cstBuildHost` and every rule becomes a uniform positioned node:

```ts
import { rules, node, regex, literal, sequence, many, parser, trivia, run, cstBuildHost } from 'parseman'

const ws = trivia(regex(/\s+/))
const g = rules(gg => ({
  Expr: node(parser({ trivia: ws }, sequence(gg.Num, many(sequence(literal('+'), gg.Num))))),
  Num:  node(regex(/[0-9]+/)),
}))

const r = run(g.Expr, '1 + 2', { build: cstBuildHost })
```

`r.value` is the CST — every node the same [`NodeLike`](../reference/types#node-types) shape,
terminals as `CSTLeaf`:

Use `node('Type', parser)` when a rule needs an explicit public type or when the node is a
local/manual helper outside `rules()`.

```ts
{
  _tag: 'node', type: 'Expr', span: { start: 0, end: 5 }, state: null,
  children: [
    { _tag: 'node', type: 'Num', span: { start: 0, end: 1 }, state: null,
      children: [{ _tag: 'leaf', value: '1', span: { start: 0, end: 1 } }] },
    { _tag: 'leaf', value: '+', span: { start: 2, end: 3 } },
    { _tag: 'node', type: 'Num', span: { start: 4, end: 5 }, state: null,
      children: [{ _tag: 'leaf', value: '2', span: { start: 4, end: 5 } }] },
  ],
}
```

Walk it with [`walk` / `createVisitor`](#walking-the-tree), and turn its trivia into a
`before`/`after` lookup with [`buildTriviaIndex`](../reference/api#buildtriviaindex).

## Unwrapping and collapsing wrapper rules

Layered grammars accumulate "wrapper" rules that exist only for structure — an expression
precedence ladder (`Sum` → `Product` → `Primary`), or a selector-list rule that wraps a
single selector. When such a rule matches just **one** child, the wrapper node is noise:
you want to *be* that child, not box it.

The `unwrap` and `collapse` options do that for grammar-local wrapper rules. Both skip
`build` for a **one-child** match; zero or two-plus children go through `build` as normal.
The difference is the shape of a single captured leaf:

- `{ unwrap: true }` returns the leaf's string value.
- `{ collapse: true }` returns the original `CSTLeaf` object, span included.

Set at most one of the two options on a given `node()`.

```ts
import { node, choice, sequence, literal, regex } from 'parseman'

// A precedence level that's transparent when there's no operator.
const sum = node('Sum',
  sequence(product, many(sequence(literal('+'), product))),
  (children, raw, span) => ({ _tag: 'node', type: 'Sum', span, state: null, children: [...children] }),
  { unwrap: true },
)
```

Use `collapse` for the same grammar-local wrapper behavior when the single child must stay
in CST form:

```ts
const componentValue = node('ComponentValue',
  choice(g.Function, g.Block, regex(/[^\s{}()[\];]+/)),
  (children, raw, span) => ({ _tag: 'node', type: 'ComponentValue', span, state: null, children: [...children] }),
  { collapse: true },
)
```

If the regex arm matches alone, `unwrap` would return the bare token string;
`collapse` returns `{ _tag: 'leaf', value, span }`.

| Children captured | Result |
| --- | --- |
| **0** | `build` runs normally |
| **1** | `build` **skipped** — `unwrap` returns a leaf's string value; `collapse` returns the child exactly; sub-nodes are returned as-is |
| **2+** | `build` runs normally |

So `2` parses to a bare `Product` node (no redundant `Sum` wrapper), while `2 + 3`
produces a real `Sum` node with its children. You get readable layered rules without
paying a `build` call per transparent layer — and without hand-writing
`if (children.length === 1) return children[0]` in every wrapper builder.

`unwrap` and `collapse` have full **interpreter, `compile()`, and macro** parity: the
compiled output emits a `children.length === 1 ? <single-child> : build(…)` ternary, and
the plugin reads static `{ unwrap: true }` / `{ collapse: true }` literals as the 4th
argument.

::: tip Grammar collapse vs host collapse
`node(..., { collapse: true })` is a grammar-local decision for one wrapper rule. For a
public CST parser, `cstBuildHost({ collapse })` lets the caller apply a host-wide collapse
policy without changing the grammar's AST/value behavior.
:::

## Collapsing public CST wrappers

When a structural grammar is also a public CST parser, you may want the same transparent
wrapper policy without changing AST/value behavior. Pass a configured CST host:

```ts
import { cstBuildHost, run } from 'parseman'

const r = run(g.Stylesheet, source, {
  build: cstBuildHost({ collapse: ['SelectorList', 'ComponentValue'] }),
})
```

This is CST-shaped collapse, not value unwrap:

| Option | Use it for | One-child leaf result |
| --- | --- | --- |
| `node(..., { unwrap: true })` | AST/value wrapper rules | the leaf's string value |
| `node(..., { collapse: true })` | grammar-local structural wrapper rules | the original `CSTLeaf` object, span included |
| `cstBuildHost({ collapse })` | caller-selected public CST wrapper policy | the original `CSTLeaf` object, span included |

`collapse` only considers successful one-child nodes whose raw child list is also one
item, so trivia-only matches and multi-token nodes keep their wrapper. The policy can be:

- `true` — collapse every one-child structural CST wrapper.
- `['RuleName', ...]` — collapse only named node types.
- `(type, child, children, rawChildren) => boolean` — decide from the grammar type and
  captured CST children.

Because the policy lives on the build host, a composed grammar can expose a compact public
CST while the evaluator keeps using the grammar's own AST builders. The interpreter,
`compile()`, and macro output all check the policy while the node is being built, so
there is no separate tree-normalization pass.

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

## Walking the tree

The tree is plain objects, so you can recurse it yourself — but two helpers save you
writing the same traversal every time.

`walk(root, visitor, ctx?)` is a depth-first traversal with `enter` / `leave` hooks.
Return `false` from `enter` to skip a subtree:

```ts
import { walk } from 'parseman'

const leaves: string[] = []
walk(tree, {
  enter(node) {
    if (node._tag === 'leaf') leaves.push(node.value)
  },
})
```

`createVisitor(handlers)` dispatches on each node's `type` — the same shape as a generated
CST-visitor class. Handlers receive an `api` with `visit` / `visitChildren` to recurse; a
node whose `type` has no handler falls through to its children, so partial visitors work:

```ts
import { createVisitor } from 'parseman'

const evalExpr = createVisitor<number>({
  Num: (n) => Number((n as NumNode).value),
  Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
})

const total = evalExpr(tree)
```

Both default to the built-in CST shape (`CSTChild`), so with no annotation `node` is typed
as the leaf/node/error union — narrow on `node._tag` to reach `value`, `children`, etc.
Parsing to your own AST instead? Pass the node type as a generic — `walk<MyNode>(root, …)`
or `createVisitor<number, MyNode>({ … })` — and the hooks are typed to your shape. Any node
carrying a `_tag` (and optional `children` array) works.

## Next

- Wire your rule registry into a live-editing document in
  [Incremental re-parsing](./incremental).
- Thread parse-time context through nodes in [Context-sensitive parsing](./context).
