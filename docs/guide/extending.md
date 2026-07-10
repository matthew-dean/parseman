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

> **`pick()` is not currently public.** An earlier `pick(grammar, names)` selected a subset
> of a grammar's rules plus their transitive closure. It's withdrawn while its build-time
> lowering is worked out: a `pick()` of an *imported* grammar can't yet carry that grammar's
> ambient trivia across the module boundary, so the macro would diverge from the interpreter.
> Prefer small composable pieces (above); `pick()` may return once it lowers identically on
> both the interpreter and the macro.

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

## How this behaves in each execution mode

`compose()` works whether a grammar [runs interpreted, via `compile()`, or via the
macro](./modes):

- **Macro (build):** `compose([...])` is fused at **build time** into one static parser —
  a plain closure of direct rule calls, emitted as ordinary source. It needs no base
  grammar source (the pieces travel on the imported value) and runs under any CSP, so it
  ships in strict-CSP contexts (browser extensions, some CDNs) with no configuration.
- **`compile()` / interpreter (runtime):** `compose([...])` fuses when it's called, using
  the same code generation `compile()` uses — so, like `compile()`, it builds the fused
  parser via `new Function` (which needs `'unsafe-eval'` under a strict CSP). Construction
  happens once; parsing afterward is full speed.

Either way the parse is identical — a single fused scope of direct rule calls, override
resolved across the whole set.
