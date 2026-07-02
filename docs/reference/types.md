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
type NodeOptions = { collapse?: boolean }
```

See [collapsing wrapper rules](../guide/ast#collapsing-wrapper-rules).

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

## Incremental re-parsing

```ts
type Registry<N>          = Record<string, RuleFn<N>>
type RuleFn<N>            = (input: string, pos: number, ctx: ParseContext) => ParseResult<N>
type FunctionalDocOptions<N> = {
  state?: unknown
  rebuild?: (node: N, children: ReadonlyArray<unknown>) => N
}

interface FunctionalDoc<N extends NodeLike> {
  readonly tree: N | null
  readonly errors: ParseFail[]
  readonly input: string
  edit(from: number, to: number, replacement: string): FunctionalDoc<N>
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
