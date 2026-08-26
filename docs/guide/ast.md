# CST / AST nodes

If your grammar needs a typed syntax tree, incremental re-parsing, or trivia handling,
wrap each named rule in `node(combinator, build?, opts?)`. There are two ways to get a
tree out:

- **A plain CST** — omit `build` and let the library build a uniform positioned node for
  every rule. Fastest to write; see [Just want a plain CST?](#just-want-a-plain-cst) below.
- **Your own AST** — pass a `build` callback that constructs whatever node shape you want
  from the captured children. Covered first.

Either way, Parséman captures the rule's terminals into `children` / `rawChildren`. When
that node owns trivia capture, it also records trivia as flat `[start, end, insertIdx, …]`
entries in `triviaLog`. **Capture is the library's job** — you don't wrap terminals to
recover their spans, and you don't reconstruct trivia by hand. It's collected as the
parser runs, in both the interpreter and the compiled build.

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
  returned). A `build` that returns a bare string gets recorded by the parent as a
  spanned leaf, so single-item "collapsing" rules keep their source span.
- **`fields`** — named captures from `field(name, parser)` inside this node, or
  `undefined` when the node has no captured fields or the build doesn't declare this
  parameter. A repeated field name becomes an array of captures.
- **`span`** — the full source span matched by this node.
- **`rawChildren`** — structural children only (same items as `children`, without trivia
  tokens).
- **`triviaLog`** — flat `[start, end, insertIdx, …]` entries for whitespace/comments
  consumed between terms. `insertIdx` is the `rawChildren` index before which the trivia
  was consumed. Pass the tree to `buildTriviaIndex(tree, input)` for a `before`/`after`
  map — useful for whitespace-sensitive syntax, like telling CSS's `div p` apart from
  `div.p`.
- **`state`** — a snapshot of `ctx.state` at parse time (see
  [Context-sensitive parsing](./context)).

Wrap a rule's inner combinator in `parser({ trivia }, combinator)` so trivia-skipping is
baked in no matter which rule you start from. The compiled table records the scope and
elides capture work wherever the final graph proves it unused.

### Scoped trivia ownership

There are three separate concerns here, kept separate on purpose:

- `parser({ trivia, captureTrivia: true }, child)` **activates** recording while `child`
  runs. It is useful for a local grammar scope; the surrounding parser state resumes when
  that scope ends.
- `node(child, build, { captureTrivia: true })` **owns** the per-node log. The log belongs
  to that node's build/CST boundary, not to every combinator below it.
- `node(child, build, { trailingTrivia: true })` is the narrow document-boundary form:
  after `child` succeeds, it commits one final run of the active trivia into that same
  node's log. It also enables that node's capture frame, even when its build/host would
  otherwise elide trivia.
- A direct `build` callback that declares its fifth `triviaLog` parameter retains the
  established capture behavior. That arity analysis is a performance optimization and
  compatibility rule, not a second parser-wide capture API.

Plain combinators such as `sequence()` and `many()` don't own nodes, so they don't
expose or retain a `triviaLog`. Put the ownership boundary at `node()` instead of
building a side channel or reconstructing source gaps later.

```ts
const ws = trivia(regex(/[ \t]+/))

const Pair = node(
  'Pair',
  parser({ trivia: ws }, sequence(regex(/[a-z]+/), literal(':'), regex(/[0-9]+/))),
  (_children, _fields, _span, _rawChildren, triviaLog) => ({ type: 'Pair', triviaLog }),
  { captureTrivia: true },
)

// Only Pair owns these offsets; the inner sequence and terminals remain plain combinators.
Pair.parse('name : 1', 0, { trackLines: false })
```

Use parser-level activation for a nested region only when that region sits inside an
owning `node()`. For example, `node(... parser({ captureTrivia: true }, child) ...)`
records the inner region for that node without making unrelated sibling nodes retain
trivia.

### Terminal document trivia

`many()` correctly rolls back trivia before a failed next item — that run is terminal,
not something between two siblings. A document root that needs to retain a final
comment can opt in without a source-gap scan:

```ts
const Document = node('Document', many(rule), undefined, { trailingTrivia: true })
```

Use this only at a meaningful terminal boundary, normally the document root. A block
body followed by `}` already has a real following term, so its final trivia belongs to
that block's normal node log — don't opt every nested node in. This keeps ordinary
sibling-gap ownership unchanged and avoids a parser-wide capture tax.

### Capture follows your `build`'s arity {#capture-follows-arity}

Building `fields`, `triviaLog`, and cloning `state` per node isn't free — on a
value-dense grammar the per-token trivia-log push alone is a large slice of parse time.
So Parséman skips the capture your `build` never asks for: a `build` that declares only
`(children)` gets no fields, trivia log, or state clone; `(children, fields, span)` gets
named fields and spans but still skips raw children, trivia, and state; declaring
`triviaLog` keeps the log; declaring `state` keeps the clone. This is inferred from the
function's parameter list at compile time — you don't opt in explicitly.

The same inference runs at **parse time** for a [structural `node(parser)`](#just-want-a-plain-cst)
whose AST is built by an injected [`ctx.build` host](#the-nodelike-contract): Parséman
reads the host's arity (`build(type, children, fields, span, rawChildren, triviaLog, state)`) and
elides the trivia/state/field capture the host doesn't take.

::: warning Keep build hosts plain-positional
The arity check has to be conservative: `Function.length` under-counts a **rest**
(`(...args) =>`) or **default** (`(a, b = 1) =>`) parameter, and can't see through a
bound function. Parséman detects rest/default params and `arguments` and falls back to
**full capture** — correct, just not the fast path. So a host written
`(type, ...args) =>` that reads `args[4]` still gets its trivia, but to keep the
elision, declare plain positional parameters and drop the ones you don't use.
:::

> `transform(p, fn)` is still the tool for plain value-mapping (no children/trivia).
> `node()` is for CST/AST rules — it adds the capture `transform` doesn't. Both compile
> under the macro.

## Just want a plain CST? {#just-want-a-plain-cst}

If you don't need a custom AST, **omit `build`**. A `node(combinator)` with no build
callback is *structural*: it constructs its node through a **host** you supply via
`ctx.build`, so the same grammar produces the same default CST whether you pass a host
or not — for your own evaluation AST instead, give the `node()` call a `build` callback
rather than relying on `ctx.build`. Inside `rules()`, the object key is the node type.
Pass the built-in `cstBuildHost` and every rule becomes a uniform positioned node:

```ts
// [verify]
import { rules, node, regex, literal, sequence, many, parser, trivia, run, cstBuildHost } from 'parseman'

const ws = trivia(regex(/\s+/))
const g = rules(gg => ({
  Expr: node(parser({ trivia: ws }, sequence(gg.Num, many(sequence(literal('+'), gg.Num))))),
  Num:  node(regex(/[0-9]+/)),
}))

const r = run(g.Expr, '1 + 2', { build: cstBuildHost })

r.ok
// → true
r.value.type
// → 'Expr'
r.value.span
// → { start: 0, end: 5 }
r.value.children.length
// → 3

// No host at all: the SAME default CST node, spans included.
run(g.Expr, '1 + 2').value.span
// → { start: 0, end: 5 }
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

Visit it with [`createVisitor`](#walking-the-tree), and turn its trivia into a
`before`/`after` lookup with [`buildTriviaIndex`](../reference/api#buildtriviaindex).

That's the whole of it for a structural grammar. No `hostMode`, no compile options —
write productions, omit `build`, pass a host. If this is what you came for, you're done.

::: tip What you get with no host at all
Omitting `build` **and** the host isn't an error, and it doesn't fall back to something
lesser. A structural node with no `ctx.build` constructs the same default CST node —
`{ _tag: 'node', type, span, state, children }`, spans included. For the grammar above,
the two trees are byte-identical.

`cstBuildHost` earns its place for two other reasons: it's what lets a grammar that
*does* have `build` callbacks produce a uniform CST anyway, and it takes a
[`collapse`](../reference/api#cstbuildhost) option for public syntax trees.
:::

## Line/column spans {#linecolumn-spans}

CST nodes carry offset spans by default:

```ts
{ span: { start: 12, end: 18 } }
```

Line/column fields are opt-in. Enable them at the parse call, at a `parser(...)` wrapper,
or for a whole `rules()` grammar:

```ts
parse(root, input, { trackLines: true })
parser({ trackLines: true }, root)
rules({ trackLines: true }, factory)
```

With `trackLines` enabled, CST spans are filled as nodes are created:

```ts
{
  span: {
    start: 12,
    end: 18,
    startLine: 2,
    startColumn: 5,
    endLine: 2,
    endColumn: 11,
  }
}
```

Use `rules({ trackLines: true }, factory)` when the grammar itself is the artifact you
ship, especially under the macro. A line-aware macro artifact is standalone: consumers
run the compiled grammar and get CST nodes with line/column spans, no re-parsing or
tree-walking needed afterward.

Keep `trackLines` off for the normal fast path. Offset-only spans are enough for most
AST work, and the default emits no line-indexing code in macro output. If you only need
line/column for a few diagnostics after parsing, keep offset spans and use the
line-index helpers in the [API reference](../reference/api#line-index-utilities).

### When the grammar has its OWN builders {#host-mode}

A grammar with no direct builders can serve either consumer. The moment you add one,
though, you need a second compilation for the CST consumer — that's the whole reason
`hostMode` exists, and why nothing above this section had to mention it.

The "host set or host unset" switch above is a genuine per-parse choice for
**structural** nodes — that's the `node(parser)` contract, and it's unchanged.

A node with its own `build` callback is different. The callback owns the result, so the
artifact has to be told at COMPILE time which consumer it is for:

```ts
const factory = (g) => ({ /* … the whole grammar, written once … */ })

export const grammar    = rules({ trivia: rw }, factory)                    // eval AST
export const cstGrammar = rules({ trivia: rw, hostMode: 'cst' }, factory)   // positioned CST
```

One source, two compilations — each bundle tree-shakes away the artifact it doesn't
import, so the eval path carries no CST capture and the tooling path carries no eval
builders. The same option exists on [`compile`](../reference/api#compile) and
[`compose`](../reference/api#compose).

`hostMode` defaults to **`'ast'`**, so a grammar with `build` callbacks just runs them —
almost always what you want, which is why nothing before this point had to mention the
option. You add `hostMode: 'cst'` for the *second* artifact, not the first. This
two-artifact pattern is the advanced case: most first grammars are structural and never
need it.

Why not decide per parse? `hostMode` doesn't just pick which builder runs — it decides
what every node captures (children, raw children, trivia log, fields, state). A runtime
switch would keep all of that live on both paths, so an eval parse would pay for CST
capture it never reads.

Getting it wrong is an error, not a degraded tree: driving an `'ast'` artifact with a
positioned-CST host throws, naming the fix. Without that check, the builder's own object
would travel into the tree as a non-CST child, a CST child filter would drop it, and the
node would simply vanish from an otherwise successful parse.

## Unwrapping and collapsing wrapper rules

Layered grammars accumulate "wrapper" rules that exist only for structure — an
expression precedence ladder (`Sum` → `Product` → `Primary`), or a selector-list rule
that wraps a single selector. When such a rule matches just **one** child, the wrapper
node is noise: you want to *be* that child, not box it.

The `unwrap` and `collapse` options handle that for grammar-local wrapper rules. Both
skip `build` for a **one-child** match; zero or two-plus children go through `build` as
normal. The difference is the shape of a single captured leaf:

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

So `2` parses to a bare `Product` node — no redundant `Sum` wrapper — while `2 + 3`
produces a real `Sum` node with its children. You get readable layered rules without
paying a `build` call per transparent layer, and without hand-writing
`if (children.length === 1) return children[0]` in every wrapper builder.

`unwrap` and `collapse` produce identical results under the **interpreter, `compile()`,
and the macro build**: the compiled output emits a
`children.length === 1 ? <single-child> : build(…)` ternary, and the plugin reads static
`{ unwrap: true }` / `{ collapse: true }` literals as the 4th argument.

## Projecting one semantic child

Some AST rules aren't one-child wrappers. They recognize punctuation, comments, or other
syntactic scaffolding that a CST host must still see, even though the AST value is just
one semantic child. A parenthesized expression is the small version:

```ts
const paren = node('Paren',
  sequence(literal('('), expr, literal(')')),
  { project: 1 },
)
```

AST mode returns captured child `1`; the `(` and `)` leaves are still captured inside
the node frame. Compile the same grammar with `hostMode: 'cst'`, and the positioned-CST
host receives the full child list, raw children, spans, fields, and trivia exactly like
an ordinary direct node.

Projection is semantic value shaping, so a selected leaf becomes its string value,
matching `unwrap`. A selected sub-node is returned as-is.

This lives on `node()` rather than in a separate value wrapper on purpose: `node()` is
the grammar boundary that owns CST capture, host-mode selection, serialization, specs,
coverage, and tracing. A projection option is plain serializable data, so composed
grammars can carry it through IR without callback source.

Reach for `project` only when the selected child index is part of the grammar shape. The
API is intentionally just a number. If the rule needs predicates such as "first value
child," "all statement children," exact CST-leaf projection, or string reconstruction
from several tokens, use a normal `build` callback instead.

::: tip Grammar collapse vs host collapse
`node(..., { collapse: true })` is a grammar-local decision for one wrapper rule. For a
public CST parser, `cstBuildHost({ collapse })` lets the caller apply a host-wide collapse
policy without changing the grammar's AST/value behavior.
:::

## Collapsing public CST wrappers

When a structural grammar is also a public CST parser, you might want the same
transparent wrapper policy without changing AST/value behavior. Pass a configured CST
host:

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

Because the policy lives on the build host, a composed grammar can expose a compact
public CST while the evaluator keeps using the grammar's own AST builders. The
interpreter, `compile()`, and macro output all check the policy while the node is being
built, so there's no separate tree-normalization pass.

## The `NodeLike` contract

Any AST your `build` callbacks produce can participate in incremental re-parsing, as
long as it satisfies `NodeLike`. That's the whole contract:

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
(`_tag: 'node'`) from everything else. The `type` string must match the rule name in the
registry so [`edit()`](./incremental) can re-parse the right rule.

The built-in CST leaf/node/error shapes are also exported as types — `CSTNode`,
`CSTLeaf`, `CSTError`, `CSTTrivia` — if you'd rather use them directly. See the
[types reference](../reference/types#cst-types).

## Walking the tree

The tree is plain objects, so you're free to recurse it yourself. For typed traversal,
`createVisitor(grammar, spec)` dispatches by concrete node type and by tags declared on
`node(..., { tags })`. The same call works with an interpreted `rules()` grammar or a
compiled/macro/`compose()` grammar.

### Tagging related node types

Use `tags` when several concrete node types belong to the same semantic family. The
node's `type` stays specific, while each tag gives visitors another stable dispatch key:

```ts
import { choice, literal, node, rules, sequence } from 'parseman'

const grammar = rules(g => ({
  Statement: choice(g.AtRuleWithBlock, g.AtRuleStatement, g.Declaration),

  AtRuleWithBlock: node(
    'AtRuleWithBlock',
    sequence(literal('@media'), literal('{'), literal('}')),
    { tags: ['AtRule', 'Statement'] },
  ),

  AtRuleStatement: node(
    'AtRuleStatement',
    sequence(literal('@import'), literal(';')),
    { tags: ['AtRule', 'Statement'] },
  ),

  Declaration: node(
    'Declaration',
    sequence(literal('color'), literal(':'), literal('red'), literal(';')),
    { tags: ['Statement'] },
  ),
}))
```

Tags are grammar metadata by default. They're available to `createVisitor(...)` without
adding a `tags` property to every CST node.

### Creating a visitor

Pass the grammar and a handler object to `createVisitor`. The function it returns visits
a tree depth-first:

```ts
import { createVisitor, cstBuildHost, parseDoc } from 'parseman'

const doc = parseDoc(grammar, 'Statement', '@media{}', { build: cstBuildHost })
const tree = doc.tree

const visit = createVisitor(grammar, {
  type: {
    AtRuleWithBlock(node) {
      // Only block-form at-rules.
    },
    Declaration(node) {
      // Only declarations.
    },
  },
  tag: {
    AtRule(node) {
      // Both AtRuleWithBlock and AtRuleStatement.
    },
    Statement(node) {
      // At-rules and declarations.
    },
  },
  enter(node) {},
  leave(node) {},
})

if (tree) visit(tree)
```

`type` keys are checked against the grammar's CST node types. `tag` keys are checked
against tags declared by the grammar, and a node with multiple tags runs each matching
tag handler in declared tag order. `enter` runs before `type`/`tag` handlers, and `leave`
runs after children. Return `false` from `enter` to skip a node's children.

The visitor doesn't need `node.tags` at runtime — it reads the grammar's reflection
table and maps a node's `type` to its declared tags. That keeps the default CST shape
lean, and lets the same visitor work for interpreted grammars, compiled grammars, macro
artifacts, and composed grammars alike.

### Materializing tags on CST nodes

When a downstream tool wants to inspect tags directly from the tree, opt in at the CST host:

```ts
import { cstBuildHost, run } from 'parseman'

const result = run(grammar.AtRuleWithBlock, '@media{}', {
  build: cstBuildHost({ tags: true }),
})

if (result.ok) {
  result.value.tags
  // => ['AtRule', 'Statement']
}
```

The materialized array is the rule's static tag array. Untagged nodes still omit the
property, and the default `cstBuildHost` omits `tags` properties altogether.

## Next

- Wire your rule registry into a live-editing document in
  [Incremental re-parsing](./incremental).
- Thread parse-time context through nodes in [Context-sensitive parsing](./context).
