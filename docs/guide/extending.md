# Extending grammars

Two grammars often overlap almost entirely: a base language and a dialect that adds or
tweaks a few rules. JSON and a lenient JSON that allows comments and trailing commas; a
small expression language and one with extra operators; a query language and a vendor
superset. Rather than copy the base grammar and edit it, factor the shared rules into a
**fragment** and extend it.

A fragment is nothing new — it's just a factory that returns a slice of a rule map:

```ts
// numbers.ts — a shared fragment
import { regex, oneOrMore } from 'parseman'

export const numbers = (g: any) => ({
  digit: regex(/[0-9]/),
  number: oneOrMore(g.digit),
})
```

Extend a grammar by **spreading** the fragment into its `rules()` map:

```ts
import { rules, sequence, regex } from 'parseman'
import { numbers } from './numbers'

export const { pair } = rules(g => ({
  ...numbers(g),                                   // fragment's rules merged in
  pair: sequence(g.number, regex(/,/), g.number),  // your rule uses g.number
}))
```

That's it. The same `g` proxy is threaded into the fragment, so `g.number` inside the
fragment and `g.number` in your grammar refer to the *same* rule. Extension is plain
JavaScript object spread — no special combinator, no build step required.

## Overriding

Spread order wins, exactly like `Object.assign`. To specialize a base grammar, spread it
first and redefine the rules you want to change. Here a strict grammar is extended into a
lenient dialect by relaxing one rule — the array now allows a trailing comma:

```ts
export const { value } = rules(g => ({
  ...strictJson(g),   // the base grammar
  array: sequence(literal('['), sepBy(g.value, comma), optional(comma), literal(']')),
}))
```

Every unlisted rule is inherited; the listed ones override. This is how a dialect *extends*
a base grammar instead of copying it.

## Injecting the tree builder (and other hosts)

If your rules build AST nodes, the build step is often grammar-specific — two dialects can
produce different nodes for the same rule. Don't let a rule's build callback close over a
module-level function; that would bind it to the *fragment's* module, not the grammar that's
extending it. **Inject the host explicitly** as a second fragment argument:

```ts
// fragment
export const values = (g, { build }) => ({
  sum: node('Sum', sequence(g.term, /* … */), (c, r, s) => build('Sum', c, r, s)),
})

// grammar that extends it
export const { … } = rules(g => ({
  ...values(g, { build }),   // ← this grammar passes ITS build
}))
```

Now the fragment's `sum` rule is built by *this* grammar's `build`. Anything
grammar-specific — the builder host, feature flags — flows in through that injected object.

## How this behaves in each mode

Parséman [runs the same grammar two ways](./modes) — interpreted, or compiled by the macro.
Extension works in **both**, but with a caveat worth understanding:

- **Interpreted (no macro): fully supported.** `...fragment(g)` is ordinary JS — the fragment
  runs, returns its rules, they merge. Nothing to configure.
- **Macro (compiled): the fragment is inlined when its source is available at build time;
  otherwise it falls back to the interpreter.** When the macro can see a fragment's source
  (see below), it inlines the whole extension into one compiled parser — full fast path.
  When it can't, it emits a warning and that grammar runs interpreted (correct, just not
  compiled). It never crashes and never silently mis-parses.

::: warning The macro is a build-time *source* transform
The macro can only inline a fragment it can **read as source** at the extending grammar's build time.
It cannot inline a fragment that reaches it only as compiled output (a published `dist`),
because a compiled combinator is an optimized parse function, not a re-composable definition
tree. This is inherent — the same reason `babel-plugin-macros` needs a macro's source, not
its build.
:::

### What "source is available" means in practice

- **Same package / monorepo** — the fragment is a source file the grammar imports
  (`./fragments/numbers.ts`, or a workspace package resolved to its `src`). Source is present
  at build time → inlined. This is the common case, since a dialect and its base are usually
  developed together.
- **Published library** — ship the fragment as **parseman source** (a source subpath export),
  the same way macro libraries ship their source. Consumers with the macro inline it; consumers
  without it run the identical source interpreted.
- **Compiled-only dependency** — no source, no inlining. Extension still *works* via the
  interpreter fallback; it just doesn't get the compiled fast path.

The tradeoff to remember: **source for speed, runtime for portability.** Ship source (or a
source subpath) if you want consumers to compile your fragment; otherwise they get the
correct-but-interpreted path.

## Status

- **Interpreted extension** — available. Nothing to enable.
- **Macro inlining of same-file fragments** — available. A `const frag = (g, deps) => ({ … })`
  in the same file, spread as `...frag(g)` in a `rules()` return, is inlined into the compiled
  rule map: the macro evaluates the fragment's body and return object against the extending
  grammar's `g` proxy and merges its rules (spread order = override order, so a later definition
  of a key wins). Nested spreads and fragment-local `const`s are supported.
- **Macro inlining of *imported* fragments (cross-file / cross-package)** — available. When a
  `...frag(g)` spread's factory is *imported*, the macro resolves the exporting module, reads its
  **source** at build time, parses it (cached per module), finds the exported factory, and inlines
  it exactly as it would a same-file one. Resolution uses [`oxc-resolver`](https://github.com/oxc-project/oxc-resolver)
  — the same resolver family as the parser — so it honors package `exports`/`imports` maps, tsconfig
  path aliases, and TypeScript extensions, and prefers a package's declared source (e.g. a `source`
  export condition or main field). If resolution still lands on compiled output under a conventional
  build directory (`dist`, `lib`, `build`, `out`, `compiled`, `cjs`, `esm`, …), the macro looks for a
  co-located `src/` tree as a best-effort fallback. If no source can be found, the spread takes the
  interpreter fallback (correct, not compiled).

### The self-contained-fragment constraint

For the macro to inline an *imported* fragment, that fragment must be **self-contained**: its rule
parsers may reference only

- **parseman combinators** (resolved by name — `regex`, `sequence`, `node`, …),
- **`g`** (the shared proxy passed in by the extending grammar),
- **injected `deps`** used inside `build`/`transform`/`node` callbacks (captured as source text and
  resolved in the *consumer's* scope — this is why you [inject the host](#injecting-the-tree-builder-and-other-hosts)
  instead of closing over a module-level function), and
- the fragment's **own block-body `const`s** (`(g) => { const comma = literal(','); return { … } }`).

If a fragment references a **module-level `const` of its own module** (not a body-local), the macro
can't resolve it and returns `null` → that spread degrades to the interpreter fallback. Fully
evaluating the exporting module's module-level combinator `const`s into the fragment scope is a
later enhancement. For now, keep shared fragments self-contained (inline the helper into the
factory body, or pass it in via `deps`).

Every tier preserves the "runs identically interpreted" guarantee: the macro only ever *inlines
what the interpreter would have computed*. Anything it can't resolve — an imported factory with
no available source, a fragment that reaches out to its module's top-level consts, a shape it
doesn't recognize — degrades to the interpreter with an actionable warning, never a crash or a
mis-parse.
