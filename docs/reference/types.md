# Types

Every type exported from `parseman`. Import them with `import type`:

```ts
import type { Combinator, ParseResult, Span, NodeLike } from 'parseman'
```

## Core

### `Combinator<T>`

The building block. A combinator carries metadata and a `parse` method; you rarely
construct one by hand — you compose them with the [combinators](../guide/combinators).

```ts
type Combinator<T> = {
  _tag: string
  _meta: ParserMeta
  _def: ParserDef
  parse(input: string, pos: number, ctx: ParseContext): ParseResult<T>
}
```

### `ParseResult<T>`

The result of a parse — a discriminated union on `ok`.

```ts
type ParseResult<T> = ParseOk<T> | ParseFail

type ParseOk<T> = {
  ok: true
  value: T
  span: Span
  trivia?: readonly number[]   // root trivia log, when captured
  errors?: ParseError[]        // present when parsed with { recover: true }
  furthestFail?: ParseFail | null
}

type ParseFail = {
  ok: false
  expected: string[]
  span: Span
}
```

### `Span`

Byte offsets, plus optional line/column when `trackLines` is on.

```ts
type Span = {
  start: number         // byte offset, inclusive
  end: number           // byte offset, exclusive
  startLine?: number    // 1-based; only when trackLines: true
  startColumn?: number
  endLine?: number
  endColumn?: number
}
```

### `ParseContext`

The mutable state threaded through a parse — trivia settings, CST collectors, user
`state`, the error channel (`_errors`), and probe data. Passed to `parse` methods; you
only touch it when writing a low-level combinator.

## Options

### `ParseOptions`

```ts
type ParseOptions = {
  trackLines?: boolean   // default false — populate line/column on spans
  recover?: boolean      // default false — collect errors + furthestFail
}
```

### `ParserOptions`

`ParseOptions` plus the document-level knobs for `parser()`:

```ts
type ParserOptions = ParseOptions & {
  trivia?: Combinator<unknown> | null   // null clears active trivia
  captureTrivia?: boolean
}
```

### `LiteralOptions` · `KeywordsOptions` · `WordOptions`

```ts
type LiteralOptions  = { caseInsensitive?: boolean }
type KeywordsOptions = { caseInsensitive?: boolean; boundary?: string }
type WordOptions     = { caseInsensitive?: boolean }
```

### `NodeOptions`

```ts
type NodeOptions = {
  unwrap?: boolean
  collapse?: boolean
  project?: number
  captureTrivia?: boolean
  trailingTrivia?: boolean // commit one active-trivia run at this node's terminal boundary
  tags?: readonly string[] // visitor categories for this CST node type
}
```

`unwrap` is for AST/value wrapper rules: when exactly one child is captured, `build` is
skipped and a captured leaf becomes its string value. `collapse` is for structural/CST
wrapper rules: when exactly one child is captured, `build` is skipped and that child is
returned exactly. `project` is for AST/value rules whose semantic value is one fixed captured
child by index; projected leaves become strings, projected sub-nodes are returned as-is, and
`hostMode: 'cst'` still gives the CST host the full node frame. `project` cannot be combined
with `build`, `unwrap`, or `collapse`. `captureTrivia` owns interior trivia. `trailingTrivia`
is for a repeating document root at EOF: it commits the active terminal trivia to that node's
log; blocks with a closing delimiter do not need it. `tags` declares grammar-level CST
categories used by `createVisitor(grammar, { tag: … })`; tags are stored in grammar
reflection, and are not copied onto CST nodes by default. Use
`cstBuildHost({ tags: true })` to materialize them on produced CST nodes. Set at most one of `unwrap` and
`collapse`. See
[unwrapping and collapsing wrapper rules](../guide/ast#unwrapping-and-collapsing-wrapper-rules).

`node(..., { project: index })` also exports the narrower options helper type used by the
projection overload:

```ts
type NodeProjectOptions<I extends number = number> =
  Omit<NodeOptions, 'project' | 'unwrap' | 'collapse'> & {
    project: I
    unwrap?: never
    collapse?: never
  }
```

### `ScanToOptions`

```ts
type ScanToOptions = {
  skip?: Combinator<unknown>[]   // opaque regions to skip intact
  orEOF?: boolean                // reaching EOF is a success (default false)
}
```

## Parsers

### `ParsemanParser<T>`

What `parser()` / `noTrivia()` return — a `Combinator<T>` with a `.parse(input)`
convenience overload.

### `CompiledParser<T>`

What `compile()` returns:

```ts
type CompiledParser<T> = {
  parse(input: string, pos?: number, opts?: ParseOptions): ParseResult<T>
  parseWithContext(input: string, ctx: ParseContext, pos?: number): ParseResult<T>
  parseWithErrors(input: string, pos?: number): ParseResult<T>  // enables the _errors channel
  source: string             // the generated JS source
  inlineExpression: string   // a self-contained expression (what the plugin inlines)
}
```

### `Runnable` · `RunOptions` · `RunResult` {#runresult}

What [`run()`](./api#run-entry-input-opts) accepts and returns:

```ts
type Runnable =
  | ((input: string, pos: number, ctx: ParseContext) => ParseResult<unknown>)  // a compiled rule fn
  | Combinator<unknown>                                                          // or an interpreter combinator

type RunOptions = {
  build?: ParseContext['build']   // ctx.build host (structural node() → CST/AST)
  state?: unknown                 // initial ctx.state
  trivia?: Runnable       // skip trailing trivia before computing unconsumedFrom
  triviaCaptureMask?: number      // per-node CST trivia-kind bitmask
  rootTrivia?: {
    select: readonly string[]
  }
  tolerant?: boolean              // enable list recovery diagnostics
  profile?: boolean               // compiled-only profiling passes
}

type RunResult = {
  ok: boolean
  value: unknown                       // the entry's value (undefined on failure)
  span: { start: number; end: number }
  expected: string[]                   // when the top-level parse failed
  errors: ParseError[]                 // tolerant-list / expect() diagnostics
  rootTrivia?: RootTriviaCapture        // only when selected root rows were retained
  unconsumedFrom: number | null            // first non-trivia offset left unconsumed, else null
}

type RootTriviaCapture = {
  rows: readonly number[]              // packed selected-root rows
  select: readonly string[]            // label table for the row kind column
  index: RootTriviaIndex               // lazy sparse gap index over rows
}
```

### `RootTriviaIndex`

```ts
type RootTriviaIndex = {
  entries: TriviaEntriesView
  labels: readonly string[] | undefined
  before: ReadonlyMap<number, readonly number[]> // following content offset -> entry indices
  after: ReadonlyMap<number, readonly number[]>  // preceding content offset -> entry indices
  entryIndicesBefore(offset: number): readonly number[]
  entryIndicesAfter(offset: number): readonly number[]
  gapBefore(offset: number): RootTriviaGap | undefined
  gapAfter(offset: number): RootTriviaGap | undefined
  gaps(): readonly RootTriviaGap[]
  gapsWithKind(kind: string | readonly string[]): readonly RootTriviaGap[]
}

type RootTriviaGap = {
  start: number
  end: number
  entryIndices: readonly number[]
  hasKind(kind: string): boolean
  text(input: string): string
}
```

### `CstBuildHostOptions`

```ts
type CstCollapsePredicate = (
  type: string,
  child: unknown,
  children: readonly unknown[],
  rawChildren: readonly unknown[],
) => boolean

type CstBuildHostOptions = {
  collapse?: boolean | readonly string[] | CstCollapsePredicate
  tags?: boolean
}
```

`cstBuildHost({ collapse })` collapses transparent one-child CST wrappers during
node construction. `true` collapses any one-child wrapper whose raw child list is
also one item; an array limits collapse to named grammar node types; a predicate
lets a language define its public CST policy. The returned child is still the original
CST child object; leaves are not unwrapped to strings. The predicate is typed over
`unknown` because `ctx.build` is a general host hook, but with the built-in
`cstBuildHost` those values are CST children.

`cstBuildHost({ tags: true })` copies a tagged rule's static `node(..., { tags })`
array onto the produced CST node as `node.tags`. Without this option, tags remain
grammar metadata for `createVisitor(grammar, spec)` and do not change the CST shape.
The array is reused as static rule metadata; it is not copied per handler dispatch.

## Building nodes

### `BuildNode<N>`

The `build` callback signature for [`node()`](../guide/ast):

```ts
type BuildNode<N> = (
  children: ReadonlyArray<unknown>,
  fields: FieldMap | undefined,
  span: { start: number; end: number },
  rawChildren: ReadonlyArray<unknown>,
  triviaLog: readonly number[],
  state: unknown,
) => N
```

```ts
type FieldCapture<T = unknown> = {
  value: T
  span: Span
}

type FieldMap = Record<string, FieldCapture | FieldCapture[]>
```

### `NodeLike`

The minimal contract an AST node must satisfy to participate in incremental re-parsing:

```ts
type NodeLike = {
  readonly _tag: 'node'
  readonly type: string        // rule name — the registry key on re-parse
  readonly span: Span
  readonly state: unknown      // ctx.state snapshot; replayed on edit
  readonly children: ReadonlyArray<{ readonly _tag: string }>
}
```

## CST types {#cst-types}

Built-in node shapes, if you'd rather use them than roll your own:

```ts
type CSTNode   = { _tag: 'node';   type: string; span: Span; children: CSTChild[]; state: unknown }
type CSTLeaf   = { _tag: 'leaf';   value: string; span: Span }
type CSTTrivia = { _tag: 'trivia'; value: string; span: Span }
type CSTError  = { _tag: 'parseError'; span: Span; expected: string[] }

type CSTChild    = CSTNode | CSTLeaf | CSTError
type CSTRawChild = CSTNode | CSTLeaf | CSTTrivia | CSTError
```

::: tip `CSTError` is the embedded `ParseError`
`CSTError` is the recovered [`ParseError`](#parseerror) (`_tag: 'parseError'`) as it
appears **in the tree**: when a CST host is active, tolerant recovery embeds one as a
`children` entry spanning the skipped text — the same value that also lands in the flat
`errors` channel. See [Error recovery](../guide/error-recovery).
:::

### `ParseError`

```ts
type ParseError = {
  _tag: 'parseError'
  span: Span
  expected: string[]
}
```

## Tree traversal

The shapes accepted by [`createVisitor`](../guide/ast#walking-the-tree). It defaults its
node type to [`CSTChild`](#cst-types); pass your own AST node as a generic to override.

### `Walkable`

The minimal contract the visitor traverses — a `_tag`, an optional rule `type`, and
optional structural `children`. Built-in `CSTChild` satisfies it, and so does any custom
AST node (the generic-override target).

```ts
type Walkable = {
  readonly _tag: string
  readonly type?: string
  readonly children?: ReadonlyArray<Walkable>
}
```

### `VisitorSpec` · `VisitorHandler` {#walk-types}

```ts
type VisitorHandler<N extends Walkable, Root extends Walkable = CSTChild, C = undefined> =
  (node: N, parent: Root | null, ctx: C) => void

type VisitorSpec<G, N extends Walkable = CSTChild, C = undefined> = {
  enter?(node: N, parent: N | null, ctx: C): boolean | void  // false → skip subtree
  leave?(node: N, parent: N | null, ctx: C): void
  type?: { [Type in GrammarNodeTypes<G>]?: VisitorHandler<NodeForType<N, Type>, N, C> }
  tag?: { [Tag in GrammarTags<G>]?: VisitorHandler<NodeForType<N, GrammarNodeTypes<G>>, N, C> }
}
```

`G` is the grammar object passed to `createVisitor(grammar, spec)`. When `G` carries
reflection from `rules()`, macro output, compilation, or `compose()`, TypeScript narrows
`type` keys to concrete node types and `tag` keys to declared `node(..., { tags })` values.

`N` is the tree node shape you are traversing. Leave it as the default for Parseman's CST
nodes, or pass your own AST/CST-compatible node union when a build host produces a richer
tree. `NodeForType<N, Type>` narrows a type handler to the member of `N` with that concrete
`type`; tag handlers receive a node whose type is one of the grammar's node types because a
tag may belong to several concrete types.

`C` is an optional caller context. Pass it as the second argument to the returned visitor:

```ts
const visit = createVisitor<typeof grammar, CSTChild, { declarations: number }>(grammar, {
  type: {
    Declaration(_node, _parent, ctx) {
      ctx.declarations++
    },
  },
})

visit(tree, { declarations: 0 })
```

## Incremental re-parsing

```ts
type Registry<N>          = Record<string, RuleFn<N>>
type RuleFn<N>            = (input: string, pos: number, ctx: ParseContext) => ParseResult<N>
type ParseDocOptions<N> = {
  state?: unknown
  rebuild?: (node: N, children: ReadonlyArray<unknown>) => N
  // Mode host: threaded into ctx.build on every (re)parse, so a composed grammar
  // builds a positioned CST / language-service tree instead of its own AST.
  build?: ParseContext['build']
}

interface ParseDoc<N extends NodeLike> {
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  edit(from: number, to: number, replacement: string): ParseDoc<N>
}
```

## Trivia index

```ts
type TriviaToken        = { value: string; span: Span }
type TriviaIndex        = { before: Map<unknown, TriviaToken[]>; after: Map<unknown, TriviaToken[]> }
type TriviaIndexOptions = { trivia: RegExp }
type TriviaEntriesView  = {
  length: number
  labels?: readonly string[]
  stride: number
  start(i: number): number
  end(i: number): number
  insertIndex(i: number): number | undefined
  kindIndex(i: number): number | undefined
  kind(i: number): string | undefined
  text(i: number, input: string): string
}
type RootTriviaGap = {
  start: number
  end: number
  entryIndices: readonly number[]
  hasKind(kind: string): boolean
  text(input: string): string
}
```

## Metadata & internals

These describe a combinator's static analysis; you'll meet them when writing a custom
combinator or reading `_def` / `_meta`.

```ts
type ParserMeta    = { firstSet: FirstSet; canMatchNewline: boolean; isTrivia: boolean; /* … */ }
type FirstSet      = { kind: 'any' } | { kind: 'ranges'; ranges: CharRange[] } | { kind: 'empty' }
type CharRange     = { lo: number; hi: number }
type ParserDef     = /* tagged union of every combinator's definition */
type ChoiceStrategy = { tag: 'greedyClassify';       superIndex: number }
                    | { tag: 'literalsLongestFirst'; sortedIndices: number[] }
                    | { tag: 'firstMatch' }
                    | { tag: 'sharedPrefix';         prefix: Combinator<unknown>; members: number[] }
type AutoNotCheck  = { kind: 'firstSet'; set: FirstSet } | { kind: 'startsWith'; value: string }
type GatedArm<T>   = { gate: (state: unknown) => boolean; combinator: Combinator<T> }
```
