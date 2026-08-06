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

## Assembling one grammar from parts of several

To borrow a piece of another grammar — say a mixin rule from one dialect and a loop from
another — factor the reusable bit into its own small `rules({ trivia })` grammar and
`compose()` it in. A piece only needs to define *its own* rules; anything it references by
name (values, identifiers, whitespace) resolves to the composing grammar's versions, so a
borrowed rule automatically adopts the host grammar's syntax and trivia:

```ts
// A package exports the mixin machinery as a standalone composable grammar…
export const mixins = rules({ trivia }, (g) => ({
  MixinCall: sequence(g.Selector, literal('('), g.args, literal(')')),
  // …references g.Selector / g.args by name — the composing grammar supplies them.
}))

// …and a consumer composes just that piece in:
const parser = compose([css, mixins, myDelta])
```

Because references resolve by name across `compose()`, you don't extract a dependency
closure — you name the shared rules and the host grammar provides them (along with its
trivia, via composing-wins).

### Shared shapes: one shape, many bindings

The same mechanism factors out a composite **shape** whose leaves differ per dialect.
A ratio is `<value> '/' <value>` in every CSS dialect; what a `<value>` is differs
(a number; a number *or* an interpolation). Write the shape once, leave the leaf as a
hole, and let each consumer bind it:

```ts
// @scope/shapes — the shape, with a hole
import { rules, literal, sequence } from 'parseman' with { type: 'macro' }
export const ratio = rules(g => ({ Ratio: sequence(g.Value, literal('/'), g.Value) }))

// a dialect binds its own Value, and builds its own tree on top
import { composeLeaf, node, regex, rules } from 'parseman' with { type: 'macro' }
import { ratio } from '@scope/shapes'
export const parser = composeLeaf([ratio, rules(g => ({
  Value:    regex(/[0-9]+/),                       // …or /@\{[a-z]+\}|[0-9]+/ next door
  Document: node('Document', g.Ratio, (children, _f, span) => ({ type: 'Ratio', children, span })),
}))])
```

A grammar with a hole isn't a runnable parser on its own — `ratio.Ratio` can't resolve
`Value` until something supplies it — so its exported value stays the ordinary
`rules(…)` map. It still ships **fully compiled**: the macro stamps its compiled pieces
on the value, and the consumer's `compose()` / `composeLeaf()` fuses them statically,
with no base source and no runtime composition. A hole that nothing binds is a build
error, not a silent drop.

Under `composeLeaf` the usual rule still applies: every grammar before the final local
one must be **recognition-only** — a shape may leave holes, but it may not carry
reductions of its own. The semantics belong to the leaf that owns the tree.

The [gating diagnostic](./first-char-gating#shared-shapes-the-verdict-belongs-to-the-fuse)
follows the same logic: whether a shape's `choice` first-char-dispatches depends on what
gets bound, so the shape itself is not warned — the answer is computed, and reported, at
each `compose()` / `composeLeaf()` that binds the hole.

### Running a composed grammar without a build step

`compose()` lowers to a **table**, so a composed grammar is a map of driver-backed rule
functions, not combinators. When you need the composition as a live **combinator graph**
instead — profiling, gating analysis, anything that must stay in interpreted mode —
use `fuseInterpreted()` with the same items:

```ts
import { fuseInterpreted, run } from 'parseman'

const g = fuseInterpreted([recognition, dialect, leafRules])
run(g.Stylesheet, input)
```

The fuse semantics are the compiled ones: later piece wins, an override reroutes the
base piece's own calls, the composing grammar's trivia governs every rule, and a
referenced-but-undefined rule fails at fuse time. `run()` / `parseDoc()` take either
shape; `isInterpretedFuse(map)` tells them apart. Without the macro, `composeLeaf()`
returns this form too (fused on first rule access).

Binding a cross-piece hole rewrites the shared placeholder object — that is how the
override reaches the base's own call sites — so **one interpreted fusion per piece**:
a second, conflicting fusion over the same piece objects throws rather than silently
rewriting the first one's parser. Build a fresh instance of the piece for the second.

> **There is no public `pick()`.** Selecting a subset of a grammar's rules plus their
> transitive closure is internal-only: such a selection over an *imported* grammar cannot
> carry that grammar's ambient trivia across the module boundary, which would make the
> macro build diverge from the interpreter. Compose small pieces instead (above).

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
service (a CST with spans). Use `node(..., { collapse: true })` for a grammar-local
transparent wrapper, or `cstBuildHost({ collapse })` for a caller-selected public CST
policy that hides one-child wrapper rules without a post-processing walk. See
[incremental re-parsing](./incremental) for driving it in an editor.

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

::: warning What a composable export must now carry
Composition is a rule-map merge, so every piece has to be able to hand back a combinator
graph. A piece does that from its **serialized IR**, which it carries alongside its table.

**If a grammar's IR will not serialize, that grammar can be run but not composed
downstream.** `compose()` refuses it by name (`carried piece "…" has no re-lowerable IR
and cannot be fused`) rather than silently producing a parser missing its rules. The usual
cause is an author callback the encoder cannot capture a source for. If you are publishing
a grammar for others to `compose()`, compose it once in your own tests — running it is not
evidence that it composes.
:::

## How this behaves in each execution mode

`compose()` works whether a grammar [runs interpreted, via `compile()`, or via the
macro](./modes):

- **Macro (build):** `compose([...])` is lowered at **build time** to one static table — a
  `tableRules({…})` data literal plus your own reducers. It needs no base grammar source
  (the pieces travel on the imported value) and contains no `eval`, so it ships in
  strict-CSP contexts (browser extensions, some CDNs) with no configuration.
- **Runtime (no macro):** `compose([...])` merges when it's called. The merge and the
  encode are data — but hydrating each carried piece back to a combinator graph goes
  through `new Function`, so a **runtime `compose()` still wants `'unsafe-eval'`** under a
  strict CSP. Construction happens once; parsing afterward is full speed.

`compile()` and the interpreter, by contrast, need no `eval` at all since 0.47.0 — a
runtime `compose()` is now the only path in the library that does. If you are shipping into
a strict CSP, compose at build time with the macro, or ship a `linkable()` artifact.

Either way the parse is identical — one encoded table over the merged rule map, override
resolved across the whole set.
