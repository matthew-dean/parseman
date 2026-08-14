# Upgrading to 0.48

0.48 keeps the grammar-authoring API intact. You do **not** need to rewrite `choice`,
`sequence`, `node`, `parser`, `rules`, `compose`, trivia, recovery, or dispatch definitions.
The release changes how compiled artifacts are packaged and executed, so there are a few
concrete upgrade steps.

## Required changes

### Use a supported Node version

The package now contains one ESM implementation. Both `import` and synchronous `require()`
resolve to that implementation on Node `^20.19.0 || >=22.13.0`. Older Node releases are
outside the supported range.

Most CommonJS consumers keep the same spelling:

```js
const { literal, parse } = require('parseman')
```

The plugin subpath exposes an ESM default export, so a CommonJS webpack config uses:

```js
const parseman = require('parseman/plugin').default
```

### Rebuild every compiled artifact

Generated, macro, composed, folded, precompiled, and rule-map artifacts are version-locked.
Re-run the build that creates them with Parseman 0.48.0; do not load an artifact produced by
0.47 in the 0.48 runtime.

This includes checked-in generated modules and published packages that embed a compiled
grammar. Source combinator grammars need no rewrite—only recompilation.

## Observable changes

### Compiled output is a TableProgram artifact

`compile()` and the macro use the canonical `TableProgram` implementation. Macro output
removes the combinator/compiler import and uses the shared `parseman/table` runtime. A
sufficiently large terminal default AST/no-lines `composeLeaf()` may also embed one static
assembly materialized from that same table. This is a size/speed choice, not a second parser
implementation.

If you inspect `compiled.source`, generated module text, bundle composition, or stack frames,
expect those details to differ from 0.47. Parse results and grammar definitions retain their
documented contracts.

### Failure diagnostics use authored terminals

`keywords()` failures now report the authored keyword strings instead of the generic
`"keyword"` label. `peek()` and `not()` use the same centralized terminal spelling as the
other execution modes. Tests that snapshot `expected` arrays may need their snapshots
updated; parsing behavior and ordered-choice semantics are unchanged.

### Document roots should own trailing trivia explicitly

This is not a new signature, but 0.48's fail-closed workload checks exposed grammars that
parsed the meaningful root and silently left final whitespace outside its span. When a
document node should consume and capture trailing trivia, put the trivia scope outside the
node and opt that node in:

```ts
const Document = parser(
  { trivia: whitespace },
  node('Document', many(statement), buildDocument, { trailingTrivia: true }),
)
```

Do not add this mechanically to every node. It is the document-boundary form for roots whose
contract includes trailing trivia; nested nodes normally leave surrounding trivia to their
parent scope.

## What did not change

- Grammar options still go first for scopes (`parser(opts, child)`, `rules(opts, factory)`) and
  last for local combinators.
- First-char gating, PEG ordered choice, `dispatch`, positive `peek`, negative `not`, and the
  repetition combinator signatures are unchanged.
- `ParserDef` gained construction metadata used internally by the compiler. It is not a new
  author-facing option; do not construct or mutate parser definition internals directly.
- Direct `parseWithContext` and custom contexts remain supported. The compiler's selected
  fast bodies fail closed to the general TableProgram path when their requirements are not
  proven.

For the full implementation and performance record, see the
[0.48 changelog](https://github.com/matthew-dean/parseman/blob/main/CHANGELOG.md)
and the frozen [0.48 architecture specification](../design/parseman-0.48.md).
