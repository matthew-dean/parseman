# Macro mode

Add the plugin once and your parser imports are evaluated and compiled at build time.
The `parseman` import disappears from the bundle entirely, leaving flat, allocation-light
JavaScript in its place.

## 1. Register the plugin

Parséman ships an [unplugin](https://github.com/unjs/unplugin)-based plugin, so the same
export adapts to every major bundler.

::: code-group

```ts [vite.config.ts]
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman()],
}
```

```js [rollup.config.js]
import parseman from 'parseman/plugin'

export default {
  plugins: [parseman.rollup()],
}
```

```js [webpack.config.js]
const parseman = require('parseman/plugin')

module.exports = {
  plugins: [parseman.webpack()],
}
```

:::

## 2. Import with `with { type: 'macro' }`

```ts
import { literal, sequence, choice, regex, transform } from 'parseman' with { type: 'macro' }
```

Same combinators, no other changes. The plugin walks each initializer, evaluates it at
build time, and replaces it with an inline function.

### Import attributes

The `with { … }` suffix is [**import attributes**](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with) —
standard JavaScript syntax from the [TC39 import-attributes
proposal](https://github.com/tc39/proposal-import-attributes). It attaches metadata to an
`import` (or `export … from`) statement. The canonical standardized use is JSON modules:

```ts
import data from './config.json' with { type: 'json' }
```

`type: 'macro'` is **not** a TC39-defined module type. It's a **bundler convention** —
the attribute tells the build tool to evaluate the import at compile time and inline the
result, rather than bundling it for runtime. The same `with { type: 'macro' }` pattern is
used by [Bun](https://bun.com/docs/bundler/macros),
[Parcel](https://parceljs.org/features/macros/), and
[unplugin-macros](https://github.com/unplugin/unplugin-macros). Parséman's plugin keys off
it the same way: see the attribute, compile the combinator tree, strip the attribute so
the import stays valid for the interpreter fallback.

Older runtimes may still accept the earlier `assert { type: 'macro' }` spelling (import
*assertions*, the predecessor syntax). TypeScript has parsed `with { … }` on imports since
5.3.

### TypeScript config

TypeScript only accepts import-attribute syntax when
[`module`](https://www.typescriptlang.org/tsconfig/#module) is set to `esnext`,
`nodenext`, or `preserve`. With anything else you'll get:

```
TS2823: Import attributes are only supported when the --module option is set to
esnext, nodenext, or preserve.
```

For a bundler-based project the usual pairing is:

```json
{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler"
  }
}
```

## What gets emitted

A `choice` over string literals with disjoint first characters compiles to a single
`codePointAt` dispatch:

```js
// Before (source):
const method = choice(literal('GET'), literal('POST'), literal('PUT'), literal('DELETE'))

// After (bundle output):
const method = function (input, _pos, _ctx) {
  const _code = _pos < input.length ? input.codePointAt(_pos) : -1
  if      (_code === 71) { /* G-E-T    */ }
  else if (_code === 80) { /* P-O-S-T  */ }
  else if (_code === 68) { /* D-E-L-E-T-E */ }
  else return { ok: false, expected: ['"GET"', '"POST"', …], span: { start: _pos, end: _pos } }
  …
}
```

- **Disjoint first characters** → a single `codePointAt` dispatch instead of trying each
  arm.
- **Composed grammars dispatch too.** When you [`compose([...])`](./extending) separately
  compiled grammars, a `choice` arm that references a rule in *another* artifact keeps its
  first-char dispatch. Because each artifact is compiled on its own, the referenced rule's
  first-set isn't known yet — so the guard is emitted as a placeholder and resolved at
  **fuse time** against the *final* rule's first-set. That stays correct even when a later
  artifact **overrides** a rule with a different first-set (open recursion). Without this,
  cross-artifact `choice` arms fell back to trying every arm per token.
- **Regex parsers** → lowered to a `charCodeAt` scan loop where provably equivalent,
  otherwise a sticky `/pattern/y` hoisted to closure scope.
- **Failure paths** allocate no objects.

For a deep dive on which regex shapes become scan loops, into what, and why some stay on the
engine, see [Under the hood: regex lowering](./regex-lowering).

## What gets compiled

The plugin compiles combinator trees end to end:

- All the core combinators — `literal`, `regex`, `sequence`, `choice`, `many`,
  `oneOrMore`, `optional`, `sepBy`, `transform`, `skip`, `token`, `not`, `scanTo`,
  `balanced`.
- `rules()` factories, **including mutually recursive ones** — emitted as mutually
  recursive named functions (`_pf0`, …) so the cycle is broken.
- `parser({ trivia })` / `noTrivia()` wrappers.
- `node()` rules — CST capture, trivia logging, and all — with every `build` / `transform`
  callback inlined at its source span.

A full grammar built as a `rules()` factory of `node()` rules compiles end to end: each
rule becomes an independently-callable function, terminal/trivia capture is emitted
inline, and grammars with no `node()` emit zero capture code (so they compile
byte-identically to the non-CST version).

Both binding forms compile:

```ts
const { value } = rules(…)   // each rule becomes a top-level function
const grammar   = rules(…)   // an object literal of compiled rules; grammar.value(…) works
```

Parsers that close over external variables the evaluator can't resolve are left as-is —
the plugin compiles what it can and quietly leaves the rest to the interpreter.

## Code size — what to expect

Compiling trades **bundle size for speed**: a compact combinator grammar expands into
flat, inlined JavaScript, and that generated code ships in your bundle. Expect roughly
**3–14× the source lines**, growing with grammar complexity. Measured on the bundled
example grammars (`pnpm bench:size`):

| Grammar | Source LOC | Generated LOC | Size | Gzip size | Line multiplier |
| --- | --- | --- | --- | --- | --- |
| JSON | 97 | 321 | 10.7 kB | 2.3 kB | 3.3× |
| CSV | 39 | 423 | 16.1 kB | 3.1 kB | 10.8× |
| GraphQL | 196 | 2,699 | 100.6 kB | 16.6 kB | 13.8× |

Two things keep this in perspective:

- **The `parseman` runtime import disappears.** Macro output has no external references, so
  you're not shipping the combinator library *and* the generated code — just the code.
- **Generated JS is repetitive, so it gzips hard.** GraphQL's 100 kB of source is ~16.6 kB
  over the wire — the number your users actually download. Raw LOC looks large; the shipped
  cost is a fraction of it.

If bundle size matters more than raw throughput for a given grammar, use the
**interpreter** (zero generated code, zero setup) or reach for `.compile()` at runtime
instead of the macro. See [the three modes](./modes).

Source maps and per-mode debugging are covered in [Debugging compiled grammars](./modes#debugging-compiled-grammars).

## When the plugin can't compile something

If the plugin meets a macro-imported declaration it can't compile statically — it closes
over a runtime value, or isn't a recognized combinator shape — it:

1. leaves that declaration for the interpreter,
2. strips the `with { type: 'macro' }` attribute so the import stays valid, and
3. emits a build **warning** (`[parseman] file:line — …`) pointing at it.

So a silent fallback never goes unnoticed — you'll see exactly which rule dropped to the
interpreter and why.
