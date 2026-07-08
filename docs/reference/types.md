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

### `LiteralOptions` · `KeywordsOptions`

```ts
type LiteralOptions  = { caseInsensitive?: boolean }
type KeywordsOptions = { caseInsensitive?: boolean; boundary?: string }
```

### `NodeOptions`

```ts
type NodeOptions = {
  unwrap?: boolean
  collapse?: boolean
}
```

`unwrap` is for AST/value wrapper rules: when exactly one child is captured, `build` is
skipped and a captured leaf becomes its string value. `collapse` is for structural/CST
wrapper rules: when exactly one child is captured, `build` is skipped and that child is
returned exactly. Set at most one option. See
[unwrapping and collapsing wrapper rules](../guide/ast#unwrapping-and-collapsing-wrapper-rules).

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
}

type RunResult = {
  ok: boolean
  value: unknown                       // the entry's value (undefined on failure)
  span: { start: number; end: number }
  expected: string[]                   // when the top-level parse failed
  errors: ParseError[]                 // recover()/expect() diagnostics
  triviaLog: number[]                  // flat [start, end] pairs
  unconsumedFrom: number | null            // first non-trivia offset left unconsumed, else null
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
}
```

`cstBuildHost({ collapse })` collapses transparent one-child CST wrappers during
node construction. `true` collapses any one-child wrapper whose raw child list is
also one item; an array limits collapse to named grammar node types; a predicate
lets a language define its public CST policy. The returned child is still the original
CST child object; leaves are not unwrapped to strings. The predicate is typed over
`unknown` because `ctx.build` is a general host hook, but with the built-in
`cstBuildHost` those values are CST children.

## Building nodes

### `BuildNode<N>`

The `build` callback signature for [`node()`](../guide/ast):

```ts
type BuildNode<N> = (
  children: ReadonlyArray<unknown>,
  rawChildren: ReadonlyArray<unknown>,
  span: { start: number; end: number },
  triviaLog: readonly number[],
  state: unknown,
) => N
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
type CSTError  = { _tag: 'error';  type: string; span: Span; expected: string[]; children: CSTChild[]; state: unknown }

type CSTChild    = CSTNode | CSTLeaf | CSTError
type CSTRawChild = CSTNode | CSTLeaf | CSTTrivia | CSTError
```

::: tip `CSTError` vs `ParseError`
`CSTError` (`_tag: 'error'`) is a *tree-node* type for representing an error node in your
own AST. The recovery combinators (`recover`, `expect`) produce a
[`ParseError`](#parseerror) (`_tag: 'parseError'`) value instead — see
[Error recovery](../guide/error-recovery).
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

The shapes accepted by [`walk` / `createVisitor`](../guide/ast#walking-the-tree). Both
default their node type to [`CSTChild`](#cst-types); pass your own AST node as a generic to
override.

### `Walkable`

The minimal contract these helpers traverse — a `_tag`, an optional rule `type`, and
optional structural `children`. Built-in `CSTChild` satisfies it, and so does any custom
AST node (the generic-override target).

```ts
type Walkable = {
  readonly _tag: string
  readonly type?: string
  readonly children?: ReadonlyArray<Walkable>
}
```

### `WalkVisitor` · `VisitApi` · `VisitorHandlers` {#walk-types}

```ts
interface WalkVisitor<N extends Walkable = CSTChild, C = undefined> {
  enter?(node: N, parent: N | null, ctx: C): boolean | void  // false → skip subtree
  leave?(node: N, parent: N | null, ctx: C): void
}

interface VisitApi<R, N extends Walkable = CSTChild> {
  visit(node: N): R | undefined       // dispatch one node to its handler
  visitChildren(node: N): R[]         // visit each child, collect defined results
}

type VisitorHandlers<R, N extends Walkable = CSTChild> =
  Record<string, (node: N, api: VisitApi<R, N>) => R>
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
  kindIndex(i: number): number
  kind(i: number): string | undefined
  text(i: number, input: string): string
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
type ChoiceStrategy = 'greedyClassify' | 'literalsLongestFirst' | 'firstMatch'
type AutoNotCheck  = { kind: 'firstSet'; set: FirstSet } | { kind: 'startsWith'; value: string }
type GatedArm<T>   = { gate: (state: unknown) => boolean; combinator: Combinator<T> }
```
