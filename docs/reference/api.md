# API reference

Every value exported from `parseman`. Types are listed separately in
[Types](./types). Import anything from the package root:

```ts
import { literal, choice, sequence, node, parse /* … */ } from 'parseman'
```

[[toc]]

## Terminals

### `literal(value, opts?)`

Exact string match. `opts.caseInsensitive` compares with a locale-aware `Intl.Collator`.

```ts
literal('const')
literal('SELECT', { caseInsensitive: true })
```

### `regex(pattern, flags?)`

Match a regular expression at the current position. Patterns are compiled to sticky
(`/…/y`) regexes and optimized via `regexp-tree`; the first-set is derived for O(1)
`choice` dispatch.

```ts
regex(/[0-9]+/)
regex(/[a-z]+/i)
```

### `word(str, boundary?)`

A single keyword with a trailing word-boundary guard, so `word('if')` won't match the
`if` in `ifdef`. `boundary` is the character class that must *not* follow (default
`_0-9A-Za-z`).

### `keywords(words, opts?)`

Match one of many keywords, longest-first, compiled to a single sticky regex.
`opts.boundary` and `opts.caseInsensitive` apply to the whole set.

```ts
keywords(['GET', 'POST', 'PUT'])
keywords(['media', 'supports'], { boundary: 'A-Za-z0-9_-' })
```

### `makeWord(boundary?)` <Badge type="tip" text="helper" />

Returns a `(str) => Combinator` factory with a fixed boundary class. Equivalent to
`(s) => keywords([s], { boundary })`.

## Composition

### `sequence(...combinators)`

Match all in order; returns a tuple of their values. Skips trivia between terms when
trivia is active.

### `choice(...args)`

Ordered PEG alternatives — first match wins. Arms may be plain combinators or
[gated arms](#gated-arms). Disjoint first characters compile to an O(1) dispatch.

### `many(combinator)` · `oneOrMore(combinator)` · `optional(combinator)` · `sepBy(combinator, sep)`

Repetition and optionality. `many` is zero-or-more, `oneOrMore` fails on zero, `optional`
returns `null` on no match, `sepBy` matches items separated by `sep`.

### `transform(combinator, fn)`

Map a successful value (and span) through `fn(value, span)`. For plain value-mapping only;
use [`node`](#node-type-combinator-build-opts) for tree building.

### `skip(main, skipped)`

Match `main` then `skipped`; return `main`'s value, with the span extended across both.

### `not(combinator)`

Negative lookahead — succeeds consuming nothing when `combinator` fails.

### `label(name, combinator)`

Attach a metadata label (used for per-chunk trivia kinds; see
[Whitespace & trivia](../guide/trivia#capturing-trivia-kinds)). Parse behavior is
unchanged.

## Recursion

### `rules(factory)` <Badge type="tip" text="helper" />

Named, mutually-recursive rule bundle. The factory receives a proxy of all rule names and
returns the definitions. See [Recursive rules](../guide/recursive-rules).

### `ref<T>()`

Low-level forward-declaration slot. `ref()` returns a combinator with a `.define(p)`
method. Prefer `rules()`.

## Trees

### `node(type, combinator, build, opts?)`

CST/AST rule. Captures the combinator's terminals into `children` / `rawChildren` and
trivia into `triviaLog`, then calls `build(children, rawChildren, span, triviaLog, state)`.
`opts.collapse` returns the single child directly for one-child matches (skipping `build`).
See [CST / AST nodes](../guide/ast).

### `buildTriviaIndex(root, input?, opts?)` {#buildtriviaindex}

Walk a CST and build `before` / `after` maps of trivia tokens keyed by node — turning the
flat `triviaLog` into a lookup table for whitespace-sensitive analysis.

### `triviaEntries(log, labels?, opts?)`

An indexed, allocation-free view over a flat trivia log: `.start(i)`, `.end(i)`,
`.kind(i)`, `.text(i, input)`. Pass `{ nodeLog: true }` for per-node logs (stride 3/4).

## Tree traversal

The tree a grammar produces is plain objects, so you can recurse it yourself — these two
helpers save writing the same traversal. Both default to the CST shape ([`CSTChild`](./types#cst-types))
and accept a generic for custom AST shapes. See [Walking the tree](../guide/ast#walking-the-tree).

### `walk(root, visitor, ctx?)`

Depth-first traversal. Calls `visitor.enter(node, parent, ctx)` before a node's children and
`visitor.leave(node, parent, ctx)` after. Return `false` from `enter` to skip that node's
subtree (`leave` still runs). `ctx` is threaded to both hooks unchanged (use it as an
accumulator). Override the node type with `walk<MyNode>(root, …)`.

```ts
const leaves: string[] = []
walk(tree, {
  enter(node) {
    if (node._tag === 'leaf') leaves.push(node.value)
  },
})
```

### `createVisitor(handlers)`

Build a visitor that dispatches on each node's `type` — the runtime analog of a generated
CST-visitor base class. Handlers are keyed by rule name and receive an
[`api`](./types#walk-types) with `visit` / `visitChildren` to recurse; a node whose `type`
has no handler falls through to its children,
so partial visitors work. Override the return and node types with
`createVisitor<R, MyNode>({ … })`.

```ts
const evalExpr = createVisitor<number>({
  Num: (n) => Number((n.children[0] as CSTLeaf).value),
  Add: (n, api) => api.visitChildren(n).reduce((a, b) => a + b, 0),
})

const total = evalExpr(tree)
```

## Whitespace

### `trivia(combinator)` <Badge type="tip" text="helper" />

Mark a combinator as skippable filler (sets `isTrivia`). Does not skip until installed via
`parser({ trivia })`.

### `parser(opts, root)` <Badge type="tip" text="helper" />

Wrap a root combinator with document-level options — `trivia`, `trackLines`,
`captureTrivia` — and add a `.parse(input)` convenience method.

### `noTrivia(root)` <Badge type="tip" text="helper" />

Shorthand for `parser({ trivia: null }, root)` — run `root` with active trivia cleared, so
its terms must be contiguous.

## Running a parse

### `parse(combinator, input, opts?)`

Run a combinator against `input` from offset 0. Returns a [`ParseResult`](./types#parseresult).

```ts
parse(myParser, 'hello world', { trackLines: true, recover: true })
```

`ParseOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `trackLines` | `false` | Populate `startLine`/`startColumn`/`endLine`/`endColumn` on spans |
| `recover` | `false` | Collect recovered errors into `result.errors` and record `result.furthestFail` |

#### Line / column tracking

```ts
const r = parse(myParser, 'hello\nworld', { trackLines: true })

if (r.ok) {
  r.span.startLine   // 1
  r.span.startColumn // 1
  r.span.endLine     // 2
  r.span.endColumn   // 6
}
```

Line lookup is O(log n) via binary search on a newline index built once per input string.
When `trackLines` is false (the default), no index is built and spans carry only byte
offsets.

## Compilation

### `compile(combinator, mapFnSources?)`

JIT-compile a combinator tree to an optimized JS function at runtime. Returns a
[`CompiledParser`](./types#compiledparser) exposing `.parse()`, `.parseWithContext()`,
`.parseWithErrors()`, plus the generated `.source` and `.inlineExpression` strings.
Requires `new Function` (won't run under a strict CSP). See
[The three modes](../guide/modes#compile-runtime-jit).

## Error recovery

### `recover(combinator, sentinel)`

On failure, scan forward to `sentinel` (not consumed) and return a
[`ParseError`](./types#parseerror) spanning the skipped text. See
[Error recovery](../guide/error-recovery#recover-skip-to-a-sentinel).

### `expect(combinator, label?)`

Required token. On failure, record a zero-width `ParseError` and recover in place.
`label` overrides the derived `expected` message. See
[Error recovery](../guide/error-recovery#expect-required-tokens).

### `sepByRecover(item, separator, until)`

Tolerant `sepBy`: a malformed element is skipped to the next `separator` or the `until` terminator and
recorded as a [`ParseError`](./types#parseerror) in the result array, instead of truncating
the list. `until` (the closing delimiter, matched but **not** consumed) is what distinguishes
an empty list from a malformed first element. Built from existing combinators, so `.compile()`
and CST capture handle it with no special cases. See
[Tolerant lists](../guide/error-recovery#tolerant-lists).

```ts
const elements = sepByRecover(value, literal(','), literal(']'))
// "[1,,3]" → [1, ParseError, 3]
```

### `manyRecover(item, until)`

Tolerant `many`: junk that is neither a valid `item` nor the `until` terminator is skipped up to `until` and
recorded as a `ParseError`, instead of ending the repetition. With no separator to resync
on, a bad run is captured as a single error up to the terminator. See
[Tolerant lists](../guide/error-recovery#tolerant-lists).

```ts
const items = manyRecover(statement, literal('}'))
```

### `staticExpected(combinator)` {#staticexpected}

Statically derive the `expected` string set from a combinator's structure (literals →
quoted, choice → union of arms, sequence → first term, etc.). This is what lets `expect`
report an identical expectation in the interpreter and the compiled output.

### `isParseError(value)`

Type guard: `value is ParseError` (`_tag === 'parseError'`).

### `scanTo(sentinel, opts?)`

Consume text up to (not including) `sentinel`; return it. `opts.skip` declares opaque
regions to skip intact; `opts.orEOF` makes EOF a success.

### `balanced(open, close, opts?)`

Match one balanced delimited region — **string** delimiters — including the delimiters,
counting nested same-type pairs. `opts.skip` (combinators) declares regions that may
contain unbalanced delimiters.

## Context

### `guard(predicate)`

Zero-width success only when `predicate(ctx.state)` is true.

### `withCtx(extra, combinator)`

Run `combinator` with `extra` merged into `ctx.state`, restored on exit.

## IDE support

### `completionsAt(combinator, input, offset)`

Return the set of expected tokens at a cursor `offset` — the raw material for
autocomplete. Probes the grammar at that position via a truncated parse.

## Incremental re-parsing

### `parseDoc(registry, rootRule, input, opts?)`

::: warning Experimental
Incremental re-parsing is **experimental** and its API may still change. Pin your version.
:::

Wrap a parse in an immutable document that re-parses incrementally via `.edit(from, to,
replacement)`. `registry` is the object `rules()` returns. See
[Incremental re-parsing](../guide/incremental).

## Line index (low-level)

Usually you just pass `trackLines: true` to `parse`. These are the primitives behind it:

### `buildLineIndex(input)`

Precompute newline offsets → a `LineIndex` for O(log n) lookups.

### `offsetToLineCol(index, offset)`

Map a byte offset to `{ line, col }` (1-based).

### `annotateSpan(span, index)`

Return a copy of `span` with `startLine`/`startColumn`/`endLine`/`endColumn` filled in.

## Gated arms

`choice` accepts `{ gate, combinator }` objects in place of a bare combinator; the arm is
only attempted when `gate(ctx.state)` returns true. See
[Ordered choice & keywords](../guide/keywords#gated-alternatives).
