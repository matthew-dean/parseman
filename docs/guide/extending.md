# Extending grammars

Two grammars often overlap almost entirely: a base language and a dialect that adds or
tweaks a few rules. Think JSON versus a lenient JSON with comments and trailing commas, or
CSS versus a Less/Sass superset. Rather than copy the base and edit it, **compose** it —
take the base grammar and fuse your changes on top.

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

A grammar (the result of `rules(...)`) is composable as-is. There's no wrapper to opt into
and no special export — every unlisted rule is inherited, and the listed ones override.

### Override is open-recursive

This is the key property, and it's what a plain object merge can't give you: overriding a
rule reroutes **every reference to it, including references inside the base's own rules.**
Above, `base.Value` calls `g.Num` — and after `compose`, that call resolves to the
*dialect's* `Num`. Composition re-binds all rule references in one shared scope, so the
base's internals see your overrides too.

## Assembling one grammar from parts of several

To borrow a piece of another grammar — say a mixin rule from one dialect and a loop from
another — factor the reusable bit into its own small `rules({ trivia })` grammar and
`compose()` it in. A piece only needs to define *its own* rules. Anything it references by
name (values, identifiers, whitespace) resolves to the composing grammar's versions, so a
borrowed rule automatically picks up the host grammar's syntax and trivia:

```ts
// A package exports the mixin machinery as a standalone composable grammar…
export const mixins = rules({ trivia }, (g) => ({
  MixinCall: sequence(g.Selector, literal('('), g.args, literal(')')),
  // …references g.Selector / g.args by name — the composing grammar supplies them.
}))

// …and a consumer composes just that piece in:
const parser = compose([css, mixins, myDelta])
```

Because references resolve by name across `compose()`, you don't have to extract a
dependency closure — you just name the shared rules, and the host grammar supplies them,
along with its trivia, since the composing grammar always wins.

### Shared shapes: one shape, many bindings

The same mechanism lets you factor out a composite **shape** whose leaves differ per
dialect. A ratio is `<value> '/' <value>` in every CSS dialect — what counts as a `<value>`
is what differs (a number; a number *or* an interpolation). Write the shape once, leave the
leaf as a hole, and let each consumer bind it:

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
`Value` until something supplies it — so its exported value stays an ordinary `rules(…)`
map. It still ships **fully compiled**: the macro stamps its compiled pieces onto the
value, and the consumer's `compose()` / `composeLeaf()` fuses them statically, with no base
source and no runtime composition involved. A hole that nothing binds is a build error, not
a silent drop.

Under `composeLeaf`, the usual rule still applies: every grammar before the final local one
must be **recognition-only**. A shape can leave holes, but it can't carry reductions of its
own — the semantics belong to the leaf that owns the tree.

The [gating diagnostic](./first-char-gating#shared-shapes-the-verdict-belongs-to-the-fuse)
follows the same logic: whether a shape's `choice` dispatches on the first character
depends on what gets bound, so the shape itself isn't warned about it. The answer is
computed — and reported — at each `compose()` / `composeLeaf()` that binds the hole.

### There is one engine you ship

`compose()` / `composeLeaf()` fuse by **codegen**, so a composed grammar is a map of
compiled functions. That's the artifact you ship, and the macro is how you get it.

Parseman also has a second, *interpreted* fuse, which runs the composition as a live
combinator graph instead of reaching codegen. It exists for diagnostics that must not reach
codegen — profiling, gating analysis, and differential tests that compare one engine
against another — and it isn't part of the public API: it's a second engine over the same
grammar, with different runtime characteristics, and picking between them isn't a decision
a consumer should have to make. `run()` / `parseDoc()` accept the shape it produces so those
internal tools keep working, but nothing you ship should depend on it.

## Building trees: swap the output shape

If your grammar's `node()` rules build an AST, `compose()` still lets a caller choose a
**different tree** at parse time without changing the grammar — just pass a build host as
`ctx.build`. `cstBuildHost` yields a uniform positioned CST from any grammar:

```ts
import { compose, cstBuildHost } from 'parseman'

const parser = compose([base])
parser.Value('12', 0, {})                      // → the grammar's own AST
parser.Value('12', 0, { build: cstBuildHost }) // → a positioned CST node
```

This is how the same composed grammar can serve an evaluator (its own AST) and a language
service (a CST with spans). Use `node(..., { collapse: true })` for a grammar-local
transparent wrapper, or `cstBuildHost({ collapse })` when the caller should choose the
public CST policy — it hides one-child wrapper rules without a separate post-processing
walk. See [incremental re-parsing](./incremental) for driving this in an editor.

## No base source required

Here's the part that matters most for reuse: **composing a grammar never needs the base
grammar's source.** When you build with the [macro](./macro-mode), an exported grammar
automatically **carries its compiled, composable form on the value** — so `import { base }`
is all a consumer needs. A downstream package just imports the compiled grammar and
composes it:

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
and it never recompiles it. There's no "ship your source for speed" tradeoff here; a
published, compiled-only package composes just fine.

## How this behaves in each execution mode

`compose()` works whether a grammar [runs interpreted, via `compile()`, or via the
macro](./modes):

- **Macro (build):** `compose([...])` is fused at **build time** into one static parser —
  a plain closure of direct rule calls, emitted as ordinary source. It needs no base
  grammar source (the pieces travel on the imported value) and runs under any CSP, so it
  ships in strict-CSP contexts like browser extensions or some CDNs with no extra
  configuration.
- **`compile()` / interpreter (runtime):** `compose([...])` fuses when it's called, using
  the same code generation `compile()` uses. So, like `compile()`, it builds the fused
  parser via `new Function`, which needs `'unsafe-eval'` under a strict CSP. Construction
  happens once; parsing afterward runs at full speed.

Either way, the parse is identical: a single fused scope of direct rule calls, with
overrides resolved across the whole set.
