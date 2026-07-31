# BUG — `node(combinator, build, opts)` silently drops `opts`

Status: **open**, unfixed. Found 0.46.0 while building the `--fix` graph rebuilder
(`src/analysis/rebuild.ts`), which has to reconstruct a `node()` from its `_def` and so
had to exercise every arity.

## The defect

`src/combinators/node.ts:159-160`:

```ts
const buildArg = hasExplicitType ? buildOrOpts : combinatorOrBuild
const opts = (typeof buildArg === 'function' ? maybeOpts : buildArg ?? maybeOpts) as NodeOptions | undefined
```

`maybeOpts` is the **fourth** positional parameter. The UNTYPED-with-build arity —
`node(combinator, build, opts)`, advertised by the overload at `node.ts:143` — passes
`opts` as the THIRD argument, so `maybeOpts` is `undefined` and the ternary's
`typeof buildArg === 'function'` branch resolves `opts` to `undefined`. Every option is
lost: `unwrap`, `collapse`, `project`, `captureTrivia`, `trailingTrivia`, `buildArity`,
`tags`.

The typed arity `node(type, combinator, build, opts)` is correct, because there `opts`
really is the fourth argument.

## Reproduction

```ts
import { node, literal } from 'parseman'

node(literal('a'), (c: unknown) => c, { unwrap: true })._def.unwrap  // undefined  ← BUG
node('T', literal('a'), (c: unknown) => c, { unwrap: true })._def.unwrap  // true   ← correct
```

Measured on `release/0.46.0`.

## Why it is silent

Nothing throws and nothing warns. The node is built, parses fine, and produces a
DIFFERENT tree shape from the one the author asked for — `unwrap`/`collapse`/`project`
change what the node contributes to its parent, so the symptom is a wrong tree far from
the call site, not an error. `buildArity` being dropped also puts the node back on the
conservative capture path, which is a silent cost rather than a wrong answer.

## Blast radius

Unknown, and worth measuring before fixing. Any grammar using the untyped-with-build
arity WITH options is affected; grammars that pass options without a build, or that use
the typed arity, are not. A fix changes tree shape for affected call sites, so it is not
a safe drive-by: it needs an identity-oracle differential over jess's grammars.

## Current mitigation

`src/analysis/rebuild.ts` refuses to reconstruct exactly this shape
(`node(untyped+build+opts)`), freezing the subtree instead, so `--fix` never silently
reproduces a node with its options dropped. That is a workaround in one consumer, not a
fix.

## Suggested fix

Detect the arity properly rather than inferring it from `typeof`:

```ts
const opts = (hasExplicitType ? maybeOpts : (typeof buildArg === 'function' ? buildOrOpts : buildArg))
  as NodeOptions | undefined
```

…with a test per arity asserting each option lands in `_def`.
