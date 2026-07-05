# Extending grammars

Two grammars often overlap almost entirely: a base language and a dialect that adds or
tweaks a few rules — JSON and a lenient JSON with comments and trailing commas; CSS and a
Less/Sass superset; a query language and a vendor variant. Rather than copy the base and
edit it, **compose** it: take the base grammar and fuse your changes on top.

## `compose()`

`compose([...])` fuses grammars into one runnable parser. Later entries **override**
earlier ones by rule name:

```ts
import { rules, regex, choice, compose } from 'parseman'

const base = rules(g => ({
  Value: choice(g.Num, g.Word),
  Num:   regex(/[0-9]+/),
  Word:  regex(/[a-z]+/),
}))

// A dialect that only redefines Num (must end with '!').
const dialect = rules(() => ({ Num: regex(/[0-9]+!/) }))

const parser = compose([base, dialect])
parser.Value('12!', 0, {})   // ✅ matches — via the overridden Num
parser.Value('12',  0, {})   // ✗ no match — dialect's Num needs '!'
parser.Value('abc', 0, {})   // ✅ Word still works
```

A grammar (`rules(...)` result) is composable **as-is** — there's no wrapper to opt into,
no special export. Every unlisted rule is inherited; the listed ones override.

### Override is open-recursive

This is the key property, and it's what a plain object merge can't give you: overriding a
rule reroutes **every reference to it, including references inside the base's own rules.**
Above, `base.Value` calls `g.Num` — and after `compose`, that call resolves to the
*dialect's* `Num`. Composition re-binds all rule references in one shared scope, so the
base's internals see your overrides too.

## À la carte with `pick`

Take only the rules you want (plus their dependency closure). Handy when you're assembling
one grammar from parts of several:

```ts
import { compose, pick } from 'parseman'

// e.g. a grammar that borrows a mixin rule from Less and a loop from Sass:
const parser = compose([
  css,                          // whole base
  pick(less, ['MixinCall']),    // just MixinCall + everything it references
  pick(sass, ['EachLoop']),
])
```

`pick(grammar, names)` keeps `names` and their transitive rule dependencies and drops the
rest. If a kept rule references a name that isn't present in the final `compose([...])`,
you get a clear compose-time error rather than a runtime surprise.

## Building trees: swap the output shape

If your grammar's `node()` rules build an AST, `compose()` still lets a caller choose a
**different tree** at parse time without changing the grammar — pass a build host as
`ctx.build`. `cstBuildHost` yields a uniform positioned CST from any grammar:

```ts
import { compose, cstBuildHost } from 'parseman'

const parser = compose([base])
parser.Value('12', 0, {})                      // → the grammar's own AST
parser.Value('12', 0, { build: cstBuildHost }) // → a positioned CST node
```

This is how the same composed grammar serves an evaluator (its own AST) and a language
service (a CST with spans). See [incremental re-parsing](./incremental) for driving it in
an editor.

## No base source required

The important part for reuse: **composing a grammar never needs the base grammar's source.**
When you build with the [macro](./macro-mode), an exported grammar automatically **carries
its compiled, composable form on the value** (so `import { base }` is all a consumer needs).
A downstream package just imports the compiled grammar and composes it:

```ts
// @scope/base  →  ships a compiled grammar
import { rules, regex, choice } from 'parseman' with { type: 'macro' }
export const base = rules(g => ({ Value: choice(g.Num, g.Word), Num: regex(/[0-9]+/), Word: regex(/[a-z]+/) }))

// @scope/dialect  →  extends it, importing the COMPILED base
import { rules, regex, compose } from 'parseman' with { type: 'macro' }
import { base } from '@scope/base'
export const parser = compose([base, rules(() => ({ Num: regex(/[0-9]+!/) }))])
```

The dialect's build reads the base's **compiled** grammar — never its TypeScript source,
and never recompiles it. There is no "ship your source for speed" tradeoff; a published,
compiled-only package composes fine.

## How this behaves in each execution mode

`compose()` works whether a grammar [runs interpreted, via `compile()`, or via the
macro](./modes):

- **Macro (build):** `compose([...])` is fused at **build time** into one static parser —
  a plain closure of direct calls, **no `new Function` / eval** in the output. This is the
  fast, eval-free path, and the one that needs no base source (above).
- **`compile()` / interpreter (runtime):** `compose([...])` fuses when it's called, using
  the same code-generation `compile()` uses (so, like `compile()`, it needs
  `'unsafe-eval'` under a strict CSP). Correct and full-speed once constructed; parsing is
  never eval.

Either way the parse is identical — a single fused scope of direct rule calls, override
resolved across the whole set.
